import type { AgentEvent } from '@deepcode/protocol';

export interface ProviderCommitBufferState {
  pendingProviderCommitEvents?: AgentEvent[];
  providerCommitDeferred?: boolean;
}

export function deferProviderCommitEvents(state: ProviderCommitBufferState): void {
  state.providerCommitDeferred = true;
}

export function providerCommitEventsDeferred(state: ProviderCommitBufferState): boolean {
  return state.providerCommitDeferred === true;
}

export function queueProviderCommitEvents(
  state: ProviderCommitBufferState,
  events: AgentEvent[]
): void {
  if (events.length === 0) return;
  state.pendingProviderCommitEvents ??= [];
  state.pendingProviderCommitEvents.push(...events);
}

export function takeProviderCommitEvents(state: ProviderCommitBufferState): AgentEvent[] {
  const events = state.pendingProviderCommitEvents ?? [];
  state.pendingProviderCommitEvents = [];
  state.providerCommitDeferred = false;
  return events;
}
