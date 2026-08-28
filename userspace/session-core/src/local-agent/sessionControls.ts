import type {
  InteractionOption,
  JsonObject,
  ModelInteractionRequest,
  PlanIntent,
  PlanOperation,
  PlanOption,
  ProviderToolDefinition,
  TodoItem,
} from '@deepcode/protocol';
import {
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_INTENT,
  SESSION_CONTROL_TODO_UPDATE,
} from '@deepcode/protocol';

export const SESSION_CONTROL_INSTRUCTIONS = `普通叙述和最终答复直接输出 Markdown 正文，不要把正文包装为 JSON、JSONL 或代码围栏。
Session 会依据当前 Provider turn 的 typed 生命周期解释普通文本：同一 turn 包含工具或 Session control call 时，普通文本是 narrative；没有调用而正常结束时，普通文本是 answer。
需要用户补充信息或确认时，调用 interaction.request；不要只在普通正文末尾向用户提问。需要 workspace mutation 时，先调用 plan.intent，等待用户选择或调整后再调用 mutation 工具。Plan 最多三个选项，每项列出闭合 operation 和精确的 workspace-relative normalized target；只有 fs.delete 必须且可以提供 targetKind。planId 由 tool callId 产生，不要在 plan.intent input 中另传 planId。
复杂任务（包含多个依赖步骤、多个工具阶段或需要先调查再实施）必须调用 todo.update 建立并持续更新待办；简单的一步回答不需要 Todo。Todo 只表达你明确给出的当前 run 待办，不得从工具状态自动推断；最多十二项，每项保持稳定 todoId，并明确 pending、inProgress 或 completed。一个 turn 最多调用一次 todo.update；它可以与 Kernel 工具同 turn 出现，但不能与 interaction.request 或 plan.intent 同 turn 出现。
调用任何工具或 Session control call 前，先用一段简短普通文本说明正在做什么。interaction.request 与 plan.intent 是阻塞 control，同一 turn 只能出现其中一个且不能同时调用其他工具或 todo.update。所有 workspace 工具 input 必须使用当前 Session binding 中的 workspaceId，不能使用绝对路径。`;

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
  required: ['prompt', 'options'],
  properties: {
    prompt: { type: 'string', minLength: 1 },
    options: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['optionId', 'label', 'operations'],
        properties: {
          optionId: { type: 'string', minLength: 1 },
          label: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          operations: {
            type: 'array',
            minItems: 1,
            items: PLAN_OPERATION_SCHEMA,
          },
        },
      },
    },
  },
};

const TODO_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  required: ['items'],
  properties: {
    items: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['todoId', 'label', 'status'],
        properties: {
          todoId: { type: 'string', minLength: 1, maxLength: 128 },
          label: { type: 'string', minLength: 1, maxLength: 240 },
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
      intent: PlanIntent;
    }
  | {
      kind: 'todo';
      callId: string;
      items: TodoItem[];
    };

export function sessionControlToolDefinitions(): readonly ProviderToolDefinition[] {
  return [
    {
      name: SESSION_CONTROL_INTERACTION_REQUEST,
      description: '主动请求用户补充信息或作出确认，并暂停当前 run 等待回应。',
      inputSchema: structuredClone(INTERACTION_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_PLAN_INTENT,
      description: '提出一个 workspace mutation Plan；input 只包含 prompt/options，planId 来自本次 tool callId。非删除 operation 不得发送 targetKind。',
      inputSchema: structuredClone(PLAN_SCHEMA) as JsonObject,
    },
    {
      name: SESSION_CONTROL_TODO_UPDATE,
      description: '发布当前 run 的结构化待办列表；它是 Session 投影元数据，不是工具执行状态。',
      inputSchema: structuredClone(TODO_SCHEMA) as JsonObject,
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
    && name !== SESSION_CONTROL_PLAN_INTENT
    && name !== SESSION_CONTROL_TODO_UPDATE
  ) return null;
  const canonicalCallId = requiredIdentifier(callId, 'callId');
  if (name === SESSION_CONTROL_INTERACTION_REQUEST) {
    return {
      kind: 'interaction',
      interactionId: canonicalCallId,
      request: decodeInteraction(input),
    };
  }
  if (name === SESSION_CONTROL_TODO_UPDATE) {
    return {
      kind: 'todo',
      callId: canonicalCallId,
      items: decodeTodoItems(input),
    };
  }
  return {
    kind: 'plan',
    intent: decodePlan(canonicalCallId, input),
  };
}

function decodeTodoItems(value: Record<string, unknown>): TodoItem[] {
  assertExactKeys(value, ['items']);
  if (!Array.isArray(value.items) || value.items.length > 12) {
    throw new SessionControlError(
      'session_control_todo_items_invalid',
      'todo.update items 必须是最多十二项的数组。',
    );
  }
  const seen = new Set<string>();
  return value.items.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new SessionControlError(
        'session_control_todo_item_invalid',
        'todo.update item 必须是对象。',
      );
    }
    assertExactKeys(candidate, ['todoId', 'label', 'status']);
    const todoId = requiredIdentifier(candidate.todoId, 'todoId');
    if (seen.has(todoId)) {
      throw new SessionControlError(
        'session_control_todo_id_duplicate',
        'todo.update todoId 不能重复。',
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
        'todo.update status 必须是 pending、inProgress 或 completed。',
      );
    }
    const label = requiredText(candidate.label, 'label');
    if (
      label.trim() !== label
      || [...label].length > 240
      || [...label].some((character) => /[\u0000-\u001f\u007f]/u.test(character))
    ) {
      throw new SessionControlError(
        'session_control_todo_label_invalid',
        'todo.update label 必须是最多 240 个可显示字符。',
      );
    }
    return { todoId, label, status: candidate.status };
  });
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

function decodePlan(planId: string, value: Record<string, unknown>): PlanIntent {
  assertExactKeys(value, ['prompt', 'options']);
  if (!Array.isArray(value.options) || value.options.length < 1 || value.options.length > 3) {
    throw new SessionControlError(
      'session_control_plan_options_invalid',
      'plan.intent options 必须包含一至三个选项。',
    );
  }
  const optionIds = new Set<string>();
  return {
    planId,
    prompt: requiredText(value.prompt, 'prompt'),
    options: value.options.map((candidate) => decodePlanOption(candidate, optionIds)),
  };
}

function decodePlanOption(value: unknown, seen: Set<string>): PlanOption {
  if (!isRecord(value)) {
    throw new SessionControlError('session_control_plan_option_invalid', 'Plan option 必须是对象。');
  }
  assertExactKeys(value, ['optionId', 'label', 'description', 'operations'], ['description']);
  const optionId = requiredIdentifier(value.optionId, 'optionId');
  if (seen.has(optionId)) {
    throw new SessionControlError(
      'session_control_plan_option_duplicate',
      'Plan optionId 不能重复。',
    );
  }
  seen.add(optionId);
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    throw new SessionControlError(
      'session_control_plan_operations_invalid',
      '每个 Plan option 必须包含至少一个闭合 operation。',
    );
  }
  return {
    optionId,
    label: requiredText(value.label, 'label'),
    ...(value.description === undefined
      ? {}
      : { description: requiredText(value.description, 'description') }),
    operations: value.operations.map(decodePlanOperation),
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
