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
  SESSION_CONTROL_CONTEXT_FOCUS,
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_CONTROL_TODO_PROGRESS,
} from '@deepcode/protocol';

export const SESSION_CONTROL_INSTRUCTIONS = `直接输出 Markdown。一个 Provider turn 有工具或 control call 时，普通文本是过程说明；无调用且正常结束时，普通文本是最终答复。
需要用户补充或确认时调用 interaction.request。需要执行计划时调用 plan.publish，发布一份完整方案而非强制多选；mutationManifest 必须覆盖实际调用的全部 fs.* 修改，具体字段遵循工具 schema。
Plan 确认后 Session 生成 Todo；仅用 todo.progress 更新已有 todoId 的状态。一个 turn 最多调用一次 todo.progress，且不能与 interaction.request 或 plan.publish 同时调用。
当前任务需要主动丢弃无关历史并转向明确焦点时调用 context.focus；它只请求 Session 压缩此前上下文，不回答任务，也不执行工具，且必须独占当前 turn。
工具调用前仅用一句话说明。interaction.request 与 plan.publish 是阻塞 control，同一 turn 只能调用其中一个且不能并用其他工具。workspace 工具使用当前 binding 的 workspaceId 和工作区相对路径。`;

const CONTEXT_FOCUS_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['focus'],
  properties: {
    focus: { type: 'string', minLength: 1, maxLength: 16_384 },
  },
};

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
      required: ['workspaceId', 'operation', 'target'],
      properties: {
        workspaceId: { type: 'string', minLength: 1 },
        operation: {
          type: 'string',
          enum: ['fs.create', 'fs.write', 'fs.edit', 'fs.ensure_directory'],
        },
        target: { type: 'string', minLength: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['workspaceId', 'operation', 'target', 'targetKind'],
      properties: {
        workspaceId: { type: 'string', minLength: 1 },
        operation: { type: 'string', enum: ['fs.delete'] },
        target: { type: 'string', minLength: 1 },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'] },
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

const TODO_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['planId', 'revision', 'updates'],
  properties: {
    planId: { type: 'string', minLength: 1, maxLength: 128 },
    revision: { type: 'integer', minimum: 1 },
    updates: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['todoId', 'status'],
        properties: {
          todoId: { type: 'string', minLength: 1, maxLength: 128 },
          status: { type: 'string', enum: ['pending', 'inProgress', 'completed'] },
        },
      },
    },
  },
};

export type SessionControlCall =
  | {
      kind: 'interaction';
      interactionId: string;
      request: ModelInteractionRequest;
    }
  | {
      kind: 'plan';
      callId: string;
      draft: PlanPublicationDraft;
    }
  | {
      kind: 'todo';
      callId: string;
      planId: string;
      revision: number;
      updates: TodoProgressUpdate[];
    }
  | {
      kind: 'focus';
      callId: string;
      focus: string;
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
      description: '主动请求用户补充信息或作出确认，并暂停当前 run 等待回应。',
      inputSchema: structuredClone(INTERACTION_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_PLAN_PUBLISH,
      description: '发布一份已经收敛的实际执行方案。Session 分配 planId/revision；正文步骤在用户确认后原子生成 Todo。',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_TODO_PROGRESS,
      description: '仅更新当前已确认 Plan 所生成 Todo 的状态；不能重写标题、顺序或来源。',
      inputSchema: structuredClone(TODO_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_CONTEXT_FOCUS,
      description: '请求 Session 压缩此前上下文并把后续工作聚焦到给定任务；必须独占当前 Provider turn。',
      inputSchema: structuredClone(CONTEXT_FOCUS_SCHEMA) as JsonObject,
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
    && name !== SESSION_CONTROL_TODO_PROGRESS
    && name !== SESSION_CONTROL_CONTEXT_FOCUS
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
  if (name === SESSION_CONTROL_INTERACTION_REQUEST) {
    return {
      kind: 'interaction',
      interactionId: canonicalCallId,
      request: decodeInteraction(input),
    };
  }
  if (name === SESSION_CONTROL_TODO_PROGRESS) {
    const progress = decodeTodoProgress(input);
    return {
      kind: 'todo',
      callId: canonicalCallId,
      ...progress,
    };
  }
  if (name === SESSION_CONTROL_CONTEXT_FOCUS) {
    assertExactKeys(input, ['focus']);
    if (typeof input.focus !== 'string' || !input.focus.trim() || input.focus.length > 16_384) {
      throw new SessionControlError(
        'session_control_focus_invalid',
        'context.focus focus 必须是一至 16384 字符的非空文本。',
      );
    }
    return {
      kind: 'focus',
      callId: canonicalCallId,
      focus: input.focus.trim(),
    };
  }
  return {
    kind: 'plan',
    callId: canonicalCallId,
    draft: decodePlan(input),
  };
}

function decodeTodoProgress(value: Record<string, unknown>): {
  planId: string;
  revision: number;
  updates: TodoProgressUpdate[];
} {
  assertExactKeys(value, ['planId', 'revision', 'updates']);
  if (!Array.isArray(value.updates) || value.updates.length < 1 || value.updates.length > 12) {
    throw new SessionControlError(
      'session_control_todo_updates_invalid',
      'todo.progress updates 必须是一至十二项的数组。',
    );
  }
  const seen = new Set<string>();
  const updates = value.updates.map((candidate): TodoProgressUpdate => {
    if (!isRecord(candidate)) {
      throw new SessionControlError(
        'session_control_todo_item_invalid',
        'todo.progress update 必须是对象。',
      );
    }
    assertExactKeys(candidate, ['todoId', 'status']);
    const todoId = requiredIdentifier(candidate.todoId, 'todoId');
    if (seen.has(todoId)) {
      throw new SessionControlError(
        'session_control_todo_id_duplicate',
        'todo.progress todoId 不能重复。',
      );
    }
    seen.add(todoId);
    if (
      candidate.status !== 'pending'
      && candidate.status !== 'inProgress'
      && candidate.status !== 'completed'
    ) {
      throw new SessionControlError(
        'session_control_todo_status_invalid',
        'todo.progress status 必须是 pending、inProgress 或 completed。',
      );
    }
    return { todoId, status: candidate.status };
  });
  return {
    planId: requiredIdentifier(value.planId, 'planId'),
    revision: requiredPositiveInteger(value.revision, 'revision'),
    updates,
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
  const target = normalizedTarget(value.target);
  const workspaceId = requiredIdentifier(value.workspaceId, 'workspaceId');
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
  if (!['fs.create', 'fs.write', 'fs.edit', 'fs.ensure_directory'].includes(String(operation))) {
    throw new SessionControlError(
      'session_control_plan_operation_unknown',
      'Plan operation 不属于 v2 闭合集合。',
    );
  }
  return {
    workspaceId,
    operation: operation as Exclude<PlanOperation['operation'], 'fs.delete'>,
    target,
  };
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
