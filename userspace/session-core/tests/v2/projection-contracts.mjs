import {
  assertSharedConversationProjectionV2,
  buildNarrativeTimelineProjection,
  normalizeAgentTimelineSnapshot,
  sessionKernelAgentEventV2,
} from '../../dist/index.js';
import {
  consumeProviderSseV1,
} from '../../dist/kernel-v2/providerStreamV1.js';

import {
  admittedReply,
  assert,
  createPlan,
  createProviderCompletionReceipt,
  openSessionHarness,
  providerToolIntent,
} from './harness.mjs';

export const contractCases = [
  {
    id: 'shared_projection_accepts_only_exact_work_segments_shape',
    run: sharedProjectionAcceptsOnlyExactWorkSegmentsShape,
  },
  {
    id: 'work_segment_orders_commentary_tools_and_canonical_effects_without_lifecycle_cards',
    run: workSegmentOrdersCommentaryToolsAndCanonicalEffectsWithoutLifecycleCards,
  },
  {
    id: 'provider_composing_archives_before_publish_and_admits_zero_tools_on_stale_or_projection_failure',
    run: providerComposingArchivesBeforePublishAndAdmitsZeroToolsOnStaleOrProjectionFailure,
  },
  {
    id: 'preview_rejection_marks_only_target_needs_revision_and_creates_no_work_segment',
    run: previewRejectionMarksOnlyTargetNeedsRevisionAndCreatesNoWorkSegment,
  },
  {
    id: 'task_projection_tracks_plan_authority_without_queued_fallback',
    run: taskProjectionTracksPlanAuthorityWithoutQueuedFallback,
  },
];

async function sharedProjectionAcceptsOnlyExactWorkSegmentsShape() {
  const sessionId = 'session-projection-shape-contract';
  const runId = 'run-projection-shape-contract';
  const events = [
    publicProjectionEvent(sessionId, runId, 1, 'input.persisted', {
      inputId: 'input-projection-shape',
      opaqueInputRef: 'opaque-input-projection-shape',
      text: 'Inspect the workspace.',
      attachments: [],
      recordedAt: timestamp(1),
      controlEpoch: 1,
    }),
    publicProjectionEvent(sessionId, runId, 2, 'provider.completed', {
      providerTurnId: 'provider-turn-projection-shape',
      controlEpoch: 1,
      outputKind: 'answer',
      terminalScope: 'turn',
      orderedItems: [
        { kind: 'text', phase: 'final_answer', text: 'Inspection complete.' },
      ],
      result: { kind: 'answer', text: 'Inspection complete.' },
      providerOutcome: providerOutcome(),
    }),
  ];
  const native = buildNarrativeTimelineProjection({ sessionId, events });
  assertSharedConversationProjectionV2(native);
  assert.equal(Object.hasOwn(native, 'legacyPrefixTurnCount'), false);
  assert.equal(native.turns.length, 1);
  assert.equal(native.turns[0].status, 'completed');
  assert.deepEqual(
    native.turns[0].parts,
    native.turns[0].blocks.map((block) => ({
      kind: 'block',
      blockId: block.id,
    }))
  );

  const unsupportedHistoryShapes = [
    mutate(native, (value) => {
      delete value.shapeVersion;
    }),
    mutate(native, (value) => {
      delete value.turns[0].workSegments;
    }),
    mutate(native, (value) => {
      delete value.turns[0].parts;
    }),
  ];
  for (const unsupported of unsupportedHistoryShapes) {
    assert.throws(
      () => normalizeAgentTimelineSnapshot(unsupported),
      (error) => error?.code === 'UnsupportedHistorySchema',
      'every pre-cutover projection shape must fail closed'
    );
  }
  const legacyFieldOnCurrentShape = mutate(native, (value) => {
    value.legacyPrefixTurnCount = 0;
  });
  assert.throws(
    () => normalizeAgentTimelineSnapshot(legacyFieldOnCurrentShape),
    /session_projection_v2_root_field_invalid/u,
    'current shape must reject every removed compatibility field'
  );

  const duplicatePart = clone(native);
  duplicatePart.turns[0].parts.push(clone(duplicatePart.turns[0].parts[0]));
  assert.throws(
    () => assertSharedConversationProjectionV2(duplicatePart),
    /session_projection_v2_part_invalid/u
  );

  const danglingPart = clone(native);
  danglingPart.turns[0].parts[0] = {
    kind: 'block',
    blockId: 'missing-block-reference',
  };
  assert.throws(
    () => assertSharedConversationProjectionV2(danglingPart),
    /session_projection_v2_part_invalid/u
  );

  const missingPart = clone(native);
  missingPart.turns[0].parts.pop();
  assert.throws(
    () => assertSharedConversationProjectionV2(missingPart),
    /session_projection_v2_part_reference_incomplete/u
  );
}

