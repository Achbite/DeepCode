import {
  admittedReply,
  assert,
  corpusFact,
  createInput,
  createPlan,
  createProviderCompletionReceipt,
  createPreview,
  createPreviewBatch,
  openSessionHarness,
  providerAnswer,
  providerPlanActionComplete,
  providerToolIntent,
  providerToolIntents,
} from './harness.mjs';
import {
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
  StrictSessionKernelProviderAdapterV2,
  canonicalJson,
  sha256Hash,
} from '../../dist/index.js';

export const contractCases = [
  {
    id: 'input_fence_orders_epoch_cancel_facts_before_next_provider',
    run: inputFenceOrdersEpochCancelFactsBeforeNextProvider,
  },
  {
    id: 'late_provider_output_is_stale_after_the_input_fence',
    run: lateProviderOutputIsStaleAfterTheInputFence,
  },
  {
    id: 'input_fence_aborts_active_queue_and_marks_tail_unexecuted',
    run: inputFenceAbortsActiveQueueAndMarksTailUnexecuted,
  },
  {
    id: 'plan_acceptance_requires_every_canonical_scope_preview',
    run: planAcceptanceRequiresEveryCanonicalScopePreview,
  },
  {
    id: 'plan_action_turn_requires_one_accepted_current_plan_revision',
    run: planActionTurnRequiresOneAcceptedCurrentPlanRevision,
  },
  {
    id: 'plan_confirmation_requires_every_current_canonical_preview',
    run: planConfirmationRequiresEveryCurrentCanonicalPreview,
  },
];

