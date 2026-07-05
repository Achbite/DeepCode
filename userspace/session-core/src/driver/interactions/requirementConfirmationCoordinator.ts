import type { AgentContextAttachment, AgentEvent } from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  ContextAssemblyInput,
  ContextAssemblyRecord,
  ContextAssemblyResult,
  PromptCachePlan,
  ProjectMemoryMode,
  SessionMemoryDocument,
  UserGuidanceEvent,
} from '../../context/index.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourcePacket,
} from '../../context/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ProviderTurnContract } from '../runFrame.js';

export interface RequirementConfirmationInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  projectMemoryMode?: ProjectMemoryMode;
  interventionLevel?: ContextAssemblyInput['interventionLevel'];
}

export interface RequirementConfirmationState {
  sessionId: string;
  runId: string;
  memoryDocument: SessionMemoryDocument;
  memoryHints: string[];
  initialContext?: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  conversationRoots: ConversationResourceRoot[];
  generatedArtifactEvidence: { size: number };
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  providerTurnContract?: ProviderTurnContract;
}

export interface RequirementConfirmationCoordinatorPorts<
  Input extends RequirementConfirmationInput,
  State extends RequirementConfirmationState,
> {
  now(): string;
  createId(prefix: string): string;
  assembleContext(input: ContextAssemblyInput): ContextAssemblyResult;
  capabilityCatalogSummary(state: State): string;
  collectUserGuidanceEvents(events: AgentEvent[], runId: string): UserGuidanceEvent[];
  buildProviderTurnContract(input: {
    contractId: string;
    sessionId: string;
    runId: string;
    turnMode: 'requirementDecision';
    allowedKinds: string[];
    requiredKind: 'decisionRequest';
    prompt: PromptEnvelope;
    contextAssembly?: ContextAssemblyRecord;
    userRequest: string;
    resourcePackets: ResourcePacket[];
    generatedArtifactCount: number;
    repairPolicy: 'deterministicIntervention';
    nextActionInstruction: string;
  }): ProviderTurnContract;
  callProviderAndParse(input: Input, state: State, prompt: PromptEnvelope): Promise<ProposalEnvelope>;
  createError(code: string, message: string): Error;
  requirementRecordFromProposal(input: {
    proposal: ProposalEnvelope;
    sessionId: string;
    runId: string;
    userRequest: string;
    timestamp: string;
  }): RequirementRecord;
  confirmationEvent(input: {
    sessionId: string;
    runId: string;
    requirement: RequirementRecord;
    proposal: ProposalEnvelope;
    originalUserRequest: string;
    attachments: AgentContextAttachment[];
    executionRootPayload?: Record<string, unknown>;
    ts: string;
    id: string;
  }): AgentEvent;
  executionRootPayload(state: State): Record<string, unknown> | undefined;
}

export class RequirementConfirmationCoordinator<
  Input extends RequirementConfirmationInput,
  State extends RequirementConfirmationState,
> {
  constructor(private readonly ports: RequirementConfirmationCoordinatorPorts<Input, State>) {}

  async build(input: Input, state: State): Promise<AgentEvent> {
    const assembledContext = this.ports.assembleContext({
      contextAssemblyId: this.ports.createId('context-assembly'),
      workflowState: 'needDecisionRequest',
      allowedProposals: ['decisionRequest'],
      capabilityCatalogSummary: this.ports.capabilityCatalogSummary(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: state.memoryHints,
      interventionLevel: input.interventionLevel,
      userGuidance: this.ports.collectUserGuidanceEvents(input.existingEvents ?? [], state.runId),
      userOverlay: [
        'Before proposing side-effect work, request user intervention only if a concrete decision is needed.',
        'Return kind="decisionRequest" only.',
        'Provide 2-3 clear options with one recommended option and impact descriptions.',
        'Do not output actionBundle yet.',
      ].join('\n'),
      userRequest: input.content,
      initialContext: state.initialContext,
      resourcePackets: state.resourcePackets,
      conversationRoots: state.conversationRoots,
      auditOnly: {
        runId: state.runId,
        sessionId: state.sessionId,
      },
    });
    state.cachePlan = assembledContext.cachePlan;
    state.contextAssembly = assembledContext.contextAssembly;
    const prompt = assembledContext.prompt;
    state.providerTurnContract = this.ports.buildProviderTurnContract({
      contractId: this.ports.createId('provider-turn-contract-requirement'),
      sessionId: state.sessionId,
      runId: state.runId,
      turnMode: 'requirementDecision',
      allowedKinds: ['decisionRequest'],
      requiredKind: 'decisionRequest',
      prompt,
      contextAssembly: state.contextAssembly,
      userRequest: input.content,
      resourcePackets: state.resourcePackets,
      generatedArtifactCount: state.generatedArtifactEvidence.size,
      repairPolicy: 'deterministicIntervention',
      nextActionInstruction: 'Return exactly one decisionRequest proposal for the concrete user decision needed before planning side-effect work.',
    });
    const proposal = await this.ports.callProviderAndParse(input, state, prompt);
    if (proposal.kind !== 'decisionRequest') {
      throw this.ports.createError(
        'decision_request_expected',
        `Expected decisionRequest before side-effect planning, got ${proposal.kind}.`
      );
    }
    const requirement = this.ports.requirementRecordFromProposal({
      proposal,
      sessionId: state.sessionId,
      runId: state.runId,
      userRequest: input.content,
      timestamp: this.ports.now(),
    });
    return this.ports.confirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      executionRootPayload: this.ports.executionRootPayload(state),
      ts: this.ports.now(),
      id: this.ports.createId('requirement-confirmation'),
    });
  }
}
