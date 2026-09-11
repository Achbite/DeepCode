import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal, loopSnapshot } from '../../session-core/dist/index.js';
import {
  decodeGuiProjection,
  inputCacheMetric,
  lastCallInputCacheMetric,
  loadGuiModelStore,
  loadGuiModule,
  installGuiFetch,
} from './gui-projection-contract.mjs';
import {
  workspaceBinding,
  actorWith,
  fakeRunPreparation,
  emptyKernel,
  completedExecutionReply,
  providerEvent,
  messageCommand,
  jsonMessagePayload,
  createSession,
  readEvents,
  singleEvent,
  assertEventOrder,
  waitForProjection,
  waitUntil,
} from '../../session-core/tests/local-agent-fixtures.mjs';

test('last-call, per-run, and Session cache rates use their own input token totals', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:cache-scopes';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const usages = [
    { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 75, cacheMissInputTokens: 25 },
    { inputTokens: 300, outputTokens: 90, cacheReadInputTokens: 25, cacheMissInputTokens: 275 },
  ];
  let callIndex = 0;
  const provider = {
    async *stream(request) {
      const usage = usages[callIndex++];
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:cache-${callIndex}`,
        content: `Answer ${callIndex}.`,
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { ...usage, contextWindowTokens: 4_096 },
      });
    },
  };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'cache-scopes');
  t.after(() => actor.dispose());
  let projection;
  for (let index = 0; index < usages.length; index += 1) {
    await actor.submit(messageCommand(sessionId, `command:cache-${index}`, `Question ${index}.`));
    projection = await waitForProjection(actor, (value) => (
      value.run?.status === 'completed' && value.tokenUsage.providerCallCount === index + 1
    ));
  }
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  const sessionCache = inputCacheMetric(projection.tokenUsage);
  const lastCallCache = lastCallInputCacheMetric(projection.contextUsage);
  assert.equal(sessionCache.inputTokens, 400);
  assert.equal(sessionCache.hitTokens, 100);
  assert.equal(sessionCache.hitPercent, 25);
  assert.equal(lastCallCache.inputTokens, 300);
  assert.equal(lastCallCache.hitTokens, 25);
  assert.equal(lastCallCache.hitPercent, 25 / 300 * 100);
  assert.deepEqual(projection.tokenUsageHistory.map((round) => ({
    input: round.inputTokens,
    hit: round.cacheReadInputTokens,
    miss: round.cacheMissInputTokens,
    ratio: round.cacheHitRatio,
  })), [
    { input: 300, hit: 25, miss: 275, ratio: 25 / 300 },
    { input: 100, hit: 75, miss: 25, ratio: 75 / 100 },
  ]);
  const lastReceipt = projection.contextCompositions.find((receipt) => (
    receipt.providerRequestId === projection.contextUsage.providerRequestId
  ));
  assert.ok(lastReceipt);
  assert.equal(lastReceipt.partitions.reduce((sum, part) => sum + part.estimatedInputTokens, 0), 300);
  assert.equal(lastCallInputCacheMetric(null), null);
  assert.equal(lastCallInputCacheMetric({
    inputTokens: 0, outputTokens: 0, contextWindowTokens: 4_096,
    cacheReadInputTokens: 0, cacheMissInputTokens: 0,
  }), null);
});

test('compaction owns last-call usage and an unreported next call clears it without losing Session totals', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:cache-latest';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  let releaseLastCall;
  const lastCallHeld = new Promise((resolve) => { releaseLastCall = resolve; });
  let callCount = 0;
  const requests = [];
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      const index = ++callCount;
      if (index === 3) await lastCallHeld;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:cache-latest-${index}`,
        content: request.purpose === 'contextCompaction' ? 'Keep the established facts.' : `Answer ${index}.`,
      });
      yield providerEvent(request.requestId, 'completed', index === 3 ? {} : {
        usage: {
          inputTokens: index === 1 ? 100 : 200,
          outputTokens: 10,
          cacheReadInputTokens: index === 1 ? 75 : 20,
          cacheMissInputTokens: index === 1 ? 25 : 180,
          contextWindowTokens: 4_096,
        },
      });
    },
  };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'cache-latest');
  t.after(async () => { releaseLastCall(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId, 'command:cache-latest-seed', 'Establish the facts.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'context.focus',
    commandId: 'command:cache-latest-focus',
    sessionId,
    task: 'Preserve the established facts.',
  });
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'running' && callCount === 3
  ));
  assert.deepEqual(requests.map((request) => request.purpose), ['agent', 'contextCompaction', 'agent']);
  assert.equal(waiting.contextUsage.providerRequestId, requests[1].requestId);
  assert.equal(lastCallInputCacheMetric(waiting.contextUsage).hitPercent, 10);
  const compactedReceipt = waiting.contextCompositions.find((receipt) => (
    receipt.providerRequestId === waiting.contextUsage.providerRequestId
  ));
  assert.equal(compactedReceipt.purpose, 'contextCompaction');
  assert.equal(compactedReceipt.partitions.reduce((sum, part) => sum + part.estimatedInputTokens, 0), 200);
  assert.deepEqual(await decodeGuiProjection(waiting), waiting);
  releaseLastCall();
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.contextUsage, null);
  assert.equal(lastCallInputCacheMetric(completed.contextUsage), null);
  assert.equal(completed.contextCompositions.at(-1).providerRequestId, requests[2].requestId);
  assert.equal(completed.contextCompositions.length, 1);
  const historical = await actor.contextComposition(requests[0].requestId);
  assert.equal(historical.providerRequestId, requests[0].requestId);
  historical.messages.length = 0;
  assert.ok((await actor.contextComposition(requests[0].requestId)).messages.length > 0);
  await assert.rejects(actor.contextComposition('provider-request:missing'), /context_composition_not_found/u);
  assert.equal(completed.tokenUsage.inputTokens, 300);
  assert.equal(completed.tokenUsage.cacheReadInputTokens, 95);
  assert.equal(completed.tokenUsage.cacheHitRatio, 95 / 300);
  assert.equal(completed.tokenUsage.providerCallCount, 3);
  assert.equal(completed.tokenUsage.reportedCallCount, 2);
  assert.equal(completed.tokenUsage.cacheComplete, false);
  assert.equal(inputCacheMetric(completed.tokenUsage).complete, false);
  assert.deepEqual(await decodeGuiProjection(completed), completed);
});

test('reasoning-only streaming projects activity without raw reasoning or per-chunk journal events', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:reasoning-draft';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  let continueStream;
  const streamHeld = new Promise((resolve) => { continueStream = resolve; });
  let reasoningConsumed;
  const reasoningWasConsumed = new Promise((resolve) => { reasoningConsumed = resolve; });
  const provider = {
    async *stream(request) {
      yield providerEvent(request.requestId, 'reasoning.delta', {
        text: 'Inspecting the current workspace state.',
      });
      reasoningConsumed();
      await streamHeld;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:reasoning-draft',
        content: 'The inspection is complete.',
        reasoningContent: 'Inspecting the current workspace state.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'reasoning-draft',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:reasoning-draft',
    'Inspect the workspace before answering.',
  ));
  await reasoningWasConsumed;
  const running = await waitForProjection(actor, (value) => (
    value.run?.status === 'running' && value.assistantDraft?.activity?.phase === 'reasoning'
  ));
  assert.equal(running.run.status, 'running');
  assert.deepEqual(running.assistantDraft.blocks, []);
  assert.equal(running.assistantDraft.reasoningContent, undefined);
  assert.equal(running.assistantDraft.content, undefined);
  assert.equal(running.assistantDraft.activity.purpose, 'agent');
  assert.ok(Date.parse(running.assistantDraft.activity.lastContentAt) >= Date.parse(running.assistantDraft.activity.startedAt));
  assert.deepEqual(await decodeGuiProjection(running), running);
  assert.ok(!JSON.stringify(running).includes('Inspecting the current workspace state.'));
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type.includes('reasoning')), false);

  continueStream();
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.assistantDraft, null);
  const events = await readEvents(journal, sessionId);
  assert.equal(
    singleEvent(events, 'provider.turn.settled').payload.reasoningContent,
    'Inspecting the current workspace state.',
  );

  await actor.dispose();
});

