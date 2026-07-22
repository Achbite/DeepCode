import type {
  SessionSemanticDraftPayload,
  SessionSemanticDraftPlanTask,
  SessionSemanticDraftToolName,
} from '@deepcode/protocol';

export interface SessionSemanticDraftStreamRecord {
  providerCallId: string;
  index: number;
  callId?: string;
  toolName?: string;
  rawArguments: string;
  revision: number;
  lastEmittedAt: number;
  lastEmittedVisibleChars: number;
  latest?: DecodedSessionSemanticDraft;
  emitted?: SessionSemanticDraftPayload;
  failed?: string;
  discarded?: string;
}

export interface DecodedSessionSemanticDraft {
  kind: 'answer' | 'plan';
  toolName: SessionSemanticDraftToolName;
  complete: boolean;
  visibleCharLength: number;
  answer?: {
    content: string;
  };
  plan?: {
    title?: string;
    summary?: string;
    tasks: SessionSemanticDraftPlanTask[];
    risks: string[];
    reviewCheckpoints: string[];
  };
}

export interface SessionSemanticDraftDecodeFailure {
  failureCode: string;
  message: string;
}

export type SessionSemanticDraftDecodeResult =
  | { ok: true; draft: DecodedSessionSemanticDraft }
  | { ok: false; failure: SessionSemanticDraftDecodeFailure };

interface JsonFieldNode {
  key: string;
  value: JsonStructureNode;
}

interface JsonStructureNode {
  kind: 'object' | 'array' | 'string' | 'number' | 'literal' | 'incomplete';
  start: number;
  end: number;
  complete: boolean;
  stringValue?: string;
  fields?: JsonFieldNode[];
  elements?: JsonStructureNode[];
}

interface JsonStructureScan {
  root?: JsonStructureNode;
  error?: string;
}

/**
 * Incremental JSON inspection is deliberately a direct structural state machine.
 * It does not build lexical tokens and never interprets user prose or model text.
 */
export function decodeSessionSemanticDraft(
  rawArguments: string,
  toolName: SessionSemanticDraftToolName
): SessionSemanticDraftDecodeResult {
  const scanned = new IncrementalJsonStructureScanner(rawArguments).scan();
  if (scanned.error) {
    return failure('semantic_draft_invalid_json', scanned.error);
  }
  const root = scanned.root;
  if (!root || root.kind === 'incomplete') {
    return success(emptyDraft(toolName, false));
  }
  if (root.kind !== 'object') {
    return failure('semantic_draft_type_mismatch', 'Semantic tool arguments must start with a JSON object.');
  }
  return toolName === 'session.submit_answer'
    ? decodeAnswerDraft(root)
    : decodePlanDraft(root, rawArguments);
}

export function validateSessionSemanticDraftFinal(
  decoded: DecodedSessionSemanticDraft,
  finalArguments: Record<string, unknown>
): SessionSemanticDraftDecodeFailure | undefined {
  if (decoded.kind === 'answer') {
    const finalContent = stringValue(finalArguments.content);
    const visible = decoded.answer?.content ?? '';
    if (!finalContent || !finalContent.startsWith(visible)) {
      return {
        failureCode: 'semantic_draft_final_mismatch',
        message: 'Final Answer content does not preserve the visible semantic draft prefix.',
      };
    }
    return undefined;
  }

  const visible = decoded.plan;
  if (!visible) return undefined;
  const finalTitle = stringValue(finalArguments.title);
  const finalSummary = stringValue(finalArguments.summary);
  if ((visible.title && !finalTitle?.startsWith(visible.title)) ||
      (visible.summary && !finalSummary?.startsWith(visible.summary))) {
    return {
      failureCode: 'semantic_draft_final_mismatch',
      message: 'Final Plan title or summary does not preserve the visible semantic draft prefix.',
    };
  }

  const finalTasks = Array.isArray(finalArguments.tasks)
    ? finalArguments.tasks.map(normalizePlanTask)
    : [];
  if (finalTasks.some((task) => !task) || !arrayPrefixMatches(visible.tasks, finalTasks as SessionSemanticDraftPlanTask[])) {
    return {
      failureCode: 'semantic_draft_final_mismatch',
      message: 'Final Plan tasks do not preserve the visible semantic draft prefix.',
    };
  }
  if (!stringArrayPrefixMatches(visible.risks, stringArray(finalArguments.risks)) ||
      !stringArrayPrefixMatches(visible.reviewCheckpoints, stringArray(finalArguments.reviewCheckpoints))) {
    return {
      failureCode: 'semantic_draft_final_mismatch',
      message: 'Final Plan risks or review checkpoints do not preserve the visible semantic draft prefix.',
    };
  }
  return undefined;
}

