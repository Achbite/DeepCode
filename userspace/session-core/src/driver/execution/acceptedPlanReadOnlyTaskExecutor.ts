import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import {
  appendTaskLocalCompactRecord,
  buildTaskLocalCompactRecord,
  type ContextAssemblyRecord,
  type ContextAssemblyTaskLocalCompactRecord,
  type ProjectMemoryMode,
} from '../../context/index.js';
import type {
  ConversationResourceRoot,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { AcceptedImplementationPlanContext } from '../../accepted-plan/types.js';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ProposalRouterResult } from '../proposal/proposalRouter.js';
import type { PlanContext } from '../proposal/planContextIndex.js';
import type { AcceptedPlanReadOnlyResourceCompletion } from './acceptedPlanExecutor.js';

export interface AcceptedPlanReadOnlyTaskInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: 'auto' | 'ask' | 'off';
  interventionLevel?: 'low' | 'medium' | 'high';
  projectMemoryMode?: ProjectMemoryMode;
}

export interface AcceptedPlanReadOnlyTaskResumeInput extends AcceptedPlanReadOnlyTaskInput {
  existingEvents?: AgentEvent[];
  appendUserMessage: false;
  requirementConfirmationMode: 'off';
  resumeResourcePackets?: boolean;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
}

export interface AcceptedPlanReadOnlyTaskState {
  sessionId: string;
  runId: string;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  taskExecutionCursor?: unknown;
  currentTaskContext?: unknown;
  contextAssembly?: ContextAssemblyRecord;
  taskLocalCompactRecords?: ContextAssemblyTaskLocalCompactRecord[];
}

export interface AcceptedPlanReadOnlyTaskExecutorPorts<
  Input extends AcceptedPlanReadOnlyTaskInput,
  State extends AcceptedPlanReadOnlyTaskState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult | undefined>;
  readActionBundle(proposal: ProposalEnvelope): unknown | undefined;
  refreshRuntimeState(state: State): void;
  readOnlyResourceCompletion(
    accepted: AcceptedImplementationPlanContext,
    cursor: unknown,
    current: unknown,
    packet: ResourcePacket
  ): ({ ok: true } & AcceptedPlanReadOnlyResourceCompletion) | { ok: false };
  recordTaskCompletion(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    completedTaskIds: string[];
  }): {
    completedTaskIds: string[];
    nextAcceptedPlan: AcceptedImplementationPlanContext;
  };
  complete(accepted: AcceptedImplementationPlanContext): boolean;
  resourceValidationCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    packet: ResourcePacket,
    completion: AcceptedPlanReadOnlyResourceCompletion,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord
  ): AgentEvent;
  executionRequest(plan: Record<string, unknown>, acceptedPlan: AcceptedImplementationPlanContext): string;
  readOnlyReviewContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan: AcceptedImplementationPlanContext;
    packet: ResourcePacket;
    completion: AcceptedPlanReadOnlyResourceCompletion;
  }): PlanContext;
  currentTaskIsReadOnlyResourceValidation(
    accepted: AcceptedImplementationPlanContext,
    cursor: unknown,
    current: unknown
  ): boolean;
  resourceRequestFromReadOnlyActionBundle(
    actionBundle: unknown,
    current: unknown,
    requestId: string
  ): ResourceRequestDraft | undefined;
  resolveResourceRequest(
    manifest: ResourceManifest,
    request: ResourceRequestDraft,
    roots: ConversationResourceRoot[]
  ): { manifest: ResourceManifest };
  resolveAndRecord(state: State, manifest: ResourceManifest): Promise<ResourcePacket>;
  packetEvent(state: State, packet: ResourcePacket, stage: string): AgentEvent;
  resourceResumeEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    cursor: unknown,
    current: unknown,
    packet: ResourcePacket,
    ts: string,
    id: string
  ): AgentEvent;
}

export class AcceptedPlanReadOnlyTaskExecutor<
  Input extends AcceptedPlanReadOnlyTaskInput,
  State extends AcceptedPlanReadOnlyTaskState,