test('snapshot-scoped wire tool resolves to exact Kernel bindings, durable ToolRecord, and continuation', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:tool-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read one fixture path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string' },
      },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  let releaseTool;
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      await toolGate;
      return completedExecutionReply(request, { content: 'fixture file contents' });
    },
  });
  const providerRequests = [];
  let wireToolName;
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const definition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.path !== undefined
        ));
        assert.ok(definition, 'prepared Kernel tool must be exposed to Provider');
        wireToolName = definition.name;
        assert.notEqual(wireToolName, preparedTool.name);
        assert.match(wireToolName, /^[A-Za-z0-9_-]{1,64}$/u);
        assert.deepEqual(definition.inputSchema.required, ['path', 'workspace']);
        assert.ok(definition.inputSchema.properties.workspace);
        assert.equal(definition.inputSchema.properties.workspaceId, undefined);
        yield providerEvent(request.requestId, 'text.delta', {
          text: 'I will inspect the fixture before answering.',
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:read',
          name: wireToolName,
          input: { workspace: 'primary', path: 'README.md' },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            contextWindowTokens: 4_096,
            cacheReadInputTokens: 40,
            cacheMissInputTokens: 60,
          },
        });
        return;
      }

      const definition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.path !== undefined
      ));
      assert.equal(definition?.name, wireToolName);
      const assistantToolCall = request.messages
        .flatMap((entry) => entry.toolCalls ?? [])
        .find((call) => call.name === wireToolName);
      assert.ok(assistantToolCall, 'continuation must include the previous tool call');
      assert.equal(assistantToolCall.input, '{"workspace":"primary","path":"README.md"}');
      assert.notEqual(assistantToolCall.callId, 'provider-call:read');
      assert.equal(assistantToolCall.providerCallId, 'provider-call:read');
      assert.ok(request.messages.some((entry) => (
        entry.role === 'tool'
        && entry.toolCallId === assistantToolCall.callId
        && entry.providerCallId === 'provider-call:read'
      )), 'continuation must include the ToolRecord result');

      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:tool-answer',
        content: 'Tool continuation completed.',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          contextWindowTokens: 4_096,
        },
      });
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'tool-chain',
  );
  t.after(async () => { releaseTool(); await actor.dispose(); });

  await actor.submit(messageCommand(sessionId, 'command:tool', 'Use the available fixture tool.'));
  await waitUntil(() => kernelRequests.length === 1, 'pending tool execution');
  try {
    const pending = await actor.snapshot();
    const activity = pending.activities.find((item) => item.kind === 'tool');
    assert.equal(activity.status, 'requested');
    assert.equal(activity.tool, undefined, 'requested tools have no execution record yet');
    assert.deepEqual(await decodeGuiProjection(pending), pending);
  } finally {
    releaseTool();
  }
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  await waitUntil(() => preparation.released.length === 1, 'tool runtime release');

  assert.equal(providerRequests.length, 2);
  assert.equal(kernelRequests.length, 1);
  assert.deepEqual(projection.tokenUsage, {
    providerCallCount: 2,
    reportedCallCount: 1,
    inputTokens: 150,
    outputTokens: 15,
    cacheReadInputTokens: 40,
    cacheMissInputTokens: 60,
    cacheAvailable: true,
    cacheComplete: false,
    cacheHitRatio: 40 / 150,
  });
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  assert.equal(inputCacheMetric(projection.tokenUsage).inputTokens, 150);
  assert.equal(lastCallInputCacheMetric(projection.contextUsage), null);
  const missingToolRecord = structuredClone(projection);
  delete missingToolRecord.activities.find((item) => item.kind === 'tool').tool;
  await assert.rejects(decodeGuiProjection(missingToolRecord), /conversation_projection_invalid/u);
  assert.deepEqual(projection.timeline.map((item) => item.kind), [
    'message',
    'narrative',
    'toolGroup',
    'message',
  ]);
  assert.equal(projection.narratives[0].content, 'I will inspect the fixture before answering.');
  assert.deepEqual(projection.timeline[2].activityIds, [projection.activities
    .find((activity) => activity.kind === 'tool').activityId]);
  const execution = kernelRequests[0];
  const runtime = preparation.snapshots[0];
  assert.deepEqual({
    sessionId: execution.sessionId,
    runId: execution.runId,
    extensionGenerationRef: execution.extensionGenerationRef,
    kernelCatalogSnapshotRef: execution.kernelCatalogSnapshotRef,
    toolBindingRef: execution.toolBindingRef,
    toolName: execution.toolName,
    input: execution.input,
  }, {
    sessionId,
    runId: projection.run.runId,
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: preparedTool.toolBindingRef,
    toolName: preparedTool.name,
    input: { workspaceId: workspaceBinding.workspaceId, path: 'README.md' },
  });

  const events = await readEvents(journal, sessionId);
  const requested = singleEvent(events, 'tool.requested');
  const toolCompleted = singleEvent(events, 'tool.completed');
  const completions = events.filter((event) => event.type === 'provider.turn.settled');
  assert.equal(completions.length, 2);
  assert.deepEqual(completions[0].payload.orderedCallIds, [requested.callId]);
  assert.notEqual(requested.callId, requested.payload.providerCallId);
  assert.equal(requested.payload.toolName, preparedTool.name);
  assert.deepEqual({
    extensionGenerationRef: toolCompleted.payload.record.extensionGenerationRef,
    kernelCatalogSnapshotRef: toolCompleted.payload.record.kernelCatalogSnapshotRef,
    toolBindingRef: toolCompleted.payload.record.toolBindingRef,
    callId: toolCompleted.payload.record.callId,
    attemptId: toolCompleted.payload.record.attemptId,
    toolName: toolCompleted.payload.record.toolName,
  }, {
    extensionGenerationRef: runtime.extensionGenerationRef,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
    toolBindingRef: preparedTool.toolBindingRef,
    callId: requested.callId,
    attemptId: requested.payload.attemptId,
    toolName: preparedTool.name,
  });
  assertEventOrder(requested, completions[0], toolCompleted, completions[1]);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: projection.run.runId,
    kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
  }]);
});

