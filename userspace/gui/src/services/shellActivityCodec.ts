const SHELL_ACTIVITY_RESULT_FIELDS = [
  'stdout',
  'stderr',
  'exitCode',
  'success',
  'timedOut',
  'truncated',
  'capturedBytes',
  'durationMs',
] as const;

const SHELL_ENVIRONMENT_FIELDS = [
  'shell',
  'interactive',
  'pathSource',
  'writeScope',
  'homeWritable',
] as const;

export function isShellActivityResult(value: unknown): boolean {
  return isExactRecord(value, SHELL_ACTIVITY_RESULT_FIELDS, ['environment'])
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && (value.exitCode === null
      || typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))
    && typeof value.success === 'boolean'
    && typeof value.timedOut === 'boolean'
    && typeof value.truncated === 'boolean'
    && isNaturalNumber(value.capturedBytes)
    && isNaturalNumber(value.durationMs)
    && (value.environment === undefined || isShellExecutionEnvironment(value.environment));
}

export function isShellExecutionEnvironment(value: unknown): boolean {
  return isExactRecord(value, SHELL_ENVIRONMENT_FIELDS)
    && typeof value.shell === 'string'
    && value.shell.trim().length > 0
    && value.interactive === false
    && value.pathSource === 'hostPlusStandardDeveloperPaths'
    && value.writeScope === 'workspaceAndKernelTemporary'
    && value.homeWritable === false;
}

function isNaturalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
