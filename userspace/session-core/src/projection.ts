import type { AgentEvent, PermissionRequest } from '@deepcode/protocol';
import type { TranscriptMessageEntry } from './transcript.js';

export interface PendingPermissionProjection {
  request: PermissionRequest;
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

export function findLatestPendingPermission(events: AgentEvent[]): PendingPermissionProjection | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === 'permission_result') return null;
    if (event.kind === 'permission_request') {
      return { request: event.payload as PermissionRequest };
    }
  }
  return null;
}
