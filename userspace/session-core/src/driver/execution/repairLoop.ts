export interface PlanRevisionRequestPlanRef {
  userPlan?: string;
  planReviewReport?: unknown;
}

export interface PlanRevisionRequestInput {
  plan: PlanRevisionRequestPlanRef;
  guidance?: string;
}

export class RepairLoop {
  planRevisionRequest(input: PlanRevisionRequestInput): string {
    const report = input.plan.planReviewReport ? clipJson(input.plan.planReviewReport, 4_000) : '';
    return [
      'The user revised the pending plan card. Generate a new reviewable taskPlan from the same user goal and the revision guidance.',
      'This is plan revision, not plan acceptance. Do not execute work, do not output actionBundle, and do not claim any files were changed.',
      input.guidance?.trim() ? `User plan revision guidance:\n${input.guidance.trim()}` : 'User plan revision guidance: revise the pending plan before execution.',
      input.plan.userPlan ? `Previous plan card content:\n${clip(input.plan.userPlan, 6_000)}` : '',
      report ? `Previous Kernel ProposalReview report, clipped:\n${report}` : '',
      [
        'Next proposal requirements:',
        '- Prefer kind="taskPlan" with a complete non-executable plan that waits for user confirmation.',
        '- If more read-only evidence is required before planning, return resourceRequest.',
        '- If a material user choice is still required, return decisionRequest.',
        '- Do not return actionBundle until the revised plan is explicitly accepted.',
        '- Keep targets and toolIds concrete enough for Kernel ProposalReview, but do not include contentBlocks or executable tool actions in taskPlan.',
      ].join('\n'),
    ].filter(Boolean).join('\n\n');
  }
}

function clipJson(value: unknown, maxChars: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return clip(text ?? '', maxChars);
}

function clip(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}
