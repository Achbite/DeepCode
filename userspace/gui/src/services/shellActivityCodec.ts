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
  'executionScope',
  'terminal',
  'pathSource',
  'writeScope',
  'homeWritable',
  'networkAccess',
] as const;

export function isShellActivityResult(value: unknown): boolean {
  return isExactRecord(value, [...SHELL_ACTIVITY_RESULT_FIELDS, 'environment'])
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string'
    && (value.exitCode === null
      || typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))
    && typeof value.success === 'boolean'
    && typeof value.timedOut === 'boolean'
    && typeof value.truncated === 'boolean'
    && isNaturalNumber(value.capturedBytes)
    && isNaturalNumber(value.durationMs)
    && isShellExecutionEnvironment(value.environment);
}

export function isShellExecutionEnvironment(value: unknown): boolean {
  return isExactRecord(value, SHELL_ENVIRONMENT_FIELDS)
    && typeof value.shell === 'string'
    && value.shell.trim().length > 0
    && typeof value.terminal === 'boolean'
    && value.interactive === value.terminal
    && (value.executionScope === 'workspace' || value.executionScope === 'host')
    && value.pathSource === 'hostPlusStandardDeveloperPaths'
    && (value.executionScope === 'host'
      ? value.writeScope === 'hostUser'
        && value.homeWritable === true
        && value.networkAccess === true
      : (
          value.writeScope === 'kernelTemporaryOnly'
          || value.writeScope === 'workspaceAndKernelTemporary'
        )
        && value.homeWritable === false
        && value.networkAccess === false);
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
