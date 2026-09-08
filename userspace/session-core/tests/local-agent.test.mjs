import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  decodeToolPromptProviderSnapshots,
  InMemoryCommandJournal,
  prepareToolPromptContributions,
  renderActiveToolGuidance,
  SessionActor,
  SessionService,
  loopSnapshot,
  runtimeInstructions,
  sessionControlToolDefinitions,
} from '../dist/index.js';
import { messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import { responseFrames } from '../dist/responseFrames.js';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import {
  decodeGuiProjection,
  inputCacheMetric,
  lastCallInputCacheMetric,
  loadGuiModelStore,
} from './gui-projection-contract.mjs';

const workspaceBinding = {
  workspaceId: 'workspace:test',
  displayName: 'Fixture workspace',
};

test('transport: oversized Unicode replies preserve content within bounded frames', () => {
  const value = { protocolVersion: 'deepcode.local-agent.v1', requestId: 'large', ok: true,
    data: { text: '中文🙂\n\"\\'.repeat(180_000) } };
  const frames = [...responseFrames(value)];
  assert.ok(frames.length > 1);
  const chunks = frames.map((frame, index) => {
    assert.ok(Buffer.byteLength(frame) <= 1024 * 1024);
    const chunk = JSON.parse(frame);
    assert.equal(chunk.index, index);
    assert.equal(chunk.final, index === frames.length - 1);
    return chunk.text;
  });
  assert.deepEqual(JSON.parse(chunks.join('')), value);
  assert.deepEqual([...responseFrames({ ok: true })], ['{"ok":true}']);
});

test('A: message uses one prepared runtime through composition, completion, cache projection, settlement, and release', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:answer-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparation = fakeRunPreparation({
    contextWindowTokens: 1_000,
    maxOutputTokens: 128,
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      assert.equal(request.purpose, 'agent');
      assert.equal(request.responseConstraint, 'normal');
      assert.equal(request.providerRuntimeRef, 'provider-runtime:g1');
      assert.equal(request.profileId, 'profile:selected');
      assert.equal(request.maxOutputTokens, 128);
      assert.ok(request.messages.some((message) => (
        message.role === 'system' && message.content === 'Stable core instruction.'
      )));

      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:answer',
        content: 'Fixture answer.',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          contextWindowTokens: 1_000,
          cacheReadInputTokens: 75,
          cacheMissInputTokens: 25,
        },
      });
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'answer-chain',
  );

  const reply = await actor.submit(messageCommand(
    sessionId,
    'command:answer',
    'Arbitrary fixture input.',
    'profile:selected',
  ));
  assert.equal(reply.status, 'accepted');
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  await waitUntil(() => preparation.released.length === 1, 'runtime release');

  assert.equal(providerRequests.length, 1);
  assert.deepEqual(preparation.prepared.map((request) => ({
    sessionId: request.sessionId,
    runId: request.runId,
    profileId: request.profileId,
  })), [{
    sessionId,
    runId: projection.run.runId,
    profileId: 'profile:selected',
  }]);
  assert.deepEqual(projection.tokenUsage, {
    providerCallCount: 1,
    reportedCallCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 75,
    cacheMissInputTokens: 25,
    cacheAvailable: true,
    cacheComplete: true,
    cacheHitRatio: 0.75,
  });

  const events = await readEvents(journal, sessionId);
  const runStarted = singleEvent(events, 'run.started');
  const composition = singleEvent(events, 'context.composed');
  const completion = singleEvent(events, 'provider.turn.settled');
  const usage = singleEvent(events, 'context.updated');
  const assistant = events.find((event) => (
    event.type === 'message.committed' && event.payload.role === 'assistant'
  ));
  const settlement = singleEvent(events, 'run.settled');

  assert.ok(assistant, 'assistant message must be durable');
  assert.deepEqual(runStarted.payload.runtimeSnapshot, preparation.snapshots[0]);
  assert.equal(composition.payload.providerRequestId, completion.payload.providerRequestId);
  assert.equal(completion.payload.providerRuntimeRef, runStarted.payload.runtimeSnapshot.provider.providerRuntimeRef);
  assert.deepEqual(completion.payload.orderedCallIds, []);
  assert.equal(usage.payload.providerRequestId, completion.payload.providerRequestId);
  assert.equal(assistant.runId, runStarted.runId);
  assert.equal(assistant.payload.providerRequestId, completion.payload.providerRequestId);
  assert.equal(settlement.payload.finalMessageId, assistant.payload.messageId);
  assertEventOrder(composition, completion, usage, assistant, settlement);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: runStarted.runId,
    kernelCatalogSnapshotRef: runStarted.payload.runtimeSnapshot.kernelCatalogSnapshotRef,
  }]);

  await actor.dispose();
});

test('A-cache: last-call, per-run, and Session cache rates use their own input token totals', async (t) => {
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

test('A-cache-latest: compaction owns last-call usage and an unreported next call clears it without losing Session totals', async (t) => {
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

test('A0: reasoning-only streaming projects activity without raw reasoning or per-chunk journal events', async () => {
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
  assert.equal(running.assistantDraft.content, '');
  assert.equal(running.assistantDraft.reasoningContent, undefined);
  assert.equal(running.assistantDraft.orderedBlocks, undefined);
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

test('B-hosted: run binding exposes hosted search once and replays its Provider item unchanged', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:hosted-web-search';
  await createSession(journal, sessionId, [workspaceBinding]);
  const hostedItems = [{
    type: 'web_search_call',
    id: 'ws_1',
    status: 'completed',
    action: { type: 'search', queries: ['current compiler release'] },
  }, {
    type: 'web_search_call',
    id: 'ws_2',
    status: 'failed',
    action: { type: 'open_page', url: 'https://example.com/unavailable' },
  }];
  const preparation = fakeRunPreparation({
    apiSurface: 'responses',
    hostedWebSearch: 'web_search',
    webSearch: { owner: 'providerHosted', providerToolType: 'web_search' },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      assert.deepEqual(request.hostedTools, [{
        type: 'webSearch',
        providerToolType: 'web_search',
      }]);
      assert.equal(request.tools.some((tool) => tool.name === 'web.search'), false);
      if (providerRequests.length === 1) {
        for (const item of hostedItems) {
          yield providerEvent(request.requestId, 'hosted.web-search.completed', {
            item: structuredClone(item),
          });
        }
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:hosted-first',
          content: 'First current answer.',
        });
      } else {
        const replay = request.messages.find((message) => (
          message.role === 'assistant'
          && message.content === 'First current answer.'
        ));
        assert.ok(replay, 'prior hosted-search answer must be in the next context');
        assert.deepEqual(replay.providerItems, hostedItems);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:hosted-second',
          content: 'Second answer after exact replay.',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'hosted-web-search',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:hosted-first',
    'Find the current compiler release.',
  ));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await actor.submit(messageCommand(
    sessionId,
    'command:hosted-second',
    'Use the prior result in this follow-up.',
  ));
  await waitUntil(() => providerRequests.length === 2, 'second hosted Provider request');
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed'
    && value.messages.some((message) => message.content === 'Second answer after exact replay.')
  ));

  const events = await readEvents(journal, sessionId);
  const settlements = events.filter((event) => event.type === 'provider.turn.settled');
  assert.deepEqual(settlements[0].payload.hostedWebSearchCalls, hostedItems);
  const firstAssistant = events.find((event) => (
    event.type === 'message.committed'
    && event.payload.content === 'First current answer.'
  ));
  assert.equal(firstAssistant.payload.providerRequestId, settlements[0].payload.providerRequestId);
  const compositions = events.filter((event) => event.type === 'context.composed');
  assert.ok(compositions[0].payload.tools.some((tool) => (
    tool.origin === 'providerHosted'
    && tool.canonicalName === 'web.search'
    && tool.wireName === 'web_search'
  )));
  assert.ok(compositions[1].payload.messages.some((message) => (
    message.blocks.some((block) => (
      block.kind === 'hostedWebSearch' && block.providerCallId === hostedItems[0].id
    ))
  )));

  await actor.dispose();
});

test('B-ordered: Responses output items preserve narrative, hosted activity, and final-message order', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:ordered-provider-output';
  await createSession(journal, sessionId, [workspaceBinding]);
  const nativeItems = [{
    type: 'message',
    id: 'provider-message:search-intro',
    role: 'assistant',
    phase: 'commentary',
    status: 'completed',
    content: [{ type: 'output_text', text: 'I will search first.' }],
  }, {
    type: 'web_search_call',
    id: 'provider-search:first',
    status: 'completed',
    action: { type: 'search', queries: ['current compiler release'] },
  }, {
    type: 'message',
    id: 'provider-message:search-follow-up',
    role: 'assistant',
    phase: 'commentary',
    status: 'completed',
    content: [{ type: 'output_text', text: 'I found a release page and will inspect it.' }],
  }, {
    type: 'web_search_call',
    id: 'provider-search:second',
    status: 'failed',
    action: { type: 'open_page', url: 'https://example.com/compiler-release' },
  }, {
    type: 'message',
    id: 'provider-message:search-final',
    role: 'assistant',
    phase: 'final_answer',
    status: 'completed',
    content: [{ type: 'output_text', text: 'The current release is recorded in the cited result.' }],
  }];
  const preparation = fakeRunPreparation({
    apiSurface: 'responses',
    hostedWebSearch: 'web_search',
    webSearch: { owner: 'providerHosted', providerToolType: 'web_search' },
  });
  const providerRequests = [];
  let completeFinalItem;
  const finalItemHeld = new Promise((resolve) => { completeFinalItem = resolve; });
  let completeFirstTurn;
  const firstTurnHeld = new Promise((resolve) => { completeFirstTurn = resolve; });
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        for (const [outputIndex, item] of nativeItems.entries()) {
          if (item.type === 'message') {
            yield providerEvent(request.requestId, 'text.delta', {
              text: item.content[0].text,
              outputIndex,
            });
            if (outputIndex === nativeItems.length - 1) await finalItemHeld;
          }
          yield providerEvent(request.requestId, 'output.item.completed', {
            outputIndex,
            item: structuredClone(item),
          });
        }
        await firstTurnHeld;
      } else {
        const replay = request.messages.find((message) => message.providerOutputBlocks);
        assert.ok(replay, 'the next turn must replay the ordered Provider output');
        assert.equal(replay.content, '');
        assert.deepEqual(
          replay.providerOutputBlocks.map((block) => block.kind),
          ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
        );
        assert.deepEqual(
          replay.providerOutputBlocks.map((block) => block.item),
          nativeItems,
        );
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:ordered-follow-up',
          content: 'The ordered output was replayed.',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'ordered-provider-output',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:ordered-first',
    'Search for the current compiler release.',
  ));
  const finalStreamingProjection = await waitForProjection(actor, (value) => (
    value.assistantDraft?.orderedBlocks?.at(-1)?.outputIndex === nativeItems.length - 1
    && value.assistantDraft.orderedBlocks.at(-1)?.kind === 'message'
  ));
  assert.equal(
    finalStreamingProjection.assistantDraft.orderedBlocks.at(-1).content,
    nativeItems.at(-1).content[0].text,
  );
  completeFinalItem();
  const streamingProjection = await waitForProjection(actor, (value) => (
    value.assistantDraft?.orderedBlocks?.length === nativeItems.length
    && value.assistantDraft.orderedBlocks.at(-1)?.kind === 'finalMessage'
  ));
  assert.equal(streamingProjection.assistantDraft.content, '');
  assert.equal(streamingProjection.assistantDraft.reasoningContent, undefined);
  assert.deepEqual(
    streamingProjection.assistantDraft.orderedBlocks.map((block) => block.kind),
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    streamingProjection.assistantDraft.orderedBlocks.map((block) => block.outputIndex),
    [0, 1, 2, 3, 4],
  );
  completeFirstTurn();
  const firstProjection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  const firstEvents = await readEvents(journal, sessionId);
  const firstSettlement = singleEvent(firstEvents, 'provider.turn.settled');
  assert.deepEqual(
    firstSettlement.payload.orderedOutputBlocks.map((block) => block.kind),
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    firstSettlement.payload.orderedOutputBlocks.map((block) => block.item),
    nativeItems,
  );
  assert.equal(firstEvents.some((event) => (
    event.type === 'tool.requested' || event.type === 'tool.completed'
  )), false, 'Provider-hosted activity must not create Kernel tool facts');

  const orderedBlocks = firstSettlement.payload.orderedOutputBlocks;
  const narrativeIds = new Set(orderedBlocks.flatMap((block) => (
    block.kind === 'narrative' ? [block.narrativeId] : []
  )));
  const activityIds = new Set(orderedBlocks.flatMap((block) => (
    block.kind === 'providerHosted' ? [block.activityId] : []
  )));
  const finalMessageId = orderedBlocks.find((block) => block.kind === 'finalMessage').messageId;
  const orderedTimelineKinds = firstProjection.timeline.flatMap((item) => {
    if (item.kind === 'narrative' && narrativeIds.has(item.narrativeId)) return ['narrative'];
    if (
      item.kind === 'toolGroup'
      && item.activityIds.some((activityId) => activityIds.has(activityId))
    ) return ['providerHosted'];
    if (item.kind === 'message' && item.messageId === finalMessageId) return ['finalMessage'];
    return [];
  });
  assert.deepEqual(
    orderedTimelineKinds,
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    firstProjection.timeline.flatMap((item) => (
      item.kind === 'narrative' && narrativeIds.has(item.narrativeId)
        || item.kind === 'message' && item.messageId === finalMessageId
        ? [item.outputIndex]
        : []
    )),
    [0, 2, 4],
  );
  assert.deepEqual(
    [...activityIds].map((activityId) => firstProjection.activities.find((activity) => (
      activity.activityId === activityId
    ))?.kind),
    ['providerHosted', 'providerHosted'],
  );
  assert.equal(
    firstProjection.messages.find((message) => message.messageId === finalMessageId)?.content,
    'The current release is recorded in the cited result.',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:ordered-follow-up',
    'Continue from that result.',
  ));
  await waitUntil(() => providerRequests.length === 2, 'ordered Provider replay request');
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed'
    && value.messages.some((message) => message.content === 'The ordered output was replayed.')
  ));

  await actor.dispose();
});

