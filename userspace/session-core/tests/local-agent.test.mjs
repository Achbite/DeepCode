import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeStartupPluginConfig,
  decodeSessionControlCall,
  emptySessionState,
  InMemoryCommandJournal,
  projectSession,
  reduceSession,
  SessionActor,
  SessionService,
} from '../dist/index.js';

const binding = { workspaceId: 'workspace:test', displayName: 'Test' };
const externalTool = {
  name: 'example.external',
  description: '执行外部 effect',
  inputSchema: { type: 'object' },
  possibleEffects: ['external'],
  availability: 'callable',
};
const writeTool = {
  name: 'fs.write',
  description: '写入工作区文件',
  inputSchema: { type: 'object' },
  possibleEffects: ['workspaceMutation'],
  availability: 'callable',
};

test('Todo progress 只接受已生成 Todo 的来源与状态更新', () => {
  assert.deepEqual(
    decodeSessionControlCall('todo:call', 'todo.progress', {
      planId: 'plan:test',
      revision: 1,
      updates: [{ todoId: 'todo:inspect', status: 'inProgress' }],
    }),
    {
      kind: 'todo',
      callId: 'todo:call',
      planId: 'plan:test',
      revision: 1,
      updates: [{ todoId: 'todo:inspect', status: 'inProgress' }],
    },
  );
  assert.throws(
    () => decodeSessionControlCall('todo:call', 'todo.progress', {
      planId: 'plan:test',
      revision: 1,
      updates: [{ todoId: 'todo:inspect', label: '不能改写', status: 'pending' }],
    }),
    (error) => error?.code === 'session_control_shape_invalid',
  );
});

test('context.focus 只接受一个明确的任务焦点', () => {
  assert.deepEqual(
    decodeSessionControlCall('call:focus', 'context.focus', {
      focus: '  只保留新的调试任务  ',
    }),
    {
      kind: 'focus',
      callId: 'call:focus',
      focus: '只保留新的调试任务',
    },
  );
  assert.throws(
    () => decodeSessionControlCall('call:focus', 'context.focus', { focus: '   ' }),
    (error) => error?.code === 'session_control_focus_invalid',
  );
});

test('共享系统提示词与 Skill 插件配置保持独立贡献', () => {
  const config = decodeStartupPluginConfig(JSON.stringify({
    systemPrompt: '使用函数式组合，并保持层间透明。',
    workspaceMutation: 'allow',
    engineeringDecisions: 'delegate',
    skills: [{ id: 'example', instructions: '只处理示例领域。' }],
  }));
  assert.equal(config.systemPrompt, '使用函数式组合，并保持层间透明。');
  assert.equal(config.workspaceMutation, 'allow');
  assert.equal(config.engineeringDecisions, 'delegate');
  assert.deepEqual(config.skills, [{ id: 'example', instructions: '只处理示例领域。' }]);
  assert.throws(
    () => decodeStartupPluginConfig(JSON.stringify({ systemPrompt: 1, skills: [] })),
    /startup_plugin_config_invalid/,
  );
});

test('累计 token 用量超过安全整数边界时拒绝生成不精确投影', () => {
  const state = emptySessionState('session:usage-overflow');
  state.run = {
    runId: 'run:usage-overflow',
    status: 'running',
    workspaceBindings: [],
  };
  state.tokenUsage.inputTokens = Number.MAX_SAFE_INTEGER;
  state.tokenUsageHistory['run:usage-overflow'] = {
    runId: 'run:usage-overflow',
    inputMessageId: 'message:usage-overflow',
    title: '溢出测试',
    sequence: 1,
    startedAt: '2026-08-25T00:00:00.000Z',
    providerCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheReportedCallCount: 0,
  };
  state.contextCompositions.push({
    runId: 'run:usage-overflow',
    providerRequestId: 'provider-request:usage-overflow',
    purpose: 'agent',
    responseConstraint: 'normal',
    messages: [],
    workspaceBindings: [],
    tools: [],
    partitions: [
      ['instructions', 1],
      ['sessionControls', 0],
      ['tools', 0],
      ['workspaceBindings', 0],
      ['contextProviders', 0],
      ['journalMessages', 0],
      ['messageAttachments', 0],
    ].map(([kind, requestShapeUnits]) => ({
      kind,
      itemCount: 0,
      requestShapeUnits,
    })),
    sequence: 1,
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  assert.throws(() => reduceSession(state, {
    schemaVersion: 'deepcode.session-event',
    eventId: 'event:usage-overflow',
    sessionId: 'session:usage-overflow',
    sequence: 1,
    occurredAt: '2026-08-25T00:00:00.000Z',
    type: 'context.updated',
    runId: 'run:usage-overflow',
    payload: {
      providerRequestId: 'provider-request:usage-overflow',
      inputTokens: 1,
      outputTokens: 0,
      contextWindowTokens: 100,
    },
  }), /token_usage_overflow/);
});

test('Provider 用量没有对应请求回执时拒绝进入共享投影', () => {
  const state = emptySessionState('session:usage-without-receipt');
  state.run = {
    runId: 'run:usage-without-receipt',
    status: 'running',
    workspaceBindings: [],
  };
  state.tokenUsageHistory['run:usage-without-receipt'] = {
    runId: 'run:usage-without-receipt',
    inputMessageId: 'message:usage-without-receipt',
    title: '无回执测试',
    sequence: 1,
    startedAt: '2026-08-25T00:00:00.000Z',
    providerCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheReportedCallCount: 0,
  };
  assert.throws(() => reduceSession(state, {
    schemaVersion: 'deepcode.session-event',
    eventId: 'event:usage-without-receipt',
    sessionId: 'session:usage-without-receipt',
    sequence: 1,
    occurredAt: '2026-08-25T00:00:01.000Z',
    type: 'context.updated',
    runId: 'run:usage-without-receipt',
    payload: {
      providerRequestId: 'provider-request:missing',
      inputTokens: 10,
      outputTokens: 2,
      contextWindowTokens: 100,
    },
  }), /provider_request_receipt_missing/);
});

test('Profile 与 workspace creation snapshot 写入 Journal 并用于恢复', async () => {
  const journal = new InMemoryCommandJournal();
  const created = [];
  const service = serviceWith(journal, created);
  await service.createSession({
    sessionId: 'session:profile',
    displayTitle: '新对话',
    workspaceBindings: [binding],
    profileId: 'profile:local-coding',
  });
  assert.deepEqual(created[0], {
    sessionId: 'session:profile',
    workspaceBindings: [binding],
    profileId: 'profile:local-coding',
  });
  assert.deepEqual((await readEvents(journal, 'session:profile'))[0].payload, {
    displayTitle: '新对话',
    workspaceBindings: [binding],
    profileId: 'profile:local-coding',
  });
  await service.dispose();

  const recoveredInputs = [];
  const recovered = serviceWith(journal, recoveredInputs);
  const projection = await recovered.snapshot('session:profile');
  assert.equal(projection.display.creationTitle, '新对话');
  assert.deepEqual(projection.workspaceBindings, [binding]);
  assert.deepEqual(recoveredInputs[0], created[0]);
  await recovered.dispose();
});

test('独立对话允许无 binding，Session 固定创建快照且可删除非活动会话', async () => {
  const journal = new InMemoryCommandJournal();
  const service = serviceWith(journal, []);
  const mutableBindings = [];
  const projection = await service.createSession({
    sessionId: 'session:standalone',
    displayTitle: '新对话',
    workspaceBindings: mutableBindings,
  });
  mutableBindings.push(binding);
  assert.deepEqual(projection.workspaceBindings, []);
  assert.deepEqual((await service.snapshot('session:standalone')).workspaceBindings, []);
  await service.deleteSession('session:standalone');
  await assert.rejects(service.snapshot('session:standalone'), /session_not_found/);
  await service.dispose();
});

test('对话目录索引进入 Journal，当前 run 冻结目录集合且变更只影响下一 run', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:directory-index';
  const extra = { workspaceId: 'workspace:extra', displayName: 'Extra' };
  const later = { workspaceId: 'workspace:later', displayName: 'Later' };
  await createSession(journal, sessionId, [binding]);
  const requests = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request.workspaceBindings.map((item) => ({ ...item })));
      if (requests.length === 1) await firstGate;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `message:directory-index:${requests.length}`,
        content: `完成 ${requests.length}`,
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  });

  assert.equal((await actor.submit({
    schemaVersion: 'deepcode.command',
    type: 'session.directory-index.attach',
    commandId: 'command:attach-extra',
    sessionId,
    workspaceBinding: extra,
  })).status, 'accepted');
  assert.deepEqual((await actor.snapshot()).workspaceBindings, [binding, extra]);

  await actor.submit(message(sessionId, 'command:run-one', '第一次'));
  await waitFor(actor, (projection) => requests.length === 1 && projection.run?.status === 'running');
  assert.deepEqual((await actor.snapshot()).run.workspaceBindings, [binding, extra]);

  assert.equal((await actor.submit({
    schemaVersion: 'deepcode.command',
    type: 'session.directory-index.attach',
    commandId: 'command:attach-later',
    sessionId,
    workspaceBinding: later,
  })).status, 'accepted');
  const duringRun = await actor.snapshot();
  assert.deepEqual(duringRun.workspaceBindings, [binding, extra, later]);
  assert.deepEqual(duringRun.run.workspaceBindings, [binding, extra]);
  releaseFirst();
  await waitFor(actor, (projection) => projection.run?.status === 'completed');

  await actor.submit(message(sessionId, 'command:run-two', '第二次'));
  await waitFor(actor, (projection) => requests.length === 2 && projection.run?.status === 'completed');
  assert.deepEqual(requests[1], [binding, extra, later]);

  assert.equal((await actor.submit({
    schemaVersion: 'deepcode.command',
    type: 'session.directory-index.detach',
    commandId: 'command:detach-extra',
    sessionId,
    workspaceId: extra.workspaceId,
  })).status, 'accepted');
  const detached = await actor.snapshot();
  assert.deepEqual(detached.workspaceBindings, [binding, later]);
  assert.deepEqual(detached.sessionDirectoryIndexes, [later]);
  const eventTypes = (await readEvents(journal, sessionId)).map((event) => event.type);
  assert.equal(eventTypes.includes('session.directory-index.attached'), true);
  assert.equal(eventTypes.includes('session.directory-index.detached'), true);
  await actor.dispose();
});

