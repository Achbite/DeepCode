import {
  HttpSessionKernelProviderBackendV2,
  SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
  SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
  StrictSessionKernelProviderAdapterV2,
  buildSessionProviderContextV2,
  canonicalJson,
  materializeProviderPlanV2,
  providerToolContextBindingV2,
  providerWireToolNameV2,
  sha256Hash,
} from '../../dist/index.js';
import {
  SESSION_PROVIDER_TOOL_SETTLEMENT_EVIDENCE_V1_SCHEMA,
  planSessionProviderCacheLaneV2,
  sessionProviderCacheMaterialV2,
  sessionProviderSemanticMessagesV2,
} from '../../dist/kernel-v2/providerCacheLaneV2.js';
import {
  providerWireToolDefinitionsV2,
} from '../../dist/kernel-v2/providerContext.js';

import {
  admittedReply,
  assert,
  corpusFact,
  createInitialState,
  createProviderCompletionReceipt,
  createPreview,
  createSessionHarness,
  openSessionHarness,
  providerAnswer,
  providerOrderedToolItems,
  providerStructuredFailure,
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
    id: 'plan_evidence_digest_is_derived_from_exact_kernel_facts',
    run: planEvidenceDigestIsDerivedFromExactKernelFacts,
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
    id: 'planning_context_separates_intent_facts_and_execution_authority',
    run: planningContextSeparatesIntentFactsAndExecutionAuthority,
  },
  {
    id: 'planning_control_stays_private_until_native_terminal_and_confirmation_settlement',
    run: planningControlStaysPrivateUntilNativeTerminalAndConfirmationSettlement,
  },
  {
    id: 'structured_provider_failure_repairs_with_a_new_exact_append_request',
    run: structuredProviderFailureRepairsWithANewExactAppendRequest,
  },
  {
    id: 'repeated_structured_provider_failure_fails_closed_without_progress',
    run: repeatedStructuredProviderFailureFailsClosedWithoutProgress,
  },
];

