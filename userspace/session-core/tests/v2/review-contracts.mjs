import {
  buildSessionKernelReviewV2,
  buildNarrativeTimelineProjection,
  canonicalJson,
  canFinalizeSessionKernelReviewV2,
  createSessionKernelLoopStateV2,
  findLatestPendingPermission,
  finalizeSessionKernelReviewV2,
  reconcileSessionKernelFactsPageV2,
  recordSessionPlanDecisionV2,
  recordSessionPlanV2,
  sessionKernelAgentEventV2,
  sha256Hash,
} from '../../dist/index.js';

import {
  NOW,
  RUN_ID,
  admittedReply,
  assert,
  createFactsPage,
  createInitialState,
  createPlan,
  corpusFact,
  openSessionHarness,
  persistPreviewAndAcceptPlan,
  providerAnswer,
  providerToolIntents,
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
  {
    id: 'canonical_terminal_facts_settle_queue_before_next_provider_or_review',
    run: canonicalTerminalFactsSettleQueueBeforeNextProviderOrReview,
  },
  {
    id: 'latest_run_drives_live_projection_without_truncating_history',
    run: latestRunDrivesLiveProjectionWithoutTruncatingHistory,
  },
  {
    id: 'recoverable_blocked_error_does_not_fail_latest_run',
    run: recoverableBlockedErrorDoesNotFailLatestRun,
  },
  {
    id: 'provider_token_usage_projection_is_canonical_digest_safe',
    run: providerTokenUsageProjectionIsCanonicalDigestSafe,
  },
  {
    id: 'draft_review_stays_private_and_final_review_projects_once',
    run: draftReviewStaysPrivateAndFinalReviewProjectsOnce,
  },
  {
    id: 'readable_review_keeps_raw_identities_only_in_audit_refs',
    run: readableReviewKeepsRawIdentitiesOnlyInAuditRefs,
  },
];

async function providerTokenUsageProjectionIsCanonicalDigestSafe() {
  const sessionId = 'session-provider-token-usage';
  const runId = 'run-provider-token-usage';
  const providerTurnId = 'provider-turn-token-usage';
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    generatedAt: '2026-07-29T00:06:00.000Z',
    events: [
      agentEvent(
        sessionId,
        'event-token-usage-user',
        'user_msg',
        runId,
        {
          inputId: 'input-token-usage',
          text: 'Report canonical Provider token counters.',
          attachments: [],
        },
        0
      ),
      agentEvent(
        sessionId,
        'event-token-usage-started',
        'workflow_stage',
        runId,
        {
          projectionKind: 'provider.started',
          providerTurnId,
        },
        1
      ),
      agentEvent(
        sessionId,
        'event-token-usage-completed',
        'tool_result',
        runId,
        {
          projectionKind: 'provider.completed',
          providerTurnId,
          providerOutcome: {
            providerProfileId: 'provider-profile-token-usage',
            provider: 'deepseek',
            model: 'deepseek-token-usage-contract',
            usage: {
              prompt_cache_hit_tokens: 1,
              prompt_cache_miss_tokens: 2,
              cached_tokens: 1,
              prompt_tokens: 3,
              completion_tokens: 4,
              total_tokens: 7,
            },
          },
        },
        2
      ),
    ],
  });

  const tokenUsage = projection.tokenUsageProjection;
  assert(tokenUsage, 'Provider usage must produce a token projection');
  assert.deepEqual(tokenUsage.totals, {
    promptCacheHitTokens: 1,
    promptCacheMissTokens: 2,
    cachedTokens: 1,
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
    providerCallCount: 1,
    providers: ['deepseek'],
  });
  assert.equal(tokenUsage.requests.length, 1);
  assert.deepEqual(
    {
      promptCacheHitTokens:
        tokenUsage.requests[0].promptCacheHitTokens,
      promptCacheMissTokens:
        tokenUsage.requests[0].promptCacheMissTokens,
      cachedTokens: tokenUsage.requests[0].cachedTokens,
      promptTokens: tokenUsage.requests[0].promptTokens,
      completionTokens: tokenUsage.requests[0].completionTokens,
      totalTokens: tokenUsage.requests[0].totalTokens,
      providerCallCount: tokenUsage.requests[0].providerCallCount,
      providers: tokenUsage.requests[0].providers,
    },
    tokenUsage.totals
  );
  assert.equal(
    Object.hasOwn(tokenUsage.totals, 'cacheHitRate'),
    false
  );
  assert.equal(
    Object.hasOwn(tokenUsage.requests[0], 'cacheHitRate'),
    false
  );

  const canonicalWire = canonicalJson(projection);
  assert.equal(
    canonicalWire.includes('"cacheHitRate"'),
    false,
    'canonical Session wire must contain only integer cache counters'
  );
  const projectionDigest = sha256Hash(canonicalWire);
  assert.match(projectionDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(
    sha256Hash(canonicalJson(JSON.parse(canonicalWire))),
    projectionDigest,
    'canonical parse/re-encode must preserve the projection digest'
  );
}

