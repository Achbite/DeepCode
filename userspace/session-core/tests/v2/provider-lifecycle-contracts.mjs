import {
  SESSION_PROVIDER_PLAN_PROPOSAL_V2_SCHEMA,
  SESSION_PROVIDER_PLAN_PROPOSAL_V2_TOOL_NAME,
  StrictSessionKernelProviderAdapterV2,
  canonicalJson,
  sha256Hash,
} from '../../dist/index.js';

import {
  admittedReply,
  assert,
  createInitialState,
  createProviderCompletionReceipt,
  createPreview,
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
    id: 'provider_profile_without_reasoning_transport_is_not_current_schema',
    run: providerProfileWithoutReasoningTransportIsNotCurrentSchema,
  },
  {
    id: 'planning_control_stays_private_until_native_terminal_and_confirmation_settlement',
    run: planningControlStaysPrivateUntilNativeTerminalAndConfirmationSettlement,
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

async function providerProfileWithoutReasoningTransportIsNotCurrentSchema() {
  const initial = createInitialState();
  delete initial.providerProfile.reasoningTransport;
  const harness = createSessionHarness({ initial });

  await assert.rejects(
    harness.open(),
    (error) => error?.code === 'session_kernel_provider_profile_invalid',
    'a Profile without reasoningTransport is not the current schema and cannot open a Session Run'
  );
  assert.equal(harness.providerInputs.length, 0);
  assert.equal(harness.calls('submitToolIntent').length, 0);
  assert.equal(harness.store.checkpoint, undefined);
}

async function planningControlStaysPrivateUntilNativeTerminalAndConfirmationSettlement() {
  const draft = planningDraft();
  const commentary = 'I will verify the exact file scope before requesting approval.';
  const valid = sealedPlanningOutput(draft, commentary);
  const invalid = [
    mutate(valid, (value) => {
      value.completion.nativeCompletion.terminalSignal = 'EOF';
    }),
    mutate(valid, (value) => {
      value.completion.nativeCompletion.finishReason = 'stop';
    }),
    mutate(valid, (value) => {
      value.completion.reasoningPresent = false;
    }),
    mutate(valid, (value) => {
      value.completion.trace.sealed = false;
    }),
    mutate(valid, (value) => {
      value.planProposal.toolName = 'fs.write';
    }),
    mutate(valid, (value) => {
      delete value.plan.actions[0].previewArguments.content;
      const proposalArguments = {
        schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V2_SCHEMA,
        plan: value.plan,
      };
      value.planProposal.argumentsDigest = sha256Hash(
        canonicalJson(proposalArguments)
      );
    }),
  ];

  for (const output of invalid) {
    const harness = await openSessionHarness();
    const restore = installPlanningTerminalEvidence(
      harness,
      output.plan,
      output.planProposal.callId
    );
    harness.enqueueProvider((input) =>
      strictAdapterReturning(output).requestTurn(input));
    try {
      await assert.rejects(
        harness.loop.runProviderTurn({
          reason: 'userInput',
          target: { kind: 'planning' },
        })
      );
    } finally {
      restore();
    }
    assert.equal(
      harness.store.projectionEvents.some((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      ),
      false,
      'invalid native planning evidence must publish neither commentary nor a confirmable Plan'
    );
    assert.equal(harness.calls('submitToolIntent').length, 0);
    assert.equal(harness.store.planDecisions.size, 0);
  }

  const duplicateControl = await openSessionHarness();
  const restoreDuplicateControl = installPlanningTerminalEvidence(
    duplicateControl,
    valid.plan,
    valid.planProposal.callId,
    { duplicateControl: true }
  );
  duplicateControl.enqueueProvider((input) =>
    strictAdapterReturning(valid).requestTurn(input));
  try {
    await assert.rejects(
      duplicateControl.loop.runProviderTurn({
        reason: 'userInput',
        target: { kind: 'planning' },
      }),
      (error) =>
        error?.code === 'session_kernel_provider_terminal_evidence_mismatch'
    );
  } finally {
    restoreDuplicateControl();
  }
  assert.equal(
    duplicateControl.store.projectionEvents.some((event) =>
      event.kind === 'plan.commentaryReleased'
      || event.kind === 'plan.confirmationReady'
    ),
    false,
    'planning terminal evidence must contain exactly one control call'
  );
  assert.equal(duplicateControl.calls('submitToolIntent').length, 0);

  const harness = await openSessionHarness();
  const backendStarted = deferred();
  const backendRelease = deferred();
  const adapter = new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        backendStarted.resolve();
        return await backendRelease.promise;
      },
    },
    { now: () => '2026-07-29T00:00:40.000Z' }
  );
  const restore = installPlanningTerminalEvidence(
    harness,
    draft,
    valid.planProposal.callId
  );
  harness.enqueueProvider((input) => adapter.requestTurn(input));
  const running = harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  await backendStarted.promise;
  assert.equal(
    harness.store.projectionEvents.some((event) =>
      event.kind === 'plan.commentaryReleased'
      || event.kind === 'plan.confirmationReady'
    ),
    false,
    'streaming commentary cannot cross the public planning boundary before native terminal validation'
  );
  assert.equal(harness.calls('submitToolIntent').length, 0);

  backendRelease.resolve(clone(valid));
  let result;
  try {
    result = await running;
  } finally {
    restore();
  }
  assert.equal(result.kind, 'plan');
  assert.equal(
    harness.store.projectionEvents.some((event) =>
      event.kind === 'plan.commentaryReleased'
      || event.kind === 'plan.confirmationReady'
    ),
    false,
    'a sealed Plan remains private until canonical preview settlement'
  );

  harness.enqueueKernel(
    'previewCapability',
    (request) => ({
      kind: 'previewed',
      data: {
        preview: planningPreview(
          request,
          harness.initial.runId
        ),
      },
    })
  );
  await harness.loop.previewPlanAction(
    result.plan.actions[0].manifest.planActionId,
    result.plan.planRevision
  );
  const ready = await harness.loop.publishPlanConfirmationReady(
    result.plan.planRevision
  );
  assert.equal(ready.planRevision, result.plan.planRevision);
  assert.deepEqual(
    harness.store.projectionEvents
      .filter((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      )
      .map((event) => event.kind),
    ['plan.commentaryReleased', 'plan.confirmationReady']
  );
  assert.equal(harness.calls('submitToolIntent').length, 0);

  const rejectedPreview = await openSessionHarness();
  const restoreRejectedPreview = installPlanningTerminalEvidence(
    rejectedPreview,
    valid.plan,
    valid.planProposal.callId
  );
  rejectedPreview.enqueueProvider((input) =>
    strictAdapterReturning(valid).requestTurn(input));
  let rejectedPlan;
  try {
    rejectedPlan = await rejectedPreview.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    });
  } finally {
    restoreRejectedPreview();
  }
  rejectedPreview.enqueueKernel(
    'previewCapability',
    (request) => ({
      kind: 'rejected',
      data: {
        toolId: request.manifest.toolId,
        reason: 'settingsDenied',
        guidance: 'Revise the requested scope before asking for approval.',
      },
    })
  );
  const rejectedReply = await rejectedPreview.loop.previewPlanAction(
    rejectedPlan.plan.actions[0].manifest.planActionId,
    rejectedPlan.plan.planRevision
  );
  assert.equal(rejectedReply.kind, 'rejected');
  await assert.rejects(
    rejectedPreview.loop.publishPlanConfirmationReady(
      rejectedPlan.plan.planRevision
    ),
    (error) =>
      error?.code === 'session_kernel_plan_confirmation_preview_incomplete'
  );
  assert.equal(
    rejectedPreview.store.projectionEvents.some((event) =>
      event.kind === 'plan.commentaryReleased'
      || event.kind === 'plan.confirmationReady'
    ),
    false,
    'a rejected canonical preview must keep planning commentary private'
  );
  assert.equal(rejectedPreview.calls('submitToolIntent').length, 0);

  const confirmationFailure = await openSessionHarness();
  const restoreConfirmationFailure = installPlanningTerminalEvidence(
    confirmationFailure,
    valid.plan,
    valid.planProposal.callId
  );
  confirmationFailure.enqueueProvider((input) =>
    strictAdapterReturning(valid).requestTurn(input));
  let confirmationPlan;
  try {
    confirmationPlan = await confirmationFailure.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    });
  } finally {
    restoreConfirmationFailure();
  }
  confirmationFailure.enqueueKernel(
    'previewCapability',
    (request) => ({
      kind: 'previewed',
      data: {
        preview: planningPreview(
          request,
          confirmationFailure.initial.runId
        ),
      },
    })
  );
  await confirmationFailure.loop.previewPlanAction(
    confirmationPlan.plan.actions[0].manifest.planActionId,
    confirmationPlan.plan.planRevision
  );
  const project = confirmationFailure.ports.projection.project.bind(
    confirmationFailure.ports.projection
  );
  confirmationFailure.ports.projection.project = async (event) => {
    if (event.kind === 'plan.confirmationReady') {
      throw new Error('controlled_confirmation_projection_failure');
    }
    return project(event);
  };
  await assert.rejects(
    confirmationFailure.loop.publishPlanConfirmationReady(
      confirmationPlan.plan.planRevision
    ),
    /controlled_confirmation_projection_failure/u
  );
  assert.equal(
    confirmationFailure.store.projectionEvents.some((event) =>
      event.kind === 'plan.commentaryReleased'
      || event.kind === 'plan.confirmationReady'
    ),
    false,
    'commentary and confirmation must publish atomically or remain private together'
  );
  assert.equal(confirmationFailure.calls('submitToolIntent').length, 0);
}

