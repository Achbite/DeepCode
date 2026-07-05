import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { CurrentTaskContext, TaskExecutionCursor } from '../../accepted-plan/index.js';
import type {
  ContextAssemblyInput,
  ContextAssemblyRecord,
  ContextAssemblyResult,
  ProjectMemoryMode,
  SessionMemoryDocument,
} from '../../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourcePacket,
} from '../../context/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ProviderTurnContract } from '../runFrame.js';

export interface ProviderTurnContextState {
  sessionId: string;
  runId: string;
  userRequest: string;
  stateContract?: {
    stateId?: string;
    allowedProposals?: string[];
  };
  driverRequest?: {
    kind?: string;
  };
  memoryDocument?: SessionMemoryDocument;
  initialContext?: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  conversationRoots: ConversationResourceRoot[];
  currentTaskContext?: CurrentTaskContext;
  taskExecutionCursor?: TaskExecutionCursor;
  acceptedImplementationPlan?: unknown;
  implementationBatch?: unknown;
  generatedArtifactEvidence: Map<string, unknown>;
  cachePlan?: unknown;
  contextAssembly?: ContextAssemblyRecord;
  providerTurnContract?: ProviderTurnContract;
}

export interface ProviderTurnContextInput {
  contextAssemblyId: string;
  contractId: string;
  inputContent: string;
  projectMemoryMode?: ProjectMemoryMode;
  interventionLevel?: ContextAssemblyInput['interventionLevel'];
  confirmedRequirement?: RequirementRecord;
  lastResult: AgentSessionResult;
}

export interface ProviderTurnContextResult {
  prompt: PromptEnvelope;
  allowedProposals: string[];
  lastResult: AgentSessionResult;
}

export interface ProviderTurnContextCoordinatorPorts<State extends ProviderTurnContextState> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  assembleContext(input: ContextAssemblyInput): ContextAssemblyResult;
  allowedProposals(kernelAllowed: string[], state: State): string[];
  capabilityCatalogSummary(state: State): string;
  memoryHints(state: State): string[];
  collectUserGuidanceEvents(events: AgentEvent[], runId: string): ContextAssemblyInput['userGuidance'];
  consumedUserGuidanceEvents(input: {
    sessionId: string;
    events: AgentEvent[];
    consumedIds: string[];
    runId: string;
    appliedAtProviderStage: string;
    userRequest: string;
  }): AgentEvent[];
  buildProviderTurnContract(input: {
    contractId: string;
    sessionId: string;
    runId: string;
    allowedKinds: string[];
    prompt: PromptEnvelope;
    contextAssembly?: ContextAssemblyRecord;
    userRequest: string;
    acceptedPlanActive: boolean;
    currentTaskContext?: CurrentTaskContext;
    resourcePackets: ResourcePacket[];
    generatedArtifactCount: number;
  }): ProviderTurnContract;
}

export class ProviderTurnContextCoordinator<State extends ProviderTurnContextState> {
  constructor(private readonly ports: ProviderTurnContextCoordinatorPorts<State>) {}

  async prepare(state: State, input: ProviderTurnContextInput): Promise<ProviderTurnContextResult> {
    const allowedProposals = this.ports.allowedProposals(state.stateContract?.allowedProposals ?? [
      'answer',
      'resourceRequest',
      'decisionRequest',
      'taskPlan',
      'actionBundle',
      'diagnostic',
    ], state);

    const assembledContext = this.ports.assembleContext({
      contextAssemblyId: input.contextAssemblyId,
      workflowState: state.stateContract?.stateId ?? state.driverRequest?.kind ?? 'needProposal',
      allowedProposals,
      capabilityCatalogSummary: this.ports.capabilityCatalogSummary(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: this.ports.memoryHints(state),
      interventionLevel: input.interventionLevel,
      userGuidance: this.ports.collectUserGuidanceEvents(input.lastResult.events, state.runId),
      userRequest: input.inputContent,
      currentTaskGoal: state.currentTaskContext?.goal,
      currentTaskContext: state.currentTaskContext,
      taskCursor: state.taskExecutionCursor,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      requirement: input.confirmedRequirement,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });

    state.cachePlan = assembledContext.cachePlan;
    state.contextAssembly = assembledContext.contextAssembly;

    const lastResult = await this.appendConsumedUserGuidanceEvents(state, input.lastResult);
    const prompt = assembledContext.prompt;
    state.providerTurnContract = this.ports.buildProviderTurnContract({
      contractId: input.contractId,
      sessionId: state.sessionId,
      runId: state.runId,
      allowedKinds: allowedProposals,
      prompt,
      contextAssembly: state.contextAssembly,
      userRequest: input.inputContent,
      acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
      currentTaskContext: state.currentTaskContext,
      resourcePackets: state.resourcePackets,
      generatedArtifactCount: state.generatedArtifactEvidence.size,
    });

    return { prompt, allowedProposals, lastResult };
  }

  private async appendConsumedUserGuidanceEvents(
    state: State,
    result: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const consumedIds = state.contextAssembly?.consumedUserGuidanceIds ?? [];
    const events = this.ports.consumedUserGuidanceEvents({
      sessionId: state.sessionId,
      events: result.events,
      consumedIds,
      runId: state.runId,
      appliedAtProviderStage: 'provider_call',
      userRequest: state.userRequest,
    });
    return events.length > 0 ? this.ports.append(state.sessionId, events) : result;
  }
}