test('唯一 Loop 提交消息、幂等命令并投影 canonical activities', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:basic', [binding]);
  const actor = actorWith(journal, 'session:basic', {
    async *stream(request) {
      assert.deepEqual(request.workspaceBindings, [binding]);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:assistant',
        content: '完成。',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  });
  const command = message('session:basic', 'command:basic', '处理这个任务');
  const admitted = await actor.submit(command);
  assert.equal(admitted.status, 'accepted');
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.deepEqual(completed.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '处理这个任务' },
    { role: 'assistant', content: '完成。' },
  ]);
  assert.equal(completed.activities.find((item) => item.kind === 'run')?.status, 'completed');
  assert.equal((await actor.submit(command)).status, 'replayed');
  const conflict = await actor.submit({ ...command, text: '不同内容' });
  assert.equal(conflict.status, 'rejected');
  assert.equal(conflict.error?.code, 'command_id_conflict');
  await actor.dispose();
});

test('文本附件只把显示元数据投影给 UI，原文仍作为 Session 消息事实提供给模型', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:attachment');
  const requests = [];
  const actor = actorWith(journal, 'session:attachment', {
    async *stream(request) {
      requests.push(request);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:attachment-answer',
        content: '已读取附件。',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  });
  const attachments = [{
    attachmentId: 'attachment:readme',
    name: 'README.md',
    mediaType: 'text/markdown',
    content: '# Example\n',
  }];
  await actor.submit(message(
    'session:attachment', 'command:attachment', '请分析附件', undefined, attachments,
  ));
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.deepEqual(completed.messages[0].attachments, [{
    attachmentId: 'attachment:readme',
    name: 'README.md',
    mediaType: 'text/markdown',
    byteLength: 10,
  }]);
  assert.match(requests[0].messages.find((item) => item.role === 'user').content, /# Example/);
  assert.equal('content' in completed.messages[0].attachments[0], false);
  const invalid = await actor.submit(message(
    'session:attachment',
    'command:attachment-invalid',
    '无效附件',
    undefined,
    [{ ...attachments[0], attachmentId: '' }],
  ));
  assert.equal(invalid.status, 'rejected');
  assert.equal(invalid.error?.code, 'message_attachment_invalid');
  await actor.dispose();
});

test('目录附件属于单条消息，只进入该消息启动的 run 目录快照', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:message-directory';
  const directoryAttachment = {
    workspaceId: 'workspace:attached',
    displayName: 'Attached',
  };
  await createSession(journal, sessionId, [binding]);
  const requests = [];
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: `message:message-directory:${requests.length}`,
        content: '完成。',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  });

  await actor.submit(message(
    sessionId,
    'command:message-directory:first',
    '分析这个目录',
    undefined,
    undefined,
    [directoryAttachment],
  ));
  const first = await waitFor(actor, (projection) => projection.run?.status === 'completed');
  assert.deepEqual(requests[0].workspaceBindings, [binding, directoryAttachment]);
  assert.deepEqual(first.workspaceBindings, [binding]);
  assert.deepEqual(first.sessionDirectoryIndexes, []);
  assert.deepEqual(first.messages[0].directoryAttachments, [directoryAttachment]);
  assert.match(
    requests[0].messages.find((item) => item.role === 'user').content,
    /"workspaceId":"workspace:attached"/,
  );

  await actor.submit(message(
    sessionId,
    'command:message-directory:second',
    '继续，但本轮不附加目录',
  ));
  await waitFor(actor, (projection) => (
    requests.length === 2 && projection.run?.status === 'completed'
  ));
  assert.deepEqual(requests[1].workspaceBindings, [binding]);
  assert.deepEqual((await actor.snapshot()).messages[0].directoryAttachments, [directoryAttachment]);
  await actor.dispose();
});

test('typed turn 叙述、模型主动介入和上下文计数进入共享投影，活动 run 可切换模型', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:structured', [binding]);
  const requests = [];
  let turn = 0;
  const actor = actorWith(journal, 'session:structured', {
    async *stream(request) {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:interaction',
          content: '正在确认项目希望采用的构建入口。',
          reasoningContent: 'private provider reasoning for the tool continuation',
          reasoningSignature: 'opaque provider reasoning signature',
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'interaction:build-entry',
          name: 'interaction.request',
          input: {
            kind: 'question',
            prompt: '请选择构建入口。',
            options: [
              { id: 'cargo', label: 'Cargo' },
              { id: 'make', label: 'Makefile', description: '沿用现有脚本。' },
            ],
            allowFreeform: false,
          },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 20, outputTokens: 10, contextWindowTokens: 100 },
        });
        return;
      }
      assert.equal(request.profileId, 'profile:pro');
      assert.ok(request.messages.some((item) => item.role === 'user' && item.content === 'cargo'));
      const interactionTurn = request.messages.find((item) => (
        item.role === 'assistant'
        && item.toolCalls?.some((call) => call.name === 'interaction.request')
      ));
      const interactionCall = interactionTurn?.toolCalls?.find(
        (call) => call.name === 'interaction.request',
      );
      assert.ok(interactionCall);
      assert.notEqual(interactionCall.callId, 'interaction:build-entry');
      assert.equal(
        interactionTurn?.reasoningContent,
        'private provider reasoning for the tool continuation',
      );
      assert.equal(
        interactionTurn?.reasoningSignature,
        'opaque provider reasoning signature',
      );
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:answer',
        content: '采用 **Cargo** 作为构建入口。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 30, outputTokens: 12, contextWindowTokens: 100 },
      });
    },
  }, undefined, [], 'structured');
  await actor.submit(message(
    'session:structured', 'command:start', '整理构建方式', 'profile:flash',
  ));
  const waiting = await waitFor(actor, (p) => p.run?.waitingReason === 'userInput');
  assert.equal(waiting.run.profileId, 'profile:flash');
  assert.equal(waiting.pendingInteraction.prompt, '请选择构建入口。');
  assert.deepEqual(waiting.narratives.map((item) => item.content), [
    '正在确认项目希望采用的构建入口。',
  ]);
  assert.equal(waiting.contextUsage.inputTokens, 20);
  assert.equal(waiting.contextUsage.outputTokens, 10);
  assert.equal(waiting.contextUsage.contextWindowTokens, 100);
  assert.equal(waiting.contextUsage.runId, waiting.run.runId);
  assert.equal(
    waiting.contextCompositions.at(-1).providerRequestId,
    waiting.contextUsage.providerRequestId,
  );
  const runId = waiting.run.runId;
  const invalid = await actor.submit(interaction(
    'session:structured', 'command:bad', runId, waiting.pendingInteraction.interactionId, 'gradle',
  ));
  assert.equal(invalid.status, 'rejected');
  assert.equal(invalid.error?.code, 'interaction_response_invalid');
  assert.equal((await actor.submit(profile(
    'session:structured', 'command:profile', runId, 'profile:pro',
  ))).status, 'accepted');
  assert.equal((await actor.submit(interaction(
    'session:structured', 'command:answer', runId, waiting.pendingInteraction.interactionId, 'cargo',
  ))).status, 'accepted');
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.run.profileId, 'profile:pro');
  assert.equal(completed.pendingInteraction, null);
  assert.equal(completed.activities.find((item) => item.kind === 'interaction')?.status, 'completed');
  assert.deepEqual(completed.narratives.map((item) => item.content), [
    '正在确认项目希望采用的构建入口。',
  ]);
  assert.equal(completed.messages.at(-1).content, '采用 **Cargo** 作为构建入口。');
  assert.deepEqual(requests.map((item) => item.profileId), ['profile:flash', 'profile:pro']);
  const interactionRequested = (await readEvents(journal, 'session:structured'))
    .find((event) => event.type === 'interaction.requested');
  assert.equal(interactionRequested.payload.providerCallId, 'interaction:build-entry');
  assert.notEqual(interactionRequested.payload.interactionId, 'interaction:build-entry');
  assert.doesNotMatch(
    JSON.stringify(await readEvents(journal, 'session:structured')),
    /private provider reasoning|opaque provider reasoning signature/u,
  );
  await actor.dispose();
});

