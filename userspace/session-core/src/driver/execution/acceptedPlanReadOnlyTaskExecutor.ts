import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  LlmChatRequest,
} from '@deepcode/protocol';
import {
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
import type { DriverProviderTurnFrame } from '../runFrame.js';
import { acceptedPlanContinuationInput } from '../runContinuation.js';
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
}

export interface AcceptedPlanReadOnlyResourceResumeInput<State extends AcceptedPlanReadOnlyTaskState> {
  state: State;
  prompt: PromptEnvelope;
  userRequest: string;
  requestProposal: ProposalEnvelope;
  packet: ResourcePacket;
  callProposalOnly(input: {
    state: State;
    prompt: PromptEnvelope;
    contract: DriverProviderTurnFrame;
    stage: string;
    messages: LlmChatRequest['messages'];
  }): Promise<string | ProposalEnvelope>;
  runRepair(stage: string, messages: LlmChatRequest['messages']): Promise<string>;
}

export interface AcceptedPlanReadOnlyTaskExecutorPorts<
  Input extends AcceptedPlanReadOnlyTaskInput,
  State extends AcceptedPlanReadOnlyTaskState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult | undefined>;
  continueSameLoop(input: AcceptedPlanReadOnlyTaskResumeInput): Promise<AgentSessionResult>;
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
  reviewHandoff(input: {
    sessionId: string;
    runId: string;
    planId: string;
    plan: PlanContext;
    result: AgentSessionResult;
    currentKernelEvents: unknown[];
    requestIdPrefix: string;
  }): Promise<AgentSessionResult>;
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
  resourceResume(input: AcceptedPlanReadOnlyResourceResumeInput<State>): Promise<ProposalEnvelope>;
  callProviderProposalOnly(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    contract: DriverProviderTurnFrame,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string | ProposalEnvelope>;
  runRepair(
    input: Input,
    state: State,
    stage: string,
    messages: LlmChatRequest['messages']
  ): Promise<string>;
  submitActionProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult>;
  submitNonExecutableProposal(
    state: State,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult>;
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
  ): Promise<AgentSessionResult | null> {
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
    const contextCompactRecord = buildTaskLocalCompactRecord({
      contextAssembly: state.contextAssembly,
      source: 'resourceValidation',
      status: 'completedByReadOnlyEvidence',
      planId: accepted.planId,
      runId: state.runId,
      taskId: completion.taskId,
    });
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
      return this.ports.continueSameLoop(acceptedPlanContinuationInput(input, {
        content: this.ports.executionRequest(
          {
            sessionId: state.sessionId,
            runId: state.runId,
            planId: accepted.planId,
            userPlan: accepted.summary ?? accepted.title ?? 'Accepted implementation plan',
            actionBundle: {
              version: '1',
              id: `${accepted.planId}:read-only-validation`,
              goal: 'Read-only validation evidence satisfied the current accepted task.',
              actions: [],
              validationExpectations: [],
              reviewExpectations: [],
            },
            codeBlocks: [],
            commandBlocks: [],
            expectedValidation: '',
            reviewGuide: '',
            implementationPlan: accepted.rawPlan,
          },
          nextAccepted
        ),
        attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
        existingEvents: result.events,
        reviewContinuationMode: input.reviewContinuationMode,
        acceptedImplementationPlan: nextAccepted,
      }));
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

    return this.ports.reviewHandoff({
      sessionId: state.sessionId,
      runId: state.runId,
      planId: accepted.planId,
      plan,
      result,
      currentKernelEvents: [resourceFact],
      requestIdPrefix: 'accepted-plan-review-facts-get',
    });
  }

  async tryCompleteActionBundle(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null> {
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

    const resumed = await this.callResourceResume(input, state, prompt, proposal, packet);
    if (resumed.kind === 'actionBundle' || resumed.kind === 'taskOutcome') {
      return this.ports.submitActionProposal(input, state, prompt, resumed, result);
    }
    if (resumed.kind !== 'resourceRequest') {
      return this.ports.submitNonExecutableProposal(state, resumed, result);
    }
    return result;
  }

  async callResourceResume(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    requestProposal: ProposalEnvelope,
    packet: ResourcePacket
  ): Promise<ProposalEnvelope> {
    return this.ports.resourceResume({
      state,
      prompt,
      userRequest: input.content,
      requestProposal,
      packet,
      callProposalOnly: ({ state: runState, prompt: runPrompt, contract, stage, messages }) =>
        this.ports.callProviderProposalOnly(input, runState, runPrompt, contract, stage, messages),
      runRepair: (stage, messages) =>
        this.ports.runRepair(input, state, stage, messages),
    });
  }
}
