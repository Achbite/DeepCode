import type { TranscriptEntry, TranscriptStore } from './transcript.js';
import type { SessionMemorySnapshot } from './context/memory.js';

export class SessionStorageClient {
  constructor(private readonly baseUrl = '') {}

  async appendTranscript(sessionId: string, entry: TranscriptEntry): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
    if (!response.ok) {
      throw new Error(`append transcript failed: HTTP ${response.status}`);
    }
  }

  async listTranscript(sessionId: string): Promise<TranscriptEntry[]> {
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/transcript`);
    if (!response.ok) {
      throw new Error(`list transcript failed: HTTP ${response.status}`);
    }
    const value = await response.json();
    return (value.data?.entries ?? []) as TranscriptEntry[];
  }

  async persistMemoryArchive(sessionId: string, snapshot: SessionMemorySnapshot): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/memory/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    });
    if (!response.ok) {
      throw new Error(`persist memory archive failed: HTTP ${response.status}`);
    }
    const value = await response.json();
    if (value && value.ok === false) {
      throw new Error(value.message ?? value.error ?? 'persist memory archive failed');
    }
  }
}

export class HttpTranscriptStore implements TranscriptStore {
  constructor(private readonly client: SessionStorageClient) {}

  async append(entry: TranscriptEntry): Promise<void> {
    await this.client.appendTranscript(entry.sessionId, entry);
  }

  async list(sessionId: string): Promise<TranscriptEntry[]> {
    return this.client.listTranscript(sessionId);
  }
}