async function workSegmentOrdersCommentaryToolsAndCanonicalEffectsWithoutLifecycleCards() {
  const sessionId = 'session-work-segment-contract';
  const runId = 'run-work-segment-contract';
  const providerTurnId = 'provider-turn-work-segment';
  const events = [
    publicProjectionEvent(sessionId, runId, 1, 'input.persisted', {
      inputId: 'input-work-segment',
      opaqueInputRef: 'opaque-input-work-segment',
      text: 'Read and update the workspace.',
      attachments: [],
      recordedAt: timestamp(1),
      controlEpoch: 1,
    }),
    publicProjectionEvent(sessionId, runId, 2, 'provider.started', {
      providerTurnId,
      controlEpoch: 1,
      contextRef: {
        contextVersion: 1,
        catalogDigest: `sha256:${'1'.repeat(64)}`,
        contextDigest: `sha256:${'2'.repeat(64)}`,
      },
      factProjection: {},
      contextAssembly: {},
    }),
    publicProjectionEvent(sessionId, runId, 3, 'wait.changed', null),
    publicProjectionEvent(sessionId, runId, 4, 'provider.completed', {
      providerTurnId,
      controlEpoch: 1,
      outputKind: 'toolIntent',
      terminalScope: 'providerTurn',
      status: 'responseAccepted',
      orderedItems: [
        { kind: 'text', phase: 'commentary', text: 'I will inspect the file.' },
        {
          kind: 'toolCall',
          ordinal: 2,
          callId: 'call-read',
          toolName: 'fs.read',
          toolId: 'fs.read',
          operationId: 'operation-read',
          status: 'completed',
          invocationId: 'invocation-read',
          terminalFactId: 'fact-read-completed',
          terminalFactKind: 'toolCompleted',
        },
        { kind: 'text', phase: 'commentary', text: 'I will now update the file.' },
        {
          kind: 'toolCall',
          ordinal: 4,
          callId: 'call-write',
          toolName: 'fs.write',
          toolId: 'fs.write',
          operationId: 'operation-write',
          status: 'completed',
          invocationId: 'invocation-write',
          terminalFactId: 'fact-write-completed',
          terminalFactKind: 'toolCompleted',
        },
      ],
      providerOutcome: providerOutcome(),
    }),
    publicProjectionEvent(
      sessionId,
      runId,
      5,
      'kernelFacts.reconciled',
      {
        requestId: 'request-facts-work-segment',
        pageFactIds: [
          'fact-read-completed',
          'fact-write-completed',
        ],
        pageFactCount: 2,
        snapshotHighWater: 2,
        nextAfterLedgerSequence: 2,
        operationFacts: [
          canonicalOperationFact({
            operationId: 'operation-read',
            invocationId: 'invocation-read',
            attemptId: 'attempt-read',
            toolId: 'fs.read',
            factId: 'fact-read-completed',
            resourceId: 'resource-readme',
            target: 'README.md',
            effectId: 'effect-read',
            canonicalAction: 'Read workspace file README.md',
            effectSummary: 'Read one canonical workspace resource.',
          }),
          canonicalOperationFact({
            operationId: 'operation-write',
            invocationId: 'invocation-write',
            attemptId: 'attempt-write',
            toolId: 'fs.write',
            factId: 'fact-write-completed',
            resourceId: 'resource-output',
            target: 'output.txt',
            effectId: 'effect-write',
            canonicalAction: 'Write workspace file output.txt',
            effectSummary: 'Updated one canonical workspace resource.',
          }),
        ],
      }
    ),
  ];
  assert.throws(
    () => publicProjectionEvent(
      sessionId,
      runId,
      6,
      'provider.completed',
      {
        providerTurnId: 'provider-turn-raw-arguments-rejected',
        controlEpoch: 1,
        outputKind: 'toolIntent',
        terminalScope: 'providerTurn',
        status: 'responseAccepted',
        orderedItems: [{
          kind: 'toolCall',
          ordinal: 1,
          callId: 'call-raw-arguments-rejected',
          toolName: 'fs.read',
          toolId: 'fs.read',
          operationId: 'operation-raw-arguments-rejected',
          status: 'pending',
          rawArguments: { path: 'must-not-publish-provider-arguments.txt' },
        }],
        providerOutcome: providerOutcome(),
      }
    ),
    (error) =>
      error?.code === 'session_kernel_projection_provider_items_invalid'
  );

  const rawArgumentsSentinel =
    'must-not-publish-tool-intent-arguments.txt';
  assert.throws(
    () => publicProjectionEvent(
      sessionId,
      runId,
      6,
      'toolIntent.submitted',
      {
        requestId: 'request-raw-arguments-rejected',
        operationId: 'operation-raw-arguments-rejected',
        toolId: 'fs.read',
        expectedControlEpoch: 1,
        authorityKind: 'contextRead',
        replyKind: 'admitted',
        invocationId: 'invocation-raw-arguments-rejected',
        rawArguments: { path: rawArgumentsSentinel },
      }
    ),
    (error) =>
      error?.code === 'session_kernel_projection_data_invalid',
    'public ToolIntent projection must reject raw Provider arguments'
  );
  const rawIntentEvent = publicProjectionEvent(
    sessionId,
    runId,
    6,
    'toolIntent.submitted',
    {
      requestId: 'request-raw-arguments-omitted',
      operationId: 'operation-raw-arguments-omitted',
      toolId: 'fs.read',
      expectedControlEpoch: 1,
      authorityKind: 'contextRead',
      replyKind: 'admitted',
      invocationId: 'invocation-raw-arguments-omitted',
    }
  );
  const rawOmissionProjection = buildNarrativeTimelineProjection({
    sessionId,
    events: [events[0], rawIntentEvent],
  });
  assertSharedConversationProjectionV2(rawOmissionProjection);
  const rawOmissionJson = JSON.stringify(rawOmissionProjection);
  assert.equal(rawOmissionJson.includes('rawArguments'), false);
  assert.equal(rawOmissionJson.includes(rawArgumentsSentinel), false);

  const beforeFacts = buildNarrativeTimelineProjection({
    sessionId,
    events: events.slice(0, -1),
  });
  assertSharedConversationProjectionV2(beforeFacts);
  const beforeFactOperations = Object.fromEntries(
    beforeFacts.turns[0].workSegments.flatMap((segment) =>
      segment.operations.map((operation) => [operation.operationId, operation])
    )
  );
  for (const operationId of ['operation-read', 'operation-write']) {
    const operation = beforeFactOperations[operationId];
    assert.ok(operation, `missing pre-facts operation ${operationId}`);
    assert.equal(Object.hasOwn(operation, 'canonicalAction'), false);
    assert.equal(Object.hasOwn(operation, 'targets'), false);
    assert.equal(Object.hasOwn(operation, 'effectSummary'), false);
    assert.deepEqual(operation.resourceRefs, []);
    assert.deepEqual(operation.effectRefs, []);
  }

  const projection = buildNarrativeTimelineProjection({ sessionId, events });
  assertSharedConversationProjectionV2(projection);
  const turn = projection.turns[0];
  assert.equal(turn.workSegments.length, 2);
  assert.deepEqual(
    turn.parts,
    [
      { kind: 'block', blockId: turn.blocks[0].id },
      { kind: 'block', blockId: turn.blocks[1].id },
      {
        kind: 'workSegment',
        workSegmentId: turn.workSegments[0].id,
      },
      { kind: 'block', blockId: turn.blocks[2].id },
      {
        kind: 'workSegment',
        workSegmentId: turn.workSegments[1].id,
      },
    ]
  );
  assert.deepEqual(
    turn.workSegments.flatMap((segment) =>
      segment.operations.map((operation) => operation.operationId)
    ),
    ['operation-read', 'operation-write']
  );
  const operations = Object.fromEntries(
    turn.workSegments.flatMap((segment) =>
      segment.operations.map((operation) => [operation.operationId, operation])
    )
  );
  assert.equal(operations['operation-read'].canonicalAction,
    'Read workspace file README.md');
  assert.deepEqual(operations['operation-read'].targets, ['README.md']);
  assert.deepEqual(operations['operation-read'].attempts, [{
    attemptId: 'attempt-read',
    status: 'completed',
    startedAt: timestamp(5),
    completedAt: timestamp(5),
  }]);
  assert.equal(operations['operation-write'].effectSummary,
    'Updated one canonical workspace resource.');
  assert.deepEqual(operations['operation-write'].effectRefs, ['effect-write']);
  assert.equal(
    turn.blocks.some((block) =>
      block.provenance.sourceEventRefs.some((eventId) =>
        eventId.includes('provider.started')
        || eventId.includes('wait.changed')
        || eventId.includes('kernelFacts.reconciled')
      )
    ),
    false,
    'replaceable lifecycle state and fact wakeups must not become history cards'
  );
  assert.equal(
    JSON.stringify(projection).includes('rawArguments'),
    false
  );
}

