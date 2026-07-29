import {
  SessionKernelPortError,
  canonicalJson,
  createSessionKernelLoopStateV2,
  reconcileSessionKernelFactsPageV2,
  restoreSessionKernelLoopStateV2,
  sha256Hash,
} from '../../dist/index.js';

import {
  admittedReply,
  assert,
  awaitingCapabilityReply,
  createFactsPage,
  createCorpusToolContext,
  createExpandedPreview,
  createInitialState,
  createPlan,
  createSessionHarness,
  corpusFact,
  openSessionHarness,
  persistPreviewAndAcceptPlan,
  providerAnswer,
  providerToolIntent,
  toolContextRef,
} from './harness.mjs';

export const contractCases = [
  {
    id: 'unknown_effect_outcome_replays_the_exact_identity_after_restart',
    run: unknownEffectOutcomeReplaysTheExactIdentityAfterRestart,
  },
  {
    id: 'restart_rebuilds_session_state_from_canonical_facts',
    run: restartRebuildsSessionStateFromCanonicalFacts,
  },
  {
    id: 'indeterminate_mutation_requires_manual_recovery_without_retry',
    run: indeterminateMutationRequiresManualRecoveryWithoutRetry,
  },
  {
    id: 'context_invalidation_refreshes_once_at_the_next_provider_boundary',
    run: contextInvalidationRefreshesOnceAtTheNextProviderBoundary,
  },
  {
    id: 'capability_allow_continues_the_same_invocation_with_a_new_lease',
    run: capabilityAllowContinuesSameInvocationWithNewLease,
  },
  {
    id: 'capability_deny_guides_next_turn_without_session_manufactured_effect',
    run: capabilityDenyGuidesNextTurnWithoutSessionManufacturedEffect,
  },
  {
    id: 'fact_reconciliation_follows_multi_page_continuation',
    run: factReconciliationFollowsMultiPageContinuation,
  },
  {
    id: 'empty_global_sequence_gap_advances_the_facts_cursor',
    run: emptyGlobalSequenceGapAdvancesTheFactsCursor,
  },
  {
    id: 'unsupported_checkpoint_schema_fails_closed',
    run: unsupportedCheckpointSchemaFailsClosed,
  },
];

async function unknownEffectOutcomeReplaysTheExactIdentityAfterRestart() {
  const first = await openSessionHarness();
  first.enqueueProvider(
    providerToolIntent(
      'fs.read',
      { path: 'README.md' },
      'provider-call-unknown-outcome'
    )
  );
  first.enqueueKernel(
    'submitToolIntent',
    new SessionKernelPortError(
      'contract_transport_unknown',
      'transport closed after dispatch',
      'unknown'
    )
  );

  await assert.rejects(
    first.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    }),
    (error) =>
      error?.code === 'session_kernel_transport_outcome_unknown'
  );

  const firstSubmission = first.calls('submitToolIntent')[0];
  const pending = first.store.pendingRequests.get('effect');
  assert.ok(pending, 'unknown transport outcome must remain durable');
  assert.equal(pending.requestId, firstSubmission.requestId);
  assert.deepEqual(
    pending.intent.payload.intent,
    firstSubmission.intent
  );

  const restarted = createSessionHarness({
    initial: first.initial,
    store: first.store,
    kernelState: first.kernelState,
  });
  restarted.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(restarted, request, {
      invocationId: 'invocation-replayed-after-restart',
      attemptId: 'attempt-replayed-after-restart',
    })
  );
  await restarted.open();

  const replay = restarted.calls('submitToolIntent')[0];
  assert.equal(replay.requestId, firstSubmission.requestId);
  assert.deepEqual(
    replay.intent,
    firstSubmission.intent,
    'recovery may only replay the exact persisted request payload'
  );
  assert.equal(
    first.store.pendingRequests.has('effect'),
    false,
    'a confirmed replay outcome must settle the durable effect lane'
  );
  assert.equal(
    restarted.loop.snapshot().activeWait?.invocationId,
    'invocation-replayed-after-restart'
  );
}