async function inputFenceOrdersEpochCancelFactsBeforeNextProvider() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(
    providerToolIntent(
      'fs.read',
      { path: 'README.md' },
      'provider-call-before-input-fence'
    )
  );
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-before-input-fence',
      attemptId: 'attempt-before-input-fence',
    })
  );
  const firstResult = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(firstResult.kind, 'admitted');
  assert.equal(
    harness.loop.snapshot().activeWait?.kind,
    'invocation'
  );
  const supersededProviderTurnId =
    harness.loop.snapshot().providerTurn?.providerTurnId;
  assert.equal(typeof supersededProviderTurnId, 'string');

  const traceStart = harness.store.trace.length;
  harness.enqueueKernel('advanceControlEpoch', (request) => {
    const epochFactId = 'fact-input-fence-epoch-2';
    const cancellationFactId =
      'fact-input-fence-cancellation-requested';
    const cancelRequestId = 'cancel-input-fence-epoch-2';
    harness.appendFacts(
      corpusFact('controlEpochAdvanced', {
        factId: epochFactId,
        ledgerSequence: harness.nextFactSequence(),
        runSequence: harness.nextRunSequence(),
        identities: {
          runId: harness.initial.runId,
          inputId: request.inputId,
          opaqueInputRef: request.opaqueInputRef,
        },
      }),
      corpusFact('controlCancellationRequested', {
        factId: cancellationFactId,
        ledgerSequence: harness.nextFactSequence() + 1,
        runSequence: harness.nextRunSequence() + 1,
        identities: {
          runId: harness.initial.runId,
          cancellationInvocationId: 'invocation-before-input-fence',
          cancelRequestId,
          epochAdvancedFactId: epochFactId,
        },
      })
    );
    harness.store.trace.push(
      'kernel.controlCancellation:invocation-before-input-fence'
    );
    return {
      runId: harness.initial.runId,
      acceptedControlEpoch: 2,
      epochFactId,
      supersededCapabilityCount: 0,
      cancellation: {
        kind: 'requested',
        data: {
          cancelRequestId,
          invocationId: 'invocation-before-input-fence',
          cancellationFactId,
        },
      },
      commandBatchHighWater:
        harness.kernelState.snapshotHighWater,
    };
  });
  const nextInput = createInput({
    inputId: 'input-after-fence',
    opaqueInputRef: 'session-input:after-fence',
    text: 'Stop prior work and answer this newer instruction.',
    recordedAt: '2026-07-29T00:01:00.000Z',
  });
  const generation =
    await harness.loop.persistUserInputBeforeFence(nextInput);

  assert.equal(
    harness.loop.isUserInputFenceCurrent(generation),
    true,
    'persistUserInputBeforeFence must return an established local fence'
  );
  const afterPersist = harness.traceSince(traceStart);
  assert.equal(
    afterPersist[0],
    'persistence.persistInput:input-after-fence'
  );
  assert.equal(
    afterPersist.some((entry) =>
      entry.startsWith('kernel.advanceControlEpoch:')
    ),
    false,
    'the Kernel epoch must not advance before the local fence exists'
  );

  await harness.loop.applyFencedUserInput(nextInput, generation);
  const supersededOutcome = harness.loop.snapshot().providerOutcomes.find(
    (outcome) => outcome.providerTurnId === supersededProviderTurnId
  );
  assert.equal(supersededOutcome?.outputKind, 'toolIntent');
  assert.equal(supersededOutcome.toolSettlement.status, 'aborted');
  assert.deepEqual(
    supersededOutcome.toolCalls.map((call) => ({
      ordinal: call.ordinal,
      status: call.status,
      settlementReason: call.settlementReason,
    })),
    [{ ordinal: 1, status: 'aborted', settlementReason: 'userInput' }],
    'the superseded call must survive queue retirement as a durable outcome'
  );
  assert.equal(supersededOutcome.toolCallReceipt.callCount, 1);
  assert.match(supersededOutcome.summary, /userInput/u);
  assert.equal(
    harness.store.projectionEvents.some((event) =>
      event.kind === 'diagnostic'
      && event.data?.providerTurnId === supersededProviderTurnId
      && event.data?.reason === 'userInput'),
    true,
    'the aborted provider turn must be projected before the next Provider call'
  );
  harness.enqueueProvider(providerAnswer('new-input answer'));
  const secondResult = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.deepEqual(secondResult, {
    kind: 'answer',
    text: 'new-input answer',
  });

  const trace = harness.traceSince(traceStart);
  assertOrdered(trace, [
    (entry) =>
      entry === 'persistence.persistInput:input-after-fence',
    (entry) =>
      entry.startsWith('kernel.advanceControlEpoch:'),
    (entry) =>
      entry.startsWith('kernel.controlCancellation:'),
    (entry) => entry.startsWith('kernel.queryFacts:'),
    (entry) => entry.startsWith('provider.requestTurn:'),
  ]);
  assert.equal(harness.loop.snapshot().controlEpoch, 2);
  assert.equal(
    harness.providerInputs.at(-1).currentInput.inputId,
    'input-after-fence'
  );
  assert.equal(
    harness.calls('cancelInvocation').length,
    0,
    'the epoch reply already carries the exact cancellation fact'
  );

  const recovering = await openSessionHarness();
  recovering.enqueueProvider(
    providerToolIntent(
      'fs.read',
      { path: 'README.md' },
      'provider-call-before-recovery-fence'
    )
  );
  recovering.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(recovering, request, {
      invocationId: 'invocation-before-recovery-fence',
      attemptId: 'attempt-before-recovery-fence',
    })
  );
  const beforeRecovery = await recovering.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(beforeRecovery.kind, 'admitted');

  const recoveryInput = createInput({
    inputId: 'input-fence-recovery',
    opaqueInputRef: 'session-input:fence-recovery',
    text: 'Recover this persisted input transition before continuing.',
    recordedAt: '2026-07-29T00:01:30.000Z',
  });
  const recoveryGeneration =
    await recovering.loop.persistUserInputBeforeFence(recoveryInput);
  recovering.enqueueKernel(
    'advanceControlEpoch',
    new Error('simulated_unknown_epoch_transport_result')
  );
  await assert.rejects(
    recovering.loop.applyFencedUserInput(
      recoveryInput,
      recoveryGeneration
    )
  );
  recovering.enqueueProvider(
    providerAnswer('must remain queued until recovery')
  );
  await assert.rejects(
    recovering.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    }),
    (error) =>
      error?.code === 'session_kernel_user_input_admission_fenced'
  );

  await recovering.loop.recover();
  const recoveredResult = await recovering.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.deepEqual(recoveredResult, {
    kind: 'answer',
    text: 'must remain queued until recovery',
  });
  assert.equal(recovering.loop.snapshot().controlEpoch, 2);
  assert.equal(
    recovering.loop.snapshot().currentInputId,
    recoveryInput.inputId
  );
  const epochAttempts = recovering.calls('advanceControlEpoch');
  assert.equal(epochAttempts.length, 2);
  assert.equal(
    epochAttempts[0].requestId,
    epochAttempts[1].requestId,
    'recovery must replay the exact persisted epoch request identity'
  );
  const fallbackCancellations = recovering.calls('cancelInvocation');
  assert.equal(fallbackCancellations.length, 1);
  assert.deepEqual(fallbackCancellations[0].target, {
    kind: 'exact',
    data: { invocationId: 'invocation-before-recovery-fence' },
  });
}