test('B-ordered-tool: native function_call identity survives settlement, execution, and replay', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:ordered-provider-tool';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparedTool = {
    toolBindingRef: 'tool-binding:ordered-read:g1',
    name: 'fs.read',
    description: 'Read one fixture path.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({
    apiSurface: 'responses',
    tools: [preparedTool],
  });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      return completedExecutionReply(request, { content: 'ordered fixture contents' });
    },
  });
  const providerRequests = [];
  let nativeItems;
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const definition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.path !== undefined
        ));
        assert.ok(definition, 'prepared Kernel tool must be exposed to Responses');
        nativeItems = [{
          type: 'message',
          id: 'provider-message:ordered-read-intro',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'I will read the fixture.' }],
        }, {
          type: 'function_call',
          id: 'provider-item:ordered-read',
          call_id: 'provider-call:ordered-read',
          name: definition.name,
          arguments: JSON.stringify({ workspace: 'primary', path: 'README.md' }),
          status: 'completed',
        }];
        yield providerEvent(request.requestId, 'text.delta', {
          text: 'I will read the fixture.',
          outputIndex: 0,
        });
        for (const [outputIndex, item] of nativeItems.entries()) {
          yield providerEvent(request.requestId, 'output.item.completed', {
            outputIndex,
            item: structuredClone(item),
          });
        }
      } else {
        const replay = request.messages.find((message) => message.providerOutputBlocks);
        assert.ok(replay, 'continuation must replay the native ordered output items');
        assert.deepEqual(replay.providerOutputBlocks.map((block) => block.item), nativeItems);
        const replayedCall = replay.providerOutputBlocks.find((block) => block.kind === 'toolCall');
        assert.ok(replayedCall);
        assert.equal(replayedCall.providerCallId, 'provider-call:ordered-read');
        assert.ok(request.messages.some((message) => (
          message.role === 'tool'
          && message.toolCallId === replayedCall.callId
          && message.providerCallId === replayedCall.providerCallId
        )), 'tool result must retain the exact native provider call identity');
        const finalItem = {
          type: 'message',
          id: 'provider-message:ordered-read-final',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'The ordered read completed.' }],
        };
        yield providerEvent(request.requestId, 'text.delta', {
          text: 'The ordered read completed.',
          outputIndex: 0,
        });
        yield providerEvent(request.requestId, 'output.item.completed', {
          outputIndex: 0,
          item: finalItem,
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'ordered-provider-tool',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:ordered-tool',
    'Read the fixture with the available tool.',
  ));
  const projection = await waitForProjection(actor, (value) => (
    value.run?.status === 'completed'
    && value.messages.some((message) => message.content === 'The ordered read completed.')
  ));
  const events = await readEvents(journal, sessionId);
  const settlements = events.filter((event) => event.type === 'provider.turn.settled');
  const toolRequested = singleEvent(events, 'tool.requested');
  assert.deepEqual(
    settlements[0].payload.orderedOutputBlocks.map((block) => block.kind),
    ['narrative', 'toolCall'],
  );
  const toolBlock = settlements[0].payload.orderedOutputBlocks[1];
  assert.equal(toolBlock.callId, toolRequested.callId);
  assert.equal(toolBlock.providerCallId, toolRequested.payload.providerCallId);
  assert.equal(toolBlock.toolName, toolRequested.payload.toolName);
  assert.equal(toolRequested.payload.providerCallId, 'provider-call:ordered-read');
  assert.equal(kernelRequests.length, 1);
  assert.ok(projection.activities.some((activity) => (
    activity.kind === 'tool' && activity.callId === toolRequested.callId
  )));

  await actor.dispose();
});

test('A1: filesystem references reach Provider as logical metadata without embedded file content', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:filesystem-reference';
  const importedWorkspace = {
    workspaceId: 'workspace:attachment',
    displayName: 'report.pdf',
  };
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:filesystem-reference',
        content: 'Reference received.',
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
    'filesystem-reference',
  );

  const command = messageCommand(
    sessionId,
    'command:filesystem-reference',
    'Inspect the attached PDF.',
  );
  command.filesystemReferences = [{
    referenceId: 'reference:pdf',
    workspaceId: importedWorkspace.workspaceId,
    logicalPath: 'report.pdf',
    displayName: importedWorkspace.displayName,
    kind: 'file',
    mediaType: 'application/pdf',
    byteLength: 123,
  }];
  const reply = await actor.submit(command);
  assert.equal(reply.status, 'accepted');
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(providerRequests.length, 1);
  const userMessage = providerRequests[0].messages.find((message) => message.role === 'user');
  assert.ok(userMessage);
  assert.match(userMessage.content, /"workspace":"workspace2"/u);
  assert.match(userMessage.content, /"path":"report\.pdf"/u);
  assert.match(userMessage.content, /"mediaType":"application\/pdf"/u);
  assert.doesNotMatch(userMessage.content, /workspace:attachment/u);
  assert.doesNotMatch(userMessage.content, /SECRET_CONTENT/u);
  assert.doesNotMatch(userMessage.content, /filesystem or Bash tools/u);
  assert.deepEqual(completed.messages[0].filesystemReferences, command.filesystemReferences);
  const events = await readEvents(journal, sessionId);
  assert.deepEqual(
    singleEvent(events, 'run.started').payload.workspaceBindings,
    [workspaceBinding, importedWorkspace],
  );
  const committed = events.find((event) => (
    event.type === 'message.committed' && event.payload.role === 'user'
  ));
  assert.deepEqual(committed.payload.filesystemReferences, command.filesystemReferences);
  const composition = singleEvent(events, 'context.composed');
  assert.deepEqual(
    composition.payload.messages
      .find((message) => message.filesystemReferences.length > 0)
      .filesystemReferences,
    [{ itemId: 'reference:pdf', label: 'report.pdf' }],
  );
  await actor.dispose();
});

test('A2: the current RunRuntimeSnapshot contract rejects missing Provider aliases explicitly', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:alias-contract';
  const runId = 'run:alias-contract';
  await createSession(journal, sessionId, [workspaceBinding]);
  const runtime = runtimeSnapshot(runId);
  delete runtime.providerToolAliases;
  await journal.append({
    type: 'message.committed',
    sessionId,
    payload: {
      messageId: 'message:alias-contract',
      role: 'user',
      content: 'Verify the current runtime snapshot contract.',
    },
  });
  await journal.append({
    type: 'run.started',
    sessionId,
    runId,
    payload: {
      inputMessageId: 'message:alias-contract',
      workspaceBindings: [workspaceBinding],
      runtimeSnapshot: runtime,
    },
  });

  const events = await readEvents(journal, sessionId);
  assert.throws(
    () => loopSnapshot(sessionId, events),
    /run_runtime_provider_tool_aliases_missing/u,
  );
});

test('A3: the current RunRuntimeSnapshot contract rejects missing tool prompt contributions explicitly', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:tool-prompt-contract';
  const runId = 'run:tool-prompt-contract';
  await createSession(journal, sessionId, [workspaceBinding]);
  const runtime = runtimeSnapshot(runId);
  delete runtime.toolPromptContributions;
  await journal.append({
    type: 'message.committed',
    sessionId,
    payload: {
      messageId: 'message:tool-prompt-contract',
      role: 'user',
      content: 'Verify the current runtime snapshot contract.',
    },
  });
  await journal.append({
    type: 'run.started',
    sessionId,
    runId,
    payload: {
      inputMessageId: 'message:tool-prompt-contract',
      workspaceBindings: [workspaceBinding],
      runtimeSnapshot: runtime,
    },
  });

  const events = await readEvents(journal, sessionId);
  assert.throws(
    () => loopSnapshot(sessionId, events),
    /run_runtime_tool_prompt_contributions_missing/u,
  );
});

