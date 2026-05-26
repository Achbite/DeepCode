import type { ParsedAgentActionError, ToolCall } from '@deepcode/protocol';

const WORKSPACE_PATH_TOOL_NAMES = new Set(['fs.read', 'fs.list', 'fs.write', 'fs.diff']);

export function nowIso(): string {
  return new Date().toISOString();
}

export function nextId(prefix: string, index: number): string {
  return `${prefix}-${Date.now()}-${index}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function parseBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;
  return undefined;
}

export function parseNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function pathError(path: string | undefined): ParsedAgentActionError | undefined {
  if (!path) return { code: 'missing_path', message: 'Missing path.' };
  if (path.includes('\0')) {
    return { code: 'invalid_path', message: 'Path contains a NUL byte.' };
  }
  if (/^[a-zA-Z]:/.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return {
      code: 'absolute_path_blocked',
      message: `Agent action paths must be workspace-relative: ${path}`,
    };
  }
  if (path.split(/[\\/]+/).includes('..')) {
    return {
      code: 'path_traversal_blocked',
      message: `Path traversal is blocked: ${path}`,
    };
  }
  return undefined;
}

export function toolCallPathError(
  toolCall: Pick<ToolCall, 'name' | 'arguments'>
): ParsedAgentActionError | undefined {
  if (!WORKSPACE_PATH_TOOL_NAMES.has(toolCall.name)) return undefined;
  if (!isRecord(toolCall.arguments)) {
    return { code: 'invalid_arguments', message: 'Tool arguments must be an object.' };
  }

  const rawPath = asString(toolCall.arguments.path);
  if (toolCall.name === 'fs.list' && (rawPath === undefined || rawPath === '')) {
    return undefined;
  }

  return pathError(rawPath);
}