async function restartRebuildsSessionStateFromCanonicalFacts() {
  const first = await openSessionHarness({
    initial: { runId: 'run-1' },
  });
  const plan = createPlan({
    runId: 'run-1',
    planRevision: 'plan-revision-golden-1',
    planActionId: 'plan-action-golden-1',
    operationId: 'planned-operation-golden-output',
  });
  await persistPreviewAndAcceptPlan(first, plan);
  const admitted = corpusFact('invocationToolIntentAdmitted', {
    factId: 'fact-admitted-before-restart',
    ledgerSequence: 6,
    runSequence: 1,
    identities: {
      runId: first.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      operationId: 'operation-restart',
      invocationId: 'invocation-restart',
      attemptId: 'attempt-restart',
    },
  });
  const observed = corpusFact('effectToolObserved', {
    factId: 'fact-observed-before-restart',
    ledgerSequence: 7,
    runSequence: 2,
    identities: {
      runId: first.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      operationId: 'operation-restart',
      invocationId: 'invocation-restart',
      attemptId: 'attempt-restart',
      effectId: 'effect-restart',
      resourceId: 'resource-output',
    },
  });
  first.appendFacts(admitted, observed);
  await first.loop.reconcileFacts(0);
  assert.ok(
    first.loop.snapshot().factsById['fact-observed-before-restart']
  );
  assert.deepEqual(
    first.store.checkpoint.state.factsById,
    {},
    'checkpoint stores orchestration identity, not a second fact authority'
  );

  const restarted = createSessionHarness({
    initial: first.initial,
    store: first.store,
    kernelState: first.kernelState,
  });
  await restarted.open();

  const restored = restarted.loop.snapshot();
  assert.deepEqual(
    restored.factsById['fact-observed-before-restart'],
    observed
  );
  assert.equal(restored.lineage.cursor.snapshotHighWater, 7);
  assert.equal(
    restored.lineage.planActions[
      'plan-action-golden-1'
    ].operationIds.includes('operation-restart'),
    true,
    'facts replay must restore the dynamic operation under its PlanAction'
  );
  const replayedLease =
    admitted.lineage.capabilityLease;
  assert.deepEqual(
    restored.lineage.operations['operation-restart'].leases,
    [replayedLease],
    'facts replay must retain the Kernel-issued lease reference'
  );
  assert.ok(
    restarted.calls('queryFacts').some(
      (request) => request.afterLedgerSequence === 0
    ),
    'restart must rebuild from the run-scoped canonical facts cursor'
  );

  restarted.enqueueProvider(providerToolIntent(
    'fs.write',
    { path: 'output.txt', content: 'contract output' },
    'provider-call-restart-reuse'
  ));
  restarted.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(restarted, request, {
      invocationId: 'invocation-restart-reuse',
      attemptId: 'attempt-restart-reuse',
    })
  );
  await restarted.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
  });
  assert.deepEqual(
    restarted.calls('submitToolIntent').at(-1).intent.authority.data.lease,
    replayedLease,
    'the restored PlanAction must reuse the facts-derived lease'
  );
}

