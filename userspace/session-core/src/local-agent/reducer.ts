import type {
  ActivityProjection,
  AssistantDraftProjection,
  ArtifactProjection,
  PendingPlanProjection,
  SessionEvent,
  SessionProjection,
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
    display: { title: '新对话' },
    creationWorkspaceBindings: [],
    sessionDirectoryIndexes: [],
    workspaceBindings: [],
    messages: [],
    narratives: [],
    pendingInteraction: null,
    pendingApproval: null,
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
    })),
    narratives: previous.narratives.map((narrative) => ({ ...narrative })),
    pendingInteraction: cloneInteraction(previous.pendingInteraction),
    pendingApproval: cloneApproval(previous.pendingApproval),
    pendingPlan: clonePlanProjection(previous.pendingPlan),
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
      next.display = { title: event.payload.displayTitle };
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
      next.todoList = null;
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
    case 'plan.intent.requested':
      next.pendingPlan = projectPlan(event, currentRunBindings(next, event.runId));
      next.activities[planActivityId(event.payload.planId)] = {
        activityId: planActivityId(event.payload.planId),
        kind: 'plan',
        status: 'waiting',
        label: event.payload.prompt,
        runId: event.runId,
        sequence: event.sequence,
      };
      break;
    case 'plan.intent.resolved':
      if (
        !next.pendingPlan
        || next.pendingPlan.planId !== event.payload.planId
        || next.pendingPlan.runId !== event.runId
      ) throw new Error('plan_request_missing');
      next.pendingPlan = null;
      settleActivity(next, planActivityId(event.payload.planId), 'completed', event.sequence);
      resumeRun(next, event.runId);
      break;
    case 'todo.updated':
      assertRunningRun(next, event.runId, 'todo_run_not_active');
      next.todoList = {
        runId: event.runId,
        items: event.payload.items.map((item) => ({ ...item })),
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      };
      break;
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
    case 'context.composed':
      assertRunningRun(next, event.runId, 'provider_request_run_not_active');
      if (next.contextCompositions.some((receipt) => (
        receipt.providerRequestId === event.payload.providerRequestId
      ))) throw new Error('provider_request_receipt_duplicate');
      validateContextPartitions(event.payload.partitions);
      next.contextCompositions.push({
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
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
      next.contextUsage = {
        ...event.payload,
        providerRequestId,
        runId: event.runId,
        sequence: event.sequence,
        updatedAt: event.occurredAt,
      };
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
      next.pendingPlan = null;
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
    })),
    narratives: state.narratives.map((narrative) => ({ ...narrative })),
    assistantDraft: assistantDraft ? { ...assistantDraft } : null,
    pendingInteraction: cloneInteraction(state.pendingInteraction),
    pendingApproval: cloneApproval(state.pendingApproval),
    pendingPlan: clonePlanProjection(state.pendingPlan),
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
  event: Extract<SessionEvent, { type: 'plan.intent.requested' }>,
  bindings: readonly WorkspaceBindingDisplay[],
): PendingPlanProjection {
  const names = new Map(bindings.map((binding) => [binding.workspaceId, binding.displayName]));
  return {
    planId: event.payload.planId,
    runId: event.runId,
    prompt: event.payload.prompt,
    options: event.payload.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      operationsDisplay: option.operations.map((operation) => {
        const workspace = names.get(operation.workspaceId) ?? operation.workspaceId;
        const targetKind = operation.operation === 'fs.delete'
          ? ` (${operation.targetKind})`
          : '';
        return `${operation.operation} · ${workspace}:${operation.target}${targetKind}`;
      }),
    })),
    responseMode: 'optionOrFreeform',
    ignoreAllowed: true,
    sequence: event.sequence,
    createdAt: event.occurredAt,
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

function clonePlanProjection(plan: PendingPlanProjection | null): PendingPlanProjection | null {
  if (!plan) return null;
  return {
    ...plan,
    options: plan.options.map((option) => ({
      ...option,
      operationsDisplay: [...option.operationsDisplay],
    })),
  };
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
  };
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
function planActivityId(planId: string): string { return `plan:${planId}`; }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function addTokenCount(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error('token_usage_overflow');
  return total;
}
