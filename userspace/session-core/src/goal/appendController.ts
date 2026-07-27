import type {
  AgentEvent,
  SessionAppendPreconditionV1,
  SessionDomainStateSnapshotV1,
  SessionGoalEffectV1,
  SessionGoalFactPayloadV1,
} from '@deepcode/protocol';
import { stableHash } from '../cache/canonicalizer.js';
import {
  currentOrLatestGoal,
  reduceSessionGoals,
  terminalLifecycle,
} from './reducer.js';
import {
  SessionGoalError,
  type ReducedSessionGoalV1,
  type SessionGoalOperationContext,
} from './types.js';

export interface PreparedGoalAppend {
  events: AgentEvent[];
  precondition?: SessionAppendPreconditionV1;
  effect?: SessionGoalEffectV1;
}

type UnlineagedSessionGoalFactPayloadV1 =
  SessionGoalFactPayloadV1 extends infer Fact
    ? Fact extends SessionGoalFactPayloadV1
      ? Omit<Fact, 'lineage'>
      : never
    : never;

export class SessionGoalAppendController {
  private admissionHeadChecked = false;

  constructor(
    private readonly sessionId: string,
    private readonly context?: SessionGoalOperationContext
  ) {}

  prepare(
    existingEvents: readonly AgentEvent[],
    incomingEvents: readonly AgentEvent[],
    domainState: SessionDomainStateSnapshotV1
  ): PreparedGoalAppend {
    if (!this.context) return { events: [...incomingEvents] };
    const history = reduceSessionGoals(this.sessionId, existingEvents);
    const current = currentOrLatestGoal(history);
    this.assertOperationContext(current, domainState);

    const events = [...incomingEvents];
    const injected = this.goalFactForBatch(current, existingEvents, events);
    if (injected) events.push(injected);
    const effect = injected
      ? goalEffectForFact(current, injected)
      : undefined;
    const precondition = injected
      ? goalSlotPrecondition(domainState, current, effect)
      : undefined;
    return { events, precondition, effect };
  }

