import type { ActionBundleDraft, ResourceRequestDraft } from '../../agent-plan/types.js';
import type { ResourcePacket, ResourcePacketItem } from '../../context/types.js';
import type {
  AcceptedImplementationPlanContext,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../../accepted-plan/types.js';

export interface AcceptedPlanReadOnlyResourceCompletion {
  taskId: string;
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
  coveredTargets: string[];
}

export class AcceptedPlanExecutor {
  currentTaskIsReadOnlyResourceValidation(
    accepted: AcceptedImplementationPlanContext,
    cursor: TaskExecutionCursor | undefined,
    current: CurrentTaskContext | undefined
  ): boolean {
    if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return false;
    const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
    if (!task || accepted.completedTaskIds.includes(task.taskId)) return false;
    const capabilities = current.capabilities.length
      ? current.capabilities
      : task.capability
        ? [task.capability]
        : [];
    return capabilities.length > 0 && capabilities.every(acceptedPlanCapabilityIsReadOnlyValidation);
  }

  readOnlyResourceCompletion(
    accepted: AcceptedImplementationPlanContext,
    cursor: TaskExecutionCursor | undefined,
    current: CurrentTaskContext | undefined,
    packet: ResourcePacket
  ): ({ ok: true } & AcceptedPlanReadOnlyResourceCompletion) | { ok: false } {
    if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return { ok: false };
    const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
    if (!task || accepted.completedTaskIds.includes(task.taskId)) return { ok: false };
    const capabilities = current.capabilities.length
      ? current.capabilities
      : task.capability
        ? [task.capability]
        : [];
    if (!capabilities.length || !capabilities.every(acceptedPlanCapabilityIsReadOnlyValidation)) return { ok: false };
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
      const capability = actionEffectiveCapability(action);
      if (!acceptedPlanCapabilityIsReadOnlyValidation(capability)) return undefined;
      const kind = readOnlyResourceRequestKind(action, capability);
      if (!kind) return undefined;
      const args = objectRecord(action.args) ?? {};
      if (kind === 'search') {
        const query = stringValue(args.query) ?? stringValue(args.pattern) ?? stringValue(args.text);
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
}

function acceptedPlanCapabilityIsReadOnlyValidation(capability: string): boolean {
  return [
    'fs.read',
    'fs.list',
    'code.search',
    'git.read',
  ].includes(capability);
}

function readOnlyResourceRequestKind(
  action: Record<string, unknown>,
  capability: string
): ResourceRequestDraft['items'][number]['kind'] | undefined {
  const toolId = stringValue(action.toolId);
  if (toolId === 'fs.list' || capability === 'fs.list') return 'directory';
  if (toolId === 'fs.read' || capability === 'fs.read') return 'file';
  if (toolId === 'code.search' || capability === 'code.search') return 'search';
  return undefined;
}

function readOnlyResourceRequestPaths(
  action: Record<string, unknown>,
  current: CurrentTaskContext | undefined,
  kind: ResourceRequestDraft['items'][number]['kind']
): string[] {
  const args = objectRecord(action.args) ?? {};
  const explicit = [
    rawStringValue(args.path),
    rawStringValue(args.targetPath),
    rawStringValue(args.resourceRef),
    rawStringValue(action.targetPath),
    fileTargetRefPath(action.targetRef),
    ...stringArrayValue(action.resourceScope),
  ].filter((path): path is string => path !== undefined);
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

function actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string {
  const capability = stringValue(action.capability);
  if (capability) return capability;
  const toolId = stringValue(action.toolId);
  if (!toolId) return '';
  if (toolId === 'git.status' || toolId === 'git.diff') return 'git.read';
  if (toolId === 'git.push') return 'git.push';
  if (toolId.startsWith('git.')) return 'git.write';
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
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

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
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
