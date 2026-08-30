import type {
  ActivityProjection,
  AssistantDraftProjection,
  ArtifactProjection,
  PendingPlanProjection,
  PlanProjection,
  SessionEvent,
  SessionProjection,
  ShellExecutionEnvironmentProjection,
  ToolExecutionRecord,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { SESSION_PROJECTION_VERSION } from '@deepcode/protocol';

export interface SessionState {
  sessionId: string;
  revision: number;
  display: SessionProjection['display'];
  creationWorkspaceBindings: WorkspaceBindingDisplay[];
  sessionDirectoryIndexes: WorkspaceBindingDisplay[];
  workspaceBindings: WorkspaceBindingDisplay[];
  messages: SessionProjection['messages'];
  narratives: SessionProjection['narratives'];
  pendingInteraction: SessionProjection['pendingInteraction'];
  pendingApproval: SessionProjection['pendingApproval'];
  plans: SessionProjection['plans'];
  activePlanRef: SessionProjection['activePlanRef'];
  pendingPlan: SessionProjection['pendingPlan'];
  todoList: SessionProjection['todoList'];
  contextUsage: SessionProjection['contextUsage'];
  contextCompositions: SessionProjection['contextCompositions'];
  tokenUsage: SessionProjection['tokenUsage'];
  tokenUsageHistory: Record<string, SessionProjection['tokenUsageHistory'][number]>;
  run: SessionProjection['run'];
  activities: Record<string, ActivityProjection>;
  artifacts: Record<string, ArtifactProjection>;
  terminalError: SessionProjection['terminalError'];
}

export function emptySessionState(sessionId: string): SessionState {
  return {
    sessionId,
    revision: 0,
    display: { creationTitle: '新对话' },
    creationWorkspaceBindings: [],
    sessionDirectoryIndexes: [],
    workspaceBindings: [],
    messages: [],
    narratives: [],
    pendingInteraction: null,
    pendingApproval: null,
    plans: [],
    activePlanRef: null,
    pendingPlan: null,
    todoList: null,
    contextUsage: null,
    contextCompositions: [],
    tokenUsage: {
      providerCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheReportedCallCount: 0,
    },
    tokenUsageHistory: {},
    run: null,
    activities: {},
    artifacts: {},
    terminalError: null,
  };
}

export function reduceSession(previous: SessionState, event: SessionEvent): SessionState {
  if (event.sessionId !== previous.sessionId) throw new Error('session_event_identity_mismatch');
  if (event.sequence !== previous.revision + 1) throw new Error('session_event_sequence_gap');

  const next: SessionState = {
    ...previous,
    revision: event.sequence,
    display: { ...previous.display },
    creationWorkspaceBindings: previous.creationWorkspaceBindings.map((binding) => ({ ...binding })),
    sessionDirectoryIndexes: previous.sessionDirectoryIndexes.map((binding) => ({ ...binding })),
    workspaceBindings: previous.workspaceBindings.map((binding) => ({ ...binding })),
    messages: previous.messages.map((message) => ({
      ...message,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      directoryAttachments: message.directoryAttachments.map((attachment) => ({ ...attachment })),
    })),
    narratives: previous.narratives.map((narrative) => ({ ...narrative })),
    pendingInteraction: cloneInteraction(previous.pendingInteraction),
    pendingApproval: cloneApproval(previous.pendingApproval),
    plans: previous.plans.map((plan) => clonePlanProjection(plan)),
    activePlanRef: previous.activePlanRef ? { ...previous.activePlanRef } : null,
    pendingPlan: previous.pendingPlan ? clonePlanProjection(previous.pendingPlan) : null,
    todoList: cloneTodoList(previous.todoList),
    contextUsage: previous.contextUsage ? { ...previous.contextUsage } : null,
    contextCompositions: previous.contextCompositions.map(cloneContextComposition),
    tokenUsage: { ...previous.tokenUsage },
    tokenUsageHistory: Object.fromEntries(
      Object.entries(previous.tokenUsageHistory).map(([runId, usage]) => [runId, { ...usage }]),
    ),
    run: previous.run ? cloneRun(previous.run) : null,
    activities: Object.fromEntries(
      Object.entries(previous.activities).map(([id, activity]) => [id, cloneActivity(activity)]),
    ),
    artifacts: Object.fromEntries(
      Object.entries(previous.artifacts).map(([id, artifact]) => [id, { ...artifact }]),
    ),
    terminalError: previous.terminalError ? { ...previous.terminalError } : null,
  };

  switch (event.type) {
    case 'session.created':
      next.display = { creationTitle: event.payload.displayTitle };
      next.creationWorkspaceBindings = event.payload.workspaceBindings.map((binding) => ({ ...binding }));
      next.sessionDirectoryIndexes = [];
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      break;
    case 'session.directory-index.attached':
      if (next.workspaceBindings.some((binding) => (
        binding.workspaceId === event.payload.workspaceBinding.workspaceId
      ))) throw new Error('session_directory_index_duplicate');
      next.sessionDirectoryIndexes.push({ ...event.payload.workspaceBinding });
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      break;
    case 'session.directory-index.detached': {
      const before = next.sessionDirectoryIndexes.length;
      next.sessionDirectoryIndexes = next.sessionDirectoryIndexes.filter((binding) => (
        binding.workspaceId !== event.payload.workspaceId
      ));
      if (next.sessionDirectoryIndexes.length === before) {
        throw new Error('session_directory_index_missing');
      }
      next.workspaceBindings = effectiveWorkspaceBindings(next);
      break;
    }
    case 'input.accepted':
      break;
    case 'run.started':
      {
        const inputMessage = next.messages.find((message) => (
          message.messageId === event.payload.inputMessageId && message.role === 'user'
        ));
        if (!inputMessage) throw new Error('run_input_message_missing');
        next.tokenUsageHistory[event.runId] = {
          runId: event.runId,
          inputMessageId: event.payload.inputMessageId,
          title: inputMessage.content,
          sequence: event.sequence,
          startedAt: event.occurredAt,
          providerCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheReportedCallCount: 0,
        };
      }
      next.run = {
        runId: event.runId,
        status: 'running',
        workspaceBindings: event.payload.workspaceBindings.map((binding) => ({ ...binding })),
        ...(event.payload.profileId ? { profileId: event.payload.profileId } : {}),
      };
      next.terminalError = null;
      next.activities[runActivityId(event.runId)] = {
        activityId: runActivityId(event.runId),
        kind: 'run',
        status: 'active',
        label: 'Agent run',
        runId: event.runId,
        sequence: event.sequence,
      };
      break;
    case 'run.profile.selected':
      assertCurrentRun(next, event.runId, 'run_profile_selection_identity_mismatch');
      next.run = { ...next.run!, profileId: event.payload.profileId };
      break;
    case 'message.committed':
      next.messages.push({
        messageId: event.payload.messageId,
        role: event.payload.role,
        content: event.payload.content,
        attachments: (event.payload.attachments ?? []).map((attachment) => ({
          attachmentId: attachment.attachmentId,
          name: attachment.name,
          mediaType: attachment.mediaType,
          byteLength: new TextEncoder().encode(attachment.content).byteLength,
        })),
        directoryAttachments: (event.payload.directoryAttachments ?? []).map((attachment) => ({
          ...attachment,
        })),
        feedback: null,
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'message.feedback.updated': {
      const index = next.messages.findIndex((message) => message.messageId === event.payload.messageId);
      if (index < 0 || next.messages[index].role !== 'assistant') {
        throw new Error('message_feedback_target_missing');
      }
      next.messages[index] = { ...next.messages[index], feedback: event.payload.feedback };
      break;
    }
    case 'narrative.committed':
      next.narratives.push({
        narrativeId: event.payload.narrativeId,
        runId: event.runId,
        content: event.payload.content,
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'interaction.requested':
      next.pendingInteraction = {
        interactionId: event.payload.interactionId,
        runId: event.runId,
        kind: event.payload.kind,
        prompt: event.payload.prompt,
        allowFreeform: event.payload.allowFreeform,
        ...(event.payload.options
          ? { options: event.payload.options.map((option) => ({ ...option })) }
          : {}),
        sequence: event.sequence,
        createdAt: event.occurredAt,
      };
      next.activities[interactionActivityId(event.payload.interactionId)] = {
        activityId: interactionActivityId(event.payload.interactionId),
        kind: 'interaction',
        status: 'waiting',
        label: event.payload.prompt,
        runId: event.runId,
        sequence: event.sequence,
      };
      break;
    case 'interaction.resolved':
      if (
        !next.pendingInteraction
        || next.pendingInteraction.interactionId !== event.payload.interactionId
        || next.pendingInteraction.runId !== event.runId
      ) throw new Error('interaction_request_missing');
      next.pendingInteraction = null;
      settleActivity(next, interactionActivityId(event.payload.interactionId), 'completed', event.sequence);
      resumeRun(next, event.runId);
      break;
    case 'plan.published': {
      if (findPlanIndex(next, event.payload.planId, event.payload.revision) >= 0) {
        throw new Error('plan_revision_duplicate');
      }
      const plan = projectPlan(event);
      next.plans.push(plan);
      next.pendingPlan = { ...clonePlanProjection(plan), responseMode: 'confirmReviseOrCancel' };
      next.activities[planActivityId(event.payload.planId, event.payload.revision)] = {
        activityId: planActivityId(event.payload.planId, event.payload.revision),
        kind: 'plan',
        status: 'waiting',
        label: event.payload.title,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      break;
    }
    case 'plan.confirmed':
      if (
        !next.pendingPlan
        || next.pendingPlan.planId !== event.payload.planId
        || next.pendingPlan.revision !== event.payload.revision
        || next.pendingPlan.runId !== event.runId
        || next.pendingPlan.callId !== event.callId
      ) throw new Error('plan_request_missing');
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'confirmed',
        decisionId: event.payload.decisionId,
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      next.pendingPlan = null;
      next.activePlanRef = {
        planId: event.payload.planId,
        revision: event.payload.revision,
      };
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'completed',
        event.sequence,
      );
      resumeRun(next, event.runId);
      break;
    case 'plan.revision.requested':
      assertPendingPlan(next, event);
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'revisionRequested',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      next.pendingPlan = null;
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'completed',
        event.sequence,
      );
      resumeRun(next, event.runId);
      break;
    case 'plan.cancelled':
      assertPendingPlan(next, event);
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'cancelled',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      next.pendingPlan = null;
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'cancelled',
        event.sequence,
      );
      resumeRun(next, event.runId);
      break;
    case 'plan.superseded':
      if (!['confirmed', 'revisionRequested'].includes(
        planFor(next, event.payload.planId, event.payload.revision).status,
      )) throw new Error('plan_supersede_state_invalid');
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'superseded',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      break;
    case 'plan.completed':
      if (
        !samePlanRef(next.activePlanRef, event.payload)
        || planFor(next, event.payload.planId, event.payload.revision).status !== 'confirmed'
        || !next.todoList
        || next.todoList.sourcePlanId !== event.payload.planId
        || next.todoList.sourcePlanRevision !== event.payload.revision
        || next.todoList.items.length === 0
        || next.todoList.items.some((item) => item.status !== 'completed')
      ) throw new Error('plan_completion_state_invalid');
      updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
        ...plan,
        status: 'completed',
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      }));
      if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
      settleActivity(
        next,
        planActivityId(event.payload.planId, event.payload.revision),
        'completed',
        event.sequence,
      );
      break;
    case 'plan.invalidated':
      if (!['published', 'confirmed', 'revisionRequested'].includes(
        planFor(next, event.payload.planId, event.payload.revision).status,
      )) throw new Error('plan_invalidation_state_invalid');
      {
        const invalidatedPending = samePlanRef(next.pendingPlan, event.payload);
        updatePlan(next, event.payload.planId, event.payload.revision, (plan) => ({
          ...plan,
          status: 'invalidated',
          sequence: event.sequence,
          updatedAt: event.occurredAt,
        }));
        if (samePlanRef(next.activePlanRef, event.payload)) next.activePlanRef = null;
        if (samePlanRef(next.pendingPlan, event.payload)) next.pendingPlan = null;
        settleActivity(
          next,
          planActivityId(event.payload.planId, event.payload.revision),
          'failed',
          event.sequence,
        );
        if (invalidatedPending) resumeRun(next, event.runId);
      }
      break;
    case 'todo.seeded':
    case 'todo.reconciled': {
      assertRunningRun(next, event.runId, 'todo_run_not_active');
      const sourcePlan = planFor(
        next,
        event.payload.sourcePlanId,
        event.payload.sourcePlanRevision,
      );
      if (sourcePlan.status !== 'confirmed') throw new Error('todo_source_plan_not_confirmed');
      const expectedSteps = new Map(sourcePlan.steps.map((step) => [step.stepId, step.title]));
      const todoIds = new Set<string>();
      const sourceStepIds = new Set<string>();
      let itemsMatchPlan = event.payload.items.length === sourcePlan.steps.length;
      for (const item of event.payload.items) {
        if (
          todoIds.has(item.todoId)
          || sourceStepIds.has(item.sourceStepId)
          || expectedSteps.get(item.sourceStepId) !== item.label
        ) {
          itemsMatchPlan = false;
          break;
        }
        todoIds.add(item.todoId);
        sourceStepIds.add(item.sourceStepId);
      }
      if (!itemsMatchPlan) throw new Error('todo_seed_plan_steps_mismatch');
      next.todoList = {
        sourcePlanId: event.payload.sourcePlanId,
        sourcePlanRevision: event.payload.sourcePlanRevision,
        items: event.payload.items.map((item) => ({ ...item })),
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      };
      break;
    }
    case 'todo.progressed': {
      assertRunningRun(next, event.runId, 'todo_run_not_active');
      if (
        !next.todoList
        || next.todoList.sourcePlanId !== event.payload.sourcePlanId
        || next.todoList.sourcePlanRevision !== event.payload.sourcePlanRevision
        || !samePlanRef(next.activePlanRef, {
          planId: event.payload.sourcePlanId,
          revision: event.payload.sourcePlanRevision,
        })
        || planFor(
          next,
          event.payload.sourcePlanId,
          event.payload.sourcePlanRevision,
        ).status !== 'confirmed'
      ) throw new Error('todo_source_plan_mismatch');
      if (new Set(event.payload.updates.map((update) => update.todoId)).size
        !== event.payload.updates.length) throw new Error('todo_update_duplicate');
      const updates = new Map(event.payload.updates.map((update) => [update.todoId, update.status]));
      for (const todoId of updates.keys()) {
        if (!next.todoList.items.some((item) => item.todoId === todoId)) {
          throw new Error('todo_item_missing');
        }
      }
      next.todoList = {
        ...next.todoList,
        items: next.todoList.items.map((item) => ({
          ...item,
          status: updates.get(item.todoId) ?? item.status,
        })),
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      };
      break;
    }
    case 'tool.requested':
      next.activities[toolActivityId(event.callId)] = {
        activityId: toolActivityId(event.callId),
        kind: 'tool',
        status: 'requested',
        label: event.payload.toolName,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      break;
    case 'approval.requested':
      next.pendingApproval = {
        approvalId: event.payload.approvalId,
        runId: event.runId,
        callId: event.callId,
        preview: {
          summary: event.payload.preview.summary,
          effects: [...event.payload.preview.effects],
          logicalTargets: [...event.payload.preview.logicalTargets],
        },
        sequence: event.sequence,
        createdAt: event.occurredAt,
      };
      next.activities[approvalActivityId(event.payload.approvalId)] = {
        activityId: approvalActivityId(event.payload.approvalId),
        kind: 'approval',
        status: 'waiting',
        label: event.payload.preview.summary,
        runId: event.runId,
        callId: event.callId,
        sequence: event.sequence,
      };
      break;
    case 'approval.resolved':
      if (
        !next.pendingApproval
        || next.pendingApproval.approvalId !== event.payload.approvalId
        || next.pendingApproval.callId !== event.callId
        || next.pendingApproval.runId !== event.runId
      ) throw new Error('approval_request_missing');
      next.pendingApproval = null;
      settleActivity(next, approvalActivityId(event.payload.approvalId), 'completed', event.sequence);
      resumeRun(next, event.runId);
      break;
    case 'tool.completed':
      settleActivity(
        next,
        toolActivityId(event.callId),
        event.payload.record.outcome,
        event.sequence,
      );
      next.activities[toolActivityId(event.callId)] = {
        ...next.activities[toolActivityId(event.callId)],
        tool: projectToolActivity(event.payload.record),
      };
      for (const artifact of artifactsFromRecord(event.payload.record)) {
        next.artifacts[artifact.artifactId] = artifact;
      }
      break;
    case 'session.control.rejected':
      assertRunningRun(next, event.runId, 'session_control_rejection_run_not_active');
      break;
    case 'context.compaction.requested':
    case 'context.compacted':
      assertRunningRun(next, event.runId, 'context_compaction_run_not_active');
      break;
    case 'context.composed':
      assertRunningRun(next, event.runId, 'provider_request_run_not_active');
      if (next.contextCompositions.some((receipt) => (
        receipt.providerRequestId === event.payload.providerRequestId
      ))) throw new Error('provider_request_receipt_duplicate');
      validateContextPartitions(event.payload.partitions);
      next.contextCompositions.push({
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
        purpose: event.payload.purpose,
        responseConstraint: event.payload.responseConstraint,
        messages: event.payload.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) => ({ ...block })),
          attachments: message.attachments.map((attachment) => ({ ...attachment })),
        })),
        workspaceBindings: event.payload.workspaceBindings.map((binding) => ({ ...binding })),
        tools: event.payload.tools.map((tool) => ({ ...tool })),
        partitions: event.payload.partitions.map((partition) => ({ ...partition })),
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'context.updated': {
      assertRunningRun(next, event.runId, 'provider_usage_run_not_active');
      const providerRequestId = event.payload.providerRequestId;
      const receiptIndex = next.contextCompositions.findIndex((receipt) => (
        receipt.runId === event.runId
        && receipt.providerRequestId === providerRequestId
      ));
      if (receiptIndex < 0) throw new Error('provider_request_receipt_missing');
      const receipt = next.contextCompositions[receiptIndex];
      next.contextCompositions[receiptIndex] = {
        ...receipt,
        partitions: estimatePartitionTokens(receipt.partitions, event.payload.inputTokens),
      };
      if (receipt.purpose === 'agent') {
        next.contextUsage = {
          ...event.payload,
          providerRequestId,
          runId: event.runId,
          sequence: event.sequence,
          updatedAt: event.occurredAt,
        };
      }
      next.tokenUsage = {
        providerCallCount: addTokenCount(next.tokenUsage.providerCallCount, 1),
        inputTokens: addTokenCount(next.tokenUsage.inputTokens, event.payload.inputTokens),
        outputTokens: addTokenCount(next.tokenUsage.outputTokens, event.payload.outputTokens),
        cacheReadInputTokens: addTokenCount(
          next.tokenUsage.cacheReadInputTokens,
          event.payload.cacheReadInputTokens ?? 0,
        ),
        cacheMissInputTokens: addTokenCount(
          next.tokenUsage.cacheMissInputTokens,
          event.payload.cacheMissInputTokens ?? 0,
        ),
        cacheReportedCallCount: addTokenCount(
          next.tokenUsage.cacheReportedCallCount,
          event.payload.cacheReadInputTokens === undefined ? 0 : 1,
        ),
      };
      const runUsage = next.tokenUsageHistory[event.runId];
      if (!runUsage) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = {
        ...runUsage,
        providerCallCount: addTokenCount(runUsage.providerCallCount, 1),
        inputTokens: addTokenCount(runUsage.inputTokens, event.payload.inputTokens),
        outputTokens: addTokenCount(runUsage.outputTokens, event.payload.outputTokens),
        cacheReadInputTokens: addTokenCount(
          runUsage.cacheReadInputTokens,
          event.payload.cacheReadInputTokens ?? 0,
        ),
        cacheMissInputTokens: addTokenCount(
          runUsage.cacheMissInputTokens,
          event.payload.cacheMissInputTokens ?? 0,
        ),
        cacheReportedCallCount: addTokenCount(
          runUsage.cacheReportedCallCount,
          event.payload.cacheReadInputTokens === undefined ? 0 : 1,
        ),
      };
      break;
    }
    case 'run.waiting':
      next.run = {
        runId: event.runId,
        status: 'waiting',
        waitingReason: event.payload.reason,
        workspaceBindings: currentRunBindings(next, event.runId),
        ...(next.run?.profileId ? { profileId: next.run.profileId } : {}),
      };
      break;
    case 'run.settled':
      if (!next.tokenUsageHistory[event.runId]) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = {
        ...next.tokenUsageHistory[event.runId],
        completedAt: event.occurredAt,
        outcome: event.payload.outcome,
      };
      next.run = {
        runId: event.runId,
        status: event.payload.outcome,
        workspaceBindings: currentRunBindings(next, event.runId),
        ...(next.run?.profileId ? { profileId: next.run.profileId } : {}),
      };
      next.pendingInteraction = null;
      next.pendingApproval = null;
      settleActivity(next, runActivityId(event.runId), event.payload.outcome, event.sequence);
      next.terminalError = event.payload.outcome === 'failed'
        || event.payload.outcome === 'indeterminate'
        ? { ...event.payload.error }
        : null;
      break;
  }
  return next;
}

