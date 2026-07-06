import type { AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type {
  ConversationResourceRoot,
  ResourceManifest,
  ResourcePacket,
} from '../../context/types.js';
import type { GeneratedArtifactEvidenceState } from './generatedArtifactEvidenceIndex.js';
import type { ResourceRequestResolution } from '../../resources/ResourceRequestResolver.js';

export interface ActionBundleAdmissionResourceFollowupState extends GeneratedArtifactEvidenceState {
  sessionId: string;
  runId: string;
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
  resourcePackets: ResourcePacket[];
}

export interface ActionBundleAdmissionResourceFollowupGeneratedEvidence<
  State extends ActionBundleAdmissionResourceFollowupState
> {
  packetForRequest(
    state: State,
    request: ResourceRequestDraft,
    packetId: string
  ): { packet?: ResourcePacket; remaining: ResourceRequestDraft };
}

export interface ActionBundleAdmissionResourceFollowupResolver {
  resolve(
    manifest: ResourceManifest,
    request: ResourceRequestDraft,
    roots: ConversationResourceRoot[]
  ): ResourceRequestResolution;
}

export interface ActionBundleAdmissionResourceFollowupLoop {
  resolutionDiagnostic(resolution: ResourceRequestResolution): { fallback: string };
}

export interface ActionBundleAdmissionResourceFollowupOrchestrator<
  State extends ActionBundleAdmissionResourceFollowupState
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

export interface ActionBundleAdmissionResourceFollowupInput<
  State extends ActionBundleAdmissionResourceFollowupState
> {
  generatedEvidence: ActionBundleAdmissionResourceFollowupGeneratedEvidence<State>;
  resolver: ActionBundleAdmissionResourceFollowupResolver;
  resourceLoop: ActionBundleAdmissionResourceFollowupLoop;
  orchestrator: ActionBundleAdmissionResourceFollowupOrchestrator<State>;
  createId(prefix: string): string;
  appendFailure(input: {
    state: State;
    proposal: ProposalEnvelope;
    reasons: string[];
    eventId: string;
  }): Promise<AgentSessionResult | undefined>;
  followupRequest(input: { runId: string; reasons: string[] }): string;
}

export type ActionBundleAdmissionResourceFollowupResult =
  | { kind: 'resume'; result: AgentSessionResult; content: string }
  | { kind: 'failed'; result: AgentSessionResult };

export interface ActionBundleAdmissionResourceFollowupRunInput<
  State extends ActionBundleAdmissionResourceFollowupState
> {
  state: State;
  proposal: ProposalEnvelope;
  request: ResourceRequestDraft;
  reasons: string[];
  result: AgentSessionResult;
}

export class ActionBundleAdmissionResourceFollowupCoordinator<
  State extends ActionBundleAdmissionResourceFollowupState = ActionBundleAdmissionResourceFollowupState
> {
  constructor(private readonly input: ActionBundleAdmissionResourceFollowupInput<State>) {}

  async handle(
    runInput: ActionBundleAdmissionResourceFollowupRunInput<State>
  ): Promise<ActionBundleAdmissionResourceFollowupResult> {
    let result = runInput.result;
    const generated = this.input.generatedEvidence.packetForRequest(
      runInput.state,
      runInput.request,
      this.input.createId('action-bundle-admission-generated-resource')
    );
    if (generated.packet) {
      result = (await this.input.orchestrator.recordAndAppend(
        runInput.state,
        generated.packet,
        'action-bundle-admission-generated-resource-context'
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
          proposal: runInput.proposal,
          reasons: [`actionBundle admission repair returned resourceRequest that cannot be resolved: ${diagnostic.fallback}`],
          eventId: this.input.createId('action-bundle-admission-resource-invalid'),
        });
        return { kind: 'failed', result: failed ?? result };
      }
    } else {
      result = (await this.input.orchestrator.resolveRecordAndAppend(
        runInput.state,
        subset.manifest,
        'action-bundle-admission-resource-context'
      )).result ?? result;
    }

    return {
      kind: 'resume',
      result,
      content: this.input.followupRequest({ runId: runInput.state.runId, reasons: runInput.reasons }),
    };
  }
}
