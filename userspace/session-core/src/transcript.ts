export type TranscriptRole = 'user' | 'assistant' | 'system' | 'tool';
export type TranscriptChannel = 'user' | 'progress' | 'observation' | 'final' | 'tool' | 'error';
export type TranscriptMetadataKind =
  | 'compact_boundary'
  | 'context_projection'
  | 'sidechain_ref'
  | 'content_replacement';

export interface SessionIndexEntry {
  sessionId: string;
  workspaceScopeKey: string;
  title: string;
  leafUuid?: string;
  lastRunId?: string;
  updatedAt: string;
}

export interface SessionIndex {
  sessions: SessionIndexEntry[];
}

export interface TranscriptMessageEntry {
  type: 'message';
  uuid: string;
  parentUuid?: string;
  sessionId: string;
  runId?: string;
  role: TranscriptRole;
  channel: TranscriptChannel;
  content?: string;
  kernelEventRefs: string[];
  visible: boolean;
  createdAt: string;
}

export interface TranscriptMetadataEntry {
  type: 'metadata';
  uuid: string;
  sessionId: string;
  kind: TranscriptMetadataKind;
  payload: unknown;
  createdAt: string;
}

export type TranscriptEntry = TranscriptMessageEntry | TranscriptMetadataEntry;

export interface TranscriptStore {
  append(entry: TranscriptEntry): Promise<void>;
  list(sessionId: string): Promise<TranscriptEntry[]>;
}

export class MemoryTranscriptStore implements TranscriptStore {
  private readonly entriesBySession = new Map<string, TranscriptEntry[]>();

  async append(entry: TranscriptEntry): Promise<void> {
    const entries = this.entriesBySession.get(entry.sessionId) ?? [];
    entries.push(entry);
    this.entriesBySession.set(entry.sessionId, entries);
  }

  async list(sessionId: string): Promise<TranscriptEntry[]> {
    return [...(this.entriesBySession.get(sessionId) ?? [])];
  }
}

export class TranscriptChain {
  static visibleMessages(entries: TranscriptEntry[]): TranscriptMessageEntry[] {
    return entries
      .filter((entry): entry is TranscriptMessageEntry => entry.type === 'message' && entry.visible)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  static rebuild(entries: TranscriptEntry[], leafUuid?: string): TranscriptMessageEntry[] {
    const messages = entries.filter(
      (entry): entry is TranscriptMessageEntry => entry.type === 'message' && entry.visible
    );
    const byId = new Map(messages.map((entry) => [entry.uuid, entry]));
    const leaf = leafUuid ? byId.get(leafUuid) : messages[messages.length - 1];
    if (!leaf) return [];

    const chain: TranscriptMessageEntry[] = [];
    const seen = new Set<string>();
    let current: TranscriptMessageEntry | undefined = leaf;
    while (current && !seen.has(current.uuid)) {
      chain.push(current);
      seen.add(current.uuid);
      current = current.parentUuid ? byId.get(current.parentUuid) : undefined;
    }
    return chain.reverse();
  }
}

export function createSessionUuid(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createTranscriptMessage(input: {
  sessionId: string;
  parentUuid?: string;
  runId?: string;
  role: TranscriptRole;
  channel: TranscriptChannel;
  content?: string;
  kernelEventRefs?: string[];
  visible?: boolean;
}): TranscriptMessageEntry {
  return {
    type: 'message',
    uuid: createSessionUuid(),
    parentUuid: input.parentUuid,
    sessionId: input.sessionId,
    runId: input.runId,
    role: input.role,
    channel: input.channel,
    content: input.content,
    kernelEventRefs: input.kernelEventRefs ?? [],
    visible: input.visible ?? true,
    createdAt: new Date().toISOString(),
  };
}

export async function appendUserMessageBeforeKernelDispatch(
  store: TranscriptStore,
  input: { sessionId: string; parentUuid?: string; content: string }
): Promise<TranscriptMessageEntry> {
  const entry = createTranscriptMessage({
    sessionId: input.sessionId,
    parentUuid: input.parentUuid,
    role: 'user',
    channel: 'user',
    content: input.content,
  });
  await store.append(entry);
  return entry;
}