test('input rejection is fed back once, valid batch peers execute once, and a corrected call succeeds', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:input-rejection';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef: 'tool-binding:read:g1', name: 'fs.read', description: 'Read source text.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, maxLines: { type: 'integer', minimum: 1 } }, additionalProperties: false },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  const executed = [];
  const kernel = emptyKernel({ async execute(request) {
    executed.push(structuredClone(request));
    if (request.input.maxLines === 0) {
      const { recordId, preparedEffect, authority, startedAt, completedAt, outcome, output, ...identity } = completedExecutionReply(request, {}).record;
      return {
        schemaVersion: 'deepcode.kernel-reply', type: 'tool.execution', requestId: request.requestId,
        callId: request.callId, status: 'inputRejected', rejection: { ...identity,
          rejectedAt: '2026-09-07T00:00:00Z',
          error: { code: 'tool_input_invalid', message: 'maxLines must be positive', issues: [{ path: '$.maxLines', rule: 'minimum', message: 'Use at least one line.', expected: 1 }] },
        },
      };
    }
    return completedExecutionReply(request, { content: `${request.input.path} content` });
  } });
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    const wire = request.tools.find((tool) => tool.inputSchema.properties?.path)?.name;
    if (turns === 1) {
      for (const [callId, path, maxLines] of [['bad', 'README.md', 0], ['peer', 'overview.md', 10]]) {
        yield providerEvent(request.requestId, 'tool.call', { callId: `provider-call:${callId}`, name: wire, input: { workspace: 'primary', path, maxLines } });
      }
    } else if (turns === 2) {
      const results = request.messages.filter((message) => message.role === 'tool');
      const rejection = results.filter((message) => jsonMessagePayload(message)?.status === 'inputRejected');
      assert.equal(rejection.length, 1);
      assert.equal(rejection[0].providerCallId, 'provider-call:bad');
      assert.equal(jsonMessagePayload(rejection[0]).executed, false);
      assert.equal(jsonMessagePayload(rejection[0]).error.issues[0].path, '$.maxLines');
      assert.ok(results.some((message) => message.providerCallId === 'provider-call:peer'));
      yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:corrected', name: wire, input: { workspace: 'primary', path: 'README.md', maxLines: 10 } });
    } else {
      assert.equal(turns, 3);
      yield providerEvent(request.requestId, 'assistant.message', { content: 'Read completed after correcting the input.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'input-rejection');
  await actor.submit(messageCommand(sessionId, 'command:rejection', 'Read the files.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.deepEqual(executed.map((request) => [request.input.path, request.input.maxLines]), [['README.md', 0], ['overview.md', 10], ['README.md', 10]]);
  const events = await readEvents(journal, sessionId);
  const rejected = singleEvent(events, 'tool.input-rejected');
  assert.equal(events.filter((event) => event.type === 'tool.completed').length, 2);
  assert.equal(events.some((event) => event.type === 'tool.completed' && event.callId === rejected.callId), false);
  assert.equal(events.some((event) => event.type === 'todo.progressed'), false);
  assert.equal(projection.activities.find((activity) => activity.callId === rejected.callId).status, 'rejected');
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  assert.deepEqual(loopSnapshot(sessionId, events).state.modelSettings, projection.modelSettings);
  await actor.dispose();
});

test('completed malformed arguments are durable unexecuted results; valid peers and correction execute once', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:native-input-rejection';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ apiSurface: 'responses', contextWindowTokens: 100_000, tools: [{
    toolBindingRef: 'binding:read', name: 'fs.read', description: 'Read text.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  const executed = [];
  const kernel = emptyKernel({ async execute(request) {
    executed.push(structuredClone(request));
    return completedExecutionReply(request, { content: request.input.path });
  } });
  const badArguments = '{"workspace":"primary","path":"unterminated';
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    const name = request.tools.find((tool) => tool.inputSchema.properties?.path).name;
    if (turns === 1) {
      for (const [outputIndex, callId, args] of [
        [0, 'bad-json', badArguments],
        [1, 'bad-shape', '[]'],
        [2, 'peer', JSON.stringify({ workspace: 'primary', path: 'overview.md' })],
      ]) {
        yield providerEvent(request.requestId, 'output.item.completed', {
          outputIndex, item: { type: 'function_call', call_id: callId, name, arguments: args, status: 'completed' },
        });
      }
      // Rendering this message must not reparse the preceding rejected arguments.
      yield providerEvent(request.requestId, 'output.item.completed', {
        outputIndex: 3, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading files.' }] },
      });
    } else if (turns === 2) {
      const replay = request.messages.find((message) => message.providerOutputBlocks).providerOutputBlocks;
      assert.deepEqual(replay.map((block) => block.kind), ['toolCallRejected', 'toolCallRejected', 'toolCall', 'narrative']);
      assert.equal(replay[0].item.arguments, badArguments);
      assert.equal(replay[1].item.arguments, '[]');
      const results = request.messages.filter((message) => message.role === 'tool');
      assert.equal(results.length, 3);
      for (const rejected of replay.slice(0, 2)) {
        const result = results.find((message) => message.providerCallId === rejected.providerCallId);
        assert.equal(result.toolCallId, rejected.callId);
        assert.equal(jsonMessagePayload(result).executed, false);
        assert.equal(jsonMessagePayload(result).error.code, 'provider_tool_call_arguments_invalid');
      }
      yield providerEvent(request.requestId, 'output.item.completed', {
        outputIndex: 0, item: { type: 'function_call', call_id: 'corrected', name, arguments: JSON.stringify({ workspace: 'primary', path: 'README.md' }), status: 'completed' },
      });
    } else {
      assert.equal(turns, 3);
      yield providerEvent(request.requestId, 'output.item.completed', {
        outputIndex: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Corrected and read.' }] },
      });
    }
    yield providerEvent(request.requestId, 'completed', { usage: { inputTokens: 100, outputTokens: 20, contextWindowTokens: 100_000, cacheReadInputTokens: 70, cacheMissInputTokens: 30 } });
  } };
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'native-correction');
  await actor.submit(messageCommand(sessionId, 'command:native-correction', 'Read the files.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(executed.map((request) => request.input.path), ['overview.md', 'README.md']);
  assert.equal(events.filter((event) => event.type === 'tool.requested').length, 2);
  assert.equal(events.filter((event) => event.type === 'tool.completed').length, 2);
  assert.equal(events.some((event) => event.type === 'tool.input-rejected'), false, 'Session rejection must not masquerade as a Kernel fact');
  assert.equal(projection.activities.filter((activity) => activity.status === 'rejected').length, 2);
  assert.equal(projection.tokenUsage.reportedCallCount, 3);
  assert.equal(projection.tokenUsage.cacheHitRatio, 0.7);
  assert.equal(JSON.stringify(projection).includes(badArguments), false);
  assert.deepEqual(await decodeGuiProjection(projection), projection);
  await actor.dispose();
  const reopened = actorWith(journal, sessionId, provider, kernel, preparation.port, 'native-reopened');
  assert.deepEqual(await reopened.snapshot(), projection);
  assert.equal(turns, 3);
  await reopened.dispose();
});

test('Plan input rejections survive actor reopen and do not suppress the final explanation', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:correction-budget';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ apiSurface: 'responses', contextWindowTokens: 100_000 });
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    assert.ok(turns <= 4, 'the final explanation must end this continuation');
    if (turns === 4) {
      assert.ok(request.messages.some((message) => jsonMessagePayload(message)?.error?.code === 'provider_tool_call_arguments_invalid'));
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Verification remains unfinished. The rejected call was not executed.' }] } });
      yield providerEvent(request.requestId, 'completed', {});
      return;
    }
    const name = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name;
    if (turns === 2) {
      const result = request.messages.find((message) => message.role === 'tool' && jsonMessagePayload(message)?.accepted === false);
      assert.ok(result);
      assert.equal(jsonMessagePayload(result).executed, false);
    }
    yield providerEvent(request.requestId, 'output.item.completed', {
      outputIndex: 0,
      item: { type: 'function_call', call_id: `native-plan-${turns}`, name, status: 'completed', arguments: turns === 1 ? '{}'
        : turns === 2 ? JSON.stringify({ title: 'Verify', summary: 'Verify remaining work.', steps: [{ stepId: 'verify', title: 'Verify', details: 'Run the project check.' }], mutationManifest: [] }) : '{' },
    });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'budget');
  await actor.submit(messageCommand(sessionId, 'command:budget', 'Plan the verification.'));
  const waiting = await waitForProjection(actor, (value) => value.run?.status === 'waiting' && value.pendingPlan !== null);
  const before = await readEvents(journal, sessionId);
  assert.equal(before.filter((event) => event.type === 'session.control.rejected').length, 1);
  assert.equal(before.filter((event) => event.type === 'plan.published').length, 1);
  assert.equal(before.some((event) => event.type === 'interaction.requested'), false);
  assert.deepEqual(await decodeGuiProjection(waiting), waiting);
  await actor.dispose();
  const reopened = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'budget-reopened');
  assert.equal(turns, 2);
  await reopened.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond', commandId: 'command:budget-confirm', sessionId,
    runId: waiting.run.runId, planId: waiting.pendingPlan.planId, revision: waiting.pendingPlan.revision, response: { kind: 'confirm' } });
  const failed = await waitForProjection(reopened, (value) => value.run?.status === 'failed');
  assert.equal(failed.terminalError.code, 'plan_incomplete');
  assert.equal(failed.todoList.items[0].status, 'pending');
  assert.ok(failed.messages.some((message) => message.role === 'assistant' && message.content === 'Verification remains unfinished. The rejected call was not executed.'));
  assert.equal(turns, 4);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'plan.confirmed').length, 1);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
  assert.ok(events.filter((event) => event.type === 'provider.turn.settled').every((event) => event.payload.outcome === 'completed'));
  assert.deepEqual(await decodeGuiProjection(failed), failed);
  await reopened.dispose();
});

