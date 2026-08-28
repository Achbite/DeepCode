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

test('Todo label whitespace is rejected at the Session control boundary', () => {
  assert.throws(
    () => decodeSessionControlCall('todo:call', 'todo.update', {
      items: [{ todoId: 'inspect', label: ' 读取项目入口', status: 'pending' }],
    }),
    (error) => error?.code === 'session_control_todo_label_invalid',
  );
  assert.throws(
    () => decodeSessionControlCall('todo:call', 'todo.update', {
      items: [{ todoId: 'inspect', label: '读取项目入口 ', status: 'pending' }],
    }),
    (error) => error?.code === 'session_control_todo_label_invalid',
  );
});

test('共享系统提示词与 Skill 插件配置保持独立贡献', () => {
  const config = decodeStartupPluginConfig(JSON.stringify({
    systemPrompt: '使用函数式组合，并保持层间透明。',
    skills: [{ id: 'example', instructions: '只处理示例领域。' }],
  }));
  assert.equal(config.systemPrompt, '使用函数式组合，并保持层间透明。');
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
    responseConstraint: 'normal',
    categories: [],
    sequence: 1,
    createdAt: '2026-08-25T00:00:00.000Z',
  });
  assert.throws(() => reduceSession(state, {
    schemaVersion: 'deepcode.session-event.v2',
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
    schemaVersion: 'deepcode.session-event.v2',
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

test('schema 5 分类摘要只按旧事实恢复，不伪造新的 Provider 请求结构', () => {
  const state = emptySessionState('session:legacy-context');
  state.run = {
    runId: 'run:legacy-context',
    status: 'running',
    workspaceBindings: [],
  };
  const restored = reduceSession(state, {
    schemaVersion: 'deepcode.session-event.v2',
    eventId: 'event:legacy-context',
    sessionId: 'session:legacy-context',
    sequence: 1,
    occurredAt: '2026-08-25T00:00:00.000Z',
    type: 'context.composed',
    runId: 'run:legacy-context',
    payload: {
      providerRequestId: 'provider-request:legacy-context',
      responseConstraint: 'normal',
      categories: [{
        kind: 'journalMessages',
        itemCount: 1,
        items: [{ itemId: 'message:legacy-context', label: '用户消息' }],
      }],
    },
  });
  const receipt = restored.contextCompositions.at(-1);
  assert.deepEqual(receipt.categories, [{
    kind: 'journalMessages',
    itemCount: 1,
    items: [{ itemId: 'message:legacy-context', label: '用户消息' }],
  }]);
  assert.equal('messages' in receipt, false);
  assert.equal('workspaceBindings' in receipt, false);
  assert.equal('tools' in receipt, false);
});

test('schema 4 历史用量在不伪造请求回执的前提下恢复为逐轮统计', () => {
  const state = emptySessionState('session:legacy-usage');
  state.revision = 1;
  state.run = {
    runId: 'run:legacy-usage',
    status: 'running',
    workspaceBindings: [],
  };
  state.tokenUsageHistory['run:legacy-usage'] = {
    runId: 'run:legacy-usage',
    inputMessageId: 'message:legacy-usage',
    title: '历史用量',
    sequence: 1,
    startedAt: '2026-08-24T00:00:00.000Z',
    providerCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheMissInputTokens: 0,
    cacheReportedCallCount: 0,
  };
  const recovered = reduceSession(state, {
    schemaVersion: 'deepcode.session-event.v2',
    eventId: 'event:legacy-usage',
    sessionId: 'session:legacy-usage',
    sequence: 2,
    occurredAt: '2026-08-24T00:00:01.000Z',
    type: 'context.updated',
    runId: 'run:legacy-usage',
    payload: {
      inputTokens: 100,
      outputTokens: 20,
      contextWindowTokens: 1_000,
      cacheReadInputTokens: 70,
      cacheMissInputTokens: 30,
    },
  });
  const projection = projectSession(recovered);
  assert.equal(projection.contextUsage, null);
  assert.equal(projection.contextCompositions.length, 0);
  assert.deepEqual(projection.tokenUsage, {
    providerCallCount: 1,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 70,
    cacheMissInputTokens: 30,
    cacheReportedCallCount: 1,
  });
  assert.equal(projection.tokenUsageHistory[0].inputTokens, 100);
  assert.equal(projection.tokenUsageHistory[0].outputTokens, 20);
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
  assert.equal(projection.display.title, '新对话');
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
    schemaVersion: 'deepcode.command.v2',
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
    schemaVersion: 'deepcode.command.v2',
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
    schemaVersion: 'deepcode.command.v2',
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
        && item.toolCalls?.some((call) => call.callId === 'interaction:build-entry')
      ));
      assert.equal(
        interactionTurn?.reasoningContent,
        'private provider reasoning for the tool continuation',
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
  assert.doesNotMatch(
    JSON.stringify(await readEvents(journal, 'session:structured')),
    /private provider reasoning/u,
  );
  await actor.dispose();
});

test('当前 turn 的累计 assistant draft 进入共享投影但不写入 Journal', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:streaming');
  const updates = [];
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
  }, undefined, [], 'streaming', (update) => updates.push(update));
  await actor.submit(message('session:streaming', 'command:start', '检查项目入口'));
  const running = await waitFor(actor, (p) => p.assistantDraft?.content === '正在检查项目入口。');
  assert.equal(running.narratives.length, 0);
  assert.equal(running.messages.length, 1);
  assert.ok(updates.some((update) => (
    update.type === 'snapshot'
    && update.projection.assistantDraft?.content === '正在检查项目入口。'
  )));
  assert.ok(updates.every((update) => update.type === 'snapshot' && !('event' in update)));
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
    schemaVersion: 'deepcode.command.v2',
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
  assert.equal('categories' in receipt, false);
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
    'plan.intent',
    'todo.update',
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
    'plan.intent',
    'todo.update',
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
          name: 'plan.intent',
          input: {
            prompt: '请选择。',
            options: [{ optionId: 'write', label: '写入', operations: [] }],
          },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 12, outputTokens: 3, contextWindowTokens: 1_000 },
        });
        return;
      }
      const rejection = request.messages.find(
        (entry) => entry.role === 'tool' && entry.toolCallId === 'plan:invalid:first',
      );
      assert.deepEqual(JSON.parse(rejection.content), {
        accepted: false,
        error: {
          code: 'session_control_plan_operations_invalid',
          message: '每个 Plan option 必须包含至少一个闭合 operation。',
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
  assert.equal(rejections[0].payload.error.code, 'session_control_plan_operations_invalid');
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
        name: 'plan.intent',
        input: {
          prompt: '请选择。',
          options: [{ optionId: `write-${turn}`, label: '写入', operations: [] }],
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
  assert.equal(failed.terminalError.code, 'session_control_plan_operations_invalid');
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
          schemaVersion: 'deepcode.kernel-reply.v2',
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
  assert.equal(completed.activities.find((item) => item.callId === 'call:external')?.status, 'completed');
  assert.equal(executions.length, 2);
  await actor.dispose();
});

test('Plan 选择生成同 session/run/workspace 的精确 authority', async () => {
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
        [authority.sessionId, authority.runId, authority.workspaceId],
        [request.sessionId, request.runId, 'workspace:plan'],
      );
      assert.deepEqual(authority.coveredOperations, [{
        workspaceId: 'workspace:plan', operation: 'fs.write', target: 'src/output.txt',
      }]);
      return executionReply(request, {
        decision: 'allow', source: 'plan', workspaceId: 'workspace:plan',
        authorityId: authority.authorityId, planId: authority.planId,
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
          name: 'plan.intent',
          input: {
            prompt: '请选择写入方案。',
            options: [{
              optionId: 'safe',
              label: '写入目标文件',
              description: '只修改一个精确目标。',
              operations: [{
                workspaceId: 'workspace:plan', operation: 'fs.write', target: 'src/output.txt',
              }],
            }],
          },
        });
      } else if (turn === 2) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'call:write',
          name: 'fs.write',
          input: { workspaceId: 'workspace:plan', path: 'src/output.txt', content: 'hello' },
        });
      } else {
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:done', content: '已按所选计划完成写入。',
        });
      }
      yield providerEvent(request.requestId, 'completed', {});
    },
  }, kernel, [writeTool], 'plan-select');
  await actor.submit(message('session:plan-select', 'command:start', '写入文件'));
  const waiting = await waitFor(actor, (p) => p.pendingPlan !== null);
  assert.equal(waiting.pendingPlan.responseMode, 'optionOrFreeform');
  assert.equal(waiting.pendingPlan.ignoreAllowed, true);
  assert.deepEqual(waiting.pendingPlan.options[0].operationsDisplay, [
    'fs.write · PlanProject:src/output.txt',
  ]);
  assert.equal((await actor.submit(planResponse(
    'session:plan-select',
    'command:select',
    waiting.run.runId,
    waiting.pendingPlan.planId,
    { kind: 'select', optionId: 'safe' },
  ))).status, 'accepted');
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.pendingPlan, null);
  assert.equal(executions.length, 1);
  assert.equal(completed.activities.find((item) => item.callId === 'call:write')?.status, 'completed');
  await actor.dispose();
});

