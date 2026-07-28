import type { SessionKernelPortV2 } from './SessionKernelPortV2.js';
import type { SessionKernelCheckpointV2 } from './state.js';
import type {
  SessionKernelProjectionEventV2,
  SessionKernelPublicRequestRecordV2,
  SessionNaturalLanguagePlanV2,
  SessionPlanDecisionV2,
  SessionProviderTurnInputV2,
  SessionProviderTurnOutputV2,
  SessionUserInputRecordV2,
} from './types.js';

export interface SessionKernelPersistencePortV2 {
  loadCheckpoint(runId: string): Promise<SessionKernelCheckpointV2 | undefined>;

  loadLatestPlan(
    runId: string
  ): Promise<SessionNaturalLanguagePlanV2 | undefined>;

  loadLatestInput(
    runId: string
  ): Promise<SessionUserInputRecordV2 | undefined>;

  loadPlanDecision(
    runId: string,
    planRevision: string
  ): Promise<SessionPlanDecisionV2 | undefined>;

  loadPendingPublicRequests(
    runId: string
  ): Promise<SessionKernelPublicRequestRecordV2[]>;

  /**
   * Same planRevision plus identical content is an idempotent replay; the
   * same revision with different content is a permanent identity conflict.
   */
  persistPlan(plan: SessionNaturalLanguagePlanV2): Promise<void>;

  persistPlanDecision(decision: SessionPlanDecisionV2): Promise<void>;

  persistInput(input: SessionUserInputRecordV2): Promise<void>;

  persistPublicRequest(
    request: SessionKernelPublicRequestRecordV2
  ): Promise<void>;

  settlePublicRequest(
    request: SessionKernelPublicRequestRecordV2,
    outcomeDigest: string,
    checkpoint: SessionKernelCheckpointV2,
    projections: SessionKernelProjectionEventV2[]
  ): Promise<void>;

  persistCheckpoint(checkpoint: SessionKernelCheckpointV2): Promise<void>;
}

export interface SessionKernelProviderPortV2 {
  requestTurn(
    input: SessionProviderTurnInputV2
  ): Promise<SessionProviderTurnOutputV2>;
}

export interface SessionKernelProjectionPortV2 {
  /**
   * Implementations must deduplicate by event.projectionId. Durable Kernel
   * requests can replay after an unknown transport outcome.
   */
  project(event: SessionKernelProjectionEventV2): Promise<void>;

  flushPending(runId: string): Promise<void>;
}

export interface SessionKernelClockPortV2 {
  now(): string;

  waitUntil(instant: string, signal?: AbortSignal): Promise<void>;
}

export interface SessionKernelIdFactoryPortV2 {
  nextRequestId(): string;

  nextProviderTurnId(): string;
}

/**
 * The Loop depends only on semantic ports. Raw KernelCommand envelopes and
 * run/decision capabilities remain below SessionKernelPortV2.
 */
export interface SessionKernelLoopPortsV2 {
  kernel: SessionKernelPortV2;
  persistence: SessionKernelPersistencePortV2;
  provider: SessionKernelProviderPortV2;
  projection: SessionKernelProjectionPortV2;
  clock: SessionKernelClockPortV2;
  ids: SessionKernelIdFactoryPortV2;
}
