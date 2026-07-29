import {
  buildSessionKernelReviewV2,
  canFinalizeSessionKernelReviewV2,
  createSessionKernelLoopStateV2,
  finalizeSessionKernelReviewV2,
  reconcileSessionKernelFactsPageV2,
  recordSessionPlanDecisionV2,
  recordSessionPlanV2,
} from '../../dist/index.js';

import {
  NOW,
  RUN_ID,
  assert,
  createFactsPage,
  createInitialState,
  createPlan,
  corpusFact,
  openSessionHarness,
  persistPreviewAndAcceptPlan,
  providerAnswer,
} from './harness.mjs';

export const contractCases = [
  {
    id: 'review_revision_is_pinned_to_one_facts_high_water',
    run: reviewRevisionIsPinnedToOneFactsHighWater,
  },
  {
    id: 'review_separates_plan_scope_effect_denial_cleanup_and_completion',
    run: reviewSeparatesPlanScopeEffectDenialCleanupAndCompletion,
  },
  {
    id: 'provider_completion_never_manufactures_an_effect_fact',
    run: providerCompletionNeverManufacturesAnEffectFact,
  },
  {
    id: 'indeterminate_or_unsettled_cleanup_blocks_final_review',
    run: indeterminateOrUnsettledCleanupBlocksFinalReview,
  },
];

async function reviewRevisionIsPinnedToOneFactsHighWater() {
  let state = acceptedPlanState();
  state = reconcileSessionKernelFactsPageV2(
    state,
    createFactsPage([
      corpusFact('authorizationExpansionAllowed', {
        factId: 'fact-expansion-at-2',
        ledgerSequence: 2,
        runSequence: 1,
        identities: {
          runId: RUN_ID,
          planRevision: 'plan-revision-1',
          planActionId: 'plan-action-write-output',
          expandedOperationId: 'planned-operation-write-output',
        },
      }),
      corpusFact('effectExpandedToolObserved', {
        factId: 'fact-effect-at-3',
        ledgerSequence: 3,
        runSequence: 2,
        identities: {
          runId: RUN_ID,
          planRevision: 'plan-revision-1',
          planActionId: 'plan-action-write-output',
          expandedOperationId: 'planned-operation-write-output',
          expandedInvocationId: 'invocation-review',
          expandedAttemptId: 'attempt-review',
          expandedEffectId: 'effect-review',
          expandedResourceId: 'resource-output',
        },
      }),
    ], {
      requestedAfterLedgerSequence: 0,
      snapshotHighWater: 3,
    })
  ).state;

  const first = buildSessionKernelReviewV2(
    state,
    '2026-07-29T00:10:00.000Z'
  );
  state.review = first;
  const replayed = buildSessionKernelReviewV2(
    state,
    '2026-07-29T00:11:00.000Z'
  );
  assert.deepEqual(
    replayed,
    first,
    'the same fact snapshot must replay the same Review revision'
  );
  assert.equal(first.revision, 1);
  assert.equal(first.snapshotHighWater, 3);

  state = reconcileSessionKernelFactsPageV2(
    state,
    createFactsPage([
      corpusFact('cleanupCompleted', {
        factId: 'fact-cleanup-at-8',
        ledgerSequence: 8,
        runSequence: 3,
        identities: {
          runId: RUN_ID,
          operationId: 'planned-operation-write-output',
          resourceId: 'resource-output',
        },
      }),
    ], {
      requestedAfterLedgerSequence: 3,
      snapshotHighWater: 8,
    })
  ).state;
  const second = buildSessionKernelReviewV2(
    state,
    '2026-07-29T00:12:00.000Z'
  );

  assert.equal(second.revision, 2);
  assert.equal(second.snapshotHighWater, 8);
  assert.equal(first.snapshotHighWater, 3);
  assert.equal(
    first.cleanup.length,
    0,
    'new facts must create a new revision rather than mutate the prior Review'
  );
  assert.equal(second.cleanup.length, 1);

  const harness = await openSessionHarness();
  const loopPlan = createPlan();
  await persistPreviewAndAcceptPlan(harness, loopPlan);
  harness.enqueueProvider(providerAnswer('PlanAction reviewed.'));
  await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: loopPlan.actions[0].manifest.planActionId,
    },
  });
  const loopFirst = await harness.loop.finalizeReview(
    loopPlan.planRevision
  );
  assert.equal(loopFirst.status, 'final');
  assert.equal(loopFirst.snapshotHighWater, 0);

  harness.appendFacts(corpusFact('cleanupCompleted', {
    factId: 'fact-late-cleanup-after-final-review',
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: harness.initial.runId,
      operationId: loopPlan.actions[0].manifest.operationId,
    },
  }));
  const loopSecond = await harness.loop.finalizeReview(
    loopPlan.planRevision
  );
  assert.equal(loopSecond.status, 'final');
  assert.equal(loopSecond.revision, loopFirst.revision + 1);
  assert.equal(
    loopSecond.snapshotHighWater,
    harness.kernelState.snapshotHighWater,
    'finalizeReview must reconcile late facts before reusing a final Review'
  );
  assert.equal(loopSecond.cleanup.length, 1);
}

