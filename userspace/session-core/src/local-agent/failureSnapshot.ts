import type { LocalAgentError, NewSessionEvent } from '@deepcode/protocol';
import type { LoopSnapshot } from './loop.js';

/** A bounded index into the journal, not a second copy of the conversation. */
export function failureSnapshotEvent(snapshot: LoopSnapshot, runId: string, error: LocalAgentError): NewSessionEvent {
  const events = snapshot.events.filter((event) => 'runId' in event && event.runId === runId);
  const attempts = events.filter((event) => event.type === 'provider.attempt.updated');
  const providerRequestId = attempts.at(-1)?.payload.providerRequestId;
  const tools = events.filter((event) => event.type === 'tool.completed');
  const terminalCalls = new Set(events.flatMap((event) => event.type === 'tool.completed' || event.type === 'tool.interrupted' ? [event.callId] : []));
  const lastMessage = snapshot.state.messages.at(-1);
  return { type: 'run.failure.recorded', sessionId: snapshot.state.sessionId, runId,
    payload: { revision: snapshot.state.revision, phase: error.diagnostics?.phase ?? 'loop', error,
      ...(providerRequestId ? { providerRequestId } : {}),
      providerAttemptIds: [...new Set(attempts.map((event) => event.payload.providerAttemptId))],
      ...(lastMessage ? { lastMessageId: lastMessage.messageId } : {}),
      toolRecordIds: tools.map((event) => event.payload.record.recordId),
      pendingCallIds: events.flatMap((event) => event.type === 'tool.requested' && !terminalCalls.has(event.callId) ? [event.callId] : []),
      queuedMessageIds: snapshot.state.queuedInputs.filter((input) => input.runId === runId).map((input) => input.messageId),
      planRef: snapshot.state.activePlanRef ? { ...snapshot.state.activePlanRef } : null,
    } };
}
