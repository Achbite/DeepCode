import type {
  AgentContextAttachment,
  AgentEvent,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import type {
  ConversationResourceRoot,
  ProjectWorkingDirectory,
} from '../context/types.js';
import type { AcceptedTaskPlanExecutionRoot } from './types.js';

export interface AcceptedPlanExecutionRootDecisionInput {
  projectWorkingDirectory?: ProjectWorkingDirectory;
  workspaceBinding?: AgentWorkspaceBinding;
}

export interface AcceptedPlanExecutionRootState {
  conversationRoots: ConversationResourceRoot[];
}

export class AcceptedPlanExecutionRootResolver {
  static fromDecision(
    input: AcceptedPlanExecutionRootDecisionInput,
    events: AgentEvent[]
  ): AcceptedTaskPlanExecutionRoot | undefined {
    const projectRoot = input.projectWorkingDirectory?.absolutePath ?? input.projectWorkingDirectory?.displayPath;
    if (projectRoot) {
      return {
        attachment: {
          kind: 'directory',
          path: input.projectWorkingDirectory?.displayPath ?? projectRoot,
          absolutePath: projectRoot,
          source: 'userSelected',
          scope: 'session',
          rootId: input.projectWorkingDirectory?.rootId,
        } as AgentContextAttachment,
        ref: projectRoot,
        source: 'projectWorkingDirectory',
      };
    }

    const recentAttachmentRoot = this.fromRecentDirectoryAttachments(events);
    if (recentAttachmentRoot) return recentAttachmentRoot;

    const packetRoot = this.fromResourcePackets(events);
    if (packetRoot) return packetRoot;

    if (input.workspaceBinding?.openPath) {
      return {
        attachment: {
          kind: 'directory',
          path: input.workspaceBinding.openPath,
          absolutePath: input.workspaceBinding.openPath,
          source: 'userSelected',
          scope: 'session',
        } as AgentContextAttachment,
        ref: input.workspaceBinding.openPath,
        source: 'workspaceBinding',
      };
    }
    return undefined;
  }

  static fromState(
    state: AcceptedPlanExecutionRootState
  ): AcceptedTaskPlanExecutionRoot | undefined {
    const root = state.conversationRoots.find((item) => item.primary) ?? state.conversationRoots[0];
    if (!root) return undefined;
    const ref = root.absolutePath ?? root.displayPath;
    if (!ref) return undefined;
    const source = this.source(root.source);
    return {
      attachment: {
        kind: 'directory',
        path: root.displayPath || ref,
        absolutePath: root.absolutePath ?? ref,
        source: 'userSelected',
        scope: 'session',
        rootId: root.rootId,
      } as AgentContextAttachment,
      ref,
      source,
    };
  }

  static toPayload(
    root: AcceptedTaskPlanExecutionRoot | undefined
  ): Record<string, unknown> | undefined {
    if (!root) return undefined;
    return {
      ref: root.ref,
      source: root.source,
      attachment: root.attachment,
    };
  }

  static fromPayload(
    payload: Record<string, unknown>
  ): AcceptedTaskPlanExecutionRoot | undefined {
    const root = objectRecord(payload.executionRoot);
    const attachmentRecord = objectRecord(root?.attachment);
    const ref = stringValue(root?.ref)
      ?? stringValue(attachmentRecord?.absolutePath)
      ?? stringValue(attachmentRecord?.path);
    const path = stringValue(attachmentRecord?.path) ?? ref;
    if (!root || !ref || !path) return undefined;
    const source = this.source(stringValue(root.source) ?? stringValue(attachmentRecord?.source));
    return {
      attachment: {
        kind: 'directory',
        path,
        absolutePath: stringValue(attachmentRecord?.absolutePath) ?? ref,
        source: 'userSelected',
        scope: 'session',
        rootId: stringValue(attachmentRecord?.rootId),
      } as AgentContextAttachment,
      ref,
      source,
    };
  }

  static attachmentsFromEvent(event: AgentEvent): AgentContextAttachment[] {
    const payload = objectRecord(event.payload);
    const attachments = Array.isArray(payload?.attachments)
      ? payload.attachments.filter((item): item is AgentContextAttachment => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    if (attachments.length) return attachments;
    const executionRoot = payload ? this.fromPayload(payload) : undefined;
    return executionRoot ? [executionRoot.attachment] : [];
  }

  static fromResourcePackets(events: AgentEvent[]): AcceptedTaskPlanExecutionRoot | undefined {
    const candidates = events
      .filter((event) => event.kind === 'tool_result')
      .flatMap((event) => {
        const payload = objectRecord(event.payload);
        const output = objectRecord(payload?.output);
        const items = Array.isArray(output?.items) ? output.items : [];
        return items.flatMap((item) => {
          const record = objectRecord(item);
          if (record?.contentKind !== 'directoryTree' && record?.resolvedKind !== 'directory') return [];
          const absolutePath = stringValue(record.absolutePath);
          const ref = absolutePath ?? stringValue(record.path);
          if (!ref) return [];
          return [{
            attachment: {
              kind: 'directory',
              path: stringValue(record.path) ?? ref,
              absolutePath: absolutePath ?? ref,
              source: 'userSelected',
              scope: 'session',
              rootId: stringValue(record.manifestEntryId),
            } as AgentContextAttachment,
            ref,
            source: 'recentAttachment' as const,
          }];
        });
      });
    if (candidates.length === 1) return candidates[0];
    return undefined;
  }

  private static fromRecentDirectoryAttachments(events: AgentEvent[]): AcceptedTaskPlanExecutionRoot | undefined {
    const attachments: AgentContextAttachment[] = [];
    for (const event of [...events].reverse()) {
      if (attachments.length >= 16) break;
      if (event.kind !== 'user_msg') continue;
      const payload = objectRecord(event.payload);
      const rawAttachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
      for (const item of rawAttachments) {
        const attachment = objectRecord(item) as AgentContextAttachment | undefined;
        if (!attachment || attachment.kind !== 'directory') continue;
        const ref = attachment.absolutePath ?? attachment.path;
        if (!ref) continue;
        attachments.push(attachment);
        if (attachments.length >= 16) break;
      }
    }
    const uniqueRefs = [...new Set(attachments.map((attachment) => comparablePath(attachment.absolutePath ?? attachment.path)))];
    if (uniqueRefs.length !== 1) return undefined;
    const attachment = attachments.find((item) => comparablePath(item.absolutePath ?? item.path) === uniqueRefs[0]);
    if (!attachment) return undefined;
    const ref = attachment.absolutePath ?? attachment.path;
    return {
      attachment: {
        ...attachment,
        path: attachment.path || ref,
        scope: attachment.scope ?? 'session',
      },
      ref,
      source: 'recentAttachment',
    };
  }

  private static source(value: string | undefined): AcceptedTaskPlanExecutionRoot['source'] {
    if (value === 'projectWorkingDirectory') return 'projectWorkingDirectory';
    if (value === 'workspaceBinding') return 'workspaceBinding';
    return 'recentAttachment';
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function comparablePath(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
}
