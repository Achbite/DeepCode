import type { ArtifactProjection } from '@deepcode/protocol';
import type { SourcePosition } from './resourceLinks';
export type ReaderTarget = ({ kind: 'workspace'; workspaceId: string; logicalPath: string } & SourcePosition)
  | { kind: 'artifact'; artifact: ArtifactProjection }
  | { kind: 'browser'; previewId?: string; url?: string; filePath?: string; selfPreview?: boolean };
export const READER_OPEN_EVENT = 'deepcode:reader-open';
export function requestReader(sessionId: string, target: ReaderTarget): void {
  window.dispatchEvent(new CustomEvent(READER_OPEN_EVENT, {detail: {sessionId, target}}));
}
export function requestWorkspacePreview(sessionId: string, workspaceId: string, logicalPath: string): Promise<void> {
  requestReader(sessionId, {kind:'workspace', workspaceId, logicalPath});
  return Promise.resolve();
}
export function readViewState<T>(key: string, initial: T): T {
  try { const saved = sessionStorage.getItem(`deepcode:reader:${key}`); return saved ? JSON.parse(saved) as T : initial; }
  catch { return initial; }
}
export function saveViewState(key: string, value: unknown): void {
  sessionStorage.setItem(`deepcode:reader:${key}`, JSON.stringify(value));
}
