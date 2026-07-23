import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ConversationLanguage,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
} from '@deepcode/protocol';
import type {
  ContextAssemblyRecord,
  ContextAssemblyTaskLocalCompactRecord,
  PromptCachePlan,
  ProjectMemoryMode,
  SessionMemoryDocument,
} from '../../context/index.js';
import { collectTaskLocalCompactRecords } from '../../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type {
  AcceptedTaskPlanContext,
  ImplementationBatchContext,
  TaskExecutionCursor,
  CurrentTaskContext,
} from '../execution/index.js';
import type {
  AcceptedPlanPromptFrame,
  TaskLedgerSnapshot,
} from '../../run-state/index.js';
import type { DriverRequestRef, KernelStateContractRef } from '../types.js';
import type { InteractionOverlayContext, SessionTurnPhase } from './interactionOverlayCodec.js';
import type { DriverProviderTurnFrame, SessionDriverTaskResourceProgress } from '../runFrame.js';
import { latestEventRunId, recoverKernelContext } from '../context/kernelEnvelopeReader.js';
import {
  buildUserAuthorityFrame,
  createSessionTurnAuthorityEvent,
  hasLegacySessionTurnAuthority,
  latestExplicitUserContent,
  latestSessionTurnAuthority,
  UserAuthorityFrameError,
  type UserAuthorityFrame,
} from '../context/userAuthorityFrame.js';
import {
  createSessionLanguageDecisionEvent,
  nextConversationLanguageRevision,
  normalizeHostLanguage,
  resolveConversationLanguagePolicy,
} from '../context/conversationLanguagePolicy.js';
import { findActiveInteraction } from '../../run-state/index.js';
import {
  emptyPromptLedgerState,
  PromptLedgerCompatibilityError,
  restoreProviderRequestCacheHistory,
  restorePromptLedger,
  type PromptLedgerState,
  type PromptLedgerWireRecord,
  type ProviderRequestCacheHistoryEntry,
} from '../../prompt/promptLedger.js';
import { ArtifactDraftLease } from '../execution/artifactDraftLedger.js';
import type { AcceptedTaskReplanReason } from '../execution/artifactDraftReplanCoordinator.js';
import type { AutonomyMode } from '../../sessionModes.js';
import type { NativeToolCallProposal } from '../../provider/providerStreamParts.js';
import { PermissionPipeline } from './permissionPipeline.js';

export interface RunLifecycleInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  profileId?: string;
  workflow?: string;
  appendUserMessage?: boolean;
  confirmedRequirement?: RequirementRecord;
  projectMemoryMode?: ProjectMemoryMode;
  resumeResourcePackets?: boolean;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  interactionOverlay?: InteractionOverlayContext;
  autonomyMode?: AutonomyMode;
  hostLanguage?: ConversationLanguage;
}

export interface RunLifecycleState {
  sessionId: string;
  runId: string;
  userRequest: string;
  userAuthorityFrame: UserAuthorityFrame;
  promptLedger: PromptLedgerState;
  artifactDraftLease?: ArtifactDraftLease;
  artifactChunkRepairAttempts?: Record<string, number>;
  semanticDirectiveRepairAttempts?: Record<string, number>;
  pendingSemanticToolCalls?: Record<string, NativeToolCallProposal>;
  pendingProviderCommitEvents?: AgentEvent[];
  providerCommitDeferred?: boolean;
  providerRequestCacheHistory?: Record<string, ProviderRequestCacheHistoryEntry>;
  phase: SessionTurnPhase;
  workspaceScopeKey: string;
  workspaceBinding?: AgentWorkspaceBinding;
  stateContract?: KernelStateContractRef;
  driverRequest?: DriverRequestRef;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  initialContext: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  resourceEvidenceRevision: number;
  generatedArtifactEvidence: Map<string, unknown>;
  resourceRequestProgressByTask: Map<string, SessionDriverTaskResourceProgress>;
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  taskLocalCompactRecords?: ContextAssemblyTaskLocalCompactRecord[];
  taskExecutionCursor?: TaskExecutionCursor;
  currentTaskContext?: CurrentTaskContext;
  taskLedger?: TaskLedgerSnapshot;
  acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  providerTurnFrame?: DriverProviderTurnFrame;
  implementationBatch: ImplementationBatchContext;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  resourceRequestRepairAttempted: boolean;
  actionBundleAdmissionRepairAttempted: boolean;
  planReviewRepairAttempted: boolean;
  terminalGuidanceRevisionAttempted: boolean;
  nativeToolReadLedger: Map<string, unknown>;
  nativeToolDuplicateRepairAttempted: boolean;
  nativeToolResumeMessages?: LlmChatRequest['messages'];
  nativeToolResumeRound?: number;
  semanticDirectiveRepairAttempted?: boolean;
  semanticDirectiveErrorSummary?: string;
  taskPlanReplanReason?: AcceptedTaskReplanReason;
  interactionOverlay?: InteractionOverlayContext;
}

