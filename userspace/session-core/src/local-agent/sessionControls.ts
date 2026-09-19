import type {
  ExecutionPlanStep,
  InteractionOption,
  JsonObject,
  ModelInteractionRequest,
  PlanOperation,
  ProviderToolDefinition,
  TodoItem,
} from '@deepcode/protocol';
import {
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_UPDATE,
  SESSION_CONTROL_PLUGIN_ACTIVATE,
} from '@deepcode/protocol';

export interface SessionControlWireNames {
  interactionRequest: string;
  planPublish: string;
  todoUpdate: string;
  pluginActivate: string;
}

export function confirmedPlanExecutionInstruction(): string {
  return 'The Plan is confirmed. Execute it now. Its approved scope remains valid for this run.';
}

export function sessionControlInstructions(
  names: SessionControlWireNames,
  hasWorkspaceBindings = true,
  hasPluginDiscovery = false,
): string {
  const decisions = ` Ask for missing information or decisions with ${names.interactionRequest}; confirmation opens a panel and resumes this run after the answer. Correct rejected inputs; Kernel handles permission approval.`;
  const plugins = hasPluginDiscovery ? ` Discover plugins when the task needs unlisted capabilities. ${names.pluginActivate} loads enabled plugins for this run; activation in a previous run does not make those tools available now. The current tool list is authoritative. User mentions are optional guidance. Loading does not grant tool permissions. Call it alone, then use the new tools.` : '';
  const progress = ` For multi-step work, use ${names.todoUpdate} when useful. Keep phases few and meaningful, merging similar work; choose the count to fit the task. Skip trivial work and unchanged updates; no update is required per tool call or before answering. Send the complete current list in one update, optionally alongside ordinary calls. Todo grants no permissions and does not gate completion; keep unfinished work honest.`;
  if (!hasWorkspaceBindings) {
    return `Explicit commentary is progress and may continue without calls; unphased text without calls is the final answer. ${names.interactionRequest} must be the only call in its turn. No workspace is bound to this run; do not invent a workspace handle or request workspace operations.${progress}${decisions}${plugins}`;
  }
  return `Explicit commentary is progress and may continue without calls; unphased text without calls is the final answer. ${names.interactionRequest} and ${names.planPublish} must each be the only call in their turn. Use a logical workspace handle from the Session binding list and workspace-relative paths; never invent or expose a workspaceId.${progress}${decisions}${plugins}`;
}

const INTERACTION_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'prompt', 'allowFreeform'],
  properties: {
    kind: { type: 'string', enum: ['question', 'confirmation'] },
    prompt: { type: 'string', minLength: 1, description: 'Markdown prose. Use actual paragraph breaks, not literal backslash-n text.' },
    options: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'label'],
        properties: {
          id: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
        },
      },
    },
    allowFreeform: { type: 'boolean' },
  },
};

const PLAN_OPERATION_SCHEMA: JsonObject = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'operation', 'target'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: {
          type: 'string',
          enum: ['fs.write', 'fs.edit', 'document.render', 'browser.capture'],
        },
        target: { type: 'string', minLength: 1 },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'], description: 'Omit or use file for one file. directoryTree explicitly permits creating and editing descendant files; it does not permit deletion.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'operation', 'target', 'targetKind'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: { type: 'string', enum: ['fs.delete'] },
        target: { type: 'string', minLength: 1 },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'] },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspace', 'operation', 'writablePaths'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: { type: 'string', enum: ['bash', 'powershell'] },
        command: { type: 'string', minLength: 1, maxLength: 16_384 },
        writablePaths: {
          type: 'array', minItems: 1,
          description: 'Declared files and directories this operation may modify, including build/output directories. A directory includes its descendants. Kernel applies the configured Shell permissions; command text is not an authorization lock.',
          items: { type: 'object', additionalProperties: false, required: ['path', 'kind'], properties: {
            path: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['file', 'directory'] },
          } },
        },
        terminal: {
          type: 'object',
          additionalProperties: false,
          required: ['stdin'],
          properties: {
            stdin: { type: 'string', maxLength: 65_536 },
          },
        },
      },
    },
  ],
};

const PLAN_TITLE_SCHEMA: JsonObject = {
  type: 'string', minLength: 1, maxLength: 240,
  pattern: '^[^\\s\\u0000-\\u001f\\u007f](?:[^\\u0000-\\u001f\\u007f]*[^\\s\\u0000-\\u001f\\u007f])?$(?![\\s\\S])',
  description: 'Single-line inline Markdown title, at most 240 characters. No leading/trailing whitespace, line breaks or control characters. Put paragraphs in summary/details.',
};