async function providerComposingArchivesBeforePublishAndAdmitsZeroToolsOnStaleOrProjectionFailure() {
  const sessionId = 'session-provider-composing-contract';
  const runId = 'run-provider-composing-contract';
  const requestId = 'provider-turn-safe-publication';
  const published = [];
  const streamResult = await consumeProviderSseV1(
    providerSseStream([
      providerSseEvent('provider_metadata', {
        type: 'provider_metadata',
        requestId,
        providerProfileId: 'provider-profile-v2-contract',
        provider: 'contract-provider',
        model: 'contract-model',
      }),
      providerSseEvent('provider_commentary_delta', {
        type: 'provider_commentary_delta',
        requestId,
        chunk: {
          type: 'delta',
          content: 'Archived commentary.',
          providerPhase: 'commentary',
        },
      }),
      providerSseEvent('provider_delta', {
        type: 'provider_delta',
        requestId,
        chunk: {
          type: 'delta',
          content: '  {"toolId":"fs.read"}',
        },
      }),
      providerSseEvent('provider_final_delta', {
        type: 'provider_final_delta',
        requestId,
        chunk: {
          type: 'delta',
          content: 'Final answer.',
          providerPhase: 'final_answer',
        },
      }),
      providerSseEvent('provider_terminal', {
        type: 'provider_terminal',
        requestId,
        receipt: createProviderCompletionReceipt(
          `sha256:${'a'.repeat(64)}`
        ),
      }),
    ]),
    requestId,
    new AbortController().signal,
    async (delta) => published.push(delta)
  );
  assert.deepEqual(published, [
    {
      providerTurnId: requestId,
      streamSequence: 1,
      textOrdinal: 1,
      providerPhase: 'commentary',
      textDelta: 'Archived commentary.',
    },
    {
      providerTurnId: requestId,
      streamSequence: 2,
      textOrdinal: 2,
      textDelta: '  {"toolId":"fs.read"}',
    },
    {
      providerTurnId: requestId,
      streamSequence: 3,
      textOrdinal: 3,
      textDelta: 'Final answer.',
    },
  ], 'all archived assistant text is visible while unsealed phases stay unknown');
  assert.deepEqual(
    streamResult.items.map((item) => item.kind === 'text'
      ? { phase: item.phase, text: item.text }
      : { kind: item.kind }),
    [
      { phase: 'commentary', text: 'Archived commentary.' },
      { phase: 'unknown', text: '  {"toolId":"fs.read"}' },
      { phase: 'final_answer', text: 'Final answer.' },
    ],
    'the sealed terminal binds phases without treating tool-shaped text as control data'
  );
  const input = publicProjectionEvent(
    sessionId,
    runId,
    1,
    'input.persisted',
    {
      inputId: 'input-provider-composing',
      opaqueInputRef: 'opaque-input-provider-composing',
      text: 'Explain before using tools.',
      attachments: [],
      recordedAt: timestamp(1),
      controlEpoch: 1,
    }
  );
  const first = publicProjectionEvent(
    sessionId,
    runId,
    2,
    'provider.composing',
    {
      providerTurnId: 'provider-turn-composing',
      controlEpoch: 1,
      streamSequence: 1,
      textOrdinal: 1,
      providerPhase: 'commentary',
      textDelta: 'Inspecting ',
    }
  );
  const second = publicProjectionEvent(
    sessionId,
    runId,
    3,
    'provider.composing',
    {
      providerTurnId: 'provider-turn-composing',
      controlEpoch: 1,
      streamSequence: 2,
      textOrdinal: 1,
      providerPhase: 'commentary',
      textDelta: 'the workspace.',
    }
  );
  assert.deepEqual(
    Object.keys(first.payload).sort(),
    [
      'channel',
      'content',
      'controlEpoch',
      'providerPhase',
      'providerTurnId',
      'projectionId',
      'projectionKind',
      'runId',
      'schemaVersion',
      'status',
      'streamSequence',
      'textOrdinal',
      'visibility',
    ].sort()
  );
  const composing = buildNarrativeTimelineProjection({
    sessionId,
    events: [input, first, second],
  });
  assert.equal(composing.turns[0].blocks.length, 2);
  assert.equal(
    composing.turns[0].blocks[1].bodyMarkdown,
    'Inspecting the workspace.'
  );
  assert.equal(composing.turns[0].blocks[1].entryRole, 'agentUpdate');
  assert.equal(JSON.stringify(composing).includes('reasoning'), false);
  assert.equal(JSON.stringify(composing).includes('rawProvider'), false);

  const skippedSequence = publicProjectionEvent(
    sessionId,
    runId,
    4,
    'provider.composing',
    {
      providerTurnId: 'provider-turn-composing',
      controlEpoch: 1,
      streamSequence: 4,
      textOrdinal: 1,
      providerPhase: 'commentary',
      textDelta: 'must fail',
    }
  );
  assert.throws(
    () => buildNarrativeTimelineProjection({
      sessionId,
      events: [input, first, skippedSequence],
    }),
    /session_projection_provider_composing_sequence_invalid/u
  );

  const stale = publicProjectionEvent(
    sessionId,
    runId,
    5,
    'provider.stale',
    {
      providerTurnId: 'provider-turn-composing',
      controlEpoch: 1,
    }
  );
  const staleProjection = buildNarrativeTimelineProjection({
    sessionId,
    events: [input, first, stale],
  });
  assert.equal(staleProjection.turns[0].workSegments.length, 0);

  const harness = await openSessionHarness();
  harness.enqueueProvider(providerToolIntent(
    'fs.read',
    { path: 'README.md' },
    'provider-call-projection-failure'
  ));
  harness.enqueueKernel('submitToolIntent', (request) =>
    admittedReply(harness, request));
  const project = harness.ports.projection.project.bind(
    harness.ports.projection
  );
  harness.ports.projection.project = async (event) => {
    if (event.kind === 'provider.completed') {
      throw new Error('controlled_projection_failure');
    }
    return project(event);
  };
  await assert.rejects(
    harness.loop.runProviderTurn({
      reason: 'userInput',
      target: { kind: 'planning' },
    }),
    /controlled_projection_failure/u
  );
  assert.equal(
    harness.calls('submitToolIntent').length,
    0,
    'projection failure must stop before any Kernel tool admission'
  );
}