async function canonicalTerminalFactsSettleQueueBeforeNextProviderOrReview() {
  const harness = await openSessionHarness();
  const plan = createPlan();
  await persistPreviewAndAcceptPlan(harness, plan);
  harness.enqueueProvider(providerToolIntents([
    {
      callId: 'provider-call-review-queue-1',
      toolId: 'fs.write',
      arguments: { path: 'output.txt', content: 'contract output' },
    },
    {
      callId: 'provider-call-review-queue-2',
      toolId: 'fs.write',
      arguments: { path: 'output.txt', content: 'contract output' },
    },
  ]));
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-review-queue-1',
      attemptId: 'attempt-review-queue-1',
    })
  );
  const admitted = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: plan.actions[0].manifest.planActionId,
    },
    remainingToolCallBudget: 2,
  });
  assert.equal(admitted.kind, 'admitted');
  assert.equal(
    harness.loop.snapshot().providerToolCallQueue.outcomeRecorded,
    false
  );
  assert.throws(
    () => buildSessionKernelReviewV2(
      harness.loop.snapshot(),
      '2026-07-29T00:04:00.000Z'
    ),
    (error) =>
      error?.code === 'session_kernel_review_snapshot_incomplete'
  );
  assert.equal(
    canFinalizeSessionKernelReviewV2(harness.loop.snapshot()),
    false
  );
  assert.throws(
    () => finalizeSessionKernelReviewV2(
      harness.loop.snapshot(),
      '2026-07-29T00:04:00.001Z'
    ),
    (error) =>
      error?.code === 'session_kernel_review_not_finalizable'
  );
  const responseAcceptedEvents = harness.store.projectionEvents.filter(
    (event) =>
      event.kind === 'provider.completed'
      && event.data?.outputKind === 'toolIntent'
      && event.data?.status === 'responseAccepted'
  );
  assert.equal(responseAcceptedEvents.length, 1);
  assert.equal(responseAcceptedEvents[0].data.terminalScope,
    'providerTurn');
  assert.equal(
    JSON.stringify(responseAcceptedEvents[0]).includes('"arguments"'),
    false,
    'the safe Provider response projection must omit raw arguments'
  );
  assert.equal(
    JSON.stringify(responseAcceptedEvents[0]).includes('output.txt'),
    false,
    'the safe Provider response projection must not infer canonical targets'
  );
  assert.equal(
    JSON.stringify(responseAcceptedEvents[0]).includes('terminalFactId'),
    false,
    'the safe Provider response projection must not manufacture terminal facts'
  );
  const completedQueueEvents = () =>
    harness.store.projectionEvents.filter(
      (event) =>
        event.kind === 'provider.completed'
        && event.data?.result?.kind === 'orderedToolCallsCompleted'
    );
  assert.equal(
    completedQueueEvents().length,
    0,
    'a submission reply cannot manufacture the queue outcome'
  );

  const firstCompleted = appendMutationCompletion(
    harness,
    plan,
    admitted,
    'attempt-review-queue-1',
    'review-queue-first'
  );
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: admitted.operationId,
    invocationId: admitted.invocationId,
    planActionId: plan.actions[0].manifest.planActionId,
    expectedPlanRevision: plan.planRevision,
  });

  const betweenCalls = harness.loop.snapshot();
  assert.deepEqual(
    betweenCalls.providerToolCallQueue.calls.map((call) => call.status),
    ['completed', 'pending']
  );
  assert.equal(
    betweenCalls.providerToolCallQueue.calls[0].terminalFactId,
    firstCompleted.factId
  );
  assert.equal(
    completedQueueEvents().length,
    0,
    'one canonical terminal fact cannot complete a two-call queue'
  );
  await assert.rejects(
    harness.loop.runProviderTurn({
      reason: 'planExecution',
      target: {
        kind: 'planAction',
        planActionId: plan.actions[0].manifest.planActionId,
      },
      remainingToolCallBudget: 1,
    }),
    (error) =>
      error?.code === 'session_kernel_provider_tool_call_queue_active'
  );
  assert.equal(
    harness.providerInputs.length,
    1,
    'an active queue must reject a new Provider turn before transport'
  );

  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      admissionFactId: 'fact-review-queue-admitted-2',
      invocationId: 'invocation-review-queue-2',
      attemptId: 'attempt-review-queue-2',
    })
  );
  const second = await harness.loop.resumePendingProviderToolCalls();
  assert.equal(second.kind, 'admitted');
  const secondCompleted = appendMutationCompletion(
    harness,
    plan,
    second,
    'attempt-review-queue-2',
    'review-queue-second'
  );
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: second.operationId,
    invocationId: second.invocationId,
    planActionId: plan.actions[0].manifest.planActionId,
    expectedPlanRevision: plan.planRevision,
  });

  let settled = harness.loop.snapshot();
  assert.equal(settled.providerToolCallQueue.status, 'completed');
  assert.equal(settled.providerToolCallQueue.outcomeRecorded, true);
  assert.equal(
    settled.providerToolCallQueue.calls[1].terminalFactId,
    secondCompleted.factId
  );
  assert.equal(completedQueueEvents().length, 1);
  assert.equal(completedQueueEvents()[0].data.result.callCount, 2);
  harness.enqueueProvider(providerAnswer('continued after queue settlement'));
  const continued = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: plan.actions[0].manifest.planActionId,
    },
    remainingToolCallBudget: 1,
  });
  assert.deepEqual(continued, {
    kind: 'answer',
    text: 'continued after queue settlement',
  });
  assert.equal(harness.providerInputs.length, 2);
  settled = harness.loop.snapshot();
  const review = buildSessionKernelReviewV2(
    settled,
    '2026-07-29T00:04:01.000Z'
  );
  assert.equal(
    review.snapshotHighWater,
    harness.kernelState.snapshotHighWater
  );
}

