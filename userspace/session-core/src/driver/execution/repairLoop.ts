import type { AgentEvent } from '@deepcode/protocol';

export interface AcceptedPlanScopeRevisionPlanRef {
  planId: string;
  implementationPlan?: unknown;
}

export interface AcceptedPlanScopeRevisionRequestInput {
  confirmation: AgentEvent;
  plan: AcceptedPlanScopeRevisionPlanRef | null;
  guidance?: string;
}

export class RepairLoop {
  acceptedPlanScopeRevisionRequest(input: AcceptedPlanScopeRevisionRequestInput): string {
    const decisionRequest = objectRecord(objectRecord(input.confirmation.payload)?.decisionRequest) ?? {};
    const implementationPlan = objectRecord(input.plan?.implementationPlan);
    const planSummary = input.plan
      ? {
          planId: input.plan.planId,
          title: stringValue(implementationPlan?.title),
          summary: stringValue(implementationPlan?.summary),
        }
      : undefined;
    return [
      'User requested an accepted-plan scope revision.',
      'Return a decisionRequest if a new user choice is required, or return a new actionBundle if the requested revision is already precise enough.',
      'Do not output legacy implementationPlan, fileOperations, accessScopes, capability, resourceScope, commandBlocks, or large/multiline codeBlocks.content.',
      'Only expand targets or toolIds when the user guidance or Kernel review reason requires it. Kernel will review the resulting execution contract and the user must confirm it before execution continues.',
      input.guidance?.trim() ? `User guidance:\n${input.guidance.trim()}` : '',
      planSummary ? `Current accepted execution summary:\n${JSON.stringify(planSummary, null, 2)}` : '',
      Object.keys(decisionRequest).length ? `Accepted-plan scope decision:\n${JSON.stringify(decisionRequest, null, 2)}` : '',
    ].filter(Boolean).join('\n\n');
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