test('Plan 自由调整作为用户事实进入同一 run，旧 Plan 不产生 authority', async () => {
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
      } else {
        assert.equal(request.responseConstraint, 'normal');
        assert.ok(request.messages.some((item) => (
          item.role === 'user' && item.content === '改为只写 docs/notes.md'
        )));
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:answer', content: '已重新整理，暂不执行写入。',
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
    { kind: 'feedback', text: '改为只写 docs/notes.md' },
  ));
  await waitFor(actor, (p) => p.run?.status === 'completed');
  const resolved = (await readEvents(journal, 'session:feedback'))
    .find((event) => event.type === 'plan.intent.resolved');
  assert.equal(resolved.payload.response.kind, 'feedback');
  assert.equal(resolved.payload.authorities, undefined);
  assert.equal(requests.length, 2);
  await actor.dispose();
});

test('Plan 忽略关闭 mutation authority，并强制同一 Loop 只接受最终 answer', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, 'session:ignore', [binding]);
  let turn = 0;
  const actor = actorWith(journal, 'session:ignore', {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', simplePlanCall('plan:ignore'));
      } else {
        assert.equal(request.responseConstraint, 'answerOnly');
        assert.deepEqual(request.tools, []);
        yield providerEvent(request.requestId, 'assistant.message', {
          messageId: 'message:answer',
          content: '已忽略计划；这里只给出最终说明，不执行修改。',
        });
      }
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
    { kind: 'ignore' },
  ));
  const completed = await waitFor(actor, (p) => p.run?.status === 'completed');
  assert.equal(completed.pendingPlan, null);
  assert.equal(completed.messages.at(-1).content, '已忽略计划；这里只给出最终说明，不执行修改。');
  const resolved = (await readEvents(journal, 'session:ignore'))
    .find((event) => event.type === 'plan.intent.resolved');
  assert.equal(resolved.payload.response.kind, 'ignore');
  assert.equal(resolved.payload.authorities, undefined);
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
  let releaseSecondRun;
  const secondRunPaused = new Promise((resolve) => { releaseSecondRun = resolve; });
  const actor = actorWith(journal, 'session:projection-facts', {
    async *stream(request) {
      turn += 1;
      if (turn === 1) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'todo:read',
          name: 'todo.update',
          input: {
            items: [
              { todoId: 'inspect', label: '读取项目入口', status: 'inProgress' },
              { todoId: 'answer', label: '整理结论', status: 'pending' },
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
      if (turn === 2) {
        yield providerEvent(request.requestId, 'tool.call', {
          callId: 'todo:done',
          name: 'todo.update',
          input: {
            items: [
              { todoId: 'inspect', label: '读取项目入口', status: 'completed' },
              { todoId: 'answer', label: '整理结论', status: 'completed' },
            ],
          },
        });
        yield providerEvent(request.requestId, 'completed', {
          usage: { inputTokens: 20, outputTokens: 5, contextWindowTokens: 1_000 },
        });
        return;
      }
      if (turn === 3) {
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
  const completed = await waitFor(actor, (projection) => (
    ['completed', 'failed', 'indeterminate'].includes(projection.run?.status)
  ));
  assert.equal(
    completed.run.status,
    'completed',
    JSON.stringify(completed.terminalError),
  );
  assert.deepEqual(completed.todoList.items, [
    { todoId: 'inspect', label: '读取项目入口', status: 'completed' },
    { todoId: 'answer', label: '整理结论', status: 'completed' },
  ]);
  assert.deepEqual(completed.tokenUsage, {
    providerCallCount: 3,
    inputTokens: 128,
    outputTokens: 17,
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
    providerCallCount: 3,
    inputTokens: 128,
    outputTokens: 17,
    cacheReportedCallCount: 1,
    outcome: 'completed',
  }]);
  const activity = completed.activities.find((item) => item.callId === 'call:read');
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
  const requested = (await readEvents(journal, 'session:projection-facts'))
    .find((event) => event.type === 'tool.requested' && event.callId === 'call:read');
  assert.equal(activity.sequence, requested.sequence);

  await actor.submit(message(
    'session:projection-facts', 'command:second', '继续回答',
  ));
  const secondRunning = await waitFor(actor, (projection) => (
    projection.run?.status === 'running' && projection.messages.at(-1)?.content === '继续回答'
  ));
  assert.equal(secondRunning.todoList, null);
  releaseSecondRun();
  const secondCompleted = await waitFor(actor, (projection) => (
    projection.run?.status === 'completed'
    && projection.messages.at(-1)?.content === '第二轮完成。'
  ));
  assert.equal(secondCompleted.tokenUsage.providerCallCount, 4);
  assert.equal(secondCompleted.tokenUsage.cacheReportedCallCount, 1);
  assert.deepEqual(secondCompleted.tokenUsageHistory.map((round) => round.title), [
    '继续回答',
    '读取 README 并分析',
  ]);
  assert.equal(secondCompleted.tokenUsageHistory[0].providerCallCount, 1);
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
    schemaVersion: 'deepcode.command.v2',
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
  onUpdate,
) {
  return new SessionActor(
    sessionId,
    journal,
    composition(providerPort, kernel ?? emptyKernel(), tools),
    { nextId: idFactory(prefix), ...(onUpdate ? { onUpdate } : {}) },
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
    schemaVersion: 'deepcode.kernel-reply.v2',
    type: 'tool.cancelled',
    requestId: 'cancel:unused',
    callId,
    attemptId,
    status: 'notFound',
  };
}

function executionReply(request, authority, logicalTarget = 'example') {
  return {
    schemaVersion: 'deepcode.kernel-reply.v2',
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
        canonicalInvocation: { toolName: request.toolName, arguments: request.input },
      },
      authority,
      startedAt: '2026-08-24T00:00:00.000Z',
      completedAt: '2026-08-24T00:00:01.000Z',
      outcome: 'completed',
      output: { changed: true },
    },
  };
}

function providerEvent(requestId, type, data) {
  return { schemaVersion: 'deepcode.provider-event.v2', requestId, type, data };
}

function message(sessionId, commandId, text, profileId, attachments) {
  return {
    schemaVersion: 'deepcode.command.v2',
    type: 'message.submit',
    commandId,
    sessionId,
    text,
    ...(attachments?.length ? { attachments } : {}),
    ...(profileId ? { profileId } : {}),
  };
}

function profile(sessionId, commandId, runId, profileId) {
  return {
    schemaVersion: 'deepcode.command.v2', type: 'run.profile.select',
    commandId, sessionId, runId, profileId,
  };
}

function interaction(sessionId, commandId, runId, interactionId, response) {
  return {
    schemaVersion: 'deepcode.command.v2', type: 'interaction.respond',
    commandId, sessionId, runId, interactionId, response,
  };
}

function approval(sessionId, commandId, runId, callId, approvalId, decision) {
  return {
    schemaVersion: 'deepcode.command.v2', type: 'approval.respond',
    commandId, sessionId, runId, callId, approvalId, decision,
  };
}

function planResponse(sessionId, commandId, runId, planId, response) {
  return {
    schemaVersion: 'deepcode.command.v2', type: 'plan.respond',
    commandId, sessionId, runId, planId, response,
  };
}

function simplePlanCall(callId) {
  return {
    callId,
    name: 'plan.intent',
    input: {
      prompt: '请选择计划。',
      options: [{
        optionId: 'one',
        label: '写入说明',
        operations: [{
          workspaceId: 'workspace:test', operation: 'fs.write', target: 'docs/plan.md',
        }],
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
