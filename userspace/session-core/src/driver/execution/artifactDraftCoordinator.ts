import type {
  AgentSessionResult,
  KernelArtifactDraftLedgerFrame,
  KernelCommandEnvelope,
  KernelReply,
} from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type {
  SessionSemanticDirective,
  SessionSemanticToolState,
} from '../../provider/SessionSemanticToolAdapter.js';
import { ArtifactDraftError, ArtifactDraftLease } from './artifactDraftLedger.js';
import type { TaskArtifactDirective } from './operationIntentCompiler.js';
import {
  conversationPresentationLanguage,
  type ConversationPresentationLanguage,
} from '../projection/conversationPresentationLanguage.js';

export interface ArtifactDraftCoordinatorState extends SessionSemanticToolState {
  artifactDraftLease?: ArtifactDraftLease;
  resourcePackets: ResourcePacket[];
}

export type ArtifactDraftCoordinatorResult =
  | { kind: 'proposal'; proposal: ProposalEnvelope; toolResult: Record<string, unknown> }
  | { kind: 'providerResume'; toolResult: Record<string, unknown> };

export interface ArtifactDraftCoordinatorPorts<State extends ArtifactDraftCoordinatorState> {
  createId(prefix: string): string;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): Promise<AgentSessionResult>;
  compileArtifacts(input: {
    state: State;
    callId: string;
    directive: TaskArtifactDirective;
  }): ProposalEnvelope;
  createError(code: string, message: string): Error;
}

export class ArtifactDraftCoordinator<State extends ArtifactDraftCoordinatorState> {
  constructor(private readonly ports: ArtifactDraftCoordinatorPorts<State>) {}

  async handle(input: {
    state: State;
    callId: string;
    directive: Exclude<SessionSemanticDirective, { kind: 'taskOutcome' }>;
  }): Promise<ArtifactDraftCoordinatorResult> {
    if (input.directive.kind === 'proposal') {
      if (input.directive.proposal.kind === 'diagnostic') {
        await this.discard(input.state, 'Provider returned a terminal diagnostic for the current artifact task.');
      }
      return {
        kind: 'proposal',
        proposal: input.directive.proposal,
        toolResult: {
          status: 'accepted',
          proposalKind: input.directive.proposal.kind,
          proposalId: input.directive.proposal.proposalId,
        },
      };
    }
    if (input.directive.kind === 'artifactChunk') {
      const lease = this.ensureLease(input.state);
      const frame = lease.prepareAppendFrame({
        slotId: input.directive.slotId,
        contentLines: input.directive.contentLines,
        finalChunk: input.directive.finalChunk,
        editMatch: input.directive.editMatch,
        resourcePackets: input.state.resourcePackets,
        createId: (prefix) => this.ports.createId(prefix),
      });
      await this.submitFrame(input.state, frame);
      lease.commitAcceptedFrame(frame);
      return {
        kind: 'providerResume',
        toolResult: {
          status: 'accepted',
          slotId: input.directive.slotId,
          slotComplete: input.directive.finalChunk,
          remainingSlotIds: lease.snapshot().slots.filter((slot) => !slot.completed).map((slot) => slot.slotId),
        },
      };
    }
    const lease = input.state.artifactDraftLease;
    if (!lease) {
      throw new ArtifactDraftError(
        'artifact_draft_incomplete',
        'No active artifact draft exists for session.finalize_task_artifacts.'
      );
    }
    const artifactDirective = lease.directive(
      input.directive.summary,
      input.directive.narration
    );
    const proposal = this.ports.compileArtifacts({
      state: input.state,
      callId: input.callId,
      directive: artifactDirective,
    });
    const frame = lease.prepareFinalizeFrame(
      input.directive.summary,
      (prefix) => this.ports.createId(prefix)
    );
    await this.submitFrame(input.state, frame);
    lease.commitAcceptedFrame(frame);
    input.state.artifactDraftLease = undefined;
    return {
      kind: 'proposal',
      proposal,
      toolResult: {
        status: 'finalized',
      },
    };
  }

  async discard(state: State, reason: string): Promise<void> {
    const lease = state.artifactDraftLease;
    if (!lease) return;
    const frame = lease.prepareDiscardFrame(reason, (prefix) => this.ports.createId(prefix));
    if (!frame) {
      state.artifactDraftLease = undefined;
      return;
    }
    await this.submitFrame(state, frame);
    lease.commitAcceptedFrame(frame);
    state.artifactDraftLease = undefined;
  }

  private ensureLease(state: State): ArtifactDraftLease {
    state.artifactDraftLease ??= ArtifactDraftLease.create({
      runId: state.runId,
      sessionId: state.sessionId,
      acceptedPlan: state.acceptedTaskPlan,
      maxTotalUtf8Bytes: draftPolicyBytes(state),
      createId: (prefix) => this.ports.createId(prefix),
    });
    return state.artifactDraftLease;
  }

  private async submitFrame(state: State, frame: KernelArtifactDraftLedgerFrame): Promise<void> {
    const reply = await this.ports.kernel({
      requestId: this.ports.createId('draft-ledger-submit'),
      command: {
        kind: 'draftLedgerSubmit',
        requestId: this.ports.createId('draft-ledger'),
        runId: state.runId,
        sessionId: state.sessionId,
        frame,
      },
    });
    if (!reply.ok) {
      throw this.ports.createError(
        reply.error?.code ?? 'artifact_chunk_invalid',
        reply.error?.message ?? 'Kernel rejected the artifact draft frame.'
      );
    }
    await this.ports.appendProjectedKernelEvents(
      state.sessionId,
      reply,
      conversationPresentationLanguage(state)
    );
  }
}

function draftPolicyBytes(state: ArtifactDraftCoordinatorState): number {
  const value = state.stateContract?.draftAdmissionPolicy?.maxTotalUtf8Bytes
    ?? state.driverRequest?.stateContract?.draftAdmissionPolicy?.maxTotalUtf8Bytes;
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ArtifactDraftError(
      'artifact_draft_incomplete',
      'Kernel DraftAdmissionPolicy is unavailable for accepted-task artifact execution.'
    );
  }
  return Number(value);
}
