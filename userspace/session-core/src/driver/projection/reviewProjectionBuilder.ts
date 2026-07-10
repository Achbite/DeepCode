import type { AgentEvent } from '@deepcode/protocol';
import type {
  ReadableProjectionItem,
  ReadableProjectionSection,
} from './structuredProjectionReadModels.js';

export interface ReviewProjectionPlan {
  userPlan: string;
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
  titleKey: 'session.projection.review.title';
  status: 'waitingUserReview';
  summaryKey: 'review.summary.waitingUserReview' | 'review.summary.needsAttention';
  sections: ReadableProjectionSection[];
  changedFiles: ReadableReviewChangedFile[];
  factCounts: {
    workUnitsCompleted: number;
    workUnitsFailed: number;
    workUnitsBlocked: number;
    toolResults: number;
  };
  operationCounts: Record<string, number>;
  auditRefs: string[];
  sourceRefs: Record<string, string>;
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
    events?: AgentEvent[];
    ts: string;
    id: string;
  }): AgentEvent {
    const ports = this.requirePorts();
    const facts = [
      ...ports.reviewFactLines(input.kernelEvents),
      ...ports.staticSyntaxReviewFactLines(input.kernelEvents),
    ];
    const reviewFacts = ports.findReviewFacts(input.kernelEvents);
    const rawGitReview = reviewFacts ? objectRecord(reviewFacts.gitReview) : undefined;
    const executionRoot = input.plan.executionRoot
      ?? latestPlanExecutionRootFromEvents(input.events ?? [], input.plan.planId);
    const gitReview = gitReviewForProjection(rawGitReview, executionRoot);
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
    const summaryKey = failed || blocked ? 'review.summary.needsAttention' : 'review.summary.waitingUserReview';
    const factCounts = {
      workUnitsCompleted: completed,
      workUnitsFailed: failed,
      workUnitsBlocked: blocked,
      toolResults,
    };
    const readableReviewBase = this.readableSummary(input.kernelEvents, reviewFacts);
    const acceptedPlanForReview = input.plan.implementationPlan
      ? ports.acceptedPlanContext(input.plan)
      : undefined;
    // Review task status is a checkpoint projection; prefer the latest ledger facts over the stale accepted-plan snapshot.
    const checkpointTaskLedger = latestAcceptedPlanTaskLedgerFromEvents<TaskLedger>(
      input.events ?? [],
      input.plan.runId,
      input.plan.planId
    );
    const reviewTaskLedger = checkpointTaskLedger ?? (acceptedPlanForReview
      ? ports.acceptedPlanTaskLedger(ports.acceptedPlanAfterBatch(
        acceptedPlanForReview,
        ports.acceptedPlanBatchCompletedTaskIds(acceptedPlanForReview, input.plan, input.kernelEvents)
      ))
      : undefined);
    const reviewFactsContextInput: ReviewFactsContextInput<TaskLedger> = {
      planId: input.plan.planId,
      runId: input.plan.runId,
      changedFileCount: readableReviewBase.changedFiles.length,
      auditRefCount: readableReviewBase.auditRefs.length,
    };
    if (reviewTaskLedger) reviewFactsContextInput.taskLedger = reviewTaskLedger;
    const reviewFactsContext = ports.buildReviewFactsContext(reviewFactsContextInput);
    const readableReview: ReadableReviewSummary = {
      ...readableReviewBase,
      titleKey: 'session.projection.review.title',
      status: 'waitingUserReview',
      summaryKey,
      factCounts,
      sourceRefs: {
        runId: input.plan.runId,
        planId: input.plan.planId,
        reviewId: `${input.plan.runId}:${input.plan.planId}`,
      },
      sections: this.reviewSections({
        plan: input.plan,
        readableReview: readableReviewBase,
        completed,
        failed,
        blocked,
        toolResults,
        continuations,
        gitReview,
        reviewFacts,
      }),
    };
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'review_summary',
      payload: {
        titleKey: 'session.projection.review.title',
        summaryKey,
        messageKey: summaryKey,
        messageArgs: {
          completed: String(completed),
          failed: String(failed),
          blocked: String(blocked),
          toolResults: String(toolResults),
        },
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
          rawGitReview,
          reviewFactsContext,
        },
        facts,
        factCounts,
        channel: 'review',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  reviewSections(input: {
    plan: ReviewProjectionPlan;
    readableReview: ReadableReviewSummary;
    completed: number;
    failed: number;
    blocked: number;
    toolResults: number;
    continuations: unknown[];
    gitReview?: Record<string, unknown>;
    reviewFacts?: Record<string, unknown>;
  }): ReadableProjectionSection[] {
    const {
      plan,
      readableReview,
      completed,
      failed,
      blocked,
      toolResults,
      continuations,
      gitReview,
      reviewFacts,
    } = input;
    return [
      {
        sectionId: 'executionResult',
        titleKey: 'session.projection.review.section.executionResult',
        items: [
          projectionItem('work-units-completed', 'fact', {
            messageKey: 'session.projection.review.count.workUnitsCompleted',
            messageArgs: { count: String(completed) },
          }),
          projectionItem('work-units-failed', 'fact', {
            messageKey: 'session.projection.review.count.workUnitsFailed',
            messageArgs: { count: String(failed) },
          }),
          projectionItem('work-units-blocked', 'fact', {
            messageKey: 'session.projection.review.count.workUnitsBlocked',
            messageArgs: { count: String(blocked) },
          }),
          projectionItem('tool-facts', 'fact', {
            messageKey: 'session.projection.review.count.toolFacts',
            messageArgs: { count: String(toolResults) },
          }),
        ],
      },
      {
        sectionId: 'changedFiles',
        titleKey: 'session.projection.review.section.changedFiles',
        emptyMessageKey: 'session.projection.review.empty.changedFiles',
        items: readableReview.changedFiles.slice(0, 64).map((item, index) => projectionItem(`changed-file-${index + 1}`, 'target', {
          messageKey: item.failureReason || item.failureClassification
            ? 'session.projection.review.changedFileWithReason'
            : 'review.changedFile',
          messageArgs: {
            path: item.path,
            operation: item.operation,
            status: item.status,
            reason: item.failureReason ?? item.failureClassification ?? '',
          },
          status: item.status,
          targetRefs: [item.path],
          auditRefs: [item.auditRef, item.workUnitId, ...(item.toolFactIds ?? [])].filter((value): value is string => Boolean(value)),
          metadata: item as unknown as Record<string, unknown>,
        })),
      },
      {
        sectionId: 'generatedArtifacts',
        titleKey: 'session.projection.review.section.generatedArtifacts',
        emptyMessageKey: 'session.projection.review.empty.generatedArtifacts',
        items: reviewGeneratedArtifactItems(reviewFacts),
      },
      {
        sectionId: 'pathDiagnostics',
        titleKey: 'session.projection.review.section.pathDiagnostics',
        emptyMessageKey: 'session.projection.review.empty.pathDiagnostics',
        items: reviewPathNormalizationItems(reviewFacts),
      },
      {
        sectionId: 'gitChanges',
        titleKey: 'session.projection.review.section.gitChanges',
        emptyMessageKey: 'session.projection.review.empty.gitChanges',
        items: gitReviewItems(gitReview),
      },
      {
        sectionId: 'auditDetails',
        titleKey: 'session.projection.review.section.auditDetails',
        emptyMessageKey: 'session.projection.review.empty.auditDetails',
        items: [
          projectionItem('developer-details', 'fact', {
            messageKey: readableReview.developerDetailsAvailable
              ? 'session.projection.review.audit.available'
              : 'session.projection.review.audit.unavailable',
          }),
          ...readableReview.auditRefs.slice(0, 12).map((ref, index) => projectionItem(`audit-ref-${index + 1}`, 'fact', {
            messageKey: 'session.projection.review.audit.ref',
            messageArgs: { ref },
            auditRefs: [ref],
          })),
        ],
      },
      {
        sectionId: 'originalPlan',
        titleKey: 'session.projection.review.section.originalPlan',
        items: [projectionItem('original-plan', 'text', { text: clip(plan.userPlan, 1200) })],
      },
      {
        sectionId: 'validation',
        titleKey: 'session.projection.review.section.validation',
        emptyMessageKey: 'session.projection.review.empty.validation',
        items: reviewExpectationItems(plan),
      },
      {
        sectionId: 'nextDecision',
        titleKey: 'session.projection.review.section.nextDecision',
        items: [
          projectionItem('decision-hint', 'decision', {
            messageKey: failed || blocked
              ? 'session.projection.review.next.failed'
              : 'session.projection.review.next.success',
          }),
          projectionItem('continuation-hint', 'decision', {
            messageKey: continuations.length
              ? 'session.projection.review.next.continuation'
              : 'session.projection.review.next.noContinuation',
            messageArgs: { count: String(continuations.length) },
          }),
        ],
      },
    ];
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
      titleKey: 'session.projection.review.title',
      status: 'waitingUserReview',
      summaryKey: 'review.summary.waitingUserReview',
      sections: [],
      changedFiles: files,
      factCounts: {
        workUnitsCompleted: 0,
        workUnitsFailed: 0,
        workUnitsBlocked: 0,
        toolResults: 0,
      },
      operationCounts,
      auditRefs: [...new Set(auditRefs.filter((item) => item.trim().length > 0))],
      sourceRefs: {},
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

function latestAcceptedPlanTaskLedgerFromEvents<TaskLedger>(
  events: AgentEvent[],
  planRunId?: string,
  planId?: string
): TaskLedger | undefined {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'workflow_stage') continue;
    const payload = objectRecord(event.payload) ?? {};
    if (stringValue(payload.stage) !== 'accepted_plan.batch_checkpoint') continue;
    if (!sameAcceptedPlan(payload, planRunId, planId)) continue;
    const ledger = objectRecord(payload.taskLedger);
    if (ledger) return ledger as TaskLedger;
  }
  return undefined;
}

