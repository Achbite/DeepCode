import type {
  ProposalEnvelope,
  ReviewExpectationDraft,
  ValidationExpectationDraft,
} from '../protocol/types.js';
import {
  acceptedPlanSettledTaskIds,
  type AcceptedTaskPlanContext,
} from './types.js';
import { AcceptedTaskRegistry } from './AcceptedTaskRegistry.js';
import { IntentSlotRegistry } from '../driver/execution/intentSlot.js';

export interface DefaultActionBundleUserPlanMarkdownInput {
  goal?: string;
  actions: Record<string, unknown>[];
  existingUserPlan?: string;
  responseLanguage?: string;
}

export interface ExecutionPromptCoordinatorPorts<TPlan> {
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  planId(plan: TPlan): string;
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
    if (!Array.isArray(payload.contentBlocks)) {
      payload.contentBlocks = [];
    }
    const existingUserPlan = this.ports.stringValue(payload.userPlan);
    if (!this.ports.isDetailedUserPlanMarkdown(existingUserPlan)) {
      const generatedUserPlan = this.ports.defaultActionBundleUserPlanMarkdown({
        goal: this.ports.stringValue(bundle.goal),
        actions,
        existingUserPlan,
        responseLanguage: proposal.responseLanguage,
      });
      payload.userPlan = generatedUserPlan;
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
    acceptedPlan: AcceptedTaskPlanContext,
    guidance?: string
  ): string {
    const settled = new Set(acceptedPlanSettledTaskIds(acceptedPlan));
    const currentTask = acceptedPlan.tasks.find((task) => !settled.has(task.taskId));
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
      'For generated content, call session.append_artifact_chunk for one current IntentSlot at a time. A small file may be one logical block; split larger content only at meaningful class, function, script, or configuration-section boundaries. Do not count lines or bytes.',
      'For an exactPatch slot, the first logical block must include editMatch derived from current ResourcePacket text. Use exactBlock, contextBlock, or a guarded lineRange; never substitute the whole file when a smaller unique block is available.',
      'Call session.finalize_task_artifacts after every slot is complete. Do not submit paths, draft ids, sequence numbers, hashes, Kernel tool identifiers, permission fields, work units, or audit fields.',
      currentTask
        ? `Current task: taskId=${currentTask.taskId}; title=${currentTask.title ?? 'untitled'}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; toolId=${currentTask.toolId ?? 'none'}.`
        : 'The current task list is complete or unavailable; Session must transition to Review instead of asking the model to invent another task directive.',
      promptFrame
        ? `AcceptedPlanPromptFrame: stableFrameHash=${promptFrame.stableFrameHash.slice(0, 16)}; currentTask=${promptFrame.taskLedger.currentTaskId ?? 'none'}; completedTaskCount=${promptFrame.taskLedger.completedTaskIds.length}; remainingTaskCount=${promptFrame.taskLedger.pendingTaskIds.length + (promptFrame.taskLedger.currentTaskId ? 1 : 0)}; projectMemoryRefresh=${promptFrame.cachePolicy.projectMemoryRefresh}.`
        : '',
      'Use session.request_resources only when a missing concrete fact would change current-task content. For exact patches, use match text copied from ResourceEvidence.',
      'If fresh, non-truncated evidence resolved for this task proves every acceptance criterion is already satisfied, call session.submit_task_outcome with outcome=alreadySatisfied and cite only the task-scoped evidence references supplied by Session.',
      'If no action or alreadySatisfied outcome applies, use session.request_decision for a recoverable user choice or session.report_diagnostic for a terminal task failure.',
      'Session advances the ordered task queue. Do not reconsider completed tasks or plan later-task scheduling.',
      guidance?.trim() ? `Additional guidance supplied when the user confirmed the plan:\n${guidance.trim()}` : '',
      `Accepted execution IntentSlot context:\n${fenced(JSON.stringify(providerContext, null, 2))}`,
    ].filter(Boolean).join('\n\n');
  }

  sanitizedContext(acceptedPlan: AcceptedTaskPlanContext | undefined): Record<string, unknown> {
    if (!acceptedPlan) return {};
    const settled = new Set(acceptedPlanSettledTaskIds(acceptedPlan));
    const currentTask = acceptedPlan.tasks.find((task) => !settled.has(task.taskId));
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
      kernelCompletedTaskCount: acceptedPlan.completedTaskIds.length,
      settledTaskCount: settled.size,
      remainingTaskCount: acceptedPlan.tasks.filter((task) => !settled.has(task.taskId)).length,
      intentSlots,
    };
  }
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
