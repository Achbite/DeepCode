import {
  StrictSessionKernelProviderAdapterV2,
  normalizeProviderKernelToolIntentV2,
  providerCallableToolsV2,
  providerWireToolNameV2,
  recordSessionToolIntentSubmissionV2,
  sha256Hash,
  canonicalJson,
} from '../../dist/index.js';

import {
  DECISION_CAPABILITY_SECRET,
  RUN_CAPABILITY_SECRET,
  admittedReply,
  assert,
  corpusFact,
  createProviderCompletionReceipt,
  createPlan,
  createPlanDiscoveryPreviewBatch,
  createToolContext,
  openSessionHarness,
  persistPreviewAndAcceptPlan,
  providerAnswer,
  providerOrderedToolItems,
  providerToolIntent,
  providerToolIntents,
  toolContextRef,
} from './harness.mjs';

// Supporting development contracts only. Product acceptance still requires the
// real Provider CLI/GUI/TUI path; these cases must never add text parsers or
// sample-specific production branches to manufacture a successful tool call.

export const contractCases = [
  {
    id: 'tool_context_is_injected_verbatim_without_transport_secrets',
    run: toolContextIsInjectedVerbatimWithoutTransportSecrets,
  },
  {
    id: 'provider_native_call_becomes_one_strict_context_read_intent',
    run: providerNativeCallBecomesOneStrictContextReadIntent,
  },
  {
    id: 'provider_native_calls_create_safe_ordered_queue_and_serialize_submission',
    run: providerNativeCallsCreateSafeOrderedQueueAndSerializeSubmission,
  },
  {
    id: 'provider_tool_call_envelope_is_bounded_before_submission',
    run: providerToolCallEnvelopeIsBoundedBeforeSubmission,
  },
  {
    id: 'ordinary_narration_never_submits_an_intent',
    run: ordinaryNarrationNeverSubmitsAnIntent,
  },
  {
    id: 'plan_action_authority_comes_from_persisted_session_state',
    run: planActionAuthorityComesFromPersistedSessionState,
  },
];

async function toolContextIsInjectedVerbatimWithoutTransportSecrets() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(providerAnswer('provider-safe answer'));

  const result = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });

  assert.deepEqual(result, {
    kind: 'answer',
    text: 'provider-safe answer',
  });
  assert.equal(harness.providerInputs.length, 1);
  const input = harness.providerInputs[0];
  assert.deepEqual(
    input.toolContext.bundle,
    harness.initial.toolContext,
    'Session must transport the Kernel-owned bundle without rewriting it'
  );
  assert.equal(
    input.toolContext.fixedPrompt,
    harness.initial.toolContext.fixedPrompt
  );
  assert.deepEqual(
    input.toolContext.tools,
    harness.initial.toolContext.tools
  );
  assert.equal(
    input.contextAssembly.messages[0].content,
    harness.initial.toolContext.fixedPrompt,
    'the first Provider system message must be the exact Kernel prompt'
  );

  const providerJson = JSON.stringify(input);
  assert.equal(providerJson.includes(RUN_CAPABILITY_SECRET), false);
  assert.equal(
    providerJson.includes(DECISION_CAPABILITY_SECRET),
    false
  );
  assert.equal(providerJson.includes('runCapability'), false);
  assert.equal(providerJson.includes('decisionCapability'), false);
}