test('当前 turn 的累计 assistant draft 可从共享 snapshot 拉取且不写入 Journal', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:streaming');
  let release;
  const paused = new Promise((resolve) => { release = resolve; });
  const actor = actorWith(journal, 'session:streaming', {
    async *stream(request) {
      yield providerEvent(request.requestId, 'text.delta', {
        text: '正在检查项目入口。',
      });
      await paused;
      yield providerEvent(request.requestId, 'text.delta', { text: '\n\n检查完成。' });
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, undefined, [], 'streaming');
  await actor.submit(message('session:streaming', 'command:start', '检查项目入口'));
  const running = await waitFor(actor, (p) => p.assistantDraft?.content === '正在检查项目入口。');
  assert.equal(running.narratives.length, 0);
  assert.equal(running.messages.length, 1);
  assert.equal((await readEvents(journal, 'session:streaming')).some((event) => (
    event.type === 'assistant.chunk'
  )), false);
  release();
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.assistantDraft, null);
  assert.equal(completed.messages.at(-1).content, '正在检查项目入口。\n\n检查完成。');
  await actor.dispose();
});

test('回答反馈作为 Session durable fact 写入 Journal、支持回放和清除', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:feedback';
  await createSession(journal, sessionId);
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:feedback-answer',
        content: '这是可复核的回答。',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  });
  await actor.submit(message(sessionId, 'command:feedback-run', '请回答'));
  await waitFor(actor, (projection) => projection.run?.status === 'completed');
  const feedbackCommand = {
    schemaVersion: 'deepcode.command',
    type: 'message.feedback.set',
    commandId: 'command:feedback-up',
    sessionId,
    messageId: 'message:feedback-answer',
    feedback: 'up',
  };
  assert.equal((await actor.submit(feedbackCommand)).status, 'accepted');
  assert.equal((await actor.snapshot()).messages.at(-1).feedback, 'up');
  await actor.dispose();

  const recovered = actorWith(journal, sessionId, { async *stream() {} });
  assert.equal((await recovered.snapshot()).messages.at(-1).feedback, 'up');
  assert.equal((await recovered.submit(feedbackCommand)).status, 'replayed');
  const clear = await recovered.submit({
    ...feedbackCommand,
    commandId: 'command:feedback-clear',
    feedback: null,
  });
  assert.equal(clear.status, 'accepted');
  assert.equal((await recovered.snapshot()).messages.at(-1).feedback, null);
  const feedbackEvents = (await readEvents(journal, sessionId)).filter((event) => (
    event.type === 'message.feedback.updated'
  ));
  assert.deepEqual(feedbackEvents.map((event) => event.payload.feedback), ['up', null]);
  await recovered.dispose();
});

test('Provider 请求回执先于调用持久化，并与用量事实使用同一 request identity', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:request-receipt';
  await createSession(journal, sessionId, [binding]);
  let eventsBeforeProvider = [];
  let providerRequest = null;
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      providerRequest = request;
      eventsBeforeProvider = await readEvents(journal, sessionId);
      const receipt = eventsBeforeProvider.at(-1);
      assert.equal(receipt.type, 'context.composed');
      assert.equal(receipt.payload.providerRequestId, request.requestId);
      assert.equal(receipt.payload.purpose, 'agent');
      assert.equal(request.purpose, 'agent');
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:request-receipt',
        content: '回执已绑定。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: {
          inputTokens: 40,
          outputTokens: 6,
          contextWindowTokens: 1_000,
          cacheReadInputTokens: 30,
          cacheMissInputTokens: 10,
        },
      });
    },
  }, undefined, [], 'request-receipt');
  await actor.submit(message(sessionId, 'command:request-receipt', '核对请求构成'));
  const completed = await waitFor(actor, (projection) => projection.run?.status === 'completed');
  assert.equal(eventsBeforeProvider.some((event) => event.type === 'context.updated'), false);
  const receipt = completed.contextCompositions.at(-1);
  assert.equal(receipt.providerRequestId, completed.contextUsage.providerRequestId);
  assert.deepEqual(receipt.messages.map((entry) => ({
    messageIndex: entry.messageIndex,
    role: entry.role,
  })), providerRequest.messages.map((entry, messageIndex) => ({
    messageIndex,
    role: entry.role,
  })));
  assert.deepEqual(receipt.workspaceBindings, providerRequest.workspaceBindings.map((entry) => ({
    itemId: entry.workspaceId,
    label: entry.displayName,
  })));
  assert.deepEqual(providerRequest.tools.map((entry) => entry.name), [
    'interaction.request',
    'plan.publish',
    'todo.progress',
    'context.focus',
  ]);
  assert.deepEqual(receipt.tools, []);
  assert.deepEqual(receipt.partitions.map((partition) => partition.kind), [
    'instructions',
    'sessionControls',
    'tools',
    'workspaceBindings',
    'contextProviders',
    'journalMessages',
    'messageAttachments',
  ]);
  assert.equal(
    receipt.partitions.reduce(
      (total, partition) => total + partition.estimatedInputTokens,
      0,
    ),
    completed.contextUsage.inputTokens,
  );
  assert.equal(receipt.partitions.every(
    (partition) => partition.tokenSource === 'sessionEstimated',
  ), true);
  assert.deepEqual(completed.tokenUsageHistory.map((round) => ({
    title: round.title,
    providerCallCount: round.providerCallCount,
    inputTokens: round.inputTokens,
    outputTokens: round.outputTokens,
    cacheReadInputTokens: round.cacheReadInputTokens,
    cacheMissInputTokens: round.cacheMissInputTokens,
    outcome: round.outcome,
  })), [{
    title: '核对请求构成',
    providerCallCount: 1,
    inputTokens: 40,
    outputTokens: 6,
    cacheReadInputTokens: 30,
    cacheMissInputTokens: 10,
    outcome: 'completed',
  }]);
  await actor.dispose();
});

test('/focus 压缩此前内容后只把任务正文作为新的用户消息继续', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:user-focus';
  await createSession(journal, sessionId);
  const requests = [];
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        assert.equal(request.purpose, 'agent');
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:old-answer',
          content: '旧任务已经完成。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 100, outputTokens: 10, contextWindowTokens: 10_000 },
        });
        return;
      }
      if (requests.length === 2) {
        assert.equal(request.purpose, 'contextCompaction');
        assert.equal(request.responseConstraint, 'answerOnly');
        assert.deepEqual(request.tools, []);
        assert.ok(request.messages.some((item) => item.content.includes('新的诊断任务')));
        assert.ok(request.messages.some((item) => item.content === '旧任务'));
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:user-focus-summary',
          content: '旧任务事实摘要：旧任务已经完成。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 120, outputTokens: 20, contextWindowTokens: 10_000 },
        });
        return;
      }
      assert.equal(request.purpose, 'agent');
      assert.ok(request.messages.some((item) => (
        item.role === 'system' && item.content.includes('旧任务事实摘要')
      )));
      assert.ok(request.messages.some((item) => (
        item.role === 'user' && item.content === '新的诊断任务'
      )));
      assert.equal(request.messages.some((item) => item.content === '旧任务'), false);
      assert.equal(request.messages.some((item) => item.content.includes('/focus')), false);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:user-focus-answer',
        content: '已切换到新的诊断任务。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 80, outputTokens: 8, contextWindowTokens: 10_000 },
      });
    },
  }, undefined, [], 'user-focus');

  await actor.submit(message(sessionId, 'command:old', '旧任务'));
  await waitFor(actor, (projection) => projection.run?.status === 'completed');
  await actor.submit(message(sessionId, 'command:focus', '/focus 新的诊断任务'));
  const completed = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '已切换到新的诊断任务。'
  ));
  assert.equal(requests.length, 3);
  assert.equal(completed.contextUsage.providerRequestId, requests[2].requestId);
  const events = await readEvents(journal, sessionId);
  const requested = events.find((event) => (
    event.type === 'context.compaction.requested'
    && event.payload.trigger === 'userFocus'
  ));
  const compacted = events.find((event) => (
    event.type === 'context.compacted'
    && event.payload.compactionId === requested.payload.compactionId
  ));
  assert.equal(requested.payload.commandId, 'command:focus');
  assert.equal(requested.payload.focus, '新的诊断任务');
  assert.equal(compacted.payload.summary, '旧任务事实摘要：旧任务已经完成。');
  assert.deepEqual(events.filter((event) => (
    event.type === 'message.committed' && event.payload.role === 'user'
  )).map((event) => event.payload.content), ['旧任务', '新的诊断任务']);
  await actor.dispose();
});

test('Pressure compaction 在估算达到九成时生成 checkpoint 并保留当前任务原文', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:pressure-compaction';
  await createSession(journal, sessionId);
  const requests = [];
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:pressure-old-answer',
          content: '旧上下文回答。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 9_000, outputTokens: 100, contextWindowTokens: 10_000 },
        });
        return;
      }
      if (requests.length === 2) {
        assert.equal(request.purpose, 'contextCompaction');
        assert.equal(request.maxOutputTokens, 1_024);
        assert.ok(request.messages.some((item) => item.content === '高占用旧任务'));
        assert.equal(request.messages.some((item) => item.content === '当前任务必须保留'), false);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:pressure-summary',
          content: '压力压缩摘要：此前高占用任务已经回答。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 1_000, outputTokens: 120, contextWindowTokens: 10_000 },
        });
        return;
      }
      assert.equal(request.purpose, 'agent');
      assert.ok(request.messages.some((item) => (
        item.role === 'system' && item.content.includes('压力压缩摘要')
      )));
      assert.ok(request.messages.some((item) => (
        item.role === 'user' && item.content === '当前任务必须保留'
      )));
      assert.equal(request.messages.some((item) => item.content === '高占用旧任务'), false);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:pressure-current-answer',
        content: '当前任务已完成。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 900, outputTokens: 50, contextWindowTokens: 10_000 },
      });
    },
  }, undefined, [], 'pressure');

  await actor.submit(message(sessionId, 'command:pressure-old', '高占用旧任务'));
  await waitFor(actor, (projection) => projection.run?.status === 'completed');
  await actor.submit(message(sessionId, 'command:pressure-current', '当前任务必须保留'));
  const completed = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '当前任务已完成。'
  ));
  assert.equal(requests.length, 3);
  assert.deepEqual(completed.contextCompositions.slice(-2).map((receipt) => receipt.purpose), [
    'contextCompaction',
    'agent',
  ]);
  const events = await readEvents(journal, sessionId);
  const requested = events.find((event) => (
    event.type === 'context.compaction.requested'
    && event.payload.trigger === 'pressure'
  ));
  assert.ok(requested);
  assert.ok(events.some((event) => (
    event.type === 'context.compacted'
    && event.payload.compactionId === requested.payload.compactionId
  )));
  await actor.dispose();
});

