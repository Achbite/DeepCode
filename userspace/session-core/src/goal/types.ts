import type {
  AgentEvent,
  AgentTimelineResult,
  GoalProjectionV1,
  SessionDomainStateSnapshotV1,
  SessionGoalCommandIdentityV1,
  SessionGoalFactPayloadV1,
  SessionGoalLifecycleV1,
  SessionGoalRefV1,
} from '@deepcode/protocol';

export type GoalOperationKind =
  | 'start'
  | 'resolveInteraction'
  | 'advance'
  | 'resume'
  | 'cancel'
  | 'read';

export interface SessionGoalOperationContext {
  operation: Exclude<GoalOperationKind, 'read'>;
  goalId: string;
  goalRevision: number;
  objective?: string;
  expectedDomainHeadDigest?: string;
  command: SessionGoalCommandIdentityV1;
  predecessorGoalRef?: SessionGoalRefV1;
}

export interface ReducedSessionGoalV1 {
  sessionId: string;
  goalId: string;
  goalRevision: number;
  lifecycle: SessionGoalLifecycleV1;
  objective: string;
  predecessorGoalRef?: SessionGoalRefV1;
  planId?: string;
  planRevision: number;
  sourceRunId: string;
  confirmedPlanRef?: string;
  authorizationFactRef?: string;
  terminalReason?: string;
  terminalFactRef?: string;
  facts: Array<{
    event: AgentEvent;
    payload: SessionGoalFactPayloadV1;
  }>;
}

export interface SessionGoalReadInput {
  sessionId: string;
  events: AgentEvent[];
  domainState: SessionDomainStateSnapshotV1;
  conversationProjection: AgentTimelineResult;
  goalId?: string;
}

export interface SessionGoalReadResult {
  projection: GoalProjectionV1 | null;
  current: ReducedSessionGoalV1 | null;
  history: ReducedSessionGoalV1[];
}

export class SessionGoalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'SessionGoalError';
  }
}
