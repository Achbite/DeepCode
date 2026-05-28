export interface SidechainEntry {
  sidechainId: string;
  sessionId: string;
  runId?: string;
  kind: 'skill' | 'validator' | 'browser' | 'subrun';
  summary?: string;
  kernelEventRefs: string[];
  createdAt: string;
}

export class SidechainStore {
  private readonly entries = new Map<string, SidechainEntry[]>();

  append(entry: SidechainEntry): void {
    const entries = this.entries.get(entry.sessionId) ?? [];
    entries.push(entry);
    this.entries.set(entry.sessionId, entries);
  }

  list(sessionId: string): SidechainEntry[] {
    return [...(this.entries.get(sessionId) ?? [])];
  }
}
