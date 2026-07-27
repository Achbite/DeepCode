import type { TranscriptEntry, TranscriptStore } from './transcript.js';
import type { SessionMemorySnapshot } from './context/memory.js';
import type { PromptLedgerWireRecord } from './prompt/promptLedger.js';
import type { ProjectionDeliveryRecord } from '@deepcode/protocol';
import type {
  ProviderAnalysisTimelineAppendAck,
  ProviderAnalysisTimelineEvent,
} from './provider/ProviderAnalysisTimeline.js';

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

  async listCacheTelemetry(sessionId: string): Promise<Record<string, unknown>[]> {
    const response = await fetch(
      `${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/cache-telemetry`
    );
    if (!response.ok) {
      throw new Error(`list cache telemetry failed: HTTP ${response.status}`);
    }
    const value = await response.json();
    assertSessionStoreResponse(value, 'list cache telemetry failed');
    return (value.data?.entries ?? []) as Record<string, unknown>[];
  }

  async appendAnalysisTimeline(
    sessionId: string,
    entries: ProviderAnalysisTimelineEvent[]
  ): Promise<ProviderAnalysisTimelineAppendAck[]> {
    if (entries.length === 0) return [];
    return this.appendAnalysisTimelineBatch(sessionId, entries);
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

  private async appendAnalysisTimelineBatch(
    sessionId: string,
    entries: ProviderAnalysisTimelineEvent[]
  ): Promise<ProviderAnalysisTimelineAppendAck[]> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(
          `${this.baseUrl}/api/session-store/${encodeURIComponent(sessionId)}/analysis-timeline`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ entries }),
            signal: controller.signal,
          }
        );
        if (!response.ok) {
          throw new Error(`append analysis timeline failed: HTTP ${response.status}`);
        }
        const value = await response.json();
        assertSessionStoreResponse(value, 'append analysis timeline failed');
        return analysisTimelineAcknowledgements(
          value,
          entries
        );
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`append analysis timeline failed: ${String(lastError)}`);
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

function analysisTimelineAcknowledgements(
  value: unknown,
  expectedEntries: readonly ProviderAnalysisTimelineEvent[]
): ProviderAnalysisTimelineAppendAck[] {
  const response = objectRecord(value);
  const data = objectRecord(response?.data);
  const appended = data?.appended;
  const tailRecordDigest = stringValue(data?.tailRecordDigest);
  const records = Array.isArray(data?.records) ? data.records : [];
  if (
    typeof appended !== 'number'
    || !Number.isSafeInteger(appended)
    || appended < 0
    || appended > expectedEntries.length
    || records.length !== expectedEntries.length
  ) {
    throw new Error(
      `append analysis timeline failed: invalid durable batch acknowledgement for ${expectedEntries.length} records`
    );
  }
  const acknowledgements = records.map((value, index) => {
    const record = objectRecord(value);
    const recordId = stringValue(record?.recordId);
    const analysisSeq = positiveInteger(record?.analysisSeq);
    const previousRecordDigest = stringValue(record?.previousRecordDigest);
    const recordDigest = stringValue(record?.recordDigest);
    const payloadDigest = stringValue(record?.payloadDigest);
    const sourcePayloadDigest = stringValue(record?.sourcePayloadDigest);
    const expectedEntry = expectedEntries[index]!;
    if (
      recordId !== expectedEntry.recordId
      || !analysisSeq
      || !recordDigest
      || !payloadDigest
      || sourcePayloadDigest !== expectedEntry.payloadDigest
    ) {
      throw new Error(
        `append analysis timeline failed: invalid durable acknowledgement for ${expectedEntry.recordId}`
      );
    }
    return {
      recordId,
      analysisSeq,
      previousRecordDigest,
      recordDigest,
      payloadDigest,
      sourcePayloadDigest,
    };
  });
  for (let index = 1; index < acknowledgements.length; index += 1) {
    if (
      acknowledgements[index]!.analysisSeq
      !== acknowledgements[index - 1]!.analysisSeq + 1
      || acknowledgements[index]!.previousRecordDigest
        !== acknowledgements[index - 1]!.recordDigest
    ) {
      throw new Error(
        `append analysis timeline failed: non-contiguous acknowledgement ${acknowledgements[index]!.analysisSeq}`
      );
    }
  }
  if (
    !tailRecordDigest
    || tailRecordDigest !== acknowledgements.at(-1)?.recordDigest
  ) {
    throw new Error(
      'append analysis timeline failed: durable tail does not match the final acknowledgement'
    );
  }
  return acknowledgements;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
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
