import type {
  AgentEvent,
  ConversationLanguagePolicyStatus,
  GoalCheckpointV1,
  SessionGoalActiveWaitV1,
  SessionGoalLifecycleV1,
  SessionGoalPendingEffectV1,
  TaskLedgerSnapshotV2,
} from '@deepcode/protocol';
import { canonicalJson, sha256Hash } from '../cache/canonicalizer.js';
import { SessionGoalError } from './types.js';

type CheckpointLifecycle = Exclude<
  SessionGoalLifecycleV1,
  'draft' | 'awaitingPlanAcceptance'
>;

export interface BuildGoalCheckpointInput {
  sessionId: string;
  goalId: string;
  goalRevision: number;
  lifecycle: CheckpointLifecycle;
  checkpointRef: string;
  sequence: number;
  taskLedger: TaskLedgerSnapshotV2;
  taskLedgerFactRef: string;
  activeWait?: SessionGoalActiveWaitV1;
  activeWaitFactRef?: string;
  languageRef: GoalCheckpointV1['languageRef'];
  contextRefs: string[];
  pendingEffect?: SessionGoalPendingEffectV1;
  lastKernelFactRef?: string;
  sourceRefs: string[];
  createdAt: string;
}

export function buildGoalCheckpoint(
  input: BuildGoalCheckpointInput
): GoalCheckpointV1 {
  const checkpointWithoutDigest = {
    schemaVersion: 'deepcode.session.goal-checkpoint.v1' as const,
    checkpointRef: requireIdentity(input.checkpointRef, 'checkpointRef'),
    sequence: requirePositiveInteger(input.sequence, 'sequence'),
    sessionId: requireIdentity(input.sessionId, 'sessionId'),
    goalId: requireIdentity(input.goalId, 'goalId'),
    goalRevision: requirePositiveInteger(input.goalRevision, 'goalRevision'),
    lifecycle: input.lifecycle,
    taskLedgerRef: {
      factRef: requireIdentity(input.taskLedgerFactRef, 'taskLedgerRef.factRef'),
      revision: requirePositiveInteger(
        input.taskLedger.revision,
        'taskLedgerRef.revision'
      ),
      stateDigest: sha256Hash(canonicalJson(input.taskLedger)),
    },
    ...(input.activeWait && input.activeWaitFactRef
      ? {
          activeWaitRef: {
            factRef: requireIdentity(
              input.activeWaitFactRef,
              'activeWaitRef.factRef'
            ),
            waitId: requireIdentity(input.activeWait.waitId, 'activeWaitRef.waitId'),
          },
        }
      : {}),
    languageRef: validateLanguageRef(input.languageRef),
    contextRefs: uniqueIdentities(input.contextRefs, 'contextRefs'),
    ...(input.pendingEffect
      ? { pendingEffect: parseGoalPendingEffect(input.pendingEffect, input.checkpointRef) }
      : {}),
    ...(input.lastKernelFactRef
      ? {
          lastKernelFactRef: requireIdentity(
            input.lastKernelFactRef,
            'lastKernelFactRef'
          ),
        }
      : {}),
    sourceRefs: uniqueIdentities(input.sourceRefs, 'sourceRefs', true),
    createdAt: requireText(input.createdAt, 'createdAt'),
  };
  return {
    ...checkpointWithoutDigest,
    stateDigest: sha256Hash(canonicalJson(checkpointWithoutDigest)),
  };
}

