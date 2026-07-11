import type {
  ProposalEnvelope,
  ReviewExpectationDraft,
  ValidationExpectationDraft,
} from '../protocol/types.js';
import type { AcceptedImplementationPlanContext } from './types.js';
import { AcceptedTaskRegistry } from './AcceptedTaskRegistry.js';
import { IntentSlotRegistry } from '../driver/execution/intentSlot.js';

export interface DefaultActionBundleUserPlanMarkdownInput {
  goal?: string;
  actions: Record<string, unknown>[];
  existingUserPlan?: string;
  outputLanguage?: string;
}

export interface ExecutionPromptCoordinatorPorts<TPlan> {
  maxActionBundleTotalCodeBytes: number;
  sideEffectCapabilities: ReadonlySet<string>;
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  planId(plan: TPlan): string;
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  isDetailedUserPlanMarkdown(userPlan: string | undefined): boolean;
  defaultActionBundleUserPlanMarkdown(input: DefaultActionBundleUserPlanMarkdownInput): string;
  expectationsHaveDescription(value: unknown): boolean;
  defaultValidationExpectation(actions: Record<string, unknown>[]): ValidationExpectationDraft;
  defaultReviewExpectation(actions: Record<string, unknown>[]): ReviewExpectationDraft;
}

export class ExecutionPromptCoordinator<TPlan> {
  private readonly intentSlots = new IntentSlotRegistry();

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
    const envelope = proposal as unknown as Record<string, unknown>;
    const existingUserPlan = this.ports.stringValue(payload.userPlan) ?? this.ports.stringValue(payload.userPlanMarkdown);
    const outputLanguage = this.ports.stringValue(payload.outputLanguage) ?? this.ports.stringValue(envelope.outputLanguage);
    if (!this.ports.isDetailedUserPlanMarkdown(existingUserPlan)) {
      const generatedUserPlan = this.ports.defaultActionBundleUserPlanMarkdown({
        goal: this.ports.stringValue(bundle.goal),
        actions,
        existingUserPlan,
        outputLanguage,
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
    const currentTask = acceptedPlan.tasks.find((task) => !acceptedPlan.completedTaskIds.includes(task.taskId));
    const registry = new AcceptedTaskRegistry(acceptedPlan);
    const taskLedger = registry.ledger();
    const promptFrame = registry.promptFrame(taskLedger);
    const providerContext = {
      sessionPlanId: this.ports.planId(plan),
      ...this.sanitizedContext(acceptedPlan),
    };
    return [
      'The user accepted the task queue. Work only on the current task cursor.',
      'Use exactly one registered execution semantic tool. Do not return a JSON proposal object.',
      'The accepted plan is intent context, not execution fact. Do not claim files changed, validation passed, or permission was granted.',
      'For generated content, call session.submit_task_artifacts with current IntentSlot ids and content only. Do not submit paths, Kernel tool identifiers, permission fields, work units, or audit fields.',
      currentTask
        ? `Current task: taskId=${currentTask.taskId}; title=${currentTask.title ?? 'untitled'}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
        : 'The current task list is complete or unavailable; call session.report_diagnostic instead of expanding scope.',
      promptFrame
        ? `AcceptedPlanPromptFrame: stableFrameHash=${promptFrame.stableFrameHash.slice(0, 16)}; currentTask=${promptFrame.taskLedger.currentTaskId ?? 'none'}; completedTaskCount=${promptFrame.taskLedger.completedTaskIds.length}; remainingTaskCount=${promptFrame.taskLedger.pendingTaskIds.length + (promptFrame.taskLedger.currentTaskId ? 1 : 0)}; projectMemoryRefresh=${promptFrame.cachePolicy.projectMemoryRefresh}.`
        : '',
      'Use session.request_resources only when a missing concrete fact would change current-task content. For exact patches, use match text copied from ResourceEvidence.',
      'Use session.complete_current_task when visible facts already satisfy the current task and no Kernel mutation is needed.',
      'Session advances the ordered task queue. Do not reconsider completed tasks or plan later-task scheduling.',
      guidance?.trim() ? `Additional guidance supplied when the user confirmed the plan:\n${guidance.trim()}` : '',
      `Accepted execution IntentSlot context:\n${fenced(JSON.stringify(providerContext, null, 2))}`,
    ].filter(Boolean).join('\n\n');
  }

  sanitizedContext(acceptedPlan: AcceptedImplementationPlanContext | undefined): Record<string, unknown> {
    if (!acceptedPlan) return {};
    const completed = new Set(acceptedPlan.completedTaskIds);
    const currentTask = acceptedPlan.tasks.find((task) => !completed.has(task.taskId));
    const intentSlots = this.intentSlots.currentTaskSlots(acceptedPlan);
    return {
      planId: acceptedPlan.planId,
      title: acceptedPlan.title ?? acceptedPlan.summary ?? acceptedPlan.planId,
      currentTask: currentTask
        ? {
          taskId: currentTask.taskId,
          title: currentTask.title,
          targets: currentTask.targets,
        }
        : undefined,
      completedTaskCount: acceptedPlan.completedTaskIds.length,
      remainingTaskCount: acceptedPlan.tasks.filter((task) => !completed.has(task.taskId)).length,
      intentSlots,
    };
  }
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