test('A4: tool prompt preparation binds exact callable tools and rejects invalid ownership', () => {
  const readTool = {
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read UTF-8 text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const bashTool = {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Run a command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
    possibleEffects: ['process'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const selectedPlugins = {
    catalogRevision: 'plugin-catalog:fixture',
    plugins: [],
  };
  const providers = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:core',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:bash',
      canonicalToolName: 'bash',
      promptSnippet: 'Run commands.',
      usageGuidelines: ['Use this for command execution.'],
    }, {
      contributionRef: 'tool-prompt-contribution:read',
      canonicalToolName: 'fs.read',
      promptSnippet: 'Read known text files.',
      usageGuidelines: ['Use this instead of shell text readers.'],
    }],
  }]);
  assert.throws(() => decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:invalid',
    origin: 'coreBuiltin',
    contributions: [],
    undeclared: true,
  }]), /tool_prompt_providers_invalid/u);
  assert.throws(() => decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:invalid-line',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:invalid-line',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['Invalid\nline.'],
    }],
  }]), /tool_prompt_contribution_invalid/u);
  assert.throws(() => decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:duplicate-ref',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:duplicate',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['First contribution.'],
    }, {
      contributionRef: 'tool-prompt-contribution:duplicate',
      canonicalToolName: 'bash',
      usageGuidelines: ['Second contribution.'],
    }],
  }]), /tool_prompt_contribution_duplicate/u);
  const prepared = prepareToolPromptContributions(
    providers,
    [bashTool, readTool],
    selectedPlugins,
  );

  assert.deepEqual(prepared.map((item) => ({
    name: item.canonicalToolName,
    binding: item.preparedToolBindingRef,
  })), [{
    name: 'fs.read',
    binding: 'tool-binding:read:g1',
  }, {
    name: 'bash',
    binding: 'tool-binding:bash:g1',
  }]);
  assert.ok(Object.isFrozen(providers));
  assert.ok(Object.isFrozen(providers[0].contributions));
  assert.ok(Object.isFrozen(providers[0].contributions[0].usageGuidelines));
  assert.ok(Object.isFrozen(prepared));
  assert.ok(Object.isFrozen(prepared[0].usageGuidelines));
  assert.deepEqual(
    prepareToolPromptContributions(providers, [bashTool, readTool], selectedPlugins),
    prepared,
  );
  const rendered = renderActiveToolGuidance(prepared, [{
    canonicalName: 'fs.read',
    wireName: 'fs_read',
  }, {
    canonicalName: 'bash',
    wireName: 'bash',
  }], [readTool, bashTool]);
  assert.ok(rendered);
  const [snippetSection, guidelineSection] = rendered.split('\n\n');
  assert.deepEqual(snippetSection.split('\n'), [
    'Active tool guidance:',
    '- fs_read: Read known text files.',
    '- bash: Run commands.',
  ]);
  assert.deepEqual(guidelineSection.split('\n'), [
    'Guidelines:',
    '- fs_read: Use this instead of shell text readers.',
    '- bash: Use this for command execution.',
  ]);

  const readOnlyProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:read',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:read-only',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['Read known text files directly.'],
    }],
  }]);
  assert.deepEqual(prepareToolPromptContributions(readOnlyProviders, [{
    ...readTool,
    availability: 'blocked',
  }], selectedPlugins), []);
  assert.throws(
    () => prepareToolPromptContributions(readOnlyProviders, [], selectedPlugins),
    /tool_prompt_target_missing:fs\.read/u,
  );

  const conflictingProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:conflict',
    origin: 'coreBuiltin',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:owner-one',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['First owner.'],
    }, {
      contributionRef: 'tool-prompt-contribution:owner-two',
      canonicalToolName: 'fs.read',
      usageGuidelines: ['Second owner.'],
    }],
  }]);
  assert.throws(
    () => prepareToolPromptContributions(conflictingProviders, [readTool], selectedPlugins),
    /tool_prompt_owner_conflict:fs\.read/u,
  );
  assert.throws(
    () => prepareToolPromptContributions(readOnlyProviders, [{
      ...readTool,
      origin: 'extension',
      pluginUri: 'plugin://fixture@mcp',
    }], selectedPlugins),
    /tool_prompt_origin_mismatch:fs\.read/u,
  );

  const extensionTool = {
    ...readTool,
    toolBindingRef: 'tool-binding:fixture-read:g1',
    name: 'fixture.read',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
  };
  const extensionProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:fixture',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
    contributions: [{
      contributionRef: 'tool-prompt-contribution:fixture-read',
      canonicalToolName: 'fixture.read',
      usageGuidelines: ['Use the selected fixture reader.'],
    }],
  }]);
  const selectedWithFixture = {
    catalogRevision: 'plugin-catalog:fixture',
    plugins: [{
      uri: 'plugin://fixture@mcp',
      pluginArtifactRef: 'plugin-artifact:fixture',
      pluginInstanceRef: 'plugin-instance:fixture:g1',
      extensionGenerationRef: 'extension-generation:g1',
      capabilityRefs: ['mcp-tool:fixture.read'],
    }],
  };
  const firstGenerationPrepared = prepareToolPromptContributions(
    extensionProviders,
    [extensionTool],
    selectedWithFixture,
  );
  assert.deepEqual(firstGenerationPrepared.map((item) => ({
    binding: item.preparedToolBindingRef,
    origin: item.origin,
    pluginUri: item.pluginUri,
  })), [{
    binding: 'tool-binding:fixture-read:g1',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
  }]);
  const nextGenerationPrepared = prepareToolPromptContributions(
    extensionProviders,
    [{ ...extensionTool, toolBindingRef: 'tool-binding:fixture-read:g2' }],
    {
      ...selectedWithFixture,
      plugins: selectedWithFixture.plugins.map((plugin) => ({
        ...plugin,
        pluginInstanceRef: 'plugin-instance:fixture:g2',
        extensionGenerationRef: 'extension-generation:g2',
      })),
    },
  );
  assert.equal(firstGenerationPrepared[0].preparedToolBindingRef, 'tool-binding:fixture-read:g1');
  assert.equal(nextGenerationPrepared[0].preparedToolBindingRef, 'tool-binding:fixture-read:g2');
  assert.throws(
    () => prepareToolPromptContributions(extensionProviders, [extensionTool], selectedPlugins),
    /tool_prompt_provider_plugin_unselected:plugin:\/\/fixture@mcp/u,
  );
  assert.throws(
    () => prepareToolPromptContributions(extensionProviders, [{
      ...extensionTool,
      pluginUri: 'plugin://different@mcp',
    }], selectedWithFixture),
    /tool_prompt_plugin_mismatch:fixture\.read/u,
  );

  const collidingTools = [extensionTool, {
    ...extensionTool,
    toolBindingRef: 'tool-binding:fixture-dash-read:g1',
    name: 'fixture-read',
  }];
  const collidingProviders = decodeToolPromptProviderSnapshots([{
    providerRef: 'tool-prompt-provider:colliding-fixture',
    origin: 'extension',
    pluginUri: 'plugin://fixture@mcp',
    contributions: collidingTools.map((tool, index) => ({
      contributionRef: `tool-prompt-contribution:collision:${index}`,
      canonicalToolName: tool.name,
      promptSnippet: `Route ${index}.`,
      usageGuidelines: [],
    })),
  }]);
  const collidingPrepared = prepareToolPromptContributions(
    collidingProviders,
    collidingTools,
    selectedWithFixture,
  );
  const collidingAliases = createProviderToolAliases(collidingTools.map((tool) => tool.name));
  assert.equal(new Set(collidingAliases.map((alias) => alias.wireName)).size, 2);
  const collidingGuidance = renderActiveToolGuidance(
    collidingPrepared,
    collidingAliases,
    collidingTools,
  );
  assert.ok(collidingGuidance);
  const collidingLines = new Set(collidingGuidance.split('\n'));
  for (const [index, tool] of collidingTools.entries()) {
    const wireName = collidingAliases.find((alias) => alias.canonicalName === tool.name)?.wireName;
    assert.ok(wireName);
    assert.ok(collidingLines.has(`- ${wireName}: Route ${index}.`));
  }
});

test('A5: Session renders one run-scoped tool guidance message with Provider aliases', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:tool-guidance';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tools = [{
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read UTF-8 text.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string' } },
    },
    possibleEffects: ['workspaceRead'],
    availability: 'callable',
    origin: 'coreBuiltin',
  }, {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Run a command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: { command: { type: 'string' } },
    },
    possibleEffects: ['process'],
    availability: 'callable',
    origin: 'coreBuiltin',
  }];
  const toolPromptContributions = [{
    contributionRef: 'tool-prompt-contribution:read',
    preparedToolBindingRef: 'tool-binding:read:g1',
    canonicalToolName: 'fs.read',
    origin: 'coreBuiltin',
    promptSnippet: 'Read UTF-8 workspace text directly.',
    usageGuidelines: ['Use this for a known text file.'],
  }, {
    contributionRef: 'tool-prompt-contribution:bash',
    preparedToolBindingRef: 'tool-binding:bash:g1',
    canonicalToolName: 'bash',
    origin: 'coreBuiltin',
    promptSnippet: 'Run commands.',
    usageGuidelines: ['Use this for search, builds, tests, and command execution.'],
  }];
  const preparation = fakeRunPreparation({ tools, toolPromptContributions });
  const requests = [];
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:tool-guidance',
        content: 'Done.',
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
    'tool-guidance',
  );

  await actor.submit(messageCommand(sessionId, 'command:tool-guidance', 'Inspect one known file.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(requests.length, 1);
  const systemMessages = requests[0].messages.filter((message) => message.role === 'system');
  const guidanceMessages = systemMessages.filter((message) => (
    message.content.startsWith('Active tool guidance:')
  ));
  assert.equal(guidanceMessages.length, 1);
  assert.equal(systemMessages.indexOf(guidanceMessages[0]), 1);
  const aliases = new Map(preparation.snapshots[0].providerToolAliases.map((alias) => (
    [alias.canonicalName, alias.wireName]
  )));
  const providerToolNames = new Set(requests[0].tools.map((tool) => tool.name));
  const guidanceLines = new Set(guidanceMessages[0].content.split('\n'));
  for (const contribution of toolPromptContributions) {
    const alias = aliases.get(contribution.canonicalToolName);
    assert.ok(alias);
    assert.ok(providerToolNames.has(alias));
    assert.ok(guidanceLines.has(`- ${alias}: ${contribution.promptSnippet}`));
    for (const guideline of contribution.usageGuidelines) {
      assert.ok(guidanceLines.has(`- ${alias}: ${guideline}`));
    }
  }
  assert.equal(guidanceMessages[0].content.match(/^- /gmu)?.length, 4);
  const events = await readEvents(journal, sessionId);
  const composition = singleEvent(events, 'context.composed');
  const guidanceReceipts = composition.payload.messages.filter((message) => (
    message.contributionId === 'instruction:deepcode.tool-guidance'
  ));
  assert.equal(guidanceReceipts.length, 1);
  assert.equal(guidanceReceipts[0].contributionKind, 'instructions');
  assert.equal(guidanceReceipts[0].role, 'system');
  assert.deepEqual(guidanceReceipts[0].blocks.map((block) => block.kind), ['text']);
  await actor.dispose();
});

test('B: snapshot-scoped wire tool resolves to exact Kernel bindings, durable ToolRecord, and continuation', async (t) => {
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
      assert.deepEqual(assistantToolCall.input, { workspace: 'primary', path: 'README.md' });
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

test('B1: read-only bash result projects its real write scope and continues the Loop', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:bash-read-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Execute one bounded Bash command.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'workspaceMode', 'executionScope'],
      properties: {
        command: { type: 'string' },
        workspaceMode: { type: 'string', enum: ['read', 'write'] },
        executionScope: { type: 'string', enum: ['workspace', 'host'] },
        timeout: { type: 'integer' },
      },
    },
    possibleEffects: ['process', 'workspaceMutation', 'external'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      const reply = completedExecutionReply(request, {
        workspaceId: workspaceBinding.workspaceId,
        command: request.input.command,
        cwd: '.',
        workspaceMode: request.input.workspaceMode,
        executionScope: request.input.executionScope,
        terminal: false,
        stdout: 'probe-ok',
        stderr: '',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
        capturedBytes: 8,
        durationMs: 1,
        environment: {
          shell: '/bin/bash',
          interactive: false,
          executionScope: request.input.executionScope,
          terminal: false,
          pathSource: 'hostPlusStandardDeveloperPaths',
          writeScope: 'kernelTemporaryOnly',
          homeWritable: false,
          networkAccess: false,
        },
      });
      reply.record.preparedEffect.logicalTargets = ['.'];
      reply.record.preparedEffect.processWorkspaceMode = 'read';
      reply.record.preparedEffect.processExecutionScope = 'workspace';
      return reply;
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const definition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.workspaceMode !== undefined
        ));
        assert.ok(definition, 'bash must be exposed to the Provider');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-read',
          name: definition.name,
          input: {
            workspace: 'primary',
            command: "printf 'probe-ok'",
            workspaceMode: 'read',
            executionScope: 'workspace',
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      const toolResult = request.messages
        .map(jsonMessagePayload)
        .find((payload) => payload?.outcome === 'completed');
      assert.equal(toolResult?.output?.workspaceMode, 'read');
      assert.equal(toolResult?.output?.executionScope, 'workspace');
      assert.equal(toolResult?.output?.terminal, false);
      assert.equal(toolResult?.output?.workspaceId, undefined);
      assert.equal(toolResult?.output?.environment?.writeScope, 'kernelTemporaryOnly');
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:bash-read-answer',
        content: 'Read-only shell continuation completed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'bash-read-chain',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:bash-read',
    'Run the read-only shell probe.',
  ));
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  await waitUntil(() => preparation.released.length === 1, 'process shell runtime release');

  assert.equal(providerRequests.length, 2);
  assert.equal(kernelRequests.length, 1);
  const shellActivity = projection.activities.find((activity) => (
    activity.callId === kernelRequests[0].callId
  ));
  assert.equal(shellActivity?.status, 'completed');
  assert.equal(shellActivity?.tool?.shell?.result?.environment.writeScope, 'kernelTemporaryOnly');
  const events = await readEvents(journal, sessionId);
  const requested = singleEvent(events, 'tool.requested');
  const completed = singleEvent(events, 'tool.completed');
  const providerCompletions = events.filter((event) => event.type === 'provider.turn.settled');
  assert.equal(providerCompletions.length, 2);
  assertEventOrder(requested, completed, providerCompletions[1]);

  await actor.dispose();
});

test('B2: a run without workspace bindings never exposes workspace-scoped tools', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:no-workspace-tools';
  await createSession(journal, sessionId);
  const tools = [
    {
      toolBindingRef: 'tool-binding:list:no-workspace',
      name: 'fs.read',
      description: 'Read one workspace file.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string' },
        },
      },
      possibleEffects: ['workspaceRead'],
      availability: 'callable',
      origin: 'coreBuiltin',
    },
    {
      toolBindingRef: 'tool-binding:shell:no-workspace',
      name: 'bash',
      description: 'Run one workspace process.',
      inputSchema: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string' },
        },
      },
      possibleEffects: ['process', 'workspaceMutation', 'external'],
      availability: 'callable',
      origin: 'coreBuiltin',
    },
    {
      toolBindingRef: 'tool-binding:web:no-workspace',
      name: 'web.search',
      description: 'Search a non-workspace source.',
      inputSchema: { type: 'object' },
      possibleEffects: ['network'],
      availability: 'callable',
      origin: 'coreBuiltin',
    },
    {
      toolBindingRef: 'tool-binding:mcp:no-workspace',
      name: 'mcp.echo',
      description: 'Call a non-workspace external tool.',
      inputSchema: { type: 'object' },
      possibleEffects: ['external'],
      availability: 'callable',
      origin: 'extension',
      pluginUri: 'plugin://echo@test',
    },
  ];
  const preparation = fakeRunPreparation({ tools });
  let capturedRequest;
  const actor = actorWith(
    journal,
    sessionId,
    {
      async *stream(request) {
        capturedRequest = structuredClone(request);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:no-workspace',
          content: 'No workspace is required for this answer.',
        });
        yield providerEvent(request.requestId, 'completed', {});
      },
    },
    emptyKernel(),
    preparation.port,
    'no-workspace-tools',
  );

  await actor.submit(messageCommand(sessionId, 'command:no-workspace', 'Report your status.'));
  const projection = await waitForProjection(
    actor,
    (value) => value.run?.status === 'completed',
  );
  assert.deepEqual(capturedRequest.workspaceBindings, []);
  assert.deepEqual(capturedRequest.tools.map((tool) => tool.name), [
    'web_search',
    'interaction_request',
    'mcp_echo',
  ]);
  assert.equal(capturedRequest.tools.some((tool) => (
    tool.inputSchema?.properties?.workspaceId !== undefined
  )), false);
  assert.ok(capturedRequest.messages.some((message) => (
    message.role === 'system'
    && message.content.includes('do not invent a workspace handle')
  )));
  assert.deepEqual(
    projection.contextCompositions.at(-1).tools.map((tool) => tool.itemId),
    ['web.search', 'interaction.request', 'mcp.echo'],
  );
  await actor.dispose();
});

