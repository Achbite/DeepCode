import {
  StrictSessionKernelProviderAdapterV2,
  canonicalJson,
  sha256Hash,
} from '../../dist/index.js';

import {
  admittedReply,
  assert,
  createInitialState,
  createProviderCompletionReceipt,
  createSessionHarness,
  openSessionHarness,
  providerOrderedToolItems,
} from './harness.mjs';

export const contractCases = [
  {
    id: 'provider_native_stream_completion_and_reasoning_gate',
    run: providerNativeStreamCompletionAndReasoningGate,
  },
  {
    id: 'provider_protocol_phase_and_final_tool_conflicts_fail_before_admission',
    run: providerProtocolPhaseAndFinalToolConflictsFailBeforeAdmission,
  },
  {
    id: 'tool_admission_waits_for_native_done_validation_and_durable_queue',
    run: toolAdmissionWaitsForNativeDoneValidationAndDurableQueue,
  },
  {
    id: 'provider_tool_call_queue_accepts_one_to_thirty_two_in_order',
    run: providerToolCallQueueAcceptsOneToThirtyTwoInOrder,
  },
  {
    id: 'legacy_provider_profile_without_reasoning_transport_fails_closed',
    run: legacyProviderProfileWithoutReasoningTransportFailsClosed,
  },
];

async function providerNativeStreamCompletionAndReasoningGate() {
  const calls = providerCalls(1, 'native-gate');
  const valid = sealedNativeToolOutput(calls);
  const invalidOutputs = [
    {
      label: 'native completion marker',
      output: mutate(valid, (value) => {
        value.completion.nativeCompletion.terminalSignal = 'EOF';
      }),
    },
    {
      label: 'plaintext reasoning evidence',
      output: mutate(valid, (value) => {
        value.completion.reasoningPresent = false;
      }),
    },
    {
      label: 'durable trace seal',
      output: mutate(valid, (value) => {
        value.completion.trace.sealed = false;
      }),
    },
  ];

  for (const invalid of invalidOutputs) {
    const harness = await openSessionHarness();
    const adapter = strictAdapterReturning(invalid.output);
    harness.enqueueProvider((input) => adapter.requestTurn(input));

    await assert.rejects(
      harness.loop.runProviderTurn({
        reason: 'userInput',
        target: { kind: 'planning' },
      }),
      (error) =>
        error?.code === 'session_kernel_provider_completion_receipt_invalid',
      `${invalid.label} must be validated before Session admission`
    );
    assert.equal(
      harness.calls('submitToolIntent').length,
      0,
      `${invalid.label} failure must admit zero Kernel effects`
    );
    assert.equal(
      harness.loop.snapshot().providerToolCallQueue,
      undefined,
      `${invalid.label} failure must not persist a partial tool queue`
    );
    assert.equal(harness.loop.snapshot().providerTurn.status, 'failed');
  }
}

async function providerProtocolPhaseAndFinalToolConflictsFailBeforeAdmission() {
  const calls = providerCalls(1, 'phase-conflict');
  const toolItem = providerOrderedToolItems(calls)[0];
  const finalWithTool = sealedNativeToolOutput(calls, {
    items: [
      { kind: 'text', phase: 'final_answer', text: 'Final answer.' },
      toolItem,
    ],
  });
  const finalThenCommentary = sealedTextOutput(
    'Final answer followed by late commentary.',
    [
      { kind: 'text', phase: 'final_answer', text: 'Final answer.' },
      { kind: 'text', phase: 'commentary', text: 'Late commentary.' },
    ]
  );

  for (const [label, output] of [
    ['final answer plus tool call', finalWithTool],
    ['commentary after final answer', finalThenCommentary],
  ]) {
    const harness = await openSessionHarness();
    const adapter = strictAdapterReturning(output);
    harness.enqueueProvider((input) => adapter.requestTurn(input));

    await assert.rejects(
      harness.loop.runProviderTurn({
        reason: 'userInput',
        target: { kind: 'planning' },
      }),
      (error) => error?.code === 'session_kernel_provider_phase_conflict',
      `${label} must fail the complete Provider response`
    );
    assert.equal(
      harness.calls('submitToolIntent').length,
      0,
      `${label} must fail before any ToolIntent submission`
    );
    assert.equal(harness.loop.snapshot().providerToolCallQueue, undefined);
    assert.equal(harness.loop.snapshot().providerTurn.status, 'failed');
  }
}

