import type {
  ExecutionPlan, NewSessionEvent, PlanProjection, RunSettlement, SessionEvent, SessionProjection,
} from '@deepcode/protocol';
import { SESSION_CONTROL_PLAN_PROGRESS, SESSION_CONTROL_PLAN_PUBLISH } from '@deepcode/protocol';
import { canonicalJsonValue } from './providerToolCodec.js';
import { LoopFailure } from './loopFailure.js';
import type { SessionState } from './reducer.js';
import type { PlanPublicationDraft, SessionControlCall } from './sessionControls.js';

/** Plan lifecycle is derived from the Session journal, never a second loop or store. */
export function publishPlan(
  state: SessionState,
  runId: string,
  callId: string,
  providerCallId: string,
  draft: PlanPublicationDraft,
  workspaceIds: readonly string[],
  nextId: (kind: string) => string,
): NewSessionEvent {
  const latest = state.plans.findLast((plan) => plan.runId === runId);
  const previous = latest && ['confirmed', 'completed', 'revisionRequested'].includes(latest.status)
    ? latest : undefined;
  const planId = previous?.planId ?? nextId('plan');
  if (!planId || planId === callId || planId === providerCallId || callId === providerCallId) {
    throw new LoopFailure('plan_identity_invalid', 'Plan、LogicalCall 与 ProviderCall 必须具有独立身份。');
  }
  if (!previous && state.plans.some((plan) => plan.planId === planId)) {
    throw new LoopFailure('plan_id_reused', 'Session 生成的 planId 已经存在。');
  }
  const reject = (code: string, message: string): NewSessionEvent => ({
    type: 'session.control.rejected', sessionId: state.sessionId, runId, callId,
    payload: { providerCallId, toolName: SESSION_CONTROL_PLAN_PUBLISH, input: { ...draft }, error: { code, message } },
  });
  const unknownWorkspace = draft.mutationManifest.find((operation) => !workspaceIds.includes(operation.workspaceId));
  if (unknownWorkspace) return reject('plan_workspace_binding_invalid', 'Plan 包含不属于当前运行的工作区。请使用当前 Session 目录索引。');
  if (previous) {
    const definition = (plan: PlanPublicationDraft) => JSON.stringify(canonicalJsonValue({
      title: plan.title, summary: plan.summary, steps: plan.steps, mutationManifest: plan.mutationManifest,
    }));
    if (definition(previous) === definition(draft)) return reject(
      'plan_revision_unchanged',
      'The proposed Plan is unchanged. Continue within the confirmed scope, or explain the result. Publish a revision only for a material scope change.',
    );
    // An execution-time supplement is a complete revision, not a replacement task list.
    // A user-requested rewrite can remove steps; its resulting scope still needs confirmation.
    const missing = previous.steps.filter((step) => !draft.steps.some((candidate) => candidate.stepId === step.stepId));
    if (previous.status !== 'revisionRequested' && missing.length > 0) return reject(
      'plan_revision_steps_missing',
      `Publish the complete revised Plan, retaining existing steps (including completed ones) and their stepId values. Add the new steps and declare the complete effective mutationManifest; nothing is merged automatically. Missing steps: ${JSON.stringify(missing)}.`,
    );
  }
  return {
    type: 'plan.published', sessionId: state.sessionId, runId, callId,
    payload: {
      ...structuredClone(draft), planId, revision: (previous?.revision ?? 0) + 1, providerCallId,
    },
  };
}

export function todoItemsForPlan(
  plan: PlanProjection,
  previous: SessionProjection['todoList'],
  previousPlan: ExecutionPlan | undefined,
  nextId: (kind: string) => string,
): NonNullable<SessionProjection['todoList']>['items'] {
  const previousByStep = new Map(previous?.sourcePlanId === plan.planId
    ? previous.items.map((item) => [item.sourceStepId, item] as const) : []);
  return plan.steps.map((step) => {
    const existing = previousByStep.get(step.stepId);
    const priorStep = previousPlan?.steps.find((candidate) => candidate.stepId === step.stepId);
    const unchanged = priorStep && JSON.stringify(canonicalJsonValue(priorStep)) === JSON.stringify(canonicalJsonValue(step));
    return {
      todoId: existing?.todoId ?? nextId('todo'), sourceStepId: step.stepId, label: step.title,
      status: existing && unchanged ? existing.status : 'pending',
    };
  });
}