test('Pressure compaction 可在同一运行内折叠已闭合工具前缀并保留当前任务原文', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:pressure-mid-run';
  await createSession(journal, sessionId, [binding]);
  const readTool = {
    name: 'fs.read',
    description: '读取工作区文件',
    inputSchema: { type: 'object' },
    possibleEffects: [],
    availability: 'callable',
  };
  const kernel = {
    async listTools() { return [readTool]; },
    async execute(request) {
      return executionReply(
        request,
        { decision: 'allow', source: 'workspaceRead', workspaceId: 'workspace:test' },
        'README.md',
        { content: '已读取的项目事实' },
      );
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  const requests = [];
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        assert.equal(request.purpose, 'agent');
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:pressure-read',
          name: 'fs.read',
          input: { workspaceId: 'workspace:test', path: 'README.md' },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 9_200, outputTokens: 100, contextWindowTokens: 10_000 },
        });
        return;
      }
      if (requests.length === 2) {
        assert.equal(request.purpose, 'contextCompaction');
        assert.ok(request.messages.some((item) => (
          item.role === 'user' && item.content === '读取后继续分析当前任务'
        )));
        assert.ok(request.messages.some((item) => (
          item.role === 'tool' && item.content.includes('已读取的项目事实')
        )));
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:pressure-mid-run-summary',
          content: '同轮压缩摘要：README.md 已读取，并获得项目事实。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 1_100, outputTokens: 80, contextWindowTokens: 10_000 },
        });
        return;
      }
      assert.equal(request.purpose, 'agent');
      assert.equal(request.messages.filter((item) => (
        item.role === 'user' && item.content === '读取后继续分析当前任务'
      )).length, 1);
      assert.ok(request.messages.some((item) => (
        item.role === 'system' && item.content.includes('同轮压缩摘要')
      )));
      assert.equal(request.messages.some((item) => item.role === 'tool'), false);
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:pressure-mid-run-answer',
        content: '当前任务已基于读取结果完成。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 700, outputTokens: 40, contextWindowTokens: 10_000 },
      });
    },
  }, kernel, [readTool], 'pressure-mid-run');

  await actor.submit(message(sessionId, 'command:pressure-mid-run', '读取后继续分析当前任务'));
  const completed = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '当前任务已基于读取结果完成。'
  ));
  assert.equal(requests.length, 3);
  assert.equal(completed.terminalError, null);
  const events = await readEvents(journal, sessionId);
  const input = events.find((event) => (
    event.type === 'message.committed'
    && event.payload.content === '读取后继续分析当前任务'
  ));
  const requested = events.find((event) => (
    event.type === 'context.compaction.requested'
    && event.payload.trigger === 'pressure'
  ));
  assert.ok(input);
  assert.ok(requested.payload.coveredThroughSequence > input.sequence);
  assert.ok(events.some((event) => (
    event.type === 'context.compacted'
    && event.payload.compactionId === requested.payload.compactionId
  )));
  await actor.dispose();
});

test('Agent context.focus 作为独占 control 触发同一 Session 压缩后继续', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:agent-focus';
  await createSession(journal, sessionId);
  const requests = [];
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        assert.ok(request.tools.some((tool) => tool.name === 'context.focus'));
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider-call:focus',
          name: 'context.focus',
          input: { focus: '聚焦真实构建失败' },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 500, outputTokens: 20, contextWindowTokens: 10_000 },
        });
        return;
      }
      if (requests.length === 2) {
        assert.equal(request.purpose, 'contextCompaction');
        assert.ok(request.messages.some((item) => item.content.includes('聚焦真实构建失败')));
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:agent-focus-summary',
          content: '构建失败相关事实摘要。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 300, outputTokens: 30, contextWindowTokens: 10_000 },
        });
        return;
      }
      assert.equal(request.purpose, 'agent');
      const focusTurn = request.messages.find((item) => (
        item.role === 'assistant'
        && item.toolCalls?.some((call) => call.name === 'context.focus')
      ));
      const focusCall = focusTurn?.toolCalls?.find((call) => call.name === 'context.focus');
      assert.ok(focusCall);
      assert.ok(request.messages.some((item) => (
        item.role === 'tool'
        && item.toolCallId === focusCall.callId
        && item.content.includes('"accepted":true')
      )));
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:agent-focus-answer',
        content: '已围绕构建失败继续。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 450, outputTokens: 25, contextWindowTokens: 10_000 },
      });
    },
  }, undefined, [], 'agent-focus');

  await actor.submit(message(sessionId, 'command:agent-focus', '分析所有历史并决定焦点'));
  const completed = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '已围绕构建失败继续。'
  ));
  assert.equal(requests.length, 3);
  const events = await readEvents(journal, sessionId);
  const requested = events.find((event) => (
    event.type === 'context.compaction.requested'
    && event.payload.trigger === 'agentFocus'
  ));
  const compacted = events.find((event) => (
    event.type === 'context.compacted'
    && event.payload.compactionId === requested.payload.compactionId
  ));
  assert.notEqual(requested.callId, requested.payload.providerCallId);
  assert.equal(compacted.callId, requested.callId);
  assert.equal(completed.contextUsage.providerRequestId, requests[2].requestId);
  await actor.dispose();
});

test('Session 只按 Kernel 目录身份冻结 callable 工具快照，并排除 blocked 站位', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:kernel-tool-snapshot';
  await createSession(journal, sessionId);
  const tools = [
    {
      name: 'z.tool',
      description: 'Z callable',
      inputSchema: {
        type: 'object',
        properties: { z: { type: 'string' }, a: { type: 'number' } },
      },
      possibleEffects: [],
      availability: 'callable',
    },
    {
      name: 'process.shell',
      description: 'Shell slot',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      possibleEffects: ['process'],
      availability: 'blocked',
    },
    {
      name: 'a.tool',
      description: 'A callable',
      inputSchema: { required: ['value'], type: 'object' },
      possibleEffects: [],
      availability: 'callable',
    },
  ];
  let capturedRequest;
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      capturedRequest = request;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:tool-snapshot',
        content: '工具快照已核对。',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, {
    async listTools() { return [tools[1], tools[0], tools[2]]; },
    async execute() { throw new Error('unexpected_tool_execution'); },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  }, tools, 'tool-snapshot');
  await actor.submit(message(sessionId, 'command:start', '核对工具快照'));
  const completed = await waitFor(actor, (projection) => projection.run?.status === 'completed');
  assert.deepEqual(capturedRequest.tools.map((tool) => tool.name), [
    'interaction.request',
    'plan.publish',
    'todo.progress',
    'context.focus',
    'a.tool',
    'z.tool',
  ]);
  assert.deepEqual(Object.keys(
    capturedRequest.tools.find((tool) => tool.name === 'z.tool').inputSchema.properties,
  ), ['a', 'z']);
  assert.equal(Object.isFrozen(capturedRequest.tools), true);
  const zToolSnapshot = capturedRequest.tools.find((tool) => tool.name === 'z.tool');
  assert.equal(Object.isFrozen(zToolSnapshot), true);
  assert.equal(Object.isFrozen(zToolSnapshot.inputSchema), true);
  assert.equal(Object.isFrozen(zToolSnapshot.inputSchema.properties), true);
  assert.deepEqual(
    completed.contextCompositions.at(-1).tools.map((tool) => tool.itemId),
    ['a.tool', 'z.tool'],
  );
  assert.equal(capturedRequest.tools.some((tool) => tool.name === 'process.shell'), false);
  await actor.dispose();
});

test('Provider 普通文本在无调用 turn 中直接成为 answer', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:invalid', [binding]);
  const actor = actorWith(journal, 'session:invalid', {
    async *stream(request) {
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:invalid',
        content: '这是一段没有结构化的自由文本。',
      });
      yield providerEvent(request.requestId, 'completed', {});
    },
  });
  await actor.submit(message('session:invalid', 'command:start', '测试格式边界'));
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.messages.at(-1).content, '这是一段没有结构化的自由文本。');
  assert.equal(completed.narratives.length, 0);
  assert.equal(completed.terminalError, null);
  await actor.dispose();
});

