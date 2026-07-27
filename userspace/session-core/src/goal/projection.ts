import type {
  GoalProjectionV1,
  SessionGoalFactPayloadV1,
} from '@deepcode/protocol';
import {
  currentOrLatestGoal,
  reduceSessionGoals,
  terminalLifecycle,
} from './reducer.js';
import {
  SessionGoalError,
  type ReducedSessionGoalV1,
  type SessionGoalReadInput,
  type SessionGoalReadResult,
} from './types.js';

export function readSessionGoal(
  input: SessionGoalReadInput
): SessionGoalReadResult {
  if (input.domainState.head.eventVersion !== input.events.length) {
    throw new SessionGoalError(
      'session_goal_projection_stale',
      'Goal read events do not match the supplied canonical domain head.'
    );
  }
  if (
    input.conversationProjection.schemaVersion
      !== 'deepcode.shared-conversation-projection.v2'
    || input.conversationProjection.sessionId !== input.sessionId
    || input.conversationProjection.sourceEventVersion
      !== input.domainState.head.eventVersion
  ) {
    throw new SessionGoalError(
      'session_goal_projection_stale',
      'Goal read requires the exact Shared Conversation Projection v2 source version.'
    );
  }
  const history = reduceSessionGoals(input.sessionId, input.events);
  assertGoalSlotConsistency(input, history);
  const selected = input.goalId
    ? history.find((goal) => goal.goalId === input.goalId) ?? null
    : currentOrLatestGoal(history);
  if (input.goalId && !selected) {
    throw new SessionGoalError(
      'session_goal_not_found',
      `Goal ${input.goalId} does not exist in Session ${input.sessionId}.`
    );
  }
  const projection = selected
    ? buildGoalProjection(input, selected)
    : null;
  return {
    projection,
    current: currentOrLatestGoal(history),
    history,
  };
}