function appendMutationCompletion(
  harness,
  plan,
  result,
  attemptId,
  label
) {
  const effectId = `effect-${label}`;
  const observed = corpusFact('effectToolObserved', {
    factId: `fact-${label}-observed`,
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: harness.initial.runId,
      planRevision: plan.planRevision,
      planActionId: plan.actions[0].manifest.planActionId,
      operationId: result.operationId,
      invocationId: result.invocationId,
      attemptId,
      effectId,
    },
  });
  const completed = corpusFact('invocationToolCompleted', {
    factId: `fact-${label}-completed`,
    ledgerSequence: harness.nextFactSequence() + 1,
    runSequence: harness.nextRunSequence() + 1,
    identities: {
      runId: harness.initial.runId,
      planRevision: plan.planRevision,
      planActionId: plan.actions[0].manifest.planActionId,
      operationId: result.operationId,
      invocationId: result.invocationId,
      attemptId,
      effectId,
      observedFactId: observed.factId,
    },
  });
  harness.appendFacts(observed, completed);
  return completed;
}

async function latestRunDrivesLiveProjectionWithoutTruncatingHistory() {
  const sessionId = 'session-latest-run-projection';
  const events = [
    agentEvent(sessionId, 'event-a-user', 'user_msg', 'run-a', {
      inputId: 'input-a',
      text: 'old run input',
      attachments: [],
    }, 0),
    agentEvent(sessionId, 'event-a-plan', 'plan_card', 'run-a', {
      planId: 'plan-a',
      title: 'Old plan',
      tasks: [{
        taskId: 'task-a',
        toolId: 'fs.read',
        operationId: 'operation-a',
      }],
    }, 1),
    agentEvent(
      sessionId,
      'event-a-permission',
      'permission_request',
      'run-a',
      {
        permissionId: 'permission-a',
        toolId: 'fs.read',
        toolName: 'Old read',
      },
      2
    ),
    agentEvent(sessionId, 'event-a-error', 'error', 'run-a', {
      status: 'failed',
      message: 'old run failed',
    }, 3),
    agentEvent(sessionId, 'event-b-user', 'user_msg', 'run-b', {
      inputId: 'input-b',
      text: 'current run input',
      attachments: [],
    }, 4),
    agentEvent(sessionId, 'event-b-plan', 'plan_card', 'run-b', {
      planId: 'plan-b',
      title: 'Current plan',
      confirmable: false,
      tasks: [{
        taskId: 'task-b',
        toolId: 'fs.write',
        operationId: 'operation-b',
      }],
    }, 5),
    agentEvent(
      sessionId,
      'event-b-permission',
      'permission_request',
      'run-b',
      {
        permissionId: 'permission-b',
        toolId: 'fs.write',
        toolName: 'Current write',
      },
      6
    ),
    agentEvent(
      sessionId,
      'event-b-waiting',
      'session_run_state',
      'run-b',
      {
        status: 'waiting',
        reason: 'scopeExpansion',
        targetId: 'permission-b',
      },
      7
    ),
  ];
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events,
    generatedAt: '2026-07-29T00:05:00.000Z',
  });

  assert.equal(projection.revision, events.length);
  assert.equal(projection.sourceEventVersion, events.length);
  assert.equal(projection.eventCount, events.length);
  assert.equal(projection.turns.length, 2);
  assert.equal(
    projection.turns.some((turn) =>
      turn.blocks.some((block) => block.id === 'event:event-a-user')
    ),
    true,
    'full Run A history must remain visible'
  );
  assert.deepEqual(
    projection.taskProjection.items.map((item) => item.id),
    ['task-b']
  );
  assert.equal(
    projection.interactionProjection.pending.requestId,
    'permission-b'
  );
  assert.equal(projection.runProjection.runId, 'run-b');
  assert.equal(projection.runProjection.status, 'waitingUser');
  assert.equal(projection.runProjection.wait.interactionId, 'permission-b');
  assert.equal(
    findLatestPendingPermission(events).request.id,
    'permission-b'
  );
}