test('C: explicit /focus and same-runtime pressure compact only after a successful summary turn', async () => {
  await verifyExplicitFocusCompaction();
  await verifyPressureCompaction();
});

test('D: cancel and service disposal close their owned runtime boundaries in order', async () => {
  await verifyWaitingCancelRelease();
  await verifyComposedDisposeRelease();
  await verifyExecutingToolDisposeCleanup();
});

test('D2: deletion remains available while an unloadable actor rolls back cleanly', async () => {
  const baseJournal = new InMemoryCommandJournal();
  const sessionId = 'session:delete-unloadable';
  await createSession(baseJournal, sessionId);
  let readCount = 0;
  let recoveryStartedResolve;
  let releaseRecoveryResolve;
  const recoveryStarted = new Promise((resolve) => { recoveryStartedResolve = resolve; });
  const releaseRecovery = new Promise((resolve) => { releaseRecoveryResolve = resolve; });
  const journal = forwardingJournal(baseJournal, async function* (targetSessionId, afterSequence) {
    readCount += 1;
    if (readCount === 1) {
      for await (const event of baseJournal.read(targetSessionId, afterSequence)) yield event;
      return;
    }
    recoveryStartedResolve();
    await releaseRecovery;
    throw new Error('fixture_recovery_failed');
  });
  let disposeCount = 0;
  const preparation = fakeRunPreparation();
  const service = new SessionService(journal, {
    async create() {
      return {
        composition: {
          contextProviders: [],
          provider: { async *stream() { throw new Error('unexpected_provider_turn'); } },
          memory: { id: 'memory.complete', select: ({ messages }) => messages },
          observers: [],
          kernel: emptyKernel(),
          runPreparation: preparation.port,
          async dispose() { disposeCount += 1; },
        },
      };
    },
  });

  const snapshot = service.snapshot(sessionId);
  await recoveryStarted;
  const deletion = service.deleteSession(sessionId);
  releaseRecoveryResolve();
  await assert.rejects(snapshot, /fixture_recovery_failed/u);
  await deletion;
  assert.equal(disposeCount, 1);
  await assert.rejects(async () => {
    for await (const _event of baseJournal.read(sessionId)) {
      // The deleted journal must not yield any event.
    }
  }, /session_not_found/u);
  await service.dispose();
});