async function previewRejectionMarksOnlyTargetNeedsRevisionAndCreatesNoWorkSegment() {
  const sessionId = 'session-preview-rejection-contract';
  const runId = 'run-preview-rejection-contract';
  const plan = threeActionPlan(runId);
  const rejectedAction = plan.actions[0];
  const events = [
    planInputEvent(sessionId, runId, 1),
    publicProjectionEvent(
      sessionId,
      runId,
      2,
      'plan.persisted',
      plan
    ),
    publicProjectionEvent(
      sessionId,
      runId,
      3,
      'scope.previewed',
      {
        kind: 'rejected',
        data: {
          toolId: rejectedAction.manifest.toolId,
          reason: 'settingsDenied',
          guidance: 'Revise only the first action scope.',
        },
        plan,
        scopePreviews: [],
        planRevision: plan.planRevision,
        planActionId: rejectedAction.manifest.planActionId,
        operationId: rejectedAction.manifest.operationId,
      }
    ),
  ];
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events,
  });
  assertSharedConversationProjectionV2(projection);
  assert.deepEqual(
    projection.taskProjection.items.map((item) => ({
      id: item.id,
      status: item.status,
    })),
    [
      {
        id: rejectedAction.taskId,
        status: 'needsRevision',
      },
      { id: plan.actions[1].taskId, status: 'planned' },
      { id: plan.actions[2].taskId, status: 'planned' },
    ],
    'a rejected canonical preview may revise only its exact PlanAction'
  );
  assert.equal(
    projection.taskProjection.items.some((item) =>
      item.status === 'running' || item.status === 'completed'
    ),
    false
  );
  assert.equal(
    projection.turns.flatMap((turn) => turn.workSegments).length,
    0,
    'a preview rejection has no invocation and therefore no WorkSegment'
  );
}

