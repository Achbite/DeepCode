export interface DiagnosticInfo {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export function diag(code: string, fallback: string, params?: Record<string, string | number>): DiagnosticInfo {
  return { code, fallback, params };
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 20)}... [truncated]`;
}

export class SessionDriverLoopError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionDriverLoopError';
  }
}

export function isEmptyResponseError(error: unknown): boolean {
  return error instanceof SessionDriverLoopError && error.code === 'llm_empty_response';
}