async function structuredProviderFailureRepairsWithANewExactAppendRequest() {
  const harness = await openSessionHarness();
  const draft = planningDraft();
  const valid = sealedPlanningOutput(
    draft,
    'I reconstructed the complete Plan from the same authoritative request.'
  );
  const restore = installPlanningTerminalEvidence(
    harness,
    valid.plan,
    valid.planProposal.callId
  );
  harness.enqueueProvider(providerStructuredFailure({
    callId: 'call-invalid-first-attempt',
  }));
  harness.enqueueProvider((input) =>
    strictAdapterReturning(valid).requestTurn(input));

  let result;
  try {
    result = await harness.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    });
  } finally {
    restore();
  }

  assert.equal(result.kind, 'plan');
  assert.equal(harness.providerInputs.length, 2);
  const [failed, repaired] = harness.providerInputs;
  assert.notEqual(failed.providerTurnId, repaired.providerTurnId);
  assert.equal(repaired.purpose, 'continuation');
  assert.equal(
    repaired.structuredRepair.predecessorProviderTurnId,
    failed.providerTurnId
  );
  assert.equal(repaired.structuredRepair.sourceTerminalKind, 'failed');
  assert.equal(
    repaired.structuredRepair.failureDigest,
    harness.store.providerEvidence
      .get(failed.providerTurnId)
      .terminal.data.structuredFailure.failureDigest
  );
  assert.equal(
    repaired.structuredRepair.errorCode,
    'provider_tool_call_arguments_invalid'
  );
  const tools = providerWireToolDefinitionsV2(repaired);
  const material = sessionProviderCacheMaterialV2(
    repaired.contextAssembly.messages,
    tools
  );
  const predecessor = {
    schemaVersion: 'deepcode.session.provider-cache-predecessor.v2',
    status: 'available',
    sessionId: repaired.sessionMemory.sessionId,
    runId: repaired.runId,
    userTurnId: repaired.currentInput.inputId,
    providerTurnId: failed.providerTurnId,
    controlEpoch: repaired.controlEpoch,
    terminalKind: 'failed',
    replayEligible: false,
    terminalReasonCode: 'provider_tool_call_arguments_invalid',
    externalRequestDigest: `sha256:${'d'.repeat(64)}`,
    externalRequestBytes: 4096,
    providerProfileRevisionDigest:
      repaired.providerProfile.providerProfileRevisionDigest,
    providerProfileId: repaired.providerProfile.providerProfileId,
    provider: 'contract-provider',
    model: 'contract-model',
    targetKind: repaired.target.kind,
    targetBindingDigest: sha256Hash(canonicalJson(repaired.target)),
    toolSchemaDigest: material.toolSchemaDigest,
    responseFormatDigest: material.responseFormatDigest,
    toolContextRef: clone(repaired.toolContext.contextRef),
    cacheLane: {
      laneId: `sha256:${'c'.repeat(64)}`,
      laneRevision: 1,
      relationKind: 'bootstrap',
      stablePrefixDigest: material.stablePrefixDigest,
    },
  };
  const cacheLane = planSessionProviderCacheLaneV2({
    turn: repaired,
    fullContextMessages: repaired.contextAssembly.messages,
    tools,
    predecessor,
  });
  assert.equal(cacheLane.mode, 'append');
  assert.equal(cacheLane.relationKind, 'sameTurnStructuredRepair');
  assert.equal(cacheLane.predecessorRequestId, failed.providerTurnId);
  const semanticMessages = sessionProviderSemanticMessagesV2(
    repaired,
    cacheLane,
    predecessor
  );
  assert.deepEqual(
    semanticMessages.map((message) => message.role),
    ['user', 'user'],
    'repair appends only a deterministic repair frame and current authority frame'
  );
  const repairFrame = JSON.parse(semanticMessages[0].content);
  assert.equal(
    repairFrame.schemaVersion,
    'deepcode.session.provider-structured-repair-frame.v1'
  );
  assert.equal(repairFrame.failureDigest, repaired.structuredRepair.failureDigest);
  assert.equal(
    semanticMessages.some((message) =>
      message.content.includes('{"plan":{]}invalid')
    ),
    false,
    'invalid assistant tool-call bytes must never be replayed into Provider messages'
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    'structured repair must not admit the invalid proposal as a Kernel effect'
  );
  const repairProjection = harness.store.projectionEvents.find(
    (event) =>
      event.kind === 'diagnostic'
      && event.data?.stage === 'provider.structuredRepair'
  );
  assert(repairProjection);
  assert.equal(repairProjection.data.status, 'recovering');
  assert.equal(repairProjection.data.currentActivityCode, 'session.validating');
}

async function repeatedStructuredProviderFailureFailsClosedWithoutProgress() {
  const harness = await openSessionHarness();
  harness.enqueueProvider(providerStructuredFailure({
    callId: 'call-invalid-first-attempt',
  }));
  harness.enqueueProvider(providerStructuredFailure({
    callId: 'call-invalid-second-attempt',
  }));

  await assert.rejects(
    harness.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    }),
    (error) =>
      error?.code
        === 'session_kernel_provider_structured_repair_no_progress'
  );

  assert.equal(harness.providerInputs.length, 2);
  assert.notEqual(
    harness.providerInputs[0].providerTurnId,
    harness.providerInputs[1].providerTurnId
  );
  assert.equal(
    harness.providerInputs[0].structuredRepair,
    undefined
  );
  assert.equal(
    harness.providerInputs[1].structuredRepair.failureDigest,
    harness.store.providerEvidence
      .get(harness.providerInputs[0].providerTurnId)
      .terminal.data.structuredFailure.failureDigest
  );
  assert.equal(
    harness.loop.snapshot().providerTurn.nextStructuredRepair,
    undefined
  );
  const failedProjection = harness.store.projectionEvents.find(
    (event) =>
      event.kind === 'diagnostic'
      && event.data?.stage === 'provider.structuredRepairNoProgress'
  );
  assert(failedProjection);
  assert.equal(failedProjection.data.status, 'failed');
}