async function indeterminateMutationRequiresManualRecoveryWithoutRetry() {
  const harness = await openSessionHarness({
    initial: { runId: 'run-1' },
  });
  const plan = createPlan({
    runId: 'run-1',
    planRevision: 'plan-revision-golden-1',
    planActionId: 'plan-action-golden-1',
    operationId: 'planned-operation-golden-output',
  });
  await persistPreviewAndAcceptPlan(harness, plan);
  harness.enqueueProvider(
    providerToolIntent(
      'fs.write',
      { path: 'output.txt', content: 'contract output' },
      'provider-call-indeterminate'
    )
  );
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-indeterminate',
      attemptId: 'attempt-indeterminate',
    })
  );
  const admitted = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
  });
  assert.equal(admitted.kind, 'admitted');

  harness.appendFacts(corpusFact('invocationToolIndeterminate', {
    factId: 'fact-indeterminate',
    ledgerSequence: 11,
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: harness.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      indeterminateOperationId: admitted.operationId,
      indeterminateInvocationId: admitted.invocationId,
      indeterminateAttemptId: 'attempt-indeterminate',
      indeterminateEffectId: 'effect-indeterminate',
    },
  }));
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: admitted.operationId,
    invocationId: admitted.invocationId,
    planActionId: 'plan-action-golden-1',
    expectedPlanRevision: 'plan-revision-golden-1',
  });

  const wait = harness.loop.snapshot().activeWait;
  assert.deepEqual(wait, {
    kind: 'manualRecovery',
    operationId: admitted.operationId,
    invocationId: admitted.invocationId,
    reason: 'indeterminate',
    factIds: ['fact-indeterminate'],
  });
  const submissionCount =
    harness.calls('submitToolIntent').length;
  await assert.rejects(
    harness.loop.runProviderTurn({
      reason: 'recovery',
      target: {
        kind: 'planAction',
        planActionId: 'plan-action-golden-1',
      },
    }),
    (error) => error?.code === 'session_kernel_active_wait'
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    submissionCount,
    'indeterminate mutation must never be resubmitted automatically'
  );
}

