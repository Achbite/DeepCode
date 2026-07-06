import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { GeneratedArtifactEvidenceState } from '../context/generatedArtifactEvidenceIndex.js';
import type { ResourceRequestResolution } from '../../resources/ResourceRequestResolver.js';

export interface AcceptedPlanScopeResourceFollowupState extends GeneratedArtifactEvidenceState {
  sessionId: string;
  runId: string;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  resourcePackets: ResourcePacket[];
}

export interface AcceptedPlanScopeResourceFollowupGeneratedEvidence<
  State extends AcceptedPlanScopeResourceFollowupState
> {
  packetForRequest(
    state: State,
    request: ResourceRequestDraft,
    packetId: string
  ): { packet?: ResourcePacket; remaining: ResourceRequestDraft };
}

export interface AcceptedPlanScopeResourceFollowupResolver {
  resolve(
    manifest: ResourceManifest,
    request: ResourceRequestDraft,
    roots: ConversationResourceRoot[]
  ): ResourceRequestResolution;
}

export interface AcceptedPlanScopeResourceFollowupLoop {
  resolutionDiagnostic(resolution: ResourceRequestResolution): { fallback: string };
}

export interface AcceptedPlanScopeResourceFollowupOrchestrator<
  State extends AcceptedPlanScopeResourceFollowupState
> {
  recordAndAppend(
    state: State,
    packet: ResourcePacket,
    eventIdPrefix: string
  ): Promise<{ result?: AgentSessionResult }>;
  resolveRecordAndAppend(
    state: State,
    manifest: ResourceManifest,
    eventIdPrefix: string
  ): Promise<{ result?: AgentSessionResult }>;
}

export interface AcceptedPlanScopeResourceFollowupInput<
  State extends AcceptedPlanScopeResourceFollowupState,
  AcceptedPlan
> {
  generatedEvidence: AcceptedPlanScopeResourceFollowupGeneratedEvidence<State>;
  resolver: AcceptedPlanScopeResourceFollowupResolver;
  resourceLoop: AcceptedPlanScopeResourceFollowupLoop;
  orchestrator: AcceptedPlanScopeResourceFollowupOrchestrator<State>;
  createId(prefix: string): string;
  appendFailure(input: {
    state: State;
    detail: string;
    eventId: string;
  }): Promise<AgentSessionResult | undefined>;
  followupRequest(input: {
    state: State;
    acceptedPlan: AcceptedPlan;
    proposal: ProposalEnvelope;
    guidance: string;
  }): string;
}

export type AcceptedPlanScopeResourceFollowupResult =
  | { kind: 'resume'; result: AgentSessionResult; content: string }
  | { kind: 'failed'; result: AgentSessionResult };

export interface AcceptedPlanScopeResourceFollowupRunInput<
  State extends AcceptedPlanScopeResourceFollowupState,
  AcceptedPlan
> {
  state: State;
  acceptedPlan: AcceptedPlan;
  proposal: ProposalEnvelope;
  request: ResourceRequestDraft;
  result: AgentSessionResult;
}

const ACCEPTED_PLAN_SCOPE_RESOURCE_FOLLOWUP_GUIDANCE = [
  'Session has resolved the read-only search/read evidence required for the current edit.',
  'Use the ResourcePacket evidence to continue the same accepted taskPlan cursor.',
  'If evidence is sufficient and the current task remains in scope, output the next actionBundle.',
  'If evidence is still missing, output a focused resourceRequest.',
  'If scope must expand, output decisionRequest instead of guessing.',
  'Write user-visible proposal fields in the current user request language; keep protocol keys, toolIds, paths, and evidence refs unchanged.',
].join('\n');

export class AcceptedPlanScopeResourceFollowupCoordinator<
  State extends AcceptedPlanScopeResourceFollowupState = AcceptedPlanScopeResourceFollowupState,
  AcceptedPlan = unknown
> {
  constructor(private readonly input: AcceptedPlanScopeResourceFollowupInput<State, AcceptedPlan>) {}

  async handle(
    runInput: AcceptedPlanScopeResourceFollowupRunInput<State, AcceptedPlan>
  ): Promise<AcceptedPlanScopeResourceFollowupResult> {
    let result = runInput.result;
    const generated = this.input.generatedEvidence.packetForRequest(
      runInput.state,
      runInput.request,
      this.input.createId('accepted-plan-repair-generated-resource')
    );
    if (generated.packet) {
      result = (await this.input.orchestrator.recordAndAppend(
        runInput.state,
        generated.packet,
        'accepted-plan-repair-generated-resource-context'
      )).result ?? result;
    }

    const subset = this.input.resolver.resolve(
      runInput.state.manifest,
      generated.remaining,
      runInput.state.conversationRoots
    );
    if (!subset.manifest.entries.length) {
      if (!generated.packet) {
        const diagnostic = this.input.resourceLoop.resolutionDiagnostic(subset);
        const failed = await this.input.appendFailure({
          state: runInput.state,
          detail: diagnostic.fallback,
          eventId: this.input.createId('accepted-plan-scope-repair-resource-invalid'),
        });
        return { kind: 'failed', result: failed ?? result };
      }
    } else {
      result = (await this.input.orchestrator.resolveRecordAndAppend(
        runInput.state,
        subset.manifest,
        'accepted-plan-repair-resource-context'
      )).result ?? result;
    }

    return {
      kind: 'resume',
      result,
      content: this.input.followupRequest({
        state: runInput.state,
        acceptedPlan: runInput.acceptedPlan,
        proposal: runInput.proposal,
        guidance: ACCEPTED_PLAN_SCOPE_RESOURCE_FOLLOWUP_GUIDANCE,
      }),
    };
  }
}