async function inputFenceAbortsActiveQueueAndMarksTailUnexecuted() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(providerToolIntents([
    {
      callId: 'provider-call-before-multi-fence-1',
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
    {
      callId: 'provider-call-before-multi-fence-2',
      toolId: 'fs.read',
      arguments: { path: 'notes/context.md' },
    },
    {
      callId: 'provider-call-before-multi-fence-3',
      toolId: 'fs.read',
      arguments: { path: 'notes/other.md' },
    },
  ]));
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-before-multi-fence',
      attemptId: 'attempt-before-multi-fence',
    })
  );
  const first = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(first.kind, 'admitted');
  const initialQueue = harness.loop.snapshot().providerToolCallQueue;
  assert.deepEqual(
    initialQueue.calls.map((call) => call.status),
    ['awaitingInvocation', 'pending', 'pending']
  );
  assert.equal(harness.calls('submitToolIntent').length, 1);
  const providerTurnId = initialQueue.providerTurnId;
  const orderedOperationIds = initialQueue.calls.map(
    (call) => call.intent.operationId
  );
  const unexecutedOperationIds = new Set(
    orderedOperationIds.slice(1)
  );
  const traceStart = harness.store.trace.length;

  const nextInput = createInput({
    inputId: 'input-aborts-multi-queue',
    opaqueInputRef: 'session-input:aborts-multi-queue',
    text: 'Supersede the complete queued tool sequence.',
    recordedAt: '2026-07-29T00:02:30.000Z',
  });
  const generation =
    await harness.loop.persistUserInputBeforeFence(nextInput);
  await harness.loop.applyFencedUserInput(nextInput, generation);

  const outcomes = harness.loop.snapshot().providerOutcomes.filter(
    (outcome) => outcome.providerTurnId === providerTurnId
  );
  assert.equal(
    outcomes.length,
    1,
    'the retired queue must have one durable Provider outcome'
  );
  const [outcome] = outcomes;
  assert.equal(outcome.outputKind, 'toolIntent');
  assert.equal(outcome.toolSettlement.status, 'aborted');
  assert.equal(outcome.toolCallReceipt.callCount, 3);
  assert.match(outcome.summary, /userInput/u);
  assert.match(outcome.summary, /unexecuted=2/u);
  const expectedSettlement = orderedOperationIds.map(
    (operationId, index) => ({
      ordinal: index + 1,
      operationId,
      status: index === 0 ? 'aborted' : 'unexecuted',
      settlementReason: 'userInput',
    })
  );
  assert.deepEqual(
    outcome.toolCalls.map((call) => ({
      ordinal: call.ordinal,
      operationId: call.operationId,
      status: call.status,
      settlementReason: call.settlementReason,
    })),
    expectedSettlement,
    'durable settlement must preserve Provider call order'
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    1,
    'the input fence must not dispatch any queued tail call'
  );
  assert.equal(
    harness.providerInputs.length,
    1,
    'the input fence must not repeat the superseded Provider turn'
  );
  assert.equal(
    harness.kernelState.facts.some((fact) =>
      unexecutedOperationIds.has(fact.lineage.operationId)
    ),
    false,
    'unexecuted tail calls must have no attempt or effect fact'
  );
  const diagnostics = harness.store.projectionEvents.filter(
    (event) =>
      event.kind === 'diagnostic'
      && event.data?.providerTurnId === providerTurnId
      && event.data?.reason === 'userInput'
  );
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.deepEqual(
    diagnostic.data.toolCallReceipt,
    outcome.toolCallReceipt,
    'the diagnostic must carry the exact recorded Provider receipt'
  );
  assert.deepEqual(diagnostic.data.unexecutedOrdinals, [2, 3]);
  assert.deepEqual(
    diagnostic.data.orderedItems
      .filter((item) => item.kind === 'toolCall')
      .map((item) => ({
        ordinal: item.ordinal,
        operationId: item.operationId,
        status: item.status,
        settlementReason: item.settlementReason,
      })),
    expectedSettlement
  );
  assert.equal(
    diagnostic.data.status,
    'blocked'
  );
  assertOrdered(harness.traceSince(traceStart), [
    (entry) =>
      entry === 'persistence.persistInput:input-aborts-multi-queue',
    (entry) =>
      entry.startsWith('projection.project:diagnostic:')
      && entry.includes(providerTurnId),
    (entry) => entry.startsWith('kernel.advanceControlEpoch:'),
    (entry) => entry.startsWith('kernel.queryFacts:'),
  ]);

  const cancelHarness = await openSessionHarness();
  cancelHarness.enqueueProvider(providerToolIntents([
    {
      callId: 'provider-call-before-run-cancel-1',
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
    {
      callId: 'provider-call-before-run-cancel-2',
      toolId: 'fs.read',
      arguments: { path: 'notes/context.md' },
    },
    {
      callId: 'provider-call-before-run-cancel-3',
      toolId: 'fs.read',
      arguments: { path: 'notes/other.md' },
    },
  ]));
  cancelHarness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(cancelHarness, request, {
      invocationId: 'invocation-before-run-cancel',
      attemptId: 'attempt-before-run-cancel',
      admissionFactId: 'fact-before-run-cancel-admitted',
    })
  );
  const beforeCancel = await cancelHarness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(beforeCancel.kind, 'admitted');
  const cancelQueueBefore =
    cancelHarness.loop.snapshot().providerToolCallQueue;
  assert.deepEqual(
    cancelQueueBefore.calls.map((call) => call.status),
    ['awaitingInvocation', 'pending', 'pending']
  );
  assert.equal(cancelHarness.calls('submitToolIntent').length, 1);
  const cancelProviderTurnId = cancelQueueBefore.providerTurnId;
  const cancelOperationIds = cancelQueueBefore.calls.map(
    (call) => call.intent.operationId
  );
  const cancelledTailOperationIds = new Set(
    cancelOperationIds.slice(1)
  );

  const cancellationFactId =
    'fact-explicit-run-cancellation-requested';
  const cancelRequestId = 'cancel-explicit-run-cancellation';
  cancelHarness.enqueueKernel('cancelInvocation', (request) => {
    assert.deepEqual(request.target, {
      kind: 'currentForRun',
      data: {},
    });
    assert.equal(request.reasonCode, 'userRequested');
    const fact = corpusFact('controlCancellationRequested', {
      factId: cancellationFactId,
      ledgerSequence: cancelHarness.nextFactSequence(),
      runSequence: cancelHarness.nextRunSequence(),
      identities: {
        runId: cancelHarness.initial.runId,
        cancellationInvocationId: 'invocation-before-run-cancel',
        cancelRequestId,
        epochAdvancedFactId: request.requestId,
      },
    });
    fact.lineage.controlEpoch = request.expectedControlEpoch;
    fact.details.identity.controlEpoch = request.expectedControlEpoch;
    fact.details.source = 'explicitCommand';
    fact.details.reasonCode = 'userRequested';
    fact.details.reason =
      'The trusted user requested this Session Run to stop.';
    cancelHarness.appendFacts(fact);
    return {
      kind: 'requested',
      data: {
        cancelRequestId,
        invocationId: 'invocation-before-run-cancel',
        factId: cancellationFactId,
        ledgerSequence: cancelHarness.kernelState.snapshotHighWater,
      },
    };
  });
  const project = cancelHarness.ports.projection.project.bind(
    cancelHarness.ports.projection
  );
  cancelHarness.ports.projection.project = async (event) => {
    await project(event);
    return {
      delivered: true,
      projectionId: event.projectionId,
      projectionDigest: sha256Hash(canonicalJson(event)),
    };
  };
  const callerRequestId = 'caller-request-explicit-run-cancel';
  const cancelOperationId = 'operation-explicit-run-cancel';
  const callerRequestDigest = sha256Hash(canonicalJson({
    callerRequestId,
    cancelOperationId,
  }));
  const cancelTraceStart = cancelHarness.store.trace.length;
  const cancelled = await cancelHarness.loop.cancelRun({
    callerRequestId,
    callerRequestDigest,
    cancelOperationId,
  });

  const cancelOutcomes = cancelHarness.loop.snapshot().providerOutcomes.filter(
    (outcome) => outcome.providerTurnId === cancelProviderTurnId
  );
  assert.equal(
    cancelOutcomes.length,
    1,
    'Run cancellation must record the Provider outcome exactly once'
  );
  const [cancelOutcome] = cancelOutcomes;
  assert.equal(cancelOutcome.outputKind, 'toolIntent');
  assert.equal(cancelOutcome.toolSettlement.status, 'aborted');
  assert.equal(cancelOutcome.toolCallReceipt.callCount, 3);
  assert.match(cancelOutcome.summary, /runCancelled/u);
  assert.match(cancelOutcome.summary, /unexecuted=2/u);
  const expectedCancelSettlement = cancelOperationIds.map(
    (operationId, index) => ({
      ordinal: index + 1,
      operationId,
      status: index === 0 ? 'aborted' : 'unexecuted',
      settlementReason: 'runCancelled',
    })
  );
  assert.deepEqual(
    cancelOutcome.toolCalls.map((call) => ({
      ordinal: call.ordinal,
      operationId: call.operationId,
      status: call.status,
      settlementReason: call.settlementReason,
    })),
    expectedCancelSettlement,
    'Run cancellation must preserve Provider call order durably'
  );
  assert.equal(
    cancelHarness.calls('submitToolIntent').length,
    1,
    'Run cancellation must not dispatch any queued tail call'
  );
  assert.equal(
    cancelHarness.providerInputs.length,
    1,
    'Run cancellation must not repeat the cancelled Provider turn'
  );
  assert.equal(
    cancelHarness.kernelState.facts.some((fact) =>
      cancelledTailOperationIds.has(fact.lineage.operationId)
    ),
    false,
    'Run-cancelled tail calls must have no submit, attempt, or effect fact'
  );
  assert.equal(cancelHarness.calls('cancelInvocation').length, 1);
  assert.equal(
    cancelHarness.kernelState.facts.some(
      (fact) =>
        fact.factId === cancellationFactId
        && fact.domain === 'control'
        && fact.factKind === 'cancellationRequested'
        && fact.details.source === 'explicitCommand'
        && fact.details.reasonCode === 'userRequested'
    ),
    true,
    'Run cancellation must reconcile its canonical explicit cancellation fact'
  );
  const cancelDiagnostics = cancelHarness.store.projectionEvents.filter(
    (event) =>
      event.kind === 'diagnostic'
      && event.data?.providerTurnId === cancelProviderTurnId
      && event.data?.reason === 'runCancelled'
  );
  assert.equal(cancelDiagnostics.length, 1);
  const [cancelDiagnostic] = cancelDiagnostics;
  assert.equal(cancelDiagnostic.data.status, 'blocked');
  assert.deepEqual(
    cancelDiagnostic.data.toolCallReceipt,
    cancelOutcome.toolCallReceipt,
    'Run cancellation diagnostic must carry the recorded receipt'
  );
  assert.deepEqual(cancelDiagnostic.data.unexecutedOrdinals, [2, 3]);
  assert.deepEqual(
    cancelDiagnostic.data.orderedItems
      .filter((item) => item.kind === 'toolCall')
      .map((item) => ({
        ordinal: item.ordinal,
        operationId: item.operationId,
        status: item.status,
        settlementReason: item.settlementReason,
      })),
    expectedCancelSettlement
  );
  assertOrdered(cancelHarness.traceSince(cancelTraceStart), [
    (entry) =>
      entry.startsWith('projection.project:diagnostic:')
      && entry.includes(cancelProviderTurnId),
    (entry) => entry.startsWith('kernel.cancelInvocation:'),
    (entry) => entry.startsWith('kernel.queryFacts:'),
    (entry) => entry.startsWith('projection.project:run.cancelled:'),
  ]);
  assert.deepEqual(cancelled, {
    callerRequestId,
    callerRequestDigest,
    cancelOperationId,
    controlEpoch: cancelHarness.initial.controlEpoch,
    cancellation: {
      kind: 'requested',
      data: {
        cancelRequestId,
        invocationId: 'invocation-before-run-cancel',
        factId: cancellationFactId,
        ledgerSequence: cancelHarness.kernelState.snapshotHighWater,
      },
    },
    facts: {
      afterLedgerSequence:
        cancelHarness.kernelState.snapshotHighWater,
      snapshotHighWater:
        cancelHarness.kernelState.snapshotHighWater,
      runSequenceHighWater:
        cancelHarness.kernelState.facts.length,
      caughtUp: true,
      pendingFactBarrierCount: 0,
    },
    projection: {
      projectionId:
        `run:${cancelHarness.initial.runId}:cancel:${cancelOperationId}:settled`,
      projectionDigest: cancelled.projection.projectionDigest,
    },
  });
}