export function parseGoalCheckpoint(
  value: unknown,
  eventId: string
): GoalCheckpointV1 {
  const checkpoint = objectRecord(value);
  if (
    checkpoint?.schemaVersion !== 'deepcode.session.goal-checkpoint.v1'
    || !nonEmpty(checkpoint.checkpointRef)
    || !positiveInteger(checkpoint.sequence)
    || !nonEmpty(checkpoint.sessionId)
    || !nonEmpty(checkpoint.goalId)
    || !positiveInteger(checkpoint.goalRevision)
    || !checkpointLifecycle(checkpoint.lifecycle)
    || !objectRecord(checkpoint.taskLedgerRef)
    || !objectRecord(checkpoint.languageRef)
    || !stringArray(checkpoint.contextRefs)
    || !stringArray(checkpoint.sourceRefs)
    || checkpoint.sourceRefs.length === 0
    || !nonEmpty(checkpoint.createdAt)
    || !nonEmpty(checkpoint.stateDigest)
  ) {
    return invalidCheckpoint(eventId);
  }
  const taskLedgerRef = objectRecord(checkpoint.taskLedgerRef)!;
  if (
    !nonEmpty(taskLedgerRef.factRef)
    || !positiveInteger(taskLedgerRef.revision)
    || !nonEmpty(taskLedgerRef.stateDigest)
  ) {
    return invalidCheckpoint(eventId);
  }
  const languageRef = objectRecord(checkpoint.languageRef)!;
  if (
    !positiveInteger(languageRef.revision)
    || !languageStatus(languageRef.status)
    || !nonEmpty(languageRef.sourceTurnId)
    || !nonEmpty(languageRef.turnAuthorityRef)
  ) {
    return invalidCheckpoint(eventId);
  }
  const activeWaitRef = checkpoint.activeWaitRef === undefined
    ? undefined
    : objectRecord(checkpoint.activeWaitRef);
  if (
    checkpoint.activeWaitRef !== undefined
    && (
      !activeWaitRef
      || !nonEmpty(activeWaitRef.factRef)
      || !nonEmpty(activeWaitRef.waitId)
    )
  ) {
    return invalidCheckpoint(eventId);
  }
  if (checkpoint.pendingEffect !== undefined) {
    parseGoalPendingEffect(checkpoint.pendingEffect, eventId);
  }
  if (
    checkpoint.lastKernelFactRef !== undefined
    && !nonEmpty(checkpoint.lastKernelFactRef)
  ) {
    return invalidCheckpoint(eventId);
  }
  const { stateDigest, ...withoutDigest } = checkpoint;
  if (sha256Hash(canonicalJson(withoutDigest)) !== stateDigest) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      `Goal checkpoint ${eventId} state digest does not match its canonical payload.`
    );
  }
  return structuredClone(checkpoint as unknown as GoalCheckpointV1);
}

export function parseGoalPendingEffect(
  value: unknown,
  sourceRef: string
): SessionGoalPendingEffectV1 {
  const effect = objectRecord(value);
  const semantic = objectRecord(effect?.semanticRef);
  const kernel = effect?.kernel === undefined
    ? undefined
    : objectRecord(effect.kernel);
  if (
    effect?.schemaVersion !== 'deepcode.session.pending-effect.v1'
    || !nonEmpty(effect.effectId)
    || effect.kind !== 'kernelAction'
    || (
      effect.state !== 'prepared'
      && effect.state !== 'dispatched'
      && effect.state !== 'observed'
    )
    || !semantic
    || semantic.schemaVersion !== 'deepcode.session.analysis-record-ref.v1'
    || !nonEmpty(semantic.recordId)
    || !positiveInteger(semantic.analysisSeq)
    || !nonEmpty(semantic.recordDigest)
    || !nonEmpty(semantic.payloadDigest)
    || !nonEmpty(semantic.providerRequestId)
    || !nonEmpty(semantic.toolCallId)
    || !nonEmpty(semantic.proposalId)
    || !nonEmpty(semantic.proposalDigest)
    || !nonEmpty(effect.runId)
    || !nonEmpty(effect.planId)
    || !nonEmpty(effect.taskId)
    || !stringArray(effect.actionIds)
    || effect.actionIds.length === 0
    || !stringArray(effect.sourceRefs)
    || effect.sourceRefs.length === 0
  ) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal pending effect at ${sourceRef} is invalid.`
    );
  }
  if (
    (effect.state === 'prepared' && kernel !== undefined)
    || (
      effect.state !== 'prepared'
      && (
        !kernel
        || !nonEmpty(kernel.requestId)
        || !nonEmpty(kernel.contractId)
        || (
          kernel.contractHash !== undefined
          && !nonEmpty(kernel.contractHash)
        )
        || !stringArray(kernel.workUnitIds)
        || !stringArray(kernel.kernelFactRefs)
        || (
          effect.state === 'observed'
          && kernel.kernelFactRefs.length === 0
        )
      )
    )
  ) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal pending effect at ${sourceRef} has an invalid ${String(effect.state)} Kernel binding.`
    );
  }
  return structuredClone(effect as unknown as SessionGoalPendingEffectV1);
}