export function planProgressFact(
  snapshot: { state: SessionState; events: readonly SessionEvent[] },
  runId: string,
  turn: Extract<SessionControlCall, { kind: 'planProgress' }> & { providerCallId: string },
): NewSessionEvent {
  const { state, events } = snapshot;
  const active = state.activePlanRef;
  const todo = state.todoList;
  const plan = state.plans.find((candidate) => candidate.planId === active?.planId && candidate.revision === active.revision);
  const reject = (code: string, reason: string): NewSessionEvent => ({
    type: 'session.control.rejected', sessionId: state.sessionId, runId, callId: turn.callId,
    payload: {
      providerCallId: turn.providerCallId, toolName: SESSION_CONTROL_PLAN_PROGRESS,
      input: { sourceFactRef: turn.sourceFactRef, updates: turn.updates },
      error: { code, message: reason },
    },
  });
  if (!plan || plan.runId !== runId || plan.status !== 'confirmed' || !todo
    || todo.sourcePlanId !== plan.planId || todo.sourcePlanRevision !== plan.revision) {
    return reject('plan_progress_not_active', 'There is no confirmed active Plan in this run. Do not update previous Todo IDs. Provide a final explanation of the recorded results, or publish a Plan if new scope is required.');
  }
  const unknown = turn.updates.filter((update) => !todo.items.some((item) => item.todoId === update.todoId));
  if (unknown.length > 0) return reject(
    'plan_progress_todo_unknown',
    `Unknown Todo IDs: ${JSON.stringify(unknown.map((item) => item.todoId))}. No updates were applied. Current Plan and Todo: ${JSON.stringify(todo)}.`,
  );
  const evidence = events.find((event) => event.type === 'tool.completed' && event.runId === runId
    && event.payload.record.recordId === turn.sourceFactRef);
  if (!evidence || evidence.type !== 'tool.completed') return reject(
    'plan_progress_evidence_missing',
    `No tool result recordId ${turn.sourceFactRef} exists in this run. Use a recordId already received before this turn; earlier investigation results are valid.`,
  );
  if (turn.updates.some((update) => update.status === 'completed') && evidence.payload.record.outcome !== 'completed') return reject(
    'plan_progress_evidence_failed',
    `Tool result ${turn.sourceFactRef} has outcome ${evidence.payload.record.outcome}; it cannot support completed Todo. Preserve unfinished steps and explain the failure if execution cannot continue.`,
  );
  return {
    type: 'todo.progressed', sessionId: state.sessionId, runId, callId: turn.callId,
    payload: {
      providerCallId: turn.providerCallId, sourcePlanId: plan.planId, sourcePlanRevision: plan.revision,
      sourceFactRef: turn.sourceFactRef, updates: turn.updates,
    },
  };
}

export function completedPlanAwaitingLifecycle(state: SessionState, runId: string): { planId: string; revision: number } | null {
  const todo = state.todoList;
  if (!todo) return null;
  const plan = state.plans.find((candidate) => candidate.planId === todo.sourcePlanId && candidate.revision === todo.sourcePlanRevision);
  return plan?.runId === runId && plan.status === 'confirmed' && todo.items.length > 0
    && todo.items.every((item) => item.status === 'completed')
    ? { planId: plan.planId, revision: plan.revision } : null;
}

/** Publishing a final explanation never marks pending Todo or failed work completed. */
export function planFinalSettlement(state: SessionState, runId: string, finalMessageId: string): RunSettlement {
  const todo = state.todoList;
  const plan = todo && state.plans.find((candidate) => candidate.runId === runId
    && candidate.planId === todo.sourcePlanId && candidate.revision === todo.sourcePlanRevision);
  const unfinished = plan && todo ? todo.items.filter((item) => item.status !== 'completed') : [];
  if (unfinished.length > 0) return {
    outcome: 'failed', error: {
      code: 'plan_incomplete',
      message: `最终说明已输出；计划仍有 ${unfinished.length} 项未完成：${unfinished.map((item) => item.label).join('、')}。已执行的工具结果和任务状态保持原样。`,
    },
  };
  return { outcome: 'completed', finalMessageId };
}
