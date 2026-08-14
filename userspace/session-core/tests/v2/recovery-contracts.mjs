import {
  SessionKernelPortError,
  canonicalJson,
  createSessionKernelLoopStateV2,
  reconcileSessionKernelFactsPageV2,
  restoreSessionKernelLoopStateV2,
  sha256Hash,
} from '../../dist/index.js';

import {
  NOW,
  admittedReply,
  assert,
  checkpointFromStateV3,
  createFactsPage,
  createCorpusToolContext,
  createDurablePersistenceHarness,
  createDurableRecordV3,
  createInterventionCandidatePreviewBatch,
  createFailedProviderEvidence,
  createInitialState,
  createOutOfPlanDiscoveryPreviewBatch,
  createPlan,
  createPlanDiscoveryPreviewBatch,
  createSessionHarness,
  createToolContextSnapshotRecordV3,
  corpusFact,
  openSessionHarness,
  persistPreviewAndAcceptPlan,
  providerAnswer,
  providerIntervention,
  providerEvidenceRecordsV3,
  providerPlanActionComplete,
  providerToolIntent,
  providerToolIntents,
  toolContextRef,
} from './harness.mjs';

// These recovery contracts are supporting development evidence only. They
// validate exact durable identities and never replace real CLI/GUI/TUI acceptance.

