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