export interface RunLifecyclePipelinePorts<State extends RunLifecycleState> {
  createId(prefix: string): string;
  now(): string;
  createError(code: string, message: string): Error;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult>;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'context_reading';
    status: 'running';
    reason: 'session';
    decisionOwner: {
      kind: 'session';
      runId: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
  userMessageEvent(input: {
    sessionId: string;
    content: string;
    attachments: AgentContextAttachment[];
  }): AgentEvent;
  kernelRunAttachments(input: RunLifecycleInput): AgentContextAttachment[];
  buildManifest(input: RunLifecycleInput, manifestId: string): {
    manifest: ResourceManifest;
    conversationRoots: ConversationResourceRoot[];
  };
  buildImplementationBatch(events: AgentEvent[]): ImplementationBatchContext;
  buildMemoryDocument(events: AgentEvent[], options: { projectMemoryMode?: ProjectMemoryMode }): SessionMemoryDocument;
  recentResourcePackets(events: AgentEvent[]): ResourcePacket[];
  generatedArtifactEvidenceFromPackets(packets: ResourcePacket[]): Map<string, unknown>;
  initialTaskRuntime(input: {
    acceptedPlan?: AcceptedTaskPlanContext;
    resourcePackets: ResourcePacket[];
    lastSavepointId?: string;
  }): {
    taskExecutionCursor?: TaskExecutionCursor;
    currentTaskContext?: CurrentTaskContext;
    taskLedger?: TaskLedgerSnapshot;
    acceptedPlanPromptFrame?: AcceptedPlanPromptFrame;
  };
  lastSavepointId(events: AgentEvent[]): string | undefined;
  implementationBatchHints(
    context: ImplementationBatchContext,
    acceptedPlan?: AcceptedTaskPlanContext
  ): string[];
  resolveInitialResources(state: State): Promise<AgentSessionResult>;
  loadWireLedger?(sessionId: string): Promise<PromptLedgerWireRecord[]>;
}

export interface RunLifecycleResult<State extends RunLifecycleState> {
  state: State;
  lastResult: AgentSessionResult;
}

export class RunLifecyclePipeline<State extends RunLifecycleState> {
  constructor(private readonly ports: RunLifecyclePipelinePorts<State>) {}