export const contractCases = [
  {
    id: 'session_schema_accepts_only_current_v4_history',
    run: sessionSchemaAcceptsOnlyCurrentV4History,
  },
  {
    id: 'active_v4_compact_checkpoint_and_public_settlement_restore_only_committed_refs',
    run: activeV4CompactCheckpointAndPublicSettlementRestoreOnlyCommittedRefs,
  },
  {
    id: 'completed_and_noncompleted_provider_terminal_recovery_never_reissues_unresolved_request',
    run: completedAndNoncompletedProviderTerminalRecoveryNeverReissuesUnresolvedRequest,
  },
  {
    id: 'historical_tool_context_snapshot_recovers_outcomes_across_refresh',
    run: historicalToolContextSnapshotRecoversOutcomesAcrossRefresh,
  },
  {
    id: 'missing_or_conflicting_tool_context_snapshot_fails_closed_without_current_bundle_fallback',
    run: missingOrConflictingToolContextSnapshotFailsClosedWithoutCurrentBundleFallback,
  },
  {
    id: 'frozen_review_final_answer_binding_budget_and_stale_reconciliation',
    run: frozenReviewFinalAnswerBindingBudgetAndStaleReconciliation,
  },
  {
    id: 'unknown_effect_outcome_replays_the_exact_identity_after_restart',
    run: unknownEffectOutcomeReplaysTheExactIdentityAfterRestart,
  },
  {
    id: 'restart_rebuilds_session_state_from_canonical_facts',
    run: restartRebuildsSessionStateFromCanonicalFacts,
  },
  {
    id: 'restart_resumes_queue_without_replaying_completed_calls',
    run: restartResumesQueueWithoutReplayingCompletedCalls,
  },
  {
    id: 'corrupted_provider_tool_queue_checkpoint_fails_closed',
    run: corruptedProviderToolQueueCheckpointFailsClosed,
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
    id: 'out_of_plan_mutation_freezes_effect_and_publishes_one_consolidated_intervention',
    run: outOfPlanMutationFreezesEffectAndPublishesOneConsolidatedIntervention,
  },
  {
    id: 'intervention_revision_preserves_identity_and_rejection_requires_run_cancellation',
    run: interventionRevisionPreservesIdentityAndRejectionRequiresRunCancellation,
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

async function sessionSchemaAcceptsOnlyCurrentV4History() {
  const current = createDurablePersistenceHarness();
  assert.equal(
    await current.persistence.loadCheckpoint(
      current.initial.runId,
      recoveryAuthority(current.initial)
    ),
    undefined
  );
  for (const historySchema of [
    'deepcode.session.kernel-persistence.v3',
    'deepcode.session.kernel-persistence.v2',
    'deepcode.session.kernel-checkpoint.v2',
    'deepcode.session.kernel-persistence.v1',
  ]) {
    assert.throws(
      () => createDurablePersistenceHarness({ historySchema }),
      (error) =>
        error?.code === 'UnsupportedHistorySchema'
        && error.observedSchema === historySchema
    );
  }

  const invalidHeaderRecords = current.store.records.map((record) => {
    if (record.recordKind !== 'storeHeader') return clone(record);
    const invalid = clone(record);
    invalid.data.schemaVersion = 'deepcode.session.kernel-persistence.v2';
    return rehashDurableRecord(invalid);
  });
  const invalidHeader = createDurablePersistenceHarness({
    sessionId: current.sessionId,
    initial: current.initial,
    records: invalidHeaderRecords,
  });
  await assert.rejects(
    invalidHeader.persistence.loadCheckpoint(
      current.initial.runId,
      recoveryAuthority(current.initial)
    ),
    (error) => error?.code === 'UnsupportedHistorySchema'
  );
}

async function activeV4CompactCheckpointAndPublicSettlementRestoreOnlyCommittedRefs() {
  const durable = createDurablePersistenceHarness({
    sessionId: 'session-compact-settlement-contract',
  });
  const { initial, persistence, store } = durable;
  await persistence.persistInput(initial.initialInput);
  const request = {
    requestId: 'request-compact-settlement',
    lane: 'query',
    intent: {
      kind: 'toolContextGet',
      payload: { knownContext: toolContextRef(initial.toolContext) },
    },
    startedAt: NOW,
    attemptCount: 1,
  };
  await persistence.persistPublicRequest(request);
  const state = createSessionKernelLoopStateV2(initial);
  state.checkpointRevision = 1;
  const checkpoint = checkpointFromStateV3(state);
  const projection = {
    projectionId: 'projection-compact-settlement-input',
    runId: initial.runId,
    recordedAt: NOW,
    kind: 'input.persisted',
    data: {
      inputId: initial.initialInput.inputId,
      opaqueInputRef: initial.initialInput.opaqueInputRef,
      text: initial.initialInput.text,
      attachments: initial.initialInput.attachments,
      recordedAt: initial.initialInput.recordedAt,
      controlEpoch: initial.controlEpoch,
    },
  };
  await persistence.settlePublicRequest(
    request,
    sha256Hash(canonicalJson({ kind: 'currentToolContext' })),
    checkpoint,
    [projection]
  );

  const checkpointRecord = store.records.find(
    (record) => record.recordKind === 'checkpoint'
  );
  const settlementRecord = store.records.find(
    (record) => record.recordKind === 'publicRequestSettled'
  );
  assert(checkpointRecord);
  assert(settlementRecord);
  assert.equal(Object.hasOwn(checkpointRecord.data, 'state'), false);
  assert.deepEqual(checkpointRecord.data.commitScope, {
    kind: 'publicRequestSettlement',
    requestId: request.requestId,
    requestDigest: sha256Hash(canonicalJson({
      requestId: request.requestId,
      lane: request.lane,
      intent: request.intent,
    })),
    outcomeDigest: sha256Hash(canonicalJson({
      kind: 'currentToolContext',
    })),
  });
  assert.equal(
    containsObjectKey(checkpointRecord.data, 'providerOutcomes'),
    false
  );
  assert.equal(
    containsObjectKey(checkpointRecord.data, 'physicalRequestCount'),
    false
  );
  assert.equal(containsObjectKey(checkpointRecord.data, 'finalText'), false);
  assert.deepEqual(
    settlementRecord.data.checkpointRef,
    {
      recordId: checkpointRecord.recordId,
      recordDigest: checkpointRecord.recordDigest,
    }
  );
  assert.equal(settlementRecord.data.projectionRefs.length, 1);
  const projectionRecord = store.records.find(
    (record) => record.recordKind === 'projection'
  );
  assert(projectionRecord);
  assert.deepEqual(settlementRecord.data.projectionRefs, [{
    recordId: projectionRecord.recordId,
    recordDigest: projectionRecord.recordDigest,
  }]);

  const recovered = await persistence.loadCheckpoint(
    initial.runId,
    recoveryAuthority(initial)
  );
  assert.equal(recovered.checkpointRevision, 1);
  assert.equal(recovered.state.currentInputId, initial.initialInput.inputId);
  assert.deepEqual(
    await persistence.loadPendingPublicRequests(initial.runId),
    []
  );

  const withoutCommitMarker = createDurablePersistenceHarness({
    sessionId: durable.sessionId,
    initial,
    records: store.records.filter(
      (record) => record.recordKind !== 'publicRequestSettled'
    ),
  });
  assert.equal(
    await withoutCommitMarker.persistence.loadCheckpoint(
      initial.runId,
      recoveryAuthority(initial)
    ),
    undefined,
    'orphan settlement checkpoint refs must not become committed state'
  );
}

async function completedAndNoncompletedProviderTerminalRecoveryNeverReissuesUnresolvedRequest() {
  const completed = await createCompletedProviderDurableHistory(
    'session-completed-terminal-recovery'
  );
  const beforeCompletedRecovery = completed.store.records.length;
  const restoredCompleted = await completed.persistence.loadCheckpoint(
    completed.initial.runId,
    recoveryAuthority(completed.initial)
  );
  assert.equal(restoredCompleted.state.providerOutcomes.length, 1);
  assert.equal(
    restoredCompleted.state.providerOutcomes[0].summary,
    'durably recovered answer'
  );
  assert.equal(
    completed.store.records.length,
    beforeCompletedRecovery,
    'completed terminal recovery must be read-only and never reissue Provider'
  );

  const completedTool = await createCompletedToolProviderDurableHistory(
    'session-completed-tool-terminal-recovery'
  );
  const restartedTool = createSessionHarness({
    initial: completedTool.initial,
    kernelState: completedTool.live.kernelState,
  });
  restartedTool.ports.persistence = completedTool.persistence;
  await restartedTool.open();
  assert.equal(restartedTool.loop.snapshot().plan.planRevision,
    'plan-revision-1');
  assert.equal(restartedTool.loop.snapshot().providerToolCallQueue.status,
    'completed');
  assert.equal(restartedTool.loop.snapshot().providerOutcomes[0].outputKind,
    'toolIntent');
  assert.equal(restartedTool.store.providerRequestCount, 0);
  assert.equal(restartedTool.calls('submitToolIntent').length, 0);

  for (const terminal of [
    {
      terminalKind: 'failed',
      reasonCode: 'provider_permanent_no_mutation',
      expectedStatus: 'failed',
    },
    {
      terminalKind: 'cancelled',
      reasonCode: 'provider_cancelled',
      expectedStatus: 'cancelled',
    },
    {
      terminalKind: 'limitExceeded',
      reasonCode: 'provider_trace_raw_limit_exceeded',
      expectedStatus: 'failed',
    },
  ]) {
    const noncompleted = await createNoncompletedProviderHistory(terminal);
    const restarted = createSessionHarness({ initial: noncompleted.initial });
    restarted.ports.persistence = noncompleted.persistence;
    await restarted.open();
    assert.equal(
      restarted.loop.snapshot().providerTurn.status,
      terminal.expectedStatus
    );
    assert.equal(restarted.loop.snapshot().providerOutcomes.length, 0);
    assert.equal(restarted.store.providerRequestCount, 0);
    assert.equal(restarted.calls('submitToolIntent').length, 0);
  }

  const unresolved = await createUnresolvedProviderHistory();
  const restartedUnresolved = createSessionHarness({
    initial: unresolved.initial,
  });
  restartedUnresolved.ports.persistence = unresolved.persistence;
  await assert.rejects(
    restartedUnresolved.open(),
    (error) =>
      error?.code === 'session_kernel_provider_dispatch_unresolved'
  );
  assert.equal(
    unresolved.store.appended.length,
    0,
    'unresolved dispatch recovery must not append or resend anything'
  );
  assert.equal(restartedUnresolved.store.providerRequestCount, 0);
  assert.equal(restartedUnresolved.calls('submitToolIntent').length, 0);
}

async function historicalToolContextSnapshotRecoversOutcomesAcrossRefresh() {
  const durable = await createCompletedToolProviderDurableHistory(
    'session-historical-context-recovery'
  );
  const refreshed = createCorpusToolContext();
  durable.store.seedDaemonRecord(
    createToolContextSnapshotRecordV3(
      durable.sessionId,
      durable.initial.runId,
      refreshed,
      '2026-07-29T00:00:10.000Z'
    )
  );
  const state = clone(durable.completedState);
  state.checkpointRevision = 2;
  state.toolContext = {
    bundle: refreshed,
    refreshRequired: false,
  };
  state.providerTurn = undefined;
  state.providerToolCallQueue = undefined;
  state.previews = {};
  await durable.persistence.persistCheckpoint(
    checkpointFromStateV3(state, '2026-07-29T00:00:11.000Z')
  );

  const restored = await durable.persistence.loadCheckpoint(
    durable.initial.runId,
    recoveryAuthority(durable.initial)
  );
  assert.deepEqual(
    toolContextRef(restored.state.toolContext.bundle),
    toolContextRef(refreshed)
  );
  assert.equal(restored.state.providerOutcomes.length, 1);
  assert.equal(restored.state.providerOutcomes[0].outputKind, 'toolIntent');
  assert.equal(
    restored.state.providerOutcomes[0].toolCallReceipt.calls[0].toolId,
    'fs.write'
  );
  assert.equal(
    refreshed.tools.some((tool) => tool.toolId === 'fs.write'),
    false,
    'the current refreshed ToolContext intentionally cannot decode old fs.write'
  );
  assert.equal(
    restored.state.providerOutcomes[0].summary,
    'Completed 1 ordered Provider tool call(s).'
  );
  const originalReservation = durable.store.records
    .find((record) =>
      record.recordKind === 'checkpoint'
      && record.data.checkpointRevision === 1
    ).data.active.providerReservation;
  assert.deepEqual(
    originalReservation.contextRef,
    toolContextRef(durable.initial.toolContext),
    'historical outcome must retain the ToolContext bound at dispatch'
  );
}

async function missingOrConflictingToolContextSnapshotFailsClosedWithoutCurrentBundleFallback() {
  const durable = await createCompletedToolProviderDurableHistory(
    'session-missing-context-recovery'
  );
  const refreshed = createCorpusToolContext();
  durable.store.seedDaemonRecord(
    createToolContextSnapshotRecordV3(
      durable.sessionId,
      durable.initial.runId,
      refreshed,
      '2026-07-29T00:00:20.000Z'
    )
  );
  const state = clone(durable.completedState);
  state.checkpointRevision = 2;
  state.toolContext = { bundle: refreshed, refreshRequired: false };
  state.providerTurn = undefined;
  state.providerToolCallQueue = undefined;
  await durable.persistence.persistCheckpoint(
    checkpointFromStateV3(state, '2026-07-29T00:00:21.000Z')
  );
  const originalRef = toolContextRef(durable.initial.toolContext);
  const refreshedRef = toolContextRef(refreshed);
  const originalSnapshotId =
    `session-kernel-v3:${durable.initial.runId}:tool-context:${originalRef.contextDigest}`;
  const refreshedSnapshotId =
    `session-kernel-v3:${durable.initial.runId}:tool-context:${refreshedRef.contextDigest}`;
  const scenarios = [
    {
      label: 'missing RunOpen snapshot',
      records: durable.store.records.filter(
        (record) => record.recordId !== originalSnapshotId
      ),
    },
    {
      label: 'missing current snapshot',
      records: durable.store.records.filter(
        (record) => record.recordId !== refreshedSnapshotId
      ),
    },
    {
      label: 'snapshot record digest mismatch',
      records: durable.store.records.map((record) => {
        if (record.recordId !== refreshedSnapshotId) return clone(record);
        const conflicting = clone(record);
        conflicting.data.toolContext.tools[0].description =
          'conflicting historical descriptor';
        return conflicting;
      }),
    },
    {
      label: 'snapshot schema mismatch',
      records: mutateDurableRecord(
        durable.store.records,
        refreshedSnapshotId,
        (record) => {
          record.data.schemaVersion =
            'deepcode.session.tool-context-snapshot.v2';
        }
      ),
    },
    {
      label: 'snapshot context digest ref mismatch',
      records: mutateDurableRecord(
        durable.store.records,
        refreshedSnapshotId,
        (record) => {
          record.data.contextRef.contextDigest = `sha256:${'1'.repeat(64)}`;
        }
      ),
    },
    {
      label: 'snapshot catalog ref mismatch',
      records: mutateDurableRecord(
        durable.store.records,
        refreshedSnapshotId,
        (record) => {
          record.data.contextRef.catalogDigest = `sha256:${'2'.repeat(64)}`;
        }
      ),
    },
    {
      label: 'snapshot context version ref mismatch',
      records: mutateDurableRecord(
        durable.store.records,
        refreshedSnapshotId,
        (record) => {
          record.data.contextRef.contextVersion += 1;
        }
      ),
    },
    {
      label: 'snapshot bundle digest mismatch',
      records: mutateDurableRecord(
        durable.store.records,
        refreshedSnapshotId,
        (record) => {
          record.data.toolContext.tools[0].description =
            'conflicting historical descriptor';
        }
      ),
    },
  ];
  for (const scenario of scenarios) {
    const rejected = createDurablePersistenceHarness({
      sessionId: durable.sessionId,
      initial: durable.initial,
      records: scenario.records,
    });
    await assert.rejects(
      rejected.persistence.loadCheckpoint(
        durable.initial.runId,
        recoveryAuthority(durable.initial)
      ),
      (error) => error?.code === 'UnsupportedHistorySchema',
      scenario.label
    );
    assert.equal(rejected.store.appended.length, 0);
    const recovery = createSessionHarness({ initial: durable.initial });
    recovery.ports.persistence = rejected.persistence;
    await assert.rejects(
      recovery.open(),
      (error) => error?.code === 'UnsupportedHistorySchema',
      `${scenario.label} must fail before Session starts Provider or tools`
    );
    assert.equal(recovery.store.providerRequestCount, 0);
    assert.equal(recovery.calls('submitToolIntent').length, 0);
  }
}

async function frozenReviewFinalAnswerBindingBudgetAndStaleReconciliation() {
  const committed = await prepareFinalAnswerHarness();
  const binding = clone(committed.loop.snapshot().finalAnswer.binding);
  const toolSubmissions = committed.calls('submitToolIntent').length;
  committed.enqueueProvider(providerAnswer('Frozen Review final answer.'));
  const final = await committed.loop.runProviderTurn({
    reason: 'finalAnswer',
    target: { kind: 'finalAnswer', ...binding },
  });
  assert.deepEqual(final, {
    kind: 'answer',
    text: 'Frozen Review final answer.',
  });
  assert.equal(committed.loop.snapshot().finalAnswer.status, 'committed');
  assert.equal(committed.loop.snapshot().finalAnswer.physicalRequestCount, 1);
  assert.deepEqual(
    committed.loop.snapshot().finalAnswer.binding,
    binding
  );

  const drifting = await prepareFinalAnswerHarness();
  const staleBinding = clone(drifting.loop.snapshot().finalAnswer.binding);
  const driftToolSubmissions = drifting.calls('submitToolIntent').length;
  drifting.enqueueProvider(async () => {
    drifting.appendFacts(corpusFact('cleanupCompleted', {
      factId: 'fact-final-answer-inflight-drift',
      ledgerSequence: drifting.nextFactSequence(),
      runSequence: drifting.nextRunSequence(),
      identities: {
        runId: drifting.initial.runId,
        operationId: drifting.loop.snapshot().plan.actions[0]
          .manifest.operationId,
      },
    }));
    return providerAnswer('Stale final answer must not commit.');
  });
  drifting.enqueueProvider(providerAnswer('Reconciled final answer.'));
  const reconciledFinal = await drifting.loop.runProviderTurn({
    reason: 'finalAnswer',
    target: { kind: 'finalAnswer', ...staleBinding },
  });
  assert.deepEqual(reconciledFinal, {
    kind: 'answer',
    text: 'Reconciled final answer.',
  });
  assert.equal(
    drifting.loop.snapshot().finalAnswer.binding.snapshotHighWater
      > staleBinding.snapshotHighWater,
    true
  );
  assert.equal(
    drifting.loop.snapshot().finalAnswer.finalText,
    'Reconciled final answer.'
  );
  assert.equal(
    drifting.calls('submitToolIntent').length,
    driftToolSubmissions,
    'in-flight facts drift must not rerun the already completed tool'
  );

  committed.appendFacts(corpusFact('cleanupCompleted', {
    factId: 'fact-final-answer-postcommit-drift',
    ledgerSequence: committed.nextFactSequence(),
    runSequence: committed.nextRunSequence(),
    identities: {
      runId: committed.initial.runId,
      operationId: committed.loop.snapshot().plan.actions[0]
        .manifest.operationId,
    },
  }));
  await committed.loop.reconcileFacts(binding.snapshotHighWater);
  assert.equal(committed.loop.snapshot().finalAnswer.status, 'stale');
  assert.equal(
    committed.calls('submitToolIntent').length,
    toolSubmissions,
    'facts drift must stale only final-answer authority and never rerun tools'
  );

  const exhausted = await prepareFinalAnswerHarness();
  const exhaustedBinding = clone(
    exhausted.loop.snapshot().finalAnswer.binding
  );
  const requestsBeforeFinalAnswer = exhausted.store.providerRequestCount;
  const exhaustedToolSubmissions = exhausted.calls('submitToolIntent').length;
  for (let index = 0; index < 3; index += 1) {
    exhausted.enqueueProvider((input) => {
      exhausted.store.providerEvidence.set(
        input.providerTurnId,
        createFailedProviderEvidence(
          input,
          'provider_retryable_no_mutation',
          { recordedAt: `2026-07-29T00:01:0${index}.000Z` }
        )
      );
      const error = new Error('controlled retryable transport failure');
      error.code = 'session_kernel_provider_transport_failed';
      throw error;
    });
  }
  const failed = await exhausted.loop.runProviderTurn({
    reason: 'finalAnswer',
    target: { kind: 'finalAnswer', ...exhaustedBinding },
  });
  assert.deepEqual(failed, {
    kind: 'finalAnswerFailed',
    errorCode: 'session_kernel_provider_transport_failed',
    physicalRequestCount: 3,
  });
  assert.equal(
    exhausted.store.providerRequestCount,
    requestsBeforeFinalAnswer + 3
  );
  assert.equal(exhausted.loop.snapshot().finalAnswer.status,
    'finalAnswerFailed');
  assert.equal(
    exhausted.calls('submitToolIntent').length,
    exhaustedToolSubmissions
  );

  const durable = createDurablePersistenceHarness({
    sessionId: 'session-final-answer-durable-budget',
    initial: exhausted.initial,
  });
  await durable.persistence.persistInput(durable.initial.initialInput);
  await durable.persistence.persistPlan(exhausted.loop.snapshot().plan);
  await durable.persistence.persistPlanDecision(
    exhausted.loop.snapshot().planDecision
  );
  for (const [requestId, stored] of exhausted.store.operationResults) {
    await durable.persistence.persistOperationResult(requestId, stored.result);
  }
  for (const evidence of exhausted.store.providerEvidence.values()) {
    seedProviderEvidenceRecordsV3(durable, evidence);
  }
  let durableCheckpointRevision = 0;
  for (const outcome of exhausted.loop.snapshot().providerOutcomes) {
    const source = exhausted.store.checkpointHistory
      .filter((checkpoint) =>
        checkpoint.state.providerTurn?.providerTurnId
          === outcome.providerTurnId
        && checkpoint.state.providerOutcomes.some(
          (candidate) =>
            candidate.providerTurnId === outcome.providerTurnId
        )
      )
      .at(-1);
    assert(
      source,
      `Missing durable reservation checkpoint for ${outcome.providerTurnId}.`
    );
    const sourceState = clone(source.state);
    sourceState.checkpointRevision = ++durableCheckpointRevision;
    delete sourceState.providerTurn.dispatchRef;
    delete sourceState.providerTurn.terminalRef;
    await durable.persistence.persistCheckpoint(
      checkpointFromStateV3(sourceState, source.savedAt)
    );
  }
  const durableState = clone(exhausted.loop.snapshot());
  durableState.checkpointRevision = ++durableCheckpointRevision;
  if (durableState.providerTurn) {
    delete durableState.providerTurn.dispatchRef;
    delete durableState.providerTurn.terminalRef;
  }
  await durable.persistence.persistCheckpoint(
    checkpointFromStateV3(durableState, '2026-07-29T00:02:00.000Z')
  );
  const restarted = createSessionHarness({
    initial: exhausted.initial,
    kernelState: exhausted.kernelState,
  });
  restarted.ports.persistence = durable.persistence;
  await restarted.open();
  assert.equal(restarted.loop.snapshot().finalAnswer.status,
    'finalAnswerFailed');
  assert.equal(restarted.loop.snapshot().finalAnswer.physicalRequestCount, 3);
  const recoveredFailure = await restarted.loop.runProviderTurn({
    reason: 'finalAnswer',
    target: { kind: 'finalAnswer', ...exhaustedBinding },
  });
  assert.equal(recoveredFailure.kind, 'finalAnswerFailed');
  assert.equal(restarted.store.providerRequestCount, 0);
  assert.equal(restarted.calls('submitToolIntent').length, 0);
}

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
  const firstQueue = first.loop.snapshot().providerToolCallQueue;
  assert.ok(firstQueue);
  assert.equal(firstQueue.status, 'active');
  assert.equal(firstQueue.calls[0].status, 'submitting');
  assert.equal(firstQueue.calls[0].requestId, firstSubmission.requestId);
  assert.deepEqual(
    firstQueue.calls[0].intent,
    firstSubmission.intent,
    'the durable queue must retain the exact unknown-outcome payload'
  );
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
    canonicalJson(replay.intent),
    canonicalJson(firstQueue.calls[0].intent),
    'unknown replay must retain the same canonical payload digest'
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
  assert.equal(
    restarted.loop.snapshot().providerToolCallQueue.calls[0].requestId,
    firstSubmission.requestId
  );
}

async function restartResumesQueueWithoutReplayingCompletedCalls() {
  const first = await openSessionHarness();
  first.enqueueProvider(providerToolIntents([
    {
      callId: 'provider-call-restart-queue-1',
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
    {
      callId: 'provider-call-restart-queue-2',
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
  ]));
  first.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(first, request, {
      invocationId: 'invocation-restart-queue-1',
      attemptId: 'attempt-restart-queue-1',
    })
  );
  const admitted = await first.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(admitted.kind, 'admitted');
  appendContextReadCompletion(
    first,
    admitted,
    'attempt-restart-queue-1',
    'restart-queue-first'
  );
  await first.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: admitted.operationId,
    invocationId: admitted.invocationId,
  });
  const beforeRestart = first.loop.snapshot().providerToolCallQueue;
  assert.deepEqual(
    beforeRestart.calls.map((call) => call.status),
    ['completed', 'pending']
  );
  const completedRequestId = beforeRestart.calls[0].requestId;

  const restarted = createSessionHarness({
    initial: first.initial,
    store: first.store,
    kernelState: first.kernelState,
  });
  await restarted.open();
  assert.equal(
    restarted.calls('submitToolIntent').length,
    0,
    'restart must not replay a canonically completed queue item'
  );
  assert.deepEqual(
    restarted.loop.snapshot().providerToolCallQueue.calls.map(
      (call) => call.status
    ),
    ['completed', 'pending']
  );
  assert.equal(
    restarted.loop.snapshot().providerToolCallQueue.calls[0].requestId,
    completedRequestId
  );

  restarted.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(restarted, request, {
      admissionFactId: 'fact-restart-queue-admitted-2',
      invocationId: 'invocation-restart-queue-2',
      attemptId: 'attempt-restart-queue-2',
    })
  );
  const second = await restarted.loop.resumePendingProviderToolCalls();
  assert.equal(second.kind, 'admitted');
  assert.equal(restarted.calls('submitToolIntent').length, 1);
  assert.equal(
    restarted.calls('submitToolIntent')[0].intent.operationId,
    beforeRestart.calls[1].intent.operationId
  );
  assert.notEqual(
    restarted.calls('submitToolIntent')[0].requestId,
    completedRequestId
  );

  appendContextReadCompletion(
    restarted,
    second,
    'attempt-restart-queue-2',
    'restart-queue-second'
  );
  await restarted.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: second.operationId,
    invocationId: second.invocationId,
  });
  assert.equal(
    restarted.loop.snapshot().providerToolCallQueue.status,
    'completed'
  );
  assert.equal(
    restarted.loop.snapshot().providerToolCallQueue.outcomeRecorded,
    true
  );
}

