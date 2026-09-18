import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { sessionControlToolDefinitions } from '../dist/index.js';
import {
  actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, waitUntil, workspaceBinding,
} from './local-agent-fixtures.mjs';

const discoveryTool = { toolBindingRef: 'binding:plugin-search', name: 'plugin.search', description: 'Discover plugins.',
  inputSchema: { type: 'object', properties: {} }, possibleEffects: ['localRead'], availability: 'callable', origin: 'coreBuiltin' };

test('Agent plugin activation and explicit user mentions coexist across request boundaries', async t => {
  for (const surface of ['aggregate', 'responses']) {
    const journal = new InMemoryCommandJournal(), sessionId = `session:plugins-${surface}`;
    await createSession(journal, sessionId, [workspaceBinding]);
    const browserUri = 'plugin://browser@local';
    const mentioned = { selectionId: 'selection:notes', uri: 'plugin://notes@local', label: 'Notes' };
    const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
    const port = { ...preparation.port, async prepare(request) {
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      runtime.kernelCatalogSnapshotRef = `catalog:plugins:${preparation.prepared.length}`;
      if (request.pluginSelections?.some(selection => selection.uri === browserUri)) {
        runtime.tools.push({ toolBindingRef: `binding:${runtime.kernelCatalogSnapshotRef}`, name: 'browser.observe',
          description: 'Observe the internal browser.', inputSchema: { type: 'object', properties: {} },
          possibleEffects: ['localRead'], availability: 'callable', origin: 'extension', pluginUri: browserUri });
      }
      runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
        ...sessionControlToolDefinitions().map(tool => tool.name)]);
      return prepared;
    } };
    let turns = 0, executing = false, finishTool;
    const gate = new Promise(resolve => { finishTool = resolve; });
    const provider = { async *stream(request) {
      assert.ok(++turns <= 3);
      const emit = (name, input) => surface === 'responses'
        ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
          type: 'function_call', call_id: `native:${turns}`, name, arguments: JSON.stringify(input), status: 'completed' } })
        : providerEvent(request.requestId, 'tool.call', { callId: `native:${turns}`, name, input });
      if (turns === 1) {
        assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
        yield emit('plugin_activate', { pluginUris: [browserUri] });
      } else if (turns === 2) {
        assert.ok(request.tools.some(tool => tool.name === 'browser_observe'));
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes(browserUri)));
        yield emit('browser_observe', {});
      } else {
        assert.ok(request.tools.some(tool => tool.name === 'browser_observe'));
        yield providerEvent(request.requestId, 'text.delta', { text: 'Preview inspected.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const actor = actorWith(journal, sessionId, provider, emptyKernel({ async execute(request) {
      assert.equal(request.toolName, 'browser.observe');
      executing = true; await gate;
      const reply = completedExecutionReply(request, { content: 'Visible preview.' });
      reply.record.preparedEffect.origin = 'extension';
      reply.record.preparedEffect.pluginInstanceRef = `instance:${browserUri}`;
      return reply;
    } }), port, `plugin-${surface}`);
    t.after(async () => { finishTool(); await actor.dispose(); });
    await actor.submit({ ...messageCommand(sessionId, 'command:start', 'Inspect the preview using my notes.'),
      pluginSelections: [mentioned], pluginCatalogRevision: 'catalog:notes' });
    await waitUntil(() => executing, 'activated browser executing');
    await actor.submit(messageCommand(sessionId, 'command:guidance', 'Check the button too.'));
    finishTool();
    const done = await waitForProjection(actor, state => state.run?.status === 'completed');
    const events = await readEvents(journal, sessionId);
    const userMessages = events.filter(event => event.type === 'message.committed' && event.payload.role === 'user');
    assert.deepEqual(userMessages[0].payload.pluginSelections, [mentioned]);
    assert.equal(userMessages[1].payload.pluginSelections, undefined);
    assert.deepEqual(events.find(event => event.type === 'session.plugins.activated').payload.pluginUris, [browserUri]);
    assert.deepEqual(new Set(preparation.prepared.at(-1).pluginSelections.map(selection => selection.uri)),
      new Set([mentioned.uri, browserUri]));
    assert.equal(done.messages.at(-1).content, 'Preview inspected.');
    assert.equal(done.activities.some(activity => activity.label === 'plugin.activate'), false,
      'Session activation must not invent a completed Kernel tool record');
    assert.equal(preparation.released.length, 1);
  }
});

test('plugin preparation failure is returned without changing the callable tool view', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:plugin-disabled';
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation({ tools: [discoveryTool], contextWindowTokens: 8192 });
  const port = { ...preparation.port, async prepare(request) {
    if (request.pluginSelections?.length) throw new Error('plugin_selection_disabled: Plugin is disabled.');
    return preparation.port.prepare(request);
  } };
  let turns = 0;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (++turns === 1) yield providerEvent(request.requestId, 'tool.call', {
      callId: 'native:disabled', name: 'plugin_activate', input: { pluginUris: ['plugin://disabled@local'] },
    });
    else {
      assert.equal(turns, 2);
      assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes('plugin_selection_disabled')));
      assert.ok(!request.tools.some(tool => tool.name === 'browser_observe'));
      yield providerEvent(request.requestId, 'text.delta', { text: 'The selected plugin is disabled.' });
    }
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel(), port, 'plugin-disabled');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:start', 'Use the plugin.'));
  await waitForProjection(actor, state => state.run?.status === 'completed');
  const events = await readEvents(journal, sessionId);
  assert.equal(events.some(event => event.type === 'session.plugins.activated' || event.type === 'run.tools.prepared'), false);
});