test('D3: an escaped Loop fault remains Session-local and releases its runtime', async () => {
  const baseJournal = new InMemoryCommandJournal();
  const failingSessionId = 'session:contained-loop-failure';
  const healthySessionId = 'session:healthy-after-loop-failure';
  const journal = {
    createSession: (input) => baseJournal.createSession(input),
    deleteSession: (sessionId) => baseJournal.deleteSession(sessionId),
    append: (event) => baseJournal.append(event),
    appendBatch(events) {
      if (events.some((event) => (
        event.sessionId === failingSessionId && event.type === 'provider.turn.settled'
      ))) throw new Error('fixture_journal_settlement_failed');
      return baseJournal.appendBatch(events);
    },
    read: (sessionId, afterSequence) => baseJournal.read(sessionId, afterSequence),
    readCommand: (sessionId, commandId) => baseJournal.readCommand(sessionId, commandId),
    commitCommand: (command, events, reply) => baseJournal.commitCommand(command, events, reply),
  };
  await createSession(journal, failingSessionId);
  await createSession(journal, healthySessionId);

  const failingPreparation = fakeRunPreparation();
  const answerProvider = {
    async *stream(request) {
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:${request.sessionId}`,
        content: `answer for ${request.sessionId}`,
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const failingActor = actorWith(
    journal,
    failingSessionId,
    answerProvider,
    emptyKernel(),
    failingPreparation.port,
    'contained-loop-failure',
  );
  await failingActor.submit(messageCommand(
    failingSessionId,
    'command:contained-loop-failure',
    'Trigger the fixture failure.',
  ));
  await waitUntil(() => failingActor.hasLoopFailure(), 'contained Loop failure');
  assert.equal(failingPreparation.released.length, 1);
  await assert.rejects(
    failingActor.snapshot(),
    /session_loop_failed:fixture_journal_settlement_failed/u,
  );

  const healthyPreparation = fakeRunPreparation();
  const healthyActor = actorWith(
    journal,
    healthySessionId,
    answerProvider,
    emptyKernel(),
    healthyPreparation.port,
    'healthy-after-loop-failure',
  );
  await healthyActor.submit(messageCommand(
    healthySessionId,
    'command:healthy-after-loop-failure',
    'Complete after the other Session failed.',
  ));
  const healthy = await waitForProjection(
    healthyActor,
    (projection) => projection.run?.status === 'completed',
  );
  assert.equal(healthy.terminalError, null);
  assert.equal(healthyPreparation.released.length, 1);

  await failingActor.dispose();
  await healthyActor.dispose();
});

test('E: one Plan confirmation resumes the same run into Todo-backed execution', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-plan-execution';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:write:g1',
    name: 'fs.write',
    description: 'Replace one fixture file.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    possibleEffects: ['workspaceMutation'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      assert.equal(request.planAuthorities?.length, 1);
      assert.equal(request.planAuthorities[0].runId, request.runId);
      assert.deepEqual(request.planAuthorities[0].coveredOperations, [{
        workspaceId: workspaceBinding.workspaceId,
        operation: 'fs.write',
        target: 'README.md',
      }]);
      return completedExecutionReply(request, { written: true });
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      const writeDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.path !== undefined
        && candidate.inputSchema?.properties?.content !== undefined
      ));

      if (providerRequests.length === 1) {
        assert.equal(request.responseConstraint, 'normal');
        assert.ok(planDefinition, 'plan.publish must be available');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:plan',
          name: planDefinition.name,
          input: {
            title: 'Update fixture README',
            summary: 'Write the confirmed fixture content.',
            steps: [{
              stepId: 'write-readme',
              title: 'Write README',
              details: 'Replace README.md with the confirmed fixture content.',
            }],
            mutationManifest: [{
              workspace: 'primary',
              operation: 'fs.write',
              target: 'README.md',
            }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 2) {
        assert.equal(request.responseConstraint, 'toolRequired');
        const preConfirmationRequest = providerRequests[0];
        assert.deepEqual(
          request.messages.slice(0, preConfirmationRequest.messages.length),
          preConfirmationRequest.messages,
          'Plan confirmation must preserve the preceding Provider message prefix',
        );
        const executionDirective = request.messages.map(jsonMessagePayload).find((value) => value?.nextAction);
        assert.match(executionDirective?.nextAction ?? '', /^The Plan is confirmed\. Execute it now\./u);
        assert.equal(
          request.messages.slice(0, preConfirmationRequest.messages.length)
            .some((message) => message.content.startsWith('The Plan is confirmed.')),
          false,
          'the transient execution directive must not be inserted into the stable prefix',
        );
        const confirmation = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.response?.kind === 'confirm');
        const todo = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.type === 'todo.current');
        assert.ok(confirmation, 'confirmed Plan must be projected as the plan call result');
        assert.ok(todo, 'confirmation must atomically seed Provider-visible Todo');
        assert.equal('executionDirective' in todo, false);
        assert.ok(writeDefinition, 'confirmed execution tool must remain available');
        assert.equal(
          request.tools.some((candidate) => candidate.name.includes('todo')),
          false,
          'Todo progress is Session-owned and must not be a Provider tool',
        );

        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:write',
          name: writeDefinition.name,
          input: {
            workspace: 'primary',
            path: 'README.md',
            content: 'Confirmed fixture content.\n',
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 3) {
        yield* planProgressEvents(request, 'completed', true);
        return;
      }
      assert.equal(providerRequests.length, 4);
      assert.equal(request.responseConstraint, 'normal');
      const todoStates = request.messages
        .map(jsonMessagePayload)
        .filter((payload) => payload?.type?.startsWith('todo.'));
      assert.equal(todoStates.length, 2);
      assert.equal(todoStates[0].items[0].status, 'pending');
      assert.equal(todoStates.at(-1).items[0].status, 'completed');
      for (let index = 1; index < providerRequests.length; index += 1) {
        assert.deepEqual(providerRequests[index].messages.slice(0, providerRequests[index - 1].messages.length), providerRequests[index - 1].messages);
      }
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:plan-complete',
        content: 'Confirmed plan executed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'confirmed-plan-execution',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:plan-start',
    'Update the fixture through a confirmed plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  const plan = waiting.pendingPlan;
  const confirmationReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: plan.planId,
    revision: plan.revision,
    response: { kind: 'confirm' },
  });
  assert.equal(confirmationReply.status, 'accepted');
  const stalePlanReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:plan-stale',
    sessionId,
    runId: waiting.run.runId,
    planId: plan.planId,
    revision: plan.revision,
    response: { kind: 'cancel' },
  });
  assert.equal(stalePlanReply.status, 'rejected');
  assert.equal(stalePlanReply.error?.code, 'plan_not_pending');
  assert.equal(
    (await journal.readCommand(sessionId, 'command:plan-stale'))?.reply.status,
    'rejected',
  );

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'confirmed Plan runtime release');
  assert.equal(providerRequests.length, 4);
  assert.equal(kernelRequests.length, 1);
  assert.equal(completed.plans[0].status, 'completed');
  assert.equal(completed.todoList.items[0].status, 'completed');

  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'input.accepted').length, 1);
  const published = singleEvent(events, 'plan.published');
  const confirmed = singleEvent(events, 'plan.confirmed');
  const seeded = singleEvent(events, 'todo.seeded');
  const requested = singleEvent(events, 'tool.requested');
  const progressed = singleEvent(events, 'todo.progressed');
  const toolCompleted = singleEvent(events, 'tool.completed');
  const planCompleted = singleEvent(events, 'plan.completed');
  const finalMessage = events.find((event) => (
    event.type === 'message.committed' && event.payload.role === 'assistant'
  ));
  const finishing = singleEvent(events, 'run.finishing');
  const released = singleEvent(events, 'run.runtime.released');
  const settlement = singleEvent(events, 'run.settled');
  assert.ok(finalMessage, 'same run must finish with one final assistant message');
  assertEventOrder(
    published,
    confirmed,
    seeded,
    requested,
    toolCompleted,
    progressed,
    planCompleted,
    finalMessage,
    finishing,
    released,
    settlement,
  );

  await actor.dispose();
});

test('E1: confirmed Host Bash uses composite authority and only a successful retry completes Todo', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-bash-retry';
  await createSession(journal, sessionId, [workspaceBinding]);

  const command = "printf ready > marker.txt";
  const terminal = { stdin: 'ready\n' };
  const preparedTool = {
    toolBindingRef: 'tool-binding:bash:g1',
    name: 'bash',
    description: 'Execute a bounded Bash command from the bound workspace.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'workspaceMode', 'executionScope'],
      properties: {
        command: { type: 'string' },
        workspaceMode: { type: 'string', enum: ['read', 'write'] },
        executionScope: { type: 'string', enum: ['workspace', 'host'] },
        timeout: { type: 'integer', minimum: 1, maximum: 600 },
        terminal: {
          type: 'object',
          additionalProperties: false,
          required: ['stdin'],
          properties: { stdin: { type: 'string' } },
        },
      },
    },
    possibleEffects: ['process', 'workspaceMutation', 'external'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  const shellOutput = (request, exitCode, stderr = '') => ({
    workspaceId: workspaceBinding.workspaceId,
    command: request.input.command,
    cwd: '.',
    workspaceMode: request.input.workspaceMode,
    executionScope: request.input.executionScope,
    terminal: request.input.terminal !== undefined,
    stdout: exitCode === 0 ? 'ready' : '',
    stderr,
    exitCode,
    success: exitCode === 0,
    timedOut: false,
    truncated: false,
    capturedBytes: exitCode === 0 ? 5 : stderr.length,
    durationMs: 1,
    environment: {
      shell: '/bin/bash',
      interactive: request.input.terminal !== undefined,
      executionScope: request.input.executionScope,
      terminal: request.input.terminal !== undefined,
      pathSource: 'hostPlusStandardDeveloperPaths',
      writeScope: 'hostUser',
      homeWritable: true,
      networkAccess: true,
    },
  });
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      assert.equal(request.planAuthorities?.length, 1);
      assert.deepEqual(request.planAuthorities[0].coveredOperations, [{
        workspaceId: workspaceBinding.workspaceId,
        operation: 'bash',
        command,
        workspaceMode: 'write',
        executionScope: 'host',
        terminal,
      }]);
      const reply = kernelRequests.length === 1
        ? failedExecutionReply(
            request,
            shellOutput(request, 7, 'fixture failure'),
            { code: 'bash_exit_nonzero', message: 'Bash command exited with status 7.' },
          )
        : completedExecutionReply(request, shellOutput(request, 0));
      reply.record.preparedEffect.logicalTargets = ['.'];
      reply.record.preparedEffect.processWorkspaceMode = 'write';
      reply.record.preparedEffect.processExecutionScope = 'host';
      reply.record.authority = {
        decision: 'allow',
        source: 'composite',
        workspaceAuthority: reply.record.authority,
        externalAuthority: {
          decision: 'allow',
          source: 'userSetting',
          authorityId: 'user-setting:agent.permissions.external',
        },
      };
      return reply;
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      const bashDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.workspaceMode !== undefined
        && candidate.inputSchema?.properties?.command !== undefined
      ));

      if (providerRequests.length === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-plan',
          name: planDefinition.name,
          input: {
            title: 'Create marker through Bash',
            summary: 'Run the exact confirmed Bash mutation.',
            steps: [{
              stepId: 'run-bash',
              title: 'Run Bash mutation',
              details: 'Create marker.txt from the bound workspace root.',
            }],
            mutationManifest: [{
              workspace: 'primary',
              operation: 'bash',
              command,
              workspaceMode: 'write',
              executionScope: 'host',
              terminal,
            }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 2) {
        assert.equal(request.responseConstraint, 'toolRequired');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-first',
          name: bashDefinition.name,
          input: {
            workspace: 'primary',
            command,
            workspaceMode: 'write',
            executionScope: 'host',
            terminal,
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 3) {
        assert.equal(request.responseConstraint, 'toolRequired');
        const failedResult = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.outcome === 'failed');
        assert.equal(failedResult?.error?.code, 'bash_exit_nonzero');
        assert.equal(failedResult?.output?.exitCode, 7);
        assert.equal(failedResult?.output?.stderr, 'fixture failure');
        assert.equal(failedResult?.output?.workspaceId, undefined);
        const todo = request.messages
          .map(jsonMessagePayload)
          .find((payload) => payload?.type === 'todo.current');
        assert.equal(todo?.items[0].status, 'pending');
        yield* planProgressEvents(request, 'inProgress');
        return;
      }
      if (providerRequests.length === 4) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:bash-retry',
          name: bashDefinition.name,
          input: {
            workspace: 'primary',
            command,
            workspaceMode: 'write',
            executionScope: 'host',
            terminal,
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      if (providerRequests.length === 5) {
        yield* planProgressEvents(request);
        return;
      }
      assert.equal(providerRequests.length, 6);
      assert.equal(request.responseConstraint, 'normal');
      const todo = request.messages
        .map(jsonMessagePayload)
        .findLast((payload) => payload?.type === 'todo.current');
      assert.equal(todo?.items[0].status, 'completed');
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:bash-plan-complete',
        content: 'Confirmed Bash plan executed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'confirmed-bash-retry',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:bash-plan-start',
    'Create the marker through a confirmed Bash plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  const confirmationReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:bash-plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: waiting.pendingPlan.planId,
    revision: waiting.pendingPlan.revision,
    response: { kind: 'confirm' },
  });
  assert.equal(confirmationReply.status, 'accepted');

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'confirmed Bash runtime release');
  assert.equal(kernelRequests.length, 2);
  assert.equal(completed.todoList.items[0].status, 'completed');
  const shellActivities = completed.activities.filter((activity) => (
    activity.tool?.operation === 'bash'
  ));
  assert.deepEqual(shellActivities.map((activity) => activity.status), ['failed', 'completed']);
  assert.equal(shellActivities[0].tool.shell.result.exitCode, 7);

  const events = await readEvents(journal, sessionId);
  const toolRecords = events
    .filter((event) => event.type === 'tool.completed')
    .map((event) => event.payload.record);
  assert.deepEqual(toolRecords.map((record) => record.outcome), ['failed', 'completed']);
  assert.equal(events.filter((event) => event.type === 'todo.progressed').length, 2);

  await actor.dispose();
});

test('E2: confirmed fs.delete reads targetKind from canonical arguments and completes Todo', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-delete';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparedTool = {
    toolBindingRef: 'tool-binding:delete:g1',
    name: 'fs.delete',
    description: 'Delete one exact workspace target.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'targetKind'],
      properties: {
        path: { type: 'string' },
        targetKind: { type: 'string', enum: ['file', 'directoryTree'] },
      },
    },
    possibleEffects: ['workspaceMutation'],
    availability: 'callable',
    origin: 'coreBuiltin',
  };
  const preparation = fakeRunPreparation({ tools: [preparedTool] });
  const kernelRequests = [];
  const kernel = emptyKernel({
    async execute(request) {
      kernelRequests.push(structuredClone(request));
      assert.deepEqual(request.planAuthorities[0].coveredOperations, [{
        workspaceId: workspaceBinding.workspaceId,
        operation: 'fs.delete',
        target: 'generated',
        targetKind: 'directoryTree',
      }]);
      return completedExecutionReply(request, { deleted: true });
    },
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      const deleteDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.targetKind !== undefined
      ));
      if (providerRequests.length === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:delete-plan',
          name: planDefinition.name,
          input: {
            title: 'Delete generated directory',
            summary: 'Delete the exact confirmed directory tree.',
            steps: [{
              stepId: 'delete-generated',
              title: 'Delete generated directory',
              details: 'Delete the generated directory tree.',
            }],
            mutationManifest: [{
              workspace: 'primary',
              operation: 'fs.delete',
              target: 'generated',
              targetKind: 'directoryTree',
            }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      if (providerRequests.length === 2) {
        assert.equal(request.responseConstraint, 'toolRequired');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:delete',
          name: deleteDefinition.name,
          input: {
            workspace: 'primary',
            path: 'generated',
            targetKind: 'directoryTree',
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      if (providerRequests.length === 3) {
        yield* planProgressEvents(request);
        return;
      }
      assert.equal(providerRequests.length, 4);
      const todo = request.messages
        .map(jsonMessagePayload)
        .findLast((payload) => payload?.type === 'todo.current');
      assert.equal(todo?.items[0].status, 'completed');
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:delete-plan-complete',
        content: 'Confirmed delete plan executed.',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'confirmed-delete',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:delete-plan-start',
    'Delete the generated directory through a confirmed plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:delete-plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: waiting.pendingPlan.planId,
    revision: waiting.pendingPlan.revision,
    response: { kind: 'confirm' },
  });

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'confirmed delete runtime release');
  assert.equal(kernelRequests.length, 1);
  assert.equal(completed.todoList.items[0].status, 'completed');
  assert.equal(completed.plans[0].status, 'completed');

  await actor.dispose();
});

test('F: confirmed Plan execution turn rejects a plain terminal answer', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:confirmed-plan-answer-rejected';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      const planDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.mutationManifest !== undefined
      ));
      if (providerRequests.length === 1) {
        assert.equal(request.responseConstraint, 'normal');
        assert.ok(planDefinition, 'plan.publish must be available');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:plan',
          name: planDefinition.name,
          input: {
            title: 'Execute one confirmed step',
            summary: 'The confirmed step must enter an execution turn.',
            steps: [{
              stepId: 'execute-step',
              title: 'Execute the step',
              details: 'Use the available structured actions after confirmation.',
            }],
            mutationManifest: [],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      assert.equal(providerRequests.length, 2);
      assert.equal(request.responseConstraint, 'toolRequired');
      assert.ok(request.messages
        .map(jsonMessagePayload)
        .some((payload) => payload?.response?.kind === 'confirm'));
      assert.ok(request.messages
        .map(jsonMessagePayload)
        .some((payload) => payload?.type === 'todo.current'));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:invalid-execution-answer',
        content: 'The plan is published; wait for another confirmation.',
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
    'confirmed-plan-answer-rejected',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:plan-start',
    'Publish and execute a confirmed plan.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingPlan !== null
  ));
  const plan = waiting.pendingPlan;
  const confirmationReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'plan.respond',
    commandId: 'command:plan-confirm',
    sessionId,
    runId: waiting.run.runId,
    planId: plan.planId,
    revision: plan.revision,
    response: { kind: 'confirm' },
  });
  assert.equal(confirmationReply.status, 'accepted');

  const failed = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  await waitUntil(() => preparation.released.length === 1, 'failed execution runtime release');
  assert.equal(providerRequests.length, 2);
  assert.equal(failed.plans[0].status, 'confirmed');
  assert.equal(failed.todoList.items[0].status, 'pending');
  assert.equal(failed.terminalError.code, 'confirmed_plan_execution_required');

  const events = await readEvents(journal, sessionId);
  const confirmed = singleEvent(events, 'plan.confirmed');
  const seeded = singleEvent(events, 'todo.seeded');
  const completions = events.filter((event) => event.type === 'provider.turn.settled');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(completions.length, 2);
  assert.equal(settlement.payload.outcome, 'failed');
  assert.equal(settlement.payload.error.code, 'confirmed_plan_execution_required');
  assert.equal(events.some((event) => (
    event.type === 'message.committed'
    && event.payload.role === 'assistant'
    && event.payload.content.includes('another confirmation')
  )), false);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
  assertEventOrder(confirmed, seeded, completions[1], settlement);

  await actor.dispose();
});

test('G: built-in runtime and control prompts stay concise and policy-scoped', () => {
  const stableCore = [{ id: 'deepcode.coding-agent', text: 'Stable core instruction.' }];
  const baseConfig = {
    extensionGenerationRef: 'extension-generation:g1',
    selectedPlugins: [{
      uri: 'plugin://fixture@skill',
      displayName: 'Fixture',
      capabilitySummary: 'Read the explicitly selected fixture instructions.',
    }],
  };
  const planAsk = runtimeInstructions(stableCore, {
    ...baseConfig,
    workspaceMutation: 'plan',
    engineeringDecisions: 'ask',
  }, {
    interactionRequest: 'ask_user_wire',
    planPublish: 'publish_plan_wire',
  });
  const allowDelegate = runtimeInstructions(stableCore, {
    ...baseConfig,
    workspaceMutation: 'allow',
    engineeringDecisions: 'delegate',
  });

  const planInstruction = planAsk.find((instruction) => (
    instruction.id === 'deepcode.workspace-autonomy'
  ))?.text ?? '';
  assert.ok(planInstruction.includes('publish_plan_wire'));
  assert.ok(planInstruction.includes('ask_user_wire'));
  assert.ok(planInstruction.includes('Then execute within its file and execution scope'));
  assert.ok(planInstruction.includes('Routine command or edit details do not require reconfirmation'));
  assert.ok(planInstruction.length < 600);
  const allowInstruction = allowDelegate.find((instruction) => (
    instruction.id === 'deepcode.workspace-autonomy'
  ))?.text ?? '';
  assert.ok(allowInstruction.includes('interaction_request'));
  assert.equal(allowInstruction.includes('plan_publish'), false);
  assert.ok(allowInstruction.length < 300);
  const pluginInstruction = planAsk.find((instruction) => (
    instruction.id === 'plugin.fixture.skill'
  ))?.text ?? '';
  assert.ok(pluginInstruction.includes('Fixture'));
  assert.ok(pluginInstruction.includes('structured user input'));
  assert.ok(pluginInstruction.includes('Read the explicitly selected fixture instructions.'));
  const controls = sessionControlToolDefinitions();
  assert.deepEqual(controls.map((tool) => tool.name), ['interaction.request', 'plan.publish', 'plan.progress']);
  assert.match(controls[1].description, /not an exact script lock/u);
  assert.match(controls[2].description, /sourceFactRef is its recordId/u);
  const bashScope = controls[1].inputSchema.properties.mutationManifest.items.oneOf[2];
  assert.equal(bashScope.required.includes('command'), false);
  assert.ok(bashScope.required.includes('executionScope'));
});

test('H: an explicit Provider failure remains failed with its original error', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:provider-failure';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const provider = {
    async *stream(request) {
      yield providerEvent(request.requestId, 'failed', {
        code: 'provider_http_failed',
        message: 'Provider returned HTTP 400: tool_choice is not supported in thinking mode.',
      });
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'provider-failure',
  );

  await actor.submit(messageCommand(sessionId, 'command:provider-failure', 'Run the fixture.'));
  const failed = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  await waitUntil(() => preparation.released.length === 1, 'failed Provider runtime release');
  assert.deepEqual(failed.terminalError, {
    code: 'provider_http_failed',
    message: 'Provider returned HTTP 400: tool_choice is not supported in thinking mode.',
  });

  const events = await readEvents(journal, sessionId);
  const composition = singleEvent(events, 'context.composed');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(settlement.payload.outcome, 'failed');
  assert.deepEqual(settlement.payload.error, failed.terminalError);
  const providerSettlement = singleEvent(events, 'provider.turn.settled');
  assert.equal(providerSettlement.payload.outcome, 'failed');
  assert.deepEqual(providerSettlement.payload.error, failed.terminalError);
  assertEventOrder(composition, providerSettlement, settlement);

  await actor.dispose();
});

test('H1: Provider cache fields are absent together or exactly partition one call input', async () => {
  const invalidCases = [
    { label: 'missing-miss', cacheReadInputTokens: 40 },
    { label: 'undercount', cacheReadInputTokens: 40, cacheMissInputTokens: 50 },
    { label: 'overcount', cacheReadInputTokens: 60, cacheMissInputTokens: 50 },
  ];
  for (const { label, ...cacheFields } of invalidCases) {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:invalid-cache-${label}`;
    await createSession(journal, sessionId);
    const preparation = fakeRunPreparation({ contextWindowTokens: 1_000 });
    const provider = {
      async *stream(request) {
        yield providerEvent(request.requestId, 'completed', {
          usage: {
            inputTokens: 100,
            outputTokens: 0,
            contextWindowTokens: 1_000,
            ...cacheFields,
          },
        });
      },
    };
    const actor = actorWith(
      journal,
      sessionId,
      provider,
      emptyKernel(),
      preparation.port,
      `invalid-cache-${label}`,
    );

    await actor.submit(messageCommand(
      sessionId,
      `command:invalid-cache-${label}`,
      'Validate the cache usage contract.',
    ));
    const failed = await waitForProjection(actor, (value) => value.run?.status === 'failed');
    await waitUntil(() => preparation.released.length === 1, 'invalid cache runtime release');
    assert.equal(failed.terminalError?.code, 'provider_usage_invalid');
    const events = await readEvents(journal, sessionId);
    assert.equal(singleEvent(events, 'provider.turn.settled').payload.outcome, 'failed');
    assert.equal(events.some((event) => event.type === 'context.updated'), false);
    await actor.dispose();
  }
});

test('I0: current Todo state precedes later inserted user input without splitting its tool result', () => {
  const sessionId = 'session:todo-user-boundary';
  const runId = 'run:todo-user-boundary';
  const events = [
    {
      schemaVersion: 'deepcode.session-event.v4',
      eventId: 'event:1',
      sessionId,
      sequence: 1,
      occurredAt: '2026-09-02T00:00:00.000Z',
      type: 'message.committed',
      runId,
      payload: {
        messageId: 'message:initial',
        role: 'user',
        content: 'Initial request.',
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v4',
      eventId: 'event:2',
      sessionId,
      sequence: 2,
      occurredAt: '2026-09-02T00:00:01.000Z',
      type: 'todo.seeded',
      runId,
      payload: {
        sourcePlanId: 'plan:todo-user-boundary',
        sourcePlanRevision: 1,
        items: [{
          todoId: 'todo:one',
          sourceStepId: 'step:one',
          label: 'Execute the fixture step.',
          status: 'inProgress',
        }],
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v4',
      eventId: 'event:3',
      sessionId,
      sequence: 3,
      occurredAt: '2026-09-02T00:00:02.000Z',
      type: 'interaction.requested',
      runId,
      callId: 'call:interaction',
      payload: {
        interactionId: 'interaction:one',
        providerCallId: 'provider-call:interaction',
        kind: 'question',
        prompt: 'Choose one option.',
        allowFreeform: true,
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v4',
      eventId: 'event:4',
      sessionId,
      sequence: 4,
      occurredAt: '2026-09-02T00:00:03.000Z',
      type: 'provider.turn.settled',
      runId,
      payload: {
        providerRequestId: 'provider-request:interaction',
        purpose: 'agent',
        providerRuntimeRef: 'provider-runtime:test',
        outcome: 'completed',
        orderedCallIds: ['call:interaction'],
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v4',
      eventId: 'event:5',
      sessionId,
      sequence: 5,
      occurredAt: '2026-09-02T00:00:04.000Z',
      type: 'interaction.resolved',
      runId,
      payload: {
        interactionId: 'interaction:one',
        commandId: 'command:interaction',
        response: 'Option A',
      },
    },
    {
      schemaVersion: 'deepcode.session-event.v4',
      eventId: 'event:6',
      sessionId,
      sequence: 6,
      occurredAt: '2026-09-02T00:00:05.000Z',
      type: 'message.committed',
      runId,
      payload: {
        messageId: 'message:interaction-response',
        role: 'user',
        content: 'Option A',
      },
    },
  ];

  const contributions = messagesFromJournal(events, runId, []);
  const resultIndex = contributions.findIndex((item) => (
    item.contributionId === 'interaction-result:interaction:one'
  ));
  const todoIndex = contributions.findIndex((item) => (
    item.contributionId === 'todo-state:event:2'
  ));
  const userIndex = contributions.findIndex((item) => (
    item.contributionId === 'message:message:interaction-response'
  ));
  assert.ok(resultIndex >= 0);
  assert.ok(todoIndex >= 0 && todoIndex < resultIndex, 'Todo stays at its original event boundary');
  assert.ok(userIndex > resultIndex, 'the later tagged user input must follow its tool result');
  assert.equal(contributions.at(-1)?.message.role, 'user');
});

test('I: an interaction response is inserted after its tool result and a stale second response is durable', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:interaction-resume';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      if (providerRequests.length === 1) {
        const interactionDefinition = request.tools.find((candidate) => (
          candidate.inputSchema?.properties?.prompt !== undefined
          && candidate.inputSchema?.properties?.allowFreeform !== undefined
        ));
        assert.ok(interactionDefinition, 'interaction control must be available');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:interaction-resume',
          name: interactionDefinition.name,
          input: {
            kind: 'question',
            prompt: 'Which fixture option?',
            allowFreeform: true,
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }

      assert.equal(providerRequests.length, 2);
      const callIndex = request.messages.findIndex((message) => (
        message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0
      ));
      const resultIndex = request.messages.findIndex((message) => message.role === 'tool');
      const responseIndex = request.messages.findLastIndex((message) => (
        message.role === 'user' && message.content === 'Use option A.'
      ));
      assert.ok(callIndex >= 0, 'the prior interaction call must remain in context');
      assert.ok(resultIndex > callIndex, 'the interaction result must follow its call');
      assert.ok(responseIndex > resultIndex, 'the tagged user response must follow the tool result');
      assert.equal(request.messages.at(-1)?.role, 'user');
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:interaction-resume',
        content: 'Option A accepted.',
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
    'interaction-resume',
  );

  await actor.submit(messageCommand(
    sessionId,
    'command:interaction-start',
    'Ask for one fixture decision.',
  ));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingInteraction !== null
  ));
  const interaction = waiting.pendingInteraction;
  const accepted = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'interaction.respond',
    commandId: 'command:interaction-accepted',
    sessionId,
    runId: waiting.run.runId,
    interactionId: interaction.interactionId,
    response: 'Use option A.',
  });
  assert.equal(accepted.status, 'accepted');
  const stale = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'interaction.respond',
    commandId: 'command:interaction-stale',
    sessionId,
    runId: waiting.run.runId,
    interactionId: interaction.interactionId,
    response: 'Use option B.',
  });
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.error?.code, 'interaction_not_pending');
  assert.equal(
    (await journal.readCommand(sessionId, 'command:interaction-stale'))?.reply.status,
    'rejected',
  );

  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.equal(completed.pendingInteraction, null);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'interaction.resolved').length, 1);
  assert.equal(events.filter((event) => (
    event.type === 'message.committed' && event.payload.role === 'user'
  )).length, 2);
  await actor.dispose();
});