test('Session settings persist independently while the active run keeps its frozen effort', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:model-settings';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation({ reasoningEffort: 'high' });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    if (turns === 1) await held;
    yield providerEvent(request.requestId, 'assistant.message', { content: 'Done.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'settings');
  const settingsCommand = (id, profileId, reasoningEffortOverride) => ({
    schemaVersion: 'deepcode.command.v3', type: 'session.model-settings.set', sessionId,
    commandId: id, settings: { profileId, reasoningEffortOverride },
  });
  await actor.submit(settingsCommand('command:settings1', 'profile:one', 'max'));
  assert.equal(preparation.prepared.length, 0);
  assert.equal(turns, 0);
  await actor.submit(messageCommand(sessionId, 'command:start1', 'First task.'));
  const first = await waitForProjection(actor, (value) => value.assistantDraft?.activity?.phase === 'waitingResponse');
  await actor.submit(settingsCommand('command:settings2', 'profile:one', 'low'));
  const edited = await actor.snapshot();
  assert.equal(edited.run.runId, first.run.runId);
  assert.equal(edited.run.reasoningEffort, 'max');
  assert.equal(edited.modelSettings.reasoningEffortOverride, 'low');
  assert.equal(preparation.prepared.length, 1);
  assert.equal(turns, 1);
  assert.deepEqual(await decodeGuiProjection(edited), edited);
  release();
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await actor.dispose();
  const reopened = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'settings-reopened');
  assert.equal((await reopened.snapshot()).modelSettings.reasoningEffortOverride, 'low');
  await reopened.submit(messageCommand(sessionId, 'command:start2', 'Second task.'));
  const second = await waitForProjection(reopened, (value) => value.run?.status === 'completed' && value.run.runId !== first.run.runId);
  assert.equal(second.run.reasoningEffort, 'low');
  await reopened.submit(settingsCommand('command:switch', 'profile:two', null));
  assert.equal((await reopened.snapshot()).modelSettings.reasoningEffortOverride, null);
  await reopened.submit(messageCommand(sessionId, 'command:start3', 'Third task.'));
  const third = await waitForProjection(reopened, (value) => value.run?.status === 'completed' && value.run.runId !== second.run.runId);
  assert.equal(third.run.profileId, 'profile:two');
  assert.equal(third.run.reasoningEffort, 'high');
  assert.deepEqual(preparation.prepared.map((request) => request.reasoningEffortOverride), ['max', 'low', undefined]);
  await reopened.dispose();
});

