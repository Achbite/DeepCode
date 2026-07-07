import type { AgentEvent, PermissionRequest } from '@deepcode/protocol';
import {
  findActiveInteraction,
  type InteractionLedgerActiveInteraction,
} from '@deepcode/session-core';

export type ActiveSessionInteraction = InteractionLedgerActiveInteraction;

export function findActiveSessionInteraction(input: {
  events: readonly AgentEvent[];
  pendingPermission?: PermissionRequest | null;
}): ActiveSessionInteraction | null {
  return findActiveInteraction(input);
}
