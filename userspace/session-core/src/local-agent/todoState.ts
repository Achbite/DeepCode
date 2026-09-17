import type { TodoListProjection, SessionEvent } from '@deepcode/protocol';
import { LoopFailure } from './loopFailure.js';

export function advanceTodoList(
  todoList: TodoListProjection | null,
  event: SessionEvent,
): TodoListProjection | null {
  if (event.type === 'todo.seeded' || event.type === 'todo.reconciled') {
    return {
      sourcePlanId: event.payload.sourcePlanId,
      sourcePlanRevision: event.payload.sourcePlanRevision,
      items: event.payload.items.map((item) => ({ ...item })),
      sequence: event.sequence,
      updatedAt: event.occurredAt,
    };
  }
  if (event.type !== 'todo.progressed' || !todoList) return todoList;
  if (
    todoList.sourcePlanId !== event.payload.sourcePlanId
    || todoList.sourcePlanRevision !== event.payload.sourcePlanRevision
  ) throw new LoopFailure('todo_source_plan_mismatch', 'Session Todo 当前状态来源不一致。');
  const updates = new Map(event.payload.updates.map((update) => [update.todoId, update.status]));
  return {
    ...todoList,
    items: todoList.items.map((item) => ({
      ...item,
      status: updates.get(item.todoId) ?? item.status,
    })),
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}