test('GUI model settings save after acknowledgement, reset effort on model change, and retain the last saved value on failure', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-settings';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream() { throw new Error('settings must not call Provider'); } }, emptyKernel(), fakeRunPreparation().port, 'gui-settings');
  t.after(() => actor.dispose());
  let commands = 0;
  let failSave = false;
  installGuiFetch(t, async (url, init) => {
    const sessionPath = `/api/conversation/sessions/${encodeURIComponent(sessionId)}`;
    if (url.pathname === `${sessionPath}/commands` && init.method === 'POST') {
      commands += 1;
      if (failSave) {
        return Response.json({ ok: false, error: 'fixture_settings_save_failed' }, { status: 500 });
      }
      return Response.json({ ok: true, data: await actor.submit(JSON.parse(init.body)) });
    }
    if (url.pathname === `${sessionPath}/projection` && (init.method ?? 'GET') === 'GET') {
      return Response.json({ ok: true, data: await actor.snapshot() });
    }
    throw new Error(`unexpected_gui_request:${init.method ?? 'GET'}:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ profiles: [
    { id: 'profile:one', name: 'My fast model', model: 'configured-model', enabled: true, thinking: 'enabled' },
    { id: 'profile:two', name: 'My other model', model: 'configured-model', enabled: true, thinking: 'enabled' },
    { id: 'profile:off', name: 'No reasoning', model: 'configured-model', enabled: true, thinking: 'disabled' },
  ] });
  await store.getState().selectProfile('profile:one');
  await store.getState().selectReasoningEffort('max');
  assert.equal(commands, 0, 'new draft selection stays in memory until a Session exists');
  assert.equal(store.getState().reasoningEffortOverride, 'max');
  store.setState({ sessionId, projection: await actor.snapshot() });
  await store.getState().selectReasoningEffort('low');
  assert.equal(store.getState().projection.modelSettings.reasoningEffortOverride, 'low');
  await store.getState().selectProfile('profile:two');
  assert.equal(store.getState().selectedProfileId, 'profile:two');
  assert.equal(store.getState().reasoningEffortOverride, null);
  assert.equal((await actor.snapshot()).modelSettings.profileId, 'profile:two');
  failSave = true;
  await store.getState().selectReasoningEffort('high');
  assert.equal(store.getState().reasoningEffortOverride, null);
  assert.match(store.getState().error, /fixture_settings_save_failed/);
  assert.equal(store.getState().modelSettingsBusy, false);
  failSave = false;
  await store.getState().selectProfile('profile:off');
  const before = commands;
  await store.getState().selectReasoningEffort('medium');
  assert.equal(commands, before);
  assert.equal(store.getState().reasoningEffortOverride, null);
  assert.equal((await actor.snapshot()).run, null);
});

test('starting a draft during initialization preserves navigation and still loads usable model configuration', async (t) => {
  let releaseCatalog;
  const catalogReady = new Promise((resolve) => { releaseCatalog = resolve; });
  const catalog = { projects: [{
    id: 'project:boot', title: 'Project', workspaceBindings: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }], sessions: [] };
  const pluginCatalog = { revision: 'plugin-catalog:boot', plugins: [] };
  const profile = { id: 'profile:boot', name: 'My model', model: 'configured-model', enabled: true, thinking: 'enabled' };
  installGuiFetch(t, async (url, init) => {
    assert.equal(init.method ?? 'GET', 'GET');
    if (url.pathname === '/api/conversation/catalog') {
      return Response.json({ ok: true, data: await catalogReady });
    }
    if (url.pathname === '/api/conversation/plugins') {
      return Response.json({ ok: true, data: pluginCatalog });
    }
    if (url.pathname === '/api/llm/profiles') {
      return Response.json({ ok: true, data: { profiles: [profile], defaultProfileId: profile.id } });
    }
    throw new Error(`new draft must not restore a Session:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  const initialization = store.getState().initialize();
  assert.equal(store.getState().loading, true);
  store.getState().startNewSession('project:boot');
  releaseCatalog(catalog);
  await initialization;
  const state = store.getState();
  assert.equal(state.draftProjectId, 'project:boot');
  assert.equal(state.sessionId, null);
  assert.equal(state.projection, null);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  assert.deepEqual(state.catalog, catalog);
  assert.deepEqual(state.pluginCatalog, pluginCatalog);
  assert.deepEqual(state.profiles, [profile]);
  assert.equal(state.defaultProfileId, profile.id);
  assert.equal(state.selectedProfileId, profile.id);
});


test('independent views own navigation, errors and pending commands separately', async (t) => {
  const { createLocalAgentStore } = await loadGuiModule(t, '/src/state/localAgentStore.ts');
  const first = createLocalAgentStore('view:one');
  const second = createLocalAgentStore('view:two');
  first.setState({ sessionId: 'session:one', error: 'old failure', submitting: true });
  second.setState({ sessionId: 'session:two', error: null, submitting: false });
  first.getState().startNewSession();
  assert.equal(first.getState().sessionId, null);
  assert.equal(first.getState().submitting, false);
  assert.equal(second.getState().sessionId, 'session:two');
  assert.equal(second.getState().error, null);
  second.setState({ submitting: true });
  assert.equal(first.getState().submitting, false);
});

test('large GUI input uploads the complete text and submits only the resulting resource reference', async (t) => {
  const api = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  const content = '  完整输入🙂\n'.repeat(10000);
  const reference = { referenceId: 'input:one', workspaceId: 'workspace:input', logicalPath: 'user-input.txt', displayName: 'user-input.txt', kind: 'file', mediaType: 'text/plain', byteLength: Buffer.byteLength(content) };
  const seen = [];
  installGuiFetch(t, (url, init) => {
    seen.push(url.pathname);
    if (url.pathname.includes('/input-resources/')) {
      assert.equal(init.body, content);
      return Response.json({ ok: true, data: { text: 'Read the original user input.', reference } });
    }
    const command = JSON.parse(init.body);
    assert.equal(command.text, 'Read the original user input.');
    assert.deepEqual(command.filesystemReferences, [reference]);
    assert.ok(Buffer.byteLength(init.body) < 2000);
    return Response.json({ ok: true, data: { schemaVersion: 'deepcode.command-reply.v3', commandId: command.commandId, sessionId: command.sessionId, status: 'accepted', revision: 1 } });
  });
  await api.submitLocalAgentCommand({ schemaVersion: 'deepcode.command.v3', type: 'message.submit', commandId: 'command:upload', sessionId: 'session:upload', text: content });
  assert.equal(seen.length, 2);
});

test('tool rows accumulate across adjacent requests without crossing message or run boundaries', async (t) => {
  const { projectionItems } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const activities = [1, 2, 3, 4].map((id) => ({ activityId: `a${id}`, runId: id === 4 ? 'run:two' : 'run:one' }));
  const group = (id) => ({ kind: 'toolGroup', timelineId: `group:${id}`, sequence: id, activityIds: [`a${id}`] });
  const projection = { activities, messages: [{ messageId: 'message:boundary', runId: 'run:one', role: 'user' }], timeline: [group(1), group(2), { kind: 'message', sequence: 3, messageId: 'message:boundary' }, group(3), group(4)] };
  const items = projectionItems(projection);
  assert.deepEqual(items.map((item) => item.type), ['toolGroup', 'message', 'toolGroup', 'toolGroup']);
  assert.equal(items[0].groupId, 'group:1');
  assert.deepEqual(items[0].values.map((activity) => activity.activityId), ['a1', 'a2']);
  assert.equal(projection.timeline.length, 5, 'presentation grouping leaves the canonical timeline intact');
});

test('plan preview occupies its native output position and has no confirmation identity', async (t) => {
  const { assistantDraftItems } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const preview = { callIndex: 1, providerCallId: 'call:plan', outputIndex: 1, title: 'Plan', summary: '', steps: ['Inspect'], truncated: false };
  const draft = { runId: 'run:one', turnId: 'request:one', planPreview: preview, blocks: [
    { kind: 'narrative', streamId: 'stream:before', outputIndex: 0, content: 'Before' },
    { kind: 'message', streamId: 'stream:after', outputIndex: 2, content: 'After' },
  ] };
  const items = assistantDraftItems(draft);
  assert.deepEqual(items.map((item) => item.type), ['text', 'planPreview', 'text']);
  assert.deepEqual(items[1].value, preview);
  assert.equal(items[1].value.planId, undefined);
  assert.equal(items[1].value.revision, undefined);
});

test('Plan documents and previews render Markdown entities, code names and verification consistently', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: PlanCard, PlanCardContent } = await loadGuiModule(t, '/src/components/local-agent/PlanCard.tsx');
  const { PlanPreviewCard, PlanPreviewContent } = await loadGuiModule(t, '/src/components/local-agent/PlanPreviewCard.tsx');
  const { MarkdownInline } = await loadGuiModule(t, '/src/components/local-agent/BufferedMarkdown.tsx');
  const { ComposerDecisionPanels } = await loadGuiModule(t, '/src/components/local-agent/ComposerDecisionPanels.tsx');
  const { InteractionReplyQuote } = await loadGuiModule(t, '/src/components/local-agent/ConversationTranscript.tsx');
  const plan = {
    planId: 'plan:document', revision: 1, runId: 'run:document', callId: 'call:document', status: 'published',
    title: '对象池 ObjectPool&lt;T,N&gt; 升级', summary: '保留 **互斥访问** 与 `C++17`。',
    steps: [{ stepId: 'write', title: '实现 `ObjectPool<T,N>`', details: '修改 `src/pool.hpp`。\n\n- 构造对象\n- 归还对象', verification: ['编译 **通过**；`exit 0`。'] }],
    mutationManifest: [{ workspaceId: 'workspace:private-id', operation: 'bash', workspaceMode: 'write', executionScope: 'workspace' }],
  };
  const published = renderToStaticMarkup(createElement(PlanCard, { plan, active: false, language: 'zh-CN' }));
  assert.ok(published.includes('aria-expanded="false"'), 'published plans wait for the reader to expand');
  assert.equal(published.includes('conversation-plan-document-body'), false, 'collapsed plans do not mount their long document');
  assert.ok(published.includes('ObjectPool&lt;T,N&gt;'));
  const html = renderToStaticMarkup(createElement(PlanCardContent, { plan, language: 'zh-CN' }));
  assert.ok(html.includes('ObjectPool&lt;T,N&gt;'));
  assert.equal(html.includes('&amp;lt;'), false, 'entities must be interpreted once by the Markdown parser');
  assert.match(html, /<code>ObjectPool&lt;T,N&gt;<\/code>/);
  assert.match(html, /<strong>通过<\/strong>/);
  assert.match(html, /<code>exit 0<\/code>/);
  assert.equal(html.includes('undefined'), false, 'optional command examples must not leak undefined');
  assert.equal(html.includes('workspace:private-id'), false, 'single-workspace review does not need internal IDs');
  assert.ok(html.includes('允许修改'));
  const previewProps = { language: 'zh-CN', preview: {
    callIndex: 0, providerCallId: 'call:preview', title: plan.title, summary: plan.summary, steps: plan.steps.map((step) => step.title), truncated: false,
  } };
  const previewCard = renderToStaticMarkup(createElement(PlanPreviewCard, previewProps));
  assert.ok(previewCard.includes('aria-expanded="false"'));
  assert.equal(previewCard.includes('conversation-plan-document-body'), false);
  assert.equal(previewCard.includes('确认执行'), false);
  const preview = renderToStaticMarkup(createElement(PlanPreviewContent, previewProps));
  for (const rendered of [html, preview]) {
    assert.ok(rendered.includes('conversation-plan-document-body'));
    assert.ok(rendered.includes('conversation-plan-document-content'));
    assert.match(rendered, /<code>ObjectPool&lt;T,N&gt;<\/code>/);
  }
  assert.equal(preview.includes('确认执行'), false, 'a display-only preview cannot authorize execution');
  const inline = renderToStaticMarkup(createElement(MarkdownInline, { children: '**对象池** [文档](https://example.com) `T<N>`' }));
  assert.match(inline, /<strong>对象池<\/strong>/);
  assert.equal(inline.includes('<a '), false, 'summary buttons cannot contain nested interactive links');
  const collapsed = renderToStaticMarkup(createElement(PlanCard, { plan: { ...plan, status: 'confirmed' }, active: true, language: 'zh-CN' }));
  assert.equal(collapsed.includes('&amp;lt;'), false);
  assert.ok(collapsed.includes('aria-expanded="false"'));
  const prompt = '保留 **容器环境** 吗？\n\n- 保留 `Dockerfile`\n- 删除演示产物';
  const question = renderToStaticMarkup(createElement(ComposerDecisionPanels, { language: 'zh-CN', composer: {
    pendingInteraction: { prompt, allowFreeform: true, options: [{ id: 'keep', label: '**保留**环境', description: '保留 `Makefile`。' }] },
    textareaRef: { current: null }, draft: '',
  } }));
  assert.match(question, /<strong>容器环境<\/strong>/);
  assert.match(question, /<code>Dockerfile<\/code>/);
  assert.match(question, /<code>Makefile<\/code>/);
  assert.ok(question.includes('local-agent__interaction-document-scroll'));
  const reply = renderToStaticMarkup(createElement(InteractionReplyQuote, { prompt }));
  assert.match(reply, /<details class="conversation-answered-question">/);
  assert.match(reply, /<code>Dockerfile<\/code>/, 'the full question remains available after answering');
});

