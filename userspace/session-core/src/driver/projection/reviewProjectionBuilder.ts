import type { AgentEvent } from '@deepcode/protocol';

export type ReviewProjectionLanguage = 'zh-CN' | 'en-US';

export interface ReviewProjectionPlan {
  userPlan: string;
  expectedValidation: string;
  reviewGuide: string;
  actionBundle: {
    reviewExpectations?: unknown;
    continuationExpectations?: unknown;
    [key: string]: unknown;
  };
}

export interface ReviewProjectionSummaryPlan extends ReviewProjectionPlan {
  sessionId: string;
  runId: string;
  planId: string;
  implementationPlan?: unknown;
  executionRoot?: unknown;
}

export interface ReadableReviewChangedFile {
  path: string;
  operation: string;
  status: 'completed' | 'failed' | 'blocked' | 'unknown';
  actionId?: string;
  workUnitId?: string;
  toolFactIds?: string[];
  failureClassification?: string;
  failureReason?: string;
  summary: string;
  messageKey: 'review.changedFile';
  messageArgs: Record<string, string>;
  auditRef?: string;
  diffRef?: string;
}

export interface ReadableReviewSummary {
  schemaVersion: 'deepcode.session.readable-review.v1';
  changedFiles: ReadableReviewChangedFile[];
  operationCounts: Record<string, number>;
  auditRefs: string[];
  developerDetailsAvailable: boolean;
  messageKey: 'review.summary';
  messageArgs: Record<string, string>;
}

export interface ReviewFactsContextInput<TaskLedger = unknown> {
  planId: string;
  runId: string;
  taskLedger?: TaskLedger;
  changedFileCount: number;
  auditRefCount: number;
}

export interface ReviewProjectionBuilderPorts<
  Plan extends ReviewProjectionSummaryPlan = ReviewProjectionSummaryPlan,
  AcceptedPlan = unknown,
  TaskLedger = unknown,
> {
  reviewFactLines(kernelEvents: unknown[]): string[];
  staticSyntaxReviewFactLines(kernelEvents: unknown[]): string[];
  findReviewFacts(kernelEvents: unknown[]): Record<string, unknown> | undefined;
  concreteContinuationExpectations(value: unknown): unknown[];
  languageForRequest(userPlan: string): ReviewProjectionLanguage;
  acceptedPlanContext(plan: Plan): AcceptedPlan | undefined;
  acceptedPlanBatchCompletedTaskIds(acceptedPlan: AcceptedPlan, plan: Plan, kernelEvents: unknown[]): string[];
  acceptedPlanAfterBatch(acceptedPlan: AcceptedPlan, completedTaskIds: string[]): AcceptedPlan;
  acceptedPlanTaskLedger(acceptedPlan: AcceptedPlan): TaskLedger | undefined;
  buildReviewFactsContext(input: ReviewFactsContextInput<TaskLedger>): unknown;
}

export class ReviewProjectionBuilder<
  Plan extends ReviewProjectionSummaryPlan = ReviewProjectionSummaryPlan,
  AcceptedPlan = unknown,
  TaskLedger = unknown,
