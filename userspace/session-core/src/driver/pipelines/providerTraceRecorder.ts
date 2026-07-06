import type { TranscriptEntry } from '../../transcript.js';
import { ProviderTraceArchive } from '../../provider/ProviderTraceArchive.js';

export interface ProviderTraceRecorderState {
  sessionId: string;
  runId: string;
}

export interface ProviderTraceRecorderPorts {
  appendTranscript?: (sessionId: string, entry: TranscriptEntry) => Promise<void>;
  createId?: (prefix: string) => string;
  now?: () => string;
}

export class ProviderTraceRecorder {
  async append(
    state: ProviderTraceRecorderState,
    stage: string,
    payload: unknown,
    ports: ProviderTraceRecorderPorts
  ): Promise<void> {
    await ports.appendTranscript?.(state.sessionId, {
      type: 'metadata',
      uuid: ports.createId?.(`provider-trace-${stage}`) ?? fallbackId(`provider-trace-${stage}`),
      sessionId: state.sessionId,
      kind: 'provider_trace',
      payload: {
        stage,
        runId: state.runId,
        payload: ProviderTraceArchive.archivePayload(stage, payload),
      },
      createdAt: ports.now?.() ?? new Date().toISOString(),
    });
  }
}

function fallbackId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
