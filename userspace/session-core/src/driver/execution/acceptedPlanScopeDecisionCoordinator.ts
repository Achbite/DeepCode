import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanBatchValidationResult,
} from '../../accepted-plan/types.js';
import { AcceptedPlanScopeIntervention } from '../../accepted-plan/AcceptedPlanScopeIntervention.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type { InteractionOverlayContext, SessionTurnPhase } from '../pipelines/interactionOverlayCodec.js';

export interface AcceptedPlanScopeDecisionState {
  sessionId: string;
  runId: string;
  phase: SessionTurnPhase;
}

export interface AcceptedPlanScopeDecisionRequest {
  content: string;
  attachments?: AgentContextAttachment[];
}

export interface AcceptedPlanScopeDecisionInterventionState {
  userRequest: string;
  acceptedPlan?: AcceptedImplementationPlanContext;
  currentTaskId?: string;
}

export interface AcceptedPlanScopeDecisionCoordinatorInput<
  State extends AcceptedPlanScopeDecisionState
> {
  now(): string;
  createId(prefix: string): string;
  visibleLanguageForRequest(userRequest: string): 'en-US' | 'zh-CN';
  requirementPipeline: {
    requirementRecordFromProposal(input: {
      proposal: ProposalEnvelope;
      sessionId: string;
      runId: string;
      userRequest: string;
      timestamp: string;
    }): RequirementRecord;
  };
  interactionOverlayCodec: {
    toPayload(overlay: InteractionOverlayContext): Record<string, unknown>;
  };
  requirementProjection: {
    confirmationEvent(input: {
      sessionId: string;
      runId: string;
      requirement: RequirementRecord;
      proposal: ProposalEnvelope;
      originalUserRequest: string;
      attachments: AgentContextAttachment[];
      interactionOverlayPayload?: Record<string, unknown>;
      ts: string;
      id: string;
    }): AgentEvent;
  };
  progressProjection: {
    sessionRunStateEvent(input: {
      sessionId: string;
      runId: string;
      phase: SessionTurnPhase;
      reason: 'requirement';
      decisionOwner: {
        kind: 'requirement';
        runId: string;
        targetId: string;
        requirementId: string;
      };
      interactionOverlay?: InteractionOverlayContext;
      ts: string;
      id: string;
    }): AgentEvent;
  };
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
}

export interface AcceptedPlanScopeDecisionRunInput<
  State extends AcceptedPlanScopeDecisionState
> {
  state: State;
  proposal: ProposalEnvelope;
  request: AcceptedPlanScopeDecisionRequest;
  confirmationIdPrefix?: string;
  runStateIdPrefix?: string;
}

export interface AcceptedPlanOutOfScopeDecisionRunInput<
  State extends AcceptedPlanScopeDecisionState
> {
  state: State;
  intervention: AcceptedPlanScopeDecisionInterventionState;
  proposal: ProposalEnvelope;
  validation: AcceptedPlanBatchValidationResult;
  request: AcceptedPlanScopeDecisionRequest;
}

export class AcceptedPlanScopeDecisionCoordinator<
  State extends AcceptedPlanScopeDecisionState = AcceptedPlanScopeDecisionState
> {
  constructor(private readonly input: AcceptedPlanScopeDecisionCoordinatorInput<State>) {}

  async waitForDecision(
    runInput: AcceptedPlanScopeDecisionRunInput<State>
  ): Promise<AgentSessionResult> {
    const requirement = this.input.requirementPipeline.requirementRecordFromProposal({
      proposal: runInput.proposal,
      sessionId: runInput.state.sessionId,
      runId: runInput.state.runId,
      userRequest: runInput.request.content,
      timestamp: this.input.now(),
    });
    const interactionOverlay: InteractionOverlayContext = {
      parentRunId: runInput.state.runId,
      parentPhase: 'executing_accepted_plan',
      interactionRunId: runInput.state.runId,
      interactionId: requirement.requirementId,
      sourceInteractionId: runInput.proposal.proposalId,
    };
    const confirmation = this.input.requirementProjection.confirmationEvent({
      sessionId: runInput.state.sessionId,
      runId: runInput.state.runId,
      requirement,
      proposal: runInput.proposal,
      originalUserRequest: runInput.request.content,
      attachments: runInput.request.attachments ?? [],
      interactionOverlayPayload: this.input.interactionOverlayCodec.toPayload(interactionOverlay),
      ts: this.input.now(),
      id: this.input.createId(runInput.confirmationIdPrefix ?? 'accepted-plan-scope-repair-decision'),
    });
    runInput.state.phase = 'waiting_permission';
    return this.input.append(runInput.state.sessionId, [
      confirmation,
      this.input.progressProjection.sessionRunStateEvent({
        sessionId: runInput.state.sessionId,
        runId: runInput.state.runId,
        phase: 'waiting_permission',
        reason: 'requirement',
        decisionOwner: {
          kind: 'requirement',
          runId: runInput.state.runId,
          targetId: requirement.requirementId,
          requirementId: requirement.requirementId,
        },
        interactionOverlay,
        ts: this.input.now(),
        id: this.input.createId(runInput.runStateIdPrefix ?? 'session-run-waiting-accepted-plan-repair-decision'),
      }),
    ]);
  }

  async waitForOutOfScopeDecision(
    runInput: AcceptedPlanOutOfScopeDecisionRunInput<State>
  ): Promise<AgentSessionResult> {
    const decisionProposal = new AcceptedPlanScopeIntervention({
      createId: (prefix) => this.input.createId(prefix),
      visibleLanguageForRequest: (userRequest) => this.input.visibleLanguageForRequest(userRequest),
    }).createDecisionProposal({
      runId: runInput.state.runId,
      sessionId: runInput.state.sessionId,
      userRequest: runInput.intervention.userRequest,
      acceptedPlan: runInput.intervention.acceptedPlan,
      currentTaskId: runInput.intervention.currentTaskId,
    }, runInput.proposal, runInput.validation);

    return this.waitForDecision({
      state: runInput.state,
      proposal: decisionProposal,
      request: runInput.request,
      confirmationIdPrefix: 'accepted-plan-scope-confirmation',
      runStateIdPrefix: 'session-run-waiting-accepted-plan-scope',
    });
  }
}
