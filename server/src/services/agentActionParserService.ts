import type {
  AgentActionParseRequest,
  AgentActionParseResult,
  AgentFixtureRunRequest,
  AgentFixtureRunResult,
  AgentMode,
  AgentObservation,
  ParsedAgentAction,
  ParsedAgentActionError,
  ParsedAgentActionType,
  ToolCall,
} from '@deepcode/protocol';
import {
  evaluateAgentPermission,
  executeAgentTool,
} from './agentToolService.js';

type RawAction = Record<string, unknown> & { type?: unknown };

const ACTION_TYPES = new Set<ParsedAgentActionType>([
  'fs.read',
  'fs.list',
  'code.search',
  'patch.plan',
  'fs.write',
  'fs.diff',
  'shell.propose',
  'final',
]);

function now(): string {
  return new Date().toISOString();
}

function nextId(prefix: string, index: number): string {
  return `${prefix}-${Date.now()}-${index}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return undefined;
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z][\w-]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(raw))) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

function pathError(path: string | undefined): ParsedAgentActionError | undefined {
  if (!path) return { code: 'missing_path', message: 'Missing path.' };
  if (path.includes('\0')) {
    return { code: 'invalid_path', message: 'Path contains a NUL byte.' };
  }
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return {
      code: 'absolute_path_blocked',
      message: `Agent action paths must be workspace-relative: ${path}`,
    };
  }
  if (path.split(/[\\/]+/).includes('..')) {
    return {
      code: 'path_traversal_blocked',
      message: `Path traversal is blocked: ${path}`,
    };
  }
  return undefined;
}

function validateAction(
  type: ParsedAgentActionType,
  payload: Record<string, unknown>
): ParsedAgentActionError[] {
  const errors: ParsedAgentActionError[] = [];

  if (type === 'fs.read' || type === 'fs.list' || type === 'fs.write' || type === 'fs.diff') {
    const err = pathError(asString(payload.path));
    if (err) errors.push(err);
  }

  if (type === 'patch.plan') {
    const err = pathError(asString(payload.path));
    if (err) errors.push(err);
    if (parseNumber(payload.startLine) === undefined || parseNumber(payload.endLine) === undefined) {
      errors.push({
        code: 'missing_range',
        message: 'patch.plan requires startLine and endLine.',
      });
    }
  }

  if (type === 'code.search' && !asString(payload.query)) {
    errors.push({ code: 'missing_query', message: 'code.search requires query.' });
  }

  if (type === 'shell.propose' && !asString(payload.command)) {
    errors.push({ code: 'missing_command', message: 'shell.propose requires command.' });
  }

  if (type === 'fs.write' && !asString(payload.content)) {
    errors.push({ code: 'missing_content', message: 'fs.write requires content.' });
  }

  if (type === 'fs.diff' && !asString(payload.newContent)) {
    errors.push({ code: 'missing_new_content', message: 'fs.diff requires newContent.' });
  }

  return errors;
}

function normalizeRawAction(raw: RawAction): {
  type?: ParsedAgentActionType;
  payload: Record<string, unknown>;
  errors: ParsedAgentActionError[];
} {
  const rawType = asString(raw.type);
  const errors: ParsedAgentActionError[] = [];
  if (!rawType || !ACTION_TYPES.has(rawType as ParsedAgentActionType)) {
    errors.push({
      code: 'unknown_action_type',
      message: `Unsupported action type: ${rawType ?? '(missing)'}`,
    });
    return { payload: {}, errors };
  }

  const type = rawType as ParsedAgentActionType;
  const payload: Record<string, unknown> = { ...raw };
  delete payload.type;
  if (type === 'code.search' && typeof payload.regex !== 'undefined') {
    payload.isRegex = parseBool(payload.regex);
    delete payload.regex;
  }

  return {
    type,
    payload,
    errors: validateAction(type, payload),
  };
}

function makeAction(
  sourceMessageId: string,
  index: number,
  parseSource: ParsedAgentAction['parseSource'],
  raw: RawAction
): ParsedAgentAction {
  const normalized = normalizeRawAction(raw);
  return {
    id: nextId('act', index),
    sourceMessageId,
    type: normalized.type ?? 'final',
    payload: normalized.payload,
    parseSource,
    status: normalized.errors.length > 0 ? 'invalid' : 'parsed',
    errors: normalized.errors.length > 0 ? normalized.errors : undefined,
  };
}

function parseJsonBlocks(
  content: string,
  sourceMessageId: string,
  startIndex: number
): { actions: ParsedAgentAction[]; errors: ParsedAgentActionError[] } {
  const actions: ParsedAgentAction[] = [];
  const errors: ParsedAgentActionError[] = [];
  const blockPattern = /```deepcode-action\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  let index = startIndex;

  while ((match = blockPattern.exec(content))) {
    const rawJson = match[1].trim();
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      if (!isRecord(parsed) || !Array.isArray(parsed.actions)) {
        errors.push({
          code: 'invalid_action_block',
          message: 'deepcode-action block must contain an actions array.',
        });
        continue;
      }
      for (const rawAction of parsed.actions) {
        index += 1;
        actions.push(
          makeAction(
            sourceMessageId,
            index,
            'jsonBlock',
            isRecord(rawAction) ? rawAction : { type: undefined }
          )
        );
      }
    } catch (err) {
      errors.push({
        code: 'json_parse_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { actions, errors };
}

function parseTagActions(
  content: string,
  sourceMessageId: string,
  startIndex: number
): ParsedAgentAction[] {
  const actions: ParsedAgentAction[] = [];
  let index = startIndex;

  const selfClosingPattern = /<(load|check)\b([^>]*)\/>/g;
  let selfClosing: RegExpExecArray | null;
  while ((selfClosing = selfClosingPattern.exec(content))) {
    const tag = selfClosing[1];
    const attrs = parseAttributes(selfClosing[2]);
    const raw =
      tag === 'load'
        ? { type: 'fs.read', path: attrs.path }
        : {
            type: 'code.search',
            query: attrs.query,
            include: attrs.path ? [attrs.path] : undefined,
            isRegex: parseBool(attrs.regex),
          };
    index += 1;
    actions.push(makeAction(sourceMessageId, index, 'tag', raw));
  }

  const pairedPattern = /<(shell|patch|final)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let paired: RegExpExecArray | null;
  while ((paired = pairedPattern.exec(content))) {
    const tag = paired[1];
    const attrs = parseAttributes(paired[2]);
    const inner = paired[3].trim();
    let raw: RawAction;
    if (tag === 'shell') {
      raw = {
        type: 'shell.propose',
        command: inner,
        cwd: attrs.cwd,
        risk: attrs.risk,
        reason: attrs.reason,
      };
    } else if (tag === 'patch') {
      raw = {
        type: 'patch.plan',
        path: attrs.path,
        startLine: parseNumber(attrs.startLine),
        endLine: parseNumber(attrs.endLine),
        oldTextSha256: attrs.oldTextSha256,
        newText: inner,
      };
    } else {
      raw = { type: 'final', content: inner };
    }
    index += 1;
    actions.push(makeAction(sourceMessageId, index, 'tag', raw));
  }

  return actions;
}

function stripMachineBlocks(content: string): string {
  return content
    .replace(/```deepcode-action\s*[\s\S]*?```/g, '')
    .replace(/<(load|check)\b[^>]*\/>/g, '')
    .replace(/<(shell|patch|final)\b[^>]*>[\s\S]*?<\/\1>/g, '')
    .trim();
}

export function parseAgentActions(request: AgentActionParseRequest): AgentActionParseResult {
  const sourceMessageId = request.sourceMessageId ?? `msg-${Date.now()}`;
  const content = request.content ?? '';
  const json = parseJsonBlocks(content, sourceMessageId, 0);
  const tags = parseTagActions(content, sourceMessageId, json.actions.length);
  const actions = [...json.actions, ...tags];

  return {
    sourceMessageId,
    actions,
    errors: json.errors,
    naturalText: stripMachineBlocks(content),
  };
}

function toToolCall(action: ParsedAgentAction): ToolCall | null {
  if (
    action.type === 'fs.read' ||
    action.type === 'fs.list' ||
    action.type === 'code.search' ||
    action.type === 'fs.diff' ||
    action.type === 'fs.write' ||
    action.type === 'shell.propose'
  ) {
    return {
      id: action.id,
      name: action.type,
      arguments: action.payload,
    };
  }
  return null;
}

function observation(
  sessionId: string,
  action: ParsedAgentAction,
  status: AgentObservation['status'],
  summary: string,
  output?: unknown,
  error?: ParsedAgentActionError
): AgentObservation {
  return {
    id: `obs-${action.id}`,
    sessionId,
    actionId: action.id,
    toolName: action.type,
    status,
    summary,
    output,
    error,
    createdAt: now(),
  };
}

export async function runAgentFixture(
  request: AgentFixtureRunRequest
): Promise<AgentFixtureRunResult> {
  const parse = parseAgentActions(request);
  const mode: AgentMode = request.mode ?? 'plan';
  const sessionId = request.sessionId ?? `fixture-${Date.now()}`;
  const observations: AgentObservation[] = [];

  for (const action of parse.actions) {
    if (action.status !== 'parsed') {
      observations.push(
        observation(
          sessionId,
          action,
          'error',
          `Invalid action: ${action.errors?.[0]?.message ?? 'unknown error'}`,
          undefined,
          action.errors?.[0]
        )
      );
      continue;
    }

    if (action.type === 'final') {
      observations.push(observation(sessionId, action, 'ok', 'Final message parsed.', action.payload));
      continue;
    }

    if (action.type === 'patch.plan') {
      observations.push(
        observation(
          sessionId,
          action,
          'needsApproval',
          'Patch plan parsed and queued for diff approval.',
          action.payload
        )
      );
      continue;
    }

    const toolCall = toToolCall(action);
    if (!toolCall) {
      observations.push(observation(sessionId, action, 'blocked', 'No executor for action.'));
      continue;
    }

    const permission = await evaluateAgentPermission({ mode, toolCall });
    if (permission.action === 'deny') {
      observations.push(
        observation(sessionId, action, 'blocked', permission.reason, undefined, {
          code: 'permission_denied',
          message: permission.reason,
        })
      );
      continue;
    }
    if (permission.action === 'ask') {
      observations.push(
        observation(sessionId, action, 'needsApproval', permission.reason, permission.request)
      );
      continue;
    }

    if (request.execute === false) {
      observations.push(observation(sessionId, action, 'ok', 'Action parsed; execution skipped.'));
      continue;
    }

    const result = await executeAgentTool({ mode, toolCall });
    observations.push(
      result.ok
        ? observation(sessionId, action, 'ok', `${toolCall.name} completed.`, result.output)
        : observation(sessionId, action, 'error', result.error ?? `${toolCall.name} failed.`, undefined, {
            code: 'tool_error',
            message: result.error ?? `${toolCall.name} failed.`,
          })
    );
  }

  return { parse, observations };
}
