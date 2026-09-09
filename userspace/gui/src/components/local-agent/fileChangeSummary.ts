import type { ActivityProjection, FileChangeProjection, SessionProjection } from '@deepcode/protocol';
import type { readFileChange } from '../../services/localAgentApi';

export type Change = { change: FileChangeProjection; index: number; recordId: string };
export type ChangedFile = { key: string; path: string; changes: Change[] };
export type ChangeCounts = { added: number; removed: number };

export function roundChangeActivities(projection: SessionProjection | null, runId: string): ActivityProjection[] {
  const records = new Set(projection?.fileChangeRounds?.find((round) => round.runId === runId)?.recordIds ?? []);
  return projection?.activities.filter((activity) => activity.tool?.recordId && records.has(activity.tool.recordId)) ?? [];
}

export function changedFiles(activities: ActivityProjection[]): ChangedFile[] {
  const files = new Map<string, ChangedFile>();
  for (const activity of activities) {
    const recordId = activity.tool?.recordId;
    if (!recordId) continue;
    for (const [index, change] of (activity.tool?.fileChanges ?? []).entries()) {
      const key = JSON.stringify([change.workspaceId, change.path]);
      const file = files.get(key) ?? { key, path: change.path, changes: [] };
      if (!file.changes.some((entry) => entry.recordId === recordId && entry.index === index)) file.changes.push({ change, recordId, index });
      files.set(key, file);
    }
  }
  return [...files.values()];
}

export async function readRoundChange(read: typeof readFileChange, sessionId: string, file: ChangedFile, signal: AbortSignal) {
  const first = file.changes[0]!;
  const last = file.changes.at(-1)!;
  const before = await read(sessionId, first.recordId, first.index, signal);
  const after = first === last ? before : await read(sessionId, last.recordId, last.index, signal);
  if (before.workspaceId !== after.workspaceId || before.path !== after.path
    || before.workspaceId !== first.change.workspaceId || before.path !== file.path) throw new Error('file_change_identity_mismatch');
  return { ...after, before: before.before };
}

export function countChangedLines(before: string | null, after: string | null, signal?: AbortSignal): Promise<ChangeCounts> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const worker = new Worker(new URL('./fileChangeSummary.worker.ts', import.meta.url), { type: 'module' });
    const dispose = () => { signal?.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { dispose(); reject(signal?.reason); };
    worker.onmessage = ({ data }: MessageEvent<{ counts: ChangeCounts } | { error: string }>) => {
      dispose();
      if ('error' in data) reject(new Error(data.error));
      else resolve(data.counts);
    };
    worker.onerror = (event) => { dispose(); reject(new Error(event.message)); };
    worker.onmessageerror = () => { dispose(); reject(new Error('无法读取修改行数计算结果')); };
    signal?.addEventListener('abort', abort, { once: true });
    try { worker.postMessage({ before, after }); }
    catch (error) { dispose(); reject(error); }
  });
}