async function reviewSeparatesPlanScopeEffectDenialCleanupAndCompletion() {
  const firstPlan = createPlan();
  const secondAction = {
    taskId: 'task-second-action',
    manifest: {
      planRevision: firstPlan.planRevision,
      planActionId: 'plan-action-second',
      operationId: 'planned-operation-second',
      toolId: 'fs.write',
      requestedResources: [{
        kind: 'workspacePath',
        data: { path: 'second.txt', access: 'write' },
      }],
    },
    previewArguments: {
      path: 'second.txt',
      content: 'second',
    },
    idempotencyKey: 'idempotency-second-action',
    deadline: { kind: 'contractDefault', data: {} },
  };
  let state = acceptedPlanState({
    ...firstPlan,
    actions: [firstPlan.actions[0], secondAction],
  });
  state.planActionSettlements['plan-action-write-output'] = {
    kind: 'completed',
    planActionId: 'plan-action-write-output',
    completionKind: 'answer',
    providerTurnId: 'provider-turn-completed',
    recordedAt: '2026-07-29T00:03:00.000Z',
  };
  const facts = [
    corpusFact('authorizationCapabilityIssued', {
      factId: 'fact-capability-issued',
      ledgerSequence: 1,
      runSequence: 1,
      identities: {
        runId: RUN_ID,
        planRevision: firstPlan.planRevision,
        planActionId: 'plan-action-write-output',
        plannedOperationId: 'planned-operation-write-output',
      },
    }),
    corpusFact('authorizationExpansionAllowed', {
      factId: 'fact-expansion-allowed',
      ledgerSequence: 2,
      runSequence: 2,
      identities: {
        runId: RUN_ID,
        planRevision: firstPlan.planRevision,
        planActionId: 'plan-action-write-output',
        expandedOperationId: 'planned-operation-write-output',
      },
    }),
    corpusFact('effectExpandedToolObserved', {
      factId: 'fact-effect-observed',
      ledgerSequence: 3,
      runSequence: 3,
      identities: {
        runId: RUN_ID,
        planRevision: firstPlan.planRevision,
        planActionId: 'plan-action-write-output',
        expandedOperationId: 'planned-operation-write-output',
        expandedInvocationId: 'invocation-category',
        expandedAttemptId: 'attempt-category',
        expandedEffectId: 'effect-category',
        expandedResourceId: 'resource-category',
      },
    }),
    corpusFact('authorizationExpansionDenied', {
      factId: 'fact-expansion-denied',
      ledgerSequence: 4,
      runSequence: 4,
      identities: {
        runId: RUN_ID,
        deniedPlanRevision: firstPlan.planRevision,
        deniedPlanActionId: 'plan-action-second',
        deniedOperationId: 'planned-operation-second',
      },
    }),
    corpusFact('cleanupScheduled', {
      factId: 'fact-cleanup-scheduled',
      ledgerSequence: 5,
      runSequence: 5,
      identities: {
        runId: RUN_ID,
        operationId: 'planned-operation-write-output',
        invocationId: 'invocation-category',
        attemptId: 'attempt-category',
        resourceId: 'resource-category',
      },
    }),
    corpusFact('cleanupCompleted', {
      factId: 'fact-cleanup-completed',
      ledgerSequence: 6,
      runSequence: 6,
      identities: {
        runId: RUN_ID,
        operationId: 'planned-operation-write-output',
        invocationId: 'invocation-category',
        attemptId: 'attempt-category',
        resourceId: 'resource-category',
        cleanupScheduledFactId: 'fact-cleanup-scheduled',
      },
    }),
  ];
  state = reconcileSessionKernelFactsPageV2(
    state,
    createFactsPage(facts, {
      requestedAfterLedgerSequence: 0,
      snapshotHighWater: 6,
    })
  ).state;

  const review = finalizeSessionKernelReviewV2(
    state,
    '2026-07-29T00:20:00.000Z'
  );
  assert.equal(review.status, 'final');
  assert.equal(review.snapshotHighWater, 6);
  assert.deepEqual(
    review.scopeExpansions.map((fact) => fact.factId),
    ['fact-expansion-allowed', 'fact-expansion-denied']
  );
  assert.deepEqual(
    review.actualEffects.map((fact) => fact.factId),
    ['fact-effect-observed']
  );
  assert.deepEqual(
    review.denied.map((fact) => fact.factId),
    ['fact-expansion-denied']
  );
  assert.deepEqual(
    review.rejections.map((fact) => fact.factId),
    ['fact-expansion-denied']
  );
  assert.deepEqual(
    review.cleanup.map((fact) => fact.factId),
    ['fact-cleanup-scheduled', 'fact-cleanup-completed']
  );
  assert.deepEqual(
    review.completions.map((item) => item.planActionId),
    ['plan-action-write-output']
  );
  assert.deepEqual(
    review.unexecuted.map((item) => item.planActionId),
    ['plan-action-second']
  );
  assert.equal(review.pendingCleanupCount, 0);
}

