import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { ResourceRequestResolution } from '../../resources/ResourceRequestResolver.js';
import type { AssistantDiagnosticInfo } from '../projection/assistantProjectionBuilder.js';
import { SessionDriverRepairRuntimeAccessor } from '../runFrame.js';
import type { ResourcePacketAppendResult } from './resourceOrchestrator.js';

export interface ResourceRequestProposalHandlerState {
  sessionId: string;
  runId: string;
  workspaceScopeKey: string;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  resourcePackets: ResourcePacket[];
  generatedArtifactEvidence: Map<string, unknown>;
  acceptedImplementationPlan?: unknown;
  taskExecutionCursor?: unknown;
  currentTaskContext?: unknown;
  resourceRequestRepairAttempted: boolean;
}

export interface GeneratedResourcePacketResult {
  packet?: ResourcePacket;
  remaining: ResourceRequestDraft;
}

export type ResourceRequestProposalHandlerResult =
  | { kind: 'return'; result: AgentSessionResult }
  | { kind: 'continue'; lastResult: AgentSessionResult };

export interface ResourceRequestProposalHandlerPorts<
  Input,
  State extends ResourceRequestProposalHandlerState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  generatedPacketForRequest(
    state: State,
    request: ResourceRequestDraft,
    packetId: string
  ): GeneratedResourcePacketResult;
  recordAndAppend(
    state: State,
    packet: ResourcePacket,
    eventIdPrefix: string
  ): Promise<ResourcePacketAppendResult>;
  resolveRecordAndAppend(
    state: State,
    manifest: ResourceManifest,
    eventIdPrefix: string
  ): Promise<ResourcePacketAppendResult>;
  resolveResourceRequest(
    manifest: ResourceManifest,
    request: ResourceRequestDraft,
    roots: ConversationResourceRoot[]
  ): ResourceRequestResolution;
  repairResourceRequest(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    resolution: ResourceRequestResolution
  ): Promise<ProposalEnvelope>;
  answerEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | AssistantDiagnosticInfo,
    ts: string,
    id: string
  ): AgentEvent;
  resourceResolutionDiagnostic(resolution: ResourceRequestResolution): AssistantDiagnosticInfo;
  resourceRepairFailedDiagnostic(message: string): AssistantDiagnosticInfo;
  refreshTaskRuntimeState(state: State): void;
  acceptedPlanResourceResumeEvent(state: State, packet: ResourcePacket, ts: string, id: string): AgentEvent;
  tryCompleteResourceTask(
    input: Input,
    state: State,
    packet: ResourcePacket,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null>;
  callResourceResume(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    packet: ResourcePacket
  ): Promise<ProposalEnvelope>;
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
  errorMessage(error: unknown): string;
}

export interface ResourceRequestProposalHandlerInput<
  Input,
  State extends ResourceRequestProposalHandlerState,
> {
  input: Input;
  state: State;
  prompt: PromptEnvelope;
  proposal: ProposalEnvelope;
  lastResult: AgentSessionResult;
}

export class ResourceRequestProposalHandler<
  Input,
  State extends ResourceRequestProposalHandlerState,
> {
  constructor(private readonly ports: ResourceRequestProposalHandlerPorts<Input, State>) {}

  async handle(
    handlerInput: ResourceRequestProposalHandlerInput<Input, State>
  ): Promise<ResourceRequestProposalHandlerResult> {
    const { input, state, prompt, proposal } = handlerInput;
    let lastResult = handlerInput.lastResult;
    const generated = this.ports.generatedPacketForRequest(
      state,
      proposal.payload as ResourceRequestDraft,
      this.ports.createId('generated-artifact-resource')
    );
    if (generated.packet) {
      lastResult = (await this.ports.recordAndAppend(
        state,
        generated.packet,
        'generated-artifact-resource-context'
      )).result;
      if (!generated.remaining.items.length) {
        return { kind: 'continue', lastResult };
      }
    }

    let subset = this.ports.resolveResourceRequest(
      state.manifest,
      generated.remaining,
      state.conversationRoots
    );
    const repairRuntime = new SessionDriverRepairRuntimeAccessor(state);
    if (!subset.manifest.entries.length && !repairRuntime.attempted('resourceRequestRepairAttempted')) {
      repairRuntime.markAttempted('resourceRequestRepairAttempted');
      try {
        const repaired = await this.ports.repairResourceRequest(input, state, prompt, proposal, subset);
        if (repaired.kind === 'answer') {
          return {
            kind: 'return',
            result: await this.ports.append(state.sessionId, [
              this.ports.answerEvent(
                state.sessionId,
                repaired,
                this.ports.now(),
                this.ports.createId('answer')
              ),
            ]),
          };
        }
        if (repaired.kind === 'resourceRequest') {
          subset = this.ports.resolveResourceRequest(
            state.manifest,
            repaired.payload as ResourceRequestDraft,
            state.conversationRoots
          );
        } else if (repaired.kind === 'actionBundle') {
          return {
            kind: 'return',
            result: await this.ports.submitActionProposal(input, state, prompt, repaired, lastResult),
          };
        } else {
          return {
            kind: 'return',
            result: await this.ports.submitNonExecutableProposal(state, repaired, lastResult),
          };
        }
      } catch (error) {
        const message = this.ports.errorMessage(error);
        return {
          kind: 'return',
          result: await this.ports.append(state.sessionId, [
            this.ports.finalDiagnosticEvent(
              state.sessionId,
              this.ports.resourceRepairFailedDiagnostic(message),
              this.ports.now(),
              this.ports.createId('resource-repair-failed')
            ),
          ]),
        };
      }
    }

    if (!subset.manifest.entries.length) {
      return {
        kind: 'return',
        result: await this.ports.append(state.sessionId, [
          this.ports.finalDiagnosticEvent(
            state.sessionId,
            this.ports.resourceResolutionDiagnostic(subset),
            this.ports.now(),
            this.ports.createId('resource-invalid')
          ),
        ]),
      };
    }

    const resourceAppend = await this.ports.resolveRecordAndAppend(
      state,
      subset.manifest,
      'resource-context'
    );
    const packet = resourceAppend.packet;
    lastResult = resourceAppend.result;
    if (state.acceptedImplementationPlan) {
      this.ports.refreshTaskRuntimeState(state);
      const resumeEvent = this.ports.acceptedPlanResourceResumeEvent(
        state,
        packet,
        this.ports.now(),
        this.ports.createId('accepted-plan-resource-resume')
      );
      lastResult = await this.ports.append(state.sessionId, [resumeEvent]) ?? lastResult;
      const readOnlyCompletion = await this.ports.tryCompleteResourceTask(
        input,
        state,
        packet,
        lastResult
      );
      if (readOnlyCompletion) {
        return { kind: 'return', result: readOnlyCompletion };
      }
      const resumed = await this.ports.callResourceResume(input, state, prompt, proposal, packet);
      if (resumed.kind === 'actionBundle') {
        return {
          kind: 'return',
          result: await this.ports.submitActionProposal(input, state, prompt, resumed, lastResult),
        };
      }
      if (resumed.kind !== 'resourceRequest') {
        return {
          kind: 'return',
          result: await this.ports.submitNonExecutableProposal(state, resumed, lastResult),
        };
      }
    }
    return { kind: 'continue', lastResult };
  }
}