async function recoverableBlockedErrorDoesNotFailLatestRun() {
  const sessionId = 'session-blocked-error-projection';
  const events = [
    agentEvent(sessionId, 'event-blocked-user', 'user_msg', 'run-current', {
      inputId: 'input-current',
      text: 'current input',
      attachments: [],
    }, 0),
    agentEvent(sessionId, 'event-blocked-error', 'error', 'run-current', {
      status: 'blocked',
      code: 'session_kernel_provider_tool_calls_aborted',
      message: 'Replanning is required.',
    }, 1),
  ];
  const recoverable = buildNarrativeTimelineProjection({
    sessionId,
    events,
  });
  assert.equal(recoverable.runProjection.runId, 'run-current');
  assert.equal(recoverable.runProjection.status, 'active');
  assert.notEqual(recoverable.runProjection.phase, 'settled');
  assert.equal(recoverable.turns[0].status, 'running');
  assert.equal(
    recoverable.turns[0].blocks.find(
      (block) => block.id === 'event:event-blocked-error'
    )?.status,
    'blocked'
  );

  const failed = buildNarrativeTimelineProjection({
    sessionId,
    events: [
      ...events,
      agentEvent(
        sessionId,
        'event-terminal-error',
        'error',
        'run-current',
        {
          status: 'failed',
          code: 'provider.requestTurn',
          message: 'Terminal Provider failure.',
        },
        2
      ),
    ],
  });
  assert.equal(failed.runProjection.status, 'failed');
  assert.equal(failed.turns[0].status, 'failed');
}