test('reasoning details are a default-off shell preference in the real Settings catalog', async (t) => {
  const { SETTING_DEFINITIONS } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  const definition = SETTING_DEFINITIONS.find((definition) => definition.key === 'gui.showReasoning');
  assert.ok(definition);
  const { DEFAULT_USER_SETTINGS } = await import('../../protocol/dist/index.js');
  assert.equal(DEFAULT_USER_SETTINGS['gui.showReasoning'], false);
  assert.equal(definition.control, 'boolean');
  assert.equal(definition.group, 'gui');
});

test('response language uses the shared Settings catalog and a compact labelled control', async (t) => {
  const { SETTING_DEFINITIONS, agentSettingDefinitions } = await loadGuiModule(t, '/src/state/settingsStore.ts');
  const { DEFAULT_USER_SETTINGS, shellPreferenceSettingsIndex } = await import('../../protocol/dist/index.js');
  const definition = SETTING_DEFINITIONS.find((item) => item.key === 'agent.responseLanguage');
  const registered = agentSettingDefinitions().find((item) => item.key === definition.key);
  assert.ok(registered);
  const { catalog, ...registeredDefinition } = registered;
  assert.equal(catalog.domain, 'agent');
  assert.deepEqual(registeredDefinition, definition);
  assert.equal(DEFAULT_USER_SETTINGS[definition.key], 'auto');
  assert.equal(shellPreferenceSettingsIndex('gui').some((item) => item.key === definition.key), false);
  assert.deepEqual(definition.options.map((option) => option.value), ['auto', 'zh-CN', 'en-US']);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: SettingsField } = await loadGuiModule(t, '/src/components/settings-center/SettingsField.tsx');
  const html = renderToStaticMarkup(createElement(SettingsField, {
    definition, value: 'zh-CN', source: 'user', language: 'en-US', compact: true, onChange() {},
  }));
  assert.match(html, /<select[^>]+aria-label="Response language"/);
  assert.match(html, /<option value="zh-CN" selected="">简体中文<\/option>/);
  assert.equal(html.includes('agent.responseLanguage'), false, 'the user control does not expose the internal setting key');
  assert.equal(html.includes('settings-field__default'), false);
});

test('GUI refresh accepts plan preview changes without a new journal revision or activity timestamp', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-plan-preview';
  await createSession(journal, sessionId);
  const provider = { async *stream(_request, signal) {
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'gui-plan-preview');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:gui-preview', 'Plan the work.'));
  const base = structuredClone(await waitForProjection(actor, (value) => Boolean(value.assistantDraft)));
  base.assistantDraft.activity.phase = 'generatingOutput';
  let incoming = structuredClone(base);
  installGuiFetch(t, async (url) => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [] });
    assert.equal(url.pathname, `/api/conversation/sessions/${encodeURIComponent(sessionId)}/projection`);
    return Response.json({ ok: true, data: incoming });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: base });
  incoming.assistantDraft.planPreview = { callIndex: 0, providerCallId: 'call:plan-preview', title: 'Inspect source', summary: '', steps: [], truncated: false };
  await store.getState().refresh();
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().projection.assistantDraft.planPreview.title, 'Inspect source');
  incoming.assistantDraft.planPreview.steps.push('Read the current implementation');
  await store.getState().refresh();
  assert.deepEqual(store.getState().projection.assistantDraft.planPreview.steps, ['Read the current implementation']);
  assert.equal(store.getState().projection.pendingPlan, null);
  assert.equal(store.getState().projection.revision, base.revision);
  delete incoming.assistantDraft.planPreview;
  await store.getState().refresh();
  assert.equal(store.getState().projection.assistantDraft.planPreview, undefined);
});

test('streaming Markdown retains stable blocks and reconciles GFM and references on completion', async (t) => {
  const { StreamingMarkdownParser } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const parser = new StreamingMarkdownParser();
  const prefix = '# Result\n\nFirst paragraph.\n\nSecond paragraph.\n\n';
  const first = parser.update(prefix + 'Last', true);
  const next = parser.update(prefix + 'Last paragraph.\n\n```cpp\nint value', true);
  assert.equal(next[0], first[0], 'already displayed heading must retain its render block');
  const text = prefix + 'Last paragraph.\n\n```cpp\nint value = 1;\n```\n\n[Guide][guide]\n\n[guide]: https://example.com\n';
  const complete = parser.update(text, false);
  assert.equal(complete[0].key, first[0].key, 'completion must retain source keys');
  assert.deepEqual(complete, new StreamingMarkdownParser().update(text, false));
  assert.match(JSON.stringify(complete), /https:\/\/example.com/);
  const replacement = parser.update('Replacement\n\n| A | B |\n| - | - |\n| 1 | 2 |', true);
  assert.doesNotMatch(JSON.stringify(replacement), /First paragraph/);
  assert.match(JSON.stringify(replacement), /"tagName":"table"/);
});

test('Markdown table reading preserves streaming cells, source links and GFM alignment', async (t) => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const { StreamingMarkdownParser } = await loadGuiModule(t, '/src/components/local-agent/streamingMarkdown.ts');
  const { MarkdownContent } = await loadGuiModule(t, '/src/components/local-agent/BufferedMarkdown.tsx');
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const prefix = '# 参考实现\n\n第一段说明。\n\n第二段说明。\n\n';
  const header = '| 项目 | 许可 | 机制 | 对齐 |\n| :--- | --- | --- | ---: |\n';
  const row = '| [ObjectPool](https://example.com/pool) | BSD | `create/validate/destroy`，**原始语义** | 12 |\n';
  const end = '| Recycler | Apache-2.0 | `Recycler<T,Size,Align>` | 23 |\n\n公式 $i$ 与 [完整来源](https://example.com/reference)。';
  const parser = new StreamingMarkdownParser();
  const start = parser.update(prefix + header, true);
  const partial = parser.update(prefix + header + row.slice(0, row.indexOf('destroy') + 3), true);
  const streamed = parser.update(prefix + header + row + end, true);
  assert.equal(partial[0], start[0], 'table growth must retain the frozen heading');
  assert.equal(streamed[0], start[0], 'later prose must retain the frozen heading');
  const tableKey = (blocks) => blocks.find((block) => block.tree.children.some((node) => node.type === 'element' && node.tagName === 'table')).key;
  assert.equal(tableKey(start), tableKey(partial));
  assert.equal(tableKey(start), tableKey(streamed));
  const text = prefix + header + row + end;
  const final = parser.update(text, false);
  assert.equal(tableKey(final), tableKey(start));
  assert.deepEqual(final, new StreamingMarkdownParser().update(text, false));
  const settled = renderToStaticMarkup(createElement(MarkdownContent, { children: text }));
  const received = renderToStaticMarkup(createElement(MarkdownContent, { children: text, streaming: true }));
  const tableHtml = (html) => html.match(/<table>[\s\S]*?<\/table>/)[0];
  assert.equal(tableHtml(received), tableHtml(settled), 'a complete streamed table and its settled view contain identical cells');
  assert.equal((settled.match(/<table>/g) ?? []).length, 1, 'a closed expanded view must not duplicate the table');
  assert.equal((settled.match(/<tr>/g) ?? []).length, 3);
  assert.equal((settled.match(/<td[ >]/g) ?? []).length, 8);
  assert.match(settled, /style="text-align:right"/);
  assert.match(settled, /href="https:\/\/example.com\/pool"/);
  assert.match(settled, /<code>create\/<wbr\/>validate\/<wbr\/>destroy<\/code>/);
  assert.match(settled.replaceAll('<wbr/>', ''), /<code>create\/validate\/destroy<\/code>/);
  assert.match(settled, /<code>Recycler&lt;T,Size,Align&gt;<\/code>/);
  assert.match(settled, /<strong>原始语义<\/strong>/);
  assert.match(settled, /class="katex"/);
  assert.match(settled, /class="conversation-table-scroll"[^>]*tabindex="0"/);
});

