import type {
  AgentEvent,
  AgentSessionResult,
  LlmChatRequest,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
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

export interface TerminalGuidanceRevisionInput {
  content: string;
  profileId?: string;
  projectMemoryMode?: ProjectMemoryMode;
  interventionLevel?: ContextAssemblyInput['interventionLevel'];
  confirmedRequirement?: RequirementRecord;
}

export interface TerminalGuidanceRevisionState {
  sessionId: string;
  runId: string;
  terminalGuidanceRevisionAttempted: boolean;
  memoryDocument: SessionMemoryDocument;
  initialContext?: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  conversationRoots: ConversationResourceRoot[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
}

export interface TerminalGuidanceRevisionCoordinatorPorts<
  Input extends TerminalGuidanceRevisionInput,
  State extends TerminalGuidanceRevisionState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  collectQueued(events: AgentEvent[], runId: string): UserGuidanceEvent[];
  transitionEvent(input: {
    sessionId: string;
    runId: string;
    guidanceIds: string[];
    userRequest: string;
    ts: string;
    id: string;
  }): AgentEvent;
  overlay(input: {
    originalRequest: string;
    draftAnswer: ProposalEnvelope;
    guidance: UserGuidanceEvent[];
  }): string;
  answerNarrationEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent | null;
  answerEvent(
    sessionId: string,
    proposal: ProposalEnvelope,
    ts: string,
    id: string,
    metadata?: Record<string, unknown>
  ): AgentEvent;
  diagnosticEvent(sessionId: string, message: string, ts: string, id: string): AgentEvent;
  assembleContext(input: ContextAssemblyInput): ContextAssemblyResult;
  capabilityCatalogSummary(state: State): string;
  implementationBatchHints(state: State): string[];
  appendConsumedGuidanceEvents(input: {
    sessionId: string;
    result: AgentSessionResult;
    contextAssembly?: ContextAssemblyRecord;
    runId: string;
    userRequest: string;
    appliedAtProviderStage: string;
  }): Promise<AgentSessionResult>;
  runRevision(input: Input, state: State, messages: LlmChatRequest['messages']): Promise<string>;
  parseProposal(raw: string, state: State): ProposalEnvelope;
  createError(code: string, message: string): Error;
}

export class TerminalGuidanceRevisionCoordinator<
  Input extends TerminalGuidanceRevisionInput,
  State extends TerminalGuidanceRevisionState,
> {
  constructor(private readonly ports: TerminalGuidanceRevisionCoordinatorPorts<Input, State>) {}

  async revise(
    input: Input,
    state: State,
    draftAnswer: ProposalEnvelope
  ): Promise<AgentSessionResult | null> {
    if (state.terminalGuidanceRevisionAttempted) return null;
    state.terminalGuidanceRevisionAttempted = true;

    let result = await this.ports.append(state.sessionId, []);
    const guidance = this.ports.collectQueued(result.events, state.runId);
    if (guidance.length === 0) return null;

    result = await this.ports.append(state.sessionId, [
      this.ports.transitionEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        guidanceIds: guidance.map((item) => item.id),
        userRequest: input.content,
        ts: this.ports.now(),
        id: this.ports.createId('guidance-revision-transition'),
      }),
    ]);
    const assembledContext = this.ports.assembleContext({
      contextAssemblyId: this.ports.createId('context-assembly-guidance-revision'),
      workflowState: 'guidanceRevision',
      allowedProposals: ['answer'],
      capabilityCatalogSummary: this.ports.capabilityCatalogSummary(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: this.ports.implementationBatchHints(state),
      interventionLevel: input.interventionLevel,
      userOverlay: this.ports.overlay({
        originalRequest: input.content,
        draftAnswer,
        guidance,
      }),
      userGuidance: guidance,
      userRequest: input.content,
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
    result = await this.ports.appendConsumedGuidanceEvents({
      sessionId: state.sessionId,
      result,
      contextAssembly: state.contextAssembly,
      runId: state.runId,
      userRequest: input.content,
      appliedAtProviderStage: 'guidance_revision',
    });

    let revised: ProposalEnvelope;
    try {
      const raw = await this.ports.runRevision(input, state, [
        { role: 'system', content: assembledContext.prompt.stablePrefix },
        { role: 'user', content: assembledContext.prompt.dynamicSuffix },
      ]);
      revised = this.ports.parseProposal(raw, state);
      if (revised.kind !== 'answer') {
        throw this.ports.createError(
          'guidance_revision_non_answer',
          `Guidance revision expected answer, got ${revised.kind}.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.ports.append(state.sessionId, [
        this.ports.diagnosticEvent(
          state.sessionId,
          `User guidance merge failed; Session fell back to the first answer: ${message}`,
          this.ports.now(),
          this.ports.createId('guidance-revision-failed')
        ),
      ]);
      return this.ports.append(state.sessionId, [
        this.ports.answerEvent(state.sessionId, draftAnswer, this.ports.now(), this.ports.createId('answer'), {
          guidanceRevisionFailed: true,
          appliedGuidanceIds: guidance.map((item) => item.id),
          replacesDraftProposalId: draftAnswer.proposalId,
        }),
      ]);
    }

    const narration = this.ports.answerNarrationEvent(
      state.sessionId,
      revised,
      this.ports.now(),
      this.ports.createId('guidance-revision-narration')
    );
    if (narration) {
      result = await this.ports.append(state.sessionId, [narration]);
    }
    return this.ports.append(state.sessionId, [
      this.ports.answerEvent(state.sessionId, revised, this.ports.now(), this.ports.createId('answer'), {
        guidanceRevision: true,
        appliedGuidanceIds: guidance.map((item) => item.id),
        replacesDraftProposalId: draftAnswer.proposalId,
      }),
    ]);
  }
}