export function recoverSession(sessionId: string, events: readonly SessionEvent[]): SessionState {
  return events.reduce(reduceSession, emptySessionState(sessionId));
}

export function projectSession(
  state: SessionState,
  assistantDraft: AssistantDraftProjection | null = null,
): SessionProjection {
  return {
    schemaVersion: SESSION_PROJECTION_VERSION,
    sessionId: state.sessionId,
    revision: state.revision,
    display: { ...state.display },
    workspaceBindings: state.workspaceBindings.map((binding) => ({ ...binding })),
    sessionDirectoryIndexes: state.sessionDirectoryIndexes.map((binding) => ({ ...binding })),
    messages: state.messages.map((message) => ({
      ...message,
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
      directoryAttachments: message.directoryAttachments.map((attachment) => ({ ...attachment })),
    })),
    narratives: state.narratives.map((narrative) => ({ ...narrative })),
    assistantDraft: assistantDraft ? { ...assistantDraft } : null,
    pendingInteraction: cloneInteraction(state.pendingInteraction),
    pendingApproval: cloneApproval(state.pendingApproval),
    plans: state.plans.map((plan) => clonePlanProjection(plan)),
    activePlanRef: state.activePlanRef ? { ...state.activePlanRef } : null,
    pendingPlan: state.pendingPlan ? clonePlanProjection(state.pendingPlan) : null,
    todoList: cloneTodoList(state.todoList),
    contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
    contextCompositions: state.contextCompositions.map(cloneContextComposition),
    tokenUsage: { ...state.tokenUsage },
    tokenUsageHistory: Object.values(state.tokenUsageHistory)
      .sort((left, right) => right.sequence - left.sequence)
      .map((usage) => ({ ...usage })),
    run: state.run ? cloneRun(state.run) : null,
    activities: Object.values(state.activities)
      .sort((left, right) => left.sequence - right.sequence)
      .map(cloneActivity),
    artifacts: Object.values(state.artifacts).map((artifact) => ({ ...artifact })),
    terminalError: state.terminalError ? { ...state.terminalError } : null,
  };
}