function sameAcceptedPlan(
  payload: Record<string, unknown>,
  planRunId?: string,
  planId?: string
): boolean {
  const payloadRunId = stringValue(payload.runId);
  const payloadPlanId = stringValue(payload.planId) ?? stringValue(payload.sourcePlanId);
  if (planId && payloadPlanId && payloadPlanId !== planId) return false;
  if (planRunId && payloadRunId && payloadRunId !== planRunId) {
    return Boolean(planId && payloadPlanId === planId);
  }
  return true;
}

function latestPlanExecutionRootFromEvents(events: AgentEvent[], planId?: string): unknown {
  for (const event of [...events].reverse()) {
    if (event.kind !== 'plan_card') continue;
    const payload = objectRecord(event.payload) ?? {};
    const payloadPlanId = stringValue(payload.planId) ?? stringValue(payload.sourcePlanId);
    if (planId && payloadPlanId && payloadPlanId !== planId) continue;
    const executionRoot = objectRecord(payload.executionRoot);
    if (executionRoot) return executionRoot;
  }
  return undefined;
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

function gitReviewForProjection(
  gitReview: Record<string, unknown> | undefined,
  executionRoot: unknown
): Record<string, unknown> | undefined {
  if (!gitReview || gitReview.available === false) return gitReview;
  const executionRootPath = projectionPath(executionRootPathValue(executionRoot));
  const root = projectionPath(stringValue(gitReview.root));
  const repoRoot = projectionPath(stringValue(gitReview.repoRoot));
  const reviewRoots = [root, repoRoot].filter((value): value is string => Boolean(value));
  if (!executionRootPath || reviewRoots.length === 0) return gitReview;
  if (reviewRoots.some((candidate) => sameProjectionRoot(candidate, executionRootPath))) return gitReview;

  return {
    available: false,
    reason: `git review root ${reviewRoots[0]} does not match execution root ${executionRootPath}`,
    root,
    repoRoot,
    executionRoot: executionRootPath,
    projectionFilter: 'executionRootMismatch',
  };
}

function executionRootPathValue(executionRoot: unknown): string | undefined {
  const record = objectRecord(executionRoot);
  const attachment = objectRecord(record?.attachment);
  return stringValue(record?.ref)
    ?? stringValue(record?.absolutePath)
    ?? stringValue(record?.path)
    ?? stringValue(attachment?.absolutePath)
    ?? stringValue(attachment?.path);
}

function projectionPath(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/\\/g, '/').replace(/\/+/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function sameProjectionRoot(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function gitReviewItems(gitReview?: Record<string, unknown>): ReadableProjectionItem[] {
  if (!gitReview) return [];
  if (gitReview.available === false) {
    const reason = stringValue(gitReview.reason) ?? '';
    return [projectionItem('git-unavailable', 'git', {
      messageKey: 'session.projection.review.git.unavailable',
      messageArgs: { reason },
      metadata: gitReview,
    })];
  }
  const items: ReadableProjectionItem[] = [];
  const summary = stringValue(gitReview.summary);
  if (summary) items.push(projectionItem('git-summary', 'git', { text: summary, metadata: gitReview }));
  const stats = objectRecord(gitReview.stats);
  const changedFiles = typeof stats?.changedFiles === 'number' ? stats.changedFiles : undefined;
  const stagedBytes = typeof stats?.stagedDiffBytes === 'number' ? stats.stagedDiffBytes : 0;
  const unstagedBytes = typeof stats?.unstagedDiffBytes === 'number' ? stats.unstagedDiffBytes : 0;
  if (changedFiles !== undefined) {
    items.push(projectionItem('git-stats', 'git', {
      messageKey: 'session.projection.review.git.stats',
      messageArgs: {
        changedFiles: String(changedFiles),
        stagedBytes: String(stagedBytes),
        unstagedBytes: String(unstagedBytes),
      },
      metadata: stats,
    }));
  }
  const files = Array.isArray(gitReview.files) ? gitReview.files : [];
  for (const item of files.slice(0, 12)) {
    const record = objectRecord(item);
    const path = stringValue(record?.path);
    if (path) items.push(projectionItem(`git-file-${path}`, 'target', { text: path, targetRefs: [path], metadata: record }));
  }
  if (files.length > 12) items.push(projectionItem('git-files-truncated', 'git', {
    messageKey: 'session.projection.review.git.truncated',
    messageArgs: { count: String(files.length - 12) },
  }));
  const diffBlocks = Array.isArray(gitReview.diffBlocks) ? gitReview.diffBlocks : [];
  if (diffBlocks.length) items.push(projectionItem('git-diff-attached', 'git', {
    messageKey: 'session.projection.review.git.diffAttached',
  }));
  return items;
}

function reviewGeneratedArtifactItems(reviewFacts?: Record<string, unknown>): ReadableProjectionItem[] {
  const artifacts = Array.isArray(reviewFacts?.generatedArtifacts) ? reviewFacts.generatedArtifacts : [];
  const items = artifacts.slice(0, 24).flatMap((item, index): ReadableProjectionItem[] => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? stringValue(record.absolutePath) ?? 'unknown';
    const operation = stringValue(record.operation) ?? stringValue(record.toolName) ?? 'write';
    const hash = stringValue(record.contentHash);
    return [projectionItem(`artifact-${index + 1}`, 'artifact', {
      messageKey: 'session.projection.review.generatedArtifact',
      messageArgs: { path, operation, hash: hash ?? '' },
      targetRefs: [path],
      metadata: record,
    })];
  });
  if (artifacts.length > 24) items.push(projectionItem('artifacts-truncated', 'artifact', {
    messageKey: 'session.projection.review.generatedArtifacts.truncated',
    messageArgs: { count: String(artifacts.length - 24) },
  }));
  return items;
}

function reviewPathNormalizationItems(reviewFacts?: Record<string, unknown>): ReadableProjectionItem[] {
  const diagnostics = Array.isArray(reviewFacts?.pathNormalizationDiagnostics)
    ? reviewFacts.pathNormalizationDiagnostics
    : [];
  const items = diagnostics.slice(0, 24).flatMap((item, index): ReadableProjectionItem[] => {
    const record = objectRecord(item) ?? {};
    const path = stringValue(record.path) ?? 'unknown';
    const normalization = objectRecord(record.pathNormalization) ?? {};
    const original = stringValue(normalization.originalPath);
    const normalized = stringValue(normalization.normalizedTargetPath);
    const stripped = Array.isArray(normalization.strippedPathPrefixes)
      ? normalization.strippedPathPrefixes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      : [];
    const duplicate = record.duplicateRootPathDetected === true || normalization.duplicateRootPathDetected === true;
    return [projectionItem(`path-diagnostic-${index + 1}`, 'diagnostic', {
      messageKey: 'session.projection.review.pathDiagnostic',
      messageArgs: {
        path,
        original: original ?? '',
        normalized: normalized ?? '',
        stripped: stripped.join(', '),
        duplicate: duplicate ? 'true' : 'false',
      },
      targetRefs: [path],
      metadata: record,
    })];
  });
  if (diagnostics.length > 24) items.push(projectionItem('path-diagnostics-truncated', 'diagnostic', {
    messageKey: 'session.projection.review.pathDiagnostics.truncated',
    messageArgs: { count: String(diagnostics.length - 24) },
  }));
  return items;
}

function reviewExpectationItems(plan: ReviewProjectionPlan): ReadableProjectionItem[] {
  const items: ReadableProjectionItem[] = [];
  const expectations = Array.isArray(plan.actionBundle.reviewExpectations) ? plan.actionBundle.reviewExpectations : [];
  for (const [index, item] of expectations.entries()) {
    const record = objectRecord(item);
    const text = stringValue(record?.description) ?? stringValue(record?.summary) ?? stringValue(record?.command);
    if (text?.trim()) items.push(projectionItem(`review-expectation-${index + 1}`, 'fact', { text: text.trim(), metadata: record }));
  }
  return items;
}

function projectionItem(
  itemId: string,
  kind: ReadableProjectionItem['kind'],
  value: Omit<ReadableProjectionItem, 'itemId' | 'kind'>
): ReadableProjectionItem {
  return { itemId, kind, ...value };
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
