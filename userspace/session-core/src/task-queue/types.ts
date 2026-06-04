import type { KernelPlanReviewReport } from '@deepcode/protocol';
import type { ActionBundleDraft } from '../agent-plan/types.js';

export type DraftTaskQueueStatus = 'draft' | 'kernelPreflighted' | 'userConfirmed' | 'rejected';

export interface DraftTask {
  id: string;
  title: string;
  capability: string;
  resourceScope: string[];
  conflictKeys: string[];
  canParallelize: boolean;
  sourceBlockId?: string;
}

export interface DraftTaskQueue {
  queueId: string;
  requirementId?: string;
  actionBundle: ActionBundleDraft;
  tasks: DraftTask[];
  status: DraftTaskQueueStatus;
  kernelPlanReview?: KernelPlanReviewReport;
}

export interface ApprovedScope {
  capabilities: string[];
  resourceScopes: string[];
  codeBlockIds: string[];
}

export interface RepairBudget {
  maxRounds: number;
  usedRounds: number;
  allowedFiles: string[];
  forbidNewFilesAfterApproval: boolean;
  forbidNewPermissionsAfterApproval: boolean;
}

export interface ApprovedTask {
  id: string;
  draftTaskId: string;
  title: string;
  capability: string;
  resourceScope: string[];
}

export interface ApprovedTaskQueue {
  queueId: string;
  requirementId?: string;
  planId: string;
  tasks: ApprovedTask[];
  approvedScope: ApprovedScope;
  repairBudget: RepairBudget;
}
