import { providerTextStreamId } from './streamIdentity.js';
import type {
  ActivityProjection,
  AssistantDraftProjection,
  ArtifactProjection,
  PendingPlanProjection,
  PlanProjection,
  ProviderOutputBlock,
  RunSettlement,
  RunRuntimeSnapshot,
  SessionEvent,
  SessionProjection,
  ShellExecutionEnvironmentProjection,
  ToolExecutionRecord,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import {
  SESSION_CONTROL_INTERACTION_REQUEST,
  SESSION_CONTROL_PLAN_PUBLISH,
  SESSION_PROJECTION_VERSION,
} from '@deepcode/protocol';

export interface SessionState {
  modelSettings: SessionProjection['modelSettings'];
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
  runRuntimeSnapshots: Record<string, RunRuntimeSnapshot>;
  pendingRunSettlements: Record<string, RunSettlement>;
  runRuntimeReleases: Record<
    string,
    Extract<SessionEvent, { type: 'run.runtime.released' }>['payload']
  >;
  providerTurns: Record<string, ProviderTurnState>;
  providerUsageRequestIds: Record<string, true>;
  providerCallFacts: Record<string, ProviderCallFactState>;
  run: SessionProjection['run'];
  activities: Record<string, ActivityProjection>;
  artifacts: Record<string, ArtifactProjection>;
  terminalError: SessionProjection['terminalError'];
}

export interface ProviderTurnState {
  runId: string;
  providerRequestId: string;
  purpose: 'agent' | 'contextCompaction';
  providerRuntimeRef: string;
  outcome: 'completed' | 'failed' | 'indeterminate';
  orderedCallIds?: string[];
  reasoningContent?: string;
  reasoningSignature?: string;
  hostedWebSearchCalls?: Record<string, unknown>[];
  orderedOutputBlocks?: ProviderOutputBlock[];
  error?: { code: string; message: string };
  sequence: number;
}

export interface ProviderCallFactState {
  runId: string;
  providerCallId: string;
  toolName: string;
  sequence: number;
}

export function emptySessionState(sessionId: string): SessionState {
  return {
    modelSettings: null,
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
      reportedCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheAvailable: false,
      cacheComplete: false,
      cacheHitRatio: null,
    },
    tokenUsageHistory: {},
    runRuntimeSnapshots: {},
    pendingRunSettlements: {},
    runRuntimeReleases: {},
    providerTurns: {},
    providerUsageRequestIds: {},
    providerCallFacts: {},
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
    modelSettings: previous.modelSettings ? { ...previous.modelSettings } : null,
    creationWorkspaceBindings: previous.creationWorkspaceBindings.map((binding) => ({ ...binding })),
    sessionDirectoryIndexes: previous.sessionDirectoryIndexes.map((binding) => ({ ...binding })),
    workspaceBindings: previous.workspaceBindings.map((binding) => ({ ...binding })),
    messages: previous.messages.map((message) => ({
      ...message,
      filesystemReferences: message.filesystemReferences.map((reference) => ({ ...reference })),
      pluginSelections: message.pluginSelections.map((selection) => ({ ...selection })),
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
    runRuntimeSnapshots: Object.fromEntries(
      Object.entries(previous.runRuntimeSnapshots).map(([runId, snapshot]) => (
        [runId, cloneRunRuntimeSnapshot(snapshot)]
      )),
    ),
    pendingRunSettlements: Object.fromEntries(
      Object.entries(previous.pendingRunSettlements).map(([runId, settlement]) => [
        runId,
        cloneRunSettlement(settlement),
      ]),
    ),
    runRuntimeReleases: Object.fromEntries(
      Object.entries(previous.runRuntimeReleases).map(([runId, receipt]) => [
        runId,
        { ...receipt, pluginInstanceRefs: [...receipt.pluginInstanceRefs] },
      ]),
    ),
    providerTurns: Object.fromEntries(
      Object.entries(previous.providerTurns).map(([requestId, turn]) => (
        [requestId, cloneProviderTurn(turn)]
      )),
    ),
    providerUsageRequestIds: { ...previous.providerUsageRequestIds },
    providerCallFacts: Object.fromEntries(Object.entries(previous.providerCallFacts)
      .map(([callId, fact]) => [callId, { ...fact }])),
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
    case 'session.model-settings.updated':
      next.modelSettings = { ...event.payload.settings };
      break;
    case 'session.created':
      next.modelSettings = event.payload.profileId
        ? { profileId: event.payload.profileId, reasoningEffortOverride: null } : null;
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
          reportedCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheMissInputTokens: 0,
          cacheAvailable: false,
          cacheComplete: false,
          cacheHitRatio: null,
        };
        if (next.runRuntimeSnapshots[event.runId]) {
          throw new Error('run_runtime_snapshot_duplicate');
        }
        next.runRuntimeSnapshots[event.runId] = cloneRunRuntimeSnapshot(
          event.payload.runtimeSnapshot,
        );
      }
      next.run = {
        runId: event.runId,
        status: 'running',
        workspaceBindings: event.payload.workspaceBindings.map((binding) => ({ ...binding })),
        profileId: event.payload.runtimeSnapshot.provider.profileId,
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
    case 'message.committed':
      {
        const common = {
          messageId: event.payload.messageId,
          content: event.payload.content,
          filesystemReferences: (event.payload.filesystemReferences ?? []).map((reference) => ({
            ...reference,
          })),
          pluginSelections: (event.payload.pluginSelections ?? []).map((selection) => ({
            ...selection,
          })),
          feedback: null,
          sequence: event.sequence,
          createdAt: event.occurredAt,
        };
        if (event.payload.role === 'assistant') {
          if (!event.runId) throw new Error('assistant_message_run_identity_missing');
          const turn = requiredProviderTurn(
            next,
            event.runId,
            event.payload.providerRequestId,
            'agent',
          );
          assertProviderMessageReference(
            turn,
            'finalMessage',
            event.payload.messageId,
            event.payload.content,
          );
          next.messages.push({
            ...common,
            role: 'assistant',
            runId: event.runId,
            providerRequestId: event.payload.providerRequestId,
          });
        } else {
          next.messages.push({
            ...common,
            role: event.payload.role,
            ...(event.runId ? { runId: event.runId } : {}),
          });
        }
      }
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
      assertProviderMessageReference(
        requiredProviderTurn(next, event.runId, event.payload.providerRequestId, 'agent'),
        'narrative',
        event.payload.narrativeId,
        event.payload.content,
      );
      next.narratives.push({
        narrativeId: event.payload.narrativeId,
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
        content: event.payload.content,
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'interaction.requested':
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        SESSION_CONTROL_INTERACTION_REQUEST,
        event.sequence,
      );
      next.pendingInteraction = {
        interactionId: event.payload.interactionId,
        runId: event.runId,
        callId: event.callId,
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
        callId: event.callId,
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
      settleActivity(next, interactionActivityId(event.payload.interactionId), 'completed');
      resumeRun(next, event.runId);
      break;
    case 'plan.published': {
      if (findPlanIndex(next, event.payload.planId, event.payload.revision) >= 0) {
        throw new Error('plan_revision_duplicate');
      }
      const plan = projectPlan(event);
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        SESSION_CONTROL_PLAN_PUBLISH,
        event.sequence,
      );
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
      if (event.callId && event.payload.providerCallId) {
        recordProviderCallFact(next, event.callId, event.runId, event.payload.providerCallId, 'plan.progress', event.sequence);
      }
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
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        event.payload.toolName,
        event.sequence,
      );
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
      settleActivity(next, approvalActivityId(event.payload.approvalId), 'completed');
      resumeRun(next, event.runId);
      break;
    case 'tool.input-rejected':
      settleActivity(next, toolActivityId(event.callId), 'rejected');
      next.activities[toolActivityId(event.callId)] = {
        ...next.activities[toolActivityId(event.callId)],
        inputRejection: structuredClone(event.payload.rejection.error),
      };
      break;
    case 'tool.completed':
      settleActivity(
        next,
        toolActivityId(event.callId),
        event.payload.record.outcome,
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
      recordProviderCallFact(
        next,
        event.callId,
        event.runId,
        event.payload.providerCallId,
        event.payload.toolName,
        event.sequence,
      );
      if (event.payload.error.code !== 'plan_revision_unchanged') {
        next.activities[toolActivityId(event.callId)] = {
          activityId: toolActivityId(event.callId),
          kind: 'tool',
          status: 'rejected',
          label: event.payload.toolName,
          runId: event.runId,
          callId: event.callId,
          sequence: event.sequence,
          inputRejection: {
            ...event.payload.error,
            issues: [{ path: '$', rule: 'session_control_schema', message: event.payload.error.message }],
          },
        };
      }
      break;
    case 'context.compaction.requested':
      assertRunningRun(next, event.runId, 'context_compaction_run_not_active');
      break;
    case 'context.compacted':
      assertRunningRun(next, event.runId, 'context_compaction_run_not_active');
      requiredProviderTurn(
        next,
        event.runId,
        event.payload.providerRequestId,
        'contextCompaction',
      );
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
        stableCoreHash: event.payload.stableCoreHash,
        baseToolSchemaHash: event.payload.baseToolSchemaHash,
        selectedPluginSnapshotHash: event.payload.selectedPluginSnapshotHash,
        dynamicInstructionBytes: event.payload.dynamicInstructionBytes,
        messages: event.payload.messages.map((message) => ({
          ...message,
          blocks: message.blocks.map((block) => ({ ...block })),
          filesystemReferences: message.filesystemReferences.map((reference) => ({
            ...reference,
          })),
        })),
        workspaceBindings: event.payload.workspaceBindings.map((binding) => ({ ...binding })),
        tools: event.payload.tools.map((tool) => ({ ...tool })),
        partitions: event.payload.partitions.map((partition) => ({ ...partition })),
        sequence: event.sequence,
        createdAt: event.occurredAt,
      });
      break;
    case 'provider.turn.settled': {
      assertRunningRun(next, event.runId, 'provider_turn_run_not_active');
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (event.payload.providerRuntimeRef !== runtime.provider.providerRuntimeRef) {
        throw new Error('provider_turn_runtime_identity_mismatch');
      }
      const receipt = next.contextCompositions.find((candidate) => (
        candidate.runId === event.runId
        && candidate.providerRequestId === event.payload.providerRequestId
      ));
      if (!receipt || receipt.purpose !== event.payload.purpose) {
        throw new Error('provider_turn_composition_missing');
      }
      if (next.providerTurns[event.payload.providerRequestId]) {
        throw new Error('provider_turn_completion_duplicate');
      }
      const currentTurnCallFacts = Object.entries(next.providerCallFacts)
        .filter(([, fact]) => (
          fact.runId === event.runId
          && fact.sequence > receipt.sequence
          && fact.sequence < event.sequence
        ))
        .sort((left, right) => left[1].sequence - right[1].sequence);
      const currentTurnCallIds = currentTurnCallFacts.map(([callId]) => callId);
      const settlement = event.payload;
      if (settlement.outcome === 'completed') {
        if (new Set(settlement.orderedCallIds).size !== settlement.orderedCallIds.length) {
          throw new Error('provider_turn_call_order_invalid');
        }
        if (
          currentTurnCallIds.length !== settlement.orderedCallIds.length
          || currentTurnCallIds.some((callId, index) => (
            callId !== settlement.orderedCallIds[index]
          ))
        ) {
          throw new Error('provider_turn_call_order_mismatch');
        }
        if (settlement.orderedOutputBlocks !== undefined) {
          validateOrderedProviderOutputBlocks(
            settlement.orderedOutputBlocks,
            settlement.orderedCallIds,
          );
          const orderedToolCalls = settlement.orderedOutputBlocks.filter((block) => (
            block.kind === 'toolCall'
          ));
          if (orderedToolCalls.some((block, index) => {
            const fact = currentTurnCallFacts[index];
            return !fact
              || fact[0] !== block.callId
              || fact[1].providerCallId !== block.providerCallId
              || fact[1].toolName !== block.toolName;
          })) {
            throw new Error('provider_turn_call_identity_mismatch');
          }
          if (settlement.purpose !== 'agent') {
            throw new Error('provider_output_blocks_purpose_invalid');
          }
          if (
            settlement.orderedOutputBlocks.some((block) => block.kind === 'providerHosted')
            && runtime.webSearch.owner !== 'providerHosted'
          ) {
            throw new Error('provider_hosted_search_owner_mismatch');
          }
        }
      } else if (currentTurnCallIds.length > 0) {
        throw new Error('provider_turn_terminal_call_facts_invalid');
      }
      next.providerTurns[event.payload.providerRequestId] = {
        runId: event.runId,
        providerRequestId: event.payload.providerRequestId,
        purpose: event.payload.purpose,
        providerRuntimeRef: event.payload.providerRuntimeRef,
        outcome: event.payload.outcome,
        ...(event.payload.outcome === 'completed'
          ? {
              orderedCallIds: [...event.payload.orderedCallIds],
              ...(event.payload.reasoningContent !== undefined
                ? { reasoningContent: event.payload.reasoningContent }
                : {}),
              ...(event.payload.reasoningSignature !== undefined
                ? { reasoningSignature: event.payload.reasoningSignature }
                : {}),
              ...(event.payload.hostedWebSearchCalls !== undefined
                ? {
                    hostedWebSearchCalls: event.payload.hostedWebSearchCalls
                      .map((item) => structuredClone(item)),
                  }
                : {}),
              ...(event.payload.orderedOutputBlocks !== undefined
                ? {
                    orderedOutputBlocks: event.payload.orderedOutputBlocks.map((block) => ({
                      ...block,
                      item: structuredClone(block.item),
                    })),
                  }
                : {}),
            }
          : { error: { ...event.payload.error } }),
        sequence: event.sequence,
      };
      if (settlement.outcome === 'completed') {
        for (const block of settlement.orderedOutputBlocks ?? []) {
          if (block.kind === 'toolCallRejected') {
            if (next.providerCallFacts[block.callId] || next.activities[toolActivityId(block.callId)]) {
              throw new Error('provider_turn_rejected_call_identity_duplicate');
            }
            next.activities[toolActivityId(block.callId)] = {
              activityId: toolActivityId(block.callId),
              kind: 'tool',
              status: 'rejected',
              label: block.toolName,
              runId: event.runId,
              callId: block.callId,
              sequence: event.sequence,
              inputRejection: structuredClone(block.error),
            };
          }
          if (block.kind !== 'providerHosted') continue;
          const status = block.item.status;
          const action = block.item.action;
          if (
            status !== 'completed' && status !== 'failed'
            || !isRecord(action)
          ) throw new Error('provider_hosted_search_item_invalid');
          next.activities[block.activityId] = {
            activityId: block.activityId,
            kind: 'providerHosted',
            status,
            label: 'web.search',
            runId: event.runId,
            sequence: event.sequence,
            providerHosted: {
              providerToolType: block.providerToolType,
              providerCallId: block.providerCallId,
              action: structuredClone(action),
            },
          };
        }
      }
      next.tokenUsage = withProviderCompletion(next.tokenUsage);
      const runUsage = next.tokenUsageHistory[event.runId];
      if (!runUsage) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = withProviderCompletion(runUsage);
      // The last settled call owns this slot, even when it reports no usage.
      next.contextUsage = null;
      break;
    }
    case 'context.updated': {
      assertRunningRun(next, event.runId, 'provider_usage_run_not_active');
      const providerRequestId = event.payload.providerRequestId;
      requiredProviderTurn(next, event.runId, providerRequestId);
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (
        event.payload.providerRuntimeRef !== runtime.provider.providerRuntimeRef
        || event.payload.contextWindowTokens !== runtime.provider.contextWindowTokens
      ) {
        throw new Error('provider_usage_runtime_identity_mismatch');
      }
      const cacheReadPresent = event.payload.cacheReadInputTokens !== undefined;
      const cacheMissPresent = event.payload.cacheMissInputTokens !== undefined;
      if (
        cacheReadPresent !== cacheMissPresent
        || cacheReadPresent
          && addTokenCount(
            event.payload.cacheReadInputTokens!,
            event.payload.cacheMissInputTokens!,
          ) !== event.payload.inputTokens
      ) {
        throw new Error('provider_usage_cache_invalid');
      }
      if (next.providerUsageRequestIds[providerRequestId]) {
        throw new Error('provider_usage_duplicate');
      }
      const receiptIndex = next.contextCompositions.findIndex((receipt) => (
        receipt.runId === event.runId
        && receipt.providerRequestId === providerRequestId
      ));
      if (receiptIndex < 0) throw new Error('provider_request_receipt_missing');
      next.providerUsageRequestIds[providerRequestId] = true;
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
      next.tokenUsage = withProviderUsage(next.tokenUsage, event.payload);
      const runUsage = next.tokenUsageHistory[event.runId];
      if (!runUsage) throw new Error('token_usage_run_missing');
      next.tokenUsageHistory[event.runId] = withProviderUsage(runUsage, event.payload);
      break;
    }
    case 'run.waiting':
      next.run = {
        runId: event.runId,
        status: 'waiting',
        waitingReason: event.payload.reason,
        workspaceBindings: currentRunBindings(next, event.runId),
        profileId: requiredRunRuntimeSnapshot(next, event.runId).provider.profileId,
      };
      break;
    case 'run.finishing':
      assertCurrentRun(next, event.runId, 'run_finishing_identity_mismatch');
      if (
        next.pendingRunSettlements[event.runId]
        || next.runRuntimeReleases[event.runId]
        || !['running', 'waiting'].includes(next.run!.status)
      ) throw new Error('run_finishing_state_invalid');
      next.pendingRunSettlements[event.runId] = cloneRunSettlement(event.payload);
      next.run = {
        runId: event.runId,
        status: 'releasing',
        workspaceBindings: currentRunBindings(next, event.runId),
        profileId: requiredRunRuntimeSnapshot(next, event.runId).provider.profileId,
      };
      next.pendingInteraction = null;
      next.pendingApproval = null;
      break;
    case 'run.runtime.release_failed': {
      assertCurrentRun(next, event.runId, 'run_runtime_release_failure_identity_mismatch');
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (
        !next.pendingRunSettlements[event.runId]
        || next.runRuntimeReleases[event.runId]
        || !['releasing', 'releaseFailed'].includes(next.run!.status)
        || event.payload.runRuntimeSnapshotRef !== runtime.runRuntimeSnapshotRef
        || event.payload.extensionGenerationRef !== runtime.extensionGenerationRef
        || event.payload.kernelCatalogSnapshotRef !== runtime.kernelCatalogSnapshotRef
        || event.payload.providerRuntimeRef !== runtime.provider.providerRuntimeRef
      ) throw new Error('run_runtime_release_failure_state_invalid');
      next.run = {
        runId: event.runId,
        status: 'releaseFailed',
        workspaceBindings: currentRunBindings(next, event.runId),
        profileId: runtime.provider.profileId,
      };
      next.terminalError = { ...event.payload.error };
      break;
    }
    case 'run.runtime.released': {
      assertCurrentRun(next, event.runId, 'run_runtime_release_identity_mismatch');
      const runtime = requiredRunRuntimeSnapshot(next, event.runId);
      if (
        !next.pendingRunSettlements[event.runId]
        || next.runRuntimeReleases[event.runId]
        || !['releasing', 'releaseFailed'].includes(next.run!.status)
        || event.payload.runRuntimeSnapshotRef !== runtime.runRuntimeSnapshotRef
        || event.payload.extensionGenerationRef !== runtime.extensionGenerationRef
        || event.payload.kernelCatalogSnapshotRef !== runtime.kernelCatalogSnapshotRef
        || event.payload.providerRuntimeRef !== runtime.provider.providerRuntimeRef
        || new Set(event.payload.pluginInstanceRefs).size !== event.payload.pluginInstanceRefs.length
        || event.payload.pluginInstanceRefs.some((pluginInstanceRef) => (
          !runtime.selectedPlugins.plugins.some((plugin) => (
            plugin.pluginInstanceRef === pluginInstanceRef
          ))
        ))
      ) throw new Error('run_runtime_release_receipt_invalid');
      next.runRuntimeReleases[event.runId] = {
        ...event.payload,
        pluginInstanceRefs: [...event.payload.pluginInstanceRefs],
      };
      next.run = {
        runId: event.runId,
        status: 'releasing',
        workspaceBindings: currentRunBindings(next, event.runId),
        profileId: runtime.provider.profileId,
      };
      next.terminalError = null;
      break;
    }
    case 'run.settled':
      if (
        !next.pendingRunSettlements[event.runId]
        || !next.runRuntimeReleases[event.runId]
        || !sameRunSettlement(next.pendingRunSettlements[event.runId], event.payload)
      ) throw new Error('run_settlement_release_receipt_missing');
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
        profileId: requiredRunRuntimeSnapshot(next, event.runId).provider.profileId,
      };
      next.pendingInteraction = null;
      next.pendingApproval = null;
      settleActivity(next, runActivityId(event.runId), event.payload.outcome);
      next.terminalError = event.payload.outcome === 'failed'
        || event.payload.outcome === 'indeterminate'
        ? { ...event.payload.error }
        : null;
      delete next.pendingRunSettlements[event.runId];
      break;
  }
  if (next.run) {
    const provider = requiredRunRuntimeSnapshot(next, next.run.runId).provider;
    next.run = {
      ...next.run,
      ...(provider.reasoningEffort ? { reasoningEffort: provider.reasoningEffort } : {}),
      ...(provider.thinking ? { thinking: provider.thinking } : {}),
    };
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
  const rounds = new Map<string, string[]>();
  for (const activity of Object.values(state.activities).sort((left, right) => left.sequence - right.sequence)) {
    if (!activity.tool?.fileChanges?.length || !activity.tool.recordId) continue;
    const records = rounds.get(activity.runId) ?? [];
    records.push(activity.tool.recordId); rounds.set(activity.runId, records);
  }
  return {
    schemaVersion: SESSION_PROJECTION_VERSION,
    ...(rounds.size ? { fileChangeRounds: [...rounds].map(([runId, recordIds]) => ({ runId, recordIds })) } : {}),
    sessionId: state.sessionId,
    revision: state.revision,
    display: { ...state.display },
    modelSettings: state.modelSettings ? { ...state.modelSettings } : null,
    workspaceBindings: state.workspaceBindings.map((binding) => ({ ...binding })),
    sessionDirectoryIndexes: state.sessionDirectoryIndexes.map((binding) => ({ ...binding })),
    messages: state.messages.map((message) => ({
      ...message,
      filesystemReferences: message.filesystemReferences.map((reference) => ({ ...reference })),
      pluginSelections: message.pluginSelections.map((selection) => ({ ...selection })),
    })),
    narratives: state.narratives.map((narrative) => ({ ...narrative })),
    timeline: projectTimeline(state),
    assistantDraft: assistantDraft ? structuredClone(assistantDraft) : null,
    pendingInteraction: cloneInteraction(state.pendingInteraction),
    pendingApproval: cloneApproval(state.pendingApproval),
    plans: state.plans.map((plan) => clonePlanProjection(plan)),
    activePlanRef: state.activePlanRef ? { ...state.activePlanRef } : null,
    pendingPlan: state.pendingPlan ? clonePlanProjection(state.pendingPlan) : null,
    todoList: cloneTodoList(state.todoList),
    contextUsage: state.contextUsage ? { ...state.contextUsage } : null,
    // The ball displays the last settled call; also expose a pending call's
    // composition before usage arrives. Historical receipts remain in the journal.
    contextCompositions: state.contextCompositions.filter((receipt, index) => (
      receipt.providerRequestId === state.contextUsage?.providerRequestId
      || index === state.contextCompositions.length - 1
    )).map(cloneContextComposition),
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

function cloneRunRuntimeSnapshot(snapshot: RunRuntimeSnapshot): RunRuntimeSnapshot {
  const storedAliases = (snapshot as unknown as { providerToolAliases?: unknown })
    .providerToolAliases;
  const storedToolPromptContributions = (
    snapshot as unknown as { toolPromptContributions?: unknown }
  ).toolPromptContributions;
  if (!Array.isArray(storedAliases)) {
    throw new Error('run_runtime_provider_tool_aliases_missing');
  }
  if (!Array.isArray(storedToolPromptContributions)) {
    throw new Error('run_runtime_tool_prompt_contributions_missing');
  }
  const providerToolAliases = (storedAliases as RunRuntimeSnapshot['providerToolAliases'])
    .map((alias) => ({ ...alias }));
  const toolPromptContributions = (
    storedToolPromptContributions as RunRuntimeSnapshot['toolPromptContributions']
  ).map((contribution) => ({
    ...contribution,
    usageGuidelines: [...contribution.usageGuidelines],
  }));
  return {
    ...snapshot,
    provider: { ...snapshot.provider },
    webSearch: { ...snapshot.webSearch },
    instructions: snapshot.instructions.map((instruction) => ({ ...instruction })),
    tools: snapshot.tools.map((tool) => ({
      ...tool,
      inputSchema: structuredClone(tool.inputSchema),
      possibleEffects: [...tool.possibleEffects],
    })),
    toolPromptContributions,
    providerToolAliases,
    selectedPlugins: {
      catalogRevision: snapshot.selectedPlugins.catalogRevision,
      plugins: snapshot.selectedPlugins.plugins.map((plugin) => ({
        ...plugin,
        capabilityRefs: [...plugin.capabilityRefs],
      })),
    },
  };
}

function cloneProviderTurn(turn: ProviderTurnState): ProviderTurnState {
  return {
    ...turn,
    ...(turn.orderedCallIds ? { orderedCallIds: [...turn.orderedCallIds] } : {}),
    ...(turn.hostedWebSearchCalls
      ? { hostedWebSearchCalls: turn.hostedWebSearchCalls.map((item) => structuredClone(item)) }
      : {}),
    ...(turn.orderedOutputBlocks
      ? {
          orderedOutputBlocks: turn.orderedOutputBlocks.map((block) => ({
            ...block,
            item: structuredClone(block.item),
          })),
        }
      : {}),
    ...(turn.error ? { error: { ...turn.error } } : {}),
  };
}

function validateOrderedProviderOutputBlocks(
  blocks: readonly ProviderOutputBlock[],
  orderedCallIds: readonly string[],
): void {
  if (blocks.length === 0) throw new Error('provider_output_blocks_empty');
  const callIds: string[] = [];
  const allCallIds = new Set<string>();
  const referenceIds = new Set<string>();
  const providerCallIds = new Set<string>();
  let previousOutputIndex = -1;
  let finalMessageCount = 0;
  const addUnique = (values: Set<string>, value: string): boolean => {
    if (values.has(value)) return false;
    values.add(value);
    return true;
  };
  for (const block of blocks) {
    if (
      !Number.isSafeInteger(block.outputIndex)
      || block.outputIndex < 0
      || block.outputIndex <= previousOutputIndex
      || !isRecord(block.item)
    ) throw new Error('provider_output_block_invalid');
    previousOutputIndex = block.outputIndex;
    switch (block.kind) {
      case 'reasoning':
        if (block.item.type !== 'reasoning') throw new Error('provider_output_block_invalid');
        break;
      case 'narrative':
        if (
          block.item.type !== 'message'
          || !addUnique(referenceIds, `narrative:${block.narrativeId}`)
        ) throw new Error('provider_output_block_invalid');
        break;
      case 'finalMessage':
        finalMessageCount += 1;
        if (
          block.item.type !== 'message'
          || !addUnique(referenceIds, `message:${block.messageId}`)
        ) throw new Error('provider_output_block_invalid');
        break;
      case 'toolCall':
      case 'toolCallRejected':
        if (
          block.item.type !== 'function_call'
          || block.item.call_id !== block.providerCallId
          || !block.callId || !block.providerCallId || !block.toolName
          || typeof block.item.name !== 'string' || !block.item.name
          || typeof block.item.arguments !== 'string'
          || !addUnique(allCallIds, block.callId)
          || !addUnique(providerCallIds, block.providerCallId)
        ) throw new Error('provider_output_block_invalid');
        if (block.kind === 'toolCall') callIds.push(block.callId);
        else if (!block.error.code || !block.error.message || !block.error.issues?.length
          || block.error.issues.some((issue) => !issue.path || !issue.rule || !issue.message)) {
          throw new Error('provider_output_rejection_invalid');
        }
        break;
      case 'providerHosted':
        if (
          block.providerToolType !== 'web_search'
          || block.item.type !== 'web_search_call'
          || block.item.id !== block.providerCallId
          || !addUnique(providerCallIds, block.providerCallId)
          || !addUnique(referenceIds, `activity:${block.activityId}`)
        ) throw new Error('provider_output_block_invalid');
        break;
    }
  }
  if (
    finalMessageCount > 1
    || callIds.length !== orderedCallIds.length
    || callIds.some((callId, index) => callId !== orderedCallIds[index])
    || allCallIds.size === 0 && finalMessageCount !== 1
    || allCallIds.size > 0 && finalMessageCount !== 0
  ) throw new Error('provider_output_block_normalization_invalid');
}

function assertProviderMessageReference(
  turn: ProviderTurnState,
  kind: 'narrative' | 'finalMessage',
  referenceId: string,
  content: string,
): void {
  if (!turn.orderedOutputBlocks) return;
  const matches = turn.orderedOutputBlocks.filter((block) => (
    block.kind === kind
    && (kind === 'narrative'
      ? block.kind === 'narrative' && block.narrativeId === referenceId
      : block.kind === 'finalMessage' && block.messageId === referenceId)
  ));
  if (
    matches.length !== 1
    || providerOutputMessageText(matches[0]!.item) !== content
  ) throw new Error('provider_output_message_reference_invalid');
}

function providerOutputMessageText(item: Record<string, unknown>): string {
  if (item.type !== 'message' || !Array.isArray(item.content)) {
    throw new Error('provider_output_message_item_invalid');
  }
  let text = '';
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== 'output_text') continue;
    if (typeof part.text !== 'string') throw new Error('provider_output_message_item_invalid');
    text += part.text;
  }
  if (!text.trim()) throw new Error('provider_output_message_item_invalid');
  return text;
}

function requiredRunRuntimeSnapshot(state: SessionState, runId: string): RunRuntimeSnapshot {
  const snapshot = state.runRuntimeSnapshots[runId];
  if (!snapshot) throw new Error('run_runtime_snapshot_missing');
  return snapshot;
}

function requiredProviderTurn(
  state: SessionState,
  runId: string,
  providerRequestId: string,
  purpose?: ProviderTurnState['purpose'],
): ProviderTurnState {
  const turn = state.providerTurns[providerRequestId];
  if (
    !turn
    || turn.outcome !== 'completed'
    || turn.runId !== runId
    || purpose !== undefined && turn.purpose !== purpose
  ) {
    throw new Error('provider_turn_completion_missing');
  }
  return turn;
}

function projectTimeline(state: SessionState): SessionProjection['timeline'] {
  const groups: Array<{
    sequence: number;
    items: SessionProjection['timeline'];
  }> = [];
  for (const message of state.messages) {
    if (message.role !== 'user') continue;
    groups.push({
      sequence: message.sequence,
      items: [{
        kind: 'message',
        timelineId: `message:${message.messageId}`,
        sequence: message.sequence,
        messageId: message.messageId,
      }],
    });
  }
  for (const turn of Object.values(state.providerTurns)) {
    if (turn.purpose !== 'agent' || turn.outcome !== 'completed') continue;
    const composition = state.contextCompositions.find((candidate) => (
      candidate.runId === turn.runId
      && candidate.providerRequestId === turn.providerRequestId
    ));
    if (!composition) throw new Error('provider_turn_composition_missing');
    if (turn.orderedOutputBlocks) {
      const items = projectOrderedProviderTurnTimeline(state, turn);
      if (items.length > 0) groups.push({ sequence: composition.sequence, items });
      continue;
    }
    const items: SessionProjection['timeline'] = [];
    const message = state.messages.find((candidate) => (
      candidate.role === 'assistant'
      && candidate.runId === turn.runId
      && candidate.providerRequestId === turn.providerRequestId
    ));
    if (message) {
      items.push({
        kind: 'message',
        timelineId: `message:${message.messageId}`,
        sequence: message.sequence,
        messageId: message.messageId,
        streamId: providerTextStreamId(state.sessionId, turn.runId, turn.providerRequestId),
      });
    }
    const narrative = state.narratives.find((candidate) => (
      candidate.runId === turn.runId
      && candidate.providerRequestId === turn.providerRequestId
    ));
    if (narrative) {
      items.push({
        kind: 'narrative',
        timelineId: `provider-turn:${turn.providerRequestId}:narrative`,
        sequence: narrative.sequence,
        providerRequestId: turn.providerRequestId,
        narrativeId: narrative.narrativeId,
        streamId: providerTextStreamId(state.sessionId, turn.runId, turn.providerRequestId),
      });
    }
    const orderedCallIds = turn.orderedCallIds ?? [];
    for (const callId of orderedCallIds) {
      const plan = state.plans.find((candidate) => candidate.callId === callId);
      if (!plan) continue;
      items.push({
        kind: 'plan',
        timelineId: `provider-turn:${turn.providerRequestId}:plan:${callId}`,
        sequence: plan.sequence,
        providerRequestId: turn.providerRequestId,
        planId: plan.planId,
        revision: plan.revision,
      });
    }
    const toolActivities = orderedCallIds.flatMap((callId) => {
      const activity = Object.values(state.activities).find((candidate) => (
        candidate.kind === 'tool' && candidate.callId === callId
      ));
      return activity ? [activity] : [];
    });
    if (toolActivities.length > 0) {
      items.push({
        kind: 'toolGroup',
        timelineId: `provider-turn:${turn.providerRequestId}:tools`,
        sequence: Math.max(...toolActivities.map((activity) => activity.sequence)),
        providerRequestId: turn.providerRequestId,
        activityIds: toolActivities.map((activity) => activity.activityId),
      });
    }
    if (items.length > 0) groups.push({ sequence: composition.sequence, items });
  }
  return groups
    .sort((left, right) => left.sequence - right.sequence)
    .flatMap((group) => group.items);
}

function projectOrderedProviderTurnTimeline(
  state: SessionState,
  turn: ProviderTurnState,
): SessionProjection['timeline'] {
  const items: SessionProjection['timeline'] = [];
  let groupedActivities: ActivityProjection[] = [];
  let activityGroupIndex = 0;
  const flushActivities = (): void => {
    if (groupedActivities.length === 0) return;
    items.push({
      kind: 'toolGroup',
      timelineId: `provider-turn:${turn.providerRequestId}:activities:${activityGroupIndex}`,
      sequence: Math.max(...groupedActivities.map((activity) => activity.sequence)),
      providerRequestId: turn.providerRequestId,
      activityIds: groupedActivities.map((activity) => activity.activityId),
    });
    activityGroupIndex += 1;
    groupedActivities = [];
  };
  for (const block of turn.orderedOutputBlocks ?? []) {
    switch (block.kind) {
      case 'reasoning':
        break;
      case 'narrative': {
        flushActivities();
        const narrative = state.narratives.find((candidate) => (
          candidate.narrativeId === block.narrativeId
          && candidate.providerRequestId === turn.providerRequestId
        ));
        if (!narrative) throw new Error('provider_output_narrative_missing');
        items.push({
          kind: 'narrative',
          timelineId: `provider-turn:${turn.providerRequestId}:narrative:${block.outputIndex}`,
          sequence: narrative.sequence,
          providerRequestId: turn.providerRequestId,
          narrativeId: narrative.narrativeId,
          outputIndex: block.outputIndex,
          streamId: providerTextStreamId(
            state.sessionId, turn.runId, turn.providerRequestId, block.outputIndex,
          ),
        });
        break;
      }
      case 'finalMessage': {
        flushActivities();
        const message = state.messages.find((candidate) => (
          candidate.role === 'assistant'
          && candidate.messageId === block.messageId
          && candidate.providerRequestId === turn.providerRequestId
        ));
        if (!message) throw new Error('provider_output_final_message_missing');
        items.push({
          kind: 'message',
          timelineId: `message:${message.messageId}`,
          sequence: message.sequence,
          messageId: message.messageId,
          outputIndex: block.outputIndex,
          streamId: providerTextStreamId(
            state.sessionId, turn.runId, turn.providerRequestId, block.outputIndex,
          ),
        });
        break;
      }
      case 'providerHosted': {
        const activity = state.activities[block.activityId];
        if (!activity || activity.kind !== 'providerHosted') {
          throw new Error('provider_hosted_activity_missing');
        }
        groupedActivities.push(activity);
        break;
      }
      case 'toolCallRejected':
      case 'toolCall': {
        const plan = state.plans.find((candidate) => candidate.callId === block.callId);
        if (plan) {
          flushActivities();
          items.push({
            kind: 'plan',
            timelineId: `provider-turn:${turn.providerRequestId}:plan:${block.callId}`,
            sequence: plan.sequence,
            providerRequestId: turn.providerRequestId,
            planId: plan.planId,
            revision: plan.revision,
          });
          break;
        }
        const activity = Object.values(state.activities).find((candidate) => (
          candidate.kind === 'tool' && candidate.callId === block.callId
        ));
        if (activity) groupedActivities.push(activity);
        break;
      }
    }
  }
  flushActivities();
  return items;
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

function cloneRunSettlement(settlement: RunSettlement): RunSettlement {
  if (settlement.outcome === 'completed') return { ...settlement };
  if (settlement.outcome === 'failed' || settlement.outcome === 'indeterminate') {
    return { outcome: settlement.outcome, error: { ...settlement.error } };
  }
  return { outcome: 'cancelled' };
}

function sameRunSettlement(left: RunSettlement, right: RunSettlement): boolean {
  if (left.outcome !== right.outcome) return false;
  if (left.outcome === 'completed' && right.outcome === 'completed') {
    return left.finalMessageId === right.finalMessageId;
  }
  if (
    (left.outcome === 'failed' || left.outcome === 'indeterminate')
    && (right.outcome === 'failed' || right.outcome === 'indeterminate')
  ) {
    return left.error.code === right.error.code && left.error.message === right.error.message;
  }
  return left.outcome === 'cancelled' && right.outcome === 'cancelled';
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
      filesystemReferences: message.filesystemReferences.map((reference) => ({ ...reference })),
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
  'filesystemReferences',
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
    ...(activity.inputRejection ? { inputRejection: structuredClone(activity.inputRejection) } : {}),
    ...(activity.tool
      ? {
          tool: {
            ...activity.tool,
            resources: activity.tool.resources.map((resource) => ({ ...resource })),
            ...(activity.tool.fileChanges ? { fileChanges: structuredClone(activity.tool.fileChanges) } : {}),
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
    ...(activity.providerHosted
      ? {
          providerHosted: {
            ...activity.providerHosted,
            action: structuredClone(activity.providerHosted.action),
          },
        }
      : {}),
  };
}

function assertCurrentRun(state: SessionState, runId: string, code: string): void {
  if (!state.run || state.run.runId !== runId) throw new Error(code);
}

function recordProviderCallFact(
  state: SessionState,
  callId: string,
  runId: string,
  providerCallId: string,
  toolName: string,
  sequence: number,
): void {
  if (state.providerCallFacts[callId] !== undefined) throw new Error('provider_call_fact_duplicate');
  state.providerCallFacts[callId] = { runId, providerCallId, toolName, sequence };
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
    profileId: state.run!.profileId,
  };
}

function settleActivity(
  state: SessionState,
  activityId: string,
  status: ActivityProjection['status'],
): void {
  const activity = state.activities[activityId];
  if (!activity) throw new Error(`activity_source_missing:${activityId}`);
  state.activities[activityId] = { ...activity, status };
}

function projectToolActivity(record: ToolExecutionRecord): NonNullable<ActivityProjection['tool']> {
  const { preparedEffect } = record;
  return {
    recordId: record.recordId,
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
    ...(record.toolName === 'bash' ? { shell: projectShellActivity(record) } : {}),
    ...projectFileChanges(record),
  };
}

function projectShellActivity(
  record: ToolExecutionRecord,
): NonNullable<NonNullable<ActivityProjection['tool']>['shell']> {
  const canonicalArguments = record.preparedEffect.canonicalInvocation.arguments;
  if (!isRecord(canonicalArguments)) {
    throw new Error('bash_projection_input_invalid');
  }
  const command = canonicalArguments.command;
  const cwd = '.';
  const workspaceMode = canonicalArguments.workspaceMode;
  const executionScope = canonicalArguments.executionScope;
  const terminal = canonicalArguments.terminal !== undefined;
  if (
    typeof command !== 'string'
    || !command.trim()
    || !matchesProcessWorkspaceMode(workspaceMode)
    || !matchesProcessExecutionScope(executionScope)
    || terminal && !isCanonicalTerminalInput(canonicalArguments.terminal)
  ) {
    throw new Error('bash_projection_input_invalid');
  }
  const output = record.outcome === 'completed'
    ? record.output
    : record.outcome === 'failed'
      ? record.output
      : undefined;
  if (output === undefined) return { command, cwd, executionScope, terminal };
  if (!isRecord(output)) throw new Error('bash_projection_output_invalid');
  const {
    command: outputCommand,
    cwd: outputCwd,
    workspaceId: outputWorkspaceId,
    workspaceMode: outputWorkspaceMode,
    executionScope: outputExecutionScope,
    terminal: outputTerminal,
    stdout,
    stderr,
    exitCode,
    success,
    timedOut,
    truncated,
    capturedBytes,
    durationMs,
  } = output;
  if (
    outputCommand !== command
    || outputCwd !== cwd
    || outputWorkspaceId !== record.preparedEffect.workspaceId
    || outputWorkspaceMode !== workspaceMode
    || outputExecutionScope !== executionScope
    || outputTerminal !== terminal
    || typeof stdout !== 'string'
    || typeof stderr !== 'string'
    || !(exitCode === null || typeof exitCode === 'number' && Number.isSafeInteger(exitCode))
    || typeof success !== 'boolean'
    || typeof timedOut !== 'boolean'
    || typeof truncated !== 'boolean'
    || !isNaturalSafeInteger(capturedBytes)
    || !isNaturalSafeInteger(durationMs)
  ) {
    throw new Error('bash_projection_output_invalid');
  }
  const environment = projectShellEnvironment(
    output.environment,
    workspaceMode,
    executionScope,
    terminal,
  );
  return {
    command,
    cwd,
    executionScope,
    terminal,
    result: {
      stdout,
      stderr,
      exitCode,
      success,
      timedOut,
      truncated,
      capturedBytes,
      durationMs,
      environment,
    },
  };
}

function projectShellEnvironment(
  value: unknown,
  workspaceMode: 'read' | 'write',
  executionScope: 'workspace' | 'host',
  terminal: boolean,
): ShellExecutionEnvironmentProjection {
  if (!isRecord(value)) throw new Error('bash_projection_environment_invalid');
  const {
    shell,
    interactive,
    executionScope: outputExecutionScope,
    terminal: outputTerminal,
    pathSource,
    writeScope,
    homeWritable,
    networkAccess,
  } = value;
  const expectedWriteScope: ShellExecutionEnvironmentProjection['writeScope'] = (
    executionScope === 'host'
      ? 'hostUser'
      : workspaceMode === 'read'
        ? 'kernelTemporaryOnly'
        : 'workspaceAndKernelTemporary'
  );
  if (
    typeof shell !== 'string'
    || !shell.trim()
    || interactive !== terminal
    || outputExecutionScope !== executionScope
    || outputTerminal !== terminal
    || pathSource !== 'hostPlusStandardDeveloperPaths'
    || writeScope !== expectedWriteScope
    || homeWritable !== (executionScope === 'host')
    || networkAccess !== (executionScope === 'host')
  ) {
    throw new Error('bash_projection_environment_invalid');
  }
  return {
    shell,
    interactive,
    executionScope,
    terminal,
    pathSource,
    writeScope: expectedWriteScope,
    homeWritable,
    networkAccess,
  };
}

function matchesProcessWorkspaceMode(value: unknown): value is 'read' | 'write' {
  return value === 'read' || value === 'write';
}

function matchesProcessExecutionScope(value: unknown): value is 'workspace' | 'host' {
  return value === 'workspace' || value === 'host';
}

function isCanonicalTerminalInput(value: unknown): value is { stdin: string } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.stdin === 'string'
    && new TextEncoder().encode(value.stdin).byteLength <= 65_536;
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

function withProviderCompletion<T extends SessionProjection['tokenUsage']>(usage: T): T {
  return recomputeCacheAggregate({
    ...usage,
    providerCallCount: addTokenCount(usage.providerCallCount, 1),
  });
}

function withProviderUsage<T extends SessionProjection['tokenUsage']>(
  usage: T,
  reported: Extract<SessionEvent, { type: 'context.updated' }>['payload'],
): T {
  const cacheReported = reported.cacheReadInputTokens !== undefined;
  return recomputeCacheAggregate({
    ...usage,
    reportedCallCount: addTokenCount(usage.reportedCallCount, cacheReported ? 1 : 0),
    inputTokens: addTokenCount(usage.inputTokens, reported.inputTokens),
    outputTokens: addTokenCount(usage.outputTokens, reported.outputTokens),
    cacheReadInputTokens: addTokenCount(
      usage.cacheReadInputTokens,
      reported.cacheReadInputTokens ?? 0,
    ),
    cacheMissInputTokens: addTokenCount(
      usage.cacheMissInputTokens,
      reported.cacheMissInputTokens ?? 0,
    ),
  });
}

function recomputeCacheAggregate<T extends SessionProjection['tokenUsage']>(usage: T): T {
  const cacheAvailable = usage.reportedCallCount > 0;
  return {
    ...usage,
    cacheAvailable,
    cacheComplete: usage.providerCallCount > 0
      && usage.reportedCallCount === usage.providerCallCount,
    cacheHitRatio: cacheAvailable && usage.inputTokens > 0
      ? usage.cacheReadInputTokens / usage.inputTokens
      : null,
  };
}

function addTokenCount(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error('token_usage_overflow');
  return total;
}

function projectFileChanges(record: ToolExecutionRecord): Pick<NonNullable<ActivityProjection['tool']>, 'fileChanges'> {
  if (!('output' in record) || !record.output || typeof record.output !== 'object' || Array.isArray(record.output)) return {};
  const changes = (record.output as Record<string, unknown>).fileChanges;
  if (changes === undefined) return {};
  if (!Array.isArray(changes) || changes.some((change) => {
    if (!change || typeof change !== 'object' || Array.isArray(change)) return true;
    return typeof change.workspaceId !== 'string' || change.workspaceId !== record.preparedEffect.workspaceId
      || typeof change.path !== 'string' || !['create', 'modify', 'delete'].includes(String(change.kind))
      || ![change.before, change.after].every((side) => side && typeof side === 'object' && !Array.isArray(side)
        && typeof side.exists === 'boolean' && (!side.exists || typeof side.contentRef === 'string' || typeof side.error === 'string'))
      || (change.kind === 'create' && (change.before?.exists !== false || change.after?.exists !== true))
      || (change.kind === 'delete' && (change.before?.exists !== true || change.after?.exists !== false))
      || (change.kind === 'modify' && (change.before?.exists !== true || change.after?.exists !== true));
  })) throw new Error('kernel_file_changes_invalid');
  return { fileChanges: structuredClone(changes) as unknown as NonNullable<ActivityProjection['tool']>['fileChanges'] };
}