test('首个非法 Session control 持久拒绝与用量，并在同一 run 给 Provider 一次纠正机会', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:control-invalid');
  let turn = 0;
  const actor = actorWith(journal, 'session:control-invalid', {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:control-invalid',
          content: '正在准备修改计划。',
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'plan:invalid:first',
          name: 'plan.publish',
          input: {
            title: '无效计划',
            summary: '缺少步骤。',
            steps: [],
            mutationManifest: [],
          },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 12, outputTokens: 3, contextWindowTokens: 1_000 },
        });
        return;
      }
      const controlCall = request.messages
        .find((entry) => entry.role === 'assistant' && entry.toolCalls?.length)
        ?.toolCalls.find((call) => call.name === 'plan.publish');
      assert.ok(controlCall);
      assert.notEqual(controlCall.callId, 'plan:invalid:first');
      const rejection = request.messages.find(
        (entry) => entry.role === 'tool' && entry.toolCallId === controlCall.callId,
      );
      assert.deepEqual(JSON.parse(rejection.content), {
        accepted: false,
        error: {
          code: 'session_control_plan_steps_invalid',
          message: 'plan.publish steps 必须包含一至十二个步骤。',
        },
      });
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:control-corrected',
        content: '已确认当前不执行文件修改。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 18, outputTokens: 4, contextWindowTokens: 1_000 },
      });
    },
  });
  await actor.submit(message('session:control-invalid', 'command:start', '测试 control 边界'));
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.messages.at(-1).content, '已确认当前不执行文件修改。');
  assert.equal(completed.narratives.at(-1).content, '正在准备修改计划。');
  assert.equal(completed.tokenUsage.providerCallCount, 2);
  assert.equal(completed.tokenUsage.inputTokens, 30);
  assert.equal(completed.tokenUsage.outputTokens, 7);
  assert.equal(completed.terminalError, null);
  const rejections = (await readEvents(journal, 'session:control-invalid'))
    .filter((event) => event.type === 'session.control.rejected');
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].payload.providerCallId, 'plan:invalid:first');
  assert.notEqual(rejections[0].callId, 'plan:invalid:first');
  assert.equal(rejections[0].payload.error.code, 'session_control_plan_steps_invalid');
  await actor.dispose();
});

test('同一 run 第二个非法 Session control 先持久用量与拒绝，再以原错误终止', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:control-invalid-twice');
  let turn = 0;
  const actor = actorWith(journal, 'session:control-invalid-twice', {
    async *stream(request) {
      turn += 1;
      yield providerEvent(request.requestId, 'tool.call', {
        callId: `plan:invalid:${turn}`,
        name: 'plan.publish',
        input: {
          title: `无效计划 ${turn}`,
          summary: '缺少步骤。',
          steps: [],
          mutationManifest: [],
        },
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 10 + turn, outputTokens: turn, contextWindowTokens: 1_000 },
      });
    },
  });
  await actor.submit(message(
    'session:control-invalid-twice',
    'command:start',
    '测试重复 control 拒绝',
  ));
  const failed = await waitFor(actor, (p) => p.run?.status === 'failed');
  assert.equal(failed.terminalError.code, 'session_control_plan_steps_invalid');
  assert.equal(failed.tokenUsage.providerCallCount, 2);
  assert.equal(failed.tokenUsage.inputTokens, 23);
  assert.equal(failed.tokenUsage.outputTokens, 3);
  const events = await readEvents(journal, 'session:control-invalid-twice');
  assert.equal(events.filter((event) => event.type === 'context.updated').length, 2);
  assert.equal(events.filter((event) => event.type === 'session.control.rejected').length, 2);
  await actor.dispose();
});

test('非 workspace effect 通过独立 approval 事实采集决定并沿同一 Kernel 端口继续', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:external');
  const executions = [];
  const kernel = {
    async listTools() { return [externalTool]; },
    async execute(request) {
      executions.push(request);
      if (executions.length === 1) {
        return {
          schemaVersion: 'deepcode.kernel-reply',
          type: 'tool.execution',
          requestId: request.requestId,
          callId: request.callId,
          status: 'approvalRequired',
          approvalId: 'approval:external',
          preview: {
            summary: '执行外部 effect',
            effects: ['external'],
            logicalTargets: ['example'],
          },
        };
      }
      assert.equal(request.nonWorkspaceAuthority.decision, 'allow');
      return executionReply(request, {
        decision: 'allow',
        source: 'user',
        authorityId: request.nonWorkspaceAuthority.authorityId,
      });
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  let turn = 0;
  const actor = actorWith(journal, 'session:external', {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'call:external', name: externalTool.name, input: { target: 'example' },
        });
      } else {
        assert.ok(request.messages.some((item) => item.role === 'tool'));
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:done', content: '外部操作已经完成。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, kernel, [externalTool], 'external');
  await actor.submit(message('session:external', 'command:start', '执行外部操作'));
  const waiting = await waitFor(actor, (p) => p.pendingApproval !== null);
  assert.equal(waiting.pendingInteraction, null);
  assert.equal(waiting.pendingApproval.approvalId, 'approval:external');
  assert.equal((await actor.submit(approval(
    'session:external',
    'command:allow',
    waiting.run.runId,
    waiting.pendingApproval.callId,
    waiting.pendingApproval.approvalId,
    'allow',
  ))).status, 'accepted');
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.pendingApproval, null);
  const externalRequest = (await readEvents(journal, 'session:external'))
    .find((event) => event.type === 'tool.requested');
  assert.equal(externalRequest.payload.providerCallId, 'call:external');
  assert.notEqual(externalRequest.callId, 'call:external');
  assert.equal(
    completed.activities.find((item) => item.callId === externalRequest.callId)?.status,
    'completed',
  );
  assert.equal(executions.length, 2);
  await actor.dispose();
});

test('Plan 确认原子生成 Todo 与 session scoped 精确 authority', async () => {
  const planBinding = { workspaceId: 'workspace:plan', displayName: 'PlanProject' };
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:plan-select', [planBinding]);
  const executions = [];
  const kernel = {
    async listTools() { return [writeTool]; },
    async execute(request) {
      executions.push(request);
      assert.deepEqual(request.workspaceBindings, ['workspace:plan']);
      assert.equal(request.planAuthorities.length, 1);
      const authority = request.planAuthorities[0];
      assert.deepEqual(
        [authority.sessionId, authority.workspaceId],
        [request.sessionId, 'workspace:plan'],
      );
      assert.equal(authority.revision, 1);
      assert.ok(authority.decisionId);
      assert.equal('runId' in authority, false);
      assert.deepEqual(authority.coveredOperations, [{
        workspaceId: 'workspace:plan', operation: 'fs.write', target: 'src/output.txt',
      }]);
      return executionReply(request, {
        decision: 'allow', source: 'plan', workspaceId: 'workspace:plan',
        authorityId: authority.authorityId, planId: authority.planId,
        revision: authority.revision, decisionId: authority.decisionId,
      }, 'src/output.txt');
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  let turn = 0;
  const actor = actorWith(journal, 'session:plan-select', {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'plan:write',
          name: 'plan.publish',
          input: {
            title: '写入目标文件',
            summary: '只修改一个精确目标。',
            steps: [{
              stepId: 'step:write',
              title: '写入文件',
              details: '写入 src/output.txt。',
              verification: ['确认工具回执为 completed。'],
            }],
            mutationManifest: [{
                workspaceId: 'workspace:plan', operation: 'fs.write', target: 'src/output.txt',
            }],
          },
        });
      } else if (turn === 2 || turn === 4) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: turn === 2 ? 'call:write' : 'call:write:supplement',
          name: 'fs.write',
          input: { workspaceId: 'workspace:plan', path: 'src/output.txt', content: 'hello' },
        });
      } else {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: turn === 3 ? 'message:done' : 'message:supplement-done',
          content: turn === 3 ? '已按所选计划完成写入。' : '补充说明未改变已确认计划。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, kernel, [writeTool], 'plan-select');
  await actor.submit(message('session:plan-select', 'command:start', '写入文件'));
  const waiting = await waitFor(actor, (p) => p.pendingPlan !== null);
  assert.equal(waiting.pendingPlan.responseMode, 'confirmReviseOrCancel');
  assert.equal(waiting.pendingPlan.status, 'published');
  assert.equal(waiting.pendingPlan.revision, 1);
  assert.deepEqual(waiting.pendingPlan.mutationManifest, [{
    workspaceId: 'workspace:plan', operation: 'fs.write', target: 'src/output.txt',
  }]);
  assert.equal((await actor.submit(planResponse(
    'session:plan-select',
    'command:confirm',
    waiting.run.runId,
    waiting.pendingPlan.planId,
    waiting.pendingPlan.revision,
    { kind: 'confirm' },
  ))).status, 'accepted');
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.pendingPlan, null);
  assert.deepEqual(completed.activePlanRef, {
    planId: waiting.pendingPlan.planId,
    revision: 1,
  });
  assert.equal(completed.plans.at(-1).status, 'confirmed');
  assert.equal(completed.todoList.sourcePlanId, waiting.pendingPlan.planId);
  assert.equal(completed.todoList.sourcePlanRevision, 1);
  assert.deepEqual(completed.todoList.items.map((item) => ({
    sourceStepId: item.sourceStepId,
    label: item.label,
    status: item.status,
  })), [{ sourceStepId: 'step:write', label: '写入文件', status: 'pending' }]);
  assert.equal(executions.length, 1);
  const writeRequest = (await readEvents(journal, 'session:plan-select'))
    .find((event) => event.type === 'tool.requested');
  assert.equal(writeRequest.payload.providerCallId, 'call:write');
  assert.notEqual(writeRequest.callId, 'call:write');
  assert.equal(
    completed.activities.find((item) => item.callId === writeRequest.callId)?.status,
    'completed',
  );

  const retainedPlan = completed.plans;
  const retainedTodo = completed.todoList;
  await actor.submit(message(
    'session:plan-select',
    'command:supplement',
    '补充说明，不改变已确认计划',
  ));
  const supplemented = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '补充说明未改变已确认计划。'
  ));
  assert.deepEqual(supplemented.plans, retainedPlan);
  assert.deepEqual(supplemented.todoList, retainedTodo);
  assert.deepEqual(supplemented.activePlanRef, completed.activePlanRef);
  assert.equal(executions.length, 2);
  assert.notEqual(executions[0].runId, executions[1].runId);
  assert.equal(
    executions[0].planAuthorities[0].authorityId,
    executions[1].planAuthorities[0].authorityId,
  );
  await actor.dispose();
});