  async initialize(input: RunLifecycleInput): Promise<RunLifecycleResult<State>> {
    const sessionId = input.sessionId;
    const events = input.existingEvents ?? [];
    if (hasLegacySessionTurnAuthority(events) && !latestSessionTurnAuthority(events)) {
      throw this.ports.createError(
        'session_language_policy_unavailable',
        'This Session uses turn authority v1 and is read-only because ConversationLanguagePolicy v1 is unavailable.'
      );
    }
    const userMessage = input.appendUserMessage === false
      ? undefined
      : this.ports.userMessageEvent({
          sessionId,
          content: input.content,
          attachments: input.attachments ?? [],
        });
    let lastResult = await this.ports.append(sessionId, userMessage ? [userMessage] : []);

    const kernelAttachments = this.ports.kernelRunAttachments(input);
    const runReply = await this.ports.kernel({
      command: {
        kind: 'runCreate',
        requestId: this.ports.createId('run-create'),
        sessionId,
        input: {
          text: input.content,
          attachments: kernelAttachments,
        },
        workspaceBinding: input.workspaceBinding,
        profileRef: input.profileId ? { id: input.profileId, kind: 'llm' } : undefined,
        runOverrides: undefined,
      },
    });
    lastResult = await this.ports.appendProjectedKernelEvents(sessionId, runReply);
    const reconciledInput = reconcileKernelWorkspaceBinding(
      input,
      runReply.snapshot,
      this.ports.createError
    );

    const runId = firstString(runReply.events, 'runId') ?? this.ports.createId('run');
    const startEvents: AgentEvent[] = [];
    if (userMessage) {
      const previousAuthority = latestSessionTurnAuthority(events);
      const pendingInteraction = pendingInteractionKind(events);
      if (pendingInteraction && !previousAuthority) {
        throw this.ports.createError(
          'session_turn_authority_unavailable',
          'The pending interaction belongs to an incompatible in-progress session without a persisted turn authority binding.'
        );
      }
      const relation = pendingInteraction ? 'interactionContinuation' : 'newTask';
      const taskId = relation === 'interactionContinuation'
        ? previousAuthority!.taskId
        : this.ports.createId('session-task');
      const turnId = this.ports.createId('session-turn');
      if (
        previousAuthority
        && resolveConversationLanguagePolicy(events, previousAuthority).status === 'pending'
      ) {
        startEvents.push(createSessionLanguageDecisionEvent({
          sessionId: previousAuthority.sessionId,
          runId: previousAuthority.runId,
          turnId: previousAuthority.turnId,
          revision: previousAuthority.languagePolicy.revision,
          status: 'superseded',
          decisionSource: 'supersededByLaterUserInput',
          eventId: this.ports.createId('session-language-superseded'),
          timestamp: this.ports.now(),
        }));
      }
      startEvents.push(createSessionTurnAuthorityEvent({
        sessionId,
        runId,
        turnId,
        taskId,
        messages: [{ messageId: userMessage.id, content: input.content }],
        relation,
        boundAtHookRef: pendingInteraction ? `interaction.${pendingInteraction}.input` : 'run.initialized',
        languageRevision: nextConversationLanguageRevision(events),
        hostLanguage: normalizeHostLanguage(input.hostLanguage),
        previousTaskId: relation === 'newTask' ? previousAuthority?.taskId : undefined,
        eventId: this.ports.createId('session-turn-authority'),
        timestamp: this.ports.now(),
      }));
    }
    startEvents.push(this.ports.sessionRunStateEvent({
      sessionId,
      runId,
      phase: 'context_reading',
      status: 'running',
      reason: 'session',
      decisionOwner: {
        kind: 'session',
        runId,
      },
      ts: this.ports.now(),
      id: this.ports.createId('session-run-context-reading'),
    }));
    lastResult = await this.ports.append(sessionId, startEvents);
    return this.hydrate({
      input: reconciledInput,
      lastResult,
      events,
      runId,
      stateContract: findStateContract(runReply.events),
      driverRequest: findDriverRequest(runReply.events),
      restoreResourcePackets: Boolean(input.resumeResourcePackets),
      resolveInitialResources: !input.resumeResourcePackets,
    });
  }

  async resume(input: RunLifecycleInput): Promise<RunLifecycleResult<State>> {
    const lastResult = await this.ports.append(input.sessionId, []);
    const events = input.existingEvents?.length ? input.existingEvents : lastResult.events;
    const runId = input.acceptedTaskPlan?.runId
      ?? latestEventRunId(events, input.sessionId)
      ?? this.ports.createId('run-resume');
    let reconciledInput = input;
    if (input.workspaceBinding) {
      const snapshotReply = await this.ports.kernel({
        command: {
          kind: 'snapshotGet',
          requestId: this.ports.createId('workspace-binding-snapshot'),
          sessionId: input.sessionId,
        },
      });
      if (!snapshotReply.ok) {
        throw this.ports.createError(
          snapshotReply.error?.code ?? 'kernel_workspace_binding_unavailable',
          snapshotReply.error?.message ?? 'Kernel workspace binding snapshot is unavailable.'
        );
      }
      reconciledInput = reconcileKernelWorkspaceBinding(
        input,
        snapshotReply.snapshot,
        this.ports.createError
      );
    }
    const recovered = recoverKernelContext(events, runId, input.sessionId);
    return this.hydrate({
      input: reconciledInput,
      lastResult,
      events,
      runId,
      stateContract: recovered.stateContract,
      driverRequest: recovered.driverRequest,
      restoreResourcePackets: true,
      resolveInitialResources: false,
    });
  }

