import type {
  ExecutionPlanStep,
  InteractionOption,
  JsonObject,
  ModelInteractionRequest,
  PlanOperation,
  ProviderToolDefinition,
  TodoProgressUpdate,
} from '@deepcode/protocol';
import {
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_PLAN_PROGRESS,
} from '@deepcode/protocol';

export interface SessionControlWireNames {
  interactionRequest: string;
  planPublish: string;
  planProgress: string;
}

export function confirmedPlanExecutionInstruction(): string {
  return 'The Plan is confirmed. Execute it now. Report step progress from observed tool result recordIds. For scope changes, publish the complete revised Plan with existing stepIds and additional steps; unchanged steps retain progress. If execution cannot continue, explain completed work and blockers in the final answer without marking unfinished Todo completed. Request user input only for a required decision.';
}

export function sessionControlInstructions(
  names: SessionControlWireNames,
  hasWorkspaceBindings = true,
): string {
  if (!hasWorkspaceBindings) {
    return `Text with calls is progress; text without calls is the final answer. ${names.interactionRequest} must be the only call in its turn. No workspace is bound to this run; do not invent a workspace handle or request workspace operations.`;
  }
  return `Text with calls is progress; text without calls is the final answer. ${names.interactionRequest} and ${names.planPublish} must each be the only call in their turn. One ${names.planProgress} may accompany ordinary tool calls, reporting confirmed Todo progress from a tool result recordId already received before this turn; never anticipate results of calls in the same turn. Command counts do not determine step completion. Session Todo messages are chronological state updates; the latest update is current. Use a logical workspace handle from the Session binding list and workspace-relative paths; never invent or expose a workspaceId.`;
}

const INTERACTION_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'prompt', 'allowFreeform'],
  properties: {
    kind: { type: 'string', enum: ['question', 'confirmation'] },
    prompt: { type: 'string', minLength: 1 },
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
          enum: ['fs.write', 'fs.edit'],
        },
        target: { type: 'string', minLength: 1 },
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
      required: ['workspace', 'operation', 'workspaceMode', 'executionScope'],
      properties: {
        workspace: { type: 'string', minLength: 1 },
        operation: { type: 'string', enum: ['bash'] },
        command: { type: 'string', minLength: 1, maxLength: 16_384 },
        workspaceMode: { type: 'string', enum: ['write'] },
        executionScope: { type: 'string', enum: ['workspace', 'host'] },
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
  required: ['title', 'summary', 'steps', 'mutationManifest'],
  properties: {
    title: PLAN_TITLE_SCHEMA,
    summary: { type: 'string', minLength: 1 },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
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
            maxItems: 8,
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    mutationManifest: {
      type: 'array',
      maxItems: 128,
      items: PLAN_OPERATION_SCHEMA,
    },
  },
};

export type SessionControlCall =
  | {
      kind: 'planProgress';
      callId: string;
      sourceFactRef: string;
      updates: TodoProgressUpdate[];
    }
  | {
      kind: 'interaction';
      callId: string;
      request: ModelInteractionRequest;
    }
  | {
      kind: 'plan';
      callId: string;
      draft: PlanPublicationDraft;
    };

export interface PlanPublicationDraft {
  title: string;
  summary: string;
  steps: ExecutionPlanStep[];
  mutationManifest: PlanOperation[];
}

