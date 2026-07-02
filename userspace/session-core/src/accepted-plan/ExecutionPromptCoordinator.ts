import type {
  ProposalEnvelope,
  ReviewExpectationDraft,
  ValidationExpectationDraft,
} from '../agent-plan/types.js';
import type { AcceptedImplementationPlanContext } from './types.js';

export interface DefaultActionBundleUserPlanMarkdownInput {
  goal?: string;
  actions: Record<string, unknown>[];
  existingUserPlan?: string;
  outputLanguage?: string;
}

export interface ExecutionPromptCoordinatorPorts<TPlan> {
  sideEffectCapabilities: ReadonlySet<string>;
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  isDetailedUserPlanMarkdown(userPlan: string | undefined): boolean;
  defaultActionBundleUserPlanMarkdown(input: DefaultActionBundleUserPlanMarkdownInput): string;
  expectationsHaveDescription(value: unknown): boolean;
  defaultValidationExpectation(actions: Record<string, unknown>[]): ValidationExpectationDraft;
  defaultReviewExpectation(actions: Record<string, unknown>[]): ReviewExpectationDraft;
  implementationPlanExecutionRequestText(
    plan: TPlan,
    acceptedPlan: AcceptedImplementationPlanContext,
    guidance?: string
  ): string;
}

export class ExecutionPromptCoordinator<TPlan> {
  constructor(private readonly ports: ExecutionPromptCoordinatorPorts<TPlan>) {}

  ensureReviewableExpectations(proposal: ProposalEnvelope): void {
    if (proposal.kind !== 'actionBundle') return;
    const payload = this.ports.objectRecord(proposal.payload);
    const bundle = this.ports.objectRecord(payload?.actionBundle);
    if (!payload || !bundle) return;
    const actions = Array.isArray(bundle.actions)
      ? bundle.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const sideEffectful = actions.some((action) => this.ports.sideEffectCapabilities.has(this.ports.actionEffectiveCapability(action)));
    if (!sideEffectful) return;
    if (!Array.isArray(payload.codeBlocks)) {
      payload.codeBlocks = [];
    }
    const existingUserPlan = this.ports.stringValue(payload.userPlan) ?? this.ports.stringValue(payload.userPlanMarkdown);
    if (!this.ports.isDetailedUserPlanMarkdown(existingUserPlan)) {
      const generatedUserPlan = this.ports.defaultActionBundleUserPlanMarkdown({
        goal: this.ports.stringValue(bundle.goal),
        actions,
        existingUserPlan,
        outputLanguage: this.ports.stringValue(payload.outputLanguage),
      });
      payload.userPlan = generatedUserPlan;
      payload.userPlanMarkdown = generatedUserPlan;
    }
    if (!this.ports.expectationsHaveDescription(bundle.validationExpectations)) {
      bundle.validationExpectations = [this.ports.defaultValidationExpectation(actions)];
    }
    if (!this.ports.expectationsHaveDescription(bundle.reviewExpectations)) {
      bundle.reviewExpectations = [this.ports.defaultReviewExpectation(actions)];
    }
  }

  executionRequest(
    plan: TPlan,
    acceptedPlan: AcceptedImplementationPlanContext,
    guidance?: string
  ): string {
    return this.ports.implementationPlanExecutionRequestText(plan, acceptedPlan, guidance);
  }
}