export function nextGoalCheckpointSequence(
  events: readonly AgentEvent[]
): number {
  let maximum = 0;
  for (const event of events) {
    if (event.kind !== 'session_goal_fact') continue;
    const payload = objectRecord(event.payload);
    if (payload?.factKind !== 'checkpoint') continue;
    const sequence = objectRecord(payload.checkpoint)?.sequence;
    if (!positiveInteger(sequence)) {
      throw new SessionGoalError(
        'session_goal_schema_unavailable',
        `Goal checkpoint fact ${event.id} has no positive global sequence.`
      );
    }
    maximum = Math.max(maximum, sequence);
  }
  return maximum + 1;
}

export function goalCheckpointLanguageRef(
  events: readonly AgentEvent[]
): GoalCheckpointV1['languageRef'] {
  const authority = [...events].reverse().find(
    (event) => event.kind === 'session_turn_authority'
  );
  const authorityPayload = objectRecord(authority?.payload);
  const policy = objectRecord(authorityPayload?.languagePolicy);
  if (
    !authority
    || !policy
    || !positiveInteger(policy.revision)
    || !nonEmpty(policy.sourceTurnId)
  ) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      'Goal checkpoint requires the exact persisted conversation language authority.'
    );
  }
  const decision = [...events].reverse().find((event) => {
    if (event.kind !== 'session_language_decision') return false;
    const payload = objectRecord(event.payload);
    return payload?.revision === policy.revision
      && payload?.turnId === policy.sourceTurnId;
  });
  const decisionStatus = objectRecord(decision?.payload)?.status;
  const status = languageStatus(decisionStatus)
    ? decisionStatus
    : policy.status;
  if (!languageStatus(status)) {
    throw new SessionGoalError(
      'session_goal_recovery_required',
      'Goal checkpoint language policy has an invalid status.'
    );
  }
  return {
    revision: policy.revision,
    status,
    sourceTurnId: policy.sourceTurnId,
    turnAuthorityRef: authority.id,
  };
}

export function goalCheckpointContextRefs(
  events: readonly AgentEvent[],
  requiredRefs: readonly string[]
): string[] {
  const recentWorkflowRefs = events
    .filter((event) => event.kind === 'workflow_stage')
    .slice(-8)
    .map((event) => event.id);
  return uniqueIdentities(
    [...requiredRefs, ...recentWorkflowRefs],
    'contextRefs'
  );
}

function validateLanguageRef(
  value: GoalCheckpointV1['languageRef']
): GoalCheckpointV1['languageRef'] {
  if (
    !positiveInteger(value.revision)
    || !languageStatus(value.status)
    || !nonEmpty(value.sourceTurnId)
    || !nonEmpty(value.turnAuthorityRef)
  ) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      'Goal checkpoint languageRef is invalid.'
    );
  }
  return { ...value };
}

function invalidCheckpoint(eventId: string): never {
  throw new SessionGoalError(
    'session_goal_schema_unavailable',
    `Goal checkpoint ${eventId} does not satisfy deepcode.session.goal-checkpoint.v1.`
  );
}

function requireIdentity(value: string, field: string): string {
  if (!nonEmpty(value)) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal checkpoint ${field} must be a non-empty identity.`
    );
  }
  return value.trim();
}

function requireText(value: string, field: string): string {
  if (!nonEmpty(value)) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal checkpoint ${field} must be non-empty.`
    );
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  if (!positiveInteger(value)) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal checkpoint ${field} must be a positive integer.`
    );
  }
  return value;
}

function uniqueIdentities(
  values: readonly string[],
  field: string,
  requireOne = false
): string[] {
  if (!stringArray(values) || (requireOne && values.length === 0)) {
    throw new SessionGoalError(
      'session_goal_schema_unavailable',
      `Goal checkpoint ${field} must contain valid identities.`
    );
  }
  return [...new Set(values.map((value) => value.trim()))];
}

function checkpointLifecycle(value: unknown): value is CheckpointLifecycle {
  return value === 'running'
    || value === 'suspended'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function languageStatus(
  value: unknown
): value is ConversationLanguagePolicyStatus {
  return value === 'pending'
    || value === 'resolved'
    || value === 'fallback'
    || value === 'superseded';
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

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((entry) => nonEmpty(entry));
}
