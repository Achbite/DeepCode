export interface ActionBatchFailureDetail {
  status: 'failed' | 'blocked';
  workUnitId?: string;
  actionId?: string;
  message?: string;
  code?: string;
  kernelCode?: string;
  classification?: string;
  writeSet: string[];
}

export class ActionBatchFailureIndex {
  details(kernelEvents: unknown[], batch?: Record<string, unknown>): ActionBatchFailureDetail[] {
    const workUnits = new Map<string, { actionId?: string; writeSet: string[] }>();
    const actionIndex = actionBatchActionIndex(batch);
    const details: ActionBatchFailureDetail[] = [];
    for (const event of kernelEvents) {
      const record = objectRecord(event);
      if (!record) continue;
      if (record.kind === 'work_unit.queued' || record.kind === 'work_unit.started') {
        const workUnit = objectRecord(record.workUnit);
        const id = stringValue(workUnit?.id) ?? stringValue(record.workUnitId);
        if (!id) continue;
        const prior = workUnits.get(id);
        const workUnitWriteSet = stringArrayValue(workUnit?.writeSet);
        workUnits.set(id, {
          actionId: stringValue(workUnit?.actionId) ?? stringValue(record.actionId) ?? prior?.actionId,
          writeSet: workUnitWriteSet.length ? workUnitWriteSet : prior?.writeSet ?? [],
        });
        continue;
      }
      if (record.kind !== 'work_unit.failed' && record.kind !== 'work_unit.blocked') continue;
      const status = record.kind === 'work_unit.failed' ? 'failed' : 'blocked';
      const workUnitId = stringValue(record.workUnitId) ?? stringValue(objectRecord(record.workUnit)?.id);
      const indexed = workUnitId ? workUnits.get(workUnitId) : undefined;
      const error = objectRecord(record.error);
      const message = stringValue(record.message) ?? stringValue(error?.message) ?? stringValue(record.reason);
      const actionId = stringValue(record.actionId) ?? indexed?.actionId;
      const eventWriteSet = stringArrayValue(record.writeSet);
      const writeSet = eventWriteSet.length ? eventWriteSet : indexed?.writeSet ?? [];
      const action = (actionId ? actionIndex.get(actionId) : undefined)
        ?? actionBatchDeleteActionForWriteSet(actionIndex, writeSet);
      const kernelCode = stringValue(record.code) ?? stringValue(error?.code);
      const classification = actionBatchFailureClassification(action, message);
      details.push({
        status,
        workUnitId,
        actionId,
        message,
        code: classification ?? kernelCode,
        kernelCode,
        classification,
        writeSet,
      });
    }
    return details;
  }

  summary(detail: ActionBatchFailureDetail): string {
    const parts = [
      detail.workUnitId ? `workUnit=${detail.workUnitId}` : undefined,
      detail.actionId ? `action=${detail.actionId}` : undefined,
      detail.code ? `code=${detail.code}` : undefined,
      detail.kernelCode && detail.kernelCode !== detail.code ? `kernelCode=${detail.kernelCode}` : undefined,
      detail.message,
      detail.writeSet.length ? `writeSet=${detail.writeSet.join(',')}` : undefined,
    ].filter((item): item is string => Boolean(item));
    return parts.length ? parts.join(' ') : detail.status;
  }
}

function actionBatchActionIndex(batch?: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  for (const action of batchActionRecords(batch)) {
    for (const id of [stringValue(action.actionId), stringValue(action.id)]) {
      if (id) index.set(id, action);
    }
  }
  return index;
}

function actionBatchDeleteActionForWriteSet(
  actionIndex: Map<string, Record<string, unknown>>,
  writeSet: string[]
): Record<string, unknown> | undefined {
  const targets = new Set(writeSet.map(normalizePlanScope).filter(Boolean));
  if (!targets.size) return undefined;
  for (const action of actionIndex.values()) {
    if (actionEffectiveCapability(action) !== 'fs.delete') continue;
    const actionTargets = actionTargetCandidates(action).map(normalizePlanScope).filter(Boolean);
    if (actionTargets.some((target) => targets.has(target))) return action;
  }
  return undefined;
}

function actionBatchFailureClassification(
  action: Record<string, unknown> | undefined,
  message: string | undefined
): string | undefined {
  if (!action) return undefined;
  const capability = actionEffectiveCapability(action);
  const normalizedMessage = (message ?? '').toLowerCase();
  if (capability === 'fs.patch' && normalizedMessage.includes('patch match did not occur')) {
    return 'patch_stale_or_mismatched_evidence';
  }
  if (capability !== 'fs.delete') return undefined;
  if (!message?.includes('fs.write target path is empty')) return undefined;
  return 'kernel_delete_compile_mismatch';
}

function batchActionRecords(batch: unknown): Record<string, unknown>[] {
  const record = objectRecord(batch);
  const nested = objectRecord(record?.actionBundle);
  const actions = Array.isArray(record?.actions)
    ? record.actions
    : Array.isArray(nested?.actions)
      ? nested.actions
      : [];
  return actions.flatMap((item) => objectRecord(item) ? [objectRecord(item) as Record<string, unknown>] : []);
}

function actionTargetCandidates(action: Record<string, unknown>): string[] {
  return uniqueStrings([
    actionFileTargetPath(action),
    stringValue(action.targetPath),
    ...stringArrayValue(action.resourceScope),
  ]);
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

function actionFileTargetPath(action: {
  targetRef?: unknown;
  targetPath?: unknown;
  resourceScope?: unknown;
  args?: unknown;
}): string | undefined {
  const args = objectRecord(action.args);
  return fileTargetRefPath(action.targetRef)
    ?? stringValue(action.targetPath)
    ?? stringArrayValue(action.resourceScope)[0]
    ?? stringValue(args?.path)
    ?? stringValue(args?.targetPath);
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}