async function contextInvalidationRefreshesOnceAtTheNextProviderBoundary() {
  const harness = await openSessionHarness();
  const invalidation = corpusFact('authorizationContextInvalidated', {
    factId: 'fact-context-invalidated',
    ledgerSequence: 5,
    runSequence: 1,
    identities: { runId: harness.initial.runId },
  });
  const previousContextRef = invalidation.details.previousContext;
  const nextContextRef = invalidation.details.nextContextRef;
  const updated = createCorpusToolContext();
  assert.deepEqual(
    toolContextRef(harness.initial.toolContext),
    previousContextRef
  );
  assert.equal(invalidation.details.reason, 'toolRevoked');
  assert.equal(invalidation.details.toolId, 'fs.write');
  assert.equal(invalidation.details.availability, 'revoked');
  assert.deepEqual(
    toolContextRef(updated),
    nextContextRef
  );
  harness.appendFacts(invalidation);
  await harness.loop.reconcileFacts(0);

  assert.equal(harness.loop.snapshot().toolContext.refreshRequired, true);
  assert.equal(
    harness.calls('getToolContext').length,
    0,
    'Session must not poll ToolContext while no Provider boundary exists'
  );

  harness.setToolContext(updated);
  harness.enqueueKernel('getToolContext', {
    kind: 'updated',
    data: { toolContext: updated },
  });
  const originalDescription = updated.tools[0].description;
  harness.enqueueProvider((input) => {
    input.toolContext.tools[0].description =
      'provider-local descriptor mutation';
    return providerAnswer('refreshed-context answer');
  });
  await harness.loop.runProviderTurn({
    reason: 'recovery',
    target: { kind: 'planning' },
  });

  assert.equal(harness.calls('getToolContext').length, 1);
  assert.deepEqual(
    harness.calls('getToolContext')[0].knownContext,
    previousContextRef
  );
  assert.deepEqual(
    toolContextRef(harness.providerInputs.at(-1).toolContext.bundle),
    nextContextRef
  );
  assert.deepEqual(
    harness.providerInputs.at(-1).toolContext.bundle.tools.map(
      (tool) => tool.toolId
    ),
    ['fs.read']
  );
  assert.equal(
    harness.loop.snapshot().toolContext.bundle.tools[0].description,
    originalDescription,
    'Provider-local ToolContext mutation must not alias Session live state'
  );
  assert.equal(
    harness.loop.snapshot().toolContext.refreshRequired,
    false
  );

  harness.enqueueProvider(providerAnswer('second provider boundary'));
  await harness.loop.runProviderTurn({
    reason: 'recovery',
    target: { kind: 'planning' },
  });
  assert.equal(
    harness.calls('getToolContext').length,
    1,
    'a consumed canonical invalidation must refresh exactly once'
  );

  const forgedCatalogDigest = `sha256:${'e'.repeat(64)}`;
  for (const field of ['previousContext', 'nextContextRef']) {
    const rejected = await openSessionHarness();
    const forgedInvalidation = corpusFact(
      'authorizationContextInvalidated',
      {
        factId: `fact-context-invalidated-forged-${field}`,
        ledgerSequence: 5,
        runSequence: 1,
        identities: { runId: rejected.initial.runId },
      }
    );
    forgedInvalidation.details[field].catalogDigest =
      forgedCatalogDigest;
    rejected.appendFacts(forgedInvalidation);
    await assert.rejects(
      rejected.loop.reconcileFacts(0),
      (error) =>
        error?.code
          === 'kernel_tool_context_invalidation_catalog_mismatch',
      `forged invalidation ${field} catalog`
    );
  }

  const mismatchedExpanded = JSON.parse(JSON.stringify(
    harness.initial.toolContext
  ));
  Object.assign(mismatchedExpanded, nextContextRef);
  const changedDescriptor = JSON.parse(JSON.stringify(updated));
  changedDescriptor.tools[0].description =
    'rewritten descriptor from an invalid updated context';
  const changedCatalog = withToolContextCatalog(
    updated,
    forgedCatalogDigest
  );
  const rejectedReplies = [
    {
      id: 'old-current',
      label: 'old current',
      code: 'kernel_tool_context_refresh_current_conflict',
      reply: {
        kind: 'current',
        data: { contextRef: previousContextRef },
      },
    },
    {
      id: 'mismatched-updated',
      label: 'mismatched updated reference',
      code: 'kernel_tool_context_updated_ref_mismatch',
      reply: {
        kind: 'updated',
        data: { toolContext: harness.initial.toolContext },
      },
    },
    {
      id: 'runtime-expansion',
      label: 'runtime expansion with a forged expected reference',
      code: 'kernel_tool_context_digest_mismatch',
      reply: {
        kind: 'updated',
        data: { toolContext: mismatchedExpanded },
      },
    },
    {
      id: 'rewritten-descriptor',
      label: 'rewritten retained descriptor',
      code: 'kernel_tool_context_contract_digest_mismatch',
      reply: {
        kind: 'updated',
        data: { toolContext: changedDescriptor },
      },
    },
    {
      id: 'changed-catalog',
      label: 'self-consistent updated bundle from another catalog',
      code: 'kernel_tool_context_updated_catalog_mismatch',
      reply: {
        kind: 'updated',
        data: { toolContext: changedCatalog },
      },
    },
  ];
  for (const scenario of rejectedReplies) {
    const rejected = await openSessionHarness();
    const rejectedInvalidation = corpusFact(
      'authorizationContextInvalidated',
      {
        factId: `fact-context-invalidated-${scenario.id}`,
        ledgerSequence: 5,
        runSequence: 1,
        identities: { runId: rejected.initial.runId },
      }
    );
    rejected.appendFacts(rejectedInvalidation);
    await rejected.loop.reconcileFacts(0);
    rejected.enqueueKernel('getToolContext', scenario.reply);
    rejected.enqueueProvider(providerAnswer('must not reach Provider'));
    await assert.rejects(
      rejected.loop.runProviderTurn({
        reason: 'recovery',
        target: { kind: 'planning' },
      }),
      (error) => error?.code === scenario.code,
      scenario.label
    );
    assert.equal(
      rejected.providerInputs.length,
      0,
      `${scenario.label} must fail before Provider exposure`
    );
    assert.equal(
      rejected.loop.snapshot().toolContext.refreshRequired,
      true
    );
    assert.deepEqual(
      rejected.loop.snapshot().toolContext.expectedContextRef,
      rejectedInvalidation.details.nextContextRef
    );
  }
}

