import { diffLines } from 'diff';
import type { ChangeCounts } from './fileChangeSummary';

/** Runs in the statistics Worker, so the time budget covers computation, not timer waits. */
export function calculateChangedLines(before: string | null, after: string | null): ChangeCounts {
  const changes = diffLines(before ?? '', after ?? '', { timeout: 1_000 });
  if (!changes) throw new Error('修改行数计算超时');
  return changes.reduce((counts, change) => ({
    added: counts.added + (change.added ? change.count : 0),
    removed: counts.removed + (change.removed ? change.count : 0),
  }), { added: 0, removed: 0 });
}