async function planEvidenceDigestIsDerivedFromExactKernelFacts() {
  const initial = createInitialState();
  const operationId = 'operation-plan-evidence-read';
  const admitted = corpusFact('invocationContextReadAdmitted', {
    factId: 'fact-plan-evidence-read-admitted',
    identities: {
      runId: initial.runId,
      contextReadOperationId: operationId,
      contextReadInvocationId: 'invocation-plan-evidence-read',
      contextReadAttemptId: 'attempt-plan-evidence-read',
    },
    ledgerSequence: 1,
    runSequence: 1,
  });
  const effect = corpusFact('effectContextReadObserved', {
    factId: 'fact-plan-evidence-read-observed',
    identities: {
      runId: initial.runId,
      contextReadOperationId: operationId,
      contextReadInvocationId: 'invocation-plan-evidence-read',
      contextReadAttemptId: 'attempt-plan-evidence-read',
      contextReadEffectId: 'effect-plan-evidence-read',
    },
    ledgerSequence: 2,
    runSequence: 2,
  });
  const completed = corpusFact('invocationContextReadCompleted', {
    factId: 'fact-plan-evidence-read-completed',
    identities: {
      runId: initial.runId,
      contextReadOperationId: operationId,
      contextReadInvocationId: 'invocation-plan-evidence-read',
      contextReadAttemptId: 'attempt-plan-evidence-read',
      contextReadEffectId: 'effect-plan-evidence-read',
    },
    ledgerSequence: 3,
    runSequence: 3,
  });
  const draft = planningDraft();
  draft.evidence.kernelFactRefs = [completed.factId];
  draft.evidence.readResources = [{
    resourceRef: effect.lineage.resourceIds[0],
    summary: 'The current README was read before planning.',
    factRefs: [completed.factId],
  }];

  const plan = materializeProviderPlanV2({
    providerTurnId: 'provider-turn-plan-evidence',
    runId: initial.runId,
    controlEpoch: initial.controlEpoch,
    currentInput: initial.initialInput,
    toolContext: providerToolContextBindingV2(initial.toolContext),
    sessionMemory: initial.sessionMemory,
    providerOutcomes: [],
    kernelFacts: {
      snapshotHighWater: 3,
      omittedCount: 0,
      facts: [admitted, effect, completed],
    },
  }, draft, '2026-07-29T00:00:02.000Z');
  assert.deepEqual(plan.evidence.readResources, [{
    resourceRef: effect.lineage.resourceIds[0],
    digest: effect.details.evidenceDigest,
    summary: draft.evidence.readResources[0].summary,
    factRefs: [effect.factId, completed.factId].sort(),
  }]);

  const finalFrame = {
    role: 'user',
    content: canonicalJson({
      schemaVersion: 'deepcode.session.provider-turn-frame.v1',
      currentInput: { inputId: initial.initialInput.inputId },
      target: { kind: 'planning' },
    }),
  };
  const semanticMessages = sessionProviderSemanticMessagesV2({
    providerOutcomes: [{
      providerTurnId: 'provider-turn-read-evidence',
      outputKind: 'toolIntent',
      recordedAt: '2026-07-29T00:00:01.000Z',
      toolCallReceipt: {
        schemaVersion: 'deepcode.session.provider-tool-call-receipt.v2',
        providerTurnId: 'provider-turn-read-evidence',
        responseDigest: `sha256:${'1'.repeat(64)}`,
        callCount: 1,
        calls: [],
        recordedAt: '2026-07-29T00:00:01.000Z',
      },
      toolSettlement: {
        status: 'completed',
        settledAt: '2026-07-29T00:00:01.000Z',
      },
      toolCalls: [{
        ordinal: 1,
        operationId,
        toolId: 'fs.read',
        status: 'completed',
        terminalFactId: completed.factId,
        terminalFactKind: completed.factKind,
      }],
    }],
    kernelFacts: {
      snapshotHighWater: 3,
      omittedCount: 0,
      facts: [admitted, effect, completed],
    },
    contextAssembly: { messages: [finalFrame] },
  }, {
    mode: 'append',
    relationKind: 'sameTurnToolContinuation',
  }, {
    status: 'available',
  });
  assert.equal(semanticMessages.length, 2);
  const evidenceFrame = JSON.parse(semanticMessages[0].content);
  assert.equal(
    evidenceFrame.schemaVersion,
    SESSION_PROVIDER_TOOL_SETTLEMENT_EVIDENCE_V1_SCHEMA
  );
  assert.deepEqual(evidenceFrame.calls[0].readResources, [{
    resourceRef: effect.lineage.resourceIds[0],
    digest: effect.details.evidenceDigest,
    factRef: effect.factId,
  }]);
  assert.deepEqual(semanticMessages[1], finalFrame);
}

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

