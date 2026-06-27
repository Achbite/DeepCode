import { stableHash } from '../cache/canonicalizer.js';
import type { TaskLedgerSnapshot } from './taskLedger.js';

export interface AcceptedPlanPromptFrame {
  schemaVersion: 'deepcode.session.accepted-plan-prompt-frame.v1';
  planId: string;
  runId: string;
  title?: string;
  summary?: string;
  stableFrameHash: string;
  taskLedger: TaskLedgerSnapshot;
  cachePolicy: {
    stablePrefixFrozen: true;
    projectMemoryRefresh: 'afterReviewOrRunCompletion';
    p5Reserved: true;
  };
}

export function buildAcceptedPlanPromptFrame(input: {
  planId: string;
  runId: string;
  title?: string;
  summary?: string;
  taskLedger: TaskLedgerSnapshot;
}): AcceptedPlanPromptFrame {
  const hashInput = JSON.stringify({
    planId: input.planId,
    runId: input.runId,
    title: input.title,
    summary: input.summary,
    taskOrder: input.taskLedger.taskOrder,
  });
  return {
    schemaVersion: 'deepcode.session.accepted-plan-prompt-frame.v1',
    planId: input.planId,
    runId: input.runId,
    title: input.title,
    summary: input.summary,
    stableFrameHash: stableHash(hashInput),
    taskLedger: input.taskLedger,
    cachePolicy: {
      stablePrefixFrozen: true,
      projectMemoryRefresh: 'afterReviewOrRunCompletion',
      p5Reserved: true,
    },
  };
}

