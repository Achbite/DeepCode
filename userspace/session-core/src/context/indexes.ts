export interface ProjectIndexEntry {
  id: string;
  kind: 'file' | 'directory' | 'manifest' | 'entrypoint' | 'test' | 'module' | 'ruler';
  path?: string;
  symbol?: string;
  summary: string;
  tags: string[];
}

export interface ProjectIndex {
  id: string;
  workspaceScopeKey: string;
  workspaceTreeHash?: string;
  schemaVersion: '1';
  entries: ProjectIndexEntry[];
  generatedAt: string;
  stale: boolean;
}

export interface CheckpointGraphNode {
  id: string;
  requirementId: string;
  reviewDecision: 'accepted' | 'revisionRequested' | 'backlog';
  summary: string;
  changedFiles: string[];
  auditRefs: string[];
}

export interface CheckpointGraph {
  id: string;
  workspaceScopeKey: string;
  schemaVersion: '1';
  nodes: CheckpointGraphNode[];
  source: 'eventLedgerDerived';
}

export interface SymbolHistoryIndexEntry {
  symbol: string;
  path: string;
  checkpointIds: string[];
  summary: string;
}

export interface SymbolHistoryIndex {
  id: string;
  workspaceScopeKey: string;
  schemaVersion: '1';
  entries: SymbolHistoryIndexEntry[];
  source: 'checkpointGraphDerived';
}

export interface ContextLayering {
  workspaceScopeKey: string;
  initialPacketEntryIds: string[];
  onDemandEntryIds: string[];
  excludedEntryIds: string[];
  budgetBytes: number;
}

export function createProjectIndex(input: {
  id: string;
  workspaceScopeKey: string;
  entries: ProjectIndexEntry[];
  workspaceTreeHash?: string;
  generatedAt?: string;
}): ProjectIndex {
  return {
    id: input.id,
    workspaceScopeKey: input.workspaceScopeKey,
    workspaceTreeHash: input.workspaceTreeHash,
    schemaVersion: '1',
    entries: [...input.entries].sort((left, right) => left.id.localeCompare(right.id)),
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    stale: false,
  };
}

export function deriveContextLayering(input: {
  projectIndex: ProjectIndex;
  initialKinds: ProjectIndexEntry['kind'][];
  budgetBytes: number;
}): ContextLayering {
  const initial = input.projectIndex.entries.filter((entry) => input.initialKinds.includes(entry.kind)).map((entry) => entry.id);
  const initialSet = new Set(initial);
  return {
    workspaceScopeKey: input.projectIndex.workspaceScopeKey,
    initialPacketEntryIds: initial,
    onDemandEntryIds: input.projectIndex.entries.filter((entry) => !initialSet.has(entry.id)).map((entry) => entry.id),
    excludedEntryIds: input.projectIndex.stale ? input.projectIndex.entries.map((entry) => entry.id) : [],
    budgetBytes: input.budgetBytes,
  };
}
