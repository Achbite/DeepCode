import { stableHash } from '../cache/canonicalizer.js';
import type { ContextAssemblyRecord, ContextAssemblyTaskLocalFoldPlan } from './assembler.js';

export type ContextAssemblyTaskLocalCompactSource =
  | 'kernelBatchCheckpoint'
  | 'modelTaskOutcome'
  | 'resourceValidation';

export type ContextAssemblyTaskLocalCompactStatus =
  | 'completedByKernelFacts'
  | 'modelJudgedSufficient'
  | 'completedByReadOnlyEvidence';

export interface ContextAssemblyTaskLocalCompactRecord {
  schemaVersion: 'deepcode.session.context-task-compact.v1';
  source: ContextAssemblyTaskLocalCompactSource;
  status: ContextAssemblyTaskLocalCompactStatus;
  boundary: 'sessionContextMetadataOnly';
  planId?: string;
  runId?: string;
  taskId?: string;
  taskCursorId?: string;
  lastTaskSavepointId?: string;
  currentTaskGoalHash?: string;
  currentTaskContextHash?: string;
  dynamicAppendLogHash: string;
  taskLocalFoldPlanHash: string;
  foldableSegmentCount: number;
  foldableRenderedCharLength: number;
  retainedSegmentCount: number;
  retainedRenderedCharLength: number;
  retainedPolicies: string[];
  foldablePolicies: string[];
  compactHash: string;
}

export function buildTaskLocalCompactRecord(input: {
  contextAssembly?: ContextAssemblyRecord;
  source: ContextAssemblyTaskLocalCompactSource;
  status: ContextAssemblyTaskLocalCompactStatus;
  planId?: string;
  runId?: string;
  taskId?: string;
}): ContextAssemblyTaskLocalCompactRecord | undefined {
  const assembly = input.contextAssembly;
  if (!assembly?.taskLocalFoldPlan) return undefined;
  const plan = assembly.taskLocalFoldPlan;
  const draft = {
    schemaVersion: 'deepcode.session.context-task-compact.v1' as const,
    source: input.source,
    status: input.status,
    boundary: 'sessionContextMetadataOnly' as const,
    planId: input.planId,
    runId: input.runId,
    taskId: input.taskId,
    taskCursorId: plan.taskCursorId,
    lastTaskSavepointId: plan.lastTaskSavepointId,
    currentTaskGoalHash: plan.currentTaskGoalHash,
    currentTaskContextHash: plan.currentTaskContextHash,
    dynamicAppendLogHash: plan.dynamicAppendLogHash,
    taskLocalFoldPlanHash: assembly.taskLocalFoldPlanHash,
    foldableSegmentCount: plan.foldableSegmentCount,
    foldableRenderedCharLength: plan.foldableRenderedCharLength,
    retainedSegmentCount: plan.retainedSegmentCount,
    retainedRenderedCharLength: plan.retainedRenderedCharLength,
    retainedPolicies: retainedPolicies(plan),
    foldablePolicies: foldablePolicies(plan),
  };
  return {
    ...draft,
    compactHash: stableHash(JSON.stringify(draft)),
  };
}

function retainedPolicies(plan: ContextAssemblyTaskLocalFoldPlan): string[] {
  return plan.policySummaries
    .filter((summary) => summary.policy !== 'dropAfterTask')
    .map((summary) => summary.policy);
}

function foldablePolicies(plan: ContextAssemblyTaskLocalFoldPlan): string[] {
  return plan.policySummaries
    .filter((summary) => summary.policy === 'dropAfterTask')
    .map((summary) => summary.policy);
}