test('Plan 修订保留同一 PlanId、递增 revision 并使旧 revision superseded', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:feedback', [binding]);
  const requests = [];
  let turn = 0;
  const actor = actorWith(journal, 'session:feedback', {
    async *stream(request) {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', simplePlanCall('plan:feedback'));
      } else if (turn === 2) {
        assert.equal(request.responseConstraint, 'normal');
        assert.ok(request.messages.some((item) => (
          item.role === 'user' && item.content === '改为只写 docs/notes.md'
        )));
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'plan:feedback:revised',
          name: 'plan.publish',
          input: {
            title: '写入修订说明',
            summary: '只修改修订后的目标。',
            steps: [{
              stepId: 'step:write',
              title: '写入修订说明',
              details: '写入 docs/notes.md。',
            }],
            mutationManifest: [{
              workspaceId: 'workspace:test', operation: 'fs.write', target: 'docs/notes.md',
            }],
          },
        });
      } else {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:answer', content: '修订后的计划已确认。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  });
  await actor.submit(message('session:feedback', 'command:start', '给出计划'));
  const waiting = await waitFor(actor, (p) => p.pendingPlan !== null);
  await actor.submit(planResponse(
    'session:feedback',
    'command:feedback',
    waiting.run.runId,
    waiting.pendingPlan.planId,
    waiting.pendingPlan.revision,
    { kind: 'requestRevision', text: '改为只写 docs/notes.md' },
  ));
  const revised = await waitFor(actor, (p) => p.pendingPlan?.revision === 2);
  assert.equal(revised.pendingPlan.planId, waiting.pendingPlan.planId);
  assert.notEqual(revised.pendingPlan.callId, waiting.pendingPlan.callId);
  assert.equal(revised.pendingPlan.mutationManifest[0].target, 'docs/notes.md');
  await actor.submit(planResponse(
    'session:feedback',
    'command:confirm-revision',
    revised.run.runId,
    revised.pendingPlan.planId,
    revised.pendingPlan.revision,
    { kind: 'confirm' },
  ));
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.deepEqual(completed.plans.map((plan) => [plan.revision, plan.status]), [
    [1, 'superseded'],
    [2, 'confirmed'],
  ]);
  const events = await readEvents(journal, 'session:feedback');
  assert.equal(events.filter((event) => event.type === 'plan.revision.requested').length, 1);
  assert.equal(events.filter((event) => event.type === 'plan.superseded').length, 1);
  assert.equal(events.filter((event) => event.type === 'plan.confirmed').length, 1);
  assert.equal(requests.length, 3);
  await actor.dispose();
});

test('Plan 取消关闭 pending Plan 且不生成 authority 或 Todo', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:ignore', [binding]);
  const actor = actorWith(journal, 'session:ignore', {
    async *stream(request) {
      yield providerEvent(request.requestId, 'tool.call', simplePlanCall('plan:ignore'));
      yield providerEvent(request.requestId, 'completed', {});
    },
  });
  await actor.submit(message('session:ignore', 'command:start', '给出计划'));
  const waiting = await waitFor(actor, (p) => p.pendingPlan !== null);
  await actor.submit(planResponse(
    'session:ignore',
    'command:ignore',
    waiting.run.runId,
    waiting.pendingPlan.planId,
    waiting.pendingPlan.revision,
    { kind: 'cancel' },
  ));
  const cancelled = await waitFor(actor, (p) => p.run?.status === 'cancelled');
  assert.equal(cancelled.pendingPlan, null);
  assert.equal(cancelled.activePlanRef, null);
  assert.equal(cancelled.todoList, null);
  assert.equal(cancelled.plans[0].status, 'cancelled');
  assert.deepEqual(cancelled.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '给出计划' },
  ]);
  const events = await readEvents(journal, 'session:ignore');
  assert.equal(events.filter((event) => event.type === 'plan.cancelled').length, 1);
  assert.equal(events.some((event) => event.type === 'plan.confirmed'), false);
  assert.equal(events.some((event) => event.type === 'todo.seeded'), false);
  assert.deepEqual(
    events.filter((event) => event.type === 'run.settled').map((event) => event.payload.outcome),
    ['cancelled'],
  );
  await actor.dispose();
});

test('Provider 跨 turn 复用原生 callId 时 Session 生成独立 LogicalCallId', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:logical-call', [binding]);
  const readTool = {
    name: 'fs.read',
    description: '读取工作区文件',
    inputSchema: { type: 'object' },
    possibleEffects: [],
    availability: 'callable',
  };
  const executedCallIds = [];
  const kernel = {
    async listTools() { return [readTool]; },
    async execute(request) {
      executedCallIds.push(request.callId);
      return executionReply(request, {
        decision: 'allow', source: 'workspaceRead', workspaceId: 'workspace:test',
      }, String(request.input.path));
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  let turn = 0;
  const actor = actorWith(journal, 'session:logical-call', {
    async *stream(request) {
      turn += 1;
      if (turn <= 2) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider:reused',
          name: 'fs.read',
          input: { workspaceId: 'workspace:test', path: `file-${turn}.txt` },
        });
      } else {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:logical-call',
          content: '两个读取调用均已完成。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, kernel, [readTool], 'logical-call');

  await actor.submit(message('session:logical-call', 'command:start', '连续读取两个文件'));
  const completed = await waitFor(actor, (projection) => projection.run?.status === 'completed');
  assert.equal(completed.terminalError, null);
  const requests = (await readEvents(journal, 'session:logical-call'))
    .filter((event) => event.type === 'tool.requested');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map((event) => event.payload.providerCallId), [
    'provider:reused',
    'provider:reused',
  ]);
  assert.equal(new Set(requests.map((event) => event.callId)).size, 2);
  assert.ok(requests.every((event) => event.callId !== event.payload.providerCallId));
  assert.deepEqual(executedCallIds, requests.map((event) => event.callId));
  await actor.dispose();
});

test('同一 Provider turn 的 reasoning 只瞬态关联全部 LogicalCallId 并用于多工具续轮', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:multi-tool-reasoning';
  await createSession(journal, sessionId, [binding]);
  const readTool = {
    name: 'fs.read',
    description: '读取工作区文件',
    inputSchema: { type: 'object' },
    possibleEffects: [],
    availability: 'callable',
  };
  const kernel = {
    async listTools() { return [readTool]; },
    async execute(request) {
      return executionReply(request, {
        decision: 'allow', source: 'workspaceRead', workspaceId: 'workspace:test',
      }, String(request.input.path));
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  const requests = [];
  let turn = 0;
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      requests.push(request);
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:multi-tool',
          content: '',
          reasoningContent: 'private reasoning for both reads',
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider:read-a',
          name: 'fs.read',
          input: { workspaceId: 'workspace:test', path: 'a.txt' },
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider:read-b',
          name: 'fs.read',
          input: { workspaceId: 'workspace:test', path: 'b.txt' },
        });
      } else {
        const assistantTurn = request.messages.find((item) => (
          item.role === 'assistant' && item.toolCalls?.length === 2
        ));
        assert.ok(assistantTurn);
        assert.equal(assistantTurn.reasoningContent, 'private reasoning for both reads');
        assert.deepEqual(
          assistantTurn.toolCalls.map((call) => call.name),
          ['fs.read', 'fs.read'],
        );
        assert.equal(new Set(assistantTurn.toolCalls.map((call) => call.callId)).size, 2);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:multi-tool-answer',
          content: '两个文件均已读取。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, kernel, [readTool], 'multi-tool-reasoning');

  await actor.submit(message(sessionId, 'command:start', '读取两个文件'));
  const completed = await waitFor(actor, (projection) => projection.run?.status === 'completed');
  assert.equal(requests.length, 2);
  assert.equal(completed.messages.at(-1).content, '两个文件均已读取。');
  assert.doesNotMatch(
    JSON.stringify(await readEvents(journal, sessionId)),
    /private reasoning for both reads/u,
  );
  assert.doesNotMatch(JSON.stringify(completed), /private reasoning for both reads/u);
  await actor.dispose();
});

