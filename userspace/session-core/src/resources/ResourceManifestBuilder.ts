import type {
  AgentContextAttachment,
  AgentEvent,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import type {
  ConversationResourceRoot,
  ProjectWorkingDirectory,
  ResourceManifest,
  ResourceManifestEntry,
} from '../context/types.js';

export interface ResourceManifestBuildResult {
  manifest: ResourceManifest;
  conversationRoots: ConversationResourceRoot[];
}

export interface ResourceManifestBuilderInput {
  sessionId: string;
  attachments?: AgentContextAttachment[];
  existingEvents?: AgentEvent[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  projectId?: string;
  projectKind?: 'folder' | 'blank';
  projectRootStatus?: 'ready' | 'unbound' | 'unavailable';
  acceptedTaskPlan?: {
    executionRoot?: {
      ref: string;
      attachment: AgentContextAttachment;
    };
  };
}

export interface ResourceManifestBuilderPorts {
  maxDerivedManifestEntries: number;
  resourceManifestMaxBytes: number;
  comparablePath(value: string): string;
  isAbsolutePath(value: string): boolean;
}

export class ResourceManifestBuilder {
  constructor(private readonly ports: ResourceManifestBuilderPorts) {}

  build(input: ResourceManifestBuilderInput, id: string): ResourceManifestBuildResult {
    const entries: ResourceManifestEntry[] = [];
    const conversationRoots: ConversationResourceRoot[] = [];
    const seenEntryRefs = new Set<string>();
    const seenRootRefs = new Set<string>();
    const primaryRootRef = this.primaryConversationRootRef(input);

    const addAttachment = (
      attachment: AgentContextAttachment,
      index: number,
      source: ConversationResourceRoot['source'],
      reason: string,
      addToManifest = true
    ) => {
      if (attachment.kind !== 'file' && attachment.kind !== 'directory') return;
      const resourceRef = attachment.absolutePath ?? attachment.path;
      if (!resourceRef) return;
      const resourceId = attachment.resourceId ?? externalResourceId(attachment, this.ports.comparablePath(resourceRef));
      const refKey = this.ports.comparablePath(resourceRef);
      if (!addToManifest && seenRootRefs.has(refKey)) return;
      if (addToManifest && seenEntryRefs.has(refKey) && seenRootRefs.has(refKey)) return;
      const entry: ResourceManifestEntry = {
        id: this.manifestEntryId(attachment, index, source),
        kind: attachment.kind,
        label: `${attachment.kind === 'directory' ? 'Directory' : 'File'} ${attachment.path || resourceRef}`,
        resourceRef: '.',
        readPolicy: 'autoRead',
        reason,
        rootId: attachment.kind === 'directory' ? this.manifestEntryId(attachment, index, source) : undefined,
        resourceId,
      };
      if (addToManifest && !seenEntryRefs.has(refKey)) {
        seenEntryRefs.add(refKey);
        entries.push(entry);
      }
      if (attachment.kind === 'directory' && !seenRootRefs.has(refKey)) {
        seenRootRefs.add(refKey);
        conversationRoots.push({
          rootId: entry.id,
          kind: 'directory',
          label: entry.label,
          displayPath: attachment.path || resourceRef,
          absolutePath: attachment.absolutePath ?? (this.ports.isAbsolutePath(resourceRef) ? resourceRef : undefined),
          resourceId,
          source,
          primary: this.ports.comparablePath(resourceRef) === primaryRootRef,
        });
      }
    };

    if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
      const workingDirectory = input.projectWorkingDirectory;
      const resourceRef = workingDirectory.absolutePath ?? workingDirectory.displayPath;
      const refKey = this.ports.comparablePath(resourceRef);
      const rootId = workingDirectory.rootId || `project-root-${sanitizeId(workingDirectory.displayPath)}`;
      const label = workingDirectory.label || `Project workspace ${workingDirectory.displayPath}`;
      // Workspace roots are manifest entries so lifecycle initialization can seed provider-visible evidence before native read tools.
      if (!seenEntryRefs.has(refKey)) {
        seenEntryRefs.add(refKey);
        entries.push({
          id: rootId,
          kind: 'directory',
          label,
          resourceRef: '.',
          readPolicy: 'autoRead',
          reason: 'Project working directory for the current turn.',
          rootId,
          contextUse: 'workspaceBootstrap',
          directoryOptions: {
            maxDepth: 1,
            maxEntries: 200,
            includeContent: false,
          },
        });
      }
      if (!seenRootRefs.has(refKey)) {
        seenRootRefs.add(refKey);
        conversationRoots.push({
          ...workingDirectory,
          rootId,
          kind: 'directory',
          absolutePath: workingDirectory.absolutePath ?? (this.ports.isAbsolutePath(resourceRef) ? resourceRef : undefined),
          primary: this.ports.comparablePath(resourceRef) === primaryRootRef,
        });
      }
    }

    if (input.workspaceBinding?.openPath) {
      const resourceRef = input.workspaceBinding.openPath;
      const refKey = this.ports.comparablePath(resourceRef);
      const rootId = `editor-workspace-${sanitizeId(resourceRef)}`;
      const label = `Editor workspace ${resourceRef}`;
      // Editor workspace bindings follow the same initial-evidence path as explicit project roots.
      if (!seenEntryRefs.has(refKey)) {
        seenEntryRefs.add(refKey);
        entries.push({
          id: rootId,
          kind: 'directory',
          label,
          resourceRef: '.',
          readPolicy: 'autoRead',
          reason: 'Editor workspace binding for the current turn.',
          rootId,
          contextUse: 'workspaceBootstrap',
          directoryOptions: {
            maxDepth: 1,
            maxEntries: 200,
            includeContent: false,
          },
        });
      }
      if (!seenRootRefs.has(refKey)) {
        seenRootRefs.add(refKey);
        conversationRoots.push({
          rootId,
          kind: 'directory',
          label,
          displayPath: resourceRef,
          absolutePath: resourceRef,
          source: 'workspaceBinding',
          primary: this.ports.comparablePath(resourceRef) === primaryRootRef,
        });
      }
    }

    (input.attachments ?? []).forEach((attachment, index) => {
      addAttachment(
        attachment,
        index,
        attachment.scope === 'session' ? 'sessionAttachment' : 'currentAttachment',
        'Explicit user attachment for the current user turn.'
      );
    });

    this.recentAttachmentFacts(input.existingEvents ?? []).forEach((attachment, index) => {
      addAttachment(
        attachment,
        index,
        'recentAttachment',
        'Recent explicit user attachment selected from session projection.',
        false
      );
    });

    const workspaceScopeKey = [
      input.workspaceBinding?.workspaceId,
      input.workspaceBinding?.workspaceHash,
      input.workspaceBinding?.openPath,
      input.workspaceBinding?.activeFolderId,
    ].filter(Boolean).join(':') || `session:${input.sessionId}:${conversationRoots[0]?.rootId ?? 'no-root'}`;
    return {
      manifest: {
        id,
        workspaceScopeKey,
        workspaceId: input.workspaceBinding?.workspaceId,
        workspaceBindingHash: input.workspaceBinding?.workspaceHash,
        projectId: input.projectId,
        projectKind: input.projectKind,
        projectRootStatus: input.projectRootStatus,
        entries,
        budget: {
          maxEntries: Math.max(this.ports.maxDerivedManifestEntries, entries.length),
          maxBytes: this.ports.resourceManifestMaxBytes,
        },
        defaultDenyPatterns: [],
      },
      conversationRoots,
    };
  }

  kernelRunAttachments(input: ResourceManifestBuilderInput): AgentContextAttachment[] {
    const attachments: AgentContextAttachment[] = [];
    if (input.acceptedTaskPlan?.executionRoot) {
      const executionRoot = input.acceptedTaskPlan.executionRoot;
      const projectRoot = input.projectWorkingDirectory?.absolutePath ?? input.projectWorkingDirectory?.displayPath;
      if (!input.projectId || !projectRoot || this.ports.comparablePath(executionRoot.ref) !== this.ports.comparablePath(projectRoot)) {
        attachments.push(executionRoot.attachment);
      }
    }
    attachments.push(...this.uniqueAttachments(input.attachments ?? []));
    const directoryAttachments = attachments.filter((attachment) => attachment.kind === 'directory');
    if (directoryAttachments.length === 0 && !input.projectWorkingDirectory) {
      const recentDirectories = this.uniqueAttachments(this.recentAttachmentFacts(input.existingEvents ?? []))
        .filter((attachment) => attachment.kind === 'directory');
      if (recentDirectories.length === 1) {
        attachments.push({
          ...recentDirectories[0],
          scope: recentDirectories[0].scope ?? 'session',
        });
      }
    }
    return this.uniqueAttachments(attachments).map((attachment) => {
      const ref = attachment.absolutePath ?? attachment.path;
      return {
        ...attachment,
        resourceId: attachment.resourceId ?? externalResourceId(attachment, this.ports.comparablePath(ref)),
      };
    });
  }

  primaryConversationRootRef(input: ResourceManifestBuilderInput): string | undefined {
    if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
      return this.ports.comparablePath(input.projectWorkingDirectory.absolutePath ?? input.projectWorkingDirectory.displayPath);
    }
    if (input.workspaceBinding?.openPath) {
      return this.ports.comparablePath(input.workspaceBinding.openPath);
    }
    if (input.acceptedTaskPlan?.executionRoot?.ref) {
      return this.ports.comparablePath(input.acceptedTaskPlan.executionRoot.ref);
    }
    const currentDirectories = (input.attachments ?? [])
      .filter((attachment) => attachment.kind === 'directory')
      .map((attachment) => attachment.absolutePath ?? attachment.path)
      .filter((value): value is string => Boolean(value && value.trim()));
    if (currentDirectories.length === 1) return this.ports.comparablePath(currentDirectories[0]);
    const recentDirectories = this.recentAttachmentFacts(input.existingEvents ?? [])
      .filter((attachment) => attachment.kind === 'directory')
      .map((attachment) => attachment.absolutePath ?? attachment.path)
      .filter((value): value is string => Boolean(value && value.trim()));
    const unique = [...new Set(recentDirectories.map((value) => this.ports.comparablePath(value)))];
    return unique.length === 1 ? unique[0] : undefined;
  }

  uniqueAttachments(attachments: AgentContextAttachment[]): AgentContextAttachment[] {
    const output: AgentContextAttachment[] = [];
    const seen = new Set<string>();
    for (const attachment of attachments) {
      const ref = attachment.absolutePath ?? attachment.path;
      if (!ref) continue;
      const key = `${attachment.kind}:${this.ports.comparablePath(ref)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(attachment);
    }
    return output;
  }

  recentAttachmentFacts(events: AgentEvent[]): AgentContextAttachment[] {
    const output: AgentContextAttachment[] = [];
    for (const event of [...events].reverse()) {
      if (output.length >= 16) break;
      if (event.kind !== 'user_msg') continue;
      const payload = objectRecord(event.payload);
      const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
      for (const item of attachments) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const attachment = item as AgentContextAttachment;
        if (attachment.kind !== 'file' && attachment.kind !== 'directory') continue;
        if (!attachment.path && !attachment.absolutePath) continue;
        output.push(attachment);
        if (output.length >= 16) break;
      }
    }
    return output;
  }

  private manifestEntryId(
    attachment: AgentContextAttachment,
    index: number,
    source: ConversationResourceRoot['source']
  ): string {
    const sourceRef = attachment.path || attachment.absolutePath || `attachment-${index}`;
    const base = sanitizeId(sourceRef).slice(0, 96);
    const prefix = source === 'recentAttachment' ? 'recent-attachment' : 'attachment';
    return `${prefix}-${index}-${base || 'resource'}`;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 128) || 'resource';
}

function externalResourceId(attachment: AgentContextAttachment, comparableRef: string): string {
  let hash = 0x811c9dc5;
  const input = `${attachment.kind}:${comparableRef}`;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `external-resource-${hash.toString(16).padStart(8, '0')}`;
}