export function isSessionSemanticDraftToolName(value: string | undefined): value is SessionSemanticDraftToolName {
  return value === 'session.submit_answer' || value === 'session.submit_plan';
}

export function normalizeSessionSemanticDraftToolName(value: string | undefined): string | undefined {
  return value?.replace(/__/g, '.');
}

function decodeAnswerDraft(root: JsonStructureNode): SessionSemanticDraftDecodeResult {
  if (duplicateField(root, 'content')) {
    return failure('semantic_draft_duplicate_field', 'Answer content appears more than once.');
  }
  const contentNode = field(root, 'content');
  if (contentNode && contentNode.kind !== 'string' && contentNode.kind !== 'incomplete') {
    return failure('semantic_draft_type_mismatch', 'Answer content must be a JSON string.');
  }
  if (root.complete && !contentNode) {
    return failure('semantic_draft_required_field_missing', 'Answer content is required.');
  }
  const content = contentNode?.stringValue ?? '';
  return success({
    kind: 'answer',
    toolName: 'session.submit_answer',
    complete: root.complete,
    visibleCharLength: content.length,
    answer: { content },
  });
}

function decodePlanDraft(root: JsonStructureNode, rawArguments: string): SessionSemanticDraftDecodeResult {
  for (const key of ['title', 'summary', 'tasks', 'risks', 'reviewCheckpoints']) {
    if (duplicateField(root, key)) {
      return failure('semantic_draft_duplicate_field', `Plan field ${key} appears more than once.`);
    }
  }

  const titleResult = visibleStringField(root, 'title');
  if (!titleResult.ok) return titleResult;
  const summaryResult = visibleStringField(root, 'summary');
  if (!summaryResult.ok) return summaryResult;
  const titleNode = field(root, 'title');
  const summaryNode = field(root, 'summary');
  const titleComplete = Boolean(titleNode?.complete);
  const summaryComplete = Boolean(summaryNode?.complete);
  const title = titleResult.value;
  const summary = titleComplete ? summaryResult.value : undefined;

  const tasksNode = field(root, 'tasks');
  if (tasksNode && tasksNode.kind !== 'array' && tasksNode.kind !== 'incomplete') {
    return failure('semantic_draft_type_mismatch', 'Plan tasks must be a JSON array.');
  }
  const tasks: SessionSemanticDraftPlanTask[] = [];
  if (titleComplete && summaryComplete && tasksNode?.kind === 'array') {
    for (const node of tasksNode.elements ?? []) {
      if (!node.complete) break;
      if (node.kind !== 'object') {
        return failure('semantic_draft_task_invalid', 'Each Plan task must be a JSON object.');
      }
      if (hasDuplicateTaskField(node)) {
        return failure('semantic_draft_duplicate_field', 'A Plan task contains a duplicate semantic field.');
      }
      const parsed = parseCompleteNode(rawArguments, node);
      const normalized = normalizePlanTask(parsed);
      if (!normalized) {
        return failure('semantic_draft_task_invalid', 'A completed Plan task does not match the semantic task shape.');
      }
      tasks.push(normalized);
    }
  }

  const tasksComplete = tasksNode?.kind === 'array' && tasksNode.complete;
  const risksResult = visibleStringArray(root, 'risks', tasksComplete);
  if (!risksResult.ok) return risksResult;
  const risksNode = field(root, 'risks');
  const risksComplete = risksNode?.kind === 'array'
    ? risksNode.complete
    : root.complete && !risksNode;
  const checkpointsResult = visibleStringArray(root, 'reviewCheckpoints', Boolean(risksComplete));
  if (!checkpointsResult.ok) return checkpointsResult;

  if (root.complete && (!titleNode || !summaryNode || !tasksNode)) {
    return failure('semantic_draft_required_field_missing', 'Plan title, summary, and tasks are required.');
  }

  const plan = {
    ...(title !== undefined ? { title } : {}),
    ...(summary !== undefined ? { summary } : {}),
    tasks,
    risks: risksResult.value,
    reviewCheckpoints: checkpointsResult.value,
  };
  return success({
    kind: 'plan',
    toolName: 'session.submit_plan',
    complete: root.complete,
    visibleCharLength: visiblePlanCharLength(plan),
    plan,
  });
}

