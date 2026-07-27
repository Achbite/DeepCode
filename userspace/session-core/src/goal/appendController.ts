import type {
  AgentEvent,
  ExecutionBudgetCoreV1,
  GoalStepOutcomeV1,
  SessionAppendPreconditionV1,
  SessionDomainStateSnapshotV1,
  SessionGoalActiveWaitKindV1,
  SessionGoalActiveWaitV1,
  SessionGoalEffectV1,
  SessionGoalFactPayloadV1,
  SessionTaskDefinitionV1,
  TaskLedgerSnapshotV2,
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
import {
  parseTaskLedgerV2,
  taskLedgerAllSettled,
} from '../run-state/taskLedger.js';

export interface PreparedGoalAppend {
  events: AgentEvent[];
  precondition?: SessionAppendPreconditionV1;
  effect?: SessionGoalEffectV1;
}

export interface SessionGoalAppendRuntime {
  stepStartedAt: string;
  providerCallCount: number;
}

export type UnlineagedSessionGoalFactPayloadV1 =
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
    domainState: SessionDomainStateSnapshotV1,
    runtime?: SessionGoalAppendRuntime
  ): PreparedGoalAppend {
    if (!this.context) return { events: [...incomingEvents] };
    const history = reduceSessionGoals(this.sessionId, existingEvents);
    const current = currentOrLatestGoal(history);
    this.assertOperationContext(current, domainState);

    const events = [...incomingEvents];
    if (!events.some((event) => event.kind === 'session_goal_fact')) {
      events.push(...this.goalStepFacts(current, events, runtime));
    }
    const injected = this.goalFactForBatch(current, existingEvents, events);
    if (injected) events.push(injected);
    const suppliedGoalFacts = events.filter(
      (event) => event.kind === 'session_goal_fact'
    );
    if (suppliedGoalFacts.length > 0) {
      this.assertGoalFactsForOperation(current, suppliedGoalFacts);
    }
    const effects = suppliedGoalFacts.flatMap((event) => {
      const effect = goalEffectForFact(current, event);
      return effect ? [effect] : [];
    });
    if (effects.length > 1) {
      throw new SessionGoalError(
        'session_goal_lifecycle_conflict',
        'One canonical Goal batch cannot carry more than one lifecycle slot effect.'
      );
    }
    const effect = effects[0];
    const precondition = suppliedGoalFacts.length > 0
      ? goalSlotPrecondition(domainState, current, effect)
      : undefined;
    return { events, precondition, effect };
  }

  private goalStepFacts(
    current: ReducedSessionGoalV1 | null,
    events: readonly AgentEvent[],
    runtime: SessionGoalAppendRuntime | undefined
  ): AgentEvent[] {
    const context = this.context;
    if (
      !context
      || context.operation !== 'advance'
      || !current
      || current.lifecycle !== 'running'
      || !runtime
    ) {
      return [];
    }
    const terminal = [...events].reverse().find((event) => {
      if (event.kind !== 'session_run_state') return false;
      const status = stringField(event.payload, 'status');
      return status === 'waiting'
        || status === 'completed'
        || status === 'failed'
        || status === 'cancelled';
    });
    if (!terminal) return [];

    const nextLedger = latestTaskLedger(events) ?? current.taskLedger;
    if (!nextLedger) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        `Goal ${current.goalId} cannot settle a foreground step without TaskLedgerV2.`
      );
    }
    const status = stringField(terminal.payload, 'status')!;
    const sourceRunId = stringField(terminal.payload, 'runId');
    if (!sourceRunId) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        `Goal ${current.goalId} step terminal ${terminal.id} has no source run identity.`
      );
    }
    const reason = stringField(terminal.payload, 'goalStepReason')
      ?? stringField(terminal.payload, 'reason')
      ?? stringField(terminal.payload, 'terminalReason')
      ?? `goalStep${status}`;
    const outcome: GoalStepOutcomeV1 = status === 'waiting'
      ? 'suspend'
      : status === 'failed' || status === 'cancelled'
        ? 'fail'
        : taskLedgerAllSettled(nextLedger)
          ? 'complete'
          : 'continue';
    const completedAt = terminal.ts;
    const priorBudget = current.executionBudget;
    const sourceRefs = uniqueStrings([
      terminal.id,
      ...(current.executionBudgetFactRef
        ? [current.executionBudgetFactRef]
        : []),
    ]);
    const budget: ExecutionBudgetCoreV1 = {
      schemaVersion: 'deepcode.session.execution-budget-core.v1',
      steps: (priorBudget?.steps ?? 0) + 1,
      providerCalls:
        (priorBudget?.providerCalls ?? 0) + runtime.providerCallCount,
      activeTimeMs:
        (priorBudget?.activeTimeMs ?? 0)
        + elapsedMilliseconds(runtime.stepStartedAt, completedAt),
      consecutiveRetryCount: retryCountForOutcome(
        priorBudget,
        outcome,
        reason
      ),
      lastStep: {
        callerRequestId: context.command.callerRequestId,
        outcome,
        reason,
        startedAt: runtime.stepStartedAt,
        completedAt,
      },
      sourceRefs,
    };
    const facts: AgentEvent[] = [];
    if (
      current.taskLedger
      && nextLedger.revision !== current.taskLedger.revision
    ) {
      facts.push(createSessionGoalFactEvent({
        sessionId: this.sessionId,
        ts: completedAt,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'taskLedger',
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: 'running',
          objective: current.objective,
          taskLedger: nextLedger,
          sourceRefs: uniqueStrings([
            terminal.id,
            ...(current.taskLedgerFactRef
              ? [current.taskLedgerFactRef]
              : []),
          ]),
          command: context.command,
        },
        sourceIdentity:
          `${context.command.callerRequestId}:taskLedger:${terminal.id}`,
      }));
    }
    const budgetFact = createSessionGoalFactEvent({
      sessionId: this.sessionId,
      ts: completedAt,
      payload: {
        schemaVersion: 'deepcode.session.goal-fact.v1',
        factKind: 'budgetUsage',
        goalId: current.goalId,
        goalRevision: current.goalRevision,
        lifecycle: 'running',
        objective: current.objective,
        executionBudget: budget,
        sourceRefs,
        command: context.command,
      },
      sourceIdentity:
        `${context.command.callerRequestId}:budgetUsage:${terminal.id}`,
    });
    facts.push(budgetFact);

    if (outcome === 'suspend') {
      const waitKind = activeWaitKindForReason(reason);
      const waitRef =
        `goal-wait-${stableHash(`${context.command.callerRequestId}:${terminal.id}`)
          .replace(/^sha256:/, '')
          .slice(0, 24)}`;
      const suspendedFact = createSessionGoalFactEvent({
        sessionId: this.sessionId,
        ts: completedAt,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind: 'suspended',
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: 'suspended',
          objective: current.objective,
          waitRef,
          sourceRunId,
          sourceRefs: [terminal.id, budgetFact.id],
          command: context.command,
        },
        sourceIdentity:
          `${context.command.callerRequestId}:suspended:${terminal.id}`,
      });
      const activeWait: SessionGoalActiveWaitV1 = {
        schemaVersion: 'deepcode.session.active-wait.v1',
        waitId: waitRef,
        kind: waitKind,
        source: kernelWaitKind(waitKind) ? 'kernel' : 'session',
        reason,
        resumable: waitKind === 'budget' || waitKind === 'checkpointRequired',
        createdAt: completedAt,
        sourceRefs: [terminal.id, suspendedFact.id],
      };
      facts.push(
        suspendedFact,
        createSessionGoalFactEvent({
          sessionId: this.sessionId,
          ts: completedAt,
          payload: {
            schemaVersion: 'deepcode.session.goal-fact.v1',
            factKind: 'activeWait',
            goalId: current.goalId,
            goalRevision: current.goalRevision,
            lifecycle: 'suspended',
            objective: current.objective,
            activeWait,
            sourceRefs: [suspendedFact.id, terminal.id],
            command: context.command,
          },
          sourceIdentity:
            `${context.command.callerRequestId}:activeWait:${terminal.id}`,
        })
      );
    } else if (outcome === 'complete' || outcome === 'fail') {
      const factKind = outcome === 'complete' ? 'completed' : 'failed';
      facts.push(createSessionGoalFactEvent({
        sessionId: this.sessionId,
        ts: completedAt,
        payload: {
          schemaVersion: 'deepcode.session.goal-fact.v1',
          factKind,
          goalId: current.goalId,
          goalRevision: current.goalRevision,
          lifecycle: factKind,
          objective: current.objective,
          sourceRunId,
          terminalReason: reason,
          sourceRefs: [terminal.id, budgetFact.id],
          command: context.command,
        },
        sourceIdentity:
          `${context.command.callerRequestId}:${factKind}:${terminal.id}`,
      }));
    }
    return facts;
  }

  private assertGoalFactsForOperation(
    current: ReducedSessionGoalV1 | null,
    events: readonly AgentEvent[]
  ): void {
    const context = this.context!;
    if (!current) {
      if (
        context.operation === 'start'
        && events.length === 1
        && objectRecord(events[0]?.payload)?.factKind === 'draftCreated'
      ) {
        return;
      }
      throw new SessionGoalError(
        'session_goal_recovery_required',
        'Goal facts cannot be appended without an existing Goal chain.'
      );
    }
    for (const event of events) {
      const payload = objectRecord(event.payload);
      const command = objectRecord(payload?.command);
      if (
        payload?.schemaVersion !== 'deepcode.session.goal-fact.v1'
        || stringField(payload, 'goalId') !== current.goalId
        || payload.goalRevision !== current.goalRevision
        || stringField(payload, 'objective') !== current.objective
        || stringField(command, 'callerRequestId')
          !== context.command.callerRequestId
        || stringField(command, 'requestDigest')
          !== context.command.requestDigest
        || stringField(command, 'hostRunId') !== context.command.hostRunId
      ) {
        throw new SessionGoalError(
          'session_goal_request_conflict',
          `Goal fact ${event.id} does not match its admitted Goal command.`
        );
      }
      const factKind = stringField(payload, 'factKind');
      const allowed = context.operation === 'advance'
        ? (
            factKind === 'taskLedger'
            || factKind === 'budgetUsage'
            || factKind === 'suspended'
            || factKind === 'activeWait'
            || factKind === 'completed'
            || factKind === 'failed'
          )
        : context.operation === 'resume'
          ? factKind === 'resumed'
          : context.operation === 'cancel'
            ? factKind === 'cancelled'
            : context.operation === 'resolveInteraction'
              ? (
                  factKind === 'activated'
                  || factKind === 'cancelled'
                  || factKind === 'planRevisionRequested'
                )
              : context.operation === 'start'
                ? (
                    factKind === 'draftCreated'
                    || factKind === 'planAwaitingAcceptance'
                    || factKind === 'failed'
                    || factKind === 'cancelled'
                  )
                : false;
      if (!allowed) {
        throw new SessionGoalError(
          'session_goal_lifecycle_conflict',
          `Goal operation ${context.operation} cannot append ${factKind ?? '<unknown>'}.`
        );
      }
    }
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
  return createSessionGoalFactEvent(input);
}

