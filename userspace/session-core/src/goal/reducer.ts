import type {
  AgentEvent,
  ExecutionBudgetCoreV1,
  SessionGoalActiveWaitV1,
  SessionGoalFactPayloadV1,
  SessionGoalLifecycleV1,
} from '@deepcode/protocol';
import {
  SessionGoalError,
  type ReducedSessionGoalV1,
} from './types.js';
import {
  createTaskLedgerV2,
  parseTaskLedgerV2,
  taskLedgerAllSettled,
} from '../run-state/taskLedger.js';

const GOAL_FACT_SCHEMA = 'deepcode.session.goal-fact.v1';

export function reduceSessionGoals(
  sessionId: string,
  events: readonly AgentEvent[]
): ReducedSessionGoalV1[] {
  const goals: ReducedSessionGoalV1[] = [];
  let current: ReducedSessionGoalV1 | undefined;

  for (const event of events) {
    if (event.kind !== 'session_goal_fact') continue;
    if (event.sessionId !== sessionId) {
      throw new SessionGoalError(
        'session_goal_schema_unavailable',
        `Goal fact ${event.id} belongs to a different Session.`
      );
    }
    const payload = parseGoalFact(event);
    if (payload.factKind === 'draftCreated') {
      if (current && !terminalLifecycle(current.lifecycle)) {
        throw new SessionGoalError(
          'session_goal_recovery_required',
          `Goal ${payload.goalId} cannot open while ${current.goalId} is ${current.lifecycle}.`
        );
      }
      const predecessor = current
        ? {
            goalId: current.goalId,
            goalRevision: current.goalRevision,
          }
        : undefined;
      if (
        predecessor
        && (
          payload.predecessorGoalRef?.goalId !== predecessor.goalId
          || payload.predecessorGoalRef.goalRevision !== predecessor.goalRevision
        )
      ) {
        throw new SessionGoalError(
          'session_goal_recovery_required',
          `Goal ${payload.goalId} does not reference the exact prior terminal Goal.`
        );
      }
      if (!predecessor && payload.predecessorGoalRef) {
        throw new SessionGoalError(
          'session_goal_recovery_required',
          `First Goal ${payload.goalId} carries an unavailable predecessor.`
        );
      }
      current = {
        sessionId,
        goalId: payload.goalId,
        goalRevision: payload.goalRevision,
        lifecycle: 'draft',
        objective: payload.objective,
        predecessorGoalRef: payload.predecessorGoalRef,
        planRevision: 0,
        sourceRunId: payload.sourceRunId,
        facts: [{ event, payload }],
      };
      goals.push(current);
      continue;
    }

    if (!current || terminalLifecycle(current.lifecycle)) {
      throw new SessionGoalError(
        'session_goal_recovery_required',
        `Goal fact ${event.id} has no active draft chain.`
      );
    }
    assertSameGoal(current, payload, event.id);
    assertStableObjective(current, payload, event.id);

    switch (payload.factKind) {
      case 'planAwaitingAcceptance': {
        if (
          current.lifecycle !== 'draft'
          && current.lifecycle !== 'awaitingPlanAcceptance'
        ) {
          invalidTransition(current, event, payload.lifecycle);
        }
        if (
          payload.planRevision < 1
          || payload.planRevision < current.planRevision
          || payload.planRevision > current.planRevision + 1
        ) {
          throw new SessionGoalError(
            'session_goal_recovery_required',
            `Goal ${current.goalId} has a non-contiguous plan revision at ${event.id}.`
          );
        }
        current.lifecycle = 'awaitingPlanAcceptance';
        current.planId = payload.planId;
        current.planRevision = payload.planRevision;
        current.sourceRunId = payload.sourceRunId;
        break;
      }
      case 'planRevisionRequested': {
        if (current.lifecycle !== 'awaitingPlanAcceptance') {
          invalidTransition(current, event, payload.lifecycle);
        }
        if (
          payload.planId !== current.planId
          || payload.planRevision !== current.planRevision + 1
        ) {
          throw new SessionGoalError(
            'session_goal_recovery_required',
            `Goal ${current.goalId} plan revision request at ${event.id} is not contiguous.`
          );
        }
        current.planRevision = payload.planRevision;
        current.sourceRunId = payload.sourceRunId;
        break;
      }
      case 'activated': {
        if (
          current.lifecycle !== 'awaitingPlanAcceptance'
          || payload.planId !== current.planId
          || payload.planRevision !== current.planRevision
        ) {
          invalidTransition(current, event, payload.lifecycle);
        }
        current.lifecycle = 'running';
        current.confirmedPlanRef = payload.confirmedPlanRef;
        current.authorizationFactRef = payload.authorizationFactRef;
        current.sourceRunId = payload.sourceRunId;
        current.taskLedger = createGoalTaskLedger(current, payload, event.id);
        current.taskLedgerFactRef = event.id;
        break;
      }
      case 'suspended': {
        if (current.lifecycle !== 'running') {
          invalidTransition(current, event, payload.lifecycle);
        }
        current.lifecycle = 'suspended';
        current.sourceRunId = payload.sourceRunId;
        current.waitRef = payload.waitRef;
        break;
      }
      case 'resumed': {
        if (
          current.lifecycle !== 'suspended'
          || !current.activeWait
          || payload.checkpointRef !== current.activeWait.waitId
        ) {
          invalidTransition(current, event, payload.lifecycle);
        }
        current.lifecycle = 'running';
        current.sourceRunId = payload.sourceRunId;
        current.waitRef = undefined;
        current.activeWait = undefined;
        current.activeWaitFactRef = undefined;
        break;
      }
      case 'completed':
      case 'failed':
      case 'cancelled': {
        const expectedLifecycle = payload.factKind;
        if (
          current.lifecycle !== 'running'
          && current.lifecycle !== 'suspended'
          && !(
            (payload.factKind === 'failed' || payload.factKind === 'cancelled')
            && (
              current.lifecycle === 'draft'
              || current.lifecycle === 'awaitingPlanAcceptance'
            )
          )
        ) {
          invalidTransition(current, event, expectedLifecycle);
        }
        if (payload.lifecycle !== expectedLifecycle) {
          invalidTransition(current, event, payload.lifecycle);
        }
        if (
          payload.factKind === 'completed'
          && (
            !current.taskLedger
            || !taskLedgerAllSettled(current.taskLedger)
            || current.activeWait
          )
        ) {
          throw new SessionGoalError(
            'session_goal_recovery_required',
            `Goal ${current.goalId} cannot complete without a fully settled TaskLedgerV2 and no ActiveWait.`
          );
        }
        current.lifecycle = expectedLifecycle;
        current.sourceRunId = payload.sourceRunId;
        current.terminalReason = payload.terminalReason;
        current.terminalFactRef = event.id;
        current.waitRef = undefined;
        break;
      }
      case 'taskLedger': {
        if (
          payload.lifecycle !== current.lifecycle
          || !current.confirmedPlanRef
          || !current.planId
          || !current.taskLedger
          || !current.taskLedgerFactRef
        ) {
          invalidTransition(current, event, payload.lifecycle);
        }
        const taskLedger = parseGoalTaskLedger(payload.taskLedger, event.id);
        assertGoalTaskLedgerOwner(current, taskLedger, event.id);
        if (
          taskLedger.revision !== current.taskLedger.revision + 1
          || !payload.sourceRefs.includes(current.taskLedgerFactRef)
        ) {
          throw new SessionGoalError(
            'session_goal_recovery_required',
            `Goal ${current.goalId} has a non-contiguous TaskLedgerV2 fact at ${event.id}.`
          );
        }
        current.taskLedger = taskLedger;
        current.taskLedgerFactRef = event.id;
        break;
      }
      case 'budgetUsage': {
        if (
          (current.lifecycle !== 'running' && current.lifecycle !== 'suspended')
          || payload.lifecycle !== current.lifecycle
        ) {
          invalidTransition(current, event, payload.lifecycle);
        }
        const executionBudget = parseExecutionBudget(
          payload.executionBudget,
          event.id
        );
        assertExecutionBudgetTransition(
          current,
          executionBudget,
          payload,
          event.id
        );
        current.executionBudget = executionBudget;
        current.executionBudgetFactRef = event.id;
        break;
      }
      case 'activeWait': {
        if (
          current.lifecycle !== 'suspended'
          || payload.lifecycle !== current.lifecycle
          || current.activeWait
          || !current.waitRef
        ) {
          invalidTransition(current, event, payload.lifecycle);
        }
        const activeWait = parseActiveWait(payload.activeWait, event.id);
        if (
          activeWait.waitId !== current.waitRef
          || !payload.sourceRefs.includes(
            current.facts.at(-1)?.event.id ?? '<missing>'
          )
        ) {
          throw new SessionGoalError(
            'session_goal_recovery_required',
            `Goal ${current.goalId} ActiveWait ${event.id} does not settle the exact suspension fact.`
          );
        }
        current.activeWait = activeWait;
        current.activeWaitFactRef = event.id;
        break;
      }
      case 'checkpoint': {
        if (payload.lifecycle !== current.lifecycle) {
          invalidTransition(current, event, payload.lifecycle);
        }
        break;
      }
      default:
        assertNever(payload);
    }
    current.facts.push({ event, payload });
  }
  return goals;
}

