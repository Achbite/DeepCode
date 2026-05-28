export * from './controller.js';
export * from './projection.js';
export * from './promptHistory.js';
export * from './resume.js';
export * from './sidechain.js';
export * from './storageClient.js';
export * from './transcript.js';
export * from './workspaceScope.js';

import type { AgentContextAttachment } from '@deepcode/protocol';

export function mergeContextAttachment(
  list: AgentContextAttachment[],
  next: AgentContextAttachment
): AgentContextAttachment[] {
  const key = `${next.folderId ?? ''}:${next.path}`;
  const filtered = list.filter((item) => `${item.folderId ?? ''}:${item.path}` !== key);
  return [...filtered, next];
}

export function assertUserSessionLayerOnly(): true {
  return true;
}
