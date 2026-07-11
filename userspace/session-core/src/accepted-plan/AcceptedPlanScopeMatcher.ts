import type { ProposalEnvelope, ActionBundleDraft } from '../protocol/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanExecutionRoot,
  AcceptedPlanAccessScope,
  AcceptedPlanExactOperationGrant,
  AcceptedPlanTargetScope,
} from './types.js';

type ActionRecord = Record<string, unknown>;

export class AcceptedPlanScopeMatcher {
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined {
    const payload = objectRecord(proposal.payload);
    const actionBundle = objectRecord(payload?.actionBundle);
    return actionBundle as unknown as ActionBundleDraft | undefined;
  }

  canonicalCapabilities(accepted: AcceptedImplementationPlanContext): Set<string> {
    const capabilities = [
      ...accepted.capabilities,
      ...accepted.tasks.map((task) => task.capability),
      ...accepted.exactOperationGrants.flatMap((grant) => [
        grant.capability,
        capabilityForAcceptedPlanOperation(grant.operation),
      ]),
      ...accepted.accessScopes.flatMap((scope) => [
        ...scope.capabilities,
        ...scope.operations.map(capabilityForAcceptedPlanOperation),
      ]),
    ];
    return new Set(capabilities
      .map((capability) => this.canonicalCapability(capability))
      .filter((capability): capability is string => Boolean(capability)));
  }