function createGoalTaskLedger(
  goal: ReducedSessionGoalV1,
  payload: Extract<SessionGoalFactPayloadV1, { factKind: 'activated' }>,
  eventId: string
) {
  try {
    return createTaskLedgerV2({
      owner: {
        kind: 'goal',
        goalId: goal.goalId,
        goalRevision: goal.goalRevision,
        confirmedPlanRef: payload.confirmedPlanRef,
        planId: payload.planId,
      },
      tasks: payload.taskSnapshot,
      sourceRefs: [...payload.sourceRefs, eventId],
    });
  } catch (error) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal activation ${eventId} has an invalid TaskLedgerV2 snapshot: ${errorMessage(error)}`
    );
  }
}

function parseGoalTaskLedger(value: unknown, eventId: string) {
  try {
    return parseTaskLedgerV2(value);
  } catch (error) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal fact ${eventId} has an invalid TaskLedgerV2 payload: ${errorMessage(error)}`
    );
  }
}

function assertGoalTaskLedgerOwner(
  goal: ReducedSessionGoalV1,
  taskLedger: ReturnType<typeof parseTaskLedgerV2>,
  eventId: string
): void {
  const owner = taskLedger.owner;
  if (
    owner.kind !== 'goal'
    || owner.goalId !== goal.goalId
    || owner.goalRevision !== goal.goalRevision
    || owner.planId !== goal.planId
    || owner.confirmedPlanRef !== goal.confirmedPlanRef
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal fact ${eventId} crosses the immutable TaskLedgerV2 owner.`
    );
  }
}

function parseActiveWait(
  value: unknown,
  eventId: string
): SessionGoalActiveWaitV1 {
  const wait = objectRecord(value);
  const kind = wait?.kind;
  if (
    wait?.schemaVersion !== 'deepcode.session.active-wait.v1'
    || !nonEmpty(wait.waitId)
    || !activeWaitKind(kind)
    || (wait.source !== 'session' && wait.source !== 'kernel')
    || !nonEmpty(wait.reason)
    || typeof wait.resumable !== 'boolean'
    || !nonEmpty(wait.createdAt)
    || !stringArray(wait.sourceRefs)
  ) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal fact ${eventId} has an invalid ActiveWaitV1 payload.`
    );
  }
  return structuredClone(wait as unknown as SessionGoalActiveWaitV1);
}

