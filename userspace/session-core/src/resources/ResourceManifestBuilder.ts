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
  acceptedImplementationPlan?: {
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
  sanitizeId(value: string): string;
  objectRecord(value: unknown): Record<string, unknown> | undefined;
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
      const refKey = this.ports.comparablePath(resourceRef);
      if (!addToManifest && seenRootRefs.has(refKey)) return;
      if (addToManifest && seenEntryRefs.has(refKey) && seenRootRefs.has(refKey)) return;
      const entry: ResourceManifestEntry = {
        id: this.manifestEntryId(attachment, index, source),
        kind: attachment.kind,
        label: `${attachment.kind === 'directory' ? 'Directory' : 'File'} ${attachment.path || resourceRef}`,
        resourceRef,
        readPolicy: 'autoRead',
        reason,
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
          source,
          primary: this.ports.comparablePath(resourceRef) === primaryRootRef,
        });
      }
    };

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

    if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
      const workingDirectory = input.projectWorkingDirectory;
      const resourceRef = workingDirectory.absolutePath ?? workingDirectory.displayPath;
      const refKey = this.ports.comparablePath(resourceRef);
      if (!seenRootRefs.has(refKey)) {
        seenRootRefs.add(refKey);
        conversationRoots.push({
          ...workingDirectory,
          rootId: workingDirectory.rootId || `project-root-${this.ports.sanitizeId(workingDirectory.displayPath)}`,
          kind: 'directory',
          absolutePath: workingDirectory.absolutePath ?? (this.ports.isAbsolutePath(resourceRef) ? resourceRef : undefined),
          primary: this.ports.comparablePath(resourceRef) === primaryRootRef,
        });
      }
    }

    if (input.workspaceBinding?.openPath) {
      const resourceRef = input.workspaceBinding.openPath;
      const refKey = this.ports.comparablePath(resourceRef);
      if (!seenRootRefs.has(refKey)) {
        seenRootRefs.add(refKey);
        conversationRoots.push({
          rootId: `editor-workspace-${this.ports.sanitizeId(resourceRef)}`,
          kind: 'directory',
          label: `Editor workspace ${resourceRef}`,
          displayPath: resourceRef,
          absolutePath: resourceRef,
          source: 'workspaceBinding',
          primary: this.ports.comparablePath(resourceRef) === primaryRootRef,
        });
      }
    }

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
    if (input.acceptedImplementationPlan?.executionRoot) {
      return this.uniqueAttachments([input.acceptedImplementationPlan.executionRoot.attachment]);
    }
    const attachments = this.uniqueAttachments(input.attachments ?? []);
    if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
      const workingDirectory = input.projectWorkingDirectory;
      attachments.push({
        kind: 'directory',
        path: workingDirectory.displayPath,
        absolutePath: workingDirectory.absolutePath,
        source: 'userSelected',
        scope: 'session',
        rootId: workingDirectory.rootId,
      } as AgentContextAttachment);
    }
    const directoryAttachments = attachments.filter((attachment) => attachment.kind === 'directory');
    if (directoryAttachments.length === 0) {
      const recentDirectories = this.uniqueAttachments(this.recentAttachmentFacts(input.existingEvents ?? []))
        .filter((attachment) => attachment.kind === 'directory');
      if (recentDirectories.length === 1) {
        attachments.push({
          ...recentDirectories[0],
          scope: recentDirectories[0].scope ?? 'session',
        });
      }
    }
    return this.uniqueAttachments(attachments);
  }

  primaryConversationRootRef(input: ResourceManifestBuilderInput): string | undefined {
    if (input.acceptedImplementationPlan?.executionRoot?.ref) {
      return this.ports.comparablePath(input.acceptedImplementationPlan.executionRoot.ref);
    }
    const currentDirectories = (input.attachments ?? [])
      .filter((attachment) => attachment.kind === 'directory')
      .map((attachment) => attachment.absolutePath ?? attachment.path)
      .filter((value): value is string => Boolean(value && value.trim()));
    if (currentDirectories.length === 1) return this.ports.comparablePath(currentDirectories[0]);
    if (input.projectWorkingDirectory?.absolutePath || input.projectWorkingDirectory?.displayPath) {
      return this.ports.comparablePath(input.projectWorkingDirectory.absolutePath ?? input.projectWorkingDirectory.displayPath);
    }
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
      const payload = this.ports.objectRecord(event.payload);
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
    const base = (attachment.path || attachment.absolutePath || `attachment-${index}`)
      .replace(/[^a-zA-Z0-9._/-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 96);
    const prefix = source === 'recentAttachment' ? 'recent-attachment' : 'attachment';
    return `${prefix}-${index}-${base || 'resource'}`;
  }
}