function assertGoalSlotConsistency(
  input: SessionGoalReadInput,
  history: readonly ReducedSessionGoalV1[]
): void {
  const slot = input.domainState.goalSlot;
  if (!slot || slot.capability !== 'goalSlotV1') {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      'Goal read requires canonical Goal slot v1 state.'
    );
  }
  const current = currentOrLatestGoal(history);
  if (!current) {
    if (slot.state !== 'empty' || slot.lastTerminalGoalRef) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        'Canonical Goal slot contains state without a Goal fact chain.'
      );
    }
    return;
  }
  const slotFactRef = goalSlotFactRef(current);
  if (!slotFactRef) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal ${current.goalId} has no reducer fact that can own the Goal slot.`
    );
  }
  if (!terminalLifecycle(current.lifecycle)) {
    if (
      slot.state !== 'active'
      || slot.goalId !== current.goalId
      || slot.goalRevision !== current.goalRevision
      || slot.lifecycle !== current.lifecycle
      || slot.factRef !== slotFactRef
    ) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        'Canonical Goal slot and active Goal fact chain disagree.'
      );
    }
    const latestFactIndex = input.events.findIndex(
      (event) => event.id === current.facts.at(-1)?.event.id
    );
    const orphanedTerminal = input.events
      .slice(latestFactIndex + 1)
      .find((event) => {
        if (event.kind !== 'session_run_state') return false;
        const payload = objectRecord(event.payload);
        return stringField(payload, 'runId') === current.sourceRunId
          && (
            stringField(payload, 'status') === 'failed'
            || stringField(payload, 'status') === 'cancelled'
          );
      });
    if (orphanedTerminal) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        `Goal ${current.goalId} has an unmaterialized terminal run fact ${orphanedTerminal.id}.`
      );
    }
    return;
  }
  const terminalRef = slot.state === 'empty'
    ? slot.lastTerminalGoalRef
    : undefined;
  if (
    slot.state !== 'empty'
    || terminalRef?.goalId !== current.goalId
    || terminalRef.goalRevision !== current.goalRevision
    || terminalRef.lifecycle !== current.lifecycle
    || terminalRef.factRef !== slotFactRef
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      'Canonical Goal slot and terminal Goal fact chain disagree.'
    );
  }
}

function goalSlotFactRef(goal: ReducedSessionGoalV1): string | undefined {
  let lifecycle: ReducedSessionGoalV1['lifecycle'] | undefined;
  let factRef: string | undefined;
  for (const { event, payload } of goal.facts) {
    switch (payload.factKind) {
      case 'draftCreated':
        lifecycle = 'draft';
        factRef = event.id;
        break;
      case 'planAwaitingAcceptance':
        if (lifecycle !== 'awaitingPlanAcceptance') {
          factRef = event.id;
        }
        lifecycle = 'awaitingPlanAcceptance';
        break;
      case 'activated':
      case 'suspended':
      case 'resumed':
      case 'completed':
      case 'failed':
      case 'cancelled':
        lifecycle = payload.lifecycle;
        factRef = event.id;
        break;
      case 'planRevisionRequested':
      case 'taskLedger':
      case 'activeWait':
      case 'checkpoint':
      case 'budgetUsage':
        break;
      default:
        assertNeverGoalFact(payload);
    }
  }
  return factRef;
}

function assertNeverGoalFact(value: never): never {
  throw new SessionGoalError(
    'session_goal_schema_unavailable',
    `Unsupported Goal slot fact ${(value as { factKind?: unknown }).factKind ?? '<unknown>'}.`
  );
}

export function buildGoalProjection(
  input: SessionGoalReadInput,
  goal: ReducedSessionGoalV1
): GoalProjectionV1 {
  const latest = goal.facts.at(-1);
  if (!latest) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal ${goal.goalId} has no canonical facts.`
    );
  }
  const pending = input.conversationProjection.interactionProjection?.pending;
  const pendingRunId = pending ? interactionRunId(pending) : undefined;
  const pendingInteraction = (
    !terminalLifecycle(goal.lifecycle)
    && pending
    && pendingRunId === goal.sourceRunId
  )
    ? {
        kind: pending.kind,
        interactionId: pending.interactionId,
        interactionRevision: pending.interactionRevision,
        targetId: pending.targetId,
        runId: pendingRunId,
      }
    : undefined;
  const sourceRefs = uniqueStrings(
    goal.facts.flatMap(({ payload }) => [
      ...payload.sourceRefs,
      ...lineageSourceRefs(payload),
    ])
  );
  const terminal = terminalLifecycle(goal.lifecycle)
    ? {
        status: goal.lifecycle,
        factRef: goal.terminalFactRef ?? latest.event.id,
        reason: goal.terminalReason ?? goal.lifecycle,
      } as GoalProjectionV1['terminal']
    : undefined;
  return {
    schemaVersion: 'deepcode.session.goal-projection.v1',
    sessionId: input.sessionId,
    goalId: goal.goalId,
    goalRevision: goal.goalRevision,
    lifecycle: goal.lifecycle,
    objective: goal.objective,
    predecessorGoalRef: goal.predecessorGoalRef,
    sourceDomainHead: { ...input.domainState.head },
    conversationRef: {
      revision: input.conversationProjection.revision,
      sourceEventVersion: input.conversationProjection.sourceEventVersion,
    },
    pendingInteraction,
    task: { status: 'notAvailable' },
    activeWait: { status: 'notAvailable' },
    checkpoint: { status: 'notAvailable' },
    executionBudget: { status: 'notAvailable' },
    terminal,
    factRefs: goal.facts.map(({ event }) => event.id),
    sourceRefs,
  };
}

function interactionRunId(value: unknown): string | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  const direct = record?.runId;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const owner = record?.decisionOwner;
  const ownerRecord = owner && typeof owner === 'object' && !Array.isArray(owner)
    ? owner as Record<string, unknown>
    : undefined;
  const owned = ownerRecord?.runId;
  return typeof owned === 'string' && owned.trim() ? owned.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' && field.trim()
    ? field.trim()
    : undefined;
}

function lineageSourceRefs(payload: SessionGoalFactPayloadV1): string[] {
  const lineage = payload.lineage;
  if (!lineage) return [];
  return [
    lineage.turnAuthorityRef,
    ...lineage.domainParentRefs,
    ...lineage.producer.kind === 'sessionRule'
      ? lineage.producer.sourceEventRefs
      : [lineage.producer.providerRequestId],
    ...lineage.kernelFactRefs.map((ref) => ref.kernelEventRef),
  ];
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => Boolean(value.trim())))];
}