function parseExecutionBudget(
  value: unknown,
  eventId: string
): ExecutionBudgetCoreV1 {
  const budget = objectRecord(value);
  const lastStep = objectRecord(budget?.lastStep);
  if (
    budget?.schemaVersion !== 'deepcode.session.execution-budget-core.v1'
    || !positiveInteger(budget.steps)
    || !nonNegativeInteger(budget.providerCalls)
    || !nonNegativeInteger(budget.activeTimeMs)
    || !nonNegativeInteger(budget.consecutiveRetryCount)
    || budget.consecutiveRetryCount > 3
    || !lastStep
    || !nonEmpty(lastStep.callerRequestId)
    || !goalStepOutcome(lastStep.outcome)
    || !nonEmpty(lastStep.reason)
    || !nonEmpty(lastStep.startedAt)
    || !nonEmpty(lastStep.completedAt)
    || !stringArray(budget.sourceRefs)
  ) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal fact ${eventId} has an invalid ExecutionBudgetCoreV1 payload.`
    );
  }
  return structuredClone(budget as unknown as ExecutionBudgetCoreV1);
}

function assertExecutionBudgetTransition(
  goal: ReducedSessionGoalV1,
  next: ExecutionBudgetCoreV1,
  payload: Extract<SessionGoalFactPayloadV1, { factKind: 'budgetUsage' }>,
  eventId: string
): void {
  const previous = goal.executionBudget;
  if (
    next.lastStep.callerRequestId !== payload.command.callerRequestId
    || (
      previous
        ? (
            next.steps !== previous.steps + 1
            || next.providerCalls < previous.providerCalls
            || next.activeTimeMs < previous.activeTimeMs
            || !goal.executionBudgetFactRef
            || !payload.sourceRefs.includes(goal.executionBudgetFactRef)
          )
        : next.steps !== 1
    )
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal ${goal.goalId} has a non-contiguous ExecutionBudgetCoreV1 fact at ${eventId}.`
    );
  }
}

