export class AcceptedPlanTargetParser {
  taskTargets(record: Record<string, unknown>): string[] {
    const rawTargets = [
      ...stringArrayValue(record.target),
      ...stringArrayValue(record.targets),
      ...stringArrayValue(record.targetPath),
      ...stringArrayValue(record.targetPaths),
      ...this.taskFileOperationTargets(record),
    ];
    const seen = new Set<string>();
    const targets: string[] = [];
    for (const target of rawTargets.flatMap((value) => this.expandTargetValue(value))) {
      const normalized = normalizePlanScope(target);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      targets.push(normalized);
    }
    return targets;
  }

  private taskFileOperationTargets(record: Record<string, unknown>): string[] {
    const operations = Array.isArray(record.fileOperations) ? record.fileOperations : [];
    const targets: string[] = [];
    for (const operation of operations) {
      const item = objectRecord(operation);
      if (!item) continue;
      const target = stringValue(item.targetPath)
        ?? stringValue(item.path)
        ?? fileTargetRefPath(item.targetRef);
      if (target) targets.push(target);
    }
    return targets;
  }

  private expandTargetValue(value: string): string[] {
    const normalized = normalizePlanScope(value);
    if (!normalized) return [];
    if (normalized.includes(',')) {
      const parts = normalized
        .split(',')
        .map((part) => normalizePlanScope(part))
        .filter(Boolean);
      if (parts.length > 1 && parts.every(targetListSegmentSafe)) return parts;
      const extracted = extractTargetTokens(normalized);
      return extracted.length ? extracted : [normalized];
    }
    const extracted = extractTargetTokens(normalized);
    return extracted.length ? extracted : [normalized];
  }
}

interface AcceptedPlanTargetToken {
  value: string;
  index: number;
}

function targetListSegmentSafe(value: string): boolean {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return false;
  if (normalized.includes(',') || normalized.includes('*')) return false;
  if (normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (/[\s()[\]{}<>（）【】]/.test(normalized)) return false;
  if (isAbsolutePath(normalized)) return normalized.replace(/\/+$/, '').length > 1;
  return true;
}

function extractTargetTokens(target: string): string[] {
  const tokens = pathTokens(target);
  if (!tokens.length) return [];
  const hasFreeformBoundary = /[,;:()[\]{}<>（）【】]/.test(target) ||
    Boolean(tokens[0]?.value.endsWith('/') && target.trim() !== tokens[0].value) ||
    (tokens.length > 1 && tokens[0]?.value.endsWith('/'));
  if (!hasFreeformBoundary) return [];
  const first = tokens[0];
  if (!first || first.index !== 0) return [];
  const normalizedFirst = normalizePlanScope(first.value);
  if (
    normalizedFirst.endsWith('/') &&
    tokens.slice(1).every((token) => !token.value.includes('/'))
  ) {
    return [normalizedFirst];
  }
  return uniqueStrings(tokens
    .map((token) => normalizePlanScope(token.value))
    .filter((token) => token && targetListSegmentSafe(token)));
}

function pathTokens(value: string): AcceptedPlanTargetToken[] {
  const tokens: AcceptedPlanTargetToken[] = [];
  for (const match of value.matchAll(/[A-Za-z0-9_.\-/]+/g)) {
    const token = match[0];
    const index = match.index ?? -1;
    if (!token || index < 0) continue;
    if (token === '.' || token === '..') continue;
    if (!token.includes('/') && !/\.[A-Za-z0-9]+$/.test(token)) continue;
    tokens.push({ value: token, index });
  }
  return tokens;
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