> {
  constructor(private readonly ports?: ReviewProjectionBuilderPorts<Plan, AcceptedPlan, TaskLedger>) {}

  summaryEvent(input: {
    sessionId: string;
    plan: Plan;
    kernelEvents: unknown[];
    ts: string;
    id: string;
  }): AgentEvent {
    const ports = this.requirePorts();
    const facts = [
      ...ports.reviewFactLines(input.kernelEvents),
      ...ports.staticSyntaxReviewFactLines(input.kernelEvents),
    ];
    const reviewFacts = ports.findReviewFacts(input.kernelEvents);
    const gitReview = reviewFacts ? objectRecord(reviewFacts.gitReview) : undefined;
    const completed = Math.max(
      reviewFacts ? arrayLength(reviewFacts.completedWorkUnits) : 0,
      input.kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.completed').length
    );
    const failed = Math.max(
      reviewFacts ? arrayLength(reviewFacts.failedWorkUnits) : 0,
      input.kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.failed').length
    );
    const blocked = Math.max(
      reviewFacts ? arrayLength(reviewFacts.blockedWorkUnits) : 0,
      input.kernelEvents.filter((event) => objectRecord(event)?.kind === 'work_unit.blocked').length
    );
    const toolResults = Math.max(
      reviewFacts ? arrayLength(reviewFacts.toolResults) : 0,
      input.kernelEvents.filter((event) => objectRecord(event)?.kind === 'tool.completed').length
    );
    const continuations = ports.concreteContinuationExpectations(input.plan.actionBundle.continuationExpectations);
    const language = ports.languageForRequest(input.plan.userPlan);
    const summary = this.waitingSummary(failed, blocked, language);
    const readableReview = this.readableSummary(input.kernelEvents, reviewFacts);
    const acceptedPlanForReview = input.plan.implementationPlan
      ? ports.acceptedPlanContext(input.plan)
      : undefined;
    const reviewTaskLedger = acceptedPlanForReview
      ? ports.acceptedPlanTaskLedger(ports.acceptedPlanAfterBatch(
        acceptedPlanForReview,
        ports.acceptedPlanBatchCompletedTaskIds(acceptedPlanForReview, input.plan, input.kernelEvents)
      ))
      : undefined;
    const reviewFactsContextInput: ReviewFactsContextInput<TaskLedger> = {
      planId: input.plan.planId,
      runId: input.plan.runId,
      changedFileCount: readableReview.changedFiles.length,
      auditRefCount: readableReview.auditRefs.length,
    };
    if (reviewTaskLedger) reviewFactsContextInput.taskLedger = reviewTaskLedger;
    const reviewFactsContext = ports.buildReviewFactsContext(reviewFactsContextInput);
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'review_summary',
      payload: {
        title: 'Review',
        summary,
        messageKey: failed || blocked ? 'review.summary.needsAttention' : 'review.summary.waitingUserReview',
        messageArgs: {
          completed: String(completed),
          failed: String(failed),
          blocked: String(blocked),
          toolResults: String(toolResults),
        },
        content: this.waitingContent({
          plan: input.plan,
          readableReview,
          summary,
          completed,
          failed,
          blocked,
          toolResults,
          continuations,
          gitReview,
          reviewFacts,
          language,
        }),
        status: 'waitingUserReview',
        runId: input.plan.runId,
        reviewId: `${input.plan.runId}:${input.plan.planId}`,
        sourcePlanId: input.plan.planId,
        confirmable: true,
        continuationRequested: false,
        continuationCount: continuations.length,
        continuations,
        reviewExpectations: Array.isArray(input.plan.actionBundle.reviewExpectations) ? input.plan.actionBundle.reviewExpectations : [],
        reviewFacts,
        gitReview,
        readableReview,
        reviewFactsContext,
        changedFiles: readableReview.changedFiles,
        developerDetails: {
          facts,
          reviewFacts,
          gitReview,
          reviewFactsContext,
        },
        facts,
        factCounts: {
          workUnitsCompleted: completed,
          workUnitsFailed: failed,
          workUnitsBlocked: blocked,
          toolResults,
        },
        channel: 'review',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  waitingSummary(failed: number, blocked: number, language: ReviewProjectionLanguage): string {
    if (language === 'en-US') {
      return failed || blocked
        ? 'The current batch progressed but has failed or blocked items. Review the facts and decide whether to revise.'
        : 'The current batch has executed. Review the tool facts and validation results.';
    }
    return failed || blocked
      ? '当前批次已推进，但存在失败或阻塞项，请审查事实后决定是否修订。'
      : '当前批次已执行，请审查工具事实与验证结果。';
  }

  waitingContent(input: {
    plan: ReviewProjectionPlan;
    readableReview: ReadableReviewSummary;
    summary: string;
    completed: number;
    failed: number;
    blocked: number;
    toolResults: number;
    continuations: unknown[];
    gitReview?: Record<string, unknown>;
    reviewFacts?: Record<string, unknown>;
    language?: ReviewProjectionLanguage;
  }): string {
    const {
      plan,
      readableReview,
      summary,
      completed,
      failed,
      blocked,
      toolResults,
      continuations,
      gitReview,
      reviewFacts,
      language = 'zh-CN',
    } = input;
    const reviewLines = reviewExpectationLines(plan, language);
    const labels = reviewContentLabels(language);
    const gitLines = gitReviewSummaryLines(gitReview, language);
    const generatedLines = reviewGeneratedArtifactLines(reviewFacts, language);
    const normalizationLines = reviewPathNormalizationLines(reviewFacts, language);
    const changedFileLines = readableReviewChangedFileLines(readableReview, language);
    return [
      '## Review',
      '',
      summary,
      '',
      `### ${labels.executionResult}`,
      `- ${labels.workUnitsCompleted}：${completed}`,
      `- ${labels.workUnitsFailed}：${failed}`,
      `- ${labels.workUnitsBlocked}：${blocked}`,
      `- ${labels.toolFacts}：${toolResults}`,
      '',
      `### ${labels.changedFiles}`,
      changedFileLines.length ? changedFileLines.join('\n') : `- ${labels.noChangedFiles}`,
      '',
      `### ${labels.generatedArtifacts}`,
      generatedLines.length ? generatedLines.join('\n') : `- ${labels.noGeneratedArtifacts}`,
      '',
      `### ${labels.pathDiagnostics}`,
      normalizationLines.length ? normalizationLines.join('\n') : `- ${labels.noPathDiagnostics}`,
      '',
      `### ${labels.gitChanges}`,
      gitLines.length ? gitLines.join('\n') : `- ${labels.noGitChanges}`,
      '',
      `### ${labels.auditDetails}`,
      readableReview.developerDetailsAvailable
        ? `- ${labels.auditDetailsAvailable}`
        : `- ${labels.noAuditDetails}`,
      readableReview.auditRefs.length ? `- auditRefs：${readableReview.auditRefs.slice(0, 12).join(', ')}` : '- auditRefs：none',
      '',
      `### ${labels.originalPlan}`,
      clip(plan.userPlan, 1200),
      '',
      `### ${labels.validation}`,
      reviewLines.length ? reviewLines.join('\n') : `- ${labels.noValidation}`,
      '',
      `### ${labels.nextDecision}`,
      failed || blocked
        ? `- ${labels.failedDecisionHint}`
        : `- ${labels.successDecisionHint}`,
      continuations.length
        ? `- ${labels.continuationHint.replace('{count}', String(continuations.length))}`
        : `- ${labels.noContinuation}`,
    ].join('\n');
  }

  readableSummary(kernelEvents: unknown[], reviewFacts?: Record<string, unknown>): ReadableReviewSummary {
    const changedFiles = new Map<string, ReadableReviewChangedFile>();
    const auditRefs: string[] = [];
    const generatedArtifacts = Array.isArray(reviewFacts?.generatedArtifacts) ? reviewFacts.generatedArtifacts : [];
    for (const item of generatedArtifacts) {
      const record = objectRecord(item);
      if (!record) continue;
      const path = reviewDisplayPath(record);
      if (!path) continue;
      const operation = reviewOperation(record);
      const actionId = stringValue(record.actionId);
      const key = `${path}:${operation}:${actionId ?? ''}`;
      changedFiles.set(key, {
        path,
        operation,
        status: 'completed',
        actionId,
        summary: `${path} operation=${operation}`,
        messageKey: 'review.changedFile',
        messageArgs: { path, operation, status: 'completed' },
        auditRef: actionId,
      });
      if (actionId) auditRefs.push(actionId);
    }

    const completedWorkUnits = Array.isArray(reviewFacts?.completedWorkUnits) ? reviewFacts.completedWorkUnits : [];
    const failedWorkUnits = Array.isArray(reviewFacts?.failedWorkUnits) ? reviewFacts.failedWorkUnits : [];
    const blockedWorkUnits = Array.isArray(reviewFacts?.blockedWorkUnits) ? reviewFacts.blockedWorkUnits : [];
    for (const item of completedWorkUnits) addReviewWorkUnitFile(changedFiles, auditRefs, item, 'completed');
    for (const item of failedWorkUnits) addReviewWorkUnitFile(changedFiles, auditRefs, item, 'failed');
    for (const item of blockedWorkUnits) addReviewWorkUnitFile(changedFiles, auditRefs, item, 'blocked');

    const toolResults = Array.isArray(reviewFacts?.toolResults) ? reviewFacts.toolResults : [];
    for (const item of toolResults) addReviewToolFile(changedFiles, auditRefs, item);

    for (const event of kernelEvents) {
      const record = objectRecord(event);
      if (!record) continue;
      const kind = stringValue(record.kind);
      if (kind === 'work_unit.completed') addReviewWorkUnitFile(changedFiles, auditRefs, record, 'completed');
      if (kind === 'work_unit.failed') addReviewWorkUnitFile(changedFiles, auditRefs, record, 'failed');
      if (kind === 'work_unit.blocked') addReviewWorkUnitFile(changedFiles, auditRefs, record, 'blocked');
      if (kind === 'tool.completed') addReviewToolFile(changedFiles, auditRefs, record);
    }

    const files = [...changedFiles.values()];
    const operationCounts: Record<string, number> = {};
    for (const file of files) operationCounts[file.operation] = (operationCounts[file.operation] ?? 0) + 1;
    return {
      schemaVersion: 'deepcode.session.readable-review.v1',
      changedFiles: files,
      operationCounts,
      auditRefs: [...new Set(auditRefs.filter((item) => item.trim().length > 0))],
      developerDetailsAvailable: Boolean(reviewFacts) || kernelEvents.length > 0,
      messageKey: 'review.summary',
      messageArgs: {
        changedFiles: String(files.length),
        auditRefs: String(auditRefs.length),
      },
    };
  }

  private requirePorts(): ReviewProjectionBuilderPorts<Plan, AcceptedPlan, TaskLedger> {
    if (!this.ports) {
      throw new Error('ReviewProjectionBuilder.summaryEvent requires ports.');
    }
    return this.ports;
  }
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function reviewContentLabels(language: ReviewProjectionLanguage): Record<string, string> {
  if (language === 'en-US') {
    return {
      executionResult: 'Execution Result',
      workUnitsCompleted: 'WorkUnits completed',
      workUnitsFailed: 'WorkUnits failed',
      workUnitsBlocked: 'WorkUnits blocked',
      toolFacts: 'Tool facts',
      changedFiles: 'Files Changed In This Batch',
      noChangedFiles: 'No file-level change summary was recorded for this batch.',
      generatedArtifacts: 'Agent Generated Artifacts',
      noGeneratedArtifacts: 'ReviewFacts did not record agentGenerated artifacts.',
      pathDiagnostics: 'Path Normalization Diagnostics',
      noPathDiagnostics: 'No path prefix stripping or duplicate-root diagnostics were recorded.',
      gitChanges: 'Git Changes',
      noGitChanges: 'No Git change facts are available.',
      auditDetails: 'Audit Details',
      auditDetailsAvailable: 'Raw Kernel facts, tool facts, and ReviewFacts are retained in developerDetails / audit refs. The main view does not expand full JSON.',
      noAuditDetails: 'No developerDetails are available.',
      originalPlan: 'Original Plan Summary',
      validation: 'Validation And Startup Suggestions',
      noValidation: 'The current plan did not provide an executable validation command; add one in a later turn if needed.',
      nextDecision: 'Next Decision',
      failedDecisionHint: 'Empty input accepts and closes the current batch without retrying failed items; type Review feedback to re-enter planning.',
      successDecisionHint: 'Empty input accepts and closes the current batch; typed text is treated as Review revision feedback and re-enters planning.',
      continuationHint: 'The current plan recorded {count} continuation intent(s). Review acceptance follows agent.reviewContinuationMode. Auto mode generates the next Plan only; the new Plan still requires confirmation.',
      noContinuation: 'The current plan did not record continuation batches.',
    };
  }
  return {
    executionResult: '执行结果',
    workUnitsCompleted: 'WorkUnit 完成',
    workUnitsFailed: 'WorkUnit 失败',
    workUnitsBlocked: 'WorkUnit 阻塞',
    toolFacts: 'Tool facts',
    changedFiles: '本轮实际改动文件',
    noChangedFiles: '当前批次没有记录文件级变更摘要。',
    generatedArtifacts: '本轮 Agent 生成产物',
    noGeneratedArtifacts: '当前 ReviewFacts 没有记录 agentGenerated 产物。',
    pathDiagnostics: '路径归一化诊断',
    noPathDiagnostics: '当前没有路径前缀剥离或重复根路径诊断。',
    gitChanges: 'Git 变更',
    noGitChanges: '当前没有可展示的 Git 变更事实。',
    auditDetails: '审计详情',
    auditDetailsAvailable: '原始 Kernel facts、tool facts 与 ReviewFacts 已保留在 developerDetails / audit refs 中，主视图不展开完整 JSON。',
    noAuditDetails: '当前没有可展开的 developerDetails。',
    originalPlan: '原计划摘要',
    validation: '验证与启动建议',
    noValidation: '当前计划未提供可执行验证命令，需要下一轮补充。',
    nextDecision: '后续决策',
    failedDecisionHint: '空输入通过并结束当前批次，不会自动执行失败项；如需修复，请在输入框输入 Review 修改意见，系统会重新进入 Plan。',
    successDecisionHint: '空输入通过并结束当前批次；输入文字会作为 Review 修订意见，系统会重新进入 Plan。',
    continuationHint: '当前计划登记了 {count} 个后续意图；Review 通过后会按 agent.reviewContinuationMode 处理。自动模式会生成下一批 Plan；新 Plan 仍需确认，确认后的合规 actionBundle 会自动提交 Kernel 执行。',
    noContinuation: '当前计划没有登记后续批次。',
  };
}

function addReviewWorkUnitFile(
  changedFiles: Map<string, ReadableReviewChangedFile>,
  auditRefs: string[],
  value: unknown,
  status: ReadableReviewChangedFile['status']
): void {
  const record = objectRecord(value);
  if (!record) return;
  const output = objectRecord(record.output);
  const path = reviewDisplayPath(output) ?? reviewDisplayPath(record);
  if (!path) return;
  const actionId = stringValue(output?.actionId) ?? stringValue(record.actionId);
  const workUnitId = stringValue(record.workUnitId);
  const operation = reviewOperation(output ?? record);
  const failure = status === 'failed' || status === 'blocked'
    ? reviewFailureDetail(record, output)
    : {};
  const key = `${path}:${operation}:${workUnitId ?? actionId ?? status}`;
  changedFiles.set(key, {
    path,
    operation,
    status,
    actionId,
    workUnitId,
    failureClassification: failure.classification,
    failureReason: failure.reason,
    summary: failure.reason
      ? `${path} operation=${operation} status=${status} reason=${failure.reason}`
      : `${path} operation=${operation} status=${status}`,
    messageKey: 'review.changedFile',
    messageArgs: { path, operation, status, reason: failure.reason ?? '' },
    auditRef: workUnitId ?? actionId,
  });
  if (workUnitId) auditRefs.push(workUnitId);
  if (actionId) auditRefs.push(actionId);
}

function addReviewToolFile(
  changedFiles: Map<string, ReadableReviewChangedFile>,
  auditRefs: string[],
  value: unknown
): void {
  const record = objectRecord(value);
  if (!record) return;
  const output = objectRecord(record.output);
  const path = reviewDisplayPath(output) ?? reviewDisplayPath(record);
  if (!path) return;
  const toolName = stringValue(record.toolName) ?? stringValue(output?.toolName);
  const actionId = stringValue(output?.actionId) ?? stringValue(record.actionId);
  const toolFactId = stringValue(record.toolCallId) ?? stringValue(record.factId);
  const operation = reviewOperation(output ?? record, toolName);
  const status = record.ok === false ? 'failed' : 'completed';
  const key = `${path}:${operation}:${toolFactId ?? actionId ?? status}`;
  const existing = changedFiles.get(key);
  const failure = status === 'failed' ? reviewFailureDetail(record, output) : {};
  changedFiles.set(key, {
    path,
    operation,
    status,
    actionId: actionId ?? existing?.actionId,
    workUnitId: existing?.workUnitId,
    toolFactIds: [...new Set([...(existing?.toolFactIds ?? []), toolFactId].filter((item): item is string => Boolean(item)))],
    failureClassification: failure.classification ?? existing?.failureClassification,
    failureReason: failure.reason ?? existing?.failureReason,
    summary: failure.reason
      ? `${path} operation=${operation} status=${status} reason=${failure.reason}`
      : `${path} operation=${operation} status=${status}`,
    messageKey: 'review.changedFile',
    messageArgs: { path, operation, status, reason: failure.reason ?? existing?.failureReason ?? '' },
    auditRef: toolFactId ?? actionId,
  });
  if (toolFactId) auditRefs.push(toolFactId);
  if (actionId) auditRefs.push(actionId);
}

function readableReviewChangedFileLines(readableReview: ReadableReviewSummary, language: ReviewProjectionLanguage): string[] {
  return readableReview.changedFiles.slice(0, 64).map((item) => {
    const ids = [
      item.actionId ? `action=${item.actionId}` : '',
      item.workUnitId ? `workUnit=${item.workUnitId}` : '',
      item.toolFactIds?.length ? `toolFacts=${item.toolFactIds.join(',')}` : '',
    ].filter(Boolean).join(' ');
    return `- \`${item.path}\` operation=${item.operation} status=${item.status}${ids ? ` ${ids}` : ''}`;
  }).concat(readableReview.changedFiles.length > 64
    ? [language === 'en-US'
      ? `- ${readableReview.changedFiles.length - 64} additional file-level change(s) are not expanded.`
      : `- 另有 ${readableReview.changedFiles.length - 64} 个文件级变更未展开。`]
    : []);
}

function reviewDisplayPath(record?: Record<string, unknown> | null): string | undefined {
  if (!record) return undefined;
  return stringValue(record.path)
    ?? stringValue(record.targetPath)
    ?? stringValue(record.normalizedTargetPath)
    ?? stringValue(objectRecord(record.pathNormalization)?.normalizedTargetPath)
    ?? stringValue(record.absolutePath)
    ?? stringArrayValue(record.writeSet)[0]
    ?? stringArrayValue(record.deleteSet)[0];
}

function reviewFailureDetail(
  record?: Record<string, unknown> | null,
  output?: Record<string, unknown> | null
): { classification?: string; reason?: string } {
  const error = objectRecord(record?.error) ?? objectRecord(output?.error);
  const reason = stringValue(record?.message)
    ?? stringValue(record?.summary)
    ?? stringValue(error?.message)
    ?? stringValue(record?.reason)
    ?? stringValue(output?.message);
  const normalized = (reason ?? '').toLowerCase();
  const classification = normalized.includes('patch match did not occur')
    ? 'patch_stale_or_mismatched_evidence'
    : stringValue(record?.classification)
      ?? stringValue(output?.classification)
      ?? stringValue(record?.code)
      ?? stringValue(error?.code);
  return { classification, reason };
}

function reviewOperation(record?: Record<string, unknown> | null, toolName?: string): string {
  if (!record) return operationFromToolName(toolName);
  return stringValue(record.operation)
    ?? operationFromToolName(stringValue(record.toolName) ?? toolName)
    ?? stringValue(record.kind)
    ?? 'modify';
}

function operationFromToolName(toolName?: string): string {
  if (!toolName) return 'modify';
  if (toolName === 'fs.write') return 'write';
  if (toolName === 'fs.patch') return 'patch';
  if (toolName === 'fs.delete') return 'delete';
  if (toolName === 'fs.rename') return 'rename';
  if (toolName.startsWith('fs.')) return toolName.slice(3);
  return toolName;
}

function gitReviewSummaryLines(gitReview?: Record<string, unknown>, language: ReviewProjectionLanguage = 'zh-CN'): string[] {
  if (!gitReview) return [];
  if (gitReview.available === false) {
    const reason = stringValue(gitReview.reason) ?? 'Git review is unavailable.';
    return [language === 'en-US' ? `- Git diff unavailable: ${reason}` : `- Git diff 不可用：${reason}`];
  }
  const lines: string[] = [];
  const summary = stringValue(gitReview.summary);
  if (summary) lines.push(`- ${summary}`);
  const stats = objectRecord(gitReview.stats);
  const changedFiles = typeof stats?.changedFiles === 'number' ? stats.changedFiles : undefined;
  const stagedBytes = typeof stats?.stagedDiffBytes === 'number' ? stats.stagedDiffBytes : 0;
  const unstagedBytes = typeof stats?.unstagedDiffBytes === 'number' ? stats.unstagedDiffBytes : 0;
  if (changedFiles !== undefined) {
    lines.push(language === 'en-US'
      ? `- Files: ${changedFiles}; staged diff: ${stagedBytes} bytes; unstaged diff: ${unstagedBytes} bytes.`
      : `- 文件数：${changedFiles}；staged diff：${stagedBytes} bytes；unstaged diff：${unstagedBytes} bytes。`);
  }
  const files = Array.isArray(gitReview.files) ? gitReview.files : [];
  for (const item of files.slice(0, 12)) {
    const record = objectRecord(item);
    const path = stringValue(record?.path);
    if (path) lines.push(`- \`${path}\``);
  }
  if (files.length > 12) lines.push(language === 'en-US'
    ? `- ${files.length - 12} additional file(s) are not expanded in the summary.`
    : `- 另有 ${files.length - 12} 个文件未在摘要中展开。`);
  const diffBlocks = Array.isArray(gitReview.diffBlocks) ? gitReview.diffBlocks : [];
  if (diffBlocks.length) lines.push(language === 'en-US'
    ? '- Full diff is attached as collapsible Review evidence.'
    : '- 完整 diff 已附加为可折叠 Review 证据。');
  return lines;
}

function reviewGeneratedArtifactLines(reviewFacts?: Record<string, unknown>, language: ReviewProjectionLanguage = 'zh-CN'): string[] {
  const artifacts = Array.isArray(reviewFacts?.generatedArtifacts) ? reviewFacts.generatedArtifacts : [];
  return artifacts.slice(0, 24).map((item) => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? stringValue(record.absolutePath) ?? 'unknown';
    const operation = stringValue(record.operation) ?? stringValue(record.toolName) ?? 'write';
    const hash = stringValue(record.contentHash);
    return `- \`${path}\` operation=${operation}${hash ? ` contentHash=${hash}` : ''}`;
  }).concat(artifacts.length > 24
    ? [language === 'en-US'
      ? `- ${artifacts.length - 24} additional agentGenerated artifact(s) are not expanded.`
      : `- 另有 ${artifacts.length - 24} 个 agentGenerated 产物未展开。`]
    : []);
}

function reviewPathNormalizationLines(reviewFacts?: Record<string, unknown>, language: ReviewProjectionLanguage = 'zh-CN'): string[] {
  const diagnostics = Array.isArray(reviewFacts?.pathNormalizationDiagnostics)
    ? reviewFacts.pathNormalizationDiagnostics
    : [];
  return diagnostics.slice(0, 24).map((item) => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? 'unknown';
    const normalization = objectRecord(record.pathNormalization) ?? {};
    const original = stringValue(normalization.originalPath);
    const normalized = stringValue(normalization.normalizedTargetPath);
    const stripped = Array.isArray(normalization.strippedPathPrefixes)
      ? normalization.strippedPathPrefixes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const duplicate = record.duplicateRootPathDetected === true || normalization.duplicateRootPathDetected === true;
    return `- \`${path}\`${original ? ` original=${original}` : ''}${normalized ? ` normalized=${normalized}` : ''}${stripped.length ? ` stripped=${stripped.join(', ')}` : ''}${duplicate ? ' duplicateRootPathDetected=true' : ''}`;
  }).concat(diagnostics.length > 24
    ? [language === 'en-US'
      ? `- ${diagnostics.length - 24} additional path normalization diagnostic(s) are not expanded.`
      : `- 另有 ${diagnostics.length - 24} 条路径归一化诊断未展开。`]
    : []);
}

function reviewExpectationLines(plan: ReviewProjectionPlan, language: ReviewProjectionLanguage = 'zh-CN'): string[] {
  const lines: string[] = [];
  if (plan.expectedValidation.trim()) {
    lines.push(language === 'en-US'
      ? `- Validation expectation: ${plan.expectedValidation.trim()}`
      : `- 验证要求：${plan.expectedValidation.trim()}`);
  }
  if (plan.reviewGuide.trim()) {
    lines.push(language === 'en-US'
      ? `- Review guide: ${plan.reviewGuide.trim()}`
      : `- Review 指引：${plan.reviewGuide.trim()}`);
  }
  const expectations = Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [];
  for (const item of expectations) {
    const record = objectRecord(item);
    const text = stringValue(record?.description) ?? stringValue(record?.summary) ?? stringValue(record?.command);
    if (text?.trim()) lines.push(`- ${text.trim()}`);
  }
  return lines;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n...[truncated]` : value;
}
