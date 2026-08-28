import type {
  AssistantDraftProjection,
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  InteractionProjection,
  NewSessionEvent,
  PlanAuthority,
  SessionEvent,
  SessionProjection,
} from '@deepcode/protocol';
import { COMMAND_REPLY_VERSION, SESSION_EVENT_VERSION } from '@deepcode/protocol';
import type { AgentComposition } from './plugins.js';
import {
  loopSnapshot,
  runAgentLoop,
  type LoopCommand,
  type LoopSnapshot,
  type ProviderRunTransientState,
} from './loop.js';
import { projectSession, reduceSession } from './reducer.js';

export interface SessionActorOptions {
  profileId?: string;
  nextId?(kind: string): string;
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
  task: Promise<void>;
}

const MAX_ATTACHMENT_COUNT = 8;
const MAX_ATTACHMENT_BYTES = 512 * 1024;

export class SessionActor {
  readonly #journal: CommandJournalPort;
  readonly #composition: AgentComposition;
  readonly #profileId?: string;
  readonly #nextId: (kind: string) => string;
  #mailbox = Promise.resolve();
  #active?: ActiveRun;
  #disposed = false;
  #projectionState?: LoopSnapshot['state'];
  #assistantDraft: AssistantDraftProjection | null = null;
  #providerRunState?: ProviderRunTransientState;

  constructor(
    readonly sessionId: string,
    journal: CommandJournalPort,
    composition: AgentComposition,
    options: SessionActorOptions = {},
  ) {
    this.#journal = journal;
    this.#composition = composition;
    this.#profileId = options.profileId;
    this.#nextId = options.nextId ?? defaultIdFactory(sessionId);
  }

  async recover(): Promise<void> {
    await this.enqueue(async () => {
      const snapshot = await this.loadSnapshot();
      if (snapshot.state.run?.status === 'running') {
        this.startLoop({ type: 'resume', runId: snapshot.state.run.runId });
      }
    });
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    return await this.enqueue(async () => this.handleCommand(command));
  }

