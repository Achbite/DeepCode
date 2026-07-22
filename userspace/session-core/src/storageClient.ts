import type { TranscriptEntry, TranscriptStore } from './transcript.js';
import type { SessionMemorySnapshot } from './context/memory.js';
import type { PromptLedgerWireRecord } from './prompt/promptLedger.js';
import type { ProjectionDeliveryRecord } from '@deepcode/protocol';

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

  async persistMemoryArchive(
    sessionId: string,
    snapshot: SessionMemorySnapshot,
    signal?: AbortSignal
  ): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/memory/archive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ snapshot }),
      signal,
    });
    if (!response.ok) {
      throw new Error(`persist memory archive failed: HTTP ${response.status}`);
    }
    const value = await response.json();
    if (value && value.ok === false) {
      throw new Error(value.message ?? value.error ?? 'persist memory archive failed');
    }
  }

  async listWireLedger(sessionId: string): Promise<PromptLedgerWireRecord[]> {
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/wire-ledger`);
    if (!response.ok) throw new Error(`list wire ledger failed: HTTP ${response.status}`);
    const value = await response.json();
    assertSessionStoreResponse(value, 'list wire ledger failed');
    return (value.data?.entries ?? []) as PromptLedgerWireRecord[];
  }

  async appendWireLedger(sessionId: string, entries: PromptLedgerWireRecord[]): Promise<void> {
    if (entries.length === 0) return;
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/wire-ledger`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    if (!response.ok) throw new Error(`append wire ledger failed: HTTP ${response.status}`);
    assertSessionStoreResponse(await response.json(), 'append wire ledger failed');
  }

  async appendCacheTelemetry(sessionId: string, entry: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/cache-telemetry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entry }),
    });
    if (!response.ok) throw new Error(`append cache telemetry failed: HTTP ${response.status}`);
    assertSessionStoreResponse(await response.json(), 'append cache telemetry failed');
  }

  async appendProjectionDelivery(
    sessionId: string,
    entries: ProjectionDeliveryRecord[],
    signal?: AbortSignal
  ): Promise<void> {
    if (entries.length === 0) return;
    const response = await fetch(
      `${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/projection-delivery`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entries }),
        signal,
      }
    );
    if (!response.ok) throw new Error(`append projection delivery failed: HTTP ${response.status}`);
    assertSessionStoreResponse(await response.json(), 'append projection delivery failed');
  }
}

function assertSessionStoreResponse(value: unknown, fallback: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const response = value as Record<string, unknown>;
  if (response.ok !== false) return;
  const detail = [response.error, response.message]
    .find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  throw new Error(detail ? `${fallback}: ${detail}` : fallback);
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