function sealedPlanningOutput(draft, commentary) {
  const proposalArguments = {
    schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V2_SCHEMA,
    plan: draft,
  };
  const responseDigest = sha256Hash(canonicalJson({
    commentary,
    proposalArguments,
  }));
  return {
    kind: 'plan',
    plan: clone(draft),
    planProposal: {
      schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V2_SCHEMA,
      callId: 'provider-plan-lifecycle-contract',
      toolName: SESSION_PROVIDER_PLAN_PROPOSAL_V2_TOOL_NAME,
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
}

function planningDraft() {
  return {
    title: 'Write reviewed output',
    objective: 'Write one exact workspace file.',
    narrative: 'Preview the exact scope before requesting approval.',
    actions: [{
      toolId: 'fs.write',
      requestedResources: [{
        kind: 'workspacePath',
        data: { path: 'output.txt', access: 'write' },
      }],
      previewArguments: {
        path: 'output.txt',
        content: 'contract output',
      },
    }],
  };
}

function installPlanningTerminalEvidence(
  harness,
  draft,
  callId,
  options = {}
) {
  const map = harness.store.providerEvidence;
  const originalSet = map.set;
  const proposalArguments = {
    schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V2_SCHEMA,
    plan: draft,
  };
  map.set = function setPlanningEvidence(providerTurnId, evidence) {
    const terminal = evidence.terminal;
    terminal.data.orderedItems.push({
      kind: 'toolCall',
      index: terminal.data.orderedItems.length,
      callId,
      name: SESSION_PROVIDER_PLAN_PROPOSAL_V2_TOOL_NAME,
      arguments: canonicalJson(proposalArguments),
    });
    if (options.duplicateControl) {
      terminal.data.orderedItems.push({
        kind: 'toolCall',
        index: terminal.data.orderedItems.length,
        callId: `${callId}-duplicate`,
        name: SESSION_PROVIDER_PLAN_PROPOSAL_V2_TOOL_NAME,
        arguments: canonicalJson(proposalArguments),
      });
    }
    terminal.ref.recordDigest = sha256Hash(canonicalJson(terminal.data));
    return originalSet.call(this, providerTurnId, evidence);
  };
  return () => {
    map.set = originalSet;
  };
}

function planningPreview(request, runId) {
  const template = createPreview({
    ...request,
    manifest: {
      planRevision: 'plan-two-actions',
      planActionId: 'plan-action-write-first',
      operationId: 'planned-operation-write-first',
      toolId: 'fs.write',
      requestedResources: request.manifest.requestedResources,
    },
  }, runId);
  return {
    ...template,
    previewId: `preview-${request.manifest.operationId}`,
    planRevision: request.manifest.planRevision,
    planActionId: request.manifest.planActionId,
    operationId: request.manifest.operationId,
    toolId: request.manifest.toolId,
  };
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