function withToolContextCatalog(toolContext, catalogDigest) {
  const forged = JSON.parse(JSON.stringify(toolContext));
  forged.catalogDigest = catalogDigest;
  forged.contextDigest = sha256Hash(
    `deepcode.kernel.tool-context.v2/bundle\0${canonicalJson({
      formatVersion: forged.formatVersion,
      contextVersion: forged.contextVersion,
      catalogDigest: forged.catalogDigest,
      fixedPrompt: forged.fixedPrompt,
      tools: forged.tools.map((tool) => ({
        toolId: tool.toolId,
        contractDigest: tool.contractDigest,
      })),
    })}`
  );
  return forged;
}

async function capabilityAllowContinuesSameInvocationWithNewLease() {
  const harness = await openSessionHarness({
    initial: { runId: 'run-1' },
  });
  const plan = createPlan({
    runId: 'run-1',
    planRevision: 'plan-revision-golden-1',
    planActionId: 'plan-action-golden-1',
    operationId: 'planned-operation-golden-output',
  });
  await persistPreviewAndAcceptPlan(harness, plan);
  const issued = corpusFact('authorizationCapabilityIssued', {
    factId: 'fact-capability-issued-before-expansion',
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
  });
  const expandedLease = corpusFact(
    'authorizationExpansionAllowed'
  ).lineage.capabilityLease;
  harness.appendFacts(issued);
  await harness.loop.reconcileFacts(0);

  harness.enqueueProvider(providerToolIntent(
    'fs.write',
    { path: 'expanded.txt', content: 'expanded' },
    'provider-call-expand-allow'
  ));
  harness.enqueueKernel('submitToolIntent', (request) =>
    awaitingCapabilityReply(
      harness,
      request,
      createExpandedPreview(request, 'allow'),
      { invocationId: 'invocation-golden-expanded-1' }
    ));
  const waiting = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
  });
  assert.equal(waiting.kind, 'awaitingCapability');
  assert.deepEqual(harness.loop.snapshot().activeWait, {
    kind: 'capability',
    operationId: waiting.operationId,
    invocationId: waiting.invocationId,
    previewId: 'preview-golden-expanded-allow-1',
    sinceHighWater: harness.kernelState.snapshotHighWater,
  });

  const allowed = corpusFact('authorizationExpansionAllowed', {
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
  });
  const continued = corpusFact('invocationExpandedToolIntentAdmitted', {
    ledgerSequence: harness.nextFactSequence() + 1,
    runSequence: harness.nextRunSequence() + 1,
  });
  harness.appendFacts(allowed, continued);
  assert.equal(
    'invocationId' in allowed.lineage,
    false,
    'ExpansionAllowed authorizes scope but does not impersonate admission'
  );
  assert.equal(
    continued.lineage.invocationId,
    waiting.invocationId
  );
  assert.equal(
    continued.lineage.attemptId,
    'attempt-golden-expanded-2'
  );
  assert.deepEqual(
    continued.lineage.capabilityLease,
    expandedLease
  );
  await harness.loop.observeCapabilityDecision({
    decision: 'allow',
    previewId: 'preview-golden-expanded-allow-1',
    operationId: waiting.operationId,
    invocationId: waiting.invocationId,
    planActionId: 'plan-action-golden-1',
    expectedPlanRevision: 'plan-revision-golden-1',
  });

  assert.deepEqual(harness.loop.snapshot().activeWait, {
    kind: 'invocation',
    operationId: waiting.operationId,
    invocationId: waiting.invocationId,
    sinceHighWater: allowed.ledgerSequence,
  });
  assert.deepEqual(
    harness.loop.snapshot().lineage.operations[
      waiting.operationId
    ].leases,
    [expandedLease]
  );
  assert.equal(harness.calls('submitToolIntent').length, 1);

  const observed = corpusFact('effectExpandedToolObserved', {
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
  });
  const completed = corpusFact('invocationExpandedToolCompleted', {
    factId: 'fact-expanded-invocation-completed',
    ledgerSequence: harness.nextFactSequence() + 1,
    runSequence: harness.nextRunSequence() + 1,
    identities: {
      expandedObservedFactId: observed.factId,
    },
  });
  harness.appendFacts(observed, completed);
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: waiting.operationId,
    invocationId: waiting.invocationId,
    planActionId: 'plan-action-golden-1',
    expectedPlanRevision: 'plan-revision-golden-1',
  });
  assert.equal(harness.loop.snapshot().activeWait, undefined);

  const observedBeforeSupersession =
    harness.loop.snapshot().lineage.cursor.snapshotHighWater;
  const superseded = corpusFact(
    'authorizationLeaseSuperseded',
    {
      ledgerSequence: harness.nextFactSequence(),
      runSequence: harness.nextRunSequence(),
    }
  );
  assert.deepEqual(
    superseded.lineage.capabilityLease,
    expandedLease
  );
  harness.appendFacts(superseded);
  await harness.loop.reconcileFacts(observedBeforeSupersession);
  assert.deepEqual(
    Object.values(harness.loop.snapshot().lineage.operations)
      .flatMap((operation) => operation.leases),
    [],
    'lease supersession must remove every old copy through the superseded version'
  );
}