function effectiveWorkspaceBindings(state: Pick<
  SessionState,
  'creationWorkspaceBindings' | 'sessionDirectoryIndexes'
>): WorkspaceBindingDisplay[] {
  return [
    ...state.creationWorkspaceBindings.map((binding) => ({ ...binding })),
    ...state.sessionDirectoryIndexes.map((binding) => ({ ...binding })),
  ];
}

function currentRunBindings(state: SessionState, runId: string): WorkspaceBindingDisplay[] {
  if (!state.run || state.run.runId !== runId) throw new Error('run_workspace_snapshot_missing');
  return state.run.workspaceBindings.map((binding) => ({ ...binding }));
}

function cloneRun(run: NonNullable<SessionProjection['run']>): NonNullable<SessionProjection['run']> {
  return {
    ...run,
    workspaceBindings: run.workspaceBindings.map((binding) => ({ ...binding })),
  };
}

function cloneApproval(
  approval: SessionProjection['pendingApproval'],
): SessionProjection['pendingApproval'] {
  if (!approval) return null;
  return {
    ...approval,
    preview: {
      summary: approval.preview.summary,
      effects: [...approval.preview.effects],
      logicalTargets: [...approval.preview.logicalTargets],
    },
  };
}

function projectPlan(
  event: Extract<SessionEvent, { type: 'plan.published' }>,
): PlanProjection & { status: 'published' } {
  return {
    planId: event.payload.planId,
    revision: event.payload.revision,
    runId: event.runId,
    callId: event.callId,
    title: event.payload.title,
    summary: event.payload.summary,
    steps: event.payload.steps.map((step) => ({
      ...step,
      ...(step.verification ? { verification: [...step.verification] } : {}),
    })),
    mutationManifest: event.payload.mutationManifest.map((operation) => ({ ...operation })),
    status: 'published',
    sequence: event.sequence,
    createdAt: event.occurredAt,
    updatedAt: event.occurredAt,
  };
}