function visibleStringField(
  root: JsonStructureNode,
  key: string
): { ok: true; value?: string } | { ok: false; failure: SessionSemanticDraftDecodeFailure } {
  const node = field(root, key);
  if (!node) return { ok: true, value: undefined };
  if (node.kind !== 'string' && node.kind !== 'incomplete') {
    return failure('semantic_draft_type_mismatch', `Plan field ${key} must be a JSON string.`);
  }
  return { ok: true, value: node.stringValue };
}

function visibleStringArray(
  root: JsonStructureNode,
  key: string,
  enabled: boolean
): { ok: true; value: string[] } | { ok: false; failure: SessionSemanticDraftDecodeFailure } {
  const node = field(root, key);
  if (!node || !enabled) return { ok: true, value: [] };
  if (node.kind !== 'array' && node.kind !== 'incomplete') {
    return failure('semantic_draft_type_mismatch', `Plan field ${key} must be a JSON array.`);
  }
  const output: string[] = [];
  for (const element of node.elements ?? []) {
    if (!element.complete) break;
    if (element.kind !== 'string' || !element.stringValue?.trim()) {
      return failure('semantic_draft_type_mismatch', `Plan field ${key} must contain non-empty strings.`);
    }
    output.push(element.stringValue);
  }
  return { ok: true, value: output };
}

function normalizePlanTask(value: unknown): SessionSemanticDraftPlanTask | undefined {
  const record = objectRecord(value);
  if (!record) return undefined;
  const taskId = stringValue(record.taskId);
  const title = stringValue(record.title);
  const toolId = stringValue(record.toolId);
  const target = requiredStringArray(record.target);
  const dependencies = requiredStringArray(record.dependencies);
  const args = objectRecord(record.args);
  const acceptanceCriteria = requiredStringArray(record.acceptanceCriteria);
  const failureCriteria = requiredStringArray(record.failureCriteria);
  if (!taskId || !title || !toolId || !target || !dependencies || !args || !acceptanceCriteria || !failureCriteria) {
    return undefined;
  }
  return {
    taskId,
    title,
    toolId,
    target,
    dependencies,
    args,
    acceptanceCriteria,
    failureCriteria,
  };
}

function hasDuplicateTaskField(node: JsonStructureNode): boolean {
  return [
    'taskId',
    'title',
    'toolId',
    'target',
    'dependencies',
    'args',
    'acceptanceCriteria',
    'failureCriteria',
  ].some((key) => duplicateField(node, key));
}

function parseCompleteNode(source: string, node: JsonStructureNode): unknown {
  try {
    return JSON.parse(source.slice(node.start, node.end)) as unknown;
  } catch {
    return undefined;
  }
}

function field(node: JsonStructureNode, key: string): JsonStructureNode | undefined {
  return node.fields?.find((candidate) => candidate.key === key)?.value;
}

function duplicateField(node: JsonStructureNode, key: string): boolean {
  return (node.fields?.filter((candidate) => candidate.key === key).length ?? 0) > 1;
}

function emptyDraft(toolName: SessionSemanticDraftToolName, complete: boolean): DecodedSessionSemanticDraft {
  if (toolName === 'session.submit_answer') {
    return {
      kind: 'answer',
      toolName,
      complete,
      visibleCharLength: 0,
      answer: { content: '' },
    };
  }
  return {
    kind: 'plan',
    toolName,
    complete,
    visibleCharLength: 0,
    plan: { tasks: [], risks: [], reviewCheckpoints: [] },
  };
}

function visiblePlanCharLength(plan: NonNullable<DecodedSessionSemanticDraft['plan']>): number {
  return (plan.title?.length ?? 0) +
    (plan.summary?.length ?? 0) +
    plan.tasks.reduce((total, task) => total + task.title.length + task.taskId.length, 0) +
    plan.risks.reduce((total, item) => total + item.length, 0) +
    plan.reviewCheckpoints.reduce((total, item) => total + item.length, 0);
}

function arrayPrefixMatches<T>(prefix: T[], value: T[]): boolean {
  if (prefix.length > value.length) return false;
  return prefix.every((item, index) => JSON.stringify(item) === JSON.stringify(value[index]));
}

function stringArrayPrefixMatches(prefix: string[], value: string[]): boolean {
  if (prefix.length > value.length) return false;
  return prefix.every((item, index) => item === value[index]);
}

function requiredStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output = value.map(stringValue);
  return output.every((item): item is string => Boolean(item)) ? output : undefined;
}

