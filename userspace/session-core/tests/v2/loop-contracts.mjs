import {
  admittedReply,
  assert,
  corpusFact,
  createInput,
  createPlan,
  createPreview,
  openSessionHarness,
  providerAnswer,
  providerToolIntent,
  providerToolIntents,
} from './harness.mjs';
import {
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
  const supersededQueue =
    harness.loop.snapshot().providerToolCallQueue;
  assert.equal(supersededQueue.status, 'aborted');
  assert.equal(supersededQueue.abortReason, 'userInput');
  assert.equal(supersededQueue.calls[0].status, 'aborted');
  assert.equal(supersededQueue.outcomeRecorded, true);
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

  const nextInput = createInput({
    inputId: 'input-aborts-multi-queue',
    opaqueInputRef: 'session-input:aborts-multi-queue',
    text: 'Supersede the complete queued tool sequence.',
    recordedAt: '2026-07-29T00:02:30.000Z',
  });
  const generation =
    await harness.loop.persistUserInputBeforeFence(nextInput);
  await harness.loop.applyFencedUserInput(nextInput, generation);

  const queue = harness.loop.snapshot().providerToolCallQueue;
  assert.equal(queue.status, 'aborted');
  assert.equal(queue.abortReason, 'userInput');
  assert.equal(queue.outcomeRecorded, true);
  assert.deepEqual(
    queue.calls.map((call) => call.status),
    ['aborted', 'unexecuted', 'unexecuted']
  );
  assert.deepEqual(
    queue.calls.slice(1).map((call) => call.settlementReason),
    ['userInput', 'userInput']
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    1,
    'the input fence must not dispatch any queued tail call'
  );
  const unexecutedOperationIds = new Set(
    queue.calls.slice(1).map((call) => call.intent.operationId)
  );
  assert.equal(
    harness.kernelState.facts.some((fact) =>
      unexecutedOperationIds.has(fact.lineage.operationId)
    ),
    false,
    'unexecuted tail calls must have no attempt or effect fact'
  );
  assert.equal(
    harness.store.projectionEvents.some(
      (event) =>
        event.kind === 'diagnostic'
        && event.data?.status === 'blocked'
        && event.data?.reason === 'userInput'
        && event.data?.unexecutedOrdinals?.join(',') === '2,3'
    ),
    true
  );

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
  const cancelled = await cancelHarness.loop.cancelRun({
    callerRequestId,
    callerRequestDigest,
    cancelOperationId,
  });

  const cancelQueue =
    cancelHarness.loop.snapshot().providerToolCallQueue;
  assert.equal(cancelQueue.status, 'aborted');
  assert.equal(cancelQueue.abortReason, 'runCancelled');
  assert.equal(cancelQueue.outcomeRecorded, true);
  assert.deepEqual(
    cancelQueue.calls.map((call) => call.status),
    ['aborted', 'unexecuted', 'unexecuted']
  );
  assert.deepEqual(
    cancelQueue.calls.slice(1).map((call) => call.settlementReason),
    ['runCancelled', 'runCancelled']
  );
  assert.equal(
    cancelHarness.calls('submitToolIntent').length,
    1,
    'Run cancellation must not dispatch any queued tail call'
  );
  const cancelledTailOperationIds = new Set(
    cancelQueue.calls.slice(1).map((call) => call.intent.operationId)
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
  assert.equal(
    cancelHarness.store.projectionEvents.some(
      (event) =>
        event.kind === 'diagnostic'
        && event.data?.status === 'blocked'
        && event.data?.reason === 'runCancelled'
        && event.data?.unexecutedOrdinals?.join(',') === '2,3'
    ),
    true
  );
  assert.equal(
    cancelHarness.loop.snapshot().providerOutcomes.some(
      (outcome) =>
        outcome.providerTurnId === cancelQueue.providerTurnId
        && outcome.outputKind === 'toolIntent'
        && outcome.toolCallReceipt?.callCount === 3
        && outcome.summary.includes('runCancelled')
    ),
    true,
    'Run cancellation must durably record the whole Provider queue outcome'
  );
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
  const harness = await openSessionHarness();
  const secondAction = {
    taskId: 'task-write-second',
    manifest: {
      planRevision: 'plan-two-actions',
      planActionId: 'plan-action-write-second',
      operationId: 'planned-operation-write-second',
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
  await harness.loop.recordPlan(plan);

  await assert.rejects(
    harness.loop.decidePlan({
      planRevision: plan.planRevision,
      decision: 'accept',
    }),
    (error) =>
      error?.code === 'session_kernel_plan_scope_preview_required'
  );

  harness.enqueueKernel(
    'previewCapability',
    (request) => ({
      kind: 'previewed',
      data: { preview: createPreview(request, harness.initial.runId) },
    })
  );
  await harness.loop.previewPlanAction(
    'plan-action-write-first',
    plan.planRevision
  );
  await assert.rejects(
    harness.loop.decidePlan({
      planRevision: plan.planRevision,
      decision: 'accept',
    }),
    (error) =>
      error?.code === 'session_kernel_plan_scope_preview_required'
  );

  harness.enqueueKernel(
    'previewCapability',
    (request) => ({
      kind: 'previewed',
      data: {
        preview: createPreview(request, harness.initial.runId),
      },
    })
  );
  await harness.loop.previewPlanAction(
    'plan-action-write-second',
    plan.planRevision
  );
  const decision = await harness.loop.decidePlan({
    planRevision: plan.planRevision,
    decision: 'accept',
  });
  assert.equal(decision.decision, 'accept');
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    'Plan acceptance records authority intent but executes nothing'
  );
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
