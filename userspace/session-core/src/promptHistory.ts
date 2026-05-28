export interface PromptHistoryEntry {
  id: string;
  sessionId: string;
  workspaceScopeKey: string;
  content: string;
  contentHash?: string;
  createdAt: string;
  source: 'composer' | 'continue' | 'retry';
}

export class PromptHistoryStore {
  private readonly entries: PromptHistoryEntry[] = [];

  add(entry: PromptHistoryEntry): void {
    this.entries.push(entry);
  }

  list(workspaceScopeKey?: string): PromptHistoryEntry[] {
    return this.entries
      .filter((entry) => !workspaceScopeKey || entry.workspaceScopeKey === workspaceScopeKey)
      .slice()
      .reverse();
  }
}
