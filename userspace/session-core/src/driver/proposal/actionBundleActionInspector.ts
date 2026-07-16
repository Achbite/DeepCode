export class ActionBundleActionInspector {
  actionToolId(action: { toolId?: unknown }): string {
    return stringValue(action.toolId) ?? '';
  }

  actionFileTargetPath(action: { args?: unknown }): string | undefined {
    const args = objectRecord(action.args);
    return stringValue(args?.path);
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