async function corruptedProviderToolQueueCheckpointFailsClosed() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(providerToolIntents([
    {
      callId: 'provider-call-corrupt-queue-1',
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
    {
      callId: 'provider-call-corrupt-queue-2',
      toolId: 'fs.read',
      arguments: { path: 'notes/context.md' },
    },
  ]));
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-corrupt-queue',
      attemptId: 'attempt-corrupt-queue',
    })
  );
  await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  const checkpoint = harness.store.checkpoint;
  assert.ok(checkpoint?.state.providerToolCallQueue);
  const corruptions = [
    (value) => {
      value.state.providerToolCallQueue.receipt.calls[0].argumentsDigest =
        `sha256:${'0'.repeat(64)}`;
    },
    (value) => {
      value.state.providerToolCallQueue.calls[0].ordinal = 2;
    },
    (value) => {
      value.state.providerToolCallQueue.calls[0].requestId = undefined;
    },
    (value) => {
      value.state.providerToolCallQueue.calls[1].intent.operationId =
        value.state.providerToolCallQueue.calls[0].intent.operationId;
    },
    (value) => {
      const call = value.state.providerToolCallQueue.calls[0];
      call.terminalFactId = 'fact-forged-terminal';
      call.terminalFactKind = 'toolCompleted';
    },
    (value) => {
      delete value.state.providerToolCallQueue.calls[0].invocationId;
    },
    (value) => {
      const call = value.state.providerToolCallQueue.calls[0];
      call.status = 'completed';
      delete call.terminalFactId;
      delete call.terminalFactKind;
    },
  ];
  for (const corrupt of corruptions) {
    const invalid = JSON.parse(JSON.stringify(checkpoint));
    corrupt(invalid);
    assert.throws(
      () => restoreSessionKernelLoopStateV2(
        invalid,
        {
          runId: harness.initial.runId,
          workspaceBindingDigest:
            harness.initial.workspaceBindingDigest,
          sessionMemory: harness.initial.sessionMemory,
          providerProfile: harness.initial.providerProfile,
        }
      ),
      (error) =>
        error?.code === 'session_provider_tool_call_queue_invalid'
    );
  }
  const correlationCorruptions = [
    {
      label: 'Provider queue target differs from its durable Provider turn',
      corrupt(value) {
        value.state.providerToolCallQueue.target = {
          kind: 'planAction',
          planActionId: 'plan-action-forged',
        };
      },
    },
    {
      label: 'missing ContextRead work authority',
      corrupt(value) {
        value.state.workAuthority = undefined;
      },
    },
    {
      label: 'ContextRead work authority missing the queued operation',
      corrupt(value) {
        const operationIds = ['operation-unrelated-context-read'];
        const { batchSequence, predecessorDigest } =
          value.state.workAuthority;
        value.state.workAuthority = {
          kind: 'contextRead',
          batchSequence,
          predecessorDigest,
          operationIds,
          digest: sha256Hash(canonicalJson({
            kind: 'contextRead',
            batchSequence,
            predecessorDigest,
            operationIds,
          })),
        };
      },
    },
    {
      label: 'planning queue forged to a mutation descriptor',
      corrupt(value) {
        const call = value.state.providerToolCallQueue.calls[0];
        const ordered = value.state.providerToolCallQueue.orderedItems.find(
          (item) => item.kind === 'toolCall' && item.ordinal === call.ordinal
        );
        const receipt = value.state.providerToolCallQueue.receipt.calls[0];
        call.intent.toolId = 'fs.write';
        ordered.toolId = 'fs.write';
        ordered.toolName = 'fs.write';
        receipt.toolId = 'fs.write';
        receipt.toolName = 'fs.write';
        value.state.providerTurn.response.items =
          JSON.parse(JSON.stringify(
            value.state.providerToolCallQueue.orderedItems
          ));
      },
    },
  ];
  for (const scenario of correlationCorruptions) {
    const invalid = JSON.parse(JSON.stringify(checkpoint));
    scenario.corrupt(invalid);
    assert.throws(
      () => restoreSessionKernelLoopStateV2(
        invalid,
        {
          runId: harness.initial.runId,
          workspaceBindingDigest:
            harness.initial.workspaceBindingDigest,
          sessionMemory: harness.initial.sessionMemory,
          providerProfile: harness.initial.providerProfile,
        }
      ),
      (error) =>
        error?.code
          === 'session_kernel_provider_tool_call_queue_turn_mismatch',
      scenario.label
    );
  }
}