  private assertOperationContext(
    current: ReducedSessionGoalV1 | null,
    domainState: SessionDomainStateSnapshotV1
  ): void {
    const context = this.context!;
    if (!domainState.goalSlot) {
      throw new SessionGoalError(
        'session_goal_schema_unavailable',
        'Canonical Session domain state does not expose Goal slot v1.'
      );
    }
    if (
      !this.admissionHeadChecked
      &&
      context.expectedDomainHeadDigest
      && context.expectedDomainHeadDigest !== domainState.head.headDigest
    ) {
      throw new SessionGoalError(
        'session_goal_projection_stale',
        'Goal operation was admitted against a different canonical domain head.'
      );
    }
    this.admissionHeadChecked = true;
    if (context.operation === 'start') {
      if (current && !terminalLifecycle(current.lifecycle)) {
        const draftCommand = current.facts[0]?.payload.command;
        if (
          current.goalId === context.goalId
          && current.goalRevision === context.goalRevision
          && draftCommand?.callerRequestId === context.command.callerRequestId
          && draftCommand.requestDigest === context.command.requestDigest
          && domainState.goalSlot.state === 'active'
          && domainState.goalSlot.goalId === current.goalId
          && domainState.goalSlot.goalRevision === current.goalRevision
          && domainState.goalSlot.lifecycle === current.lifecycle
        ) {
          return;
        }
        throw new SessionGoalError(
          'session_goal_already_active',
          `Session already has active Goal ${current.goalId}.`
        );
      }
      if (domainState.goalSlot.state !== 'empty') {
        throw new SessionGoalError(
          'session_goal_recovery_required',
          'Goal reducer and durable Goal slot disagree before start.'
        );
      }
      if (current && terminalLifecycle(current.lifecycle)) {
        if (
          context.predecessorGoalRef?.goalId !== current.goalId
          || context.predecessorGoalRef.goalRevision !== current.goalRevision
          || domainState.goalSlot.lastTerminalGoalRef?.goalId !== current.goalId
          || domainState.goalSlot.lastTerminalGoalRef.goalRevision
            !== current.goalRevision
        ) {
          throw new SessionGoalError(
            'session_goal_recovery_required',
            'New Goal admission does not reference the exact prior terminal Goal.'
          );
        }
      }
      return;
    }
    if (
      current
      && terminalLifecycle(current.lifecycle)
      && context.operation === 'resolveInteraction'
      && current.facts.at(-1)?.payload.command?.callerRequestId
        === context.command.callerRequestId
      && current.facts.at(-1)?.payload.command?.requestDigest
        === context.command.requestDigest
      && domainState.goalSlot.state === 'empty'
    ) {
      return;
    }
    if (
      !current
      || terminalLifecycle(current.lifecycle)
      || current.goalId !== context.goalId
      || current.goalRevision !== context.goalRevision
    ) {
      throw new SessionGoalError(
        'session_goal_revision_conflict',
        'Goal operation no longer matches the active Goal identity and revision.'
      );
    }
    if (
      domainState.goalSlot.state !== 'active'
      || domainState.goalSlot.goalId !== current.goalId
      || domainState.goalSlot.goalRevision !== current.goalRevision
      || domainState.goalSlot.lifecycle !== current.lifecycle
    ) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        'Goal reducer and durable Goal slot disagree.'
      );
    }
  }

  private goalFactForBatch(
    current: ReducedSessionGoalV1 | null,
    existingEvents: readonly AgentEvent[],
    incomingEvents: readonly AgentEvent[]
  ): AgentEvent | undefined {
    const context = this.context!;
    if (
      context.operation === 'start'
      && (!current || terminalLifecycle(current.lifecycle))
    ) {
      const authority = lastEvent(incomingEvents, 'session_turn_authority');
      const running = lastSessionRunState(incomingEvents, 'running');
      const user = lastEvent(incomingEvents, 'user_msg');
      if (!authority || !running || !user) return undefined;
      const runId = stringField(running.payload, 'runId');
      if (!runId || !context.objective?.trim()) {
        throw new SessionGoalError(
          'session_goal_authority_required',
          'Goal draft bootstrap requires objective, user authority and exact run identity.'
        );
      }
      return goalFactEvent({
        sessionId: this.sessionId,
        ts: running.ts,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'draftCreated',
          goalId: context.goalId,
          goalRevision: context.goalRevision,
          lifecycle: 'draft',
          objective: context.objective.trim(),
          planRevision: 0,
          sourceRunId: runId,
          ...(context.predecessorGoalRef
            ? { predecessorGoalRef: context.predecessorGoalRef }
            : {}),
          sourceRefs: [user.id, authority.id, running.id],
          command: context.command,
        },
        sourceIdentity: `${context.command.callerRequestId}:${authority.id}`,
      });
    }
    if (!current) return undefined;

    const startTerminal = context.operation === 'start'
      ? [...incomingEvents].reverse().find((event) => {
          if (event.kind !== 'session_run_state') return false;
          const status = stringField(event.payload, 'status');
          return status === 'failed' || status === 'cancelled';
        })
      : undefined;
    if (
      startTerminal
      && (
        current.lifecycle === 'draft'
        || current.lifecycle === 'awaitingPlanAcceptance'
      )
    ) {
      const status = stringField(startTerminal.payload, 'status');
      const runId = stringField(startTerminal.payload, 'runId');
      if (!runId || (status !== 'failed' && status !== 'cancelled')) {
        throw new SessionGoalError(
          'session_goal_recovery_required',
          'Goal start terminal fact has no exact run identity or status.'
        );
      }
      return goalFactEvent({
        sessionId: this.sessionId,
        ts: startTerminal.ts,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: status,
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: status,
          objective: current.objective,
          sourceRunId: runId,
          terminalReason: stringField(startTerminal.payload, 'error')
            ?? stringField(startTerminal.payload, 'reason')
            ?? `goalStart${status === 'failed' ? 'Failed' : 'Cancelled'}`,
          sourceRefs: [startTerminal.id],
          command: context.command,
        },
        sourceIdentity: `${context.command.callerRequestId}:${startTerminal.id}`,
      });
    }

    const planCard = lastEvent(incomingEvents, 'plan_card');
    const waiting = lastSessionRunState(incomingEvents, 'waiting');
    if (planCard && waiting) {
      const planId = stringField(planCard.payload, 'planId');
      const runId = stringField(planCard.payload, 'runId');
      if (!planId || !runId) {
        throw new SessionGoalError(
          'session_goal_recovery_required',
          'Goal plan awaiting fact requires exact plan and run identity.'
        );
      }
      const planRevision = current.lifecycle === 'draft'
        ? 1
        : Math.max(1, current.planRevision);
      return goalFactEvent({
        sessionId: this.sessionId,
        ts: waiting.ts,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'planAwaitingAcceptance',
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: 'awaitingPlanAcceptance',
          objective: current.objective,
          planId,
          planRevision,
          sourceRunId: runId,
          sourceRefs: [planCard.id, waiting.id],
          command: context.command,
        },
        sourceIdentity: `${context.command.callerRequestId}:${planCard.id}`,
      });
    }

    const planDecision = lastEvent(incomingEvents, 'plan_review');
    const decisionStatus = stringField(planDecision?.payload, 'status');
    if (!planDecision || !decisionStatus) return undefined;
    const planId = stringField(planDecision.payload, 'planId') ?? current.planId;
    const runId = stringField(planDecision.payload, 'runId') ?? current.sourceRunId;
    if (!planId || !runId || current.lifecycle !== 'awaitingPlanAcceptance') {
      throw new SessionGoalError(
        'session_goal_lifecycle_conflict',
        'Goal Plan decision no longer matches the awaiting Plan.'
      );
    }
    const planCardSource = [...existingEvents].reverse().find((event) => {
      return event.kind === 'plan_card'
        && stringField(event.payload, 'planId') === planId;
    });
    if (!planCardSource) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        `Goal Plan ${planId} has no canonical plan_card source.`
      );
    }
    if (decisionStatus === 'needsRevision') {
      return goalFactEvent({
        sessionId: this.sessionId,
        ts: planDecision.ts,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'planRevisionRequested',
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: 'awaitingPlanAcceptance',
          objective: current.objective,
          planId,
          planRevision: current.planRevision + 1,
          sourceRunId: runId,
          sourceRefs: [planCardSource.id, planDecision.id],
          command: context.command,
        },
        sourceIdentity: `${context.command.callerRequestId}:${planDecision.id}`,
      });
    }
    if (decisionStatus === 'accepted') {
      const authorization = latestPlanAuthorizationDecision(
        existingEvents,
        planCardSource,
        'accept'
      );
      if (!authorization) {
        throw new SessionGoalError(
          'session_goal_authorization_required',
          'Goal activation requires an earlier exact Kernel PlanAuthorization accept fact.'
        );
      }
      return goalFactEvent({
        sessionId: this.sessionId,
        ts: planDecision.ts,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'activated',
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: 'running',
          objective: current.objective,
          planId,
          planRevision: current.planRevision,
          confirmedPlanRef: planCardSource.id,
          authorizationFactRef: authorization.id,
          sourceRunId: runId,
          taskSnapshot: taskSnapshot(planCardSource),
          sourceRefs: [planCardSource.id, authorization.id, planDecision.id],
          command: context.command,
        },
        sourceIdentity: `${context.command.callerRequestId}:${planDecision.id}`,
      });
    }
    if (decisionStatus === 'rejected') {
      return goalFactEvent({
        sessionId: this.sessionId,
        ts: planDecision.ts,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'cancelled',
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: 'cancelled',
          objective: current.objective,
          sourceRunId: runId,
          terminalReason: 'planRejected',
          sourceRefs: [planCardSource.id, planDecision.id],
          command: context.command,
        },
        sourceIdentity: `${context.command.callerRequestId}:${planDecision.id}`,
      });
    }
    return undefined;
  }
}