async function lateProviderOutputIsStaleAfterTheInputFence() {
  const harness = await openSessionHarness();
  const providerStarted = deferred();
  const providerOutput = deferred();
  harness.enqueueProvider(async (input) => {
    providerStarted.resolve(input);
    return providerOutput.promise;
  });

  const oldTurn = harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  await providerStarted.promise;

  const nextInput = createInput({
    inputId: 'input-supersedes-provider',
    opaqueInputRef: 'session-input:supersedes-provider',
    text: 'Use this newer request instead.',
    recordedAt: '2026-07-29T00:02:00.000Z',
  });
  const generation =
    await harness.loop.persistUserInputBeforeFence(nextInput);
  providerOutput.resolve(providerAnswer('late stale answer'));

  const stale = await oldTurn;
  assert.equal(stale.kind, 'staleProviderResult');
  assert.equal(
    harness.store.projectionEvents.some(
      (event) =>
        event.kind === 'provider.completed'
        && event.data?.result?.text === 'late stale answer'
    ),
    false,
    'a late Provider answer must not cross the synchronous input fence'
  );
  assert.equal(harness.calls('submitToolIntent').length, 0);

  await harness.loop.applyFencedUserInput(nextInput, generation);
  assert.equal(
    harness.loop.snapshot().currentInputId,
    'input-supersedes-provider'
  );
}