> {
  constructor(private readonly ports: AcceptedPlanReadOnlyTaskExecutorPorts<Input, State>) {}

  async tryCompleteResourceTask(
    input: Input,
    state: State,
    packet: ResourcePacket,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult | null> {
    const accepted = state.acceptedImplementationPlan;
    if (!accepted) return null;
    this.ports.refreshRuntimeState(state);
    const completion = this.ports.readOnlyResourceCompletion(
      accepted,
      state.taskExecutionCursor,
      state.currentTaskContext,
      packet
    );
    if (!completion.ok) return null;

    const ledgerEffect = this.ports.recordTaskCompletion({
      acceptedPlan: accepted,
      completedTaskIds: completion.completedTaskIds,
    });
    const nextAccepted = ledgerEffect.nextAcceptedPlan;
    state.acceptedImplementationPlan = nextAccepted;
    this.ports.refreshRuntimeState(state);
    const contextCompactRecord = buildTaskLocalCompactRecord({
      contextAssembly: state.contextAssembly,
      source: 'resourceValidation',
      status: 'completedByReadOnlyEvidence',
      planId: accepted.planId,
      runId: state.runId,
      taskId: completion.taskId,
    });
    state.taskLocalCompactRecords = appendTaskLocalCompactRecord(
      state.taskLocalCompactRecords,
      contextCompactRecord
    );
    const checkpoint = this.ports.resourceValidationCheckpointEvent(
      state.sessionId,
      state.runId,
      accepted,
      packet,
      completion,
      this.ports.now(),
      this.ports.createId('accepted-plan-resource-validation-checkpoint'),
      contextCompactRecord
    );
    let result = await this.ports.append(state.sessionId, [checkpoint]) ?? fallback;

    if (!this.ports.complete(nextAccepted)) {
      return { kind: 'continue', lastResult: result };
    }

    const plan = this.ports.readOnlyReviewContext({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: nextAccepted,
      packet,
      completion,
    });
    const resourceFact = {
      kind: 'tool.completed',
      toolName: 'kernel.resourceResolve',
      status: 'ok',
      summary: `Kernel resolved ${packet.items.length} resource item(s) for accepted-plan read-only validation.`,
      output: packet,
    };

    return {
      kind: 'assembleReview',
      request: {
        sessionId: state.sessionId,
        runId: state.runId,
        planId: accepted.planId,
        plan,
        result,
        currentKernelEvents: [resourceFact],
        requestIdPrefix: 'accepted-plan-review-facts-get',
      },
    };
  }

  async tryCompleteActionBundle(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult | null> {
    const accepted = state.acceptedImplementationPlan;
    const actionBundle = this.ports.readActionBundle(proposal);
    if (!accepted || !actionBundle) return null;
    this.ports.refreshRuntimeState(state);
    if (!this.ports.currentTaskIsReadOnlyResourceValidation(
      accepted,
      state.taskExecutionCursor,
      state.currentTaskContext
    )) {
      return null;
    }

    const request = this.ports.resourceRequestFromReadOnlyActionBundle(
      actionBundle,
      state.currentTaskContext,
      this.ports.createId('accepted-plan-readonly-action-resource-request')
    );
    if (!request) return null;
    const subset = this.ports.resolveResourceRequest(state.manifest, request, state.conversationRoots);
    if (!subset.manifest.entries.length) return null;

    const packet = await this.ports.resolveAndRecord(state, subset.manifest);
    let result = await this.ports.append(state.sessionId, [
      this.ports.packetEvent(state, packet, 'accepted-plan-readonly-action-resource-context'),
      this.ports.resourceResumeEvent(
        state.sessionId,
        state.runId,
        accepted,
        state.taskExecutionCursor,
        state.currentTaskContext,
        packet,
        this.ports.now(),
        this.ports.createId('accepted-plan-readonly-action-resource-resume')
      ),
    ]) ?? fallback;

    const readOnlyCompletion = await this.tryCompleteResourceTask(input, state, packet, result);
    if (readOnlyCompletion) return readOnlyCompletion;

    return { kind: 'continue', lastResult: result };
  }
}
