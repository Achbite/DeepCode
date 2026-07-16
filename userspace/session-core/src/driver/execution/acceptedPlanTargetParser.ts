export class AcceptedPlanTargetParser {
  taskTargets(record: Record<string, unknown>): string[] {
    const rawTargets = stringArrayValue(record.target);
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const target of rawTargets) {
      const normalized = normalizePlanScope(target);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      targets.push(normalized);
    }
    return targets;
  }
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
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