async function capabilityDenyGuidesNextTurnWithoutSessionManufacturedEffect() {
  const harness = await openSessionHarness({
    initial: { runId: 'run-1' },
  });
  const plan = createPlan({
    runId: 'run-1',
    planRevision: 'plan-revision-golden-deny-1',
    planActionId: 'plan-action-golden-deny-1',
    operationId: 'planned-operation-golden-deny-output',
  });
  await persistPreviewAndAcceptPlan(harness, plan);
  const issued = corpusFact('authorizationCapabilityIssuedDeny', {
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
  });
  harness.appendFacts(issued);
  await harness.loop.reconcileFacts(0);
  const issuedLease = issued.lineage.capabilityLease;
  harness.enqueueProvider(providerToolIntent(
    'fs.write',
    { path: 'expanded.txt', content: 'expanded' },
    'provider-call-expand-deny'
  ));
  harness.enqueueKernel('submitToolIntent', (request) =>
    awaitingCapabilityReply(
      harness,
      request,
      createExpandedPreview(request, 'deny'),
      { invocationId: 'invocation-golden-expanded-deny-1' }
    ));
  const waiting = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-deny-1',
    },
  });
  assert.equal(harness.loop.snapshot().activeWait?.kind, 'capability');
  assert.deepEqual(
    harness.calls('submitToolIntent').at(-1).intent.authority.data.lease,
    issuedLease,
    'the denied expansion request must still carry the existing v1 lease'
  );
  const denied = corpusFact('authorizationExpansionDenied', {
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
  });
  const guidance = denied.details.guidance;
  const effectCountBefore =
    harness.kernelState.facts.filter(
      (fact) => fact.domain === 'effect'
    ).length;
  harness.appendFacts(denied);
  harness.enqueueProvider(providerAnswer('replanned after denial'));
  const resumed = await harness.loop.observeCapabilityDecision({
    decision: 'deny',
    previewId: 'preview-golden-expanded-deny-1',
    operationId: waiting.operationId,
    invocationId: waiting.invocationId,
    planActionId: 'plan-action-golden-deny-1',
    expectedPlanRevision: 'plan-revision-golden-deny-1',
    nextTurn: {
      reason: 'recovery',
      target: { kind: 'planning' },
    },
  });
  assert.deepEqual(resumed, {
    kind: 'answer',
    text: 'replanned after denial',
  });
  assert.deepEqual(harness.providerInputs.at(-1).guidance, [guidance]);
  assert.equal(harness.calls('submitToolIntent').length, 1);
  assert.equal(
    harness.kernelState.facts.filter(
      (fact) => fact.domain === 'effect'
    ).length,
    effectCountBefore,
    'Session reconciliation must not manufacture an effect'
  );
}