const PLAN_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'mutationManifest'],
  anyOf: [{ required: ['title', 'steps'] }, { required: ['mode'] }],
  properties: {
    mode: { type: 'string', enum: ['extendScope'], description: 'Only to add scope to the current confirmed Plan: submit summary (reason) and mutationManifest (additions), omitting title and steps. Existing phases and verification are preserved; user confirmation is still required.' },
    title: PLAN_TITLE_SCHEMA,
    summary: { type: 'string', minLength: 1, description: 'Markdown prose. Use actual paragraph breaks, not literal backslash-n text.' },
    steps: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stepId', 'title', 'details'],
        properties: {
          stepId: { type: 'string', minLength: 1, maxLength: 128 },
          title: PLAN_TITLE_SCHEMA,
          details: { type: 'string', minLength: 1 },
          verification: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    mutationManifest: {
      type: 'array',
      items: PLAN_OPERATION_SCHEMA,
    },
  },
};

export type SessionControlCall =
  | { kind: 'pluginActivate'; callId: string; pluginUris: string[] }
  | {
      kind: 'todoUpdate';
      callId: string;
      items: TodoItem[];
    }
  | {
      kind: 'interaction';
      callId: string;
      request: ModelInteractionRequest;
    }
  | {
      kind: 'plan';
      callId: string;
      draft: PlanPublicationDraft | PlanScopeExtension;
    };

export interface PlanPublicationDraft {
  title: string;
  summary: string;
  steps: ExecutionPlanStep[];
  mutationManifest: PlanOperation[];
}

export interface PlanScopeExtension {
  mode: 'extendScope';
  summary: string;
  mutationManifest: PlanOperation[];
}

export function sessionControlToolDefinitions(): readonly ProviderToolDefinition[] {
  return [
    {
      name: SESSION_CONTROL_PLUGIN_ACTIVATE,
      description: 'Load installed, enabled plugins needed for the current task. Discover exact URIs with plugin search first. User mentions are optional and remain separate user guidance. This adds plugin tools/instructions to the next request in this run; it does not install, enable disabled plugins, change settings or authorize their effects. Must be the only call in its turn.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['pluginUris'], properties: {
        pluginUris: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true,
          items: { type: 'string', pattern: '^plugin://[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$' } },
      } },
    },
    {
      name: SESSION_CONTROL_INTERACTION_REQUEST,
      description: 'Ask the user for missing information or a required decision, then pause the run.',
      inputSchema: structuredClone(INTERACTION_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_PLAN_PUBLISH,
      description: 'Propose a Plan for user confirmation. Keep steps to a few meaningful outcome phases, merging similar work instead of listing files, commands or implementation recipes; choose the count to fit the task. New tasks need not repeat completed history. For scope additions only, use mode=extendScope with summary explaining why and mutationManifest containing additions; Session preserves the approved phases and verification; Todo stays independent. If the task needs a rewritten Plan, omit mode, retain existing stepIds and submit title, summary, steps and the full effective manifest. Scope expansion and Plan rewrites take effect only after user confirmation. fs.edit/fs.write/document.render/browser.capture share file or explicit directoryTree scope; deletion is separate. When creating a module, propose its specific directoryTree scope upfront so new implementation files within that approved directory need no extra confirmation; list unrelated root files separately. Bash command is an optional example, not an exact script lock. Routine fixes within confirmed scope need no reconfirmation. Titles use inline Markdown; other text uses Markdown.',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_TODO_UPDATE,
      description: 'Replace the complete ordered task list when progress meaningfully changes. Keep phases few and meaningful, merging similar work; choose the count to fit the task and revise the list as needed. Report pending, inProgress, completed or blocked work; an empty list clears it. No Plan, record IDs or approval needed; unfinished items do not prevent answering. At most one update per turn; ordinary calls may accompany it.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['items'],
        properties: { items: { type: 'array', items: {
          type: 'object', additionalProperties: false, required: ['text', 'status'],
          properties: {
            text: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['pending', 'inProgress', 'completed', 'blocked'] },
          },
        } } },
      },
    },
  ];
}

