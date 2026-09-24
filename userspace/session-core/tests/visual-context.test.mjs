import assert from 'node:assert/strict';
import test from 'node:test';
import { imageCatalog, readImageReferences, visualContextMessages } from '../dist/local-agent/visualContext.js';
import { decodeConversationReadQuery, readConversation } from '../dist/local-agent/conversationRead.js';
import { withProviderAttempts } from '../dist/local-agent/providerAttempts.js';
import { ProviderReportedFailure } from '../dist/local-agent/loopFailure.js';

const sessionId = 'session:images', runId = 'run:images';
function history() {
  const events = [];
  const append = (type, payload, extra = {}) => {
    const event = { type, sessionId, runId, eventId: `event:${events.length}`, sequence: events.length + 1, payload, ...extra };
    events.push(event);
    return event;
  };
  append('session.created', { workspaceBindings: [] });
  return { events, append };
}
const file = id => ({ referenceId: id, workspaceId: 'input:images', logicalPath: `${id}.png`, mediaType: 'image/png', displayName: id, kind: 'file' });
const ids = messages => messages.map(message => JSON.parse(message.message.content.slice('Current visual inputs: '.length)).imageId);
const observe = (append, id) => append('tool.completed', { record: {
  toolName: 'browser.observe', input: {}, outcome: 'completed', output: { modelImages: [{ artifactId: id }] },
} }, { callId: `call:${id}` });
const choose = (append, imageIds, outcome = 'completed') => append('tool.completed', { record: {
  toolName: 'session.read', input: { sessionId, view: 'images', imageIds }, outcome,
  ...(outcome === 'completed' ? { output: {} } : { error: { code: 'session_image_not_found' } }),
} }, { callId: 'call:read' });

test('visual inputs retain run attachments, replace observation batches and reload exact old images', () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', messageId: 'input', filesystemReferences: [file('design')] }, { runId: undefined });
  append('run.started', { inputMessageId: 'input' });
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design']);
  append('context.composed', { purpose: 'agent' });
  observe(append, 'before');
  observe(append, 'detail');
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design', 'before', 'detail']);
  append('context.composed', { purpose: 'agent' });
  append('tool.completed', { record: { toolName: 'fs.read', input: {}, outcome: 'completed', output: { content: 'code' } } });
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design', 'before', 'detail']);
  observe(append, 'after');
  assert.deepEqual(ids(visualContextMessages(events, runId)), ['design', 'after']);
  choose(append, ['before', 'after']);
  const compared = visualContextMessages(events, runId);
  assert.deepEqual(ids(compared), ['before', 'after']);
  assert.deepEqual(compared[0].message.toolImages, [{ callId: 'call:before', artifactId: 'before' }]);
  choose(append, ['missing'], 'failed');
  assert.deepEqual(visualContextMessages(events, runId), compared);
  choose(append, []);
  assert.deepEqual(visualContextMessages(events, runId), []);
  assert.equal(imageCatalog(events).size, 4);
});

test('a new run carries references without pixels and can reopen images across a compaction', () => {
  const { events, append } = history();
  observe(append, 'original');
  append('context.compacted', { coveredThroughSequence: events.length, summary: 'Original image is archived.' });
  append('message.committed', { role: 'user', messageId: 'next', content: 'Compare the old image.' }, { runId: 'run:next' });
  append('run.started', { inputMessageId: 'next' }, { runId: 'run:next' });
  assert.deepEqual(visualContextMessages(events, 'run:next'), []);
  const selection = choose(append, ['original']);
  selection.runId = 'run:next';
  assert.deepEqual(ids(visualContextMessages(events, 'run:next')), ['original']);
  assert.throws(() => readImageReferences(events, ['missing']), /session_image_not_found/);
});

test('image reference pages preserve whole source events and explicit selection rejects unavailable references', async () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', filesystemReferences: [file('a'), file('b')] });
  append('message.committed', { role: 'user', filesystemReferences: [file('c'), file('d')] });
  const journal = { async *read() { yield* events; } };
  const first = await readConversation(journal, { sessionId, view: 'images', limit: 1 });
  assert.deepEqual(first.items.map(item => item.imageId), ['c', 'd']);
  const second = await readConversation(journal, { sessionId, view: 'images', before: first.nextBefore, limit: 1 });
  assert.deepEqual(second.items.map(item => item.imageId), ['a', 'b']);
  assert.equal(second.nextBefore, null);
  const selected = await readConversation(journal, { sessionId, view: 'images', imageIds: ['d', 'a'] });
  assert.deepEqual(selected.items.map(item => item.imageId), ['d', 'a']);
  await assert.rejects(readConversation(journal, { sessionId, view: 'images', imageIds: ['unknown'] }), /session_image_not_found/);
  assert.deepEqual(decodeConversationReadQuery({ sessionId, view: 'images', imageIds: [] }).imageIds, []);
  assert.throws(() => decodeConversationReadQuery({ sessionId, view: 'images', imageIds: ['a', 'a'] }), /conversation_read_invalid/);
  assert.throws(() => decodeConversationReadQuery({ sessionId, view: 'images', imageIds: ['a'], before: 3 }), /conversation_read_invalid/);
});

test('retry preserves selected attachment and observation images in the request and replay', async () => {
  const { events, append } = history();
  append('message.committed', { role: 'user', messageId: 'input', filesystemReferences: [file('attachment')] }, { runId: undefined });
  append('run.started', { inputMessageId: 'input' });
  observe(append, 'observation');
  choose(append, ['attachment', 'observation']);
  const selected = visualContextMessages(events, runId);
  assert.deepEqual(ids(selected), ['attachment', 'observation']);
  const requests = [], facts = [];
  const request = { requestId: 'request:images', sessionId, runId, purpose: 'agent',
    messages: selected.map(contribution => contribution.message) };
  append('context.composed', { purpose: 'agent' });
  await withProviderAttempts(request, { nextId: kind => `${kind}:${facts.length}`, commit: async event => {
    facts.push(event); append(event.type, event.payload);
  }, updateAssistantDraft() {} },
    new AbortController().signal, async (attempt, completed) => {
      requests.push(structuredClone(attempt));
      if (requests.length === 1) throw new ProviderReportedFailure('provider_network_failed', 'Connection interrupted',
        { source: 'providerTransport', category: 'network', retryable: true });
      completed();
    });
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages, requests[0].messages);
  assert.deepEqual(requests[1].messages.flatMap(message => message.images ?? []),
    [{ workspaceId: 'input:images', logicalPath: 'attachment.png', mediaType: 'image/png' }]);
  assert.deepEqual(requests[1].messages.flatMap(message => message.toolImages ?? []),
    [{ callId: 'call:observation', artifactId: 'observation' }]);
  assert.deepEqual(visualContextMessages(events, runId), selected, 'attempt lifecycle events must not consume the selected images');
  assert.equal(facts.at(-1).payload.phase, 'completed');
});