function cloneInteraction(
  interaction: SessionProjection['pendingInteraction'],
): SessionProjection['pendingInteraction'] {
  if (!interaction) return null;
  return {
    ...interaction,
    ...(interaction.options
      ? { options: interaction.options.map((option) => ({ ...option })) }
      : {}),
  };
}

function clonePlanProjection<T extends PlanProjection | PendingPlanProjection>(plan: T): T;
function clonePlanProjection(plan: null): null;
function clonePlanProjection(
  plan: PlanProjection | PendingPlanProjection | null,
): PlanProjection | PendingPlanProjection | null {
  if (plan === null) return null;
  return {
    ...plan,
    steps: plan.steps.map((step) => ({
      ...step,
      ...(step.verification ? { verification: [...step.verification] } : {}),
    })),
    mutationManifest: plan.mutationManifest.map((operation) => ({ ...operation })),
  };
}

function findPlanIndex(state: SessionState, planId: string, revision: number): number {
  return state.plans.findIndex((plan) => plan.planId === planId && plan.revision === revision);
}

function planFor(state: SessionState, planId: string, revision: number): PlanProjection {
  const plan = state.plans[findPlanIndex(state, planId, revision)];
  if (!plan) throw new Error('plan_revision_missing');
  return plan;
}

function updatePlan(
  state: SessionState,
  planId: string,
  revision: number,
  update: (plan: PlanProjection) => PlanProjection,
): void {
  const index = findPlanIndex(state, planId, revision);
  if (index < 0) throw new Error('plan_revision_missing');
  state.plans[index] = update(planFor(state, planId, revision));
}