function appendContextReadCompletion(
  harness,
  result,
  attemptId,
  label
) {
  const effectId = `effect-${label}`;
  const observed = corpusFact('effectContextReadObserved', {
    factId: `fact-${label}-observed`,
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: harness.initial.runId,
      contextReadOperationId: result.operationId,
      contextReadInvocationId: result.invocationId,
      contextReadAttemptId: attemptId,
      contextReadEffectId: effectId,
    },
  });
  const completed = corpusFact('invocationContextReadCompleted', {
    factId: `fact-${label}-completed`,
    ledgerSequence: harness.nextFactSequence() + 1,
    runSequence: harness.nextRunSequence() + 1,
    identities: {
      runId: harness.initial.runId,
      contextReadOperationId: result.operationId,
      contextReadInvocationId: result.invocationId,
      contextReadAttemptId: attemptId,
      contextReadEffectId: effectId,
    },
  });
  harness.appendFacts(observed, completed);
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
  const { preview: approvedPreview } =
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
  restarted.enqueueKernel('previewCapabilityBatch', (request) =>
    createPlanDiscoveryPreviewBatch(request, approvedPreview));
  restarted.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(restarted, request, {
      invocationId: 'invocation-restart-reuse',
      attemptId: 'attempt-restart-reuse',
    })
  );
  const classified = await restarted.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(classified.kind, 'noTool');
  const readmitted = await restarted.loop.resumePendingProviderToolCalls();
  assert.equal(readmitted.kind, 'admitted');
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
  const { preview: approvedPreview } =
    await persistPreviewAndAcceptPlan(harness, plan);
  harness.enqueueProvider(
    providerToolIntent(
      'fs.write',
      { path: 'output.txt', content: 'contract output' },
      'provider-call-indeterminate'
    )
  );
  harness.enqueueKernel('previewCapabilityBatch', (request) =>
    createPlanDiscoveryPreviewBatch(request, approvedPreview));
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-indeterminate',
      attemptId: 'attempt-indeterminate',
    })
  );
  const classified = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(classified.kind, 'noTool');
  const admitted = await harness.loop.resumePendingProviderToolCalls();
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
      remainingToolCallBudget: 32,
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