async function planningContextSeparatesIntentFactsAndExecutionAuthority() {
  const initial = createInitialState();
  const toolContext = initial.toolContext;
  initial.initialInput.text = [
    'Restore the current workspace to its clean state.',
    'Preserve the established workflow.',
    'Any new implementation is deferred until I choose its scope.',
  ].join(' ');
  const contextSource = {
    providerTurnId: 'provider-turn-planning-context-contract',
    purpose: 'primary',
    runId: initial.runId,
    controlEpoch: initial.controlEpoch,
    currentInput: initial.initialInput,
    conversationInputs: [initial.initialInput],
    conversationInputOmittedCount: 0,
    providerOutcomes: [],
    providerOutcomeOmittedCount: 0,
    sessionMemory: initial.sessionMemory,
    providerProfile: initial.providerProfile,
    kernelFacts: {
      snapshotHighWater: 0,
      omittedCount: 0,
      facts: [],
    },
    target: { kind: 'planning' },
    guidance: [],
    toolContext: {
      bundle: toolContext,
      contextRef: {
        contextVersion: toolContext.contextVersion,
        catalogDigest: toolContext.catalogDigest,
        contextDigest: toolContext.contextDigest,
      },
      fixedPrompt: toolContext.fixedPrompt,
      tools: toolContext.tools,
    },
    planActionSettlementOutcomes: {},
  };
  const contextAssembly = buildSessionProviderContextV2(contextSource);
  const answerText = 'Please clarify the desired immediate scope.';
  const responseDigest = sha256Hash(canonicalJson({
    kind: 'text',
    text: answerText,
  }));
  let wireRequest;
  const backend = new HttpSessionKernelProviderBackendV2(
    {
      async request(request) {
        wireRequest = clone(request);
        return {
          requestId: request.requestId,
          items: [{
            kind: 'text',
            phase: 'final_answer',
            text: answerText,
          }],
          providerProfileId: 'provider-profile-v2-contract',
          provider: 'contract-provider',
          model: 'contract-model',
          completion: createProviderCompletionReceipt(responseDigest),
        };
      },
    },
    'provider-profile-v2-contract'
  );
  const adapter = new StrictSessionKernelProviderAdapterV2(
    backend,
    { now: () => '2026-07-29T00:00:20.000Z' }
  );
  const result = await adapter.requestTurn({
    ...contextSource,
    contextAssembly,
    signal: new AbortController().signal,
  });

  assert.equal(result.kind, 'answer');
  assert.equal(result.text, answerText);
  assert.ok(
    wireRequest,
    'the production HTTP backend must assemble one wire request'
  );
  assert.deepEqual(
    wireRequest.messages,
    contextAssembly.messages,
    'the wire request must preserve the exact Session context assembly'
  );

  const messages = contextAssembly.messages;
  assert.equal(messages[1].role, 'system');
  assert.equal(messages.at(-1).role, 'user');
  assert.equal(
    messages.slice(2).every((message) => message.role === 'user'),
    true,
    'all dynamic context and the active turn frame must remain untrusted user messages'
  );
  const currentInput = JSON.parse(messages.at(-1).content);
  assert.equal(
    currentInput.schemaVersion,
    'deepcode.session.provider-turn-frame.v1'
  );
  assert.equal(currentInput.currentInput.text, initial.initialInput.text);
  assert.deepEqual(currentInput.target, { kind: 'planning' });

  const contract = messages[1].content;
  assert.match(
    contract,
    /complete sorted ready tool catalog are immutable/u
  );
  assert.match(contract, /Tool availability never grants authority/u);
  assert.match(
    contract,
    /For planning, ordinary text or one concise clarification question is valid/u
  );
  assert.match(
    contract,
    /Put only mutation actions/u
  );
  assert.match(
    contract,
    /ready read tools remain available whenever Kernel Settings and canonical scope permit them/u
  );
  assert.match(
    contract,
    /current confirmed PlanAction is the only mutation authority/u
  );
  assert.match(
    contract,
    /consolidate the current action, remaining unsettled actions, directly related resources, material technical options, recommendation, and tradeoffs/u
  );

  const planControls = wireRequest.tools.filter(
    (tool) => tool.name === SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME
  );
  assert.equal(planControls.length, 1);
  const planDescription = planControls[0].description;
  assert.match(planDescription, /explicit immediate requested outcome/u);
  assert.match(planDescription, /honors every preserve constraint/u);
  assert.match(planDescription, /excludes deferred or conditional work/u);
  assert.match(planDescription, /Workspace facts describe state only/u);
  assert.match(planDescription, /current input did not request/u);
  assert.match(planDescription, /needs clarification, do not call it/u);
  assert.deepEqual(
    wireRequest.tools.map((tool) => tool.name),
    [
      ...toolContext.tools.map((tool) => providerWireToolNameV2(tool.toolId)),
      SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
      SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
      SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
    ],
    'planning must retain the complete stable ready tool and Session control surface'
  );
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
      delete value.plan.actions[0]
        .scopeIntent.data.requestedResources[0].data.access;
      const proposalArguments = {
        schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
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
  duplicateControl.enqueueProvider((input) =>
    strictAdapterReturning(valid).requestTurn(input));
  try {
    await assert.rejects(
      duplicateControl.loop.runProviderTurn({
        reason: 'userInput',
        target: { kind: 'planning' },
      }),
      (error) =>
        error?.code
          === 'session_kernel_provider_structured_repair_no_progress'
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
  assert.deepEqual(
    harness.store.projectionEvents
      .filter((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      )
      .map((event) => event.kind),
    ['plan.commentaryReleased'],
    'sealed commentary may publish, but confirmation remains unavailable before canonical preview settlement'
  );

  harness.enqueueKernel(
    'previewCapabilityBatch',
    (request) => planningPreviewBatch(
      request,
      harness.initial.runId
    )
  );
  await harness.loop.previewPlan(result.plan.planRevision);
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
    'previewCapabilityBatch',
    (request) => ({
      runId: rejectedPreview.initial.runId,
      acceptedControlEpoch: request.expectedControlEpoch,
      planRevision: request.planRevision,
      results: request.items.map((item) => ({
        kind: 'rejected',
        data: {
          planActionId: item.planActionId,
          operationId: item.operationId,
          toolId: item.toolId,
          reason: 'settingsDenied',
          guidance: 'Revise the requested scope before asking for approval.',
        },
      })),
    })
  );
  const rejectedReply = await rejectedPreview.loop.previewPlan(
    rejectedPlan.plan.planRevision
  );
  assert.equal(rejectedReply.results[0].kind, 'rejected');
  const previewSettlement = rejectedPreview.loop.snapshot()
    .pendingProviderControlSettlement;
  assert.equal(previewSettlement?.kind, 'planPreviewRejected');
  assert.equal(
    previewSettlement?.predecessorProviderTurnId,
    rejectedPreview.loop.snapshot().providerOutcomes.at(-1).providerTurnId
  );
  assert.deepEqual(previewSettlement?.preview, {
    planRevision: rejectedPlan.plan.planRevision,
    rejections: rejectedReply.results.map((result) => result.data),
  });
  rejectedPreview.enqueueProvider(
    providerAnswer('The rejected scope requires a revised Plan.')
  );
  const revised = await rejectedPreview.loop.runProviderTurn({
    reason: 'replan',
    target: { kind: 'planning' },
  });
  assert.equal(revised.kind, 'answer');
  assert.deepEqual(
    rejectedPreview.providerInputs.at(-1)
      .pendingProviderControlSettlement,
    previewSettlement,
    'replanning must consume the exact durable Plan preview rejection receipt'
  );
  assert.equal(
    rejectedPreview.loop.snapshot().pendingProviderControlSettlement,
    undefined
  );
  await assert.rejects(
    rejectedPreview.loop.publishPlanConfirmationReady(
      rejectedPlan.plan.planRevision
    ),
    (error) =>
      error?.code === 'session_kernel_plan_confirmation_preview_mismatch'
  );
  assert.deepEqual(
    rejectedPreview.store.projectionEvents
      .filter((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      )
      .map((event) => event.kind),
    ['plan.commentaryReleased'],
    'a rejected canonical preview must not publish confirmation authority'
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
    'previewCapabilityBatch',
    (request) => planningPreviewBatch(
      request,
      confirmationFailure.initial.runId
    )
  );
  await confirmationFailure.loop.previewPlan(
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
  assert.deepEqual(
    confirmationFailure.store.projectionEvents
      .filter((event) =>
        event.kind === 'plan.commentaryReleased'
        || event.kind === 'plan.confirmationReady'
      )
      .map((event) => event.kind),
    ['plan.commentaryReleased'],
    'a failed confirmation delivery must not manufacture confirmation authority'
  );
  assert.equal(confirmationFailure.calls('submitToolIntent').length, 0);
}

function sealedPlanningOutput(draft, commentary) {
  const proposalArguments = {
    schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
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
      schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
      callId: 'provider-plan-lifecycle-contract',
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
}

function planningDraft() {
  return {
    title: 'Write reviewed output',
    objective: 'Write one exact workspace file.',
    narrative: 'Preview the exact scope before requesting approval.',
    evidence: {
      kernelFactRefs: [],
      readResources: [],
      blockingUnknowns: [],
      nonBlockingUnknowns: [],
      coverage: 'The requested write target is explicitly scoped.',
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
      deadline: { kind: 'contractDefault', data: {} },
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
    schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
    plan: draft,
  };
  map.set = function setPlanningEvidence(providerTurnId, evidence) {
    const terminal = evidence.terminal;
    if (terminal.data.terminalKind !== 'completed') {
      return originalSet.call(this, providerTurnId, evidence);
    }
    terminal.data.orderedItems.push({
      kind: 'toolCall',
      index: terminal.data.orderedItems.length,
      callId,
      name: SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
      arguments: canonicalJson(proposalArguments),
    });
    if (options.duplicateControl) {
      terminal.data.orderedItems.push({
        kind: 'toolCall',
        index: terminal.data.orderedItems.length,
        callId: `${callId}-duplicate`,
        name: SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
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

function planningPreview(request, item, runId) {
  const templateItem = {
    ...item,
    planActionId: 'plan-action-write-first',
    operationId: 'planned-operation-write-first',
  };
  const template = createPreview({
    ...request,
    planRevision: 'plan-two-actions',
    items: [templateItem],
  }, templateItem, runId);
  return {
    ...template,
    previewId: `preview-${item.operationId}`,
    planRevision: request.planRevision,
    planActionId: item.planActionId,
    operationId: item.operationId,
    toolId: item.toolId,
  };
}

function planningPreviewBatch(request, runId) {
  return {
    runId,
    acceptedControlEpoch: request.expectedControlEpoch,
    planRevision: request.planRevision,
    results: request.items.map((item) => ({
      kind: 'previewed',
      data: { preview: planningPreview(request, item, runId) },
    })),
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