function assertPendingPlan(
  state: SessionState,
  event: Extract<SessionEvent, { type: 'plan.revision.requested' | 'plan.cancelled' }>,
): void {
  if (
    !state.pendingPlan
    || state.pendingPlan.planId !== event.payload.planId
    || state.pendingPlan.revision !== event.payload.revision
    || state.pendingPlan.runId !== event.runId
    || state.pendingPlan.callId !== event.callId
  ) throw new Error('plan_request_missing');
}

function samePlanRef(
  reference: { planId: string; revision: number } | null,
  candidate: { planId: string; revision: number },
): boolean {
  return Boolean(
    reference
    && reference.planId === candidate.planId
    && reference.revision === candidate.revision
  );
}

function cloneTodoList(todoList: SessionProjection['todoList']): SessionProjection['todoList'] {
  if (!todoList) return null;
  return {
    ...todoList,
    items: todoList.items.map((item) => ({ ...item })),
  };
}

function cloneContextComposition(
  receipt: SessionProjection['contextCompositions'][number],
): SessionProjection['contextCompositions'][number] {
  return {
    ...receipt,
    messages: receipt.messages.map((message) => ({
      ...message,
      blocks: message.blocks.map((block) => ({ ...block })),
      attachments: message.attachments.map((attachment) => ({ ...attachment })),
    })),
    workspaceBindings: receipt.workspaceBindings.map((binding) => ({ ...binding })),
    tools: receipt.tools.map((tool) => ({ ...tool })),
    partitions: receipt.partitions.map((partition) => ({ ...partition })),
  };
}

