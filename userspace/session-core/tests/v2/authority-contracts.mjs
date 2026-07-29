import {
  normalizeProviderKernelToolIntentV2,
  providerCallableToolsV2,
  recordSessionToolIntentSubmissionV2,
} from '../../dist/index.js';

import {
  DECISION_CAPABILITY_SECRET,
  RUN_CAPABILITY_SECRET,
  admittedReply,
  assert,
  corpusFact,
  createPlan,
  createToolContext,
  openSessionHarness,
  persistPreviewAndAcceptPlan,
  providerAnswer,
  providerToolIntent,
  toolContextRef,
} from './harness.mjs';

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
    id: 'ordinary_narration_never_submits_an_intent',
    run: ordinaryNarrationNeverSubmitsAnIntent,
  },
  {
    id: 'text_tool_intent_requires_one_standalone_structural_frame',
    run: textToolIntentRequiresOneStandaloneStructuralFrame,
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
    kind: 'contextRead',
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

async function textToolIntentRequiresOneStandaloneStructuralFrame() {
  const toolContext = createToolContext();
  const frame = JSON.stringify({
    schemaVersion: 'deepcode.session.tool-intent-frame.v2',
    kind: 'toolIntent',
    toolId: 'fs.read',
    arguments: { path: 'notes/context.md' },
  });
  const binding = {
    runId: 'run-text-frame',
    controlEpoch: 3,
    operationId: 'operation-text-frame',
    authority: {
      kind: 'contextRead',
      data: { purpose: 'Read the requested note.' },
    },
    idempotencyKey: 'intent-text-frame',
    toolContext,
  };

  const intent = normalizeProviderKernelToolIntentV2(
    { source: 'textFrame', frame },
    binding
  );
  assert.equal(intent.toolId, 'fs.read');
  assert.deepEqual(intent.rawArguments, {
    path: 'notes/context.md',
  });
  assert.deepEqual(intent.authority, binding.authority);

  assert.throws(
    () => normalizeProviderKernelToolIntentV2(
      {
        source: 'textFrame',
        frame: `Please run this:\n${frame}`,
      },
      binding
    ),
    (error) =>
      error?.code === 'session_tool_intent_text_not_structured'
  );
  assert.throws(
    () => normalizeProviderKernelToolIntentV2(
      {
        source: 'textFrame',
        frame: `\`\`\`json\n${frame}\n\`\`\``,
      },
      binding
    ),
    (error) =>
      error?.code === 'session_tool_intent_text_not_structured'
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
  await persistPreviewAndAcceptPlan(harness, plan);
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
    'submitToolIntent',
    (request) => {
      firstReply = admittedReply(harness, request, {
        invocationId: 'invocation-authority-first',
        attemptId: 'attempt-authority-first',
      });
      return firstReply;
    }
  );

  const firstResult = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
  });

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
    ['fs.write'],
    'a PlanAction Provider turn exposes only its persisted tool'
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
    'submitToolIntent',
    (request) => admittedReply(harness, request, {
      admissionFactId: 'fact-tool-intent-admitted-authority-second',
      invocationId: 'invocation-authority-second',
      attemptId: 'attempt-authority-second',
    })
  );
  const secondResult = await harness.loop.runProviderTurn({
    reason: 'planExecution',
    target: {
      kind: 'planAction',
      planActionId: 'plan-action-golden-1',
    },
  });
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
  let postRevocationIntent;
  harness.enqueueKernel('submitToolIntent', (request) => {
    postRevocationIntent = request.intent;
    throw new Error('stop_after_post_revocation_intent_capture');
  });
  await assert.rejects(
    harness.loop.runProviderTurn({
      reason: 'planExecution',
      target: {
        kind: 'planAction',
        planActionId: 'plan-action-golden-1',
      },
    })
  );
  assert.deepEqual(postRevocationIntent.authority, {
    kind: 'planAction',
    data: {
      planRevision: 'plan-revision-golden-1',
      planActionId: 'plan-action-golden-1',
    },
  });
}
