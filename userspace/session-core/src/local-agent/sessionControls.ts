import type {
  ExecutionPlanStep,
  InteractionOption,
  JsonObject,
  ModelInteractionRequest,
  PlanOperation,
  ProviderToolDefinition,
} from '@deepcode/protocol';
import {
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
} from '@deepcode/protocol';

export interface SessionControlWireNames {
  interactionRequest: string;
  planPublish: string;
}

export function confirmedPlanExecutionInstruction(names: SessionControlWireNames): string {
  return `The Plan is confirmed. Execute it now; do not ask for confirmation again. The Session tracks Todo progress from completed tool results. Use ${names.interactionRequest} only for a required user decision. Use ${names.planPublish} only when the confirmed Plan must change.`;
}

export function sessionControlInstructions(
  names: SessionControlWireNames,
  hasWorkspaceBindings = true,
): string {
  if (!hasWorkspaceBindings) {
    return `Text with calls is progress; text without calls is the final answer. ${names.interactionRequest} must be the only call in its turn. No workspace is bound to this run; do not invent a workspace handle or request workspace operations.`;
  }
  return `Text with calls is progress; text without calls is the final answer. ${names.interactionRequest} and ${names.planPublish} must be the only call in their turn. Use a logical workspace handle from the current Session binding list and workspace-relative paths; never invent or expose a workspaceId.`;
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
      required: ['workspace', 'operation', 'command', 'workspaceMode', 'executionScope'],
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

const PLAN_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'steps', 'mutationManifest'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: 240 },
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
          title: { type: 'string', minLength: 1, maxLength: 240 },
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
      description: 'Publish a complete new or revised execution plan for confirmation. mutationManifest must list every intended workspace mutation. A bash mutation must exactly include workspaceMode=write, executionScope, and terminal stdin when PTY input will be used. Confirmation creates the Todo list.',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
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
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
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
  assertExactKeys(value, ['title', 'summary', 'steps', 'mutationManifest']);
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
  return {
    title: requiredDisplayText(value.title, 'title', 240),
    summary: requiredText(value.summary, 'summary'),
    steps: value.steps.map((candidate) => decodePlanStep(candidate, stepIds)),
    mutationManifest: value.mutationManifest.map(decodePlanOperation),
  };
}

function decodePlanStep(value: unknown, seen: Set<string>): ExecutionPlanStep {
  if (!isRecord(value)) {
    throw new SessionControlError('session_control_plan_step_invalid', 'Plan step 必须是对象。');
  }
  assertExactKeys(value, ['stepId', 'title', 'details', 'verification'], ['verification']);
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

function decodePlanOperation(value: unknown): PlanOperation {
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
      ['terminal'],
    );
    const command = requiredText(value.command, 'command');
    if (
      command.length > 16_384
      || value.workspaceMode !== 'write'
      || value.executionScope !== 'workspace' && value.executionScope !== 'host'
    ) {
      throw new SessionControlError(
        'session_control_plan_shell_invalid',
        'bash Plan operation 必须声明有界 command、workspaceMode=write 和 executionScope。',
      );
    }
    const terminal = value.terminal === undefined
      ? undefined
      : decodeTerminalInput(value.terminal);
    return {
      workspaceId,
      operation,
      command,
      workspaceMode: 'write',
      executionScope: value.executionScope,
      ...(terminal ? { terminal } : {}),
    };
  }
  const target = normalizedTarget(value.target);
  if (operation === 'fs.delete') {
    assertExactKeys(value, ['workspaceId', 'operation', 'target', 'targetKind']);
    if (value.targetKind !== 'file' && value.targetKind !== 'directoryTree') {
      throw new SessionControlError(
        'session_control_plan_target_kind_invalid',
        'fs.delete 必须明确 targetKind=file 或 directoryTree。',
      );
    }
    return { workspaceId, operation, target, targetKind: value.targetKind };
  }
  assertExactKeys(value, ['workspaceId', 'operation', 'target']);
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
      `Session control 字段 ${field} 必须是最多 ${maxLength} 个可显示字符。`,
    );
  }
  return text;
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new SessionControlError(
      'session_control_integer_invalid',
      `Session control 字段 ${field} 必须是正整数。`,
    );
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed);
  const optionalSet = new Set(optional);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key))
    || allowed.some((key) => !optionalSet.has(key) && value[key] === undefined)
  ) {
    throw new SessionControlError(
      'session_control_shape_invalid',
      'Session control call 字段与当前闭合 schema 不一致。',
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