const CONTEXT_PARTITION_ORDER = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'messageAttachments',
] as const;

function validateContextPartitions(
  partitions: Extract<SessionEvent, { type: 'context.composed' }>['payload']['partitions'],
): void {
  if (
    partitions.length !== CONTEXT_PARTITION_ORDER.length
    || partitions.some((partition, index) => (
      partition.kind !== CONTEXT_PARTITION_ORDER[index]
      || !Number.isSafeInteger(partition.itemCount)
      || partition.itemCount < 0
      || !Number.isSafeInteger(partition.requestShapeUnits)
      || partition.requestShapeUnits < 0
    ))
    || partitions.every((partition) => partition.requestShapeUnits === 0)
  ) throw new Error('context_partition_receipt_invalid');
}

function estimatePartitionTokens(
  partitions: NonNullable<SessionProjection['contextCompositions'][number]['partitions']>,
  inputTokens: number,
): NonNullable<SessionProjection['contextCompositions'][number]['partitions']> {
  validateContextPartitions(partitions);
  const totalUnits = partitions.reduce(
    (total, partition) => total + BigInt(partition.requestShapeUnits),
    0n,
  );
  const totalTokens = BigInt(inputTokens);
  const allocated = partitions.map((partition, index) => {
    const weighted = totalTokens * BigInt(partition.requestShapeUnits);
    return {
      index,
      tokens: weighted / totalUnits,
      remainder: weighted % totalUnits,
    };
  });
  let remaining = totalTokens - allocated.reduce((total, item) => total + item.tokens, 0n);
  for (const item of [...allocated].sort((left, right) => {
    if (left.remainder === right.remainder) return left.index - right.index;
    return left.remainder > right.remainder ? -1 : 1;
  })) {
    if (remaining === 0n) break;
    item.tokens += 1n;
    remaining -= 1n;
  }
  return partitions.map((partition, index) => ({
    kind: partition.kind,
    itemCount: partition.itemCount,
    requestShapeUnits: partition.requestShapeUnits,
    estimatedInputTokens: Number(allocated[index].tokens),
    tokenSource: 'sessionEstimated',
  }));
}

