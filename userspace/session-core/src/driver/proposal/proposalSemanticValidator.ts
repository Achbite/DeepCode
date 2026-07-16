import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type ProposalEnvelope,
  type ReviewExpectationDraft,
  type ValidationExpectationDraft,
} from '../../protocol/types.js';

export interface ProposalSemanticValidatorPorts {
  sideEffectToolIds: Set<string>;
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined;
  actionToolId(action: { toolId?: unknown }): string;
  actionFileTargetPath(action: Record<string, unknown>): string | undefined;
}

export class ProposalSemanticValidator {
  constructor(private readonly ports: ProposalSemanticValidatorPorts) {}

  expectationsHaveDescription(value: unknown): boolean {
    if (!Array.isArray(value)) return false;
    return value.some((item) => typeof objectRecord(item)?.description === 'string' && Boolean(String(objectRecord(item)?.description).trim()));
  }

  defaultValidationExpectation(actions: Record<string, unknown>[]): ValidationExpectationDraft {
    const targets = actions.map((action) => this.ports.actionFileTargetPath(action)).filter((target): target is string => Boolean(target));
    const targetSummary = targets.slice(0, 8).join(', ');
    const expectation: ValidationExpectationDraft & Record<string, unknown> = {
      id: 'session-default-validation',
      messageKey: targets.length
        ? 'session.driver.defaultValidation.targets'
        : 'session.driver.defaultValidation.generic',
      messageArgs: targets.length ? { targets: targetSummary } : {},
      description: targets.length
        ? `Kernel facts must show the requested operation completed for: ${targetSummary}.`
        : 'Kernel facts must show the requested side-effect operation completed.',
    };
    return expectation;
  }

  defaultReviewExpectation(actions: Record<string, unknown>[]): ReviewExpectationDraft {
    const targets = actions.map((action) => this.ports.actionFileTargetPath(action)).filter((target): target is string => Boolean(target));
    const targetSummary = targets.slice(0, 8).join(', ');
    const expectation: ReviewExpectationDraft & Record<string, unknown> = {
      id: 'session-default-review',
      messageKey: targets.length
        ? 'session.driver.defaultReview.targets'
        : 'session.driver.defaultReview.generic',
      messageArgs: targets.length ? { targets: targetSummary } : {},
      description: targets.length
        ? `Review the Kernel facts and resulting workspace state for: ${targetSummary}.`
        : 'Review the Kernel facts and resulting workspace state for this action bundle.',
    };
    return expectation;
  }

  isDetailedUserPlanMarkdown(userPlan: string | undefined): boolean {
    return Boolean(userPlan?.trim());
  }

  defaultActionBundleUserPlanMarkdown(input: {
    goal?: string;
    actions: Record<string, unknown>[];
    existingUserPlan?: string;
    outputLanguage?: string;
  }): string {
    const targets = input.actions.map((action) => this.ports.actionFileTargetPath(action)).filter((target): target is string => Boolean(target));
    const actionLines = input.actions.map((action, index) => {
      const toolId = this.ports.actionToolId(action) || 'side-effect';
      const target = this.ports.actionFileTargetPath(action) ?? `action-${index + 1}`;
      const description = stringValue(action.description) ?? toolId;
      return { toolId, target, description };
    });
    const targetList = targets.length
      ? targets.slice(0, 12).map((target) => `- ${target}`)
      : ['- Kernel facts will identify the affected workspace targets.'];
    const changeList = actionLines.length
      ? actionLines.slice(0, 12).map((action) => `- ${action.toolId}: ${action.target} - ${action.description}`)
      : ['- Submit the current accepted-task side-effect batch to Kernel review.'];
    const summary = input.goal ?? input.existingUserPlan ?? 'Execute the current accepted-task action bundle.';
    if ((input.outputLanguage ?? '').toLowerCase().startsWith('zh')) {
      return [
        '# 执行批次',
        '',
        '## 摘要',
        summary,
        '',
        '## 关键变更',
        ...changeList,
        '',
        '## 影响范围',
        ...targetList,
        '',
        '## 验证计划',
        '- Kernel facts 必须记录本批次的工具执行结果。',
        '- Review 阶段必须展示实际变更路径和执行状态。',
        '',
        '## 假设与约束',
        '- 本批次只覆盖当前已确认任务范围内的操作。',
        '- Session 只补充可审查说明，不把该说明当作完成事实。',
      ].join('\n');
    }
    return [
      '# Execution Batch',
      '',
      '## Summary',
      summary,
      '',
      '## Key Changes',
      ...changeList,
      '',
      '## Affected Targets',
      ...targetList,
      '',
      '## Validation Plan',
      '- Kernel facts must record the tool execution results for this batch.',
      '- Review must show the actual changed paths and execution status.',
      '',
      '## Assumptions And Constraints',
      '- This batch only covers operations inside the current accepted task scope.',
      '- Session adds reviewable explanation only; this explanation is not a completion fact.',
    ].join('\n');
  }