test('draft and committed provider text occupy the same round and row identity', async (t) => {
  const { conversationRounds } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const user = { type: 'message', sequence: 1, value: { messageId: 'user:1', role: 'user', content: 'Continue' } };
  const draft = { type: 'text', block: { streamId: 'stream:answer', kind: 'message', content: 'Answer', outputIndex: 0 } };
  const before = conversationRounds([user], [draft], 'run:1');
  const answer = { type: 'message', sequence: 5, streamId: 'stream:answer', value: { messageId: 'answer:1', role: 'assistant', runId: 'run:1', content: 'Answer' } };
  const after = conversationRounds([user, answer], [draft], 'run:1');
  assert.equal(after.at(-1).key, before.at(-1).key);
  assert.equal(after.at(-1).rows[0].key, before.at(-1).rows[0].key);
  assert.equal(after.at(-1).rows.length, 1, 'commit and residual draft must not duplicate text');
});

test('streamed text advances between snapshots and catches up without a character-rate backlog', async (t) => {
  const { StreamingTextBuffer } = await loadGuiModule(t, '/src/components/local-agent/streamingText.ts');
  const buffer = new StreamingTextBuffer();
  let source = 'A received paragraph. '.repeat(80);
  buffer.update(source, 0);
  let previous = '';
  for (const time of [16, 32, 48, 64, 80, 96]) {
    if (time === 64) { source += 'More received text. '.repeat(40); buffer.update(source, time); }
    const shown = buffer.advance(time);
    assert.ok(shown.startsWith(previous) && shown.length > previous.length);
    assert.ok(source.startsWith(shown) && shown.length < source.length);
    previous = shown;
  }
  assert.equal(buffer.advance(120), source, 'new arrivals must not extend the pending display deadline');
  assert.equal(buffer.complete, true);
  buffer.update(source + ' Next chunk.', 200);
  assert.equal(buffer.advance(320), source + ' Next chunk.');
  buffer.update('Authoritative replacement.', 330);
  assert.equal(buffer.text, 'Authoritative replacement.');
  assert.equal(buffer.advance(400), 'Authoritative replacement.', 'replacement must discard the previous tail');
});

test('streamed text keeps Unicode pairs intact and settled history displays immediately', async (t) => {
  const { StreamingTextBuffer } = await loadGuiModule(t, '/src/components/local-agent/streamingText.ts');
  const text = '中文🙂🚀，代码与公式。';
  const buffer = new StreamingTextBuffer();
  buffer.update(text, 0);
  for (let time = 1; time <= 120; time += 1) {
    const shown = buffer.advance(time);
    assert.equal(shown, [...shown].filter((character) => !/^[\uD800-\uDFFF]$/u.test(character)).join(''));
    assert.ok(text.startsWith(shown));
  }
  assert.equal(buffer.text, text);
  const history = new StreamingTextBuffer(text);
  assert.equal(history.text, text);
  assert.equal(history.complete, true);
});

