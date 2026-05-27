import type {
  AgentContextAttachment,
  AgentEvent,
  AgentWorkspaceBinding,
  ListAgentSessionsRequest,
  PermissionRequest,
  WorkspaceFolderSpec,
  WorkspaceSpec,
} from '@deepcode/protocol';

export interface WorkspaceBindingInput {
  current?: WorkspaceSpec | null;
  activeFolder?: WorkspaceFolderSpec | null;
  activeFolderId?: string;
}

export interface PendingPermissionProjection {
  request: PermissionRequest;
}

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

export interface PromptHistoryEntry {
  id: string;
  sessionId: string;
  workspaceScopeKey: string;
  content: string;
  contentHash?: string;
  createdAt: string;
  source: 'composer' | 'continue' | 'retry';
}

export interface SidechainEntry {
  sidechainId: string;
  sessionId: string;
  runId?: string;
  kind: 'skill' | 'validator' | 'browser' | 'subrun';
  summary?: string;
  kernelEventRefs: string[];
  createdAt: string;
}

export interface SessionProjectionCard {
  id: string;
  sessionId?: string;
  kind: 'progress' | 'tool' | 'stage' | 'permission' | 'review' | 'error';
  kernelEventRef?: string;
  title: string;
  detail?: string;
  createdAt: string;
}

export interface SessionProjection {
  messages: TranscriptMessageEntry[];
  cards: SessionProjectionCard[];
}

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

export class ProjectionEngine {
  projectKernelEvents(events: unknown[], sessionId?: string): SessionProjectionCard[] {
    return events.map((event, index) => {
      const value = event as Record<string, unknown>;
      const kind = typeof value.kind === 'string' ? value.kind : 'kernel.event';
      return {
        id: `${kind}-${index}`,
        sessionId,
        kind: this.cardKind(kind),
        kernelEventRef: this.eventRef(value, index),
        title: kind,
        detail: typeof value.summary === 'string' ? value.summary : undefined,
        createdAt: new Date().toISOString(),
      };
    });
  }

  private cardKind(kind: string): SessionProjectionCard['kind'] {
    if (kind.includes('permission')) return 'permission';
    if (kind.includes('tool') || kind.includes('workspace') || kind.includes('skill')) return 'tool';
    if (kind.includes('stage') || kind.includes('workflow')) return 'stage';
    if (kind.includes('review')) return 'review';
    if (kind === 'error') return 'error';
    return 'progress';
  }

  private eventRef(event: Record<string, unknown>, index: number): string {
    const sequence = event.sequence;
    if (typeof sequence === 'number') return `kernel:${sequence}`;
    const requestId = event.requestId;
    if (typeof requestId === 'string') return `kernel:${requestId}`;
    return `kernel:event:${index}`;
  }
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

export interface ResumeView {
  session: SessionIndexEntry;
  messages: TranscriptMessageEntry[];
  cards: SessionProjectionCard[];
}

export class ResumeLoader {
  constructor(
    private readonly transcriptStore: TranscriptStore,
    private readonly projector = new ProjectionEngine()
  ) {}

  async load(session: SessionIndexEntry, kernelEvents: unknown[] = []): Promise<ResumeView> {
    const entries = await this.transcriptStore.list(session.sessionId);
    return {
      session,
      messages: TranscriptChain.rebuild(entries, session.leafUuid),
      cards: this.projector.projectKernelEvents(kernelEvents, session.sessionId),
    };
  }
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

export function createSessionUuid(): string {
  const random = globalThis.crypto?.randomUUID?.();
  if (random) return random;
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function simpleWorkspaceHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ws-${(hash >>> 0).toString(16)}`;
}

export function createWorkspaceScope(workspace?: WorkspaceSpec | null): ListAgentSessionsRequest {
  if (!workspace) return {};
  const workspaceKey = workspace.folders
    .map((folder) => folder.absolutePath || folder.originalPath || folder.id)
    .join('|');
  return {
    workspaceId: workspace.id,
    workspaceHash: workspaceKey ? simpleWorkspaceHash(workspaceKey) : workspace.id,
  };
}

export function createWorkspaceScopeKey(workspace?: WorkspaceSpec | null): string {
  const scope = createWorkspaceScope(workspace);
  return scope.workspaceHash ?? scope.workspaceId ?? 'no-workspace';
}

export function createWorkspaceBinding(input: WorkspaceBindingInput): AgentWorkspaceBinding | undefined {
  const workspace = input.current;
  if (!workspace) return undefined;

  const activeFolder = input.activeFolder ?? workspace.folders[0];
  const openPath = workspace.sourcePath ?? activeFolder?.absolutePath ?? workspace.folders[0]?.absolutePath;
  if (!openPath) return undefined;

  const scope = createWorkspaceScope(workspace);
  const folderKey = activeFolder?.absolutePath ?? activeFolder?.originalPath ?? activeFolder?.id;
  return {
    workspaceId: workspace.id,
    workspaceHash: scope.workspaceHash,
    openPath,
    activeFolderId: activeFolder?.id ?? input.activeFolderId ?? workspace.folders[0]?.id,
    folderHash: folderKey ? simpleWorkspaceHash(folderKey) : undefined,
  };
}

export function mergeContextAttachment(
  list: AgentContextAttachment[],
  next: AgentContextAttachment
): AgentContextAttachment[] {
  const key = `${next.folderId ?? ''}:${next.path}`;
  const filtered = list.filter((item) => `${item.folderId ?? ''}:${item.path}` !== key);
  return [...filtered, next];
}

export function findLatestPendingPermission(
  events: AgentEvent[]
): PendingPermissionProjection | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'permission_result') return null;
    if (event.kind === 'permission_request') {
      return { request: event.payload as PermissionRequest };
    }
  }
  return null;
}

export function assertUserSessionLayerOnly(): true {
  return true;
}