async function planAcceptanceRequiresEveryCanonicalScopePreview() {
  const secondAction = {
    taskId: 'task-write-second',
    manifest: {
      planRevision: 'plan-two-actions',
      planActionId: 'plan-action-write-second',
      operationId: 'planned-operation-write-second',
      toolId: 'fs.write',
      scopeIntent: {
        kind: 'resourceScope',
        data: {
          requestedResources: [{
            kind: 'workspacePath',
            data: { path: 'second.txt', access: 'write' },
          }],
        },
      },
    },
    idempotencyKey: 'plan-action-idempotency-second',
    deadline: { kind: 'contractDefault', data: {} },
  };
  const first = createPlan({
    planRevision: 'plan-two-actions',
    planActionId: 'plan-action-write-first',
    operationId: 'planned-operation-write-first',
  });
  const plan = {
    ...first,
    actions: [first.actions[0], secondAction],
  };

  const partial = await openSessionHarness();
  await partial.loop.recordPlan(plan);
  partial.enqueueKernel('previewCapabilityBatch', (request) => {
    const reply = createPreviewBatch(request, partial.initial.runId);
    reply.results.pop();
    return reply;
  });
  await assert.rejects(
    partial.loop.previewPlan(plan.planRevision),
    (error) =>
      error?.code === 'session_kernel_scope_preview_batch_correlation_mismatch',
    'a partial batch reply must fail before any PlanAction preview is retained'
  );
  assert.deepEqual(partial.loop.snapshot().previews, {});

  const mismatched = await openSessionHarness();
  await mismatched.loop.recordPlan(plan);
  mismatched.enqueueKernel('previewCapabilityBatch', (request) => {
    const reply = createPreviewBatch(request, mismatched.initial.runId);
    reply.results[1].data.preview.planActionId =
      'plan-action-from-another-batch';
    return reply;
  });
  await assert.rejects(
    mismatched.loop.previewPlan(plan.planRevision),
    (error) =>
      error?.code === 'session_kernel_scope_preview_batch_correlation_mismatch',
    'every batch result must retain its exact PlanAction correlation'
  );
  assert.deepEqual(mismatched.loop.snapshot().previews, {});

  const harness = await openSessionHarness();
  await harness.loop.recordPlan(plan);
  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => createPreviewBatch(request, harness.initial.runId)
  );
  const preview = await harness.loop.previewPlan(plan.planRevision);
  assert.equal(harness.calls('previewCapabilityBatch').length, 1);
  assert.deepEqual(
    harness.calls('previewCapabilityBatch')[0].items,
    plan.actions.map((action) => ({
      planActionId: action.manifest.planActionId,
      operationId: action.manifest.operationId,
      idempotencyKey: action.idempotencyKey,
      toolId: action.manifest.toolId,
      scopeIntent: action.manifest.scopeIntent,
      deadline: action.deadline,
      origin: { kind: 'plan', data: {} },
    })),
    'the complete Plan must cross the Kernel boundary as one exact batch'
  );
  assert.deepEqual(
    preview.results.map((result) => result.data.preview.planActionId),
    plan.actions.map((action) => action.manifest.planActionId)
  );
  assert.deepEqual(
    Object.keys(harness.loop.snapshot().previews).sort(),
    plan.actions.map((action) => action.manifest.operationId).sort()
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    'atomic Plan preview executes no ToolIntent'
  );
}