  proposalTargetScopes(
    proposal: ProposalEnvelope,
    accepted: AcceptedImplementationPlanContext
  ): AcceptedPlanTargetScope[] {
    const actionBundle = this.readActionBundle(proposal);
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
      const normalized = this.normalizeTargetScope(raw, accepted);
      const key = `${raw}\u0000${normalized}`;
      if (!normalized || seen.has(key)) continue;
      seen.add(key);
      output.push({ raw, normalized });
    }
    return output;
  }

  targetError(
    target: AcceptedPlanTargetScope,
    accepted: AcceptedImplementationPlanContext
  ): string | undefined {
    const raw = target.raw;
    const normalized = target.normalized;
    if (!normalized) return 'actionBundle target path is empty and cannot be auto-executed.';
    if (normalized === '.' || normalized === '..') {
      return `target ${raw} points to the primary root directory itself, not a writable file target.`;
    }
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
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

  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string {
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

  autoExecutableCapability(capability: string): boolean {
    return [
      'fs.read',
      'fs.write',
      'fs.patch',
      'fs.delete',
      'process.exec',
      'network.egress',
      'git.read',
      'git.write',
      'git.push',
      'config.modify',
      'browser.control',
      'provider.egress',
    ].includes(capability);
  }

  capabilitySetAllows(
    allowed: Set<string>,
    capability: string,
    direction: 'acceptedCoversAction' | 'actionCoversAccepted' = 'acceptedCoversAction'
  ): boolean {
    if (allowed.has(capability)) return true;
    return [...allowed].some((item) =>
      direction === 'acceptedCoversAction'
        ? acceptedPlanCapabilityCovers(item, capability)
        : acceptedPlanCapabilityCovers(capability, item)
    );
  }

  actionTargetScopes(action: ActionBundleDraft['actions'][number], proposal: ProposalEnvelope): string[] {
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

  normalizeTargetScope(scope: string, accepted: AcceptedImplementationPlanContext): string {
    return normalizePlanTargetForExecutionRoot(scope, accepted.executionRoot);
  }

  normalizeTargetForExecutionRoot(
    scope: string,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): string {
    return normalizePlanTargetForExecutionRoot(scope, executionRoot);
  }

  normalizeScopeIdentity(scope: string): string {
    return normalizePlanScopeIdentity(scope);
  }

  expandTargetTokens(target: string): string[] {
    return expandPlanTargetTokens(target);
  }

  scopesOverlap(left: string, right: string): boolean {
    return planScopeCovers(left, right) || planScopeCovers(right, left);
  }

  scopeCovered(scope: string, capability: string | undefined, accepted: AcceptedImplementationPlanContext): boolean {
    const normalized = normalizePlanScope(scope);
    if (!normalized) return false;
    if (this.exactOperationGrantCoversTarget(normalized, capability, accepted)) return true;
    if ((capability === 'fs.delete' || capability === 'fs.rename') && this.taskTargetsCoverScope(normalized, accepted)) {
      return true;
    }
    if (capability === 'fs.delete' || capability === 'fs.rename') return false;
    const acceptedScopes = accepted.targetScopes
      .flatMap(expandPlanTargetTokens)
      .map((target) => normalizePlanTargetForExecutionRoot(target, accepted.executionRoot))
      .filter(Boolean);
    if (scopeCoveredByAcceptedPlan(normalized, acceptedScopes)) return true;
    return accepted.accessScopes.some((accessScope) => {
      if (accessScope.outsideWorkspace) return false;
      if (!accessScopeCapabilityMatches(accessScope, capability)) return false;
      return planScopeCovers(
        normalizePlanTargetForExecutionRoot(accessScope.path, accepted.executionRoot),
        normalized
      );
    });
  }

  deleteTargetResourceKind(action: {
    targetResourceKind?: unknown;
    targetKind?: unknown;
    toolArgs?: unknown;
    args?: unknown;
  }): 'file' | 'directory' | undefined {
    const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
    const value = stringValue(action.targetResourceKind)
      ?? stringValue(action.targetKind)
      ?? stringValue(toolArgs?.targetResourceKind)
      ?? stringValue(toolArgs?.targetKind);
    if (value === 'directory' || value === 'dir') return 'directory';
    if (value === 'file') return 'file';
    return undefined;
  }

  deleteRecursive(action: { recursive?: unknown; toolArgs?: unknown; args?: unknown }): boolean {
    const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
    return action.recursive === true || toolArgs?.recursive === true;
  }

  objectRecord(value: unknown): Record<string, unknown> | undefined {
    return objectRecord(value);
  }

  stringValue(value: unknown): string | undefined {
    return stringValue(value);
  }

  private canonicalCapability(capability: string | undefined): string | undefined {
    if (!capability) return undefined;
    if (this.autoExecutableCapability(capability)) return capability;
    return undefined;
  }

  private taskTargetsCoverScope(scope: string, accepted: AcceptedImplementationPlanContext): boolean {
    const normalized = normalizePlanScopeIdentity(scope);
    if (!normalized) return false;
    return accepted.tasks.some((task) =>
      task.targets
        .flatMap(expandPlanTargetTokens)
        .map((target) => normalizePlanScopeIdentity(
          normalizePlanTargetForExecutionRoot(target, accepted.executionRoot)
        ))
        .filter(Boolean)
        .some((target) =>
          planScopeCovers(target, normalized) ||
          planScopeCovers(normalized, target)
        )
    );
  }

  private exactOperationGrantCoversTarget(
    scope: string,
    capability: string | undefined,
    accepted: AcceptedImplementationPlanContext
  ): boolean {
    const normalized = normalizePlanScopeIdentity(scope);
    if (!normalized || !capability) return false;
    return accepted.exactOperationGrants.some((grant) => {
      if (!exactOperationGrantCapabilityMatches(grant, capability)) return false;
      return normalizePlanScopeIdentity(
        normalizePlanTargetForExecutionRoot(grant.targetPath, accepted.executionRoot)
      ) === normalized;
    });
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
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
}

function capabilityForAcceptedPlanOperation(operation: string | undefined): string | undefined {
  if (!operation) return undefined;
  if (operation === 'read' || operation === 'list' || operation === 'search') return 'fs.read';
  if (operation === 'create' || operation === 'write' || operation === 'overwrite') return 'fs.write';
  if (operation === 'patch' || operation === 'replace') return 'fs.patch';
  if (operation === 'delete' || operation === 'remove') return 'fs.delete';
  if (operation === 'rename' || operation === 'move') return 'fs.rename';
  return undefined;
}

function acceptedPlanCapabilityCovers(acceptedCapability: string, actionCapability: string): boolean {
  if (acceptedCapability === actionCapability) return true;
  if (acceptedCapability === 'fs.write' && actionCapability === 'fs.patch') return true;
  return false;
}

function accessScopeCapabilityMatches(scope: AcceptedPlanAccessScope, capability: string | undefined): boolean {
  if (!capability) return false;
  if (scope.capabilities.some((item) => acceptedPlanCapabilityCovers(item, capability))) return true;
  if (capability === 'fs.write' && scope.operations.some((operation) => operation === 'create' || operation === 'write')) return true;
  if (capability === 'fs.patch' && scope.operations.includes('patch')) return true;
  return false;
}

function exactOperationGrantCapabilityMatches(
  grant: AcceptedPlanExactOperationGrant,
  capability: string | undefined
): boolean {
  if (!capability) return false;
  if (grant.capability === capability) return true;
  if (grant.capability === 'fs.write' && capability === 'fs.patch') return true;
  if (capability === 'fs.write' && ['create', 'write'].includes(grant.operation)) return true;
  if (capability === 'fs.patch' && grant.operation === 'patch') return true;
  if (capability === 'fs.delete' && grant.operation === 'delete') return true;
  if (capability === 'fs.rename' && grant.operation === 'rename') return true;
  return false;
}

function scopeCoveredByAcceptedPlan(scope: string, acceptedScopes: string[]): boolean {
  if (acceptedScopes.length === 0) return false;
  return acceptedScopes.some((accepted) => planScopeCovers(accepted, scope));
}

function planScopeCovers(accepted: string, candidate: string): boolean {
  if (!accepted || !candidate) return false;
  const acceptedNormalized = normalizePlanScopeIdentity(accepted);
  const candidateNormalized = normalizePlanScopeIdentity(candidate);
  if (acceptedNormalized === candidateNormalized) return true;
  if (isAbsolutePath(acceptedNormalized) || isAbsolutePath(candidateNormalized)) return false;
  const acceptedDir = acceptedNormalized.endsWith('/') ? acceptedNormalized : `${acceptedNormalized}/`;
  return candidateNormalized.startsWith(acceptedDir);
}

function normalizePlanTargetForExecutionRoot(
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

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizePlanScopeIdentity(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function expandPlanTargetTokens(target: string): string[] {
  if (!target || !target.trim()) return [];
  const candidates = target.match(/[A-Za-z0-9_.\-/]+/g) ?? [];
  const pathLike = candidates.filter((token) => token.includes('/') || /\.[A-Za-z0-9]+$/.test(token));
  return pathLike.length ? pathLike : [target.trim()];
}

function comparablePath(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function basename(value: string): string {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