async function providerNativeCallBecomesOneStrictContextReadIntent() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(
    providerToolIntent(
      'fs.read',
      { path: 'README.md' },
      'provider-call-read-1'
    )
  );
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request)
  );

  const result = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });

  assert.equal(result.kind, 'admitted');
  const submissions = harness.calls('submitToolIntent');
  assert.equal(
    submissions.length,
    1,
    'one structural Provider call must submit exactly one ToolIntent'
  );
  const intent = submissions[0].intent;
  assert.equal(intent.runId, harness.initial.runId);
  assert.equal(intent.expectedControlEpoch, 1);
  assert.equal(
    typeof intent.operationId === 'string'
      && intent.operationId.length > 0,
    true
  );
  assert.equal(
    typeof intent.idempotencyKey === 'string'
      && intent.idempotencyKey.length > 0,
    true
  );
  assert.equal(intent.toolId, 'fs.read');
  assert.deepEqual(intent.rawArguments, { path: 'README.md' });
  assert.deepEqual(intent.authority, {
    kind: 'read',
    data: {
      purpose: 'Session planning context read using fs.read.',
    },
  });
  assert.deepEqual(
    intent.toolContextRef,
    toolContextRef(harness.initial.toolContext)
  );
  assert.equal('lease' in intent, false);
  assert.equal(
    JSON.stringify(submissions[0]).includes(RUN_CAPABILITY_SECRET),
    false
  );

  const replay = await openSessionHarness();
  replay.enqueueProvider(
    providerToolIntent(
      'fs.read',
      { path: 'README.md' },
      'provider-call-read-1'
    )
  );
  replay.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(replay, request)
  );
  await replay.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.deepEqual(
    replay.calls('submitToolIntent')[0].intent,
    intent,
    'the same semantic Provider call must reproduce the same Session identity'
  );
}

async function providerNativeCallsCreateSafeOrderedQueueAndSerializeSubmission() {
  const harness = await openSessionHarness();
  const providerToolName = providerWireToolNameV2('fs.read');
  const backendCalls = [
    {
      callId: 'provider-call-ordered-read-1',
      toolName: providerToolName,
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
    {
      callId: 'provider-call-ordered-read-2',
      toolName: providerToolName,
      toolId: 'fs.read',
      arguments: { path: 'README.md' },
    },
  ];
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'nativeToolCalls',
    calls: backendCalls,
  }));
  const adapter = new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        return {
          kind: 'nativeToolCalls',
          calls: backendCalls,
          items: providerOrderedToolItems(backendCalls),
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
      },
    },
    { now: () => '2026-07-29T00:00:10.000Z' }
  );
  harness.enqueueProvider((input) => adapter.requestTurn(input));
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      invocationId: 'invocation-ordered-read-1',
      attemptId: 'attempt-ordered-read-1',
    })
  );

  const first = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(first.kind, 'admitted');
  assert.equal(harness.calls('submitToolIntent').length, 1);

  let queue = harness.loop.snapshot().providerToolCallQueue;
  assert.ok(queue);
  assert.equal(queue.status, 'active');
  assert.equal(queue.outcomeRecorded, false);
  assert.deepEqual(
    queue.calls.map((call) => ({
      ordinal: call.ordinal,
      status: call.status,
      toolId: call.intent.toolId,
    })),
    [
      { ordinal: 1, status: 'awaitingInvocation', toolId: 'fs.read' },
      { ordinal: 2, status: 'pending', toolId: 'fs.read' },
    ]
  );
  assert.equal(queue.receipt.responseDigest, responseDigest);
  assert.deepEqual(
    queue.receipt.calls.map((call) => ({
      ordinal: call.ordinal,
      callId: call.callId,
      toolName: call.toolName,
      toolId: call.toolId,
    })),
    [
      {
        ordinal: 1,
        callId: 'provider-call-ordered-read-1',
        toolName: providerToolName,
        toolId: 'fs.read',
      },
      {
        ordinal: 2,
        callId: 'provider-call-ordered-read-2',
        toolName: providerToolName,
        toolId: 'fs.read',
      },
    ]
  );
  const receiptJson = JSON.stringify(queue.receipt);
  assert.equal(receiptJson.includes('README.md'), false);
  assert.equal(receiptJson.includes(RUN_CAPABILITY_SECRET), false);
  assert.equal(receiptJson.includes(DECISION_CAPABILITY_SECRET), false);
  assert.equal(
    queue.receipt.calls[0].argumentsDigest,
    sha256Hash(canonicalJson({ path: 'README.md' }))
  );

  appendContextReadCompletion(
    harness,
    first,
    'attempt-ordered-read-1',
    'ordered-first'
  );
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: first.operationId,
    invocationId: first.invocationId,
  });
  queue = harness.loop.snapshot().providerToolCallQueue;
  assert.deepEqual(
    queue.calls.map((call) => call.status),
    ['completed', 'pending']
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    1,
    'the second call cannot submit before the first canonical terminal fact'
  );

  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      admissionFactId: 'fact-ordered-read-admitted-2',
      invocationId: 'invocation-ordered-read-2',
      attemptId: 'attempt-ordered-read-2',
    })
  );
  const second = await harness.loop.resumePendingProviderToolCalls();
  assert.equal(second.kind, 'admitted');
  assert.equal(harness.calls('submitToolIntent').length, 2);
  queue = harness.loop.snapshot().providerToolCallQueue;
  assert.deepEqual(
    queue.calls.map((call) => call.status),
    ['completed', 'awaitingInvocation']
  );
  assert.equal(
    new Set(queue.calls.map((call) => call.intent.operationId)).size,
    2
  );
  assert.equal(
    new Set(queue.calls.map((call) => call.intent.idempotencyKey)).size,
    2
  );
  assert.equal(
    new Set(queue.calls.map((call) => call.requestId)).size,
    2
  );

  appendContextReadCompletion(
    harness,
    second,
    'attempt-ordered-read-2',
    'ordered-second'
  );
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: second.operationId,
    invocationId: second.invocationId,
  });
  queue = harness.loop.snapshot().providerToolCallQueue;
  assert.equal(queue.status, 'completed');
  assert.equal(queue.outcomeRecorded, true);
  assert.deepEqual(
    queue.calls.map((call) => call.status),
    ['completed', 'completed']
  );
  assert.equal(
    harness.store.projectionEvents.some(
      (event) =>
        event.kind === 'provider.completed'
        && event.data?.result?.kind === 'orderedToolCallsCompleted'
        && event.data?.result?.callCount === 2
    ),
    true,
    'the durable provider outcome must follow both canonical terminal facts'
  );
}