async function planConfirmationRequiresEveryCurrentCanonicalPreview() {
  const incomplete = await openSessionHarness();
  const incompletePlan = await runSealedPlanningTurn(
    incomplete,
    twoActionPlanDraft(),
    'I will inspect the exact requested scopes before asking for approval.'
  );
  assert.deepEqual(
    incomplete.store.projectionEvents
      .filter((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      )
      .map((event) => event.kind),
    ['plan.commentaryReleased'],
    'sealed commentary may publish before scope settlement, but confirmation may not'
  );
  await assert.rejects(
    incomplete.loop.publishPlanConfirmationReady(
      incompletePlan.planRevision
    ),
    (error) =>
      error?.code
        === 'session_kernel_plan_confirmation_preview_mismatch'
  );
  assert.equal(incomplete.store.planDecisions.size, 0);
  assert.equal(incomplete.calls('submitToolIntent').length, 0);

  const mismatches = [
    ['plan revision', (preview) => {
      preview.planRevision = 'plan-revision-from-another-plan';
    }],
    ['PlanAction', (preview) => {
      preview.planActionId = 'plan-action-from-another-plan';
    }],
    ['operation', (preview) => {
      preview.operationId = 'operation-from-another-plan';
    }],
    ['tool', (preview) => {
      preview.toolId = 'fs.edit';
    }],
  ];
  for (const [label, mutatePreview] of mismatches) {
    const mismatched = await openSessionHarness();
    const mismatchedPlan = await runSealedPlanningTurn(
      mismatched,
      oneActionPlanDraft(),
      `I will verify the requested file scope and ${label} binding.`
    );
    mismatched.enqueueKernel('previewCapabilityBatch', (request) => {
      const reply = dynamicPlanPreviewBatch(
        request,
        mismatched.initial.runId
      );
      mutatePreview(reply.results[0].data.preview);
      return reply;
    });
    await assert.rejects(
      mismatched.loop.previewPlan(mismatchedPlan.planRevision),
      (error) =>
        error?.code
          === 'session_kernel_scope_preview_batch_correlation_mismatch',
      `${label} mismatch must fail the whole preview batch closed`
    );
    assert.deepEqual(mismatched.loop.snapshot().previews, {});
    assert.equal(mismatched.store.planDecisions.size, 0);
    assert.equal(mismatched.calls('submitToolIntent').length, 0);
  }

  const complete = await openSessionHarness();
  const completePlan = await runSealedPlanningTurn(
    complete,
    twoActionPlanDraft(),
    'I will verify both requested file scopes before asking for approval.'
  );
  complete.enqueueKernel(
    'previewCapabilityBatch',
    (request) => dynamicPlanPreviewBatch(
      request,
      complete.initial.runId
    )
  );
  await complete.loop.previewPlan(completePlan.planRevision);
  assert.equal(complete.store.planDecisions.size, 0);
  await assert.rejects(
    complete.loop.decidePlan({
      planRevision: completePlan.planRevision,
      decision: 'accept',
    }),
    (error) =>
      error?.code === 'session_kernel_plan_confirmation_required',
    'canonical previews alone cannot replace the published confirmation boundary'
  );
  const ready = await complete.loop.publishPlanConfirmationReady(
    completePlan.planRevision
  );
  const readyReplay = await complete.loop.publishPlanConfirmationReady(
    completePlan.planRevision
  );
  assert.equal(ready.planRevision, completePlan.planRevision);
  assert.deepEqual(
    readyReplay,
    ready,
    'the exact confirmation publication must replay one durable projection identity'
  );
  assert.deepEqual(
    complete.store.projectionEvents
      .filter((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      )
      .map((event) => event.kind),
    ['plan.commentaryReleased', 'plan.confirmationReady'],
    'one sealed commentary projection must precede one confirmation-ready projection'
  );
  const decision = await complete.loop.decidePlan({
    planRevision: completePlan.planRevision,
    decision: 'accept',
  });
  const replay = await complete.loop.decidePlan({
    planRevision: completePlan.planRevision,
    decision: 'accept',
  });
  assert.deepEqual(replay, decision);
  assert.equal(complete.store.planDecisions.size, 1);
  assert.equal(
    complete.store.projectionEvents.filter(
      (event) => event.kind === 'plan.decided'
    ).length,
    1,
    'exact decision replay must not duplicate public history'
  );
  assert.equal(
    complete.calls('submitToolIntent').length,
    0,
    'acceptance records authority but cannot itself execute a tool'
  );

  await assert.rejects(
    complete.loop.publishPlanConfirmationReady(
      completePlan.planRevision
    ),
    (error) =>
      error?.code === 'session_kernel_plan_confirmation_ready_stale',
    'a durable decision must stale the prior confirmation boundary'
  );
}

async function planActionTurnRequiresOneAcceptedCurrentPlanRevision() {
  const pending = await openSessionHarness();
  const { plan: pendingPlan } = await prepareConfirmablePlan(
    pending,
    oneActionPlanDraft(),
    'I will request approval before starting the planned action.'
  );
  const pendingProviderInputCount = pending.providerInputs.length;
  await assert.rejects(
    pending.loop.runProviderTurn({
      reason: 'planExecution',
      target: {
        kind: 'planAction',
        planActionId: pendingPlan.actions[0].manifest.planActionId,
      },
      remainingToolCallBudget: 1,
    }),
    (error) => error?.code === 'session_kernel_plan_acceptance_required'
  );
  assert.equal(
    pending.providerInputs.length,
    pendingProviderInputCount,
    'a pending Plan decision must stop before another Provider request'
  );
  assert.equal(pending.calls('submitToolIntent').length, 0);

  const accepted = await pending.loop.decidePlan({
    planRevision: pendingPlan.planRevision,
    decision: 'accept',
  });
  assert.equal(accepted.decision, 'accept');
  assert.equal(pending.calls('submitToolIntent').length, 0);

  pending.enqueueProvider(providerPlanActionComplete(
    'no_op',
    'plan-action-complete-accepted-action'
  ));
  const completed = await pending.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: pendingPlan.actions[0].manifest.planActionId,
    },
    remainingToolCallBudget: 1,
  });
  assert.deepEqual(completed, { kind: 'noTool' });
  assert.deepEqual(
    pending.loop.snapshot().planActionSettlements[
      pendingPlan.actions[0].manifest.planActionId
    ],
    {
      kind: 'planActionComplete',
      planRevision: pendingPlan.planRevision,
      planActionId: pendingPlan.actions[0].manifest.planActionId,
      controlEpoch: pending.loop.snapshot().controlEpoch,
      outcome: 'no_op',
      providerTurnId: pending.loop.snapshot().providerTurn.providerTurnId,
      controlCallId: 'plan-action-complete-accepted-action',
      controlArgumentsDigest: sha256Hash(canonicalJson({
        schemaVersion: 'deepcode.session.plan-action-complete.v2',
        outcome: 'no_op',
      })),
      snapshotHighWater:
        pending.loop.snapshot().lineage.cursor.snapshotHighWater,
      recordedAt:
        pending.loop.snapshot().providerOutcomes.at(-1).recordedAt,
    }
  );

  for (const decision of ['reject', 'revise']) {
    const denied = await openSessionHarness();
    const { plan: deniedPlan } = await prepareConfirmablePlan(
      denied,
      oneActionPlanDraft(),
      `I will wait for the user to ${decision} or approve this Plan.`
    );
    const deniedProviderInputCount = denied.providerInputs.length;
    const deniedDecision = await denied.loop.decidePlan({
      planRevision: deniedPlan.planRevision,
      decision,
      guidance: decision === 'reject'
        ? 'Do not modify the workspace.'
        : 'Revise the requested workspace change.',
    });
    assert.equal(deniedDecision.decision, decision);
    await assert.rejects(
      denied.loop.runProviderTurn({
        reason: 'planExecution',
        target: {
          kind: 'planAction',
          planActionId: deniedPlan.actions[0].manifest.planActionId,
        },
        remainingToolCallBudget: 1,
      }),
      (error) => error?.code === 'session_kernel_plan_acceptance_required'
    );
    await assert.rejects(
      denied.loop.publishPlanConfirmationReady(
        deniedPlan.planRevision
      ),
      (error) =>
        error?.code === 'session_kernel_plan_confirmation_ready_stale',
      `${decision} must make the prior confirmation boundary unusable`
    );
    assert.equal(
      denied.providerInputs.length,
      deniedProviderInputCount,
      `${decision} must stop before another Provider request`
    );
    assert.equal(denied.calls('submitToolIntent').length, 0);
  }
}