export function decodeSessionControlCall(
  callId: string,
  name: string,
  input: JsonObject,
): SessionControlCall | null {
  if (
    name !== SESSION_CONTROL_INTERACTION_REQUEST
    && name !== SESSION_CONTROL_PLAN_PUBLISH
    && name !== SESSION_CONTROL_TODO_UPDATE
    && name !== SESSION_CONTROL_PLUGIN_ACTIVATE
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
  if (name === SESSION_CONTROL_PLUGIN_ACTIVATE) {
    assertExactKeys(input, ['pluginUris']);
    if (!Array.isArray(input.pluginUris) || input.pluginUris.length < 1 || input.pluginUris.length > 16
      || input.pluginUris.some(uri => typeof uri !== 'string' || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(uri))
      || new Set(input.pluginUris).size !== input.pluginUris.length) {
      throw new SessionControlError('plugin_selection_invalid', 'pluginUris 必须包含 1 至 16 个不重复的已发现插件 URI。');
    }
    return { kind: 'pluginActivate', callId: canonicalCallId, pluginUris: input.pluginUris as string[] };
  }
  if (name === SESSION_CONTROL_TODO_UPDATE) {
    assertExactKeys(input, ['items']);
    if (!Array.isArray(input.items)) {
      throw new SessionControlError('todo_update_invalid', 'items must be the complete ordered task list.');
    }
    const items = input.items.map((item): TodoItem => {
      if (!isRecord(item)) throw new SessionControlError('todo_update_invalid', 'Each task must be an object.');
      assertExactKeys(item, ['text', 'status']);
      if (typeof item.status !== 'string' || !['pending', 'inProgress', 'completed', 'blocked'].includes(item.status)) {
        throw new SessionControlError('todo_update_invalid', 'Task status must be pending, inProgress, completed or blocked.');
      }
      return { text: requiredText(item.text, 'text'), status: item.status as TodoItem['status'] };
    });
    return { kind: 'todoUpdate', callId: canonicalCallId, items };
  }
  if (name === SESSION_CONTROL_INTERACTION_REQUEST) {
    return {
      kind: 'interaction',
      callId: canonicalCallId,
      request: decodeInteraction(input),
    };
  }
  return {
    kind: 'plan',
    callId: canonicalCallId,
    draft: decodePlan(input),
  };
}

function decodeInteraction(value: Record<string, unknown>): ModelInteractionRequest {
  assertExactKeys(value, ['kind', 'prompt', 'options', 'allowFreeform'], ['options']);
  if (value.kind !== 'question' && value.kind !== 'confirmation') {
    throw new SessionControlError(
      'session_control_interaction_kind_invalid',
      'interaction.request kind 必须是 question 或 confirmation。',
    );
  }
  if (typeof value.allowFreeform !== 'boolean') {
    throw new SessionControlError(
      'session_control_interaction_freeform_invalid',
      'interaction.request 必须明确 allowFreeform。',
    );
  }
  const request: ModelInteractionRequest = {
    kind: value.kind,
    prompt: requiredText(value.prompt, 'prompt'),
    allowFreeform: value.allowFreeform,
    ...(value.options === undefined ? {} : { options: decodeInteractionOptions(value.options) }),
  };
  if (!request.allowFreeform && (request.options?.length ?? 0) === 0) {
    throw new SessionControlError(
      'session_control_interaction_unanswerable',
      '不允许自由输入的 interaction.request 必须提供选项。',
    );
  }
  return request;
}

function decodePlan(value: Record<string, unknown>): PlanPublicationDraft | PlanScopeExtension {
  if (value.mode === 'extendScope') {
    assertExactKeys(value, ['mode', 'summary', 'mutationManifest'], [], 'plan scope extension');
    return { mode: 'extendScope', summary: requiredText(value.summary, 'summary'), mutationManifest: decodeManifest(value.mutationManifest) };
  }
  assertExactKeys(value, ['title', 'summary', 'steps', 'mutationManifest'], [], 'plan');
  if (!Array.isArray(value.steps) || value.steps.length < 1) {
    throw new SessionControlError(
      'session_control_plan_steps_invalid',
      'plan.publish steps 必须包含至少一个阶段。',
    );
  }
  const stepIds = new Set<string>();
  const title = requiredDisplayText(value.title, 'title', 240);
  const summary = requiredText(value.summary, 'summary');
  const steps = value.steps.map((candidate, index) => decodePlanStep(candidate, stepIds, index));
  return { title, summary, steps, mutationManifest: decodeManifest(value.mutationManifest) };
}

function decodeManifest(value: unknown): PlanOperation[] {
  if (!Array.isArray(value)) {
    throw new SessionControlError('session_control_plan_manifest_invalid', 'plan.publish mutationManifest 必须是数组。');
  }
  const mutationManifest: PlanOperation[] = [];
  const shapeErrors: string[] = [];
  for (const [index, candidate] of value.entries()) {
    try { mutationManifest.push(decodePlanOperation(candidate, index)); }
    catch (error) {
      if (!(error instanceof SessionControlError) || error.code !== 'session_control_shape_invalid') throw error;
      shapeErrors.push(error.message);
    }
  }
  // Return every invalid manifest shape in the same correction result.
  // No partially decoded plan is published.
  if (shapeErrors.length) throw new SessionControlError('session_control_shape_invalid', shapeErrors.join('\n'));
  return mutationManifest;
}

function decodePlanStep(value: unknown, seen: Set<string>, index: number): ExecutionPlanStep {
  if (!isRecord(value)) {
    throw new SessionControlError('session_control_plan_step_invalid', 'Plan step 必须是对象。');
  }
  assertExactKeys(value, ['stepId', 'title', 'details', 'verification'], ['verification'], `steps[${index}]`);
  const stepId = requiredIdentifier(value.stepId, 'stepId');
  if (seen.has(stepId)) {
    throw new SessionControlError(
      'session_control_plan_step_duplicate',
      'Plan stepId 不能重复。',
    );
  }
  seen.add(stepId);
  if (
    value.verification !== undefined
    && !Array.isArray(value.verification)
  ) {
    throw new SessionControlError(
      'session_control_plan_verification_invalid',
      'Plan step verification 必须是字符串数组。',
    );
  }
  return {
    stepId,
    title: requiredDisplayText(value.title, 'title', 240),
    details: requiredText(value.details, 'details'),
    ...(value.verification === undefined
      ? {}
      : {
          verification: value.verification.map((entry, index) => (
            requiredText(entry, `verification[${index}]`)
          )),
        }),
  };
}

function decodePlanOperation(value: unknown, index: number): PlanOperation {
  if (!isRecord(value)) {
    throw new SessionControlError(
      'session_control_plan_operation_invalid',
      'Plan operation 必须是对象。',
    );
  }
  const operation = value.operation;
  const workspaceId = requiredIdentifier(value.workspaceId, 'workspaceId');
  if (operation === 'bash' || operation === 'powershell') {
    assertExactKeys(
      value,
      ['workspaceId', 'operation', 'command', 'terminal', 'writablePaths'],
      ['command', 'terminal'],
      `mutationManifest[${index}]`,
    );
    const command = value.command === undefined ? undefined : requiredText(value.command, 'command');
    if (command !== undefined && command.length > 16_384) {
      throw new SessionControlError('session_control_plan_shell_invalid', 'Shell Plan command 不得超过 16384 个字符。');
    }
    const terminal = value.terminal === undefined ? undefined : decodeTerminalInput(value.terminal);
    if (!Array.isArray(value.writablePaths) || !value.writablePaths.length) {
      throw new SessionControlError('session_control_plan_shell_invalid', 'writablePaths 必须包含至少一个可写文件或目录。');
    }
    const writablePaths = value.writablePaths.map((entry) => {
      if (!isRecord(entry) || entry.kind !== 'file' && entry.kind !== 'directory') {
        throw new SessionControlError('session_control_plan_shell_invalid', 'writablePaths 项必须包含 path 和 kind=file|directory。');
      }
      assertExactKeys(entry, ['path', 'kind'], [], 'writablePaths');
      return { path: normalizedTarget(entry.path), kind: entry.kind as 'file' | 'directory' };
    });
    return {
      workspaceId, operation, writablePaths,
      ...(command === undefined ? {} : { command }),
      ...(terminal ? { terminal } : {}),
    };
  }

  const target = normalizedTarget(value.target);
  if (operation === 'fs.delete') {
    assertExactKeys(value, ['workspaceId', 'operation', 'target', 'targetKind'], [], `mutationManifest[${index}]`);
    if (value.targetKind !== 'file' && value.targetKind !== 'directoryTree') {
      throw new SessionControlError(
        'session_control_plan_target_kind_invalid',
        'fs.delete 必须明确 targetKind=file 或 directoryTree。',
      );
    }
    return { workspaceId, operation, target, targetKind: value.targetKind };
  }
  assertExactKeys(value, ['workspaceId', 'operation', 'target', 'targetKind'], ['targetKind'], `mutationManifest[${index}]`);
  if (value.targetKind !== undefined && value.targetKind !== 'file' && value.targetKind !== 'directoryTree') {
    throw new SessionControlError('session_control_plan_target_kind_invalid', '写入范围的 targetKind 必须是 file 或 directoryTree。');
  }
  if (!['fs.write', 'fs.edit', 'document.render', 'browser.capture'].includes(String(operation))) {
    throw new SessionControlError(
      'session_control_plan_operation_unknown',
      'Plan operation 不属于 v2 闭合集合。',
    );
  }
  return {
    workspaceId,
    operation: operation as Exclude<PlanOperation['operation'], 'fs.delete' | 'bash' | 'powershell'>,
    target,
    ...(value.targetKind === undefined ? {} : { targetKind: value.targetKind }),
  };
}

function decodeTerminalInput(value: unknown): { stdin: string } {
  if (!isRecord(value)) {
    throw new SessionControlError(
      'session_control_plan_shell_invalid',
      'bash terminal 必须是对象。',
    );
  }
  assertExactKeys(value, ['stdin']);
  if (
    typeof value.stdin !== 'string'
    || new TextEncoder().encode(value.stdin).byteLength > 65_536
  ) {
    throw new SessionControlError(
      'session_control_plan_shell_invalid',
      'bash terminal.stdin 必须是不超过 65536 bytes 的字符串。',
    );
  }
  return { stdin: value.stdin };
}

function decodeInteractionOptions(value: unknown): InteractionOption[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new SessionControlError(
      'session_control_interaction_options_invalid',
      'interaction.request options 必须是最多八项的数组。',
    );
  }
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new SessionControlError(
        'session_control_interaction_option_invalid',
        '交互选项必须是对象。',
      );
    }
    assertExactKeys(candidate, ['id', 'label', 'description'], ['description']);
    const id = requiredIdentifier(candidate.id, 'id');
    if (seen.has(id)) {
      throw new SessionControlError(
        'session_control_interaction_option_duplicate',
        '交互选项 id 不能重复。',
      );
    }
    seen.add(id);
    return {
      id,
      label: requiredText(candidate.label, 'label'),
      ...(candidate.description === undefined
        ? {}
        : { description: requiredText(candidate.description, 'description') }),
    };
  });
}