async function outOfPlanMutationFreezesEffectAndPublishesOneConsolidatedIntervention() {
  const { harness, plan, intervention } = await prepareOpenIntervention();
  assert.equal(harness.calls('submitToolIntent').length, 0);
  assert.equal(harness.loop.snapshot().activeWait?.kind, 'userIntervention');
  assert.equal(intervention.options.length, 2);
  assert.deepEqual(
    intervention.affectedPlanActionIds,
    [plan.actions[0].manifest.planActionId]
  );
  const executable = intervention.options.find(
    (option) => option.kind === 'executable'
  );
  assert.ok(executable);
  assert.equal(executable.actions.length, 1);
  assert.equal(
    executable.actions[0].preview.origin.kind,
    'interventionCandidate'
  );
  assert.equal(
    executable.actions[0].preview.disposition,
    'requiresUserDecision'
  );
  const guidanceOnly = intervention.options.find(
    (option) => option.kind === 'guidanceOnly'
  );
  const decision = await harness.loop.decideUserIntervention({
    interactionId: intervention.interactionId,
    interactionRevision: intervention.interactionRevision,
    candidateSetDigest: intervention.candidateSetDigest,
    decision: 'select',
    optionId: guidanceOnly.optionId,
    guidance: 'Keep the original mutation boundary.',
    callerRequestId: 'caller-guidance-only-1',
  });
  assert.equal(decision.disposition, 'guidanceReplan');
  assert.equal(harness.loop.snapshot().activeWait, undefined);
  assert.equal(harness.loop.snapshot().userIntervention, undefined);
  assert.equal(harness.calls('submitToolIntent').length, 0);
  assert.equal(
    harness.kernelState.facts.some((fact) => fact.domain === 'effect'),
    false
  );
}