test('Provider 续轮失败不改写已完成工具、已确认 Plan 或 Todo 投影', async () => {
  const journal = new InMemoryCommandJournal();
  const sessionId = 'session:tool-completed-provider-failed';
  await createSession(journal, sessionId, [binding]);
  const ensureDirectoryTool = {
    name: 'fs.ensure_directory',
    description: '确保工作区目录存在',
    inputSchema: { type: 'object' },
    possibleEffects: ['workspaceMutation'],
    availability: 'callable',
  };
  const kernel = {
    async listTools() { return [ensureDirectoryTool]; },
    async execute(request) {
      const authority = request.planAuthorities[0];
      assert.ok(authority);
      return executionReply(request, {
        decision: 'allow',
        source: 'plan',
        workspaceId: 'workspace:test',
        authorityId: authority.authorityId,
        planId: authority.planId,
        revision: authority.revision,
        decisionId: authority.decisionId,
      }, String(request.input.path));
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  let turn = 0;
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider:plan',
          name: 'plan.publish',
          input: {
            title: '创建项目目录',
            summary: '创建 include 与 src 目录。',
            steps: [{
              stepId: 'step:directories',
              title: '创建 include 与 src 目录',
              details: '执行两个精确目录创建操作。',
            }],
            mutationManifest: [
              {
                workspaceId: 'workspace:test',
                operation: 'fs.ensure_directory',
                target: 'include',
              },
              {
                workspaceId: 'workspace:test',
                operation: 'fs.ensure_directory',
                target: 'src',
              },
            ],
          },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      if (turn === 2) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider:mkdir-include',
          name: 'fs.ensure_directory',
          input: { workspaceId: 'workspace:test', path: 'include' },
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'provider:mkdir-src',
          name: 'fs.ensure_directory',
          input: { workspaceId: 'workspace:test', path: 'src' },
        });
        yield providerEvent(request.requestId, 'completed', {});
        return;
      }
      yield providerEvent(request.requestId, 'failed', {
        code: 'provider_http_failed',
        message: 'Provider 返回 HTTP 400。',
      });
    },
  }, kernel, [ensureDirectoryTool], 'tool-completed-provider-failed');

  await actor.submit(message(sessionId, 'command:start', '创建目录'));
  const waiting = await waitFor(actor, (projection) => projection.pendingPlan !== null);
  await actor.submit(planResponse(
    sessionId,
    'command:confirm',
    waiting.run.runId,
    waiting.pendingPlan.planId,
    waiting.pendingPlan.revision,
    { kind: 'confirm' },
  ));
  const failed = await waitFor(actor, (projection) => projection.run?.status === 'failed');
  assert.equal(failed.terminalError.code, 'provider_http_failed');
  assert.equal(failed.terminalError.message, 'Provider 返回 HTTP 400。');
  assert.deepEqual(
    failed.activities.filter((activity) => activity.kind === 'tool').map((activity) => (
      [activity.tool.operation, activity.tool.resources[0].logicalPath, activity.status]
    )),
    [
      ['fs.ensure_directory', 'include', 'completed'],
      ['fs.ensure_directory', 'src', 'completed'],
    ],
  );
  assert.equal(failed.plans.at(-1).status, 'confirmed');
  assert.equal(failed.todoList.items[0].status, 'pending');
  assert.deepEqual(failed.activePlanRef, {
    planId: waiting.pendingPlan.planId,
    revision: waiting.pendingPlan.revision,
  });
  assert.deepEqual(failed.messages.map(({ role, content }) => ({ role, content })), [
    { role: 'user', content: '创建目录' },
  ]);
  await actor.dispose();
});

test('LLM Todo、Provider 缓存用量与 PreparedEffect 资源由同一共享投影确定', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:projection-facts', [binding]);
  const readTool = {
    name: 'fs.read',
    description: '读取工作区文件',
    inputSchema: { type: 'object' },
    possibleEffects: [],
    availability: 'callable',
  };
  const kernel = {
    async listTools() { return [readTool]; },
    async execute(request) {
      return executionReply(request, {
        decision: 'allow', source: 'workspaceRead', workspaceId: 'workspace:test',
      }, 'README.md');
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  let turn = 0;
  let seededTodo;
  let releaseSecondRun;
  const secondRunPaused = new Promise((resolve) => { releaseSecondRun = resolve; });
  const actor = actorWith(journal, 'session:projection-facts', {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'plan:projection-facts',
          name: 'plan.publish',
          input: {
            title: '读取并分析项目入口',
            summary: '读取 README 并整理结论。',
            steps: [
              { stepId: 'step:inspect', title: '读取项目入口', details: '读取 README。' },
              { stepId: 'step:answer', title: '整理结论', details: '形成最终答复。' },
            ],
            mutationManifest: [],
          },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 12, outputTokens: 3, contextWindowTokens: 1_000 },
        });
        return;
      }
      if (turn === 2) {
        const todoFact = request.messages
          .filter((item) => item.role === 'system')
          .map((item) => {
            try { return JSON.parse(item.content); } catch { return null; }
          })
          .find((item) => item?.type === 'todo.seeded');
        assert.ok(todoFact);
        seededTodo = todoFact;
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'todo:read',
          name: 'todo.progress',
          input: {
            planId: todoFact.sourcePlanId,
            revision: todoFact.sourcePlanRevision,
            updates: [
              { todoId: todoFact.items[0].todoId, status: 'inProgress' },
              { todoId: todoFact.items[1].todoId, status: 'pending' },
            ],
          },
        });
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'call:read',
          name: 'fs.read',
          input: { workspaceId: 'workspace:test', path: 'README.md' },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: {
            inputTokens: 100,
            outputTokens: 10,
            contextWindowTokens: 1_000,
            cacheReadInputTokens: 70,
            cacheMissInputTokens: 30,
          },
        });
        return;
      }
      if (turn === 3) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'todo:done',
          name: 'todo.progress',
          input: {
            planId: seededTodo.sourcePlanId,
            revision: seededTodo.sourcePlanRevision,
            updates: [
              { todoId: seededTodo.items[0].todoId, status: 'completed' },
              { todoId: seededTodo.items[1].todoId, status: 'completed' },
            ],
          },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 20, outputTokens: 5, contextWindowTokens: 1_000 },
        });
        return;
      }
      if (turn === 4) {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:projection-facts',
          content: '读取与分析完成。',
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 8, outputTokens: 2, contextWindowTokens: 1_000 },
        });
        return;
      }
      await secondRunPaused;
      yield providerEvent(request.requestId, 'assistant.message', {
        messageId: 'message:second-run',
        content: '第二轮完成。',
      });
      yield providerEvent(request.requestId, 'completed', {
        usage: { inputTokens: 4, outputTokens: 1, contextWindowTokens: 1_000 },
      });
    },
  }, kernel, [readTool], 'projection-facts');

  await actor.submit(message(
    'session:projection-facts', 'command:first', '读取 README 并分析',
  ));
  const planWaiting = await waitFor(actor, (projection) => projection.pendingPlan !== null);
  await actor.submit(planResponse(
    'session:projection-facts',
    'command:confirm-plan',
    planWaiting.run.runId,
    planWaiting.pendingPlan.planId,
    planWaiting.pendingPlan.revision,
    { kind: 'confirm' },
  ));
  const completed = await waitFor(actor, (projection) => (
    ['completed', 'failed', 'indeterminate'].includes(projection.run?.status)
  ));
  assert.equal(
    completed.run.status,
    'completed',
    JSON.stringify(completed.terminalError),
  );
  assert.deepEqual(completed.todoList.items, [
    {
      todoId: seededTodo.items[0].todoId,
      sourceStepId: 'step:inspect',
      label: '读取项目入口',
      status: 'completed',
    },
    {
      todoId: seededTodo.items[1].todoId,
      sourceStepId: 'step:answer',
      label: '整理结论',
      status: 'completed',
    },
  ]);
  assert.equal(completed.todoList.sourcePlanId, planWaiting.pendingPlan.planId);
  assert.equal(completed.todoList.sourcePlanRevision, 1);
  assert.equal(completed.plans[0].status, 'completed');
  assert.equal(completed.activePlanRef, null);
  assert.deepEqual(completed.tokenUsage, {
    providerCallCount: 4,
    inputTokens: 140,
    outputTokens: 20,
    cacheReadInputTokens: 70,
    cacheMissInputTokens: 30,
    cacheReportedCallCount: 1,
  });
  assert.equal(completed.contextUsage.inputTokens, 8);
  assert.equal(completed.contextUsage.outputTokens, 2);
  assert.equal(completed.contextUsage.contextWindowTokens, 1_000);
  assert.equal(
    completed.contextCompositions.at(-1).providerRequestId,
    completed.contextUsage.providerRequestId,
  );
  assert.deepEqual(completed.tokenUsageHistory.map((round) => ({
    title: round.title,
    providerCallCount: round.providerCallCount,
    inputTokens: round.inputTokens,
    outputTokens: round.outputTokens,
    cacheReportedCallCount: round.cacheReportedCallCount,
    outcome: round.outcome,
  })), [{
    title: '读取 README 并分析',
    providerCallCount: 4,
    inputTokens: 140,
    outputTokens: 20,
    cacheReportedCallCount: 1,
    outcome: 'completed',
  }]);
  const requested = (await readEvents(journal, 'session:projection-facts'))
    .find((event) => (
      event.type === 'tool.requested' && event.payload.providerCallId === 'call:read'
    ));
  assert.notEqual(requested.callId, 'call:read');
  const activity = completed.activities.find((item) => item.callId === requested.callId);
  assert.equal(activity.status, 'completed');
  assert.deepEqual(activity.tool, {
    operation: 'fs.read',
    resources: [{
      kind: 'workspacePath',
      label: 'README.md',
      workspaceId: 'workspace:test',
      logicalPath: 'README.md',
    }],
  });
  assert.equal(activity.sequence, requested.sequence);

  await actor.submit(message(
    'session:projection-facts', 'command:second', '继续回答',
  ));
  const secondRunning = await waitFor(actor, (projection) => (
    projection.run?.status === 'running' && projection.messages.at(-1)?.content === '继续回答'
  ));
  assert.deepEqual(secondRunning.todoList, completed.todoList);
  assert.deepEqual(secondRunning.plans, completed.plans);
  releaseSecondRun();
  const secondCompleted = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '第二轮完成。'
  ));
  assert.equal(secondCompleted.tokenUsage.providerCallCount, 5);
  assert.equal(secondCompleted.tokenUsage.cacheReportedCallCount, 1);
  assert.deepEqual(secondCompleted.tokenUsageHistory.map((round) => round.title), [
    '继续回答',
    '读取 README 并分析',
  ]);
  assert.equal(secondCompleted.tokenUsageHistory[0].providerCallCount, 1);
  await actor.dispose();
});