async function providerToolCallEnvelopeIsBoundedBeforeSubmission() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(providerAnswer('baseline envelope input'));
  await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  const tooManyCalls = Array.from({ length: 33 }, (_, index) => ({
    callId: `provider-call-over-limit-${index + 1}`,
    toolName: 'write_file',
    toolId: 'fs.write',
    arguments: { path: 'output.txt', content: 'contract output' },
  }));
  const rejectingAdapter = new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        const responseDigest = sha256Hash(canonicalJson(tooManyCalls));
        return {
          kind: 'nativeToolCalls',
          calls: tooManyCalls,
          items: providerOrderedToolItems(tooManyCalls),
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
      },
    },
    { now: () => '2026-07-29T00:00:20.000Z' }
  );
  await assert.rejects(
    rejectingAdapter.requestTurn(harness.providerInputs[0]),
    (error) =>
      error?.code === 'session_kernel_provider_tool_call_count_invalid'
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    '33 Provider calls must be rejected before any Kernel submission'
  );

  const maximum = await openSessionHarness();
  const maximumCalls = Array.from({ length: 32 }, (_, index) => ({
    callId: `provider-call-at-limit-${index + 1}`,
    toolName: 'read_file',
    toolId: 'fs.read',
    arguments: { path: 'README.md' },
  }));
  const maximumAdapter = new StrictSessionKernelProviderAdapterV2(
    {
      async requestTurn() {
        const responseDigest = sha256Hash(canonicalJson(maximumCalls));
        return {
          kind: 'nativeToolCalls',
          calls: maximumCalls,
          items: providerOrderedToolItems(maximumCalls),
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
      },
    },
    { now: () => '2026-07-29T00:00:21.000Z' }
  );
  maximum.enqueueProvider((input) => maximumAdapter.requestTurn(input));
  maximum.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(maximum, request, {
      invocationId: 'invocation-at-limit-1',
      attemptId: 'attempt-at-limit-1',
    })
  );
  const atLimit = await maximum.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });
  assert.equal(atLimit.kind, 'admitted');
  assert.equal(
    maximum.loop.snapshot().providerToolCallQueue.calls.length,
    32
  );
  assert.equal(maximum.calls('submitToolIntent').length, 1);
  assert.equal(
    maximum.loop.snapshot().providerToolCallQueue.calls
      .slice(1)
      .every((call) => call.status === 'pending'),
    true,
    'the 32-call upper bound still admits only the first call initially'
  );
}