async function interventionRevisionPreservesIdentityAndRejectionRequiresRunCancellation() {
  const { harness, intervention, preview } = await prepareOpenIntervention();
  const revised = await harness.loop.decideUserIntervention({
    interactionId: intervention.interactionId,
    interactionRevision: intervention.interactionRevision,
    candidateSetDigest: intervention.candidateSetDigest,
    decision: 'revise',
    guidance: 'Compare one narrower alternative before asking again.',
    callerRequestId: 'caller-revise-intervention-1',
  });
  assert.equal(revised.disposition, 'researchRevision');
  const research = harness.loop.snapshot().interventionResearch;
  assert.equal(research.guidanceRevision, 2);
  assert.equal(harness.loop.snapshot().userIntervention, undefined);

  const draft = interventionDraft('Revised consolidated intervention');
  harness.enqueueProvider(providerIntervention(
    draft,
    'intervention-proposal-revised'
  ));
  harness.enqueueKernel('previewCapabilityBatch', (request) =>
    createInterventionCandidatePreviewBatch(request, preview));
  const regenerated = await harness.loop.runProviderTurn({
    reason: 'recovery',
    target: {
      kind: 'interventionResearch',
      researchId: research.researchId,
    },
  });
  assert.equal(regenerated.kind, 'noTool');
  const next = harness.loop.snapshot().userIntervention;
  assert.equal(next.interactionId, intervention.interactionId);
  assert.notEqual(next.interactionRevision, intervention.interactionRevision);
  assert.notEqual(next.candidateSetDigest, intervention.candidateSetDigest);

  const rejected = await harness.loop.decideUserIntervention({
    interactionId: next.interactionId,
    interactionRevision: next.interactionRevision,
    candidateSetDigest: next.candidateSetDigest,
    decision: 'reject',
    guidance: 'Do not expand this Run.',
    callerRequestId: 'caller-reject-intervention-1',
  });
  assert.equal(rejected.disposition, 'runCancellationRequired');
  assert.equal(harness.loop.snapshot().activeWait, undefined);
  assert.equal(harness.calls('submitToolIntent').length, 0);
  assert.equal(
    harness.kernelState.facts.some((fact) => fact.domain === 'effect'),
    false
  );
}

async function prepareOpenIntervention() {
  const harness = await openSessionHarness({
    initial: { runId: 'run-1' },
  });
  const plan = createPlan({
    runId: 'run-1',
    planRevision: 'plan-revision-golden-1',
    planActionId: 'plan-action-golden-1',
    operationId: 'planned-operation-golden-output',
  });
  const { preview } = await persistPreviewAndAcceptPlan(harness, plan);
  harness.enqueueProvider(providerToolIntent(
    'fs.write',
    { path: 'expanded.txt', content: 'expanded' },
    'provider-call-out-of-plan'
  ));
  harness.enqueueKernel('previewCapabilityBatch', (request) =>
    createOutOfPlanDiscoveryPreviewBatch(request, preview));
  const frozen = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
  });
  assert.equal(frozen.kind, 'noTool');
  const research = harness.loop.snapshot().interventionResearch;
  assert.ok(research);
  assert.equal(harness.loop.snapshot().activeWait, undefined);

  harness.enqueueProvider(providerIntervention(interventionDraft()));
  harness.enqueueKernel('previewCapabilityBatch', (request) =>
    createInterventionCandidatePreviewBatch(request, preview));
  const published = await harness.loop.runProviderTurn({
    reason: 'recovery',
    target: {
      kind: 'interventionResearch',
      researchId: research.researchId,
    },
  });
  assert.equal(published.kind, 'noTool');
  const intervention = harness.loop.snapshot().userIntervention;
  assert.ok(intervention);
  return { harness, plan, intervention, preview };
}

