export * from './agent-plan/index.js';
export * from './cache/index.js';
export * from './cadence/index.js';
export * from './confirmation/index.js';
export * from './context/index.js';
export * from './controller.js';
export * from './driver/index.js';
export * from './projection.js';
export * from './prompt/index.js';
export * from './promptHistory.js';
export * from './requirement/index.js';
export * from './resume.js';
export * from './review/index.js';
export * from './sidechain.js';
export * from './storageClient.js';
export * from './task-queue/index.js';
export * from './transcript.js';
export * from './workflow/index.js';
export * from './workspaceScope.js';

import type { AgentContextAttachment } from '@deepcode/protocol';

export function mergeContextAttachment(
  list: AgentContextAttachment[],
  next: AgentContextAttachment
): AgentContextAttachment[] {
  const attachmentKey = (item: AgentContextAttachment) =>
    `${item.folderId ?? ''}:${item.absolutePath ?? item.path}`;
  const key = attachmentKey(next);
  const filtered = list.filter((item) => attachmentKey(item) !== key);
  return [...filtered, next];
}

export function assertUserSessionLayerOnly(): true {
  return true;
}