function stringArray(value: unknown): string[] {
  return requiredStringArray(value) ?? [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function success(draft: DecodedSessionSemanticDraft): { ok: true; draft: DecodedSessionSemanticDraft } {
  return { ok: true, draft };
}

function failure(
  failureCode: string,
  message: string
): { ok: false; failure: SessionSemanticDraftDecodeFailure } {
  return { ok: false, failure: { failureCode, message } };
}

class IncrementalJsonStructureScanner {
  private position = 0;
  private error?: string;

  constructor(private readonly source: string) {}

  scan(): JsonStructureScan {
    this.skipWhitespace();
    if (this.position >= this.source.length) return {};
    const root = this.readValue();
    if (this.error) return { error: this.error };
    if (root.complete) {
      this.skipWhitespace();
      if (this.position < this.source.length) {
        return { error: 'Semantic tool arguments contain data after the root JSON value.' };
      }
    }
    return { root };
  }

  private readValue(): JsonStructureNode {
    this.skipWhitespace();
    const start = this.position;
    if (start >= this.source.length) return this.incomplete(start);
    const current = this.source[start];
    if (current === '{') return this.readObject();
    if (current === '[') return this.readArray();
    if (current === '"') return this.readString();
    if (current === '-' || isDigit(current)) return this.readNumber();
    if (current === 't') return this.readLiteral('true');
    if (current === 'f') return this.readLiteral('false');
    if (current === 'n') return this.readLiteral('null');
    this.fail(`Unexpected JSON character at offset ${start}.`);
    return this.incomplete(start);
  }

  private readObject(): JsonStructureNode {
    const start = this.position;
    this.position += 1;
    const fields: JsonFieldNode[] = [];
    this.skipWhitespace();
    if (this.consume('}')) return { kind: 'object', start, end: this.position, complete: true, fields };
    while (!this.error) {
      this.skipWhitespace();
      if (this.position >= this.source.length) {
        return { kind: 'object', start, end: this.position, complete: false, fields };
      }
      if (this.source[this.position] !== '"') {
        this.fail(`JSON object key must be a string at offset ${this.position}.`);
        break;
      }
      const keyNode = this.readString();
      if (!keyNode.complete) return { kind: 'object', start, end: this.position, complete: false, fields };
      this.skipWhitespace();
      if (!this.consume(':')) {
        if (this.position >= this.source.length) {
          return { kind: 'object', start, end: this.position, complete: false, fields };
        }
        this.fail(`JSON object field is missing ':' at offset ${this.position}.`);
        break;
      }
      const value = this.readValue();
      fields.push({ key: keyNode.stringValue ?? '', value });
      if (!value.complete) return { kind: 'object', start, end: this.position, complete: false, fields };
      this.skipWhitespace();
      if (this.consume('}')) return { kind: 'object', start, end: this.position, complete: true, fields };
      if (!this.consume(',')) {
        if (this.position >= this.source.length) {
          return { kind: 'object', start, end: this.position, complete: false, fields };
        }
        this.fail(`JSON object fields must be separated by ',' at offset ${this.position}.`);
        break;
      }
      this.skipWhitespace();
      if (this.position < this.source.length && this.source[this.position] === '}') {
        this.fail(`JSON object contains a trailing comma at offset ${this.position}.`);
        break;
      }
    }
    return { kind: 'object', start, end: this.position, complete: false, fields };
  }

  private readArray(): JsonStructureNode {
    const start = this.position;
    this.position += 1;
    const elements: JsonStructureNode[] = [];
    this.skipWhitespace();
    if (this.consume(']')) return { kind: 'array', start, end: this.position, complete: true, elements };
    while (!this.error) {
      const value = this.readValue();
      elements.push(value);
      if (!value.complete) return { kind: 'array', start, end: this.position, complete: false, elements };
      this.skipWhitespace();
      if (this.consume(']')) return { kind: 'array', start, end: this.position, complete: true, elements };
      if (!this.consume(',')) {
        if (this.position >= this.source.length) {
          return { kind: 'array', start, end: this.position, complete: false, elements };
        }
        this.fail(`JSON array items must be separated by ',' at offset ${this.position}.`);
        break;
      }
      this.skipWhitespace();
      if (this.position < this.source.length && this.source[this.position] === ']') {
        this.fail(`JSON array contains a trailing comma at offset ${this.position}.`);
        break;
      }
    }
    return { kind: 'array', start, end: this.position, complete: false, elements };
  }

  private readString(): JsonStructureNode {
    const start = this.position;
    this.position += 1;
    const contentStart = this.position;
    while (this.position < this.source.length) {
      const current = this.source[this.position];
      if (current === '"') {
        this.position += 1;
        try {
          return {
            kind: 'string',
            start,
            end: this.position,
            complete: true,
            stringValue: JSON.parse(this.source.slice(start, this.position)) as string,
          };
        } catch {
          this.fail(`Invalid JSON string at offset ${start}.`);
          return this.incomplete(start);
        }
      }
      if (current.charCodeAt(0) < 0x20) {
        this.fail(`JSON string contains a control character at offset ${this.position}.`);
        return this.incomplete(start);
      }
      if (current === '\\') {
        const escapeStart = this.position;
        this.position += 1;
        if (this.position >= this.source.length) {
          return this.partialString(start, contentStart, escapeStart);
        }
        const escaped = this.source[this.position];
        if (escaped === 'u') {
          const digitsStart = this.position + 1;
          const digitsEnd = digitsStart + 4;
          if (digitsEnd > this.source.length) {
            return this.partialString(start, contentStart, escapeStart);
          }
          if (!/^[0-9a-fA-F]{4}$/u.test(this.source.slice(digitsStart, digitsEnd))) {
            this.fail(`JSON Unicode escape is invalid at offset ${escapeStart}.`);
            return this.incomplete(start);
          }
          this.position = digitsEnd;
          continue;
        }
        if (!'"\\/bfnrt'.includes(escaped)) {
          this.fail(`JSON escape is invalid at offset ${escapeStart}.`);
          return this.incomplete(start);
        }
      }
      this.position += 1;
    }
    return this.partialString(start, contentStart, this.source.length);
  }

  private readNumber(): JsonStructureNode {
    const start = this.position;
    while (this.position < this.source.length && /[-+0-9.eE]/u.test(this.source[this.position])) {
      this.position += 1;
    }
    if (this.position >= this.source.length) return this.incomplete(start);
    try {
      JSON.parse(this.source.slice(start, this.position));
      return { kind: 'number', start, end: this.position, complete: true };
    } catch {
      this.fail(`Invalid JSON number at offset ${start}.`);
      return this.incomplete(start);
    }
  }

  private readLiteral(expected: 'true' | 'false' | 'null'): JsonStructureNode {
    const start = this.position;
    const remaining = this.source.slice(start);
    if (expected.startsWith(remaining)) {
      this.position = this.source.length;
      return this.incomplete(start);
    }
    if (!remaining.startsWith(expected)) {
      this.fail(`Invalid JSON literal at offset ${start}.`);
      return this.incomplete(start);
    }
    this.position += expected.length;
    return { kind: 'literal', start, end: this.position, complete: true };
  }

  private partialString(start: number, contentStart: number, safeEnd: number): JsonStructureNode {
    return {
      kind: 'string',
      start,
      end: this.position,
      complete: false,
      stringValue: decodeJsonStringPrefix(this.source.slice(contentStart, safeEnd)),
    };
  }

  private incomplete(start: number): JsonStructureNode {
    return { kind: 'incomplete', start, end: this.position, complete: false };
  }

  private skipWhitespace(): void {
    while (this.position < this.source.length && /\s/u.test(this.source[this.position])) this.position += 1;
  }

  private consume(expected: string): boolean {
    if (this.source[this.position] !== expected) return false;
    this.position += 1;
    return true;
  }

  private fail(message: string): void {
    this.error ??= message;
  }
}

function decodeJsonStringPrefix(value: string): string {
  let output = '';
  for (let index = 0; index < value.length;) {
    const current = value[index];
    if (current !== '\\') {
      const code = current.charCodeAt(0);
      if (isHighSurrogate(code)) {
        const next = value.charCodeAt(index + 1);
        if (!isLowSurrogate(next)) break;
        output += `${current}${value[index + 1]}`;
        index += 2;
        continue;
      }
      if (isLowSurrogate(code)) break;
      output += current;
      index += 1;
      continue;
    }

    const escaped = value[index + 1];
    if (!escaped) break;
    const simple: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escaped !== 'u') {
      const decoded = simple[escaped];
      if (decoded === undefined) break;
      output += decoded;
      index += 2;
      continue;
    }

    const digits = value.slice(index + 2, index + 6);
    if (!/^[0-9a-fA-F]{4}$/u.test(digits)) break;
    const code = Number.parseInt(digits, 16);
    if (isHighSurrogate(code)) {
      if (value.slice(index + 6, index + 8) !== '\\u') break;
      const lowDigits = value.slice(index + 8, index + 12);
      if (!/^[0-9a-fA-F]{4}$/u.test(lowDigits)) break;
      const low = Number.parseInt(lowDigits, 16);
      if (!isLowSurrogate(low)) break;
      output += String.fromCharCode(code, low);
      index += 12;
      continue;
    }
    if (isLowSurrogate(code)) break;
    output += String.fromCharCode(code);
    index += 6;
  }
  return output;
}

function isDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}
