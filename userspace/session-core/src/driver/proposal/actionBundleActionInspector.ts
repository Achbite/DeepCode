export class ActionBundleActionInspector {
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

  actionFileTargetPath(action: {
    targetRef?: unknown;
    targetPath?: unknown;
    resourceScope?: unknown;
    args?: unknown;
  }): string | undefined {
    const args = objectRecord(action.args);
    return this.fileTargetRefPath(action.targetRef)
      ?? stringValue(action.targetPath)
      ?? stringArrayValue(action.resourceScope)[0]
      ?? stringValue(args?.path)
      ?? stringValue(args?.targetPath);
  }

  fileTargetRefPath(value: unknown): string | undefined {
    const direct = stringValue(value);
    if (direct) return direct;
    const record = objectRecord(value);
    return stringValue(record?.path) ?? stringValue(record?.targetPath);
  }

  fileTargetRefFromPath(path: string): Record<string, unknown> {
    return {
      kind: isAbsolutePath(path) ? 'absolutePath' : 'workspaceRelative',
      path,
    };
  }

  deleteActionTargetResourceKind(action: {
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

  deleteActionRecursive(action: { recursive?: unknown; toolArgs?: unknown; args?: unknown }): boolean {
    const toolArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
    return booleanLike(action.recursive) || booleanLike(toolArgs?.recursive);
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

function booleanLike(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
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

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value);
}