  private async hydrate(options: {
    input: RunLifecycleInput;
    lastResult: AgentSessionResult;
    events: AgentEvent[];
    runId: string;
    stateContract?: KernelStateContractRef;
    driverRequest?: DriverRequestRef;
    restoreResourcePackets: boolean;
    resolveInitialResources: boolean;
  }): Promise<RunLifecycleResult<State>> {
    const { input, events, runId } = options;
    const sessionId = input.sessionId;
    let lastResult = options.lastResult;
    const authorityEvents = mergeEvents(events, lastResult.events ?? []);
    let userAuthorityFrame: UserAuthorityFrame;
    try {
      userAuthorityFrame = buildUserAuthorityFrame(authorityEvents, {
        messageId: this.ports.createId('user-authority-fallback'),
        content: input.content,
      }, input.autonomyMode ?? 'strict', { runId });
    } catch (error) {
      if (error instanceof UserAuthorityFrameError) {
        throw this.ports.createError(error.code, error.message);
      }
      throw error;
    }
    const wireLedgerRecords = this.ports.loadWireLedger
      ? await this.ports.loadWireLedger(sessionId)
      : [];
    let promptLedger: PromptLedgerState;
    try {
      promptLedger = wireLedgerRecords.length
        ? restorePromptLedger(wireLedgerRecords)
        : emptyPromptLedgerState();
    } catch (error) {
      if (error instanceof PromptLedgerCompatibilityError) {
        throw this.ports.createError(error.code, error.message);
      }
      throw error;
    }
    const providerRequestCacheHistory = restoreProviderRequestCacheHistory(wireLedgerRecords);
    const manifestBuild = this.ports.buildManifest(input, this.ports.createId('resource-manifest'));
    const taskPlanReplanReason = input.acceptedTaskPlan
      ? recoverArtifactBudgetReplanReason(authorityEvents, runId, input.acceptedTaskPlan.planId)
      : undefined;
    const acceptedTaskPlan = taskPlanReplanReason ? undefined : input.acceptedTaskPlan;
    const implementationBatch = this.ports.buildImplementationBatch(events);
    if (acceptedTaskPlan) {
      implementationBatch.batchIndex = acceptedTaskPlan.batchIndex;
    }
    const restoredResourcePackets = options.restoreResourcePackets
      ? this.ports.recentResourcePackets(events)
      : [];
    const taskLocalCompactRecords = collectTaskLocalCompactRecords(events, {
      limit: 8,
      planId: acceptedTaskPlan?.planId,
    });
    const initialTaskRuntime = this.ports.initialTaskRuntime({
      acceptedPlan: acceptedTaskPlan,
      resourcePackets: restoredResourcePackets,
      lastSavepointId: this.ports.lastSavepointId(events),
    });
    const state = {
      sessionId,
      runId,
      userRequest: latestExplicitUserContent(userAuthorityFrame),
      userAuthorityFrame,
      promptLedger,
      artifactDraftLease: ArtifactDraftLease.restore({
        events: authorityEvents,
        runId,
        sessionId,
        acceptedPlan: acceptedTaskPlan,
        maxTotalUtf8Bytes: draftPolicyBytes(options.stateContract),
        createId: (prefix) => this.ports.createId(prefix),
      }),
      artifactChunkRepairAttempts: {},
      semanticDirectiveRepairAttempts: {},
      pendingSemanticToolCalls: {},
      pendingProviderCommitEvents: [],
      providerCommitDeferred: false,
      phase: 'context_reading',
      workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
      workspaceBinding: input.workspaceBinding,
      stateContract: options.stateContract,
      driverRequest: options.driverRequest,
      manifest: manifestBuild.manifest,
      conversationRoots: manifestBuild.conversationRoots,
      initialContext: {
        id: this.ports.createId('initial-context'),
        workspaceScopeKey: manifestBuild.manifest.workspaceScopeKey,
        manifest: manifestBuild.manifest,
      },
      resourcePackets: [...restoredResourcePackets],
      resourceEvidenceRevision: restoredResourcePackets.length,
      generatedArtifactEvidence: this.ports.generatedArtifactEvidenceFromPackets(restoredResourcePackets),
      resourceRequestProgressByTask: new Map<string, SessionDriverTaskResourceProgress>(),
      memoryDocument: this.ports.buildMemoryDocument(authorityEvents, {
        projectMemoryMode: input.projectMemoryMode,
      }),
      memoryHints: this.ports.implementationBatchHints(implementationBatch, acceptedTaskPlan),
      taskLocalCompactRecords,
      taskExecutionCursor: initialTaskRuntime.taskExecutionCursor,
      currentTaskContext: initialTaskRuntime.currentTaskContext,
      taskLedger: initialTaskRuntime.taskLedger,
      acceptedPlanPromptFrame: initialTaskRuntime.acceptedPlanPromptFrame,
      implementationBatch,
      acceptedTaskPlan,
      resourceRequestRepairAttempted: false,
      actionBundleAdmissionRepairAttempted: false,
      planReviewRepairAttempted: false,
      terminalGuidanceRevisionAttempted: false,
      nativeToolReadLedger: new Map<string, unknown>(),
      nativeToolDuplicateRepairAttempted: false,
      nativeToolResumeMessages: undefined,
      nativeToolResumeRound: 0,
      semanticDirectiveRepairAttempted: false,
      semanticDirectiveErrorSummary: undefined,
      taskPlanReplanReason,
      providerRequestCacheHistory,
      interactionOverlay: input.interactionOverlay,
    } as unknown as State;

    if (state.manifest.entries.length > 0 && options.resolveInitialResources) {
      lastResult = await this.ports.resolveInitialResources(state);
    }

    return { state, lastResult };
  }
}

function pendingInteractionKind(events: readonly AgentEvent[]): 'permission' | 'review' | 'plan' | 'requirement' | undefined {
  const pendingPermission = new PermissionPipeline().findPendingPermissionContext([...events]);
  if (pendingPermission) return 'permission';
  return findActiveInteraction({ events })?.kind;
}

function draftPolicyBytes(stateContract: KernelStateContractRef | undefined): number | undefined {
  const value = stateContract?.draftAdmissionPolicy?.maxTotalUtf8Bytes;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function findStateContract(events: unknown[] | undefined): KernelStateContractRef | undefined {
  return recoverKernelContext(events ?? []).stateContract;
}

function findDriverRequest(events: unknown[] | undefined): DriverRequestRef | undefined {
  return recoverKernelContext(events ?? []).driverRequest;
}

function firstString(events: unknown[] | undefined, key: string): string | undefined {
  for (const event of events ?? []) {
    const record = objectRecord(event);
    const value = record?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function reconcileKernelWorkspaceBinding(
  input: RunLifecycleInput,
  snapshot: unknown,
  createError: (code: string, message: string) => Error
): RunLifecycleInput {
  const canonical = kernelWorkspaceBinding(snapshot);
  if (!canonical) return input;

  const requestedPath = comparableWorkspacePath(input.workspaceBinding?.openPath);
  const canonicalPath = comparableWorkspacePath(canonical.openPath);
  if (requestedPath && canonicalPath && requestedPath !== canonicalPath) {
    throw createError(
      'kernel_workspace_binding_mismatch',
      'Kernel canonical workspace path does not match the Session run workspace path.'
    );
  }

  return {
    ...input,
    workspaceBinding: canonical,
  };
}

function kernelWorkspaceBinding(snapshot: unknown): AgentWorkspaceBinding | undefined {
  const binding = objectRecord(objectRecord(snapshot)?.workspaceBinding);
  if (!binding) return undefined;
  const canonical: AgentWorkspaceBinding = {
    workspaceId: stringValue(binding.workspaceId),
    workspaceHash: stringValue(binding.workspaceHash),
    openPath: stringValue(binding.openPath),
    activeFolderId: stringValue(binding.activeFolderId),
    folderHash: stringValue(binding.folderHash),
  };
  return Object.values(canonical).some(Boolean) ? canonical : undefined;
}

function comparableWorkspacePath(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return normalized || undefined;
}

export function recoverArtifactBudgetReplanReason(
  events: readonly AgentEvent[],
  runId: string,
  acceptedPlanId: string
): AcceptedTaskReplanReason | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'workflow_stage') continue;
    const payload = objectRecord(event.payload);
    if (stringValue(payload?.stage) !== 'accepted_plan.replan_required') continue;
    if (stringValue(payload?.code) !== 'artifact_draft_budget_exceeded') continue;
    if (stringValue(payload?.runId) !== runId) continue;
    if (stringValue(payload?.previousPlanId) !== acceptedPlanId) continue;
    const message = stringValue(payload?.message);
    if (!message) continue;
    return {
      code: 'artifact_draft_budget_exceeded',
      message,
      previousPlanId: acceptedPlanId,
      previousTaskId: stringValue(payload?.previousTaskId),
    };
  }
  return undefined;
}

function mergeEvents(primary: readonly AgentEvent[], secondary: readonly AgentEvent[]): AgentEvent[] {
  const merged: AgentEvent[] = [];
  const seen = new Set<string>();
  for (const event of [...primary, ...secondary]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}