export function sessionControlToolDefinitions(): readonly ProviderToolDefinition[] {
  return [
    {
      name: SESSION_CONTROL_INTERACTION_REQUEST,
      description: 'Ask the user for missing information or a required decision, then pause the run.',
      inputSchema: structuredClone(INTERACTION_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_PLAN_PUBLISH,
      description: 'Publish a complete Plan for user confirmation. Titles use inline Markdown; summary, details and verification use Markdown. Format code names and paths with backticks. mutationManifest declares file targets, explicit deletions and Bash execution/workspace scope; fs.edit and fs.write cover the same declared file. Bash command is an optional example, not an exact script lock. Continue routine fixes within confirmed scope. Execution-time changes revise the current Plan: retain all existing stepIds (including completed steps), add new steps and submit the full effective manifest. Unchanged steps retain Todo identity and progress; changed steps become pending. Nothing is merged or authorized automatically.',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_PLAN_PROGRESS,
      description: 'Update confirmed Todo steps after examining a tool result. sourceFactRef is its recordId from this run, received before this turn, including investigation before Plan confirmation. Mark completed only when the step and its verification are done. Batch related updates into one call, optionally alongside ordinary tool calls; their future results cannot be evidence. This does not request user confirmation.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['sourceFactRef', 'updates'],
        properties: {
          sourceFactRef: { type: 'string', minLength: 1 },
          updates: { type: 'array', minItems: 1, maxItems: 12, items: {
            type: 'object', additionalProperties: false, required: ['todoId', 'status'],
            properties: {
              todoId: { type: 'string', minLength: 1 },
              status: { type: 'string', enum: ['pending', 'inProgress', 'completed'] },
            },
          } },
        },
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
    && name !== SESSION_CONTROL_PLAN_PROGRESS
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
  if (name === SESSION_CONTROL_PLAN_PROGRESS) {
    assertExactKeys(input, ['sourceFactRef', 'updates']);
    if (!Array.isArray(input.updates) || input.updates.length < 1 || input.updates.length > 12) {
      throw new SessionControlError('plan_progress_invalid', 'updates 必须包含一至十二个步骤更新。');
    }
    const seen = new Set<string>();
    const updates = input.updates.map((item): TodoProgressUpdate => {
      if (!isRecord(item)) throw new SessionControlError('plan_progress_invalid', '步骤更新必须是对象。');
      assertExactKeys(item, ['todoId', 'status']);
      const todoId = requiredIdentifier(item.todoId, 'todoId');
      if (seen.has(todoId) || !['pending', 'inProgress', 'completed'].includes(String(item.status))) {
        throw new SessionControlError('plan_progress_invalid', '步骤更新重复或状态无效。');
      }
      seen.add(todoId);
      return { todoId, status: item.status as TodoProgressUpdate['status'] };
    });
    return { kind: 'planProgress', callId: canonicalCallId, sourceFactRef: requiredIdentifier(input.sourceFactRef, 'sourceFactRef'), updates };
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

function decodePlan(value: Record<string, unknown>): PlanPublicationDraft {
  assertExactKeys(value, ['title', 'summary', 'steps', 'mutationManifest'], [], 'plan');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 12) {
    throw new SessionControlError(
      'session_control_plan_steps_invalid',
      'plan.publish steps 必须包含一至十二个步骤。',
    );
  }
  if (!Array.isArray(value.mutationManifest) || value.mutationManifest.length > 128) {
    throw new SessionControlError(
      'session_control_plan_manifest_invalid',
      'plan.publish mutationManifest 必须是最多 128 项的数组。',
    );
  }
  const stepIds = new Set<string>();
  const title = requiredDisplayText(value.title, 'title', 240);
  const summary = requiredText(value.summary, 'summary');
  const steps = value.steps.map((candidate, index) => decodePlanStep(candidate, stepIds, index));
  const mutationManifest: PlanOperation[] = [];
  const shapeErrors: string[] = [];
  for (const [index, candidate] of value.mutationManifest.entries()) {
    try { mutationManifest.push(decodePlanOperation(candidate, index)); }
    catch (error) {
      if (!(error instanceof SessionControlError) || error.code !== 'session_control_shape_invalid') throw error;
      shapeErrors.push(error.message);
    }
  }
  // Return every invalid manifest shape in the same correction result.
  // No partially decoded plan is published.
  if (shapeErrors.length) throw new SessionControlError('session_control_shape_invalid', shapeErrors.join('\n'));
  return {
    title, summary, steps, mutationManifest,
  };
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
    && (!Array.isArray(value.verification) || value.verification.length > 8)
  ) {
    throw new SessionControlError(
      'session_control_plan_verification_invalid',
      'Plan step verification 必须是最多八项的字符串数组。',
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
  if (operation === 'bash') {
    assertExactKeys(
      value,
      ['workspaceId', 'operation', 'command', 'workspaceMode', 'executionScope', 'terminal'],
      ['command', 'terminal'],
      `mutationManifest[${index}]`,
    );
    const command = value.command === undefined ? undefined : requiredText(value.command, 'command');
    if (
      command !== undefined && command.length > 16_384
      || value.workspaceMode !== 'write'
      || value.executionScope !== 'workspace' && value.executionScope !== 'host'
    ) {
      throw new SessionControlError(
        'session_control_plan_shell_invalid',
        'bash Plan operation 必须声明 workspaceMode=write 和 executionScope。',
      );
    }
    const terminal = value.terminal === undefined
      ? undefined
      : decodeTerminalInput(value.terminal);
    return {
      workspaceId,
      operation,
      ...(command === undefined ? {} : { command }),
      workspaceMode: 'write',
      executionScope: value.executionScope,
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
  assertExactKeys(value, ['workspaceId', 'operation', 'target'], [], `mutationManifest[${index}]`);
  if (!['fs.write', 'fs.edit'].includes(String(operation))) {
    throw new SessionControlError(
      'session_control_plan_operation_unknown',
      'Plan operation 不属于 v2 闭合集合。',
    );
  }
  return {
    workspaceId,
    operation: operation as Exclude<PlanOperation['operation'], 'fs.delete' | 'bash'>,
    target,
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