async function toolAdmissionWaitsForNativeDoneValidationAndDurableQueue() {
  const harness = await openSessionHarness();
  const calls = providerCalls(2, 'durable-admission');
  const response = sealedNativeToolOutput(calls);
  const backendStarted = deferred();
  const backendRelease = deferred();
  const adapter = new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        backendStarted.resolve();
        return await backendRelease.promise;
      },
    },
    { now: () => '2026-07-29T00:00:30.000Z' }
  );
  harness.enqueueProvider((input) => adapter.requestTurn(input));
  let checkpointObservedAtKernelAdmission = false;
  harness.enqueueKernel('submitToolIntent', (request) => {
    const checkpoint = harness.store.checkpoint;
    const state = checkpoint?.state;
    assert.equal(
      state?.providerTurn?.response?.completion?.trace?.sealed,
      true,
      'the sealed complete response must be checkpointed before Kernel admission'
    );
    assert.equal(
      state?.providerTurn?.response?.completion?.responseDigest,
      response.responseDigest
    );
    assert.deepEqual(
      state?.providerToolCallQueue?.calls.map((call) => call.status),
      ['submitting', 'pending'],
      'the ordered queue and first submitting identity must be durable before dispatch'
    );
    assert.deepEqual(
      state?.providerToolCallQueue?.receipt.calls.map((call) => call.callId),
      calls.map((call) => call.callId)
    );
    checkpointObservedAtKernelAdmission = true;
    return admittedReply(harness, request, {
      invocationId: 'invocation-durable-admission-1',
      attemptId: 'attempt-durable-admission-1',
    });
  });

  const running = harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  await backendStarted.promise;
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    'a partial Provider response cannot reach Kernel admission'
  );
  assert.equal(
    harness.loop.snapshot().providerToolCallQueue,
    undefined,
    'Session must not synthesize a queue before the complete response is validated'
  );

  backendRelease.resolve(response);
  const result = await running;
  assert.equal(result.kind, 'admitted');
  assert.equal(checkpointObservedAtKernelAdmission, true);
  assert.equal(harness.calls('submitToolIntent').length, 1);
  const trace = harness.store.trace;
  const providerRequestIndex = trace.findIndex((entry) =>
    entry.startsWith('provider.requestTurn:'));
  const kernelSubmissionIndex = trace.findIndex((entry) =>
    entry.startsWith('kernel.submitToolIntent:'));
  const durableCheckpoints = trace
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) =>
      entry.startsWith('persistence.persistCheckpoint:')
      && index > providerRequestIndex
      && index < kernelSubmissionIndex);
  assert.equal(
    durableCheckpoints.length >= 3,
    true,
    'response receipt, queue creation, and submitting identity each require a pre-dispatch checkpoint'
  );
}

async function providerToolCallQueueAcceptsOneToThirtyTwoInOrder() {
  for (const count of Array.from({ length: 32 }, (_, index) => index + 1)) {
    const harness = await openSessionHarness();
    const calls = providerCalls(count, `ordered-${count}`);
    const adapter = strictAdapterReturning(
      sealedNativeToolOutput(calls)
    );
    harness.enqueueProvider((input) => adapter.requestTurn(input));
    harness.enqueueKernel('submitToolIntent', (request) =>
      admittedReply(harness, request, {
        invocationId: `invocation-ordered-boundary-${count}`,
        attemptId: `attempt-ordered-boundary-${count}`,
      }));

    const result = await harness.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    });
    assert.equal(result.kind, 'admitted');
    const queue = harness.loop.snapshot().providerToolCallQueue;
    assert.equal(queue.calls.length, count);
    assert.deepEqual(
      queue.receipt.calls.map((call) => call.ordinal),
      Array.from({ length: count }, (_, index) => index + 1)
    );
    assert.deepEqual(
      queue.receipt.calls.map((call) => call.callId),
      calls.map((call) => call.callId)
    );
    assert.deepEqual(
      queue.orderedItems.map((item) => item.ordinal),
      Array.from({ length: count }, (_, index) => index + 1)
    );
    assert.deepEqual(
      queue.calls.map((call) => call.status),
      ['awaitingInvocation', ...Array(count - 1).fill('pending')],
      'only the first durable queue item may be submitted initially'
    );
    assert.equal(
      new Set(queue.calls.map((call) => call.intent.operationId)).size,
      count
    );
    assert.equal(harness.calls('submitToolIntent').length, 1);
  }
}

async function legacyProviderProfileWithoutReasoningTransportFailsClosed() {
  const initial = createInitialState();
  delete initial.providerProfile.reasoningTransport;
  const harness = createSessionHarness({ initial });

  await assert.rejects(
    harness.open(),
    (error) => error?.code === 'session_kernel_provider_profile_invalid',
    'an old Profile without reasoningTransport must remain visible only to Host migration UI and cannot open a Session Run'
  );
  assert.equal(harness.providerInputs.length, 0);
  assert.equal(harness.calls('submitToolIntent').length, 0);
  assert.equal(harness.store.checkpoint, undefined);
}

function strictAdapterReturning(output) {
  return new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        return clone(output);
      },
    },
    { now: () => '2026-07-29T00:00:20.000Z' }
  );
}

function sealedNativeToolOutput(calls, overrides = {}) {
  const normalized = calls.map((call) => ({
    callId: call.callId,
    toolName: call.toolName ?? call.toolId,
    toolId: call.toolId,
    arguments: clone(call.arguments),
  }));
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'nativeToolCalls',
    calls: normalized,
  }));
  return {
    kind: 'nativeToolCalls',
    calls: normalized,
    items: clone(overrides.items ?? providerOrderedToolItems(normalized)),
    completion: clone(overrides.completion
      ?? createProviderCompletionReceipt(responseDigest, {
        hasToolCalls: true,
      })),
    providerResult: {
      providerProfileId: 'provider-profile-v2-contract',
      provider: 'contract-provider',
      model: 'contract-model',
    },
    responseDigest,
  };
}

function sealedTextOutput(text, items) {
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'text',
    items,
  }));
  return {
    kind: 'text',
    text,
    items: clone(items),
    completion: createProviderCompletionReceipt(responseDigest),
    providerResult: {
      providerProfileId: 'provider-profile-v2-contract',
      provider: 'contract-provider',
      model: 'contract-model',
    },
    responseDigest,
  };
}

function providerCalls(count, label) {
  return Array.from({ length: count }, (_, index) => ({
    callId: `provider-call-${label}-${index + 1}`,
    toolName: `read_file_${index + 1}`,
    toolId: 'fs.read',
    arguments: { path: 'README.md' },
  }));
}

function mutate(value, mutation) {
  const result = clone(value);
  mutation(result);
  return result;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