function cloneActivity(activity: ActivityProjection): ActivityProjection {
  return {
    ...activity,
    ...(activity.tool
      ? {
          tool: {
            ...activity.tool,
            resources: activity.tool.resources.map((resource) => ({ ...resource })),
            ...(activity.tool.shell
              ? {
                  shell: {
                    ...activity.tool.shell,
                    ...(activity.tool.shell.result
                      ? { result: { ...activity.tool.shell.result } }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
  };
}

function assertCurrentRun(state: SessionState, runId: string, code: string): void {
  if (!state.run || state.run.runId !== runId) throw new Error(code);
}

function assertRunningRun(state: SessionState, runId: string, code: string): void {
  if (!state.run || state.run.runId !== runId || state.run.status !== 'running') {
    throw new Error(code);
  }
}

function resumeRun(state: SessionState, runId: string): void {
  assertCurrentRun(state, runId, 'run_resume_identity_mismatch');
  state.run = {
    runId,
    status: 'running',
    workspaceBindings: state.run!.workspaceBindings.map((binding) => ({ ...binding })),
    ...(state.run?.profileId ? { profileId: state.run.profileId } : {}),
  };
}

function settleActivity(
  state: SessionState,
  activityId: string,
  status: ActivityProjection['status'],
  _sequence: number,
): void {
  const activity = state.activities[activityId];
  if (!activity) throw new Error(`activity_source_missing:${activityId}`);
  state.activities[activityId] = { ...activity, status };
}

function projectToolActivity(record: ToolExecutionRecord): NonNullable<ActivityProjection['tool']> {
  const { preparedEffect } = record;
  return {
    operation: preparedEffect.operation,
    resources: preparedEffect.logicalTargets.map((target) => {
      if (preparedEffect.workspaceId) {
        return {
          kind: 'workspacePath' as const,
          label: target,
          workspaceId: preparedEffect.workspaceId,
          logicalPath: target,
        };
      }
      if (/^https?:\/\//iu.test(target)) {
        return { kind: 'url' as const, label: target, uri: target };
      }
      return { kind: 'logicalTarget' as const, label: target };
    }),
    ...(record.toolName === 'process.shell' ? { shell: projectShellActivity(record) } : {}),
  };
}

function projectShellActivity(
  record: ToolExecutionRecord,
): NonNullable<NonNullable<ActivityProjection['tool']>['shell']> {
  const canonicalArguments = record.preparedEffect.canonicalInvocation.arguments;
  if (!isRecord(canonicalArguments)) {
    throw new Error('process_shell_projection_input_invalid');
  }
  const command = canonicalArguments.command;
  const cwd = canonicalArguments.cwd;
  if (
    typeof command !== 'string'
    || !command.trim()
    || typeof cwd !== 'string'
    || !cwd.trim()
  ) {
    throw new Error('process_shell_projection_input_invalid');
  }
  if (record.outcome !== 'completed') return { command, cwd };
  if (!isRecord(record.output)) throw new Error('process_shell_projection_output_invalid');
  const {
    command: outputCommand,
    cwd: outputCwd,
    stdout,
    stderr,
    exitCode,
    success,
    timedOut,
    truncated,
    capturedBytes,
    durationMs,
  } = record.output;
  if (
    outputCommand !== command
    || outputCwd !== cwd
    || typeof stdout !== 'string'
    || typeof stderr !== 'string'
    || !(exitCode === null || typeof exitCode === 'number' && Number.isSafeInteger(exitCode))
    || typeof success !== 'boolean'
    || typeof timedOut !== 'boolean'
    || typeof truncated !== 'boolean'
    || !isNaturalSafeInteger(capturedBytes)
    || !isNaturalSafeInteger(durationMs)
  ) {
    throw new Error('process_shell_projection_output_invalid');
  }
  const environment = projectShellEnvironment(record.output.environment);
  return {
    command,
    cwd,
    result: {
      stdout,
      stderr,
      exitCode,
      success,
      timedOut,
      truncated,
      capturedBytes,
      durationMs,
      ...(environment ? { environment } : {}),
    },
  };
}

function projectShellEnvironment(value: unknown): ShellExecutionEnvironmentProjection | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('process_shell_projection_environment_invalid');
  const { shell, interactive, pathSource, writeScope, homeWritable } = value;
  if (
    typeof shell !== 'string'
    || !shell.trim()
    || interactive !== false
    || pathSource !== 'hostPlusStandardDeveloperPaths'
    || writeScope !== 'workspaceAndKernelTemporary'
    || homeWritable !== false
  ) {
    throw new Error('process_shell_projection_environment_invalid');
  }
  return { shell, interactive, pathSource, writeScope, homeWritable };
}

function artifactsFromRecord(record: ToolExecutionRecord): ArtifactProjection[] {
  if (record.outcome !== 'completed' || !isRecord(record.output)) return [];
  const artifacts = record.output.artifacts;
  if (!Array.isArray(artifacts)) return [];
  return artifacts.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const { artifactId, label, workspaceId, logicalPath, uri } = candidate;
    if (typeof artifactId !== 'string' || typeof label !== 'string') return [];
    if (
      workspaceId !== undefined && typeof workspaceId !== 'string'
      || logicalPath !== undefined && typeof logicalPath !== 'string'
      || uri !== undefined && typeof uri !== 'string'
      || logicalPath === undefined && uri === undefined
    ) return [];
    return [{
      artifactId,
      label,
      ...(typeof workspaceId === 'string' ? { workspaceId } : {}),
      ...(typeof logicalPath === 'string' ? { logicalPath } : {}),
      ...(typeof uri === 'string' ? { uri } : {}),
    }];
  });
}

function runActivityId(runId: string): string { return `run:${runId}`; }
function toolActivityId(callId: string): string { return `tool:${callId}`; }
function approvalActivityId(approvalId: string): string { return `approval:${approvalId}`; }
function interactionActivityId(interactionId: string): string { return `interaction:${interactionId}`; }
function planActivityId(planId: string, revision: number): string {
  return `plan:${planId}:${revision}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNaturalSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function addTokenCount(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error('token_usage_overflow');
  return total;
}
