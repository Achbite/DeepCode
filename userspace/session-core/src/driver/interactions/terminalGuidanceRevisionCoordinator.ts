import type {
  AgentEvent,
  AgentSessionResult,
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
import { ProviderProfileRegistry } from '../../provider/ProviderProfileRegistry.js';
import type { ContextFrameBuilder } from '../context/index.js';
import { prepareProviderSideCallMessagesContextAdmission } from '../context/index.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import {
  SessionDriverRepairRuntimeAccessor,
  type SessionDriverProviderRuntimeState,
} from '../runFrame.js';
import {
  takeProviderCommitEvents,
  type ProviderCommitBufferState,
} from '../pipelines/providerCommitBuffer.js';

const providerProfiles = new ProviderProfileRegistry();

export interface TerminalGuidanceRevisionInput {
  content: string;
  profileId?: string;
  projectMemoryMode?: ProjectMemoryMode;
  interventionLevel?: ContextAssemblyInput['interventionLevel'];
  confirmedRequirement?: RequirementRecord;
}

export interface TerminalGuidanceRevisionState extends SessionDriverProviderRuntimeState, ProviderCommitBufferState {
  sessionId: string;
  runId: string;
  phase: string;
  userRequest: string;
  terminalGuidanceRevisionAttempted: boolean;
  memoryDocument: SessionMemoryDocument;
  initialContext?: InitialContextPacket;
  resourcePackets: ResourcePacket[];
  conversationRoots: ConversationResourceRoot[];
  cachePlan?: PromptCachePlan;
  contextAssembly?: ContextAssemblyRecord;
  semanticDirectiveErrorSummary?: string;
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
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'completed';
    status: 'completed';
    reason: 'session';
    decisionOwner: {
      kind: 'session';
      runId: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
  assembleContext(input: ContextAssemblyInput): ContextAssemblyResult;
  toolCatalogSummary(state: State): string;
  implementationBatchHints(state: State): string[];
  appendConsumedGuidanceEvents(input: {
    sessionId: string;
    result: AgentSessionResult;
    contextAssembly?: ContextAssemblyRecord;
    runId: string;
    userRequest: string;
    appliedAtProviderStage: string;
  }): Promise<AgentSessionResult>;
  runRevision(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    contract: DriverProviderTurnFrame
  ): Promise<ProposalEnvelope | { kind: 'providerResume' }>;
  createError(code: string, message: string): Error;
  contextFrameBuilder: ContextFrameBuilder;
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
    const repairRuntime = new SessionDriverRepairRuntimeAccessor(state);
    if (repairRuntime.attempted('terminalGuidanceRevisionAttempted')) return null;
    repairRuntime.markAttempted('terminalGuidanceRevisionAttempted');

    let result = await this.ports.append(state.sessionId, []);
    const guidance = this.ports.collectQueued(result.events, state.runId);
    if (guidance.length === 0) return null;

    result = await this.ports.append(state.sessionId, [
      ...takeProviderCommitEvents(state),
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
      toolCatalogSummary: this.ports.toolCatalogSummary(state),
      memoryDocument: state.memoryDocument,
      projectMemoryMode: input.projectMemoryMode,
      extraMemoryHints: this.ports.implementationBatchHints(state),
      interventionLevel: input.interventionLevel,
      providerProfileSystemContract: providerProfiles.profile('review-v1').systemContract,
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
    result = await this.ports.appendConsumedGuidanceEvents({
      sessionId: state.sessionId,
      result,
      contextAssembly: assembledContext.contextAssembly,
      runId: state.runId,
      userRequest: input.content,
      appliedAtProviderStage: 'guidance_revision',
    });

    let revised: ProposalEnvelope;
    try {
      let admission = prepareProviderSideCallMessagesContextAdmission({
        state,
        prompt: assembledContext.prompt,
        contextFrameBuilder: this.ports.contextFrameBuilder,
        contractId: this.ports.createId('guidance-revision-contract'),
        turnMode: 'reviewAnswer',
        allowedKinds: ['answer'],
        requiredKind: 'answer',
        messages: [
          { role: 'system', content: assembledContext.prompt.stablePrefix },
          { role: 'user', content: assembledContext.prompt.dynamicSuffix },
        ],
        userRequest: input.content,
        contextAssembly: assembledContext.contextAssembly,
        resourcePackets: state.resourcePackets,
        repairPolicy: 'sameKindOnly',
        projectionVisibility: 'traceOnly',
        nextActionInstruction: 'Call session.submit_answer exactly once with the revised final answer that applies the queued user guidance. Do not call planning or execution tools.',
      });
      let revision = await this.ports.runRevision(input, state, admission.prompt, admission.contract);
      if (revision.kind === 'providerResume') {
        admission = prepareProviderSideCallMessagesContextAdmission({
          state,
          prompt: assembledContext.prompt,
          contextFrameBuilder: this.ports.contextFrameBuilder,
          contractId: this.ports.createId('guidance-revision-repair-contract'),
          turnMode: 'reviewAnswer',
          allowedKinds: ['answer'],
          requiredKind: 'answer',
          messages: [
            { role: 'system', content: assembledContext.prompt.stablePrefix },
            { role: 'user', content: assembledContext.prompt.dynamicSuffix },
          ],
          userRequest: input.content,
          errorSummary: state.semanticDirectiveErrorSummary,
          contextAssembly: assembledContext.contextAssembly,
          resourcePackets: state.resourcePackets,
          repairPolicy: 'sameKindOnly',
          projectionVisibility: 'traceOnly',
          nextActionInstruction: 'Repair the invalid arguments by calling session.submit_answer exactly once. Keep the answer scope and queued user guidance unchanged.',
        });
        revision = await this.ports.runRevision(input, state, admission.prompt, admission.contract);
      }
      if (revision.kind === 'providerResume') {
        throw this.ports.createError(
          'guidance_revision_semantic_repair_failed',
          'Guidance revision did not produce a valid Session semantic answer after one same-profile repair.'
        );
      }
      revised = revision;
      if (revised.kind !== 'answer') {
        throw this.ports.createError(
          'guidance_revision_non_answer',
          `Guidance revision expected answer, got ${revised.kind}.`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.phase = 'completed';
      return this.ports.append(state.sessionId, [
        ...takeProviderCommitEvents(state),
        this.ports.diagnosticEvent(
          state.sessionId,
          `User guidance merge failed; Session fell back to the first answer: ${message}`,
          this.ports.now(),
          this.ports.createId('guidance-revision-failed')
        ),
        this.ports.answerEvent(state.sessionId, draftAnswer, this.ports.now(), this.ports.createId('answer'), {
          guidanceRevisionFailed: true,
          appliedGuidanceIds: guidance.map((item) => item.id),
          replacesDraftProposalId: draftAnswer.proposalId,
        }),
        this.completedRunStateEvent(state),
      ]);
    }

    const narration = this.ports.answerNarrationEvent(
      state.sessionId,
      revised,
      this.ports.now(),
      this.ports.createId('guidance-revision-narration')
    );
    state.phase = 'completed';
    return this.ports.append(state.sessionId, [
      ...takeProviderCommitEvents(state),
      ...(narration ? [narration] : []),
      this.ports.answerEvent(state.sessionId, revised, this.ports.now(), this.ports.createId('answer'), {
        guidanceRevision: true,
        appliedGuidanceIds: guidance.map((item) => item.id),
        replacesDraftProposalId: draftAnswer.proposalId,
      }),
      this.completedRunStateEvent(state),
    ]);
  }

  private completedRunStateEvent(state: State): AgentEvent {
    return this.ports.sessionRunStateEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      phase: 'completed',
      status: 'completed',
      reason: 'session',
      decisionOwner: {
        kind: 'session',
        runId: state.runId,
      },
      ts: this.ports.now(),
      id: this.ports.createId('session-run-completed-guidance-revision'),
    });
  }
}