async function prepareConfirmablePlan(harness, draft, commentary) {
  const plan = await runSealedPlanningTurn(harness, draft, commentary);
  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => dynamicPlanPreviewBatch(
      request,
      harness.initial.runId
    )
  );
  await harness.loop.previewPlan(plan.planRevision);
  const confirmation = await harness.loop.publishPlanConfirmationReady(
    plan.planRevision
  );
  return { plan, confirmation };
}

async function runSealedPlanningTurn(harness, draft, commentary) {
  const proposalArguments = {
    schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
    plan: draft,
  };
  const proposalCallId = 'provider-plan-proposal-contract';
  const responseDigest = sha256Hash(canonicalJson({
    commentary,
    proposalArguments,
  }));
  const backendOutput = {
    kind: 'plan',
    plan: draft,
    planProposal: {
      schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
      callId: proposalCallId,
      toolName: SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
      argumentsDigest: sha256Hash(canonicalJson(proposalArguments)),
    },
    items: [{ kind: 'text', phase: 'commentary', text: commentary }],
    completion: createProviderCompletionReceipt(responseDigest, {
      hasToolCalls: true,
    }),
    providerResult: {
      providerProfileId: 'provider-profile-v2-contract',
      provider: 'contract-provider',
      model: 'contract-model',
    },
    responseDigest,
  };
  const adapter = new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        return JSON.parse(JSON.stringify(backendOutput));
      },
    },
    { now: () => '2026-07-29T00:00:00.000Z' }
  );
  const originalSet = harness.store.providerEvidence.set.bind(
    harness.store.providerEvidence
  );
  harness.store.providerEvidence.set = (providerTurnId, evidence) => {
    const terminal = evidence.terminal;
    terminal.data.orderedItems.push({
      kind: 'toolCall',
      index: terminal.data.orderedItems.length,
      callId: proposalCallId,
      name: SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
      arguments: canonicalJson(proposalArguments),
    });
    terminal.ref.recordDigest = sha256Hash(canonicalJson(terminal.data));
    return originalSet(providerTurnId, evidence);
  };
  try {
    harness.enqueueProvider((input) => adapter.requestTurn(input));
    const result = await harness.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    });
    assert.equal(result.kind, 'plan');
    return result.plan;
  } finally {
    harness.store.providerEvidence.set = originalSet;
  }
}

