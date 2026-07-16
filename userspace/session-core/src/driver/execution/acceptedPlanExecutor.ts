import type { ActionBundleDraft, ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type { ResourcePacket, ResourcePacketItem } from '../../context/types.js';
import type {
  AcceptedTaskPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../../accepted-plan/types.js';
import type { PlanContext } from '../proposal/planContextIndex.js';

export interface AcceptedPlanReadOnlyResourceCompletion {
  taskId: string;
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
  coveredTargets: string[];
}

export type NormalizedAcceptedPlanKernelBatch =
  | {
      ok: true;
      batch: {
        planId: string;
        contractId?: string;
        contractHash?: string;
        actionBundle: Record<string, unknown>;
        contentBlocks: unknown[];
      };
      reasons: [];
    }
  | {
      ok: false;
      reasons: string[];
    };

export interface AcceptedPlanExecutorPorts {
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined;
  kernelExecutionContractId(report?: Record<string, unknown>): string | undefined;
  kernelExecutionContractHash(report?: Record<string, unknown>): string | undefined;
}

export class AcceptedPlanExecutor {
  constructor(private readonly ports?: AcceptedPlanExecutorPorts) {}

  executionContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan?: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    planReviewReport: Record<string, unknown>;
  }): PlanContext {
    const ports = this.requirePorts();
    const payload = objectRecord(input.proposal.payload) ?? {};
    const actionBundle = ports.readActionBundle(input.proposal) ?? {
      id: input.acceptedPlan?.planId ?? input.proposal.proposalId,
      version: '1',
      goal: stringValue(input.acceptedPlan?.summary) ?? 'Accepted implementation plan batch',
      actions: [],
      validationExpectations: [],
      reviewExpectations: [],
    };
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      planId: input.acceptedPlan?.planId ?? stringValue(actionBundle.id) ?? input.proposal.proposalId,
      proposalId: input.proposal.proposalId,
      userPlan: stringValue(payload.userPlan) ?? stringValue(input.acceptedPlan?.summary) ?? 'Accepted implementation plan batch',
      actionBundle: actionBundle as unknown as Record<string, unknown>,
      contentBlocks: Array.isArray(payload.contentBlocks) ? payload.contentBlocks : [],
      expectedValidation: stringValue(payload.expectedValidation) ?? '',
      reviewGuide: stringValue(payload.reviewGuide) ?? '',
      planReviewReport: input.planReviewReport,
      taskPlan: input.acceptedPlan?.rawPlan,
    };
  }

  readOnlyReviewContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan: AcceptedTaskPlanContext;
    packet: ResourcePacket;
    completion: AcceptedPlanReadOnlyResourceCompletion;
  }): PlanContext {
    const targets = input.completion.coveredTargets.join(', ');
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      planId: input.acceptedPlan.planId,
      proposalId: `${input.acceptedPlan.planId}:read-only-validation`,
      userPlan: targets
        ? `Read-only validation evidence resolved for accepted targets: ${targets}.`
        : 'Read-only validation evidence resolved for the accepted plan.',
      actionBundle: {
        version: '1',
        id: `${input.acceptedPlan.planId}:read-only-validation`,
        goal: 'Read-only validation evidence satisfied the accepted task.',
        actions: [],
        validationExpectations: [{
          id: 'read-only-resource-validation',
          description: `ResourcePacket ${input.packet.id} resolved the read-only evidence required by the accepted task.`,
        }],
        reviewExpectations: [{
          id: 'review-read-only-validation',
          description: 'Review the resolved resource evidence and accepted-plan checkpoint.',
        }],
      },
      contentBlocks: [],
      expectedValidation: `ResourcePacket ${input.packet.id} resolved the read-only evidence for the accepted task.`,
      reviewGuide: 'Review the resolved ResourcePacket evidence and accepted-plan checkpoint.',
      taskPlan: input.acceptedPlan.rawPlan,
    };
  }

  modelTaskOutcomeReviewContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan: AcceptedTaskPlanContext;
    taskId: string;
    summary: string;
    evidenceRefs: string[];
  }): PlanContext {
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      planId: input.acceptedPlan.planId,
      proposalId: `${input.acceptedPlan.planId}:task-outcome`,
      userPlan: input.acceptedPlan.summary ?? input.acceptedPlan.title ?? 'Accepted task plan',
      actionBundle: {
        version: '1',
        id: `${input.acceptedPlan.planId}:task-outcome`,
        goal: input.summary,
        actions: [],
        validationExpectations: [{
          id: `${input.taskId}:already-satisfied`,
          description: input.summary,
          evidenceRefs: input.evidenceRefs,
          source: 'sessionTaskOutcome',
        }],
        reviewExpectations: [{
          id: `${input.taskId}:review-already-satisfied`,
          description: 'Review the task-scoped evidence showing that no additional workspace mutation was required.',
        }],
      },
      contentBlocks: [],
      expectedValidation: input.summary,
      reviewGuide: 'Distinguish Kernel execution facts from Session modelJudgedSufficient task outcomes.',
      taskPlan: input.acceptedPlan.rawPlan,
      planHash: input.acceptedPlan.planHash,
      authorizationContractId: input.acceptedPlan.authorizationContractId,
      authorizationContractHash: input.acceptedPlan.authorizationContractHash,
      executionRoot: input.acceptedPlan.executionRoot,
    };
  }

  normalizeKernelBatch(input: {
    planId: string;
    plan: PlanContext;
    acceptedPlan?: AcceptedTaskPlanContext;
    resourcePackets?: ResourcePacket[];
  }): NormalizedAcceptedPlanKernelBatch {
    const ports = this.requirePorts();
    const actionBundle = objectRecord(input.plan.actionBundle);
    const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
    const reasons: string[] = [];
    if (!actionBundle || !actions.length) {
      reasons.push('actionBundle.actions must be a non-empty array.');
    }
    const contentBlocks = input.plan.contentBlocks.map((value) => {
      const block = objectRecord(value);
      if (!block) {
        reasons.push(`contentBlocks[] is not an object.`);
        return value;
      }
      const blockId = stringValue(block.blockId);
      if (!blockId || !stringValue(block.targetPath) || !Array.isArray(block.contentLines)) {
        reasons.push('contentBlocks[] requires blockId, targetPath, and contentLines.');
      } else if (block.contentLines.some((line) => typeof line !== 'string')) {
        reasons.push(`contentBlocks[] ${blockId} contains a non-string content line.`);
      }
      return { ...block };
    });

    const normalizedActions = actions.map((value) => {
      const action = objectRecord(value);
      if (!action) {
        reasons.push(`actionBundle.actions[] is not an object.`);
        return value;
      }
      const actionId = stringValue(action.actionId);
      const toolId = stringValue(action.toolId);
      if (!actionId || !toolId || !objectRecord(action.args)) {
        reasons.push(`actionBundle.actions[] requires actionId, toolId, and typed args.`);
      }
      return { ...action };
    });

    if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
    return {
      ok: true,
      reasons: [],
      batch: {
        planId: input.planId,
        contractId: ports.kernelExecutionContractId(input.plan.planReviewReport),
        contractHash: ports.kernelExecutionContractHash(input.plan.planReviewReport),
        actionBundle: { ...(actionBundle ?? {}), actions: normalizedActions },
        contentBlocks,
      },
    };
  }

  currentTaskIsReadOnlyResourceValidation(
    accepted: AcceptedTaskPlanContext,
    cursor: TaskExecutionCursor | undefined,
    current: CurrentTaskContext | undefined
  ): boolean {
    if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return false;
    const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
    if (!task || accepted.completedTaskIds.includes(task.taskId)) return false;
    const toolIds = current.toolIds.length
      ? current.toolIds
      : task.toolId
        ? [task.toolId]
        : [];
    return toolIds.length > 0 && toolIds.every(acceptedPlanToolIsReadOnlyValidation);
  }

  readOnlyResourceCompletion(
    accepted: AcceptedTaskPlanContext,
    cursor: TaskExecutionCursor | undefined,
    current: CurrentTaskContext | undefined,
    packet: ResourcePacket
  ): ({ ok: true } & AcceptedPlanReadOnlyResourceCompletion) | { ok: false } {
    if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return { ok: false };
    const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
    if (!task || accepted.completedTaskIds.includes(task.taskId)) return { ok: false };
    const toolIds = current.toolIds.length
      ? current.toolIds
      : task.toolId
        ? [task.toolId]
        : [];
    if (!toolIds.length || !toolIds.every(acceptedPlanToolIsReadOnlyValidation)) return { ok: false };
    const targets = current.targets.length ? current.targets : task.targets;
    const normalizedTargets = uniqueStrings(targets.map(normalizeReadOnlyResourceScope).filter(Boolean));
    const coveredTargets = acceptedPlanResourceCoveredTargets(packet, normalizedTargets);
    if (!normalizedTargets.length || coveredTargets.length < normalizedTargets.length) {
      return { ok: false };
    }
    const completedTaskIds = [...new Set([...accepted.completedTaskIds, task.taskId])];
    const completed = new Set(completedTaskIds);
    return {
      ok: true,
      taskId: task.taskId,
      newlyCompletedTaskIds: [task.taskId],
      completedTaskIds,
      remainingTaskIds: accepted.tasks.map((item) => item.taskId).filter((taskId) => !completed.has(taskId)),
      coveredTargets,
    };
  }

  resourceRequestFromReadOnlyActionBundle(
    actionBundle: ActionBundleDraft,
    current: CurrentTaskContext | undefined,
    requestId: string
  ): ResourceRequestDraft | undefined {
    const items: ResourceRequestDraft['items'] = [];
    const actions = (actionBundle.actions ?? [])
      .map((action) => objectRecord(action))
      .filter((action): action is Record<string, unknown> => Boolean(action));
    if (!actions.length) return undefined;

    for (const action of actions) {
      const toolId = actionToolId(action);
      if (!acceptedPlanToolIsReadOnlyValidation(toolId)) return undefined;
      const kind = readOnlyResourceRequestKind(action);
      if (!kind) return undefined;
      const args = objectRecord(action.args) ?? {};
      if (kind === 'search') {
        const query = stringValue(args.query);
        if (!query) return undefined;
        items.push({
          id: `${requestId}-item-${items.length + 1}`,
          kind: 'search',
          path: readOnlyResourceRequestPaths(action, current, kind)[0] ?? '.',
          query,
          reason: 'Resolve read-only search evidence for the current accepted task.',
        });
        continue;
      }
      const paths = readOnlyResourceRequestPaths(action, current, kind);
      if (!paths.length) return undefined;
      for (const path of paths) {
        items.push({
          id: `${requestId}-item-${items.length + 1}`,
          kind,
          path,
          reason: 'Resolve read-only evidence for the current accepted task.',
        });
      }
    }

    if (!items.length) return undefined;
    return {
      version: '1',
      id: requestId,
      reason: 'Accepted-plan read-only actionBundle normalized to ResourceResolve by Session.',
      items,
    };
  }

  private requirePorts(): AcceptedPlanExecutorPorts {
    if (!this.ports) {
      throw new Error('AcceptedPlanExecutor requires ports for execution context and kernel batch normalization.');
    }
    return this.ports;
  }

}