export function createSessionGoalFactEvent(input: {
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

function taskSnapshot(planCard: AgentEvent): SessionTaskDefinitionV1[] {
  const payload = objectRecord(planCard.payload);
  const taskPlan = objectRecord(payload?.taskPlan);
  const tasks = Array.isArray(taskPlan?.tasks) ? taskPlan.tasks : [];
  const snapshot = tasks.flatMap((value, index): SessionTaskDefinitionV1[] => {
    const task = objectRecord(value);
    const taskId = stringField(task, 'taskId')
      ?? stringField(task, 'id')
      ?? `task-${index + 1}`;
    if (!task) return [];
    return [{
      taskId,
      title: stringField(task, 'title'),
      targets: uniqueStrings([
        ...stringArray(task.target),
        ...stringArray(task.targets),
      ]),
      toolId: stringField(task, 'toolId'),
      dependencies: uniqueStrings(stringArray(task.dependencies)),
      acceptanceCriteria: uniqueStrings(stringArray(task.acceptanceCriteria)),
      failureCriteria: uniqueStrings(stringArray(task.failureCriteria)),
      required: true,
    }];
  });
  if (!snapshot.length || snapshot.length !== tasks.length) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal Plan ${planCard.id} has no closed task snapshot.`
    );
  }
  return snapshot;
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

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (
      typeof item === 'string' && item.trim() ? [item.trim()] : []
    ));
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function latestTaskLedger(
  events: readonly AgentEvent[]
): TaskLedgerSnapshotV2 | undefined {
  for (const event of [...events].reverse()) {
    const payload = objectRecord(event.payload);
    const candidate = payload?.taskLedger;
    if (!candidate) continue;
    try {
      return parseTaskLedgerV2(candidate);
    } catch (error) {
      throw new SessionGoalError(
        'session_task_ledger_transition_invalid',
        `Goal step event ${event.id} carries an invalid TaskLedgerV2: ${errorMessage(error)}`
      );
    }
  }
  return undefined;
}

function elapsedMilliseconds(startedAt: string, completedAt: string): number {
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (
    !Number.isFinite(started)
    || !Number.isFinite(completed)
    || completed < started
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      'Goal step timestamps cannot produce a monotonic active-time measurement.'
    );
  }
  return completed - started;
}

function retryCountForOutcome(
  _previous: ExecutionBudgetCoreV1 | undefined,
  outcome: GoalStepOutcomeV1,
  reason: string
): number {
  return outcome === 'suspend' && reason === 'retryGuardExhausted'
    ? 3
    : 0;
}

function activeWaitKindForReason(
  reason: string
): SessionGoalActiveWaitKindV1 {
  switch (reason) {
    case 'requirement':
      return 'requirement';
    case 'plan_review':
      return 'plan';
    case 'review':
      return 'review';
    case 'permission':
      return 'permission';
    case 'checkpointRequired':
    case 'accepted_plan_execution':
      return 'checkpointRequired';
    case 'scopeChange':
      return 'scopeChange';
    case 'replan':
      return 'replan';
    case 'retryGuardExhausted':
      return 'budget';
    case 'work_unit_failed':
    case 'kernelIndeterminate':
      return 'indeterminate';
    case 'kernelCleanup':
      return 'cleanup';
    case 'provider_failure':
    case 'driver_failure':
      return 'persistence';
    case 'userAcceptance':
      return 'userAcceptance';
    default:
      return 'userDecision';
  }
}

function kernelWaitKind(kind: SessionGoalActiveWaitKindV1): boolean {
  return kind === 'permission'
    || kind === 'cleanup'
    || kind === 'indeterminate';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