async function verifyExplicitFocusCompaction() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:focus-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation({
    contextWindowTokens: 1_000,
    maxOutputTokens: 120,
  });
  const requests = [];
  let agentTurn = 0;
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      if (request.purpose === 'contextCompaction') {
        assert.equal(request.responseConstraint, 'answerOnly');
        assert.equal(request.maxOutputTokens, 120);
        assert.deepEqual(request.tools, []);
        assert.ok(request.messages.some((message) => (
          message.role === 'system'
          && message.content?.startsWith('Summarize the supplied Session history into a factual handoff')
        )));
        assert.ok(request.messages.some((message) => (
          message.role === 'system'
          && message.content === 'Prioritize existing facts relevant to the following future-work focus, but do not answer it:\nPreserve the selected facts.'
        )));
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:focus-summary',
          content: 'Durable focus summary.',
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      agentTurn += 1;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:focus-agent:${agentTurn}`,
        content: `Agent fixture result ${agentTurn}.`,
      });
      yield providerEvent(request.requestId, 'completed', agentTurn === 1
        ? {
            usage: {
              inputTokens: 100,
              outputTokens: 10,
              contextWindowTokens: 1_000,
            },
          }
        : {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'focus-chain',
  );

  await actor.submit(messageCommand(sessionId, 'command:focus-seed', 'Seed context.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'focus seed release');
  await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'context.focus',
    commandId: 'command:focus',
    sessionId,
    task: 'Preserve the selected facts.',
  });
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed' && preparation.prepared.length === 2
  ));
  await waitUntil(() => preparation.released.length === 2, 'focus run release');

  assert.deepEqual(requests.map((request) => request.purpose), [
    'agent',
    'contextCompaction',
    'agent',
  ]);
  const events = await readEvents(journal, sessionId);
  const focusRequest = events.find((event) => (
    event.type === 'context.compaction.requested' && event.payload.trigger === 'userFocus'
  ));
  assert.ok(focusRequest, 'explicit /focus must create a compaction request');
  assert.equal(focusRequest.payload.focus, 'Preserve the selected facts.');
  assert.equal(focusRequest.payload.commandId, 'command:focus');
  const focusInput = events.find((event) => (
    event.type === 'input.accepted' && event.payload.commandId === 'command:focus'
  ));
  assert.equal(focusInput?.payload.text, 'Preserve the selected facts.');
  assertSuccessfulCompactionOrder(events, focusRequest, 'Durable focus summary.');

  await actor.dispose();
}

async function verifyPressureCompaction() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:pressure-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation({
    contextWindowTokens: 1_000,
    maxOutputTokens: 200,
  });
  const requests = [];
  let agentTurn = 0;
  const provider = {
    async *stream(request) {
      requests.push(structuredClone(request));
      assert.equal(request.providerRuntimeRef, 'provider-runtime:g1');
      assert.equal(request.maxOutputTokens, 200);
      if (request.purpose === 'contextCompaction') {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'provider-message:pressure-summary',
          content: 'Durable pressure summary.',
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      agentTurn += 1;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `provider-message:pressure-agent:${agentTurn}`,
        content: `Pressure fixture result ${agentTurn}.`,
      });
      yield providerEvent(request.requestId, 'completed', agentTurn === 1
        ? {
            usage: {
              inputTokens: 850,
              outputTokens: 20,
              contextWindowTokens: 1_000,
            },
          }
        : {});
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'pressure-chain',
  );

  await actor.submit(messageCommand(sessionId, 'command:pressure-seed', 'Seed pressure facts.'));
  await waitForProjection(actor, (value) => value.run?.status === 'completed');
  await waitUntil(() => preparation.released.length === 1, 'pressure seed release');
  await actor.submit(messageCommand(sessionId, 'command:pressure-next', 'Continue with another turn.'));
  await waitForProjection(actor, (value) => (
    value.run?.status === 'completed' && preparation.prepared.length === 2
  ));
  await waitUntil(() => preparation.released.length === 2, 'pressure run release');

  assert.deepEqual(requests.map((request) => request.purpose), [
    'agent',
    'contextCompaction',
    'agent',
  ]);
  const runtime = preparation.snapshots[1].provider;
  assert.ok(850 + runtime.maxOutputTokens >= runtime.contextWindowTokens);
  const events = await readEvents(journal, sessionId);
  const pressureRequest = events.find((event) => (
    event.type === 'context.compaction.requested' && event.payload.trigger === 'pressure'
  ));
  assert.ok(pressureRequest, 'same-runtime usage plus full output reserve must request compaction');
  assertSuccessfulCompactionOrder(events, pressureRequest, 'Durable pressure summary.');

  await actor.dispose();
}

async function verifyWaitingCancelRelease() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:cancel-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  const provider = {
    async *stream(request) {
      const interactionDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.prompt !== undefined
        && candidate.inputSchema?.properties?.allowFreeform !== undefined
      ));
      assert.ok(interactionDefinition, 'interaction control must be available');
      yield providerEvent(request.requestId, 'tool.call', {
        callId: 'provider-call:interaction',
        name: interactionDefinition.name,
        input: {
          kind: 'question',
          prompt: 'Fixture decision?',
          allowFreeform: true,
        },
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
    'cancel-chain',
  );

  await actor.submit(messageCommand(sessionId, 'command:cancel-start', 'Enter a waiting boundary.'));
  const waiting = await waitForProjection(actor, (value) => (
    value.run?.status === 'waiting' && value.pendingInteraction !== null
  ));
  assert.equal(preparation.released.length, 0);
  const cancelReply = await actor.submit({
    schemaVersion: 'deepcode.command.v3',
    type: 'run.cancel',
    commandId: 'command:cancel',
    sessionId,
    runId: waiting.run.runId,
  });
  assert.equal(cancelReply.status, 'accepted');
  const cancelled = await waitForProjection(actor, (value) => value.run?.status === 'cancelled');
  await waitUntil(() => preparation.released.length === 1, 'cancelled run release');
  assert.equal(cancelled.pendingInteraction, null);

  const events = await readEvents(journal, sessionId);
  const completion = singleEvent(events, 'provider.turn.settled');
  const interaction = singleEvent(events, 'interaction.requested');
  const settlement = singleEvent(events, 'run.settled');
  assert.deepEqual(completion.payload.orderedCallIds, [interaction.callId]);
  assert.equal(settlement.payload.outcome, 'cancelled');
  assertEventOrder(interaction, completion, settlement);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: waiting.run.runId,
    kernelCatalogSnapshotRef: preparation.snapshots[0].kernelCatalogSnapshotRef,
  }]);

  await actor.dispose();
}

async function verifyComposedDisposeRelease() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:dispose-chain';
  await createSession(journal, sessionId);
  const preparation = fakeRunPreparation();
  let streamStartedResolve;
  const streamStarted = new Promise((resolve) => { streamStartedResolve = resolve; });
  let compositionDisposed = false;
  const provider = {
    async *stream(request, signal) {
      streamStartedResolve(request.requestId);
      await waitForAbort(signal);
      throw new Error('fixture_provider_interrupted');
    },
  };
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    emptyKernel(),
    preparation.port,
    'dispose-chain',
    () => { compositionDisposed = true; },
  );

  await actor.submit(messageCommand(sessionId, 'command:dispose', 'Begin an active Provider turn.'));
  const providerRequestId = await streamStarted;
  await actor.dispose();

  assert.equal(compositionDisposed, true);
  assert.equal(preparation.released.length, 1);
  const events = await readEvents(journal, sessionId);
  const composition = singleEvent(events, 'context.composed');
  const providerSettlement = singleEvent(events, 'provider.turn.settled');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(composition.payload.providerRequestId, providerRequestId);
  assert.equal(providerSettlement.payload.outcome, 'indeterminate');
  assert.equal(providerSettlement.payload.error.code, 'provider_turn_outcome_unknown');
  assert.match(providerSettlement.payload.error.message, /fixture_provider_interrupted/u);
  assert.equal(settlement.payload.outcome, 'indeterminate');
  assert.equal(settlement.payload.error.code, 'provider_turn_outcome_unknown');
  assert.match(settlement.payload.error.message, /fixture_provider_interrupted/u);
  assertEventOrder(composition, providerSettlement, settlement);
  assert.deepEqual(preparation.released, [{
    sessionId,
    runId: settlement.runId,
    kernelCatalogSnapshotRef: preparation.snapshots[0].kernelCatalogSnapshotRef,
  }]);
}

async function verifyExecutingToolDisposeCleanup() {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:executing-tool-dispose';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparedTool = {
    toolBindingRef: 'tool-binding:read:g1',
    name: 'fs.read',
    description: 'Read one fixture file.',
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
  const provider = {
    async *stream(request) {
      const readDefinition = request.tools.find((candidate) => (
        candidate.inputSchema?.properties?.path !== undefined
      ));
      assert.ok(readDefinition, 'read tool must be available');
      yield providerEvent(request.requestId, 'tool.call', {
        callId: 'provider-call:dispose-read',
        name: readDefinition.name,
        input: { workspace: 'primary', path: 'README.md' },
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  };
  let request;
  let resolveExecution;
  let executionStartedResolve;
  const executionStarted = new Promise((resolve) => { executionStartedResolve = resolve; });
  let physicalCleanupComplete = false;
  const kernel = emptyKernel({
    async execute(candidate) {
      request = structuredClone(candidate);
      executionStartedResolve();
      return await new Promise((resolve) => { resolveExecution = resolve; });
    },
    async cancel(callId, attemptId) {
      assert.equal(callId, request.callId);
      assert.equal(attemptId, request.attemptId);
      physicalCleanupComplete = true;
      const record = indeterminateExecutionRecord(request);
      resolveExecution({
        schemaVersion: 'deepcode.kernel-reply',
        type: 'tool.execution',
        requestId: request.requestId,
        callId,
        status: 'indeterminate',
        record,
      });
      return {
        schemaVersion: 'deepcode.kernel-reply',
        type: 'tool.cancelled',
        requestId: 'kernel-cancel:dispose-read',
        callId,
        attemptId,
        status: 'indeterminate',
        record,
      };
    },
  });
  const actor = actorWith(
    journal,
    sessionId,
    provider,
    kernel,
    preparation.port,
    'executing-tool-dispose',
    () => assert.equal(physicalCleanupComplete, true),
  );

  await actor.submit(messageCommand(sessionId, 'command:dispose-read', 'Read the fixture.'));
  await executionStarted;
  await actor.dispose();

  assert.equal(physicalCleanupComplete, true);
  assert.equal(preparation.released.length, 0);
  const events = await readEvents(journal, sessionId);
  const completed = singleEvent(events, 'tool.completed');
  assert.equal(completed.payload.record.outcome, 'indeterminate');
  assert.equal(events.some((event) => event.type === 'run.settled'), false);
}

test('J: input rejection is fed back once, valid batch peers execute once, and a corrected call succeeds', async () => {
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

test('J-native: completed malformed arguments are durable unexecuted results; valid peers and correction execute once', async () => {
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

test('J-budget: control input can be corrected into a confirmed Plan; a second rejection fails after actor reopen', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:correction-budget';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ apiSurface: 'responses', contextWindowTokens: 100_000 });
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    assert.ok(turns <= 3, 'a second rejected turn must not trigger another correction');
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
  assert.equal(failed.terminalError.code, 'tool_input_correction_exhausted');
  assert.match(failed.terminalError.message, /provider_tool_call_arguments_invalid/);
  assert.equal(turns, 3);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'plan.confirmed').length, 1);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
  assert.ok(events.filter((event) => event.type === 'provider.turn.settled').every((event) => event.payload.outcome === 'completed'));
  assert.deepEqual(await decodeGuiProjection(failed), failed);
  await reopened.dispose();
});

test('J-terminal: missing completion stays indeterminate; a completed unknown alias fails without correction or execution', async () => {
  for (const completed of [false, true]) {
    const journal = new InMemoryCommandJournal();
    const sessionId = `session:native-terminal-${completed}`;
    await createSession(journal, sessionId);
    const preparation = fakeRunPreparation({ apiSurface: 'responses' });
    let turns = 0;
    const actor = actorWith(journal, sessionId, { async *stream(request) {
      turns += 1;
      yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0,
        item: { type: 'function_call', call_id: 'native-terminal', name: completed ? 'undeclared_tool' : request.tools[0].name, arguments: '{', status: 'completed' } });
      if (completed) yield providerEvent(request.requestId, 'completed', {});
      else throw new Error('fixture_connection_closed');
    } }, emptyKernel(), preparation.port, `terminal-${completed}`);
    await actor.submit(messageCommand(sessionId, 'command:terminal', 'Inspect.'));
    const result = await waitForProjection(actor, (value) => value.run?.status === (completed ? 'failed' : 'indeterminate'));
    assert.equal(result.terminalError.code, completed ? 'provider_tool_alias_unknown' : 'provider_turn_outcome_unknown');
    if (!completed) assert.match(result.terminalError.message, /fixture_connection_closed/);
    assert.equal(turns, 1);
    const events = await readEvents(journal, sessionId);
    assert.equal(events.some((event) => event.type === 'tool.requested' || event.type === 'tool.input-rejected'), false);
    const settlement = singleEvent(events, 'provider.turn.settled');
    assert.equal(settlement.payload.outcome, completed ? 'failed' : 'indeterminate');
    assert.equal('orderedOutputBlocks' in settlement.payload, false);
    await actor.dispose();
  }
});

test('J1: Kernel infrastructure errors remain run failures rather than correctable input results', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:kernel-infrastructure';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [{
    toolBindingRef: 'binding:read', name: 'fs.read', description: 'Read source.',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    possibleEffects: ['workspaceRead'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    turns += 1;
    yield providerEvent(request.requestId, 'tool.call', { callId: 'provider-call:read', name: request.tools.find((tool) => tool.inputSchema.properties?.path).name, input: { workspace: 'primary', path: 'README.md' } });
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({ async execute() { throw new Error('tool_record_store_read_failed: fixture disk error'); } }), preparation.port, 'infrastructure');
  await actor.submit(messageCommand(sessionId, 'command:infra', 'Read source.'));
  const projection = await waitForProjection(actor, (value) => value.run?.status === 'failed');
  assert.equal(turns, 1);
  assert.match(projection.terminalError.message, /fixture disk error/);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'tool.input-rejected'), false);
  await actor.dispose();
});

test('K: Session settings persist independently while the active run keeps its frozen effort', async () => {
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

test('K1: the real Session bridge persists model commands and passes effort through message and focus preparation', { timeout: 15_000 }, async (t) => {
  const journal = new InMemoryCommandJournal();
  const prepared = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://fixture');
      const parts = url.pathname.split('/').map(decodeURIComponent);
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = body ? JSON.parse(body) : null;
      let data;
      if (url.pathname === '/api/local-agent/journal/sessions') data = await journal.createSession(input);
      else if (parts[6] === 'events') {
        data = [];
        for await (const event of journal.read(parts[5], Number(url.searchParams.get('after')))) data.push(event);
      } else if (parts[6] === 'commands') data = await journal.readCommand(parts[5], parts[7]);
      else if (url.pathname === '/api/local-agent/journal/commands') data = await journal.commitCommand(input.command, input.events, input.reply);
      else if (url.pathname === '/api/local-agent/runtime/prepare-run') {
        prepared.push(input);
        response.writeHead(422, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'fixture_prepare_boundary', message: 'Preparation reached; no Provider is started.' }));
        return;
      } else throw new Error(`unexpected_http_path:${url.pathname}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/sessionServiceBridge.js', import.meta.url))], {
    env: { ...process.env, DEEPCODE_LOCAL_AGENT_API_BASE: `http://127.0.0.1:${server.address().port}`, DEEPCODE_LOCAL_AGENT_TOKEN: 'fixture-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout });
  const frames = lines[Symbol.asyncIterator]();
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    lines.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  let next = 0;
  const send = async (operation, data) => {
    const requestId = `bridge-request:${++next}`;
    child.stdin.write(`${JSON.stringify({ protocolVersion: 'deepcode.local-agent', requestId, operation, data })}\n`);
    const frame = await frames.next();
    assert.equal(frame.done, false, stderr);
    const reply = JSON.parse(frame.value);
    assert.equal(reply.requestId, requestId);
    return reply;
  };
  const sessionId = 'session:bridge-settings';
  assert.equal((await send('createSession', { sessionId, displayTitle: 'Bridge fixture', workspaceBindings: [] })).ok, true);
  const command = { schemaVersion: 'deepcode.command.v3', type: 'session.model-settings.set', commandId: 'command:wire-settings', sessionId, settings: { profileId: 'profile:wire', reasoningEffortOverride: 'medium' } };
  const saved = await send('submit', { command });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const projection = (await send('snapshot', { sessionId })).data;
  assert.deepEqual(projection.modelSettings, command.settings);
  assert.equal(projection.run, null);
  assert.equal(prepared.length, 0);
  for (const type of ['message.submit', 'context.focus']) {
    const reply = await send('submit', { command: { schemaVersion: 'deepcode.command.v3', type, commandId: `command:${type}`, sessionId, [type === 'message.submit' ? 'text' : 'task']: 'Inspect source.', reasoningEffortOverride: 'low' } });
    assert.equal(reply.ok, false);
    assert.match(JSON.stringify(reply.error), /fixture_prepare_boundary/);
  }
  assert.deepEqual(prepared.map((request) => [request.profileId, request.reasoningEffortOverride]), [['profile:wire', 'low'], ['profile:wire', 'low']]);
  assert.equal((await send('shutdown', {})).ok, true);
  await once(child, 'exit');
  assert.equal(child.exitCode, 0, stderr);
});