function goalEffectForFact(
  current: ReducedSessionGoalV1 | null,
  event: AgentEvent
): SessionGoalEffectV1 | undefined {
  const payload = event.payload as UnlineagedSessionGoalFactPayloadV1;
  if (payload.factKind === 'draftCreated') {
    return {
      kind: 'open',
      goalId: payload.goalId,
      goalRevision: payload.goalRevision,
      lifecycle: 'draft',
      factRef: event.id,
    };
  }
  if (payload.factKind === 'planAwaitingAcceptance') {
    if (current?.lifecycle === 'awaitingPlanAcceptance') return undefined;
    return {
      kind: 'transition',
      goalId: payload.goalId,
      goalRevision: payload.goalRevision,
      fromLifecycle: 'draft',
      toLifecycle: 'awaitingPlanAcceptance',
      factRef: event.id,
    };
  }
  if (payload.factKind === 'activated') {
    return {
      kind: 'transition',
      goalId: payload.goalId,
      goalRevision: payload.goalRevision,
      fromLifecycle: 'awaitingPlanAcceptance',
      toLifecycle: 'running',
      factRef: event.id,
    };
  }
  if (
    payload.factKind === 'completed'
    || payload.factKind === 'failed'
    || payload.factKind === 'cancelled'
  ) {
    return {
      kind: 'release',
      goalId: payload.goalId,
      goalRevision: payload.goalRevision,
      lifecycle: payload.factKind,
      factRef: event.id,
    };
  }
  return undefined;
}