function oneActionPlanDraft() {
  return {
    title: 'Write reviewed output',
    objective: 'Write one file inside the workspace.',
    narrative: 'Use the approved PlanAction and report canonical facts.',
    evidence: {
      kernelFactRefs: [],
      readResources: [],
      blockingUnknowns: [],
      nonBlockingUnknowns: [],
      coverage: 'The requested workspace mutation has a complete explicit scope.',
    },
    actions: [{
      toolId: 'fs.write',
      scopeIntent: {
        kind: 'resourceScope',
        data: {
          requestedResources: [{
            kind: 'workspacePath',
            data: { path: 'output.txt', access: 'write' },
          }],
        },
      },
    }],
  };
}

function twoActionPlanDraft() {
  const first = oneActionPlanDraft();
  return {
    ...first,
    title: 'Write two reviewed outputs',
    objective: 'Write two files inside the workspace.',
    actions: [
      first.actions[0],
      {
        toolId: 'fs.write',
        scopeIntent: {
          kind: 'resourceScope',
          data: {
            requestedResources: [{
              kind: 'workspacePath',
              data: { path: 'second.txt', access: 'write' },
            }],
          },
        },
      },
    ],
  };
}

function dynamicPlanPreview(request, item, runId) {
  const requestedResources = item.scopeIntent.kind === 'resourceScope'
    ? item.scopeIntent.data.requestedResources
    : [];
  const path = item.scopeIntent.kind === 'exactInvocation'
    ? item.scopeIntent.data.rawArguments.path
    : requestedResources[0]?.data.path;
  const second = path === 'second.txt';
  const templateItem = {
    ...item,
    planActionId: second
      ? 'plan-action-write-second'
      : 'plan-action-write-first',
    operationId: second
      ? 'planned-operation-write-second'
      : 'planned-operation-write-first',
  };
  const templateRequest = {
    ...request,
    planRevision: 'plan-two-actions',
    items: [templateItem],
  };
  const preview = createPreview(templateRequest, templateItem, runId);
  return {
    ...preview,
    previewId: `preview-${item.operationId}`,
    planRevision: request.planRevision,
    planActionId: item.planActionId,
    operationId: item.operationId,
    toolId: item.toolId,
  };
}

function dynamicPlanPreviewBatch(request, runId) {
  return {
    runId,
    acceptedControlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision,
    results: request.items.map((item) => ({
      kind: 'previewed',
      data: { preview: dynamicPlanPreview(request, item, runId) },
    })),
  };
}

function assertOrdered(trace, predicates) {
  let cursor = -1;
  for (const predicate of predicates) {
    const next = trace.findIndex(
      (entry, index) => index > cursor && predicate(entry)
    );
    assert.notEqual(
      next,
      -1,
      `missing ordered trace step after index ${cursor}: ${trace.join(' | ')}`
    );
    cursor = next;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}