async function providerCompletionNeverManufacturesAnEffectFact() {
  const state = acceptedPlanState();
  state.planActionSettlements['plan-action-write-output'] = {
    kind: 'completed',
    planActionId: 'plan-action-write-output',
    completionKind: 'answer',
    providerTurnId: 'provider-turn-answer-only',
    recordedAt: '2026-07-29T00:30:00.000Z',
  };

  const review = finalizeSessionKernelReviewV2(
    state,
    '2026-07-29T00:31:00.000Z'
  );
  assert.equal(review.completions.length, 1);
  assert.equal(
    review.actualEffects.length,
    0,
    'Session narration or completion cannot stand in for a Kernel effect fact'
  );
  assert.deepEqual(
    review.unexecuted.map((item) => item.planActionId),
    ['plan-action-write-output'],
    'Provider completion cannot remove a PlanAction from unexecuted without Kernel execution facts'
  );
}

async function indeterminateOrUnsettledCleanupBlocksFinalReview() {
  let state = acceptedPlanState();
  state = reconcileSessionKernelFactsPageV2(
    state,
    createFactsPage([
      corpusFact('cleanupScheduled', {
        factId: 'fact-cleanup-still-pending',
        ledgerSequence: 1,
        runSequence: 1,
        identities: {
          runId: RUN_ID,
          operationId: 'planned-operation-write-output',
          invocationId: 'invocation-review-indeterminate',
          attemptId: 'attempt-review-indeterminate',
          resourceId: 'resource-pending',
        },
      }),
      corpusFact('invocationToolIndeterminate', {
        factId: 'fact-review-indeterminate',
        ledgerSequence: 2,
        runSequence: 2,
        identities: {
          runId: RUN_ID,
          planRevision: state.plan.planRevision,
          planActionId: 'plan-action-write-output',
          indeterminateOperationId: 'planned-operation-write-output',
          indeterminateInvocationId:
            'invocation-review-indeterminate',
          indeterminateAttemptId: 'attempt-review-indeterminate',
          indeterminateEffectId: 'effect-review-indeterminate',
        },
      }),
    ], {
      requestedAfterLedgerSequence: 0,
      snapshotHighWater: 2,
    })
  ).state;

  const draft = buildSessionKernelReviewV2(
    state,
    '2026-07-29T00:40:00.000Z'
  );
  assert.equal(draft.status, 'draft');
  assert.equal(draft.pendingCleanupCount, 1);
  assert.deepEqual(
    draft.indeterminate.map((fact) => fact.factId),
    ['fact-review-indeterminate']
  );
  assert.equal(canFinalizeSessionKernelReviewV2(state), false);
  assert.throws(
    () => finalizeSessionKernelReviewV2(
      state,
      '2026-07-29T00:41:00.000Z'
    ),
    (error) =>
      error?.code === 'session_kernel_review_not_finalizable'
  );
}

function acceptedPlanState(plan = createPlan()) {
  let state = createSessionKernelLoopStateV2(
    createInitialState()
  );
  state = recordSessionPlanV2(state, plan);
  state = recordSessionPlanDecisionV2(state, {
    planRevision: plan.planRevision,
    decision: 'accept',
    recordedAt: NOW,
  });
  return state;
}