function agentEvent(
  sessionId,
  id,
  kind,
  runId,
  payload,
  second
) {
  return {
    id,
    sessionId,
    ts: new Date(
      Date.parse('2026-07-29T00:05:00.000Z') + second * 1_000
    ).toISOString(),
    kind,
    payload: {
      runId,
      ...payload,
    },
  };
}

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
    remainingToolCallBudget: 32,
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
  assert.equal(loopSecond.revision, loopFirst.revision + 2);
  assert.equal(
    loopSecond.snapshotHighWater,
    harness.kernelState.snapshotHighWater,
    'finalizeReview must reconcile late facts before reusing a final Review'
  );
  assert.equal(loopSecond.cleanup.length, 1);
  assert.deepEqual(
    harness.store.projectionEvents
      .filter((event) =>
        event.kind === 'review.revised'
        && event.data.snapshotHighWater === loopSecond.snapshotHighWater
        && event.data.revision > loopFirst.revision
      )
      .map((event) => ({
        revision: event.data.revision,
        status: event.data.status,
        snapshotHighWater: event.data.snapshotHighWater,
      })),
    [
      {
        revision: loopFirst.revision + 1,
        status: 'draft',
        snapshotHighWater: loopSecond.snapshotHighWater,
      },
      {
        revision: loopFirst.revision + 2,
        status: 'final',
        snapshotHighWater: loopSecond.snapshotHighWater,
      },
    ],
    'late facts must persist distinct draft and final Review revisions at one high-water'
  );
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

async function draftReviewStaysPrivateAndFinalReviewProjectsOnce() {
  const sessionId = 'session-review-publication-contract';
  const runId = RUN_ID;
  const state = acceptedPlanState();
  const draft = buildSessionKernelReviewV2(
    state,
    '2026-07-29T00:50:00.000Z'
  );
  assert.equal(draft.status, 'draft');
  assert.throws(
    () => reviewProjectionEvent(
      sessionId,
      runId,
      1,
      draft
    ),
    (error) =>
      error?.code === 'session_kernel_projection_data_invalid',
    'a draft Review is durable Session state but not a public conversation event'
  );

  const final = finalizeSessionKernelReviewV2(
    state,
    '2026-07-29T00:50:01.000Z'
  );
  assert.equal(final.status, 'final');
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events: [
      agentEvent(
        sessionId,
        'event-review-publication-user',
        'user_msg',
        runId,
        {
          inputId: 'input-review-publication',
          text: 'Finish the reviewed batch.',
          attachments: [],
        },
        0
      ),
      reviewProjectionEvent(sessionId, runId, 2, final),
      reviewProjectionEvent(sessionId, runId, 3, final),
    ],
  });
  const reviewBlocks = projection.turns.flatMap((turn) =>
    turn.blocks.filter((block) => block.kind === 'review')
  );
  assert.equal(
    reviewBlocks.length,
    1,
    'replaying the same final Review revision must update one logical block rather than append duplicates'
  );
  assert.equal(reviewBlocks[0].structuredProjection.kind, 'review');
  assert.equal(
    projection.turns.flatMap((turn) => turn.parts).filter(
      (part) => part.kind === 'block'
        && part.blockId === reviewBlocks[0].id
    ).length,
    1
  );
}

