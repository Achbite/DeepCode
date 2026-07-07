import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type ProposalEnvelope,
  type ReviewExpectationDraft,
  type ValidationExpectationDraft,
} from '../../protocol/types.js';

export interface ProposalSemanticValidatorPorts {
  maxActionBundleTotalCodeBytes: number;
  sideEffectCapabilities: Set<string>;
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined;
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  actionFileTargetPath(action: Record<string, unknown>): string | undefined;
  deleteActionTargetResourceKind(action: Record<string, unknown>): string | undefined;
  deleteActionRecursive(action: Record<string, unknown>): boolean;
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
    if (!userPlan || userPlan.trim().length < 240) return false;
    const lines = userPlan.split(/\r?\n/);
    const headings = lines.filter((line) => /^#{1,3}\s+\S/.test(line.trim()));
    const listItems = lines.filter((line) => /^\s*[-*+]\s+\S/.test(line));
    return headings.length >= 4 && listItems.length >= 3;
  }

  defaultActionBundleUserPlanMarkdown(input: {
    goal?: string;
    actions: Record<string, unknown>[];
    existingUserPlan?: string;
    outputLanguage?: string;
  }): string {
    const targets = input.actions.map((action) => this.ports.actionFileTargetPath(action)).filter((target): target is string => Boolean(target));
    const actionLines = input.actions.map((action, index) => {
      const capability = this.ports.actionEffectiveCapability(action) || 'side-effect';
      const target = this.ports.actionFileTargetPath(action) ?? `action-${index + 1}`;
      const description = stringValue(action.description) ?? stringValue(action.title) ?? capability;
      return { capability, target, description };
    });
    const targetList = targets.length
      ? targets.slice(0, 12).map((target) => `- ${target}`)
      : ['- Kernel facts will identify the affected workspace targets.'];
    const changeList = actionLines.length
      ? actionLines.slice(0, 12).map((action) => `- ${action.capability}: ${action.target} - ${action.description}`)
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

  canonicalizeWriteActionSourceBlockRefs(proposal: ProposalEnvelope): void {
    if (proposal.kind !== 'actionBundle') return;
    const payload = objectRecord(proposal.payload);
    const bundle = objectRecord(payload?.actionBundle);
    const codeBlocks = Array.isArray(payload?.codeBlocks) ? payload.codeBlocks : [];
    const actions = Array.isArray(bundle?.actions) ? bundle.actions : [];
    if (!payload || !bundle || !codeBlocks.length || !actions.length) return;

    const blocks = codeBlocks.flatMap((block) => {
      const record = objectRecord(block);
      const id = stringValue(record?.id) ?? stringValue(record?.blockId);
      const targetPath = stringValue(record?.targetPath) ?? stringValue(record?.path);
      if (!id || !targetPath) return [];
      return [{ id, targetPath: normalizePlanScope(targetPath) }];
    });
    if (!blocks.length) return;

    const fixes: Array<Record<string, unknown>> = [];
    for (const [index, action] of actions.entries()) {
      const record = objectRecord(action);
      if (!record) continue;
      const capability = this.ports.actionEffectiveCapability(record);
      if (capability !== 'fs.write') continue;
      const args = objectRecord(record.args) ?? objectRecord(record.toolArgs);
      const existingSource = stringValue(record.sourceBlockId) ?? stringValue(args?.sourceBlockId);
      if (existingSource) continue;
      const actionKind = stringValue(record.kind);
      if (['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) continue;
      const targetPath = this.ports.actionFileTargetPath(record);
      if (!targetPath) continue;
      const normalizedTarget = normalizePlanScope(targetPath);
      const matches = blocks.filter((block) => block.targetPath === normalizedTarget);
      if (matches.length !== 1) continue;

      const nextArgs = { ...(args ?? {}) };
      nextArgs.sourceBlockId = matches[0].id;
      record.args = nextArgs;
      record.toolArgs = nextArgs;
      record.sourceBlockId = matches[0].id;
      fixes.push({
        kind: 'fs_write_sourceBlockId_canonicalized',
        actionIndex: index,
        actionId: stringValue(record.actionId) ?? stringValue(record.id),
        path: normalizedTarget,
        sourceBlockId: matches[0].id,
        reason: 'unique_codeBlock_targetPath_match',
      });
    }

    if (!fixes.length) return;
    const diagnostics = objectRecord(proposal.parserDiagnostics);
    proposal.parserDiagnostics = {
      ...(diagnostics ?? {}),
      canonicalizations: [
        ...(Array.isArray(diagnostics?.canonicalizations) ? diagnostics.canonicalizations : []),
        ...fixes,
      ],
    };
  }

  validateProposalSemantics(proposal: ProposalEnvelope, options?: {
    allowBriefActionBundleUserPlan?: boolean;
  }): void {
    if (proposal.kind === 'taskPlan' || proposal.kind === 'implementationPlan') {
      this.validateTaskPlanSemantics(proposal);
      return;
    }
    if (proposal.kind !== 'actionBundle') return;
    const payload = objectRecord(proposal.payload) ?? {};
    const bundle = this.ports.readActionBundle(proposal);
    if (!bundle) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle must include an actionBundle object.');
    }
    if (typeof bundle.id !== 'string' || !bundle.id.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.id must be a non-empty string.');
    }
    if (bundle.version !== '1') {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.version must be "1".');
    }
    if (typeof bundle.goal !== 'string' || !bundle.goal.trim()) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.goal must be a non-empty string.');
    }
    if (!Array.isArray(bundle.actions) || bundle.actions.length === 0) {
      throw new AgentPlanParseError('invalid_action_bundle', 'Agent Protocol v3.actionBundle.actions must not be empty.');
    }
    const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
    const codeBlockIds = new Set<string>();
    let totalCodeBytes = 0;
    for (const [index, block] of codeBlocks.entries()) {
      const record = objectRecord(block);
      const blockId = typeof record?.id === 'string' ? record.id.trim() : '';
      if (!blockId) {
        throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].id must be a non-empty string.`);
      }
      codeBlockIds.add(blockId);
      const content = typeof record?.content === 'string' ? record.content : '';
      const size = utf8Bytes(content);
      totalCodeBytes += size;
      const operation = typeof record?.operation === 'string' ? record.operation : '';
      const allowEmptyContent = record?.allowEmptyContent === true;
      if (size === 0 && !(allowEmptyContent && ['createEmpty', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(operation))) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `codeBlocks[${index}].content must be non-empty. Empty content is allowed only with operation="createEmpty" for an explicit empty file or with patch/replace/insert operations; do not use empty .gitkeep or placeholder writes to create directories.`
        );
      }
    }
    if (totalCodeBytes > this.ports.maxActionBundleTotalCodeBytes) {
      throw new AgentPlanParseError(
        'action_bundle_budget_exceeded',
        `codeBlocks total content is ${totalCodeBytes} bytes; reorganize the implementation by module, file section, class, or function so this actionBundle stays within the ${this.ports.maxActionBundleTotalCodeBytes} byte payload budget without reducing the accepted plan scope.`
      );
    }
    for (const [index, action] of bundle.actions.entries()) {
      if (typeof action.id !== 'string' || !action.id.trim()) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].id must be a non-empty string.`);
      }
      if (typeof action.title !== 'string' || !action.title.trim()) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].title must be a non-empty string.`);
      }
      if (typeof action.capability !== 'string' || !action.capability.trim()) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].capability must be a non-empty string.`);
      }
      if (!Array.isArray(action.resourceScope)) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}].resourceScope must be an array.`);
      }
      const actionKind = typeof action.kind === 'string' ? action.kind : '';
      const effectiveActionKind = actionKind || (action.capability === 'fs.patch' ? 'patch' : '');
      const isPatchAction = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(effectiveActionKind);
      const replacementBlockId = typeof action.replacementBlockId === 'string'
        ? action.replacementBlockId.trim()
        : '';
      if (action.capability === 'fs.delete') {
        const deleteTargetError = this.deleteActionTargetError(action);
        if (deleteTargetError) {
          throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${deleteTargetError}`);
        }
        if (action.sourceBlockId?.trim() || replacementBlockId) {
          throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] fs.delete must not reference codeBlocks/sourceBlockId.`);
        }
      }
      if (action.capability === 'fs.write' && !isPatchAction && !action.sourceBlockId?.trim()) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${action.capability} must include sourceBlockId.`);
      }
      if (isPatchAction && !(replacementBlockId || action.sourceBlockId?.trim())) {
        throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] patch action must include replacementBlockId or sourceBlockId.`);
      }
      if (isPatchAction) {
        const patchSpecError = this.patchActionSpecError(action);
        if (patchSpecError) {
          throw new AgentPlanParseError('invalid_action_bundle', `actionBundle.actions[${index}] ${patchSpecError}`);
        }
      }
      if (action.sourceBlockId && !codeBlockIds.has(action.sourceBlockId)) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `actionBundle.actions[${index}].sourceBlockId "${action.sourceBlockId}" does not match any codeBlocks[].id.`
        );
      }
      if (replacementBlockId && !codeBlockIds.has(replacementBlockId)) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `actionBundle.actions[${index}].replacementBlockId "${replacementBlockId}" does not match any codeBlocks[].id.`
        );
      }
    }
    const sideEffectful = bundle.actions.some((action) => this.ports.sideEffectCapabilities.has(action.capability));
    if (!sideEffectful) return;
    for (const [index, block] of codeBlocks.entries()) {
      const record = objectRecord(block);
      const hasPath = typeof record?.path === 'string' && record.path.trim();
      const hasTargetPath = typeof record?.targetPath === 'string' && record.targetPath.trim();
      if (!hasPath && !hasTargetPath) {
        throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}] must include path or targetPath.`);
      }
      if (typeof record?.content !== 'string') {
        throw new AgentPlanParseError('invalid_action_bundle', `codeBlocks[${index}].content must be a string.`);
      }
    }
    let userPlan = typeof payload.userPlan === 'string' ? payload.userPlan.trim() : '';
    if (!options?.allowBriefActionBundleUserPlan) {
      if (!this.isDetailedUserPlanMarkdown(userPlan)) {
        const generatedUserPlan = this.defaultActionBundleUserPlanMarkdown({
          goal: bundle.goal,
          actions: bundle.actions as unknown as Record<string, unknown>[],
          existingUserPlan: userPlan,
          outputLanguage: stringValue(payload.outputLanguage)
            ?? stringValue((proposal as unknown as Record<string, unknown>).outputLanguage),
        });
        payload.userPlan = generatedUserPlan;
        payload.userPlanMarkdown = generatedUserPlan;
        userPlan = generatedUserPlan.trim();
      }
      this.validateDetailedUserPlan(userPlan);
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
    for (const [index, item] of tasks.entries()) {
      const record = objectRecord(item) ?? {};
      const targets = [
        ...stringArrayValue(record.target),
        ...stringArrayValue(record.targets),
      ];
      if (!targets.length) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].target must include at least one concrete target.`);
      }
      if (!stringArrayValue(record.acceptanceCriteria).length) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].acceptanceCriteria must include at least one reviewable criterion.`);
      }
      if (!stringArrayValue(record.failureCriteria).length) {
        throw new AgentPlanParseError('invalid_task_plan', `taskPlan.tasks[${index}].failureCriteria must include at least one stop or replan criterion.`);
      }
    }
  }

  private deleteActionTargetError(action: ActionBundleDraft['actions'][number]): string | undefined {
    const target = this.ports.actionFileTargetPath(action as unknown as Record<string, unknown>);
    if (!target) {
      return 'fs.delete must include a concrete targetPath or resourceScope[0].';
    }
    const normalized = normalizeSlashes(target);
    if (!normalized || normalized === '.' || normalized === './') {
      return 'fs.delete target cannot be empty or the workspace root.';
    }
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      return 'fs.delete target cannot escape the primary workspace root.';
    }
    if (normalized.includes('*')) {
      return 'fs.delete target must name concrete files; wildcard cleanup is not allowed.';
    }
    if (this.ports.deleteActionTargetResourceKind(action as unknown as Record<string, unknown>) === 'directory') {
      if (!this.ports.deleteActionRecursive(action as unknown as Record<string, unknown>) && normalized.endsWith('/')) {
        return 'fs.delete directory target with trailing slash must set recursive=true or use the normalized directory path.';
      }
      return undefined;
    }
    if (normalized.endsWith('/')) {
      return 'fs.delete directory target must set targetKind="directory" and recursive=true when deleting a directory tree.';
    }
    return undefined;
  }

  private patchActionSpecError(action: ActionBundleDraft['actions'][number]): string | undefined {
    const patchSpec = objectRecord(action.patchSpec);
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

  private validateDetailedUserPlan(userPlan: string): void {
    if (userPlan.length < 240) {
      throw new AgentPlanParseError(
        'action_bundle_plan_required',
        'Side-effect actionBundle must include a detailed Markdown userPlan, not a one-line summary.'
      );
    }
    const headings = userPlan
      .split(/\r?\n/)
      .filter((line) => /^#{1,3}\s+\S/.test(line.trim()));
    const listItems = userPlan
      .split(/\r?\n/)
      .filter((line) => /^\s*[-*+]\s+\S/.test(line));
    if (headings.length < 4 || listItems.length < 3) {
      throw new AgentPlanParseError(
        'action_bundle_plan_required',
        'Side-effect actionBundle.userPlan must use structured Markdown with multiple headings and concrete reviewable items; localized headings are accepted.'
      );
    }
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

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizeSlashes(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}