test('process.shell 使用 canonical 默认参数投影命令与执行结果', async () => {
  const sessionId = 'session:shell-activity';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [binding]);
  const shellTool = {
    name: 'process.shell',
    description: '在绑定工作区内运行项目调试命令',
    inputSchema: { type: 'object' },
    possibleEffects: ['process'],
    availability: 'callable',
  };
  const kernel = {
    async listTools() { return [shellTool]; },
    async execute(request) {
      return executionReply(request, {
        decision: 'allow', source: 'workspaceBinding', workspaceId: 'workspace:test',
      }, '.', {
        workspaceId: 'workspace:test',
        command: 'make build',
        cwd: '.',
        stdout: 'building\nfinished\n',
        stderr: 'warning: example\n',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
        capturedBytes: 36,
        durationMs: 842,
        environment: {
          shell: '/bin/sh',
          interactive: false,
          pathSource: 'hostPlusStandardDeveloperPaths',
          writeScope: 'workspaceAndKernelTemporary',
          homeWritable: false,
        },
      }, {
        command: 'make build',
        cwd: '.',
        timeoutMs: 120_000,
        maxOutputBytes: 262_144,
      });
    },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
  let turn = 0;
  const actor = actorWith(journal, sessionId, {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'call:shell',
          name: 'process.shell',
          input: {
            workspaceId: 'workspace:test',
            command: 'make build',
            timeoutMs: 120_000,
          },
        });
      } else {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:shell-finished',
          content: '构建命令已运行。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, kernel, [shellTool], 'shell-activity');

  await actor.submit(message(sessionId, 'command:start', '运行构建'));
  const completed = await waitFor(actor, (projection) => projection.run?.status === 'completed');
  const activity = completed.activities.find((item) => item.kind === 'tool');
  assert.deepEqual(activity.tool, {
    operation: 'process.shell',
    resources: [{
      kind: 'workspacePath',
      label: '.',
      workspaceId: 'workspace:test',
      logicalPath: '.',
    }],
    shell: {
      command: 'make build',
      cwd: '.',
      result: {
        stdout: 'building\nfinished\n',
        stderr: 'warning: example\n',
        exitCode: 0,
        success: true,
        timedOut: false,
        truncated: false,
        capturedBytes: 36,
        durationMs: 842,
        environment: {
          shell: '/bin/sh',
          interactive: false,
          pathSource: 'hostPlusStandardDeveloperPaths',
          writeScope: 'workspaceAndKernelTemporary',
          homeWritable: false,
        },
      },
    },
  });
  await actor.dispose();
});

test('取消命令先持久化，再中止活动 Provider 流并收敛为 cancelled', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:cancel');
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const actor = actorWith(journal, 'session:cancel', {
    async *stream(request, signal) {
      startedResolve();
      yield providerEvent(request.requestId, 'text.delta', { text: '处理中' });
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      throw new Error('provider_cancelled');
    },
  });
  await actor.submit(message('session:cancel', 'command:start', '等待取消'));
  await started;
  const running = await waitFor(actor, (p) => p.run?.status === 'running');
  const command = {
    schemaVersion: 'deepcode.command',
    type: 'run.cancel',
    commandId: 'command:cancel',
    sessionId: 'session:cancel',
    runId: running.run.runId,
  };
  assert.equal((await actor.submit(command)).status, 'accepted');
  const cancelled = await waitFor(actor, (p) => p.run?.status === 'cancelled');
  assert.equal(cancelled.pendingInteraction, null);
  assert.equal(cancelled.pendingPlan, null);
  assert.equal((await actor.submit(command)).status, 'replayed');
  await actor.dispose();
});

function serviceWith(journal, inputs) {
  return new SessionService(journal, {
    async create(input) {
      inputs.push(input);
      return { composition: composition({ async *stream() {} }) };
    },
  });
}

function actorWith(
  journal,
  sessionId,
  providerPort,
  kernel,
  tools = [],
  prefix = 'test',
) {
  return new SessionActor(
    sessionId,
    journal,
    composition(providerPort, kernel ?? emptyKernel(), tools),
    { nextId: idFactory(prefix) },
  );
}

function composition(providerPort, kernel = emptyKernel(), tools = []) {
  return {
    instructions: [{ id: 'core', text: '你是本地编码 Agent。' }],
    contextProviders: [],
    toolIds: tools.map((tool) => tool.name),
    provider: providerPort,
    memory: { id: 'complete', select: ({ messages }) => messages },
    observers: [],
    kernel,
    async dispose() {},
  };
}

function emptyKernel() {
  return {
    async listTools() { return []; },
    async execute() { throw new Error('unexpected_tool_execution'); },
    async cancel(callId, attemptId) { return cancelNotFound(callId, attemptId); },
    async readRecord() { return null; },
  };
}

function cancelNotFound(callId, attemptId) {
  return {
    schemaVersion: 'deepcode.kernel-reply',
    type: 'tool.cancelled',
    requestId: 'cancel:unused',
    callId,
    attemptId,
    status: 'notFound',
  };
}

function executionReply(
  request,
  authority,
  logicalTarget = 'example',
  output = { changed: true },
  canonicalArguments = request.input,
) {
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
      callId: request.callId,
      attemptId: request.attemptId,
      toolName: request.toolName,
      input: request.input,
      preparedEffect: {
        callId: request.callId,
        attemptId: request.attemptId,
        sessionId: request.sessionId,
        runId: request.runId,
        toolName: request.toolName,
        ...(request.input.workspaceId ? { workspaceId: request.input.workspaceId } : {}),
        operation: request.toolName,
        logicalTargets: [logicalTarget],
        canonicalInvocation: { toolName: request.toolName, arguments: canonicalArguments },
      },
      authority,
      startedAt: '2026-08-24T00:00:00.000Z',
      completedAt: '2026-08-24T00:00:01.000Z',
      outcome: 'completed',
      output,
    },
  };
}

function providerEvent(requestId, type, data) {
  return { schemaVersion: 'deepcode.provider-event', requestId, type, data };
}

function message(
  sessionId,
  commandId,
  text,
  profileId,
  attachments,
  directoryAttachments,
) {
  return {
    schemaVersion: 'deepcode.command',
    type: 'message.submit',
    commandId,
    sessionId,
    text,
    ...(attachments?.length ? { attachments } : {}),
    ...(directoryAttachments?.length ? { directoryAttachments } : {}),
    ...(profileId ? { profileId } : {}),
  };
}

function profile(sessionId, commandId, runId, profileId) {
  return {
    schemaVersion: 'deepcode.command', type: 'run.profile.select',
    commandId, sessionId, runId, profileId,
  };
}

function interaction(sessionId, commandId, runId, interactionId, response) {
  return {
    schemaVersion: 'deepcode.command', type: 'interaction.respond',
    commandId, sessionId, runId, interactionId, response,
  };
}

function approval(sessionId, commandId, runId, callId, approvalId, decision) {
  return {
    schemaVersion: 'deepcode.command', type: 'approval.respond',
    commandId, sessionId, runId, callId, approvalId, decision,
  };
}

function planResponse(sessionId, commandId, runId, planId, revision, response) {
  return {
    schemaVersion: 'deepcode.command', type: 'plan.respond',
    commandId, sessionId, runId, planId, revision, response,
  };
}

function simplePlanCall(callId) {
  return {
    callId,
    name: 'plan.publish',
    input: {
      title: '写入说明',
      summary: '写入一份项目说明。',
      steps: [{
        stepId: 'step:write',
        title: '写入说明',
        details: '写入 docs/plan.md。',
      }],
      mutationManifest: [{
          workspaceId: 'workspace:test', operation: 'fs.write', target: 'docs/plan.md',
      }],
    },
  };
}

async function createSession(journal, sessionId, workspaceBindings = []) {
  await journal.createSession({ sessionId, displayTitle: '新对话', workspaceBindings });
}

async function readEvents(journal, sessionId) {
  const events = [];
  for await (const event of journal.read(sessionId)) events.push(event);
  return events;
}

function idFactory(prefix) {
  let next = 0;
  return (kind) => `${prefix}:${kind}:${++next}`;
}

async function waitFor(actor, predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const projection = await actor.snapshot();
    if (predicate(projection)) return projection;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`等待 Session 投影超时：${JSON.stringify(await actor.snapshot())}`);
}