async function taskProjectionTracksPlanAuthorityWithoutQueuedFallback() {
  const sessionId = 'session-plan-authority-contract';
  const runId = 'run-plan-authority-contract';
  const plan = threeActionPlan(runId);
  const firstAction = plan.actions[0];
  const events = [
    planInputEvent(sessionId, runId, 1),
    publicProjectionEvent(
      sessionId,
      runId,
      2,
      'plan.persisted',
      plan
    ),
    publicProjectionEvent(
      sessionId,
      runId,
      3,
      'plan.commentaryReleased',
      {
        planRevision: plan.planRevision,
        providerTurnId: 'provider-turn-plan-authority',
        controlEpoch: 1,
        orderedItems: [{
          kind: 'text',
          phase: 'commentary',
          text: 'Narration may say queued, running, or completed without changing task facts.',
        }],
        recordedAt: timestamp(3),
      }
    ),
    publicProjectionEvent(
      sessionId,
      runId,
      4,
      'plan.decided',
      {
        planRevision: plan.planRevision,
        decision: 'accept',
        recordedAt: timestamp(4),
      }
    ),
    publicProjectionEvent(
      sessionId,
      runId,
      5,
      'authorization.decided',
      {
        factId: 'fact-plan-authority-only',
        factKind: 'capabilityIssued',
        controlEpoch: 1,
        planActionIds: [firstAction.manifest.planActionId],
        operationId: firstAction.manifest.operationId,
        resourceIds: [],
        details: {},
      }
    ),
  ];
  const projection = buildNarrativeTimelineProjection({
    sessionId,
    events,
  });
  assertSharedConversationProjectionV2(projection);
  assert.deepEqual(
    projection.taskProjection.items.map((item) => item.status),
    ['authorized', 'authorized', 'authorized'],
    'accepted Plan authority remains authorized until invocation or facts establish another status'
  );
  assert.equal(
    projection.taskProjection.items.some((item) =>
      item.status === 'running' || item.status === 'completed'
    ),
    false,
    'narration and capability facts cannot imply execution'
  );
  assert.equal(
    projection.turns.flatMap((turn) => turn.workSegments).length,
    0,
    'authority without an invocation cannot manufacture a WorkSegment'
  );
}

