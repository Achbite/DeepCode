import type { ProposalEnvelope } from '../../agent-plan/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanExecutionRoot,
  AcceptedPlanTargetScope,
} from '../../accepted-plan/types.js';

export class AcceptedPlanProposalScopeIndex {
  proposalTargetScopes(
    proposal: ProposalEnvelope,
    accepted: AcceptedImplementationPlanContext
  ): AcceptedPlanTargetScope[] {
    const actionBundle = readActionBundle(proposal);
    const targets: string[] = [];
    for (const action of actionBundle?.actions ?? []) {
      targets.push(...this.actionTargetScopes(action, proposal));
    }
    const payload = objectRecord(proposal.payload) ?? {};
    const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
    for (const block of codeBlocks) {
      const record = objectRecord(block);
      if (!record) continue;
      targets.push(...stringArrayValue(record.path), ...stringArrayValue(record.targetPath));
    }
    const output: AcceptedPlanTargetScope[] = [];
    const seen = new Set<string>();
    for (const raw of targets) {
      const normalized = this.normalizeAcceptedTargetScope(raw, accepted);
      const key = `${raw}\u0000${normalized}`;
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      output.push({ raw, normalized });
    }
    return output;
  }

  actionTargetScopes(
    action: {
      resourceScope?: unknown;
      targetPath?: unknown;
      targetRef?: unknown;
      sourceBlockId?: unknown;
      replacementBlockId?: unknown;
      args?: unknown;
    },
    proposal: ProposalEnvelope
  ): string[] {
    const args = objectRecord(action.args);
    const concreteTargets = stringArrayValue(action.targetPath);
    concreteTargets.push(...stringArrayValue(args?.path), ...stringArrayValue(args?.targetPath));
    const targetRefPath = fileTargetRefPath(action.targetRef);
    if (targetRefPath) concreteTargets.push(targetRefPath);
    const payload = objectRecord(proposal.payload) ?? {};
    const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
    const blockIds = new Set([
      stringValue(action.sourceBlockId),
      stringValue(action.replacementBlockId),
      stringValue(args?.sourceBlockId),
      stringValue(args?.replacementBlockId),
    ].filter((item): item is string => Boolean(item)));
    for (const block of codeBlocks) {
      const record = objectRecord(block);
      const blockId = stringValue(record?.id) ?? stringValue(record?.blockId);
      if (!blockId || !blockIds.has(blockId)) continue;
      concreteTargets.push(...stringArrayValue(record?.path), ...stringArrayValue(record?.targetPath));
    }
    return concreteTargets.length ? concreteTargets : stringArrayValue(action.resourceScope);
  }

  normalizeAcceptedTargetScope(value: string, accepted: AcceptedImplementationPlanContext): string {
    return this.normalizeTargetForExecutionRoot(value, accepted.executionRoot);
  }

  normalizeTargetForExecutionRoot(
    value: string,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): string {
    const normalized = normalizePlanScope(value);
    const rootRef = executionRoot?.ref;
    if (!rootRef) return normalized;
    const root = comparablePath(rootRef);
    const candidate = comparablePath(value);
    if (isAbsolutePath(value) || isAbsolutePath(normalized)) {
      if (candidate === root) return '.';
      if (candidate.startsWith(`${root}/`)) return normalizePlanScope(candidate.slice(root.length + 1));
      return normalized;
    }
    const rootName = basename(rootRef);
    if (rootName && normalized === rootName) return '.';
    if (rootName && normalized.startsWith(`${rootName}/`)) {
      return normalizePlanScope(normalized.slice(rootName.length + 1));
    }
    return normalized;
  }

  relativeTargetError(
    target: AcceptedPlanTargetScope,
    accepted: AcceptedImplementationPlanContext
  ): string | undefined {
    const raw = target.raw;
    const normalized = target.normalized;
    if (!normalized) return 'actionBundle target path is empty and cannot be auto-executed.';
    if (normalized === '.' || normalized === '..') {
      return `target ${raw} points to the primary root directory itself, not a writable file target.`;
    }
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      return `target ${raw} must not contain a relative path that escapes the primary root.`;
    }
    const rootRef = accepted.executionRoot?.ref;
    if (isAbsolutePath(raw)) return undefined;
    if (isAbsolutePath(normalized)) return undefined;
    if (rootRef) {
      const rootName = basename(rootRef);
      const rawNormalized = normalizePlanScope(raw);
      if (rootName && rawNormalized === rootName) {
        return `target ${raw} points to the primary root directory itself, not a writable file target.`;
      }
    }
    return undefined;
  }
}

function readActionBundle(proposal: ProposalEnvelope): { actions?: Record<string, unknown>[] } | undefined {
  const payload = objectRecord(proposal.payload);
  const actionBundle = objectRecord(payload?.actionBundle);
  if (!actionBundle) return undefined;
  const actions = Array.isArray(actionBundle.actions)
    ? actionBundle.actions.flatMap((item) => objectRecord(item) ? [objectRecord(item) as Record<string, unknown>] : [])
    : [];
  return { actions };
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function comparablePath(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function basename(value: string): string {
  const normalized = comparablePath(value);
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function isAbsolutePath(value: string): boolean {
  return /^\/|^[a-zA-Z]:[\\/]/.test(value);
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
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