async function factReconciliationFollowsMultiPageContinuation() {
  const harness = createSessionHarness();
  const admission = corpusFact('invocationToolIntentAdmitted', {
    factId: 'fact-page-admitted',
    ledgerSequence: 1,
    runSequence: 1,
    identities: {
      runId: harness.initial.runId,
      operationId: 'operation-paged',
      invocationId: 'invocation-paged',
      attemptId: 'attempt-paged',
    },
  });
  const observed = corpusFact('effectToolObserved', {
    factId: 'fact-page-observed',
    ledgerSequence: 2,
    runSequence: 2,
    identities: {
      runId: harness.initial.runId,
      operationId: 'operation-paged',
      invocationId: 'invocation-paged',
      attemptId: 'attempt-paged',
      effectId: 'effect-paged',
      resourceId: 'resource-paged',
    },
  });
  const completed = corpusFact('invocationToolCompleted', {
    factId: 'fact-page-completed',
    ledgerSequence: 3,
    runSequence: 3,
    identities: {
      runId: harness.initial.runId,
      operationId: 'operation-paged',
      invocationId: 'invocation-paged',
      attemptId: 'attempt-paged',
      effectId: 'effect-paged',
      observedFactId: 'fact-page-observed',
    },
  });
  harness.enqueueKernel('queryFacts', createFactsPage(
    [admission, observed],
    {
      requestedAfterLedgerSequence: 0,
      snapshotHighWater: 3,
      hasMore: true,
      nextAfterLedgerSequence: 2,
      nextContinuation: 'facts-page-2',
    }
  ));
  harness.enqueueKernel('queryFacts', createFactsPage(
    [completed],
    {
      requestedAfterLedgerSequence: 2,
      snapshotHighWater: 3,
      hasMore: false,
      nextAfterLedgerSequence: 3,
    }
  ));
  await harness.open();

  assert.deepEqual(
    harness.calls('queryFacts').map((request) => ({
      afterLedgerSequence: request.afterLedgerSequence,
      continuation: request.continuation,
    })),
    [
      { afterLedgerSequence: 0, continuation: undefined },
      { afterLedgerSequence: 2, continuation: 'facts-page-2' },
    ]
  );
  assert.equal(harness.loop.snapshot().lineage.cursor.snapshotHighWater, 3);
  assert.ok(harness.loop.snapshot().factsById['fact-page-completed']);
}

async function emptyGlobalSequenceGapAdvancesTheFactsCursor() {
  const initial = createInitialState();
  const state = createSessionKernelLoopStateV2(initial);
  const page = createFactsPage([], {
    requestedAfterLedgerSequence: 0,
    snapshotHighWater: 19,
    hasMore: false,
  });
  assert.equal(
    page.nextAfterLedgerSequence,
    19,
    'an empty final page must still consume the advertised snapshot'
  );

  const reconciled = reconcileSessionKernelFactsPageV2(
    state,
    page
  );
  assert.equal(
    reconciled.state.lineage.cursor.afterLedgerSequence,
    19
  );
  assert.equal(reconciled.caughtUp, true);
}

async function unsupportedCheckpointSchemaFailsClosed() {
  const initial = createInitialState();
  assert.throws(
    () => restoreSessionKernelLoopStateV2(
      {
        schemaVersion: 'deepcode.session.kernel-checkpoint.v1',
        checkpointRevision: 1,
        savedAt: '2026-07-29T00:00:00.000Z',
        state: createSessionKernelLoopStateV2(initial),
      },
      {
        runId: initial.runId,
        workspaceBindingDigest: initial.workspaceBindingDigest,
        sessionMemory: initial.sessionMemory,
        providerProfile: initial.providerProfile,
      }
    ),
    (error) =>
      error?.code === 'session_kernel_checkpoint_schema_unsupported'
  );
}