test('projection polling stays serial through visibility changes and stops after unmount', async (t) => {
  const { startProjectionPolling } = await loadGuiModule(t, '/src/components/local-agent/useProjectionPolling.ts');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const timers = new Map();
  const listeners = new Set();
  let nextId = 0;
  globalThis.window = { setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id) { timers.delete(id); } };
  globalThis.document = { visibilityState: 'visible', addEventListener(_event, callback) { listeners.add(callback); }, removeEventListener(_event, callback) { listeners.delete(callback); } };
  let stop = () => {};
  let stopIdle = () => {};
  t.after(() => { stop(); stopIdle(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const fire = () => { assert.equal(timers.size, 1); const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); };
  const visibility = (state) => { document.visibilityState = state; for (const listener of listeners) listener(); };
  let calls = 0;
  let release;
  stop = startProjectionPolling(true, () => { calls += 1; return new Promise((resolve) => { release = resolve; }); });
  assert.equal(timers.values().next().value.delay, 120);
  fire();
  visibility('hidden'); visibility('visible');
  assert.equal(calls, 1);
  assert.equal(timers.size, 0, 'a slow refresh must not accumulate polling timers');
  release(); await Promise.resolve();
  assert.equal(timers.size, 1);
  visibility('hidden');
  assert.equal(timers.values().next().value.delay, 10_000);
  visibility('visible');
  assert.equal(calls, 2);
  stop(); release(); await Promise.resolve();
  assert.equal(timers.size, 0);
  assert.equal(listeners.size, 0);
  stopIdle = startProjectionPolling(false, async () => {});
  assert.equal(timers.values().next().value.delay, 4_000);
  stopIdle();
});

test('unchanged status snapshots do not publish redundant GUI state updates', async (t) => {
  installGuiFetch(t, async (url) => {
    assert.equal(url.pathname, '/api/conversation/statuses');
    return Response.json({ ok: true, data: [] });
  });
  const store = await loadGuiModelStore(t);
  let publications = 0;
  const unsubscribe = store.subscribe(() => { publications += 1; });
  t.after(unsubscribe);
  await store.getState().refresh();
  await store.getState().refresh();
  assert.equal(publications, 0);
  store.setState({ error: 'Status request failed', errorSource: 'statuses' });
  await store.getState().refresh();
  assert.equal(store.getState().error, null, 'a successful refresh must still clear its previous error');
  assert.equal(publications, 2);
});

test('round change totals use first before and final after, without summing repeated edits', async (t) => {
  const { changedFiles, readRoundChange } = await loadGuiModule(t, '/src/components/local-agent/fileChangeSummary.ts');
  const { calculateChangedLines: countChangedLines } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const change = { workspaceId: 'workspace:1', path: 'src/pool.cpp', kind: 'modify', before: { exists: true }, after: { exists: true } };
  const activity = (recordId) => ({ tool: { recordId, fileChanges: [change] } });
  const files = changedFiles([activity('edit:1'), activity('edit:2'), activity('edit:2')]);
  assert.equal(files.length, 1);
  assert.equal(files[0].changes.length, 2);
  const read = async (_session, recordId) => ({ workspaceId: change.workspaceId, path: change.path,
    before: recordId === 'edit:1' ? 'original\n' : 'temporary\n',
    after: recordId === 'edit:1' ? 'temporary\n' : 'original\nadded\n',
  });
  const round = await readRoundChange(read, 'session:1', files[0], new AbortController().signal);
  assert.deepEqual(await countChangedLines(round.before, round.after), { added: 1, removed: 0 });
  assert.deepEqual(await countChangedLines(null, 'new\nfile\n'), { added: 2, removed: 0 });
  assert.deepEqual(await countChangedLines('removed\n', null), { added: 0, removed: 1 });
});

test('binary changes do not interrupt text totals and immutable line statistics are cached per revision', async (t) => {
  const { readFileChange } = await loadGuiModule(t, '/src/services/localAgentApi.ts');
  const { changedFiles, readChangeStatistics } = await loadGuiModule(t, '/src/components/local-agent/fileChangeSummary.ts');
  const { calculateChangedLines } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const calls = [];
  let unavailable = true;
  installGuiFetch(t, (_url, init) => {
    const { recordId } = JSON.parse(init.body);
    calls.push(recordId);
    if (recordId === 'binary') return Response.json({ ok: false, error: 'file_change_binary_content', message: 'bin/demo 是二进制文件。' });
    if (recordId === 'missing' && unavailable) return Response.json({ ok: false, error: 'file_change_content_unavailable', message: 'snapshot missing' });
    return Response.json({ ok: true, data: { workspaceId: 'workspace:1', path: `${recordId}.txt`, before: null, after: 'one\ntwo\n' } });
  });
  const files = changedFiles(['first', 'binary', 'last', 'missing'].map((recordId) => ({ tool: { recordId, fileChanges: [{ workspaceId: 'workspace:1', path: `${recordId}.txt`, kind: 'create', before: { exists: false }, after: { exists: true } }] } })));
  const count = async (before, after) => calculateChangedLines(before, after);
  const signal = new AbortController().signal;
  const values = [];
  for (const file of files.slice(0, 3)) values.push(await readChangeStatistics(readFileChange, 'session:counts', file, signal, count));
  assert.deepEqual(values, [{ kind: 'text', counts: { added: 2, removed: 0 } }, { kind: 'binary' }, { kind: 'text', counts: { added: 2, removed: 0 } }]);
  for (const file of files.slice(0, 3)) await readChangeStatistics(readFileChange, 'session:counts', file, signal, count);
  assert.deepEqual(calls, ['first', 'binary', 'last'], 'switching cards reuses classifications without reading or diffing again');
  await assert.rejects(readChangeStatistics(readFileChange, 'session:counts', files[3], signal, count), /snapshot missing/);
  unavailable = false;
  assert.equal((await readChangeStatistics(readFileChange, 'session:counts', files[3], signal, count)).kind, 'text', 'failed reads are not cached as success');
  await readChangeStatistics(readFileChange, 'session:other', files[0], signal, count);
  assert.equal(calls.at(-1), 'first', 'separate sessions do not share results');
});

test('line statistics compute full-file creation, deletion and replacement without per-edit timers', async (t) => {
  const { calculateChangedLines } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const source = Array.from({ length: 1200 }, (_, index) => `line ${index}\n`).join('');
  const replacement = Array.from({ length: 400 }, (_, index) => `replacement ${index}\n`).join('');
  assert.deepEqual(calculateChangedLines(null, source), { added: 1200, removed: 0 });
  assert.deepEqual(calculateChangedLines(source, null), { added: 0, removed: 1200 });
  assert.deepEqual(calculateChangedLines(source, source), { added: 0, removed: 0 });
  assert.deepEqual(calculateChangedLines(source, replacement), { added: 400, removed: 1200 });
  assert.deepEqual(calculateChangedLines(null, ''), { added: 0, removed: 0 });
  assert.deepEqual(calculateChangedLines(null, 'first\r\nsecond'), { added: 2, removed: 0 });
  assert.deepEqual(calculateChangedLines('first\r\nsecond\r\n', null), { added: 0, removed: 2 });
  assert.deepEqual(calculateChangedLines('unchanged', 'unchanged\n'), { added: 1, removed: 1 });
});


test('disabled model bindings survive catalog refresh and cannot submit a new run', async (t) => {
  const profiles = [
    { id: 'profile:bound', name: 'Bound model', enabled: false, thinking: 'enabled' },
    { id: 'profile:available', name: 'Available model', enabled: true, thinking: 'enabled' },
  ];
  installGuiFetch(t, async (url) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    return Response.json({ ok: true, data: { profiles, defaultProfileId: profiles[0].id } });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId: 'session:bound', selectedProfileId: profiles[0].id });
  await store.getState().refreshProfiles();
  assert.equal(store.getState().selectedProfileId, profiles[0].id);
  assert.equal(store.getState().defaultProfileId, profiles[0].id);
  assert.deepEqual(store.getState().profiles, profiles);
  await assert.rejects(store.getState().sendMessage('Continue.'), /llm_profile_unavailable/);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { default: Selector } = await loadGuiModule(t, '/src/components/local-agent/SessionModelSelector.tsx');
  const html = renderToStaticMarkup(createElement(Selector, {
    language: 'zh-CN', profiles, selectedProfileId: profiles[0].id,
    contextUsage: null, contextCompositions: [], reasoningEffortOverride: null,
  }));
  assert.match(html, /Bound model · 已停用/);
  store.getState().startNewSession();
  assert.equal(store.getState().selectedProfileId, profiles[0].id, 'an invalid configured default remains visible');
});

test('polling and command reconciliation read draft snapshots in order at the same revision', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:ordered-draft';
  await createSession(journal, sessionId);
  const provider = { async *stream(_request, signal) {
    if (!signal.aborted) await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'ordered-draft');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:ordered-start', 'Plan the work.'));
  const base = structuredClone(await waitForProjection(actor, (value) => Boolean(value.assistantDraft)));
  base.assistantDraft.planPreview = { callIndex: 0, providerCallId: 'call:ordered-plan', title: 'Plan', summary: '', steps: ['Read source'], truncated: false };
  const latest = structuredClone(base);
  latest.assistantDraft.planPreview.steps.push('Verify behavior');
  let releaseOld;
  const held = new Promise((resolve) => { releaseOld = resolve; });
  let reads = 0;
  let commands = 0;
  installGuiFetch(t, async (url) => {
    if (url.pathname === '/api/conversation/statuses') return Response.json({ ok: true, data: [] });
    if (url.pathname.endsWith('/commands')) {
      commands += 1;
      return Response.json({ ok: true, data: { schemaVersion: 'deepcode.command-reply.v3', sessionId, commandId: 'command:setting', status: 'accepted', revision: base.revision } });
    }
    assert.ok(url.pathname.endsWith('/projection'));
    reads += 1;
    if (reads === 1) { await held; return Response.json({ ok: true, data: base }); }
    return Response.json({ ok: true, data: latest });
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: base, selectedProfileId: 'profile:test', profiles: [
    { id: 'profile:test', enabled: true, thinking: 'enabled' },
  ] });
  const polling = store.getState().refresh();
  await waitUntil(() => reads === 1);
  const saving = store.getState().selectReasoningEffort('low');
  await waitUntil(() => commands === 1);
  assert.equal(reads, 1, 'the post-command read waits for the earlier in-flight read');
  releaseOld();
  await Promise.all([polling, saving]);
  assert.equal(store.getState().error, null);
  assert.equal(reads, 2);
  assert.deepEqual(store.getState().projection.assistantDraft.planPreview.steps, ['Read source', 'Verify behavior']);
  assert.equal(store.getState().projection.revision, base.revision);
});

test('desktop startup diagnostics render the Host failure and log reference verbatim', async (t) => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { HostStartupDiagnostic } = await loadGuiModule(t, '/src/components/shared/HostStartupDiagnostic.tsx');
  const status = { phase: 'failed', code: 'host_startup_process_exited',
    message: 'Kernel exited: exit status: 71', diagnosticRef: '/runtime/logs/startup.log' };
  const html = renderToStaticMarkup(createElement(HostStartupDiagnostic, { status, language: 'zh-CN' }));
  assert.match(html, /Kernel exited: exit status: 71/);
  assert.match(html, /\/runtime\/logs\/startup.log/);
  assert.equal(renderToStaticMarkup(createElement(HostStartupDiagnostic, { status: { ...status, phase: 'ready' }, language: 'zh-CN' })), '');
});