function planInputEvent(sessionId, runId, sequence) {
  return publicProjectionEvent(
    sessionId,
    runId,
    sequence,
    'input.persisted',
    {
      inputId: `input-${runId}`,
      opaqueInputRef: `opaque-${runId}`,
      text: 'Prepare a reviewed three-action plan.',
      attachments: [],
      recordedAt: timestamp(sequence),
      controlEpoch: 1,
    }
  );
}

function threeActionPlan(runId) {
  const first = createPlan({ runId });
  const action = (ordinal, path) => ({
    taskId: `task-plan-authority-${ordinal}`,
    manifest: {
      planRevision: first.planRevision,
      planActionId: `plan-action-authority-${ordinal}`,
      operationId: `operation-authority-${ordinal}`,
      toolId: 'fs.write',
      requestedResources: [{
        kind: 'workspacePath',
        data: { path, access: 'write' },
      }],
    },
    previewArguments: { path, content: `content-${ordinal}` },
    idempotencyKey: `idempotency-authority-${ordinal}`,
    deadline: { kind: 'contractDefault', data: {} },
  });
  return {
    ...first,
    actions: [
      {
        ...first.actions[0],
        taskId: 'task-plan-authority-1',
        manifest: {
          ...first.actions[0].manifest,
          planActionId: 'plan-action-authority-1',
          operationId: 'operation-authority-1',
        },
        idempotencyKey: 'idempotency-authority-1',
      },
      action(2, 'second.txt'),
      action(3, 'third.txt'),
    ],
  };
}

function publicProjectionEvent(
  sessionId,
  runId,
  sequence,
  kind,
  data
) {
  return sessionKernelAgentEventV2(sessionId, {
    projectionId: `projection-${sequence}-${kind}`,
    runId,
    recordedAt: timestamp(sequence),
    kind,
    data,
  });
}

function canonicalOperationFact(options) {
  return {
    operationId: options.operationId,
    invocationId: options.invocationId,
    attemptId: options.attemptId,
    toolId: options.toolId,
    factId: options.factId,
    factKind: 'toolCompleted',
    resourceIds: [options.resourceId],
    targets: [options.target],
    effectId: options.effectId,
    canonicalAction: options.canonicalAction,
    effectSummary: options.effectSummary,
    recordedAt: timestamp(5),
  };
}

function providerOutcome() {
  return {
    providerProfileId: 'provider-profile-v2-contract',
    provider: 'contract-provider',
    model: 'contract-model',
  };
}

function providerSseEvent(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function providerSseStream(frames) {
  const bytes = new TextEncoder().encode(frames.join(''));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function timestamp(sequence) {
  return new Date(
    Date.parse('2026-07-29T01:00:00.000Z') + sequence * 1_000
  ).toISOString();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutate(value, callback) {
  const copy = clone(value);
  callback(copy);
  return copy;
}