async function readableReviewKeepsRawIdentitiesOnlyInAuditRefs() {
  const sessionId = 'session-readable-review-contract';
  const plan = createPlan();
  let state = acceptedPlanState(plan);
  state.planActionSettlements[plan.actions[0].manifest.planActionId] = {
    kind: 'completed',
    planActionId: plan.actions[0].manifest.planActionId,
    completionKind: 'answer',
    providerTurnId: 'provider-turn-readable-review',
    recordedAt: '2026-07-29T00:51:00.000Z',
  };
  const rawIds = {
    factId: 'fact-readable-review-effect',
    invocationId: 'invocation-readable-review',
    effectId: 'effect-readable-review',
    operationId: plan.actions[0].manifest.operationId,
    planActionId: plan.actions[0].manifest.planActionId,
    resourceId: 'resource-readable-review',
  };
  state = reconcileSessionKernelFactsPageV2(
    state,
    createFactsPage([
      corpusFact('effectExpandedToolObserved', {
        factId: rawIds.factId,
        ledgerSequence: 1,
        runSequence: 1,
        identities: {
          runId: RUN_ID,
          planRevision: plan.planRevision,
          planActionId: rawIds.planActionId,
          expandedOperationId: rawIds.operationId,
          expandedInvocationId: rawIds.invocationId,
          expandedAttemptId: 'attempt-readable-review',
          expandedEffectId: rawIds.effectId,
          expandedResourceId: rawIds.resourceId,
        },
      }),
    ], {
      requestedAfterLedgerSequence: 0,
      snapshotHighWater: 1,
    })
  ).state;
  const review = finalizeSessionKernelReviewV2(
    state,
    '2026-07-29T00:51:01.000Z'
  );
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events: [
      agentEvent(
        sessionId,
        'event-readable-review-user',
        'user_msg',
        RUN_ID,
        {
          inputId: 'input-readable-review',
          text: 'Show the readable Review.',
          attachments: [],
        },
        0
      ),
      reviewProjectionEvent(sessionId, RUN_ID, 1, review),
    ],
  });
  const block = projection.turns[0].blocks.find(
    (candidate) => candidate.kind === 'review'
  );
  assert.ok(block?.structuredProjection);
  const readable = block.structuredProjection;
  assert.deepEqual(readable.messageArgs, {
    planned: String(review.planned.length),
    effects: String(review.actualEffects.length),
    unexecuted: String(review.unexecuted.length),
    rejected: String(review.denied.length + review.rejections.length),
    cleanup: String(review.cleanup.length),
    indeterminate: String(review.indeterminate.length),
  });
  const categoryNames = [
    'scopeExpansions',
    'actualEffects',
    'unexecuted',
    'denied',
    'rejections',
    'cleanup',
    'indeterminate',
  ];
  assert.deepEqual(
    readable.sections.map((section) => section.sectionId),
    categoryNames.filter((name) => review[name].length > 0),
    'empty Review categories must be omitted from the readable projection'
  );
  const readableSurface = {
    title: readable.title,
    summary: readable.summary,
    summaryKey: readable.summaryKey,
    messageArgs: readable.messageArgs,
    sections: readable.sections.map((section) => ({
      sectionId: section.sectionId,
      titleKey: section.titleKey,
      titleArgs: section.titleArgs,
      emptyMessageKey: section.emptyMessageKey,
      items: section.items.map((item) => ({
        kind: item.kind,
        text: item.text,
        messageKey: item.messageKey,
        messageArgs: item.messageArgs,
        status: item.status,
        targetRefs: item.targetRefs,
      })),
    })),
  };
  const readableJson = JSON.stringify(readableSurface);
  for (const rawId of Object.values(rawIds)) {
    assert.equal(
      readableJson.includes(rawId),
      false,
      `raw identity ${rawId} must not enter readable Review text or message arguments`
    );
  }
  const auditRefs = readable.sections.flatMap((section) =>
    section.items.flatMap((item) => item.auditRefs ?? [])
  );
  for (const rawId of Object.values(rawIds)) {
    assert.equal(
      auditRefs.includes(rawId),
      true,
      `raw identity ${rawId} must remain available through auditRefs`
    );
  }
}

function reviewProjectionEvent(sessionId, runId, sequence, review) {
  return sessionKernelAgentEventV2(sessionId, {
    projectionId: `review-projection-${sequence}-${review.revision}`,
    runId,
    recordedAt: new Date(
      Date.parse('2026-07-29T00:52:00.000Z') + sequence * 1_000
    ).toISOString(),
    kind: 'review.revised',
    data: review,
  });
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
