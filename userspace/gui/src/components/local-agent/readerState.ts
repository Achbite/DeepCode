import type { ChangedFile } from './fileChangeSummary';
import { resourceKey, type ResourceReference } from '../../services/conversationResources';
import type { ArtifactProjection } from '@deepcode/protocol';
import type { SourcePosition } from './resourceLinks';
export type ReaderTarget = ({ kind: 'workspace'; workspaceId: string; logicalPath: string } & SourcePosition)
  | { kind: 'resource'; resource: ResourceReference; name: string }
  | { kind: 'diff'; file: ChangedFile }
  | { kind: 'file'; path: string }
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

export function readerTargetKey(target: ReaderTarget): string {
  if (target.kind === 'diff') return 'diff:' + JSON.stringify(target.file.changes.map(entry => [entry.recordId, entry.index]));
  if (target.kind === 'resource') return 'resource:' + resourceKey(target.resource);
  if (target.kind === 'file') return 'file:' + target.path;
  if (target.kind === 'workspace')
    return 'resource:' + resourceKey({ workspaceId: target.workspaceId, logicalPath: target.logicalPath });
  if (target.kind === 'artifact') return 'artifact:' + target.artifact.artifactId;
  return 'browser:' + target.previewId;
}