  validateProposalSemantics(proposal: ProposalEnvelope, options?: {
    allowBriefActionBundleUserPlan?: boolean;
  }): void {
    if (proposal.kind === 'taskPlan') {
      this.validateTaskPlanSemantics(proposal);
      return;
    }
    if (proposal.kind !== 'actionBundle') return;
    const payload = objectRecord(proposal.payload) ?? {};
    const bundle = this.ports.readActionBundle(proposal);
    if (!bundle) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v4.actionBundle must include an actionBundle object.');
    }
    if (typeof bundle.id !== 'string' || !bundle.id.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v4.actionBundle.id must be a non-empty string.');
    }
    if (bundle.version !== '1') {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v4.actionBundle.version must be "1".');
    }
    if (typeof bundle.goal !== 'string' || !bundle.goal.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v4.actionBundle.goal must be a non-empty string.');
    }
    if (!Array.isArray(bundle.actions) || bundle.actions.length === 0) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v4.actionBundle.actions must not be empty.');
    }
    const contentBlocks = Array.isArray(payload.contentBlocks) ? payload.contentBlocks : [];
    const contentBlockIds = new Set<string>();
    for (const [index, block] of contentBlocks.entries()) {
      const record = objectRecord(block);
      const blockId = stringValue(record?.blockId) ?? '';
      if (!blockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `contentBlocks[${index}].blockId must be a non-empty string.`);
      }
      contentBlockIds.add(blockId);
      const contentLines = Array.isArray(record?.contentLines)
        ? record.contentLines.filter((line): line is string => typeof line === 'string')
        : [];
      const content = contentLines.join('\n');
      const size = utf8Bytes(content);
      const operation = typeof record?.operation === 'string' ? record.operation : '';
      const allowEmptyContent = record?.allowEmptyContent === true;
      if (size === 0 && !(allowEmptyContent && ['createEmpty', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(operation))) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `contentBlocks[${index}].contentLines must be non-empty. Empty content is allowed only with operation="createEmpty" and allowEmptyContent=true.`
        );
      }
    }
    for (const [index, action] of bundle.actions.entries()) {
      const toolId = action.toolId.trim();
      if (!action.actionId.trim() || !toolId || !objectRecord(action.args)) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] requires actionId, toolId, and typed args.`);
      }
      const args = action.args;
      const contentBlockId = stringValue(args.contentBlockId);
      const replacementBlockId = stringValue(args.replacementBlockId);
      if (toolId === 'fs.delete') {
        if (contentBlockId || replacementBlockId) {
          throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] fs.delete must not reference content blocks.`);
        }
      }
      if ((toolId === 'fs.create' || toolId === 'fs.write') && !contentBlockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${toolId} must include args.contentBlockId.`);
      }
      if (toolId === 'fs.edit' && !replacementBlockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] fs.edit must include args.replacementBlockId.`);
      }
      if (toolId === 'fs.edit') {
        const patchSpecError = this.patchActionSpecError(action);
        if (patchSpecError) {
          throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${patchSpecError}`);
        }
      }
      if (contentBlockId && !contentBlockIds.has(contentBlockId)) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `actionBundle.actions[${index}].args.contentBlockId "${contentBlockId}" does not match any contentBlocks[].blockId.`
        );
      }
      if (replacementBlockId && !contentBlockIds.has(replacementBlockId)) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `actionBundle.actions[${index}].args.replacementBlockId "${replacementBlockId}" does not match any contentBlocks[].blockId.`
        );
      }
    }
    const sideEffectful = bundle.actions.some((action) => this.ports.sideEffectToolIds.has(action.toolId));
    if (!sideEffectful) return;
    for (const [index, block] of contentBlocks.entries()) {
      const record = objectRecord(block);
      if (!stringValue(record?.targetPath)) {
        throw new AgentPlanParseError('invalid_action_bundle', `contentBlocks[${index}].targetPath must be a non-empty string.`);
      }
      if (!Array.isArray(record?.contentLines)) {
        throw new AgentPlanParseError('invalid_action_bundle', `contentBlocks[${index}].contentLines must be an array.`);
      }
    }
    let userPlan = typeof payload.userPlan === 'string' ? payload.userPlan.trim() : '';
    if (!options?.allowBriefActionBundleUserPlan) {
      if (!this.isDetailedUserPlanMarkdown(userPlan)) {
        const generatedUserPlan = this.defaultActionBundleUserPlanMarkdown({
          goal: bundle.goal,
          actions: bundle.actions as unknown as Record<string, unknown>[],
          existingUserPlan: userPlan,
          outputLanguage: stringValue(payload.outputLanguage),
        });
        payload.userPlan = generatedUserPlan;
        userPlan = generatedUserPlan.trim();
      }
    }
    const validationExpectations = Array.isArray(bundle.validationExpectations) ? bundle.validationExpectations : [];
    const reviewExpectations = Array.isArray(bundle.reviewExpectations) ? bundle.reviewExpectations : [];
    if (!validationExpectations.some((item) => item?.description?.trim())) {
      bundle.validationExpectations = [this.defaultValidationExpectation(bundle.actions as unknown as Record<string, unknown>[])];
    }
    if (!reviewExpectations.some((item) => item?.description?.trim())) {
      bundle.reviewExpectations = [this.defaultReviewExpectation(bundle.actions as unknown as Record<string, unknown>[])];
    }
  }

  private validateTaskPlanSemantics(proposal: ProposalEnvelope): void {
    const plan = objectRecord(proposal.payload) ?? {};
    const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const taskPositions = new Map<string, number>();
    for (const [index, item] of tasks.entries()) {
      const taskId = stringValue((objectRecord(item) ?? {}).taskId);
      if (!taskId) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].taskId must be non-empty.`);
      }
      if (taskPositions.has(taskId)) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan taskId ${taskId} must be unique.`);
      }
      taskPositions.set(taskId, index);
    }
    for (const [index, item] of tasks.entries()) {
      const record = objectRecord(item) ?? {};
      const taskId = stringValue(record.taskId)!;
      const targets = stringArrayValue(record.target);
      if (!targets.length) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].target must include at least one concrete target.`);
      }
      const toolId = stringValue(record.toolId);
      if (!toolId) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].toolId must be a non-empty Kernel catalog tool ID.`);
      }
      if (!stringArrayValue(record.acceptanceCriteria).length) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].acceptanceCriteria must include at least one reviewable criterion.`);
      }
      if (!stringArrayValue(record.failureCriteria).length) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].failureCriteria must include at least one stop or replan criterion.`);
      }
      if (!Array.isArray(record.dependencies)) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].dependencies must be an explicit string array.`);
      }
      for (const dependency of stringArrayValue(record.dependencies)) {
        const dependencyIndex = taskPositions.get(dependency);
        if (dependencyIndex === undefined) {
          throw new AgentPlanParseError(
            'invalid_task_plan',
            `taskPlan task ${taskId} references unknown dependency ${dependency}.`
          );
        }
        if (dependencyIndex >= index) {
          throw new AgentPlanParseError(
            'invalid_task_plan',
            `taskPlan task ${taskId} dependency ${dependency} must reference an earlier task.`
          );
        }
      }
    }
  }

  private patchActionSpecError(action: ActionBundleDraft['actions'][number]): string | undefined {
    const patchSpec = objectRecord(action.args.patchSpec);
    if (!patchSpec) {
      return 'patch action must include patchSpec.';
    }
    const match = objectRecord(patchSpec.match);
    if (!match) {
      return 'patch action must include patchSpec.match.';
    }
    const matchKind = stringValue(match.kind);
    if (matchKind !== 'exactBlock') {
      return 'patchSpec.match.kind must be "exactBlock".';
    }
    const text = stringValue(match.text);
    if (!text) {
      return 'patchSpec.match.text must be a non-empty exact block from current ResourcePacket evidence.';
    }
    return undefined;
  }

}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : [];
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
