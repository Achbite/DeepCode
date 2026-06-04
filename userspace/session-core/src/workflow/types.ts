import type { ResourceManifest, InitialContextPacket } from '../context/types.js';
import type { ConversationProjectionCardKind } from '../projection.js';

export type WorkflowRequestKind = 'readOnlyAnswer' | 'developmentTask' | 'resourceDiscovery' | 'repairLoop';

export type SessionOrchestrationMicroPhase =
  | 'requirementProbe'
  | 'resourceRequest'
  | 'resourcePacket'
  | 'planDialogue'
  | 'planReview'
  | 'permissionPrompt'
  | 'execution'
  | 'repairLoop'
  | 'reviewRound'
  | 'answer';

export type StateMachineBoundary = 'kernelOwnedStateMachine';

export interface DynamicWorkflowInput {
  workflowId: string;
  requestKind: WorkflowRequestKind;
  userRequest: string;
  workflowRef?: string;
  profile?: string;
  runOverrides?: Record<string, unknown>;
  isReadOnly: boolean;
  requiresExecution: boolean;
  needsMoreContext: boolean;
  hasKernelPlanReview: boolean;
  hasPermissionPrompt: boolean;
  hasExecutionFacts: boolean;
  hasReviewPacket: boolean;
  repairAttempt?: number;
  initialContextPacket?: InitialContextPacket;
  resourceManifest?: ResourceManifest;
}

export interface DynamicWorkflowPlan {
  workflowId: string;
  selectedKind: WorkflowRequestKind;
  workflowRef?: string;
  profile?: string;
  stateMachineBoundary: StateMachineBoundary;
  microPhases: SessionOrchestrationMicroPhase[];
  projectionCardKinds: ConversationProjectionCardKind[];
  requiresPlanReview: boolean;
  requiresUserPlanConfirmation: boolean;
  usesKernelPermissionGate: boolean;
  notes: string[];
}
