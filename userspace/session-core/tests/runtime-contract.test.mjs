import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, waitForProjection, readEvents } from './local-agent-fixtures.mjs';

test('the public schema validates Session producers and rejects missing execution identities', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:public-contract';
  await createSession(journal, sessionId, [workspaceBinding]);
  let sent;
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    sent = request;
    const text = providerEvent(request.requestId, 'text.delta', { text: 'Current contract.' });
    const completed = providerEvent(request.requestId, 'completed', {});
    assertRuntimeContract('ProviderEvent', text);
    assertRuntimeContract('ProviderEvent', completed);
    yield text; yield completed;
  } }, emptyKernel(), fakeRunPreparation().port, 'public-contract');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId, 'command:public-contract', 'Inspect the current contract.'));
  const projection = await waitForProjection(actor, value => value.run?.status === 'completed');
  assertRuntimeContract('SessionProjection', projection);
  for (const event of await readEvents(journal, sessionId)) {
    assertRuntimeContract('SessionEvent', event);
    if (event.runId) {
      const missingRun = structuredClone(event);
      delete missingRun.runId;
      assert.throws(() => assertRuntimeContract('SessionEvent', missingRun), /runId/);
    }
  }
  const missingHostedTools = structuredClone(sent);
  delete missingHostedTools.hostedTools;
  assert.throws(() => assertRuntimeContract('ProviderRequest', missingHostedTools), /hostedTools/);
  const unknownProjectionFact = { ...projection, inferredSuccess: true };
  assert.throws(() => assertRuntimeContract('SessionProjection', unknownProjectionFact), /inferredSuccess/);
});