function interventionDraft(
  problemSummary = 'The requested mutation expands the accepted Plan scope.'
) {
  return {
    problemSummary,
    recommendation: 'Choose the reviewed executable revision only if the expanded file is required.',
    relevantFactRefs: [],
    affectedPlanActionIds: ['plan-action-golden-1'],
    options: [
      {
        optionId: 'option-expanded',
        kind: 'executable',
        title: 'Expand the Plan once',
        description: 'Add the newly discovered workspace write to a replacement Plan revision.',
        tradeoffs: ['Expands the mutation surface but preserves Kernel review.'],
        recommended: true,
        candidatePlan: {
          title: 'Write reviewed expanded output',
          objective: 'Write the newly discovered file after explicit user selection.',
          narrative: 'Carry completed work and execute only the reviewed remaining mutation.',
          evidence: {
            kernelFactRefs: [],
            readResources: [],
            blockingUnknowns: [],
            nonBlockingUnknowns: [],
            coverage: 'The expanded target is represented by one candidate-only preview.',
          },
          actions: [{
            toolId: 'fs.write',
            scopeIntent: {
              kind: 'resourceScope',
              data: {
                requestedResources: [{
                  kind: 'workspacePath',
                  data: { path: 'expanded.txt', access: 'write' },
                }],
              },
            },
          }],
        },
      },
      {
        optionId: 'option-guidance',
        kind: 'guidanceOnly',
        title: 'Keep the original boundary',
        description: 'Replan without adding the newly discovered mutation.',
        tradeoffs: ['May leave the optional expanded output unfinished.'],
        recommended: false,
      },
    ],
  };
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

async function createCompletedProviderDurableHistory(sessionId) {
  const live = await openSessionHarness();
  live.enqueueProvider(providerAnswer('durably recovered answer'));
  await live.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  const completedState = clone(live.loop.snapshot());
  const providerTurn = completedState.providerTurn;
  const providerOutcome = completedState.providerOutcomes.find(
    (candidate) => candidate.providerTurnId === providerTurn.providerTurnId
  );
  assert(providerOutcome);
  const durable = createDurablePersistenceHarness({
    sessionId,
    initial: live.initial,
  });
  await durable.persistence.persistInput(durable.initial.initialInput);
  const evidence = providerEvidenceRecordsV3(
    sessionId,
    durable.initial.runId,
    live.providerInputs[0],
    {
      items: providerTurn.response.items,
      completion: providerTurn.response.completion,
      providerResult: providerOutcome.providerResult,
    },
    providerOutcome.recordedAt
  );
  durable.store.seedDaemonRecord(evidence.dispatch);
  durable.store.seedDaemonRecord(evidence.terminal);
  completedState.checkpointRevision = 1;
  delete completedState.providerTurn.dispatchRef;
  delete completedState.providerTurn.terminalRef;
  await durable.persistence.persistCheckpoint(
    checkpointFromStateV3(completedState)
  );
  return {
    ...durable,
    live,
    completedState,
    evidence,
  };
}

async function createCompletedToolProviderDurableHistory(sessionId) {
  const live = await openSessionHarness();
  const plan = createPlan();
  const { preview: approvedPreview } =
    await persistPreviewAndAcceptPlan(live, plan);
  live.enqueueProvider(providerToolIntent(
    'fs.write',
    { path: 'output.txt', content: 'contract output' },
    'provider-call-durable-tool-history'
  ));
  live.enqueueKernel('previewCapabilityBatch', (request) =>
    createPlanDiscoveryPreviewBatch(request, approvedPreview));
  live.enqueueKernel('submitToolIntent', (request) =>
    admittedReply(live, request, {
      invocationId: 'invocation-durable-tool-history',
      attemptId: 'attempt-durable-tool-history',
    }));
  const classified = await live.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: plan.actions[0].manifest.planActionId,
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(classified.kind, 'noTool');
  const admitted = await live.loop.resumePendingProviderToolCalls();
  assert.equal(admitted.kind, 'admitted');
  appendMutationCompletion(
    live,
    plan,
    admitted,
    'attempt-durable-tool-history',
    'durable-tool-history'
  );
  await live.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: admitted.operationId,
    invocationId: admitted.invocationId,
    planActionId: plan.actions[0].manifest.planActionId,
    expectedPlanRevision: plan.planRevision,
  });
  const completedState = clone(live.loop.snapshot());
  assert.equal(completedState.providerToolCallQueue.status, 'completed');
  const providerTurn = completedState.providerTurn;
  const providerOutcome = completedState.providerOutcomes.find(
    (candidate) => candidate.providerTurnId === providerTurn.providerTurnId
  );
  assert.equal(providerOutcome?.outputKind, 'toolIntent');

  const durable = createDurablePersistenceHarness({
    sessionId,
    initial: live.initial,
  });
  await durable.persistence.persistInput(durable.initial.initialInput);
  await durable.persistence.persistPlan(plan);
  await durable.persistence.persistPlanDecision(
    live.store.planDecisions.get(plan.planRevision)
  );
  for (const [requestId, stored] of live.store.operationResults) {
    await durable.persistence.persistOperationResult(requestId, stored.result);
  }
  const evidence = providerEvidenceRecordsV3(
    sessionId,
    durable.initial.runId,
    live.providerInputs[0],
    {
      items: providerTurn.response.items,
      completion: providerTurn.response.completion,
      providerResult: providerOutcome.providerResult,
    },
    providerOutcome.recordedAt
  );
  durable.store.seedDaemonRecord(evidence.dispatch);
  durable.store.seedDaemonRecord(evidence.terminal);
  completedState.checkpointRevision = 1;
  delete completedState.providerTurn.dispatchRef;
  delete completedState.providerTurn.terminalRef;
  await durable.persistence.persistCheckpoint(
    checkpointFromStateV3(completedState)
  );
  return {
    ...durable,
    live,
    completedState,
    evidence,
  };
}

