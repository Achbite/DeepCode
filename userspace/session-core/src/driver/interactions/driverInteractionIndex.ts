import type { AgentEvent } from '@deepcode/protocol';
import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanExecutionRoot,
} from '../execution/index.js';
import type { AcceptedPlanExecutionRootDecisionInput } from '../../accepted-plan/AcceptedPlanExecutionRootResolver.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';
import type { PlanContext } from '../proposal/planContextIndex.js';

export type DriverInteractionIndexRef =
  | { kind: 'review'; runId: string }
  | { kind: 'plan'; runId: string; planId: string }
  | { kind: 'requirement'; runId: string; requirementId: string };

export interface DriverInteractionIndexDecisionInput extends AcceptedPlanExecutionRootDecisionInput {
  interventionLevel?: 'low' | 'medium' | 'high';
}

export interface DriverInteractionRecoveredAcceptedPlanContext {
  plan: PlanContext;
  acceptedPlan: AcceptedImplementationPlanContext;
}

export interface DriverInteractionIndexPorts {
  latestActiveReviewInteraction(events: AgentEvent[]): DriverInteractionIndexRef | null;
  latestActivePlanInteraction(events: AgentEvent[]): DriverInteractionIndexRef | null;
  latestActiveRequirementInteraction(events: AgentEvent[]): DriverInteractionIndexRef | null;
  findPlanCard(events: AgentEvent[], runId: string | undefined, planId: string): PlanContext | null | undefined;
  executionRootFromDecision(
    input: DriverInteractionIndexDecisionInput,
    events: AgentEvent[]
  ): AcceptedImplementationPlanExecutionRoot | undefined;
  buildAcceptedPlan(input: {
    plan: PlanContext;
    interventionLevel?: 'low' | 'medium' | 'high';
    executionRoot?: AcceptedImplementationPlanExecutionRoot;
  }): AcceptedImplementationPlanContext;
  recoverLatestCheckpoint(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    events: AgentEvent[];
  }): { nextAcceptedPlan: AcceptedImplementationPlanContext };
  recordTaskCompletion(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    completedTaskIds: string[];
  }): { nextAcceptedPlan: AcceptedImplementationPlanContext };
}

export class DriverInteractionIndex {
  constructor(private readonly ports: DriverInteractionIndexPorts) {}

  active(events: AgentEvent[]): DriverInteractionIndexRef | null {
    return this.ports.latestActiveReviewInteraction(events)
      ?? this.ports.latestActivePlanInteraction(events)
      ?? this.ports.latestActiveRequirementInteraction(events);
  }

  recoverAcceptedPlanFromOverlay(
    input: DriverInteractionIndexDecisionInput,
    events: AgentEvent[],
    overlay: InteractionOverlayContext | undefined
  ): DriverInteractionRecoveredAcceptedPlanContext | undefined {
    const planId = overlay?.acceptedPlanId;
    if (!planId) return undefined;
    const plan = (overlay.acceptedPlanRunId ? this.ports.findPlanCard(events, overlay.acceptedPlanRunId, planId) : undefined)
      ?? this.ports.findPlanCard(events, undefined, planId);
    if (!plan?.implementationPlan) return undefined;
    const executionRoot = plan.executionRoot ?? this.ports.executionRootFromDecision(input, events);
    let acceptedPlan = this.ports.recoverLatestCheckpoint({
      acceptedPlan: this.ports.buildAcceptedPlan({ plan, interventionLevel: input.interventionLevel, executionRoot }),
      events,
    }).nextAcceptedPlan;
    const overlayCompletedTaskIds = overlay.acceptedCompletedTaskIds ?? [];
    if (overlayCompletedTaskIds.length) {
      acceptedPlan = this.ports.recordTaskCompletion({
        acceptedPlan,
        completedTaskIds: [
          ...new Set([...acceptedPlan.completedTaskIds, ...overlayCompletedTaskIds]),
        ],
      }).nextAcceptedPlan;
    }
    return { plan, acceptedPlan };
  }
}