function activeWaitKind(value: unknown): boolean {
  return value === 'requirement'
    || value === 'plan'
    || value === 'review'
    || value === 'userDecision'
    || value === 'userAcceptance'
    || value === 'scopeChange'
    || value === 'replan'
    || value === 'budget'
    || value === 'persistence'
    || value === 'permission'
    || value === 'cleanup'
    || value === 'indeterminate'
    || value === 'checkpointRequired';
}

function goalStepOutcome(value: unknown): boolean {
  return value === 'continue'
    || value === 'suspend'
    || value === 'complete'
    || value === 'fail';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function currentOrLatestGoal(
  goals: readonly ReducedSessionGoalV1[]
): ReducedSessionGoalV1 | null {
  const active = [...goals].reverse().find(
    (goal) => !terminalLifecycle(goal.lifecycle)
  );
  return active ?? goals.at(-1) ?? null;
}

export function terminalLifecycle(lifecycle: SessionGoalLifecycleV1): boolean {
  return lifecycle === 'completed'
    || lifecycle === 'failed'
    || lifecycle === 'cancelled';
}

function parseGoalFact(event: AgentEvent): SessionGoalFactPayloadV1 {
  const payload = objectRecord(event.payload);
  if (
    !payload
    || payload.schemaVersion !== GOAL_FACT_SCHEMA
    || !nonEmpty(payload.factKind)
    || !nonEmpty(payload.goalId)
    || !positiveInteger(payload.goalRevision)
    || !nonEmpty(payload.lifecycle)
    || !nonEmpty(payload.objective)
    || !stringArray(payload.sourceRefs)
    || !validGoalCommand(payload.command)
    || !validGoalLineage(payload.lineage)
  ) {
    return invalidGoalSchema(event);
  }
  switch (payload.factKind) {
    case 'draftCreated':
      if (
        payload.lifecycle !== 'draft'
        || payload.planRevision !== 0
        || !nonEmpty(payload.sourceRunId)
        || (
          payload.predecessorGoalRef !== undefined
          && !validGoalRef(payload.predecessorGoalRef)
        )
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'planAwaitingAcceptance':
    case 'planRevisionRequested':
      if (
        payload.lifecycle !== 'awaitingPlanAcceptance'
        || !nonEmpty(payload.planId)
        || !positiveInteger(payload.planRevision)
        || !nonEmpty(payload.sourceRunId)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'activated':
      if (
        payload.lifecycle !== 'running'
        || !nonEmpty(payload.planId)
        || !positiveInteger(payload.planRevision)
        || !nonEmpty(payload.confirmedPlanRef)
        || !nonEmpty(payload.authorizationFactRef)
        || !nonEmpty(payload.sourceRunId)
        || !Array.isArray(payload.taskSnapshot)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'suspended':
      if (
        payload.lifecycle !== 'suspended'
        || !nonEmpty(payload.waitRef)
        || !nonEmpty(payload.sourceRunId)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'resumed':
      if (
        payload.lifecycle !== 'running'
        || !nonEmpty(payload.checkpointRef)
        || !nonEmpty(payload.sourceRunId)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'completed':
    case 'failed':
    case 'cancelled':
      if (
        payload.lifecycle !== payload.factKind
        || !nonEmpty(payload.sourceRunId)
        || !nonEmpty(payload.terminalReason)
        || (
          payload.checkpointRef !== undefined
          && !nonEmpty(payload.checkpointRef)
        )
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'taskLedger':
      if (
        (payload.lifecycle !== 'running' && payload.lifecycle !== 'suspended')
        || !objectRecord(payload.taskLedger)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'activeWait':
      if (
        payload.lifecycle !== 'suspended'
        || !objectRecord(payload.activeWait)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'checkpoint':
      if (
        !(
          payload.lifecycle === 'running'
          || payload.lifecycle === 'suspended'
          || payload.lifecycle === 'completed'
          || payload.lifecycle === 'failed'
          || payload.lifecycle === 'cancelled'
        )
        || !objectRecord(payload.checkpoint)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    case 'budgetUsage':
      if (
        (payload.lifecycle !== 'running' && payload.lifecycle !== 'suspended')
        || !objectRecord(payload.executionBudget)
      ) {
        return invalidGoalSchema(event);
      }
      break;
    default:
      return invalidGoalSchema(event);
  }
  return payload as unknown as SessionGoalFactPayloadV1;
}

function invalidGoalSchema(event: AgentEvent): never {
  throw new SessionGoalError(
    'session_goal_schema_unavailable',
    `Goal fact ${event.id} does not satisfy ${GOAL_FACT_SCHEMA}.`
  );
}

function validGoalRef(value: unknown): boolean {
  const ref = objectRecord(value);
  return Boolean(
    ref
    && nonEmpty(ref.goalId)
    && positiveInteger(ref.goalRevision)
  );
}

function validGoalCommand(value: unknown): boolean {
  const command = objectRecord(value);
  return Boolean(
    command
    && nonEmpty(command.callerRequestId)
    && nonEmpty(command.requestDigest)
    && nonEmpty(command.hostRunId)
  );
}

function validGoalLineage(value: unknown): boolean {
  const lineage = objectRecord(value);
  const producer = objectRecord(lineage?.producer);
  return Boolean(
    lineage
    && lineage.schemaVersion === 'deepcode.session.fact-lineage.v1'
    && nonEmpty(lineage.turnAuthorityRef)
    && producer
    && (
      (
        producer.kind === 'sessionRule'
        && nonEmpty(producer.ruleId)
        && stringList(producer.sourceEventRefs)
      )
      || (
        producer.kind === 'providerAdmission'
        && nonEmpty(producer.providerRequestId)
        && nonEmpty(producer.proposalId)
      )
    )
    && stringList(lineage.domainParentRefs)
    && Array.isArray(lineage.kernelFactRefs)
    && lineage.kernelFactRefs.every((ref) => Boolean(objectRecord(ref)))
  );
}

function assertSameGoal(
  goal: ReducedSessionGoalV1,
  payload: SessionGoalFactPayloadV1,
  eventId: string
): void {
  if (
    payload.goalId !== goal.goalId
    || payload.goalRevision !== goal.goalRevision
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal fact ${eventId} crosses Goal identity or revision.`
    );
  }
}

function assertStableObjective(
  goal: ReducedSessionGoalV1,
  payload: SessionGoalFactPayloadV1,
  eventId: string
): void {
  if (payload.objective !== goal.objective) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal fact ${eventId} changes the objective without a new Goal revision.`
    );
  }
}

function invalidTransition(
  goal: ReducedSessionGoalV1,
  event: AgentEvent,
  next: SessionGoalLifecycleV1
): never {
  throw new SessionGoalError(
    'session_goal_recovery_required',
    `Goal ${goal.goalId} cannot transition ${goal.lifecycle} -> ${next} at ${event.id}.`
  );
}

function assertNever(value: never): never {
  throw new SessionGoalError(
    'session_goal_schema_unavailable',
    `Unsupported Goal fact ${(value as { factKind?: unknown }).factKind ?? '<unknown>'}.`
  );
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmpty)
    && new Set(value).size === value.length;
}