async function createNoncompletedProviderHistory(options) {
  const source = await createCompletedProviderDurableHistory(
    `session-${options.terminalKind}-terminal-source`
  );
  const records = source.store.records.filter(
    (record) =>
      record.recordKind !== 'checkpoint'
      && record.recordKind !== 'providerTurnTerminal'
  );
  const failedTerminal = createDurableRecordV3({
    sessionId: source.sessionId,
    runId: source.initial.runId,
    recordKind: 'providerTurnTerminal',
    logicalId:
      `provider-turn:${source.completedState.providerTurn.providerTurnId}:terminal`,
    recordedAt: '2026-07-29T00:00:30.000Z',
    data: {
      schemaVersion: 'deepcode.session.provider-turn-terminal.v4',
      providerTurnId: source.completedState.providerTurn.providerTurnId,
      dispatchRef: {
        recordId: source.evidence.dispatch.recordId,
        recordDigest: source.evidence.dispatch.recordDigest,
      },
      authorityBinding: clone(source.evidence.dispatch.data.authorityBinding),
      terminalKind: options.terminalKind,
      reasonCode: options.reasonCode,
      traceRef: {
        terminalDigest: sha256Hash('failed-terminal-contract'),
        sealDigest: sha256Hash('failed-seal-contract'),
        recordCount: 2,
      },
      orderedItems: [],
    },
  });
  records.push(failedTerminal);
  const failed = createDurablePersistenceHarness({
    sessionId: source.sessionId,
    initial: source.initial,
    records,
  });
  const state = clone(source.completedState);
  state.checkpointRevision = 1;
  state.providerTurn.status = options.expectedStatus;
  delete state.providerTurn.response;
  delete state.providerTurn.dispatchRef;
  delete state.providerTurn.terminalRef;
  state.providerOutcomes = [];
  await failed.persistence.persistCheckpoint(checkpointFromStateV3(state));
  return failed;
}

async function createUnresolvedProviderHistory() {
  const source = await createCompletedProviderDurableHistory(
    'session-unresolved-terminal-source'
  );
  const records = source.store.records.filter(
    (record) =>
      record.recordKind !== 'checkpoint'
      && record.recordKind !== 'providerTurnDispatch'
      && record.recordKind !== 'providerTurnTerminal'
  );
  const preparing = createDurablePersistenceHarness({
    sessionId: source.sessionId,
    initial: source.initial,
    records,
  });
  const state = clone(source.completedState);
  state.checkpointRevision = 1;
  state.providerTurn.status = 'active';
  delete state.providerTurn.response;
  delete state.providerTurn.dispatchRef;
  delete state.providerTurn.terminalRef;
  state.providerOutcomes = [];
  await preparing.persistence.persistCheckpoint(
    checkpointFromStateV3(state)
  );
  preparing.store.seedDaemonRecord(source.evidence.dispatch);
  return createDurablePersistenceHarness({
    sessionId: source.sessionId,
    initial: source.initial,
    records: preparing.store.records,
  });
}

async function prepareFinalAnswerHarness() {
  const harness = await openSessionHarness();
  const plan = createPlan();
  const { preview: approvedPreview } =
    await persistPreviewAndAcceptPlan(harness, plan);
  harness.enqueueProvider(providerToolIntent(
    'fs.write',
    { path: 'output.txt', content: 'contract output' },
    'provider-call-final-answer-tool'
  ));
  harness.enqueueKernel('previewCapabilityBatch', (request) =>
    createPlanDiscoveryPreviewBatch(request, approvedPreview));
  harness.enqueueKernel('submitToolIntent', (request) =>
    admittedReply(harness, request, {
      invocationId: 'invocation-final-answer-tool',
      attemptId: 'attempt-final-answer-tool',
    }));
  const classified = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: plan.actions[0].manifest.planActionId,
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(classified.kind, 'noTool');
  const admitted = await harness.loop.resumePendingProviderToolCalls();
  assert.equal(admitted.kind, 'admitted');
  appendMutationCompletion(
    harness,
    plan,
    admitted,
    'attempt-final-answer-tool',
    'final-answer-tool'
  );
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: admitted.operationId,
    invocationId: admitted.invocationId,
    planActionId: plan.actions[0].manifest.planActionId,
    expectedPlanRevision: plan.planRevision,
  });
  harness.enqueueProvider(providerPlanActionComplete(
    'completed',
    'plan-action-complete-final-answer-preparation'
  ));
  await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: plan.actions[0].manifest.planActionId,
    },
    remainingToolCallBudget: 31,
  });
  const review = await harness.loop.finalizeReview(
    harness.loop.snapshot().workAuthority
  );
  assert.equal(review.status, 'final');
  assert.equal(harness.loop.snapshot().finalAnswer.status, 'pending');
  assert.deepEqual(harness.loop.snapshot().finalAnswer.binding, {
    inputId: harness.loop.snapshot().currentInputId,
    controlEpoch: harness.loop.snapshot().controlEpoch,
    workAuthority: harness.loop.snapshot().workAuthority,
    reviewRevision: review.revision,
    snapshotHighWater: review.snapshotHighWater,
  });
  return harness;
}

function recoveryAuthority(initial) {
  return {
    workspaceBindingDigest: initial.workspaceBindingDigest,
    sessionMemory: clone(initial.sessionMemory),
    providerProfile: clone(initial.providerProfile),
    toolContext: clone(initial.toolContext),
  };
}

function containsObjectKey(value, key) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsObjectKey(entry, key));
  }
  return Object.prototype.hasOwnProperty.call(value, key)
    || Object.values(value).some((entry) => containsObjectKey(entry, key));
}

function rehashDurableRecord(record) {
  const { recordDigest: _oldDigest, ...withoutDigest } = clone(record);
  return {
    ...withoutDigest,
    recordDigest: sha256Hash(canonicalJson(withoutDigest)),
  };
}

function mutateDurableRecord(records, recordId, mutate) {
  return records.map((record) => {
    if (record.recordId !== recordId) return clone(record);
    const changed = clone(record);
    mutate(changed);
    return rehashDurableRecord(changed);
  });
}

function seedProviderEvidenceRecordsV3(durable, evidence) {
  const providerTurnId = evidence.dispatch.data.providerTurnId;
  const dispatch = createDurableRecordV3({
    sessionId: durable.sessionId,
    runId: durable.initial.runId,
    recordKind: 'providerTurnDispatch',
    logicalId: `provider-turn:${providerTurnId}:dispatch`,
    recordedAt: evidence.dispatch.recordedAt,
    data: evidence.dispatch.data,
  });
  const terminal = createDurableRecordV3({
    sessionId: durable.sessionId,
    runId: durable.initial.runId,
    recordKind: 'providerTurnTerminal',
    logicalId: `provider-turn:${providerTurnId}:terminal`,
    recordedAt: evidence.terminal.recordedAt,
    data: {
      ...clone(evidence.terminal.data),
      dispatchRef: {
        recordId: dispatch.recordId,
        recordDigest: dispatch.recordDigest,
      },
    },
  });
  durable.store.seedDaemonRecord(dispatch);
  durable.store.seedDaemonRecord(terminal);
}

function clone(value) {
  return value === undefined
    ? undefined
    : JSON.parse(JSON.stringify(value));
}
