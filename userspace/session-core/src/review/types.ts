import type { KernelPlanReviewReport } from '@deepcode/protocol';
import type { ActionBundleDraft, ValidationExpectationDraft } from '../agent-plan/types.js';

export type ReviewPacketStatus = 'selfChecked' | 'waitingUserReview' | 'accepted' | 'revisionRequested';

export interface ReviewPermissionDecision {
  id: string;
  capability: string;
  resourceScope: string;
  decision: 'pending' | 'approved' | 'denied';
  summary?: string;
}

export interface ReviewToolResult {
  id: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  toolName?: string;
  modifiedFiles: string[];
  error?: string;
}

export interface ReviewValidationFact {
  id: string;
  description: string;
  status: 'pending' | 'passed' | 'failed' | 'skipped';
  command?: string;
  evidenceRef?: string;
}

export interface ReviewSelfCheckInput {
  userRequest: string;
  userPlan?: string;
  actionBundle?: ActionBundleDraft;
  kernelPlanReview?: KernelPlanReviewReport;
  permissionDecisions: ReviewPermissionDecision[];
  toolResults: ReviewToolResult[];
  validationCandidates: ValidationExpectationDraft[];
}

export interface ReviewKernelFacts {
  modifiedFiles: string[];
  createdFiles: string[];
  deletedFiles: string[];
  commandsExecuted: string[];
  permissionDecisions: ReviewPermissionDecision[];
  toolResults: ReviewToolResult[];
  validationResults: ReviewValidationFact[];
  diffSummary?: string;
  permissionSummary?: string;
  auditRefs: string[];
}

export interface LlmReviewGuidance {
  summary: string;
  finalSummary: string;
  suggestedReviewChecks: string[];
  knownRisks: string[];
  unverifiedItems: string[];
}

export interface ReviewPacket {
  requirementId: string;
  runId: string;
  status: ReviewPacketStatus;
  selfCheckInput: ReviewSelfCheckInput;
  kernelFacts: ReviewKernelFacts;
  llmGuidance: LlmReviewGuidance;
}

export type UserReviewDecision =
  | { kind: 'accept' }
  | { kind: 'requestRevision'; feedback: string }
  | { kind: 'reject'; reason: string }
  | { kind: 'expandScope'; scopeDelta: string }
  | { kind: 'createNewRequirement'; draft: string };
