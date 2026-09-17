import type { ErrorDiagnostics, LocalAgentError } from './localAgent.js';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0');

export function isErrorDiagnostics(value: unknown): value is ErrorDiagnostics {
  if (!object(value) || !['source', 'phase', 'category'].every((key) => text(value[key]))
    || typeof value.retryable !== 'boolean' || !Array.isArray(value.causes) || value.causes.length > 16) return false;
  if (Object.keys(value).some((key) => !['source', 'phase', 'category', 'retryable', 'causes', 'isConnect', 'isTimeout', 'isBody', 'stopReason', 'archivePath', 'secondary'].includes(key))) return false;
  return value.causes.every((cause) => object(cause) && text(cause.message)
    && Object.keys(cause).every((key) => ['message', 'kind', 'osCode'].includes(key))
    && (cause.kind === undefined || text(cause.kind)) && (cause.osCode === undefined || Number.isSafeInteger(cause.osCode)))
    && ['isConnect', 'isTimeout', 'isBody'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    && ['stopReason', 'archivePath'].every((key) => value[key] === undefined || text(value[key]))
    && (value.secondary === undefined || Array.isArray(value.secondary) && value.secondary.length <= 16
      && value.secondary.every((entry) => object(entry) && Object.keys(entry).length === 2 && text(entry.code) && text(entry.message)));
}

export function isLocalAgentErrorValue(value: unknown): value is LocalAgentError {
  return object(value) && Object.keys(value).every((key) => ['code', 'message', 'diagnostics'].includes(key))
    && text(value.code) && text(value.message) && (value.diagnostics === undefined || isErrorDiagnostics(value.diagnostics));
}
