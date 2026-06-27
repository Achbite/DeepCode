import type { TaskLedgerSnapshot } from './taskLedger.js';

export interface ReviewFactsContext {
  schemaVersion: 'deepcode.session.review-facts-context.v1';
  scope: 'acceptedPlan';
  planId?: string;
  runId?: string;
  taskLedger?: TaskLedgerSnapshot;
  changedFileCount?: number;
  auditRefCount?: number;
}

export function buildReviewFactsContext(input: {
  planId?: string;
  runId?: string;
  taskLedger?: TaskLedgerSnapshot;
  changedFileCount?: number;
  auditRefCount?: number;
}): ReviewFactsContext {
  return {
    schemaVersion: 'deepcode.session.review-facts-context.v1',
    scope: 'acceptedPlan',
    planId: input.planId,
    runId: input.runId,
    taskLedger: input.taskLedger,
    changedFileCount: input.changedFileCount,
    auditRefCount: input.auditRefCount,
  };
}

