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

export interface PlanRevisionRequestPlanRef {
  userPlan?: string;
  planReviewReport?: unknown;
}

export interface PlanRevisionRequestInput {
  plan: PlanRevisionRequestPlanRef;
  guidance?: string;
}

export interface ActionBundleAdmissionResourceFollowupRequestInput {
  runId: string;
  reasons: string[];
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

  planRevisionRequest(input: PlanRevisionRequestInput): string {
    const report = input.plan.planReviewReport ? clipJson(input.plan.planReviewReport, 4_000) : '';
    return [
      'The user revised the pending plan card. Generate a new reviewable taskPlan from the same user goal and the revision guidance.',
      'This is plan revision, not plan acceptance. Do not execute work, do not output actionBundle, and do not claim any files were changed.',
      input.guidance?.trim() ? `User plan revision guidance:\n${input.guidance.trim()}` : 'User plan revision guidance: revise the pending plan before execution.',
      input.plan.userPlan ? `Previous plan card content:\n${clip(input.plan.userPlan, 6_000)}` : '',
      report ? `Previous Kernel PlanReview report, clipped:\n${report}` : '',
      [
        'Next proposal requirements:',
        '- Prefer kind="taskPlan" with a complete non-executable plan that waits for user confirmation.',
        '- If more read-only evidence is required before planning, return resourceRequest.',
        '- If a material user choice is still required, return decisionRequest.',
        '- Do not return actionBundle until the revised plan is explicitly accepted.',
        '- Keep targets and capabilities concrete enough for Kernel PlanReview, but do not include codeBlocks or executable tool actions in taskPlan.',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
  }

  actionBundleAdmissionResourceFollowupRequest(input: ActionBundleAdmissionResourceFollowupRequestInput): string {
    return [
      'Session has resolved the read-only resource evidence required for actionBundle admission.',
      'Continue the same user request by producing a confirmable plan, but satisfy the concrete target constraints for deletion.',
      'fs.delete must use toolId="fs.delete" and args.path with concrete file targets or explicit directory targets. Workspace targets must be relative paths; user-confirmed outside targets may be absolute paths.',
      'Directory deletion must use args.targetKind="directory" and args.recursive=true so Kernel PlanReview can display it and request user confirmation. Do not output wildcards, workspace root targets, empty targets, or ambiguous cleanup targets.',
      'If ResourcePacket shows a target is a directory and the user intent really is to delete that directory, keep that directory path and set args.targetKind="directory" and args.recursive=true.',
      'If the directory scope is uncertain, or if concrete file scope still cannot be confirmed, return decisionRequest instead of an unexecutable actionBundle.',
      'Write user-visible proposal fields in the current user request language; keep protocol keys, toolIds, args keys, paths, and evidence refs unchanged.',
      input.reasons.length ? `Previous admission rejection reasons:\n${input.reasons.map((reason) => `- ${reason}`).join('\n')}` : '',
      `Current runId: ${input.runId}`,
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

function clipJson(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return clip(text ?? '', maxChars);
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