function acceptedPlanToolIsReadOnlyValidation(toolId: string): boolean {
  return [
    'fs.read',
    'fs.list',
    'fs.glob',
    'fs.diff',
    'code.grep',
    'document.read',
    'git.status',
    'git.diff',
  ].includes(toolId);
}

function readOnlyResourceRequestKind(
  action: Record<string, unknown>
): ResourceRequestDraft['items'][number]['kind'] | undefined {
  const toolId = stringValue(action.toolId);
  if (toolId === 'fs.list' || toolId === 'fs.glob') return 'directory';
  if (toolId === 'fs.read' || toolId === 'document.read' || toolId === 'fs.diff') return 'file';
  if (toolId === 'code.grep') return 'search';
  return undefined;
}

function readOnlyResourceRequestPaths(
  action: Record<string, unknown>,
  current: CurrentTaskContext | undefined,
  kind: ResourceRequestDraft['items'][number]['kind']
): string[] {
  const args = objectRecord(action.args) ?? {};
  const explicit = [rawStringValue(args.path)]
    .filter((path): path is string => path !== undefined);
  const source = explicit.length
    ? explicit
    : kind === 'directory'
      ? ['.']
      : current?.targets ?? [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const path of source) {
    const normalized = normalizeResourceRequestPath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function acceptedPlanResourceCoveredTargets(packet: ResourcePacket, targets: string[]): string[] {
  const normalizedTargets = uniqueStrings(targets.map(normalizeReadOnlyResourceScope).filter(Boolean));
  if (!normalizedTargets.length) return [];
  const resolvedItems = (packet.items ?? [])
    .filter((item) => item.status === 'resolved' || item.status === 'provided');
  return normalizedTargets.filter((target) =>
    resolvedItems.some((item) => resourcePacketItemMatchesTargetScope(item, target))
  );
}

function resourcePacketItemMatchesTargetScope(item: ResourcePacketItem, target: string): boolean {
  const normalizedTarget = normalizeReadOnlyResourceScope(target);
  if (!normalizedTarget) return false;
  const itemRecord = objectRecord(item);
  if (normalizedTarget === '.' && item.contentKind === 'directoryTree') return true;
  if (itemRecord && resourceNodeListContainsPath(itemRecord.nodes, normalizedTarget)) return true;
  const candidates = [
    item.path,
    item.absolutePath,
    item.manifestEntryId,
  ]
    .map((value) => typeof value === 'string' ? normalizePlanScope(value) : '')
    .filter(Boolean);
  return candidates.some((candidate) =>
    candidate === normalizedTarget ||
    candidate.endsWith(`/${normalizedTarget}`) ||
    normalizedTarget.endsWith(`/${candidate}`) ||
    planScopeCovers(normalizedTarget, candidate) ||
    planScopeCovers(candidate, normalizedTarget)
  );
}

function resourceNodeListContainsPath(value: unknown, targetPath: string): boolean {
  if (!Array.isArray(value)) return false;
  const target = normalizeReadOnlyResourceScope(targetPath);
  for (const item of value) {
    const node = objectRecord(item);
    if (!node) continue;
    const path = stringValue(node.path) ?? stringValue(node.name);
    const normalizedPath = path ? normalizeReadOnlyResourceScope(path) : '';
    if (
      normalizedPath &&
      (normalizedPath === target ||
        planScopeCovers(normalizedPath, target) ||
        planScopeCovers(target, normalizedPath))
    ) {
      return true;
    }
    if (resourceNodeListContainsPath(node.children, target)) return true;
  }
  return false;
}

function actionToolId(action: { toolId?: unknown }): string {
  return stringValue(action.toolId) ?? '';
}

function planScopeCovers(accepted: string, candidate: string): boolean {
  if (!accepted || !candidate) return false;
  const acceptedNormalized = normalizeReadOnlyResourceScope(accepted);
  const candidateNormalized = normalizeReadOnlyResourceScope(candidate);
  if (acceptedNormalized === candidateNormalized) return true;
  if (acceptedNormalized === '.' || candidateNormalized === '.') return false;
  if (isAbsolutePath(acceptedNormalized) || isAbsolutePath(candidateNormalized)) return false;
  const acceptedDir = acceptedNormalized.endsWith('/') ? acceptedNormalized : `${acceptedNormalized}/`;
  return candidateNormalized.startsWith(acceptedDir);
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizeReadOnlyResourceScope(value: string): string {
  const normalized = normalizePlanScope(value);
  const identity = normalized.replace(/\/+$/, '');
  if (!identity || normalized === '/' || identity === '.') return '.';
  return identity;
}

function normalizeResourceRequestPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
  if (!normalized || normalized === '/' || normalized === './' || normalized === '.') return '.';
  return normalized;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