  async snapshot(): Promise<SessionProjection> {
    return projectSession((await this.loadSnapshot()).state, this.#assistantDraft);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#active?.controller.abort('session_service_stopped');
    await this.#active?.task;
    await this.#composition.dispose();
  }

  private async handleCommand(command: ConversationCommand): Promise<CommandReply> {
    if (this.#disposed) throw new Error('session_actor_disposed');
    if (command.sessionId !== this.sessionId) {
      return this.reject(command, 'session_identity_mismatch', '命令不属于当前会话。');
    }
    const stored = await this.#journal.readCommand(this.sessionId, command.commandId);
    if (stored) {
      if (canonicalJson(stored.command) !== canonicalJson(command)) {
        return {
          schemaVersion: COMMAND_REPLY_VERSION,
          commandId: command.commandId,
          sessionId: this.sessionId,
          status: 'rejected',
          revision: stored.reply.revision,
          error: { code: 'command_id_conflict', message: '同一 commandId 已用于不同内容。' },
        };
      }
      return { ...stored.reply, status: 'replayed' };
    }

    switch (command.type) {
      case 'session.directory-index.attach':
        return await this.handleDirectoryIndexAttach(command);
      case 'session.directory-index.detach':
        return await this.handleDirectoryIndexDetach(command);
      case 'message.submit':
        return await this.handleMessage(command);
      case 'message.feedback.set':
        return await this.handleMessageFeedback(command);
      case 'run.profile.select':
        return await this.handleProfileSelection(command);
      case 'run.cancel':
        return await this.handleCancel(command);
      case 'interaction.respond':
        return await this.handleInteraction(command);
      case 'approval.respond':
        return await this.handleApproval(command);
      case 'plan.respond':
        return await this.handlePlan(command);
    }
  }

  private async handleDirectoryIndexAttach(
    command: Extract<ConversationCommand, { type: 'session.directory-index.attach' }>,
  ): Promise<CommandReply> {
    if (!validWorkspaceBinding(command.workspaceBinding)) {
      return await this.recordRejection(
        command,
        'session_directory_index_invalid',
        '目录索引的 workspace identity 无效。',
      );
    }
    const snapshot = await this.loadSnapshot();
    if (snapshot.state.workspaceBindings.some((binding) => (
      binding.workspaceId === command.workspaceBinding.workspaceId
    ))) {
      return await this.recordRejection(
        command,
        'session_directory_index_duplicate',
        '该目录已经属于当前 Session 的有效目录集合。',
      );
    }
    const reply = await this.#journal.commitCommand(
      command,
      [{
        type: 'session.directory-index.attached',
        sessionId: this.sessionId,
        payload: {
          commandId: command.commandId,
          workspaceBinding: { ...command.workspaceBinding },
        },
      }],
      acceptedReply(command),
    );
    return reply;
  }

  private async handleDirectoryIndexDetach(
    command: Extract<ConversationCommand, { type: 'session.directory-index.detach' }>,
  ): Promise<CommandReply> {
    if (!validProfileId(command.workspaceId)) {
      return await this.recordRejection(
        command,
        'session_directory_index_invalid',
        '目录索引的 workspaceId 无效。',
      );
    }
    const snapshot = await this.loadSnapshot();
    if (!snapshot.state.sessionDirectoryIndexes.some((binding) => (
      binding.workspaceId === command.workspaceId
    ))) {
      return await this.recordRejection(
        command,
        'session_directory_index_not_attached',
        '该目录不是当前 Session 可移除的对话目录索引。',
      );
    }
    const reply = await this.#journal.commitCommand(
      command,
      [{
        type: 'session.directory-index.detached',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, workspaceId: command.workspaceId },
      }],
      acceptedReply(command),
    );
    return reply;
  }

  private async handleMessage(
    command: Extract<ConversationCommand, { type: 'message.submit' }>,
  ): Promise<CommandReply> {
    if (!command.text.trim()) {
      return await this.recordRejection(command, 'message_empty', '用户消息不能为空。');
    }
    if (command.profileId !== undefined && !validProfileId(command.profileId)) {
      return await this.recordRejection(command, 'llm_profile_invalid', '模型 Profile 标识无效。');
    }
    const attachmentError = validateAttachments(command.attachments);
    if (attachmentError) {
      return await this.recordRejection(command, 'message_attachment_invalid', attachmentError);
    }
    const before = await this.loadSnapshot();
    if (before.state.pendingPlan) {
      return await this.recordRejection(
        command,
        'plan_response_required',
        '当前运行正在等待 plan.respond，不能创建并发运行。',
      );
    }
    if (before.state.pendingInteraction) {
      return await this.recordRejection(
        command,
        'interaction_response_required',
        '当前运行正在等待 interaction.respond，不能创建并发运行。',
      );
    }
    if (before.state.pendingApproval) {
      return await this.recordRejection(
        command,
        'approval_response_required',
        '当前运行正在等待 approval.respond，不能创建并发运行。',
      );
    }
    await this.stopCurrentRunForSteering();
    const messageId = this.#nextId('message');
    const runId = this.#nextId('run');
    const profileId = command.profileId ?? this.#profileId;
    const reply = await this.#journal.commitCommand(
      command,
      [
        {
          type: 'input.accepted',
          sessionId: this.sessionId,
          payload: { commandId: command.commandId, messageId, text: command.text },
        },
        {
          type: 'message.committed',
          sessionId: this.sessionId,
          payload: {
            messageId,
            role: 'user',
            content: command.text,
            ...(command.attachments?.length
              ? { attachments: command.attachments.map((attachment) => ({ ...attachment })) }
              : {}),
          },
        },
        {
          type: 'run.started',
          sessionId: this.sessionId,
          runId,
          payload: {
            inputMessageId: messageId,
            workspaceBindings: before.state.workspaceBindings.map((binding) => ({ ...binding })),
            ...(profileId ? { profileId } : {}),
          },
        },
      ],
      acceptedReply(command),
    );
    this.startLoop({ type: 'start', runId });
    return reply;
  }

  private async handleMessageFeedback(
    command: Extract<ConversationCommand, { type: 'message.feedback.set' }>,
  ): Promise<CommandReply> {
    if (!validProfileId(command.messageId)) {
      return await this.recordRejection(
        command,
        'message_feedback_target_invalid',
        '反馈目标消息标识无效。',
      );
    }
    const snapshot = await this.loadSnapshot();
    const message = snapshot.state.messages.find((candidate) => (
      candidate.messageId === command.messageId
    ));
    if (!message || message.role !== 'assistant') {
      return await this.recordRejection(
        command,
        'message_feedback_target_missing',
        '反馈只能关联当前 Session 中已有的 Assistant 消息。',
      );
    }
    const reply = await this.#journal.commitCommand(
      command,
      [{
        type: 'message.feedback.updated',
        sessionId: this.sessionId,
        payload: {
          commandId: command.commandId,
          messageId: command.messageId,
          feedback: command.feedback,
        },
      }],
      acceptedReply(command),
    );
    return reply;
  }

  private async handleInteraction(
    command: Extract<ConversationCommand, { type: 'interaction.respond' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    const interaction = snapshot.state.pendingInteraction;
    if (
      !interaction
      || interaction.interactionId !== command.interactionId
      || interaction.runId !== command.runId
      || snapshot.state.run?.runId !== command.runId
      || snapshot.state.run.status !== 'waiting'
      || snapshot.state.run.waitingReason !== 'userInput'
    ) {
      return await this.recordRejection(
        command,
        'interaction_not_pending',
        '该交互请求已经关闭或不属于当前运行。',
      );
    }
    const response = command.response.trim();
    if (!validInteractionResponse(interaction, response)) {
      return await this.recordRejection(
        command,
        'interaction_response_invalid',
        '响应不符合当前交互请求。',
      );
    }

    const messageId = this.#nextId('message');
    const events: NewSessionEvent[] = [
      {
        type: 'input.accepted',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, messageId, text: command.response },
      },
      {
        type: 'interaction.resolved',
        sessionId: this.sessionId,
        runId: command.runId,
        payload: {
          interactionId: command.interactionId,
          commandId: command.commandId,
          response: command.response,
        },
      },
      {
        type: 'message.committed',
        sessionId: this.sessionId,
        runId: command.runId,
        payload: { messageId, role: 'user', content: command.response },
      },
    ];
    const reply = await this.#journal.commitCommand(command, events, acceptedReply(command));
    this.startLoop({ type: 'resume', runId: command.runId });
    return reply;
  }

  private async handleApproval(
    command: Extract<ConversationCommand, { type: 'approval.respond' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    const approval = snapshot.state.pendingApproval;
    if (
      !approval
      || approval.approvalId !== command.approvalId
      || approval.callId !== command.callId
      || approval.runId !== command.runId
      || snapshot.state.run?.runId !== command.runId
      || snapshot.state.run.status !== 'waiting'
      || snapshot.state.run.waitingReason !== 'approval'
    ) {
      return await this.recordRejection(
        command,
        'approval_not_pending',
        '该 effect 裁决已经关闭或不属于当前运行。',
      );
    }
    const reply = await this.#journal.commitCommand(
      command,
      [{
        type: 'approval.resolved',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: command.callId,
        payload: {
          approvalId: command.approvalId,
          commandId: command.commandId,
          decision: command.decision,
          authorityId: this.#nextId('authority'),
        },
      }],
      acceptedReply(command),
    );
    this.startLoop({ type: 'resume', runId: command.runId });
    return reply;
  }

  private async handlePlan(
    command: Extract<ConversationCommand, { type: 'plan.respond' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    const plan = snapshot.state.pendingPlan;
    if (
      !plan
      || plan.planId !== command.planId
      || plan.runId !== command.runId
      || snapshot.state.run?.runId !== command.runId
      || snapshot.state.run.status !== 'waiting'
      || snapshot.state.run.waitingReason !== 'plan'
    ) {
      return await this.recordRejection(
        command,
        'plan_not_pending',
        '该 Plan 已关闭、已变化或不属于当前运行。',
      );
    }
    const optionIds = new Set(plan.options.map((option) => option.optionId));
    if (
      command.response.kind === 'select' && !optionIds.has(command.response.optionId)
      || command.response.kind === 'feedback' && (
        !command.response.text.trim()
        || command.response.optionId !== undefined && !optionIds.has(command.response.optionId)
      )
    ) {
      return await this.recordRejection(
        command,
        'plan_response_invalid',
        'Plan 响应没有引用当前有效 option，或反馈文本为空。',
      );
    }

    const authorities = command.response.kind === 'select'
      ? planAuthoritiesForSelection(
          snapshot.events,
          command.runId,
          command.planId,
          command.response.optionId,
          this.#nextId,
        )
      : [];
    const resolution: NewSessionEvent = {
      type: 'plan.intent.resolved',
      sessionId: this.sessionId,
      runId: command.runId,
      payload: {
        planId: command.planId,
        commandId: command.commandId,
        response: structuredClone(command.response),
        ...(authorities.length ? { authorities } : {}),
      },
    };
    const events: NewSessionEvent[] = [resolution];
    if (command.response.kind === 'feedback') {
      const messageId = this.#nextId('message');
      events.unshift({
        type: 'input.accepted',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, messageId, text: command.response.text },
      });
      events.push(
        {
          type: 'message.committed',
          sessionId: this.sessionId,
          runId: command.runId,
          payload: { messageId, role: 'user', content: command.response.text },
        },
      );
    }
    const reply = await this.#journal.commitCommand(command, events, acceptedReply(command));
    this.startLoop({
      type: 'resume',
      runId: command.runId,
      answerOnly: command.response.kind === 'ignore',
    });
    return reply;
  }

  private async handleProfileSelection(
    command: Extract<ConversationCommand, { type: 'run.profile.select' }>,
  ): Promise<CommandReply> {
    if (!validProfileId(command.profileId)) {
      return await this.recordRejection(command, 'llm_profile_invalid', '模型 Profile 标识无效。');
    }
    const snapshot = await this.loadSnapshot();
    if (
      !snapshot.state.run
      || snapshot.state.run.runId !== command.runId
      || isTerminal(snapshot.state.run.status)
    ) {
      return await this.recordRejection(
        command,
        'run_not_current',
        '模型切换目标不是当前活动运行。',
      );
    }
    const reply = await this.#journal.commitCommand(
      command,
      [{
        type: 'run.profile.selected',
        sessionId: this.sessionId,
        runId: command.runId,
        payload: { commandId: command.commandId, profileId: command.profileId },
      }],
      acceptedReply(command),
    );
    return reply;
  }

  private async handleCancel(
    command: Extract<ConversationCommand, { type: 'run.cancel' }>,
  ): Promise<CommandReply> {
    const snapshot = await this.loadSnapshot();
    if (!snapshot.state.run || snapshot.state.run.runId !== command.runId) {
      return await this.recordRejection(command, 'run_not_current', '取消目标不是当前运行。');
    }
    if (isTerminal(snapshot.state.run.status)) {
      return await this.recordRejection(command, 'run_already_settled', '运行已经结束。');
    }
    const reply = await this.#journal.commitCommand(command, [], acceptedReply(command));
    if (this.#active?.runId === command.runId) {
      this.#active.controller.abort('user_cancelled');
      await this.#active.task;
    } else {
      await this.runLoop({ type: 'cancel', runId: command.runId });
    }
    return reply;
  }

  private async stopCurrentRunForSteering(): Promise<void> {
    const snapshot = await this.loadSnapshot();
    const run = snapshot.state.run;
    if (!run || isTerminal(run.status)) return;
    if (this.#active?.runId === run.runId) {
      this.#active.controller.abort('superseded_by_user_message');
      await this.#active.task;
    } else {
      await this.runLoop({ type: 'cancel', runId: run.runId });
    }
  }

  private startLoop(command: LoopCommand): void {
    if (this.#active) throw new Error('session_run_already_active');
    this.#assistantDraft = null;
    if (command.type === 'start') {
      this.#providerRunState = providerRunState(command.runId);
    } else if (this.#providerRunState?.runId !== command.runId) {
      this.#providerRunState = providerRunState(command.runId);
    }
    const controller = new AbortController();
    const active: ActiveRun = { runId: command.runId, controller, task: Promise.resolve() };
    active.task = this.runLoop(command, controller.signal)
      .then(() => undefined)
      .finally(() => {
        if (this.#active === active) this.#active = undefined;
      });
    this.#active = active;
  }

  private async runLoop(
    command: LoopCommand,
    signal = new AbortController().signal,
  ): Promise<void> {
    const snapshot = await this.loadSnapshot();
    const providerRunState = this.#providerRunState ?? providerRunStateForRecovery(command.runId);
    this.#providerRunState = providerRunState;
    const result = await runAgentLoop(
      snapshot,
      command,
      {
        composition: this.#composition,
        providerRunState,
        ...(this.#profileId ? { defaultProfileId: this.#profileId } : {}),
        commit: async (events) => {
          const batch = Array.isArray(events) ? events : [events];
          const previousDraft = this.#assistantDraft;
          const closesDraft = closesAssistantDraft(batch, command.runId);
          if (closesDraft) this.#assistantDraft = null;
          let committed: SessionEvent[];
          try {
            const current = await this.loadSnapshot();
            let previewState = current.state;
            for (const [index, event] of batch.entries()) {
              previewState = reduceSession(previewState, {
                ...event,
                schemaVersion: SESSION_EVENT_VERSION,
                eventId: `preflight:${current.state.revision + index + 1}`,
                sequence: current.state.revision + index + 1,
                occurredAt: '1970-01-01T00:00:00.000Z',
              } as SessionEvent);
            }
            committed = batch.length === 1
              ? [await this.#journal.append(batch[0]!)]
              : await this.#journal.appendBatch(batch);
          } catch (error) {
            if (closesDraft) this.#assistantDraft = previousDraft;
            throw error;
          }
          for (const event of committed) await this.observe(event);
          return await this.loadSnapshot();
        },
        updateAssistantDraft: (draft) => {
          if (draft && draft.runId !== command.runId) {
            throw new Error('assistant_draft_run_identity_mismatch');
          }
          this.#assistantDraft = draft ? { ...draft } : null;
          if (!this.#projectionState) throw new Error('session_projection_state_missing');
        },
        nextId: this.#nextId,
      },
      signal,
    );
    if (result.status === 'settled' && this.#providerRunState === providerRunState) {
      this.#providerRunState = undefined;
    }
  }

  private async loadSnapshot(): Promise<LoopSnapshot> {
    const events: SessionEvent[] = [];
    for await (const event of this.#journal.read(this.sessionId)) events.push(event);
    const snapshot = loopSnapshot(this.sessionId, events);
    this.#projectionState = snapshot.state;
    return snapshot;
  }

  private async observe(event: SessionEvent): Promise<void> {
    await Promise.all(this.#composition.observers.map((observer) => observer.observe(event)));
  }

  private async recordRejection(
    command: ConversationCommand,
    code: string,
    message: string,
  ): Promise<CommandReply> {
    return await this.#journal.commitCommand(command, [], {
      schemaVersion: COMMAND_REPLY_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      status: 'rejected',
      error: { code, message },
    });
  }

  private reject(command: ConversationCommand, code: string, message: string): CommandReply {
    return {
      schemaVersion: COMMAND_REPLY_VERSION,
      commandId: command.commandId,
      sessionId: command.sessionId,
      status: 'rejected',
      revision: 0,
      error: { code, message },
    };
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mailbox.then(operation, operation);
    this.#mailbox = result.then(() => undefined, () => undefined);
    return await result;
  }
}

function providerRunState(runId: string): ProviderRunTransientState {
  return {
    runId,
    observedCallIds: new Set(),
    reasoningByCallId: new Map(),
  };
}

function providerRunStateForRecovery(runId: string): ProviderRunTransientState {
  return providerRunState(runId);
}

function planAuthoritiesForSelection(
  events: readonly SessionEvent[],
  runId: string,
  planId: string,
  optionId: string,
  nextId: (kind: string) => string,
): PlanAuthority[] {
  const requested = events.findLast(
    (event): event is Extract<SessionEvent, { type: 'plan.intent.requested' }> => (
      event.type === 'plan.intent.requested'
      && event.runId === runId
      && event.payload.planId === planId
    ),
  );
  const option = requested?.payload.options.find((candidate) => candidate.optionId === optionId);
  if (!requested || !option) throw new Error('plan_option_fact_missing');
  const workspaceIds = [...new Set(option.operations.map((operation) => operation.workspaceId))];
  return workspaceIds.map((workspaceId) => ({
    authorityId: nextId('plan-authority'),
    planId,
    optionId,
    sessionId: requested.sessionId,
    runId,
    workspaceId,
    coveredOperations: option.operations
      .filter((operation) => operation.workspaceId === workspaceId)
      .map((operation) => ({ ...operation })),
  }));
}

function validInteractionResponse(interaction: InteractionProjection, response: string): boolean {
  if (!response) return false;
  return interaction.allowFreeform || Boolean(interaction.options?.some((option) => (
    option.id === response || option.label === response
  )));
}

function acceptedReply(command: ConversationCommand): Omit<CommandReply, 'revision'> {
  return {
    schemaVersion: COMMAND_REPLY_VERSION,
    commandId: command.commandId,
    sessionId: command.sessionId,
    status: 'accepted',
  };
}

function validWorkspaceBinding(value: unknown): value is {
  workspaceId: string;
  displayName: string;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  return Object.keys(binding).every((key) => ['workspaceId', 'displayName'].includes(key))
    && typeof binding.workspaceId === 'string'
    && validProfileId(binding.workspaceId)
    && typeof binding.displayName === 'string'
    && Boolean(binding.displayName.trim())
    && binding.displayName.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(binding.displayName);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('command_requires_safe_integer_numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, sortJsonValue(source[key])]),
    );
  }
  return value;
}

function isTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'indeterminate'].includes(status);
}

function closesAssistantDraft(
  events: readonly (NewSessionEvent | SessionEvent)[],
  runId: string,
): boolean {
  return events.some((event) => (
    'runId' in event
    && event.runId === runId
    && (
      event.type === 'narrative.committed'
      || event.type === 'interaction.requested'
      || event.type === 'plan.intent.requested'
      || event.type === 'tool.requested'
      || event.type === 'run.settled'
      || event.type === 'message.committed' && event.payload.role === 'assistant'
    )
  ));
}

function validProfileId(value: string): boolean {
  return value.length > 0
    && value.length <= 128
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validateAttachments(
  attachments: Extract<ConversationCommand, { type: 'message.submit' }>['attachments'],
): string | null {
  if (attachments === undefined) return null;
  if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENT_COUNT) {
    return `单次消息最多附加 ${MAX_ATTACHMENT_COUNT} 个文件。`;
  }
  const seen = new Set<string>();
  let bytes = 0;
  for (const attachment of attachments) {
    if (
      !attachment
      || typeof attachment !== 'object'
      || typeof attachment.attachmentId !== 'string'
      || !validProfileId(attachment.attachmentId)
      || seen.has(attachment.attachmentId)
      || typeof attachment.name !== 'string'
      || !attachment.name.trim()
      || attachment.name.length > 255
      || attachment.name.includes('\0')
      || typeof attachment.mediaType !== 'string'
      || !attachment.mediaType.trim()
      || attachment.mediaType.length > 128
      || typeof attachment.content !== 'string'
    ) return '附件标识、名称、类型或内容无效。';
    seen.add(attachment.attachmentId);
    bytes += new TextEncoder().encode(attachment.content).byteLength;
    if (bytes > MAX_ATTACHMENT_BYTES) {
      return `附件文本总计不能超过 ${MAX_ATTACHMENT_BYTES} 字节。`;
    }
  }
  return null;
}

function defaultIdFactory(sessionId: string): (kind: string) => string {
  let next = 0;
  return (kind) => {
    next += 1;
    return `${sessionId}:${kind}:${Date.now().toString(36)}:${next.toString(36)}`;
  };
}