test('K2: reopening a run waiting for Plan confirmation restores its original effort rather than newer Session settings', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:plan-effort';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ reasoningEffort: 'high' });
  let turns = 0;
  const provider = { async *stream(request) {
    turns += 1;
    yield providerEvent(request.requestId, 'tool.call', {
      callId: 'provider-call:effort-plan', name: request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name,
      input: { title: 'Inspect project', summary: 'Read the relevant sources.', steps: [{ stepId: 'inspect', title: 'Inspect', details: 'Read relevant files.' }], mutationManifest: [] },
    });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'plan-effort');
  await actor.submit({ ...messageCommand(sessionId, 'command:plan-effort', 'Plan the inspection.', 'profile:one'), reasoningEffortOverride: 'max' });
  const waiting = await waitForProjection(actor, (value) => value.run?.status === 'waiting');
  assert.equal(waiting.run.reasoningEffort, 'max');
  await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'session.model-settings.set', sessionId, commandId: 'command:change-waiting', settings: { profileId: 'profile:one', reasoningEffortOverride: 'low' } });
  await actor.dispose();
  const reopened = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'plan-effort-reopened');
  await reopened.recover();
  const restored = await reopened.snapshot();
  assert.equal(restored.run.runId, waiting.run.runId);
  assert.equal(restored.run.status, 'waiting');
  assert.equal(restored.run.reasoningEffort, 'max');
  assert.equal(restored.modelSettings.reasoningEffortOverride, 'low');
  assert.equal(restored.pendingPlan.planId, waiting.pendingPlan.planId);
  assert.equal(turns, 1);
  assert.deepEqual(preparation.prepared.map((request) => request.reasoningEffortOverride), ['max', 'max']);
  await reopened.dispose();
});

