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
  SessionService,
  loopSnapshot,
  runtimeInstructions,
  sessionControlToolDefinitions,
} from '../dist/index.js';
import { messagesFromJournal } from '../dist/local-agent/contextComposer.js';
import { decodeSessionControlCall } from '../dist/local-agent/sessionControls.js';
import { HttpProviderPort } from '../dist/local-agent/httpPorts.js';
import { responseFrames } from '../dist/responseFrames.js';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import {
  workspaceBinding,
  actorWith,
  fakeRunPreparation,
  runtimeSnapshot,
  emptyKernel,
  completedExecutionReply,
  failedExecutionReply,
  indeterminateExecutionRecord,
  planProgressEvents,
  providerEvent,
  messageCommand,
  jsonMessagePayload,
  forwardingJournal,
  createSession,
  readEvents,
  singleEvent,
  assertEventOrder,
  assertSuccessfulCompactionOrder,
  waitForProjection,
  waitUntil,
  waitForAbort,
} from './local-agent-fixtures.mjs';

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

test('message uses one prepared runtime through composition, completion, cache projection, settlement, and release', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:answer-chain';
  await createSession(journal, sessionId, [workspaceBinding]);

  const preparation = fakeRunPreparation({
    contextWindowTokens: 16_000,
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
          contextWindowTokens: 16_000,
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

test('run binding exposes hosted search once and replays its Provider item unchanged', async () => {
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
    tools: [{
      name: 'web.search', toolBindingRef: 'tool-binding:search:blocked',
      description: 'Local search adapter.', inputSchema: { type: 'object' },
      possibleEffects: ['network'], availability: 'blocked', origin: 'coreBuiltin',
    }, {
      name: 'web.fetch', toolBindingRef: 'tool-binding:fetch:g1',
      description: 'Read a known URL.', inputSchema: { type: 'object' },
      possibleEffects: ['network'], availability: 'callable', origin: 'coreBuiltin',
    }],
    toolPromptContributions: [{
      contributionRef: 'tool-prompt-contribution:fetch',
      canonicalToolName: 'web.fetch', preparedToolBindingRef: 'tool-binding:fetch:g1',
      origin: 'coreBuiltin', promptSnippet: 'Read a known URL.',
      usageGuidelines: ['Read URLs supplied by the user or earlier results.'],
    }],
  });
  const providerRequests = [];
  const provider = {
    async *stream(request) {
      providerRequests.push(structuredClone(request));
      assert.deepEqual(request.hostedTools, [{
        type: 'webSearch',
        providerToolType: 'web_search',
      }]);
      assert.equal(request.tools.some((tool) => tool.name === 'web_search'), false);
      assert.ok(request.tools.some((tool) => tool.name === 'web_fetch'));
      const searchGuidance = request.messages.filter((message) => (
        message.role === 'system' && message.content.startsWith('Active tool guidance:')
      ));
      assert.equal(searchGuidance.length, 1);
      assert.match(searchGuidance[0].content, /web_search: Search by keyword/u);
      assert.match(searchGuidance[0].content, /fetch reads known URLs/u);
      assert.match(searchGuidance[0].content, /Cite sources and report search errors/u);
      assert.match(searchGuidance[0].content, /web_fetch: Read a known URL/u);
      assert.equal(searchGuidance[0].content.match(/^- web_search:/gmu)?.length, 1);
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
  const systemPrefix = (request) => request.messages.slice(
    0, request.messages.findIndex((message) => message.role === 'user'),
  );
  assert.deepEqual(systemPrefix(providerRequests[1]), systemPrefix(providerRequests[0]));
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
  assert.equal(compositions[0].payload.tools.filter((tool) => tool.canonicalName === 'web.search').length, 1);
  assert.equal(compositions[0].payload.messages.filter((message) => (
    message.contributionId === 'instruction:deepcode.tool-guidance'
  )).length, 1);
  assert.ok(compositions[1].payload.messages.some((message) => (
    message.blocks.some((block) => (
      block.kind === 'hostedWebSearch' && block.providerCallId === hostedItems[0].id
    ))
  )));

  await actor.dispose();
});

test('Responses output items preserve narrative, hosted activity, and final-message order', async () => {
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
    value.assistantDraft?.blocks?.at(-1)?.outputIndex === nativeItems.length - 1
    && value.assistantDraft.blocks.at(-1)?.kind === 'message'
  ));
  assert.equal(
    finalStreamingProjection.assistantDraft.blocks.at(-1).content,
    nativeItems.at(-1).content[0].text,
  );
  completeFinalItem();
  const streamingProjection = await waitForProjection(actor, (value) => (
    value.assistantDraft?.blocks?.length === nativeItems.length
    && value.assistantDraft.blocks.at(-1)?.kind === 'finalMessage'
  ));
  assert.equal(streamingProjection.assistantDraft.content, undefined);
  assert.equal(streamingProjection.assistantDraft.reasoningContent, undefined);
  assert.deepEqual(
    streamingProjection.assistantDraft.blocks.map((block) => block.kind),
    ['narrative', 'providerHosted', 'narrative', 'providerHosted', 'finalMessage'],
  );
  assert.deepEqual(
    streamingProjection.assistantDraft.blocks.map((block) => block.outputIndex),
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
    firstProjection.timeline.flatMap((item) => (
      item.kind === 'narrative' && narrativeIds.has(item.narrativeId)
        || item.kind === 'message' && item.messageId === finalMessageId
        ? [item.streamId]
        : []
    )),
    streamingProjection.assistantDraft.blocks.flatMap((block) => {
      if (block.kind === 'providerHosted') return [];
      assert.equal(typeof block.streamId, 'string');
      assert.ok(block.streamId.length > 0);
      return [block.streamId];
    }),
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

test('native function_call identity survives settlement, execution, and replay', async () => {
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

test('filesystem references reach Provider as logical metadata without embedded file content', async () => {
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

test('the current RunRuntimeSnapshot contract rejects missing Provider aliases explicitly', async () => {
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

test('the current RunRuntimeSnapshot contract rejects missing tool prompt contributions explicitly', async () => {
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

test('tool prompt preparation binds exact callable tools and rejects invalid ownership', () => {
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
  }], [readTool, bashTool], []);
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
    [],
  );
  assert.ok(collidingGuidance);
  const collidingLines = new Set(collidingGuidance.split('\n'));
  for (const [index, tool] of collidingTools.entries()) {
    const wireName = collidingAliases.find((alias) => alias.canonicalName === tool.name)?.wireName;
    assert.ok(wireName);
    assert.ok(collidingLines.has(`- ${wireName}: Route ${index}.`));
  }
});

test('Session renders one run-scoped tool guidance message with Provider aliases', async () => {
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
  assert.deepEqual(requests[0].hostedTools, []);
  assert.doesNotMatch(guidanceMessages[0].content, /API's native search tool/u);
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

test('read-only bash result projects its real write scope and continues the Loop', async () => {
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

test('a run without workspace bindings never exposes workspace-scoped tools', async () => {
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
  const preparation = fakeRunPreparation({
    tools,
    toolPromptContributions: tools.filter((tool) => tool.origin === 'coreBuiltin').map((tool) => ({
      contributionRef: `tool-prompt-contribution:${tool.name}`,
      canonicalToolName: tool.name,
      preparedToolBindingRef: tool.toolBindingRef,
      origin: tool.origin,
      promptSnippet: tool.description,
      usageGuidelines: [],
    })),
  });
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
  const guidance = capturedRequest.messages.find((message) => (
    message.role === 'system' && message.content.startsWith('Active tool guidance:')
  ));
  assert.ok(guidance);
  assert.match(guidance.content, /web_search: Search a non-workspace source/u);
  assert.doesNotMatch(guidance.content, /fs_read:|bash:|API's native search tool/u);
  assert.deepEqual(capturedRequest.hostedTools, []);
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

test('explicit /focus and same-runtime pressure compact only after a successful summary turn', async () => {
  await verifyExplicitFocusCompaction();
  await verifyPressureCompaction();
});

test('cancel and service disposal close their owned runtime boundaries in order', async () => {
  await verifyWaitingCancelRelease();
  await verifyComposedDisposeRelease();
  await verifyExecutingToolDisposeCleanup();
});

test('deletion remains available while an unloadable actor rolls back cleanly', async () => {
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

test('an escaped Loop fault remains Session-local and releases its runtime', async () => {
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

test('one Plan confirmation resumes the same run into Todo-backed execution', async () => {
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
        assert.equal(request.responseConstraint, 'normal');
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

test('confirmed Host Bash uses composite authority and only a successful retry completes Todo', async () => {
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
  const preparation = fakeRunPreparation({ contextWindowTokens: 64_000, tools: [preparedTool] });
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
        assert.equal(request.responseConstraint, 'normal');
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
        assert.equal(request.responseConstraint, 'normal');
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

test('confirmed fs.delete reads targetKind from canonical arguments and completes Todo', async () => {
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
        assert.equal(request.responseConstraint, 'normal');
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

test('unfinished Plan preserves final explanation and pending Todo without reporting success', async () => {
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
      assert.equal(request.responseConstraint, 'normal');
      assert.ok(request.messages
        .map(jsonMessagePayload)
        .some((payload) => payload?.response?.kind === 'confirm'));
      assert.ok(request.messages
        .map(jsonMessagePayload)
        .some((payload) => payload?.type === 'todo.current'));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'provider-message:invalid-execution-answer',
        content: 'Execution is blocked. The confirmed work has not been completed.',
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
  assert.equal(failed.terminalError.code, 'plan_incomplete');

  const events = await readEvents(journal, sessionId);
  const confirmed = singleEvent(events, 'plan.confirmed');
  const seeded = singleEvent(events, 'todo.seeded');
  const completions = events.filter((event) => event.type === 'provider.turn.settled');
  const settlement = singleEvent(events, 'run.settled');
  assert.equal(completions.length, 2);
  assert.equal(settlement.payload.outcome, 'failed');
  assert.equal(settlement.payload.error.code, 'plan_incomplete');
  const finalMessage = events.find((event) => event.type === 'message.committed' && event.payload.role === 'assistant');
  assert.equal(finalMessage?.payload.content, 'Execution is blocked. The confirmed work has not been completed.');
  assert.equal(events.some((event) => event.type === 'plan.completed'), false);
  assert.equal(events.some((event) => event.type === 'tool.requested'), false);
  assertEventOrder(confirmed, seeded, completions[1], finalMessage, singleEvent(events, 'run.finishing'), singleEvent(events, 'run.runtime.released'), settlement);

  await actor.dispose();
});

test('execution-time Plan revisions retain Todo identity and rejected progress cannot consume final output', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:plan-revision-progress';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ contextWindowTokens: 100_000, tools: [{
    toolBindingRef: 'tool-binding:write:g1', name: 'fs.write', description: 'Write an approved file.',
    inputSchema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
    possibleEffects: ['workspaceMutation'], availability: 'callable', origin: 'coreBuiltin',
  }] });
  const initial = {
    title: 'Implement and verify', summary: 'Complete the approved work.',
    steps: [
      { stepId: 'implement', title: 'Implement', details: 'Write the implementation.' },
      { stepId: 'verify', title: 'Verify', details: 'Check the result.' },
    ],
    mutationManifest: [{ workspace: 'primary', operation: 'fs.write', target: 'README.md' }],
  };
  const cleanup = { stepId: 'cleanup', title: 'Clean up', details: 'Ignore generated files.' };
  const revised = {
    ...initial, title: 'Implement, verify and clean up',
    steps: [initial.steps[0], { ...initial.steps[1], details: 'Check the result and generated files.' }, cleanup],
    mutationManifest: [...initial.mutationManifest, { workspace: 'primary', operation: 'fs.write', target: '.gitignore' }],
  };
  const requests = [];
  const executions = [];
  let originalTodo;
  const kernel = emptyKernel({ async execute(request) {
    executions.push(structuredClone(request));
    const authority = request.planAuthorities[0];
    assert.equal(authority.revision, executions.length);
    assert.deepEqual(authority.coveredOperations.map((operation) => operation.target), executions.length === 1 ? ['README.md'] : ['README.md', '.gitignore']);
    return completedExecutionReply(request, { written: true });
  } });
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    const turn = requests.length;
    assert.ok(turn <= 10);
    if (turn > 1) {
      const previous = requests.at(-2);
      assert.deepEqual(request.tools, previous.tools, 'Plan phases preserve tool definitions and ordering');
      assert.deepEqual(request.messages.slice(0, previous.messages.length), previous.messages, 'Plan phases append facts without rewriting the cached prefix');
    }
    assert.equal(request.responseConstraint, 'normal');
    const payloads = request.messages.map(jsonMessagePayload);
    const todo = payloads.findLast((payload) => payload?.type === 'todo.current');
    const record = payloads.find((payload) => payload?.recordId);
    const planTool = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest);
    const progressTool = request.tools.find((tool) => tool.inputSchema.properties?.sourceFactRef);
    const writeTool = request.tools.find((tool) => tool.inputSchema.properties?.content);
    let name, input;
    if (turn === 1) { name = planTool.name; input = initial; }
    else if (turn === 2) {
      originalTodo = structuredClone(todo);
      name = writeTool.name; input = { workspace: 'primary', path: 'README.md', content: 'Implemented.' };
    } else if (turn === 3) {
      name = progressTool.name; input = { sourceFactRef: record.recordId, updates: todo.items.map((item, index) => ({ todoId: item.todoId, status: index === 0 ? 'completed' : 'inProgress' })) };
    } else if (turn === 4) {
      name = planTool.name; input = { ...revised, steps: [cleanup] };
    } else if (turn === 5) {
      const error = payloads.findLast((payload) => payload?.accepted === false).error;
      assert.equal(error.code, 'plan_revision_steps_missing');
      assert.match(error.message, /implement.*verify/);
      name = planTool.name; input = revised;
    } else if (turn === 6) {
      assert.equal(todo.sourcePlanId, originalTodo.sourcePlanId);
      assert.equal(todo.sourcePlanRevision, 2);
      assert.deepEqual(todo.items.slice(0, 2).map((item) => item.todoId), originalTodo.items.map((item) => item.todoId));
      assert.deepEqual(todo.items.map((item) => item.status), ['completed', 'pending', 'pending']);
      name = writeTool.name; input = { workspace: 'primary', path: '.gitignore', content: 'core\n' };
    } else if (turn === 7) {
      name = progressTool.name; input = { sourceFactRef: record.recordId, updates: [
        { todoId: todo.items[2].todoId, status: 'completed' }, { todoId: 'todo:unknown', status: 'completed' },
      ] };
    } else if (turn === 8) {
      const error = payloads.findLast((payload) => payload?.accepted === false).error;
      assert.equal(error.code, 'plan_progress_todo_unknown');
      assert.ok(error.message.includes(todo.items[2].todoId));
      assert.equal(todo.items[2].status, 'pending', 'invalid progress applies no partial update');
      name = progressTool.name; input = { sourceFactRef: record.recordId, updates: todo.items.map((item) => ({ todoId: item.todoId, status: 'completed' })) };
    } else if (turn === 9) {
      assert.ok(payloads.some((payload) => payload?.type === 'plan.completed' && payload.revision === 2));
      name = progressTool.name; input = { sourceFactRef: record.recordId, updates: [{ todoId: originalTodo.items[0].todoId, status: 'completed' }] };
    } else {
      assert.equal(payloads.findLast((payload) => payload?.accepted === false).error.code, 'plan_progress_not_active');
      yield providerEvent(request.requestId, 'assistant.message', { messageId: 'message:revision-finished', content: 'The revised work and cleanup are complete.' });
      yield providerEvent(request.requestId, 'completed', {});
      return;
    }
    yield providerEvent(request.requestId, 'tool.call', { callId: `provider-call:revision-${turn}`, name, input });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, 'revision');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:revision-start', 'Implement and verify.'));
  let waiting = await waitForProjection(actor, (value) => value.pendingPlan?.revision === 1);
  const firstId = waiting.pendingPlan.planId;
  for (const revision of [1, 2]) {
    if (revision === 2) {
      waiting = await waitForProjection(actor, (value) => value.pendingPlan?.revision === 2);
      assert.equal(waiting.pendingPlan.planId, firstId);
      assert.equal(waiting.todoList.items.length, 2, 'the proposed revision cannot replace Todo before confirmation');
      assert.equal(executions.length, 1, 'new scope must wait for user confirmation');
    }
    await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'plan.respond', commandId: `command:revision-confirm-${revision}`, sessionId,
      runId: waiting.run.runId, planId: firstId, revision, response: { kind: 'confirm' } });
  }
  const completed = await waitForProjection(actor, (value) => value.run?.status === 'completed');
  assert.deepEqual(completed.plans.map((plan) => plan.status), ['superseded', 'completed']);
  assert.ok(completed.todoList.items.every((item) => item.status === 'completed'));
  assert.equal(requests.length, 10);
  assert.equal(executions.length, 2);
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'todo.seeded').length, 1);
  assert.equal(events.filter((event) => event.type === 'todo.reconciled').length, 1);
  assert.deepEqual(events.filter((event) => event.type === 'session.control.rejected').map((event) => event.payload.error.code),
    ['plan_revision_steps_missing', 'plan_progress_todo_unknown', 'plan_progress_not_active']);
  const final = events.find((event) => event.type === 'message.committed' && event.payload.role === 'assistant');
  assertEventOrder(singleEvent(events, 'plan.completed'), final, singleEvent(events, 'run.finishing'), singleEvent(events, 'run.runtime.released'), singleEvent(events, 'run.settled'));
  assert.equal(preparation.released.length, 1);
});

test('built-in runtime and control prompts stay concise and policy-scoped', () => {
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

test('plan rejection names the invalid manifest field and preserves the Provider prefix for correction', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:plan-field-diagnostic';
  await createSession(journal, sessionId, [workspaceBinding]);
  const input = {
    title: 'Create the project', summary: 'Write sources and build script.',
    steps: [{ stepId: 'write', title: 'Write files', details: 'Create the source files and build script.' }],
    mutationManifest: ['include/pool.hpp', 'src/main.cpp', 'build.sh', 'run.sh'].map((target) => ({
      workspace: 'primary', operation: 'fs.write', target,
    })),
  };
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    assert.ok(requests.length <= 2);
    const plan = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest);
    const candidate = structuredClone(input);
    if (requests.length === 1) {
      candidate.mutationManifest[2].executable = true;
      candidate.mutationManifest[3].executable = true;
    }
    else {
      const rejection = request.messages.map(jsonMessagePayload).find((value) => value?.accepted === false);
      assert.equal(rejection.executed, false);
      assert.equal(rejection.error.code, 'session_control_shape_invalid');
      assert.match(rejection.error.message, /mutationManifest\[2\].*不支持字段 executable/u);
      assert.match(rejection.error.message, /mutationManifest\[3\].*不支持字段 executable/u);
      assert.match(rejection.error.message, /允许字段：workspace, operation, target/u);
      assert.deepEqual(request.tools, requests[0].tools, 'correction must not change the cached tool definitions');
      assert.deepEqual(request.messages.slice(0, requests[0].messages.length), requests[0].messages);
    }
    yield providerEvent(request.requestId, 'tool.call', { callId: `call:plan-${requests.length}`, name: plan.name, input: candidate });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), fakeRunPreparation().port, 'plan-field-diagnostic');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:plan-field', 'Prepare the project.'));
  const waiting = await waitForProjection(actor, (value) => value.run?.status === 'waiting' && value.pendingPlan !== null);
  assert.equal(waiting.pendingPlan.mutationManifest.length, 4);
  assert.equal(waiting.activePlanRef, null, 'valid publication still requires user confirmation');
  const events = await readEvents(journal, sessionId);
  const rejected = singleEvent(events, 'session.control.rejected');
  assert.equal(rejected.payload.input.mutationManifest[2].executable, true, 'keep the original invalid input in the journal');
  assert.equal(events.filter((event) => event.type === 'plan.published').length, 1);
  assert.equal(events.some((event) => event.type === 'tool.requested' || event.type === 'plan.confirmed'), false);
});

test('an explicit Provider failure remains failed with its original error', async () => {
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

test('Provider cache fields are absent together or exactly partition one call input', async () => {
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

test('current Todo state precedes later inserted user input without splitting its tool result', () => {
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

test('an interaction response is inserted after its tool result and a stale second response is durable', async () => {
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
  const answer = completed.messages.find((message) => message.content === 'Use option A.');
  assert.deepEqual(answer.replyToInteraction, { interactionId: interaction.interactionId, prompt: 'Which fixture option?' });
  assert.deepEqual(loopSnapshot(sessionId, events).state.messages.find((message) => message.messageId === answer.messageId).replyToInteraction,
    answer.replyToInteraction, 'journal replay preserves the exact question without GUI caching or inference');
  assert.equal(events.filter((event) => (
    event.type === 'message.committed' && event.payload.role === 'user'
  )).length, 2);
  await actor.dispose();
});

test('Plan title schema advertises the same single-line boundary enforced during publication', () => {
  const schema = sessionControlToolDefinitions().find((tool) => tool.name === 'plan.publish').inputSchema;
  const pattern = new RegExp(schema.properties.title.pattern, 'u');
  const input = { title: '保留 `Dockerfile`、`Makefile`', summary: '说明',
    steps: [{ stepId: 'inspect', title: '检查工作区', details: '读取目录' }], mutationManifest: [] };
  assert.ok(pattern.test(input.title));
  assert.equal(decodeSessionControlCall('call:title', 'plan.publish', input).draft.title, input.title);
  for (const title of ['计划\n\n', '计划\n第二行', ' 计划', '计划 ', '\u0000']) {
    assert.equal(pattern.test(title), false, 'the advertised schema must reject the actual failing input');
    assert.throws(() => decodeSessionControlCall('call:title', 'plan.publish', { ...input, title }),
      (error) => error.code === 'session_control_display_text_invalid' && /单行/.test(error.message));
  }
  assert.equal(schema.properties.steps.items.properties.title.pattern, schema.properties.title.pattern);
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

test('missing completion stays indeterminate; a completed unknown alias fails without correction or execution', async () => {
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

test('Kernel infrastructure errors remain run failures rather than correctable input results', async () => {
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

test('the real Session bridge persists model commands and passes effort through message and focus preparation', { timeout: 15_000 }, async (t) => {
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

test('reopening a run waiting for Plan confirmation restores its original effort rather than newer Session settings', async () => {
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


test('first request reserves output budget before calling a Provider and preserves original input', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:first-budget';
  await createSession(journal, sessionId, [workspaceBinding]);
  let calls = 0;
  const provider = { async *stream() { calls += 1; throw new Error('must not call Provider'); } };
  const preparation = fakeRunPreparation({ contextWindowTokens: 100, maxOutputTokens: 30 });
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'first-budget');
  const original = 'Full original input '.repeat(500);
  await actor.submit(messageCommand(sessionId, 'command:first-budget', original));
  const projection = await waitForProjection(actor, (projection) => projection.run?.status === 'failed');
  assert.equal(calls, 0);
  assert.equal(projection.terminalError.code, 'context_input_budget_exceeded');
  assert.equal(projection.messages[0].content, original);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'context.compacted'), false);
  await actor.dispose();
});

test('new file inputs preserve the existing Provider prefix and keep historical files readable', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:input-cache';
  await createSession(journal, sessionId, [workspaceBinding]);
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(structuredClone(request));
    yield providerEvent(request.requestId, 'assistant.message', { messageId: `message:cache-${requests.length}`, content: 'Read the referenced input.' });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const preparation = fakeRunPreparation({ contextWindowTokens: 64000 });
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, 'input-cache');
  for (let index = 0; index < 3; index += 1) {
    const command = messageCommand(sessionId, `command:cache-${index}`, `Original input ${index}`);
    if (index < 2) command.filesystemReferences = [{ referenceId: `reference:${index}`, workspaceId: `file-workspace:${index}`,
      logicalPath: 'user-input.txt', displayName: 'user-input.txt', kind: 'file', mediaType: 'text/plain', byteLength: 100000 }];
    await actor.submit(command);
    await waitForProjection(actor, (projection) => projection.run?.status === 'completed');
  }
  for (let index = 1; index < requests.length; index += 1) {
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
  }
  assert.deepEqual(requests[2].workspaceBindings.map((binding) => binding.workspaceId), ['workspace:test', 'file-workspace:0', 'file-workspace:1']);
  await actor.dispose();
});

test('reasoning display bounds real text and summary independently without changing replay data', async () => {
  const { LiveReasoning, reasoningReadItem } = await import('../dist/local-agent/reasoningRead.js');
  const live = new LiveReasoning();
  live.append('request:one', 'run:one', '中文🙂'.repeat(5000), 'text');
  live.append('request:one', 'run:one', 'Native summary.', 'summary');
  const window = live.read('request:one');
  assert.equal(window.truncated, true);
  assert.deepEqual(window.parts.map((part) => part.kind), ['text', 'summary']);
  assert.ok(window.parts.reduce((total, part) => total + part.content.length, 0) <= 8192);
  const event = { sequence: 10, runId: 'run:one', payload: { outcome: 'completed', providerRequestId: 'request:one',
    reasoningContent: 'x'.repeat(20000), orderedOutputBlocks: [{ kind: 'reasoning', item: { summary: [{ type: 'summary_text', text: 'Native summary.' }] } }] } };
  const page = reasoningReadItem(event, 0);
  assert.equal(page.nextOffset, 8192);
  assert.equal(page.parts[0].kind, 'summary');
  assert.equal(reasoningReadItem(event, null).parts, undefined);
  assert.equal(event.payload.reasoningContent.length, 20000);
});

test('Kernel changes produce ordered round references while display evidence stays out of Provider context', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:change-round';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ apiSurface: 'responses', contextWindowTokens: 64000, tools: [{
    toolBindingRef: 'binding:write', name: 'fs.write', description: 'Write text.', origin: 'coreBuiltin',
    availability: 'callable', possibleEffects: ['workspaceMutation'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  }] });
  const changes = [{ workspaceId: workspaceBinding.workspaceId, path: 'sample.txt', kind: 'modify',
    before: { exists: true, contentRef: '/fixture/attempt/before' }, after: { exists: true, contentRef: '/fixture/attempt/after' } }];
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    const item = requests.length === 1
      ? { type: 'function_call', call_id: 'provider-call:change', name: request.tools.find((tool) => tool.inputSchema.properties?.path).name,
          arguments: JSON.stringify({ workspace: 'primary', path: 'sample.txt', content: 'new' }), status: 'completed' }
      : { type: 'message', id: 'provider-message:change', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Saved.' }] };
    yield providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item });
    yield providerEvent(request.requestId, 'completed', {});
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel({ execute: async (request) =>
    completedExecutionReply(request, { saved: true, fileChanges: changes }) }), preparation.port, 'changes');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:changes', 'Update the file.'));
  const projection = await waitForProjection(actor, (projection) => projection.run?.status === 'completed');
  const tool = projection.activities.find((activity) => activity.tool?.fileChanges?.length)?.tool;
  assert.ok(tool);
  assert.deepEqual(tool.fileChanges, changes);
  assert.deepEqual(projection.fileChangeRounds, [{ runId: projection.run.runId, recordIds: [tool.recordId] }]);
  const toolMessage = requests[1].messages.find((message) => message.role === 'tool');
  assert.ok(toolMessage);
  assert.equal(JSON.stringify(toolMessage).includes('fileChanges'), false);
  assert.equal(JSON.stringify(toolMessage).includes('/fixture/attempt/'), false);
  const event = (await readEvents(journal, sessionId)).find((event) => event.type === 'tool.completed');
  assert.deepEqual(event.payload.record.output.fileChanges, changes);
});

test('plan preview streams formed fields at the same revision and publishes only after complete validation', async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:streamed-plan';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const input = { title: 'Inspect the project', summary: 'Read the relevant source.', steps: [{ stepId: 'inspect', title: 'Read source', details: 'Inspect the source.' }], mutationManifest: [] };
  const serialized = JSON.stringify(input);
  const split = serialized.indexOf(',"steps"');
  const secondSplit = serialized.indexOf(',"details"');
  const releases = [];
  const gate = () => new Promise((resolve) => releases.push(resolve));
  const requests = [];
  const provider = { async *stream(request, signal) {
    requests.push(structuredClone(request));
    const name = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name;
    for (const fragment of [serialized.slice(0, split), serialized.slice(split, secondSplit), serialized.slice(secondSplit)]) {
      yield providerEvent(request.requestId, 'tool.call.delta', { callIndex: 0, callId: 'call:plan', name, argumentsDelta: fragment });
      await Promise.race([gate(), waitForAbort(signal)]);
      if (signal.aborted) return;
    }
    yield providerEvent(request.requestId, 'tool.call', { callId: 'call:plan', name, input });
    yield providerEvent(request.requestId, 'completed', { usage: { inputTokens: 100, outputTokens: 30, cacheReadInputTokens: 90, cacheMissInputTokens: 10, contextWindowTokens: 4096 } });
  } };
  const wireProvider = new HttpProviderPort({ apiBase: 'http://fixture', serviceToken: 'fixture', fetchImpl: async (_url, init) => {
    const request = JSON.parse(init.body);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      try {
        for await (const event of provider.stream(request, init.signal)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      } catch (error) { controller.error(error); }
    } }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const actor = actorWith(journal, sessionId, wireProvider, emptyKernel(), preparation.port, 'streamed-plan');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:preview', 'Plan an inspection.'));
  const first = await waitForProjection(actor, (p) => p.assistantDraft?.planPreview?.title === input.title);
  assert.equal(first.pendingPlan, null);
  assert.equal(first.plans.length, 0);
  assert.equal(first.activities.some((activity) => activity.kind === 'tool'), false);
  assert.equal(first.assistantDraft.planPreview.summary, input.summary);
  assert.equal((await readEvents(journal, sessionId)).some((event) => event.type === 'plan.published'), false);
  await waitUntil(() => releases.length === 1, 'first preview fragment'); releases.shift()();
  const second = await waitForProjection(actor, (p) => p.assistantDraft?.planPreview?.steps.length === 1);
  assert.equal(second.revision, first.revision);
  assert.deepEqual(second.assistantDraft.planPreview.steps, ['Read source']);
  assert.equal(second.pendingPlan, null);
  await waitUntil(() => releases.length === 1, 'second preview fragment'); releases.shift()();
  await waitUntil(() => releases.length === 1, 'complete preview fragment'); releases.shift()();
  const published = await waitForProjection(actor, (p) => p.run?.status === 'waiting' && p.pendingPlan !== null);
  assert.equal(published.assistantDraft, null);
  assert.equal(published.pendingPlan.title, input.title);
  assert.deepEqual(published.pendingPlan.steps, input.steps);
  assert.deepEqual(published.pendingPlan.mutationManifest, []);
  assert.equal(published.activePlanRef, null);
  assert.equal(published.contextUsage.cacheReadInputTokens, 90);
  assert.equal(requests.length, 1, 'preview never requests another model response');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.filter((event) => event.type === 'plan.published').length, 1);
  assert.equal(events.some((event) => event.type === 'plan.confirmed' || event.type === 'tool.requested'), false);
});

for (const outcome of ['failed', 'cancelled']) test(`an unfinished plan preview is cleared when its request is ${outcome}`, async (t) => {
  const journal = new InMemoryCommandJournal();
  const sessionId = `session:preview-${outcome}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = { async *stream(request, signal) {
    const name = request.tools.find((tool) => tool.inputSchema.properties?.mutationManifest).name;
    yield providerEvent(request.requestId, 'tool.call.delta', { callIndex: 0, callId: 'call:draft', name, argumentsDelta: '{"title":"Unfinished",' });
    await Promise.race([gate, waitForAbort(signal)]);
    if (signal.aborted) return;
    yield providerEvent(request.requestId, 'failed', { code: 'fixture_provider_failed', message: 'Provider failed during plan generation.' });
  } };
  const actor = actorWith(journal, sessionId, provider, emptyKernel(), preparation.port, `preview-${outcome}`);
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:begin', 'Plan this inspection.'));
  const streaming = await waitForProjection(actor, (p) => p.assistantDraft?.planPreview?.title === 'Unfinished');
  if (outcome === 'cancelled') await actor.submit({ schemaVersion: 'deepcode.command.v3', type: 'run.cancel', sessionId, runId: streaming.run.runId, commandId: 'command:cancel-preview' });
  else release();
  // An interrupted Provider with no terminal receipt keeps the existing unknown-outcome contract.
  const settled = await waitForProjection(actor, (p) => p.run?.status === (outcome === 'cancelled' ? 'indeterminate' : 'failed'));
  if (outcome === 'cancelled') assert.equal(settled.terminalError.code, 'provider_turn_outcome_unknown');
  else assert.equal(settled.terminalError.code, 'fixture_provider_failed');
  assert.equal(settled.assistantDraft, null);
  assert.equal(settled.pendingPlan, null);
  assert.equal(settled.plans.length, 0);
  assert.equal(preparation.released.length, 1);
});

test('plan preview reads complete JSON fields and keeps its display buffer bounded', async () => {
  const { PlanPreviewBuffer } = await import('../dist/local-agent/planPreview.js');
  const preview = new PlanPreviewBuffer('plan_publish');
  const delta = (argumentsDelta, name = 'plan_publish') => preview.append({ callIndex: 0, callId: 'call:prefix', name, argumentsDelta });
  assert.equal(delta('{"title":"Ignored"}', 'fs_read'), undefined);
  assert.equal(delta('{"title":"Escaped \\').title, '');
  assert.equal(delta('" quote", "steps":[{"title":"Step one",').title, 'Escaped " quote');
  assert.deepEqual(delta('"details":"pending').steps, ['Step one']);
  const bounded = delta('x'.repeat(100_000));
  assert.equal(bounded.truncated, true);
  assert.ok(JSON.stringify(bounded).length < 9000);
});
