import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, workspaceBinding,
  providerEvent, messageCommand, waitForProjection, completedExecutionReply, readEvents } from './local-agent-fixtures.mjs';

const processTool = { toolBindingRef: 'binding:process', name: 'process', description: 'Manage a command',
  origin: 'extension', pluginUri: 'plugin://processes@builtin', pluginInstanceRef: 'instance:process',
  availability: 'callable', possibleEffects: ['process'],
  inputSchema: {type: 'object', required: ['action'], properties: {action: {type: 'string'}, input: {type: 'object'}}} };

for (const stop of [false, true]) test(`managed command ${stop ? 'stops with the run' : 'waits for a result without model polling'}`, async t => {
  const journal = new InMemoryCommandJournal();
  const sessionId = `session:managed-${stop}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  let job;
  let wake = () => {};
  let calls = 0;
  let closed = false;
  const requests = [];
  const provider = { async *stream(request) {
    requests.push(request);
    if (++calls === 1) yield providerEvent(request.requestId, 'tool.call', {callId: 'process-start', name: 'process',
      input: {action: 'start', tool: 'bash', input: {command: 'build'}}});
    else yield providerEvent(request.requestId, 'text.delta', {text: calls === 2 ? 'Premature answer.' : 'Build result received.'});
    yield providerEvent(request.requestId, 'completed', {});
  }};
  const finish = status => {
    if (!job || job.status !== 'active') return;
    job = {...job, revision: job.revision + 1, status, completedAt: String(Date.now()),
      result: {exitCode: status === 'completed' ? 0 : null, durationMs: 20, timedOut: false},
      ...(status === 'cancelled' ? {error:{code:'tool_execution_cancelled',message:'Cancelled by run owner'}} : {})};
    wake();
  };
  const kernel = emptyKernel({
    async execute(request) {
      job = {jobId: 'job:one', sessionId, runId: request.runId, callId: request.callId, revision: 1,
        toolName: 'bash', command: 'build', targets: ['.'], status: 'active', startedAt: String(Date.now()),
        output: {stdout: 'building\n', stderr: '', stdoutBytes: 9, stderrBytes: 0, truncated: false}};
      wake();
      const reply = completedExecutionReply(request, {job});
      reply.record.preparedEffect.providerRef = 'deepcode:processes';
      reply.record.preparedEffect.operation = 'bash';
      reply.record.preparedEffect.logicalTargets = ['.'];
      return reply;
    },
    async readProcesses(request, signal) {
      if (request.cancel) { closed = true; finish('cancelled'); }
      const changed = () => job && request.revisions?.[job.jobId] !== job.revision;
      if (request.waitMs && !changed()) {
        await new Promise(resolve => {
          const release = () => { if (wake === release) wake = () => {}; signal?.removeEventListener('abort', release); resolve(); };
          wake = release; signal?.addEventListener('abort', release, {once:true});
          if (signal?.aborted) release();
        });
      }
      return changed() ? [structuredClone(job)] : [];
    },
  });
  const preparation = fakeRunPreparation({tools: [processTool], contextWindowTokens: 20000});
  const actor = actorWith(journal, sessionId, provider, kernel, preparation.port, `managed-${stop}`);
  t.after(async () => { finish('cancelled'); wake(); await actor.dispose(); });
  const message = messageCommand(sessionId, 'command:start', 'Build with a managed process.');
  message.pluginSelections = [{selectionId:'selection:processes',uri:'plugin://processes@builtin',label:'Processes'}];
  await actor.submit(message);
  const active = await waitForProjection(actor, p => p.activities.some(a => a.tool?.process && a.status === 'active'));
  while (calls < 2) await delay(5);
  await delay(50);
  assert.equal(calls, 2, 'waiting for a process does not keep requesting the model');
  assert.equal((await actor.snapshot()).messages.some(m => m.content === 'Premature answer.'), false);
  if (stop) await actor.submit({type:'run.cancel', commandId:'command:stop', sessionId, runId:active.run.runId});
  else finish('completed');
  const final = await waitForProjection(actor, p => ['completed','cancelled'].includes(p.run?.status));
  const activity = final.activities.find(a => a.tool?.process);
  assert.equal(activity.status, stop ? 'cancelled' : 'completed');
  assert.equal(activity.liveOutput, undefined);
  assert.equal(activity.tool.process.output.stdout, 'building\n');
  assert.equal(closed, true);
  if (!stop) {
    assert.equal(calls, 3);
    assert.ok(requests[2].messages.some(m => m.role === 'tool' && JSON.parse(m.content).process?.status === 'completed'));
  }
  const updates = (await readEvents(journal,sessionId)).filter(e => e.type === 'process.updated');
  assert.equal(updates.filter(e => e.payload.job.status !== 'active').length,1);
  assert.equal(preparation.released.length,1);
});