function appendContextReadCompletion(harness, result, attemptId, label) {
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

async function ordinaryNarrationNeverSubmitsAnIntent() {
  const harness = await openSessionHarness();
  const embedded = JSON.stringify({
    schemaVersion: 'deepcode.session.tool-intent-frame.v2',
    kind: 'toolIntent',
    toolId: 'fs.read',
    arguments: { path: 'README.md' },
  });
  harness.enqueueProvider(
    providerAnswer(`Do not execute this narrated example: ${embedded}`)
  );

  const result = await harness.loop.runProviderTurn({
    reason: 'userInput',
    target: { kind: 'planning' },
  });

  assert.equal(result.kind, 'answer');
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    'ordinary answer text must never be scanned for executable JSON'
  );
}

async function planActionAuthorityComesFromPersistedSessionState() {
  const harness = await openSessionHarness({
    initial: { runId: 'run-1' },
  });
  const plan = createPlan({
    runId: 'run-1',
    planRevision: 'plan-revision-golden-1',
    planActionId: 'plan-action-golden-1',
    operationId: 'planned-operation-golden-output',
  });
  const { preview: approvedPreview } = await persistPreviewAndAcceptPlan(
    harness,
    plan
  );
  const lineageBeforeFirstSubmit =
    harness.loop.snapshot().lineage;
  harness.enqueueProvider(
    providerToolIntent(
      'fs.write',
      { path: 'output.txt', content: 'contract output' },
      'provider-call-write-1'
    )
  );
  let firstReply;
  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => createPlanDiscoveryPreviewBatch(request, approvedPreview)
  );
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => {
      firstReply = admittedReply(harness, request, {
        invocationId: 'invocation-authority-first',
        attemptId: 'attempt-authority-first',
      });
      return firstReply;
    }
  );

  const firstClassification = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(firstClassification.kind, 'noTool');
  const firstResult = await harness.loop.resumePendingProviderToolCalls();

  assert.equal(firstResult.kind, 'admitted');
  const firstIntent = harness.calls('submitToolIntent').at(-1).intent;
  const replyOnlyLineage = recordSessionToolIntentSubmissionV2(
    lineageBeforeFirstSubmit,
    firstIntent,
    firstReply
  );
  assert.deepEqual(
    replyOnlyLineage.operations[firstIntent.operationId].leases,
    [],
    'an admitted reply must not create Session lease authority before canonical fact reconciliation'
  );
  assert.equal(firstIntent.toolId, 'fs.write');
  assert.deepEqual(firstIntent.authority, {
    kind: 'planAction',
    data: {
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
    },
  });
  assert.equal(
    typeof firstIntent.operationId === 'string'
      && firstIntent.operationId.length > 0,
    true,
    'Session must retain a non-empty operation identity'
  );
  assert.deepEqual(
    providerCallableToolsV2(
      harness.providerInputs.at(-1)
    ).map(
      (tool) => tool.toolId
    ),
    ['fs.read', 'fs.write'],
    'a PlanAction Provider turn keeps the complete ready tool surface stable'
  );
  const issuedLease = corpusFact(
    'invocationToolIntentAdmitted'
  ).lineage.capabilityLease;
  assert.deepEqual(
    harness.loop.snapshot().lineage.operations[
      firstResult.operationId
    ].leases,
    [issuedLease],
    'the Kernel-issued lease reference must enter Session lineage unchanged'
  );

  const firstObserved = corpusFact('effectToolObserved', {
    factId: 'fact-first-plan-action-call-observed',
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: harness.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      operationId: firstResult.operationId,
      invocationId: firstResult.invocationId,
      attemptId: 'attempt-authority-first',
    },
  });
  const firstCompleted = corpusFact('invocationToolCompleted', {
    factId: 'fact-first-plan-action-call-completed',
    ledgerSequence: harness.nextFactSequence() + 1,
    runSequence: harness.nextRunSequence() + 1,
    identities: {
      runId: harness.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      operationId: firstResult.operationId,
      invocationId: firstResult.invocationId,
      attemptId: 'attempt-authority-first',
      observedFactId: firstObserved.factId,
    },
  });
  harness.appendFacts(firstObserved, firstCompleted);
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: firstResult.operationId,
    invocationId: firstResult.invocationId,
    planActionId: 'plan-action-golden-1',
    expectedPlanRevision: 'plan-revision-golden-1',
  });
  assert.equal(harness.loop.snapshot().activeWait, undefined);

  harness.enqueueProvider(
    providerToolIntent(
      'fs.write',
      { path: 'output.txt', content: 'contract output' },
      'provider-call-write-2'
    )
  );
  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => createPlanDiscoveryPreviewBatch(request, approvedPreview)
  );
  harness.enqueueKernel(
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      admissionFactId: 'fact-tool-intent-admitted-authority-second',
      invocationId: 'invocation-authority-second',
      attemptId: 'attempt-authority-second',
    })
  );
  const secondClassification = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(secondClassification.kind, 'noTool');
  const secondResult = await harness.loop.resumePendingProviderToolCalls();
  assert.equal(secondResult.kind, 'admitted');
  const secondIntent =
    harness.calls('submitToolIntent').at(-1).intent;
  assert.deepEqual(secondIntent.authority, {
    kind: 'planAction',
    data: {
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      lease: issuedLease,
    },
  });

  const secondObserved = corpusFact('effectToolObserved', {
    factId: 'fact-second-plan-action-call-observed',
    ledgerSequence: harness.nextFactSequence(),
    runSequence: harness.nextRunSequence(),
    identities: {
      runId: harness.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      operationId: secondResult.operationId,
      invocationId: secondResult.invocationId,
      attemptId: 'attempt-authority-second',
    },
  });
  const secondCompleted = corpusFact('invocationToolCompleted', {
    factId: 'fact-second-plan-action-call-completed',
    ledgerSequence: harness.nextFactSequence() + 1,
    runSequence: harness.nextRunSequence() + 1,
    identities: {
      runId: harness.initial.runId,
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
      operationId: secondResult.operationId,
      invocationId: secondResult.invocationId,
      attemptId: 'attempt-authority-second',
      observedFactId: secondObserved.factId,
    },
  });
  const revoked = corpusFact('authorizationLeaseRevoked', {
    ledgerSequence: harness.nextFactSequence() + 2,
    runSequence: harness.nextRunSequence() + 2,
  });
  harness.appendFacts(secondObserved, secondCompleted, revoked);
  await harness.loop.notifyKernelWakeHint({
    waitKind: 'invocation',
    operationId: secondResult.operationId,
    invocationId: secondResult.invocationId,
    planActionId: 'plan-action-golden-1',
    expectedPlanRevision: 'plan-revision-golden-1',
  });
  assert.deepEqual(
    Object.values(harness.loop.snapshot().lineage.operations)
      .flatMap((operation) => operation.leases),
    [],
    'a canonical revocation must remove the lease from every PlanAction operation'
  );

  harness.enqueueProvider(
    providerToolIntent(
      'fs.write',
      { path: 'output.txt', content: 'contract output' },
      'provider-call-write-after-revoke'
    )
  );
  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => createPlanDiscoveryPreviewBatch(request, approvedPreview)
  );
  let postRevocationIntent;
  harness.enqueueKernel('submitToolIntent', (request) => {
    postRevocationIntent = request.intent;
    throw new Error('stop_after_post_revocation_intent_capture');
  });
  const postRevocationClassification = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
    remainingToolCallBudget: 32,
  });
  assert.equal(postRevocationClassification.kind, 'noTool');
  await assert.rejects(harness.loop.resumePendingProviderToolCalls());
  assert.deepEqual(postRevocationIntent.authority, {
    kind: 'planAction',
    data: {
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
    },
  });
}