function goalSlotPrecondition(
  state: SessionDomainStateSnapshotV1,
  current: ReducedSessionGoalV1 | null,
  effect: SessionGoalEffectV1 | undefined
): SessionAppendPreconditionV1 {
  if (effect?.kind === 'open') {
    return { kind: 'goalSlot', expected: { state: 'empty' } };
  }
  if (
    !current
    || current.lifecycle === 'completed'
    || current.lifecycle === 'failed'
    || current.lifecycle === 'cancelled'
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      'Goal transition has no active reducer state.'
    );
  }
  if (!state.goalSlot || state.goalSlot.state !== 'active') {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      'Goal transition has no active durable slot.'
    );
  }
  return {
    kind: 'goalSlot',
    expected: {
      state: 'active',
      goalId: current.goalId,
      goalRevision: current.goalRevision,
      lifecycle: current.lifecycle,
    },
  };
}

function goalFactEvent(input: {
  sessionId: string;
  ts: string;
  payload: UnlineagedSessionGoalFactPayloadV1;
  sourceIdentity: string;
}): AgentEvent {
  const suffix = stableHash(input.sourceIdentity).replace(/^sha256:/, '').slice(0, 24);
  return {
    id: `session-goal-fact-${input.payload.factKind}-${suffix}`,
    sessionId: input.sessionId,
    ts: input.ts,
    kind: 'session_goal_fact',
    payload: {
      ...input.payload,
      channel: 'task',
      visibility: 'hidden',
      presentation: 'traceOnly',
    },
  };
}

function latestPlanAuthorizationDecision(
  events: readonly AgentEvent[],
  planCard: AgentEvent,
  decision: 'accept' | 'reject'
): AgentEvent | undefined {
  const contractId = stringField(planCard.payload, 'authorizationContractId')
    ?? stringField(
      objectField(planCard.payload, 'authorizationContract'),
      'id'
    );
  return [...events].reverse().find((event) => {
    const payload = objectRecord(event.payload);
    const kernel = objectRecord(payload?.kernelEvent);
    return stringField(payload, 'stage') === 'plan_authorization.decision_recorded'
      && stringField(kernel, 'decision') === decision
      && (
        !contractId
        || stringField(kernel, 'authorizationContractId') === contractId
      )
      && stringField(kernel, 'kind') === 'plan_authorization.decision_recorded';
  });
}

function taskSnapshot(planCard: AgentEvent): unknown[] {
  const payload = objectRecord(planCard.payload);
  const taskPlan = objectRecord(payload?.taskPlan);
  return Array.isArray(taskPlan?.tasks)
    ? structuredClone(taskPlan.tasks)
    : [];
}

function lastEvent(
  events: readonly AgentEvent[],
  kind: AgentEvent['kind']
): AgentEvent | undefined {
  return [...events].reverse().find((event) => event.kind === kind);
}

function lastSessionRunState(
  events: readonly AgentEvent[],
  status: string
): AgentEvent | undefined {
  return [...events].reverse().find((event) => {
    return event.kind === 'session_run_state'
      && stringField(event.payload, 'status') === status;
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function objectField(
  value: unknown,
  key: string
): Record<string, unknown> | undefined {
  return objectRecord(objectRecord(value)?.[key]);
}

function stringField(value: unknown, key: string): string | undefined {
  const field = objectRecord(value)?.[key];
  return typeof field === 'string' && field.trim()
    ? field.trim()
    : undefined;
}