function normalizedTarget(value: unknown): string {
  const target = requiredText(value, 'target');
  const segments = target.split('/');
  if (
    target.trim() !== target
    || target.startsWith('/')
    || target.includes('\\')
    || target.includes('\0')
    || segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new SessionControlError(
      'session_control_plan_target_invalid',
      'Plan target 必须是无歧义的 workspace-relative normalized path。',
    );
  }
  return target;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_000_000) {
    throw new SessionControlError(
      'session_control_field_invalid',
      `Session control 字段 ${field} 必须是非空字符串。`,
    );
  }
  return value;
}

function requiredIdentifier(value: unknown, field: string): string {
  const id = requiredText(value, field);
  if (id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    throw new SessionControlError(
      'session_control_identifier_invalid',
      `Session control 字段 ${field} 不是有效标识。`,
    );
  }
  return id;
}

function requiredDisplayText(value: unknown, field: string, maxLength: number): string {
  const text = requiredText(value, field);
  if (
    text.trim() !== text
    || [...text].length > maxLength
    || [...text].some((character) => /[\u0000-\u001f\u007f]/u.test(character))
  ) {
    throw new SessionControlError(
      'session_control_display_text_invalid',
      `Session control 字段 ${field} 必须是单行标题，最多 ${maxLength} 个字符，首尾不能有空白，不能包含换行或控制字符。段落请写入 summary/details。`,
    );
  }
  return text;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
  location = 'call',
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  const unexpected = Object.keys(value).filter((key) => !allowedSet.has(key));
  const missing = allowed.filter((key) => !optionalSet.has(key) && value[key] === undefined);
  if (unexpected.length || missing.length) {
    const wireField = (key: string) => key === 'workspaceId' ? 'workspace' : key;
    const details = [
      ...(unexpected.length ? [`不支持字段 ${unexpected.map(wireField).join(', ')}`] : []),
      ...(missing.length ? [`缺少字段 ${missing.map(wireField).join(', ')}`] : []),
    ].join('；');
    throw new SessionControlError(
      'session_control_shape_invalid',
      `Session control ${location} 字段与当前 schema 不一致：${details}。允许字段：${allowed.map(wireField).join(', ')}。`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export class SessionControlError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SessionControlError';
  }
}
