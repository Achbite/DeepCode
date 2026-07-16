import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type {
  InteractionOverlayContext,
  SessionTurnPhase,
} from '../pipelines/interactionOverlayCodec.js';

export interface ProviderDecisionRequestInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
}

export interface ProviderDecisionRequestState {
  sessionId: string;
  runId: string;
  phase: SessionTurnPhase;
  interactionOverlay?: InteractionOverlayContext;
  acceptedTaskPlan?: {
    planId?: string;
    runId?: string;
    completedTaskIds?: string[];
  };
  currentTaskContext?: {
    taskId?: string;
  };
}

export interface ProviderDecisionRequestHandlerPorts<
  Input extends ProviderDecisionRequestInput,
  State extends ProviderDecisionRequestState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
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
    interactionOverlayPayload: Record<string, unknown>;
    ts: string;
    id: string;
  }): AgentEvent;
  interactionOverlayPayload(overlay: InteractionOverlayContext): Record<string, unknown>;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'waiting_requirement_confirmation';
    reason: 'requirement';
    decisionOwner: {
      kind: 'requirement';
      runId: string;
      targetId: string;
      requirementId: string;
    };
    interactionOverlay: InteractionOverlayContext;
    ts: string;
    id: string;
  }): AgentEvent;
}

export class ProviderDecisionRequestHandler<
  Input extends ProviderDecisionRequestInput,
  State extends ProviderDecisionRequestState,
> {
  constructor(private readonly ports: ProviderDecisionRequestHandlerPorts<Input, State>) {}

  async handle(input: Input, state: State, proposal: ProposalEnvelope): Promise<AgentSessionResult> {
    const requirement = this.ports.requirementRecordFromProposal({
      proposal,
      sessionId: state.sessionId,
      runId: state.runId,
      userRequest: input.content,
      timestamp: this.ports.now(),
    });
    const interactionOverlay: InteractionOverlayContext = {
      parentRunId: state.interactionOverlay?.parentRunId ?? state.runId,
      parentPhase: state.phase,
      interactionRunId: state.runId,
      interactionId: requirement.requirementId,
      sourceInteractionId: requirement.requirementId,
      acceptedPlanId: state.acceptedTaskPlan?.planId,
      acceptedPlanRunId: state.acceptedTaskPlan?.runId,
      acceptedCurrentTaskId: state.currentTaskContext?.taskId,
      acceptedCompletedTaskIds: state.acceptedTaskPlan?.completedTaskIds,
    };
    const confirmation = this.ports.confirmationEvent({
      sessionId: state.sessionId,
      runId: state.runId,
      requirement,
      proposal,
      originalUserRequest: input.content,
      attachments: input.attachments ?? [],
      interactionOverlayPayload: this.ports.interactionOverlayPayload(interactionOverlay),
      ts: this.ports.now(),
      id: this.ports.createId('decision-request'),
    });
    state.phase = 'waiting_requirement_confirmation';
    return this.ports.append(state.sessionId, [
      confirmation,
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_requirement_confirmation',
        reason: 'requirement',
        decisionOwner: {
          kind: 'requirement',
          runId: state.runId,
          targetId: requirement.requirementId,
          requirementId: requirement.requirementId,
        },
        interactionOverlay,
        ts: this.ports.now(),
        id: this.ports.createId('session-run-waiting-requirement'),
      }),
    ]);
  }
}
