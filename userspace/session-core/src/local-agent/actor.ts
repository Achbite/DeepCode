import type {
  AssistantDraftProjection,
  CommandJournalPort,
  CommandReply,
  ConversationCommand,
  InteractionProjection,
  NewSessionEvent,
  PlanAuthority,
  RunSettlement,
  SessionEvent,
  SessionProjection,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  COMMAND_REPLY_VERSION,
  SESSION_EVENT_VERSION,
} from '@deepcode/protocol';
import type { AgentComposition } from './plugins.js';
import {
  loopSnapshot,
  runAgentLoop,
  type LoopCommand,
  type LoopSnapshot,
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

const MAX_FILESYSTEM_REFERENCE_COUNT = 8;

export class SessionActor {
  readonly #journal: CommandJournalPort;
  readonly #composition: AgentComposition;
  readonly #profileId?: string;
  readonly #nextId: (kind: string) => string;
  #mailbox = Promise.resolve();
  #active?: ActiveRun;
  #disposed = false;
  #loopFailure?: Error;
  #projectionState?: LoopSnapshot['state'];
  #assistantDraft: AssistantDraftProjection | null = null;

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
      const run = snapshot.state.run;
      if (!run) return;
      if (isTerminal(run.status)) return;
      if (run.status === 'releasing' || run.status === 'releaseFailed') {
        const settlement = snapshot.state.pendingRunSettlements[run.runId];
        if (!settlement) throw new Error('run_finishing_settlement_missing');
        await this.finalizeRunRuntime(snapshot, run.runId, settlement);
        return;
      }
      const restored = await this.restoreRunRuntime(snapshot, run.runId);
      if (restored && run.status === 'running') {
        this.startLoop({ type: 'recover', runId: run.runId });
      }
    });
  }

  async submit(command: ConversationCommand): Promise<CommandReply> {
    return await this.enqueue(async () => {
      this.assertOperational();
      return await this.handleCommand(command);
    });
  }

  async snapshot(): Promise<SessionProjection> {
    this.assertOperational();
    return projectSession((await this.loadSnapshot()).state, this.#assistantDraft);
  }

  hasLoopFailure(): boolean {
    return this.#loopFailure !== undefined;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#active?.controller.abort('session_service_stopped');
    const errors: unknown[] = [];
    try {
      await this.#active?.task;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.#composition.dispose();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) throw new AggregateError(errors, 'session_actor_dispose_failed');
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
      case 'context.focus':
        return await this.handleFocus(command);
      case 'message.feedback.set':
        return await this.handleMessageFeedback(command);
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
    const events: NewSessionEvent[] = [{
        type: 'session.directory-index.detached',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, workspaceId: command.workspaceId },
      }];
    const activePlan = snapshot.state.activePlanRef
      ? snapshot.state.plans.find((candidate) => (
          candidate.planId === snapshot.state.activePlanRef?.planId
          && candidate.revision === snapshot.state.activePlanRef.revision
        ))
      : undefined;
    if (activePlan?.mutationManifest.some((operation) => (
      operation.workspaceId === command.workspaceId
    ))) {
      events.push({
        type: 'plan.invalidated',
        sessionId: this.sessionId,
        runId: activePlan.runId,
        payload: {
          planId: activePlan.planId,
          revision: activePlan.revision,
          reason: `Plan 引用的 workspace binding 已从 Session 移除：${command.workspaceId}`,
          sourceFactRef: command.commandId,
        },
      });
    }
    const reply = await this.#journal.commitCommand(
      command,
      events,
      acceptedReply(command),
    );
    return reply;
  }

  private async handleMessage(
    command: Extract<ConversationCommand, { type: 'message.submit' }>,
  ): Promise<CommandReply> {
    return await this.handleRunInput(command, command.text, null);
  }

  private async handleFocus(
    command: Extract<ConversationCommand, { type: 'context.focus' }>,
  ): Promise<CommandReply> {
    return await this.handleRunInput(command, command.task, command.task);
  }

  private async handleRunInput(
    command: Extract<ConversationCommand, { type: 'message.submit' | 'context.focus' }>,
    submittedText: string,
    focusTask: string | null,
  ): Promise<CommandReply> {
    if (!submittedText.trim()) {
      if (command.type === 'context.focus') {
        return await this.recordRejection(
          command,
          'context_focus_task_empty',
          '/focus 后必须提供新的任务正文。',
        );
      }
      return await this.recordRejection(command, 'message_empty', '用户消息不能为空。');
    }
    if (command.profileId !== undefined && !validProfileId(command.profileId)) {
      return await this.recordRejection(command, 'llm_profile_invalid', '模型 Profile 标识无效。');
    }
    const filesystemReferenceError = validateFilesystemReferences(command.filesystemReferences);
    if (filesystemReferenceError) {
      return await this.recordRejection(
        command,
        'message_filesystem_reference_invalid',
        filesystemReferenceError,
      );
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
    const runWorkspaceBindings = mergeWorkspaceBindings(
      before.state.workspaceBindings,
      (command.filesystemReferences ?? []).map((reference) => ({
        workspaceId: reference.workspaceId,
        displayName: reference.displayName,
      })),
    );
    const prepared = await this.#composition.runPreparation.prepare({
      sessionId: this.sessionId,
      runId,
      ...(profileId ? { profileId } : {}),
      ...(command.pluginCatalogRevision
        ? { pluginCatalogRevision: command.pluginCatalogRevision }
        : {}),
      ...(command.pluginSelections?.length
        ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) }
        : {}),
    });
    const runtimeSnapshot = prepared.runtimeSnapshot;
    const events: NewSessionEvent[] = [
      {
        type: 'input.accepted',
        sessionId: this.sessionId,
        payload: {
          commandId: command.commandId,
          messageId,
          text: submittedText,
          ...(command.pluginSelections?.length
            ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) }
            : {}),
        },
      },
      {
        type: 'message.committed',
        sessionId: this.sessionId,
        payload: {
          messageId,
          role: 'user',
          content: submittedText,
          ...(command.filesystemReferences?.length
            ? {
                filesystemReferences: command.filesystemReferences.map((reference) => ({
                  ...reference,
                })),
              }
            : {}),
          ...(command.pluginSelections?.length
            ? { pluginSelections: command.pluginSelections.map((selection) => ({ ...selection })) }
            : {}),
        },
      },
      {
        type: 'run.started',
        sessionId: this.sessionId,
        runId,
        payload: {
          inputMessageId: messageId,
          workspaceBindings: runWorkspaceBindings,
          runtimeSnapshot,
        },
      },
    ];
    if (focusTask !== null) {
      events.push({
        type: 'context.compaction.requested',
        sessionId: this.sessionId,
        runId,
        payload: {
          compactionId: this.#nextId('compaction'),
          providerRequestId: this.#nextId('provider-request'),
          trigger: 'userFocus',
          coveredThroughSequence: before.state.revision,
          focus: focusTask,
          commandId: command.commandId,
        },
      });
    }
    let reply: CommandReply;
    try {
      reply = await this.#journal.commitCommand(
        command,
        events,
        acceptedReply(command),
      );
    } catch (error) {
      try {
        await this.#composition.runPreparation.release({
          sessionId: this.sessionId,
          runId,
          kernelCatalogSnapshotRef: runtimeSnapshot.kernelCatalogSnapshotRef,
        });
      } catch (releaseError) {
        throw new AggregateError([error, releaseError], 'run_admission_release_failed');
      }
      throw error;
    }
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
      || plan.revision !== command.revision
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
    if (command.response.kind === 'requestRevision' && !command.response.text.trim()) {
      return await this.recordRejection(
        command,
        'plan_response_invalid',
        'Plan 修订说明不能为空。',
      );
    }

    const events: NewSessionEvent[] = [];
    if (command.response.kind === 'confirm') {
      const decisionId = this.#nextId('plan-decision');
      const superseded = planToSupersede(snapshot.state, plan.planId, plan.revision);
      if (superseded) {
        events.push({
          type: 'plan.superseded',
          sessionId: this.sessionId,
          runId: command.runId,
          payload: {
            planId: superseded.planId,
            revision: superseded.revision,
            supersededByPlanId: plan.planId,
            supersededByRevision: plan.revision,
          },
        });
      }
      const authorities = planAuthoritiesForConfirmation(
        plan,
        this.sessionId,
        decisionId,
        this.#nextId,
      );
      events.push({
        type: 'plan.confirmed',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: plan.callId,
        payload: {
          planId: plan.planId,
          revision: plan.revision,
          commandId: command.commandId,
          decisionId,
          authorities,
        },
      });
      const todoItems = todoItemsForPlan(plan, snapshot.state.todoList, this.#nextId);
      events.push({
        type: snapshot.state.todoList?.sourcePlanId === plan.planId
          ? 'todo.reconciled'
          : 'todo.seeded',
        sessionId: this.sessionId,
        runId: command.runId,
        payload: {
          sourcePlanId: plan.planId,
          sourcePlanRevision: plan.revision,
          items: todoItems,
        },
      });
    } else if (command.response.kind === 'requestRevision') {
      const messageId = this.#nextId('message');
      events.push({
        type: 'input.accepted',
        sessionId: this.sessionId,
        payload: { commandId: command.commandId, messageId, text: command.response.text },
      });
      events.push({
        type: 'plan.revision.requested',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: plan.callId,
        payload: {
          planId: plan.planId,
          revision: plan.revision,
          commandId: command.commandId,
          text: command.response.text,
        },
      });
      events.push({
        type: 'message.committed',
        sessionId: this.sessionId,
        runId: command.runId,
        payload: { messageId, role: 'user', content: command.response.text },
      });
    } else {
      events.push({
        type: 'plan.cancelled',
        sessionId: this.sessionId,
        runId: command.runId,
        callId: plan.callId,
        payload: {
          planId: plan.planId,
          revision: plan.revision,
          commandId: command.commandId,
        },
      });
    }
    const reply = await this.#journal.commitCommand(command, events, acceptedReply(command));
    if (command.response.kind === 'cancel') {
      if (this.#active?.runId === command.runId) {
        this.#active.controller.abort('user_cancelled_plan');
        await this.#active.task;
      } else {
        await this.runLoop({ type: 'cancel', runId: command.runId });
      }
    } else {
      this.startLoop({ type: 'resume', runId: command.runId });
    }
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
    const plan = snapshot.state.pendingPlan;
    const reply = await this.#journal.commitCommand(
      command,
      plan
        ? [{
            type: 'plan.cancelled',
            sessionId: this.sessionId,
            runId: command.runId,
            callId: plan.callId,
            payload: {
              planId: plan.planId,
              revision: plan.revision,
              commandId: command.commandId,
            },
          }]
        : [],
      acceptedReply(command),
    );
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
    const controller = new AbortController();
    const active: ActiveRun = { runId: command.runId, controller, task: Promise.resolve() };
    active.task = this.runLoop(command, controller.signal)
      .then(() => undefined)
      .catch(async (error: unknown) => {
        this.#loopFailure = await this.containLoopFailure(command.runId, error);
      })
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
    const result = await runAgentLoop(
      snapshot,
      command,
      {
        composition: this.#composition,
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
    if (result.status === 'finishing') {
      const current = await this.loadSnapshot();
      const settlement = current.state.pendingRunSettlements[command.runId];
      if (!settlement) throw new Error('run_finishing_settlement_missing');
      await this.finalizeRunRuntime(current, command.runId, settlement);
    }
  }

  private async containLoopFailure(runId: string, error: unknown): Promise<Error> {
    const failure = asError(error);
    let snapshot: LoopSnapshot;
    try {
      snapshot = await this.loadSnapshot();
    } catch (snapshotError) {
      return new AggregateError(
        [failure, asError(snapshotError)],
        failure.message,
      );
    }
    const runtime = snapshot.state.runRuntimeSnapshots[runId];
    if (!runtime || snapshot.state.runRuntimeReleases[runId]) return failure;
    try {
      await this.#composition.runPreparation.release({
        sessionId: this.sessionId,
        runId,
        kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
      });
    } catch (releaseError) {
      return new AggregateError(
        [failure, asError(releaseError)],
        failure.message,
      );
    }
    return failure;
  }

  private async restoreRunRuntime(snapshot: LoopSnapshot, runId: string): Promise<boolean> {
    const runtime = snapshot.state.runRuntimeSnapshots[runId];
    if (!runtime) throw new Error('run_runtime_snapshot_missing');
    let prepared;
    try {
      prepared = await this.#composition.runPreparation.prepare({
        sessionId: this.sessionId,
        runId,
        profileId: runtime.provider.profileId,
        ...recoveryPluginSelection(snapshot, runId, runtime),
      });
    } catch (error) {
      await this.settleRecoveryFailure(runId, error);
      return false;
    }
    const restored = prepared.runtimeSnapshot;
    if (canonicalJson(restored) !== canonicalJson(runtime)) {
      const mismatch = new Error('run_runtime_recovery_identity_mismatch');
      try {
        await this.#composition.runPreparation.release({
          sessionId: this.sessionId,
          runId,
          kernelCatalogSnapshotRef: prepared.runtimeSnapshot.kernelCatalogSnapshotRef,
        });
      } finally {
        await this.settleRecoveryFailure(runId, mismatch);
      }
      return false;
    }
    return true;
  }

  private async settleRecoveryFailure(runId: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.appendLifecycleEvents([{
      type: 'run.finishing',
      sessionId: this.sessionId,
      runId,
      payload: {
        outcome: 'failed',
        error: { code: errorCode(message), message },
      },
    }]);
    const snapshot = await this.loadSnapshot();
    const settlement = snapshot.state.pendingRunSettlements[runId];
    if (!settlement) throw new Error('run_finishing_settlement_missing');
    await this.finalizeRunRuntime(snapshot, runId, settlement);
  }

  private async finalizeRunRuntime(
    snapshot: LoopSnapshot,
    runId: string,
    settlement: RunSettlement,
  ): Promise<boolean> {
    const runtime = snapshot.state.runRuntimeSnapshots[runId];
    if (!runtime) throw new Error('run_runtime_snapshot_missing');
    if (snapshot.state.runRuntimeReleases[runId]) {
      await this.appendLifecycleEvents([{
        type: 'run.settled',
        sessionId: this.sessionId,
        runId,
        payload: cloneSettlement(settlement),
      }]);
      return true;
    }
    let released;
    try {
      released = await this.#composition.runPreparation.release({
        sessionId: this.sessionId,
        runId,
        kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendLifecycleEvents([{
        type: 'run.runtime.release_failed',
        sessionId: this.sessionId,
        runId,
        payload: {
          runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef,
          extensionGenerationRef: runtime.extensionGenerationRef,
          kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
          providerRuntimeRef: runtime.provider.providerRuntimeRef,
          error: { code: errorCode(message), message },
        },
      }]);
      return false;
    }
    await this.appendLifecycleEvents([
      {
        type: 'run.runtime.released',
        sessionId: this.sessionId,
        runId,
        payload: {
          runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef,
          extensionGenerationRef: runtime.extensionGenerationRef,
          kernelCatalogSnapshotRef: released.kernelCatalogSnapshotRef,
          providerRuntimeRef: runtime.provider.providerRuntimeRef,
          pluginInstanceRefs: runtime.selectedPlugins.plugins.map((plugin) => (
            plugin.pluginInstanceRef
          )),
          alreadyReleased: released.alreadyReleased,
        },
      },
      {
        type: 'run.settled',
        sessionId: this.sessionId,
        runId,
        payload: cloneSettlement(settlement),
      },
    ]);
    return true;
  }

  private async appendLifecycleEvents(events: readonly NewSessionEvent[]): Promise<void> {
    const current = await this.loadSnapshot();
    let previewState = current.state;
    for (const [index, event] of events.entries()) {
      previewState = reduceSession(previewState, {
        ...event,
        schemaVersion: SESSION_EVENT_VERSION,
        eventId: `preflight:${current.state.revision + index + 1}`,
        sequence: current.state.revision + index + 1,
        occurredAt: '1970-01-01T00:00:00.000Z',
      } as SessionEvent);
    }
    const committed = events.length === 1
      ? [await this.#journal.append(events[0]!)]
      : await this.#journal.appendBatch(events);
    for (const event of committed) await this.observe(event);
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

  private assertOperational(): void {
    if (this.#loopFailure) {
      throw new Error(`session_loop_failed:${this.#loopFailure.message}`, {
        cause: this.#loopFailure,
      });
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function planAuthoritiesForConfirmation(
  plan: NonNullable<SessionProjection['pendingPlan']>,
  sessionId: string,
  decisionId: string,
  nextId: (kind: string) => string,
): PlanAuthority[] {
  const workspaceIds = [...new Set(plan.mutationManifest.map((operation) => operation.workspaceId))];
  return workspaceIds.map((workspaceId) => ({
    authorityId: nextId('plan-authority'),
    planId: plan.planId,
    revision: plan.revision,
    decisionId,
    sessionId,
    runId: plan.runId,
    workspaceId,
    coveredOperations: plan.mutationManifest
      .filter((operation) => operation.workspaceId === workspaceId)
      .map((operation) => ({ ...operation })),
  }));
}

function planToSupersede(
  state: LoopSnapshot['state'],
  nextPlanId: string,
  nextRevision: number,
): { planId: string; revision: number } | null {
  if (state.activePlanRef && (
    state.activePlanRef.planId !== nextPlanId
    || state.activePlanRef.revision !== nextRevision
  )) return { ...state.activePlanRef };
  const previousRevision = state.plans
    .filter((candidate) => (
      candidate.planId === nextPlanId
      && candidate.revision < nextRevision
      && (candidate.status === 'confirmed' || candidate.status === 'revisionRequested')
    ))
    .sort((left, right) => right.revision - left.revision)[0];
  return previousRevision
    ? { planId: previousRevision.planId, revision: previousRevision.revision }
    : null;
}

function todoItemsForPlan(
  plan: NonNullable<SessionProjection['pendingPlan']>,
  previous: SessionProjection['todoList'],
  nextId: (kind: string) => string,
): NonNullable<SessionProjection['todoList']>['items'] {
  const previousByStep = new Map(
    previous?.sourcePlanId === plan.planId
      ? previous.items.map((item) => [item.sourceStepId, item] as const)
      : [],
  );
  return plan.steps.map((step) => {
    const existing = previousByStep.get(step.stepId);
    return {
      todoId: existing?.todoId ?? nextId('todo'),
      sourceStepId: step.stepId,
      label: step.title,
      status: existing?.status ?? 'pending',
    };
  });
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

function errorCode(message: string): string {
  const [candidate] = message.split(':', 1);
  return candidate && /^[a-z][a-z0-9_.-]{0,127}$/u.test(candidate)
    ? candidate
    : 'run_runtime_recovery_failed';
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

function recoveryPluginSelection(
  snapshot: LoopSnapshot,
  runId: string,
  runtime: LoopSnapshot['state']['runRuntimeSnapshots'][string],
): {
  pluginCatalogRevision?: string;
  pluginSelections?: Extract<ConversationCommand, { type: 'message.submit' }>['pluginSelections'];
} {
  const started = snapshot.events.find((event): event is Extract<
    SessionEvent,
    { type: 'run.started' }
  > => event.type === 'run.started' && event.runId === runId);
  if (!started) throw new Error('run_started_event_missing');
  const input = snapshot.events.find((event): event is Extract<
    SessionEvent,
    { type: 'input.accepted' }
  > => (
    event.type === 'input.accepted'
    && event.payload.messageId === started.payload.inputMessageId
  ));
  const selections = input?.payload.pluginSelections ?? [];
  if (selections.length === 0) return {};
  return {
    pluginCatalogRevision: runtime.selectedPlugins.catalogRevision,
    pluginSelections: selections.map((selection) => ({ ...selection })),
  };
}

function cloneSettlement(settlement: RunSettlement): RunSettlement {
  if (settlement.outcome === 'completed') return { ...settlement };
  if (settlement.outcome === 'failed' || settlement.outcome === 'indeterminate') {
    return { outcome: settlement.outcome, error: { ...settlement.error } };
  }
  return { outcome: 'cancelled' };
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
      || event.type === 'plan.published'
      || event.type === 'tool.requested'
      || event.type === 'run.finishing'
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

function validateFilesystemReferences(
  references: Extract<ConversationCommand, { type: 'message.submit' }>['filesystemReferences'],
): string | null {
  if (references === undefined) return null;
  if (!Array.isArray(references) || references.length > MAX_FILESYSTEM_REFERENCE_COUNT) {
    return `单次消息最多附加 ${MAX_FILESYSTEM_REFERENCE_COUNT} 个文件系统引用。`;
  }
  const referenceIds = new Set<string>();
  const targets = new Set<string>();
  for (const reference of references) {
    if (
      !reference
      || typeof reference !== 'object'
      || typeof reference.referenceId !== 'string'
      || !validProfileId(reference.referenceId)
      || referenceIds.has(reference.referenceId)
      || !validWorkspaceBinding({
        workspaceId: reference.workspaceId,
        displayName: reference.displayName,
      })
      || typeof reference.logicalPath !== 'string'
      || !validLogicalPath(reference.logicalPath)
      || targets.has(`${reference.workspaceId}\0${reference.logicalPath}`)
    ) {
      return '文件系统引用的 identity、workspace 或逻辑路径无效或重复。';
    }
    if (reference.kind === 'file') {
      if (
        reference.logicalPath === '.'
        || typeof reference.mediaType !== 'string'
        || !reference.mediaType.trim()
        || reference.mediaType.length > 128
        || !Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0
      ) return '文件引用的 kind、mediaType 或 byteLength 无效。';
    } else if (reference.kind === 'directory') {
      if (
        reference.logicalPath !== '.'
        || Object.hasOwn(reference, 'mediaType')
        || Object.hasOwn(reference, 'byteLength')
      ) return '目录引用必须指向 workspace 根且不能携带文件元数据。';
    } else {
      return '文件系统引用 kind 无效。';
    }
    referenceIds.add(reference.referenceId);
    targets.add(`${reference.workspaceId}\0${reference.logicalPath}`);
  }
  return null;
}

function validLogicalPath(value: string): boolean {
  if (!value || value.length > 4_096 || value.includes('\0') || value.includes('\\')) return false;
  if (value === '.') return true;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function mergeWorkspaceBindings(
  base: readonly WorkspaceBindingDisplay[],
  additions: readonly WorkspaceBindingDisplay[],
): WorkspaceBindingDisplay[] {
  const seen = new Set<string>();
  return [...base, ...additions]
    .filter((binding) => {
      if (seen.has(binding.workspaceId)) return false;
      seen.add(binding.workspaceId);
      return true;
    })
    .map((binding) => ({ ...binding }));
}

function defaultIdFactory(sessionId: string): (kind: string) => string {
  let next = 0;
  return (kind) => {
    next += 1;
    return `${sessionId}:${kind}:${Date.now().toString(36)}:${next.toString(36)}`;
  };
}