test('K3: GUI model settings save after acknowledgement, reset effort on model change, and retain the last saved value on failure', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:gui-settings';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, { async *stream() { throw new Error('settings must not call Provider'); } }, emptyKernel(), fakeRunPreparation().port, 'gui-settings');
  let commands = 0;
  let failSave = false;
  const store = loadGuiModelStore({
    async submitLocalAgentCommand(command) {
      commands += 1;
      if (failSave) throw new Error('fixture_settings_save_failed');
      return await actor.submit(command);
    },
    async getLocalAgentProjection() { return await actor.snapshot(); },
  });
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
  await actor.dispose();
});

test('K4: starting a draft during initialization preserves navigation and still loads usable model configuration', async () => {
  let releaseCatalog;
  const catalogReady = new Promise((resolve) => { releaseCatalog = resolve; });
  const catalog = { projects: [{ id: 'project:boot', title: 'Project' }], sessions: [] };
  const pluginCatalog = { revision: 'plugin-catalog:boot', plugins: [] };
  const profile = { id: 'profile:boot', name: 'My model', model: 'configured-model', enabled: true, thinking: 'enabled' };
  const store = loadGuiModelStore({
    async getConversationCatalog() { return await catalogReady; },
    async getPluginCatalog() { return pluginCatalog; },
    async getLocalAgentProjection() { throw new Error('new draft must not restore a Session'); },
  }, {
    async getLlmProfiles() { return { ok: true, data: { profiles: [profile], defaultProfileId: profile.id } }; },
  });
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

function actorWith(
  journal,
  sessionId,
  provider,
  kernel,
  runPreparation,
  idPrefix,
  onDispose = () => {},
) {
  return new SessionActor(
    sessionId,
    journal,
    {
      contextProviders: [],
      provider,
      memory: { id: 'memory.complete', select: ({ messages }) => messages },
      observers: [],
      kernel,
      runPreparation,
      async dispose() { onDispose(); },
    },
    { nextId: idFactory(idPrefix) },
  );
}

function fakeRunPreparation(options = {}) {
  const prepared = [];
  const released = [];
  const snapshots = [];
  return {
    prepared,
    released,
    snapshots,
    port: {
      async prepare(request) {
        prepared.push(structuredClone(request));
        const snapshot = runtimeSnapshot(request.runId, {
          profileId: request.profileId ?? options.profileId ?? 'profile:default',
          contextWindowTokens: options.contextWindowTokens,
          maxOutputTokens: options.maxOutputTokens,
          apiSurface: options.apiSurface,
          hostedWebSearch: options.hostedWebSearch,
          webSearch: options.webSearch,
          tools: options.tools,
          toolPromptContributions: options.toolPromptContributions,
          reasoningEffort: request.reasoningEffortOverride ?? options.reasoningEffort,
          reasoningEffortOverride: request.reasoningEffortOverride,
        });
        snapshots.push(structuredClone(snapshot));
        return { runtimeSnapshot: snapshot };
      },
      async release(request) {
        released.push(structuredClone(request));
        return {
          kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
          alreadyReleased: false,
        };
      },
    },
  };
}

function runtimeSnapshot(runId, options = {}) {
  const tools = (options.tools ?? []).map((tool) => structuredClone(tool));
  const provider = {
    providerRuntimeRef: 'provider-runtime:g1',
    profileId: options.profileId ?? 'profile:default',
    contextWindowTokens: options.contextWindowTokens ?? 4_096,
    maxOutputTokens: options.maxOutputTokens ?? 512,
    apiSurface: options.apiSurface ?? 'chatCompletions',
    hostedWebSearch: options.hostedWebSearch ?? 'none',
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.reasoningEffortOverride ? { reasoningEffortOverride: options.reasoningEffortOverride } : {}),
  };
  const webSearch = options.webSearch ?? (
    tools.some((tool) => tool.name === 'web.search' && tool.availability === 'callable')
      ? { owner: 'kernelAdapter', toolName: 'web.search' }
      : { owner: 'unavailable' }
  );
  const providerToolAliases = [
    ...tools.filter((tool) => tool.availability === 'callable').map((tool) => tool.name),
    ...sessionControlToolDefinitions().map((tool) => tool.name),
  ]
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((canonicalName) => ({
      canonicalName,
      wireName: canonicalName.replace(/[.-]/gu, '_'),
    }));
  return {
    runRuntimeSnapshotRef: `runtime-snapshot:${runId}`,
    extensionGenerationRef: 'extension-generation:g1',
    kernelCatalogSnapshotRef: `kernel-catalog:${runId}`,
    provider,
    webSearch,
    instructions: [{ id: 'deepcode.coding-agent', text: 'Stable core instruction.' }],
    tools,
    toolPromptContributions: (options.toolPromptContributions ?? [])
      .map((contribution) => structuredClone(contribution)),
    providerToolAliases,
    selectedPlugins: {
      catalogRevision: 'plugin-catalog:fixture',
      plugins: [],
    },
  };
}

function emptyKernel(overrides = {}) {
  return {
    async prepareCatalog() { throw new Error('unexpected_prepare_catalog'); },
    async releaseCatalog() { throw new Error('unexpected_release_catalog'); },
    async execute() { throw new Error('unexpected_tool_execution'); },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
    ...overrides,
  };
}

function completedExecutionReply(request, output) {
  return {
    schemaVersion: 'deepcode.kernel-reply',
    type: 'tool.execution',
    requestId: request.requestId,
    callId: request.callId,
    status: 'completed',
    record: {
      recordId: `record:${request.callId}`,
      sessionId: request.sessionId,
      runId: request.runId,
      extensionGenerationRef: request.extensionGenerationRef,
      kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
      toolBindingRef: request.toolBindingRef,
      callId: request.callId,
      attemptId: request.attemptId,
      toolName: request.toolName,
      input: structuredClone(request.input),
      preparedEffect: {
        callId: request.callId,
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        runId: request.runId,
        extensionGenerationRef: request.extensionGenerationRef,
        kernelCatalogSnapshotRef: request.kernelCatalogSnapshotRef,
        toolBindingRef: request.toolBindingRef,
        contributionRef: 'contribution:fixture',
        providerRef: 'provider:fixture',
        origin: 'coreBuiltin',
        toolName: request.toolName,
        workspaceId: request.input.workspaceId,
        operation: request.toolName,
        logicalTargets: [request.input.path],
        canonicalInvocation: {
          toolName: request.toolName,
          arguments: structuredClone(request.input),
        },
      },
      authority: request.planAuthorities?.length
        ? {
            decision: 'allow',
            source: 'plan',
            workspaceId: request.input.workspaceId,
            authorityId: request.planAuthorities[0].authorityId,
            planId: request.planAuthorities[0].planId,
            revision: request.planAuthorities[0].revision,
            decisionId: request.planAuthorities[0].decisionId,
          }
        : {
            decision: 'allow',
            source: 'workspaceBinding',
            workspaceId: request.input.workspaceId,
          },
      startedAt: '2026-08-30T00:00:00.000Z',
      completedAt: '2026-08-30T00:00:01.000Z',
      outcome: 'completed',
      output,
    },
  };
}

function failedExecutionReply(request, output, error) {
  const reply = completedExecutionReply(request, output);
  reply.status = 'failed';
  reply.record.outcome = 'failed';
  reply.record.error = structuredClone(error);
  return reply;
}

function indeterminateExecutionRecord(request) {
  const record = completedExecutionReply(request, {}).record;
  delete record.output;
  record.outcome = 'indeterminate';
  record.error = {
    code: 'tool_effect_outcome_unknown',
    message: 'Fixture execution crossed the effect boundary before cancellation.',
  };
  return record;
}

function cancelNotFound(callId, attemptId) {
  return {
    schemaVersion: 'deepcode.kernel-reply',
    type: 'tool.cancelled',
    requestId: 'kernel-cancel:fixture',
    callId,
    attemptId,
    status: 'notFound',
  };
}

function* planProgressEvents(request, status = 'completed', native = false) {
  const tool = request.tools.find((candidate) => candidate.inputSchema?.properties?.sourceFactRef);
  const payloads = request.messages.map(jsonMessagePayload);
  const todo = payloads.findLast((payload) => payload?.type === 'todo.current');
  const record = payloads.findLast((payload) => payload?.recordId);
  assert.ok(tool && todo && record, 'progress requires the control, current Todo and real tool result');
  const callId = `provider-call:progress:${request.requestId}`;
  const input = { sourceFactRef: record.recordId, updates: todo.items.map((item) => ({ todoId: item.todoId, status })) };
  yield native
    ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0,
      item: { type: 'function_call', call_id: callId, name: tool.name, arguments: JSON.stringify(input), status: 'completed' } })
    : providerEvent(request.requestId, 'tool.call', { callId, name: tool.name, input });
  yield providerEvent(request.requestId, 'completed', {});
}

function providerEvent(requestId, type, data) {
  return {
    schemaVersion: 'deepcode.provider-event',
    requestId,
    type,
    data,
  };
}

function messageCommand(sessionId, commandId, text, profileId) {
  return {
    schemaVersion: 'deepcode.command.v3',
    type: 'message.submit',
    commandId,
    sessionId,
    text,
    ...(profileId ? { profileId } : {}),
  };
}

function jsonMessagePayload(message) {
  if (typeof message.content !== 'string') return null;
  try {
    return JSON.parse(message.content);
  } catch {
    return null;
  }
}

function forwardingJournal(delegate, read) {
  return {
    createSession: (input) => delegate.createSession(input),
    deleteSession: (sessionId) => delegate.deleteSession(sessionId),
    append: (event) => delegate.append(event),
    appendBatch: (events) => delegate.appendBatch(events),
    read,
    readCommand: (sessionId, commandId) => delegate.readCommand(sessionId, commandId),
    commitCommand: (command, events, reply) => delegate.commitCommand(command, events, reply),
  };
}

async function createSession(journal, sessionId, workspaceBindings = []) {
  await journal.createSession({
    sessionId,
    displayTitle: 'Fixture session',
    workspaceBindings,
  });
}

async function readEvents(journal, sessionId) {
  const events = [];
  for await (const event of journal.read(sessionId)) events.push(event);
  return events;
}

function singleEvent(events, type) {
  const matches = events.filter((event) => event.type === type);
  assert.equal(matches.length, 1, `expected exactly one ${type} event`);
  return matches[0];
}

function assertEventOrder(...events) {
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(
      events[index - 1].sequence < events[index].sequence,
      `${events[index - 1].type} must precede ${events[index].type}`,
    );
  }
}

function assertSuccessfulCompactionOrder(events, request, expectedSummary) {
  const composition = events.find((event) => (
    event.type === 'context.composed'
    && event.payload.providerRequestId === request.payload.providerRequestId
  ));
  const completion = events.find((event) => (
    event.type === 'provider.turn.settled'
    && event.payload.providerRequestId === request.payload.providerRequestId
  ));
  const checkpoint = events.find((event) => (
    event.type === 'context.compacted'
    && event.payload.compactionId === request.payload.compactionId
  ));
  assert.ok(composition, 'compaction composition must be durable');
  assert.ok(completion, 'successful summary Provider turn must be durable');
  assert.ok(checkpoint, 'successful summary must create a checkpoint');
  assert.equal(completion.payload.purpose, 'contextCompaction');
  assert.deepEqual(completion.payload.orderedCallIds, []);
  assert.equal(checkpoint.payload.summary, expectedSummary);
  assertEventOrder(request, composition, completion, checkpoint);
}

function idFactory(prefix) {
  let next = 0;
  return (kind) => `${prefix}:${kind}:${++next}`;
}

async function waitForProjection(actor, predicate) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const projection = await actor.snapshot();
    if (predicate(projection)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for Session projection: ${JSON.stringify(await actor.snapshot())}`);
}

async function waitUntil(predicate, label) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function waitForAbort(signal) {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
}
