import { SESSION_EVENT_VERSION } from '@deepcode/protocol';
import type { CommandReply, ConversationCommand, NewSessionEvent, SessionEvent } from '@deepcode/protocol';
import { loopSnapshot, pendingToolRequests, type LoopSnapshot } from './loop.js';
import { reduceSession } from './reducer.js';
import { planProgressEvidence } from './planStage.js';

/** New writes are admitted here; replay preserves already-recorded failure facts. */
export function admitSessionEvents(
  current: LoopSnapshot,
  events: readonly NewSessionEvent[],
  command?: { input: ConversationCommand; reply: Omit<CommandReply, 'revision'> },
): void {
  if (command) admitCommandBatch(command.input, events, command.reply);
  let snapshot = current;
  for (const event of events) {
    admitEvent(snapshot, event);
    const candidate = {
      ...event, schemaVersion: SESSION_EVENT_VERSION,
      eventId: 'admission', sequence: snapshot.state.revision + 1,
      occurredAt: '1970-01-01T00:00:00.000Z',
    } as SessionEvent;
    const journalEvents = [...snapshot.journalEvents, candidate];
    snapshot = event.type === 'conversation.revised'
      ? loopSnapshot(current.state.sessionId, journalEvents)
      : { journalEvents, events: [...snapshot.events, candidate], state: reduceSession(snapshot.state, candidate) };
  }
}

function admitCommandBatch(command: ConversationCommand, events: readonly NewSessionEvent[], reply: Omit<CommandReply, 'revision'>): void {
  if (reply.sessionId !== command.sessionId || reply.commandId !== command.commandId
    || events.some((event) => event.sessionId !== command.sessionId)) throw new Error('session_command_identity_mismatch');
  if (reply.status === 'rejected') {
    if (events.length) throw new Error('rejected_command_event_batch_invalid');
    return;
  }
  if (command.type !== 'plan.respond') return;
  const decisions = events.filter((event) => (event.type === 'plan.confirmed'
    || event.type === 'plan.revision.requested' || event.type === 'plan.cancelled')
    && event.payload.planId === command.planId && event.payload.revision === command.revision
    && event.payload.commandId === command.commandId);
  const todos = events.filter((event) => (event.type === 'todo.seeded' || event.type === 'todo.reconciled')
    && event.payload.sourcePlanId === command.planId && event.payload.sourcePlanRevision === command.revision);
  const expected = { confirm: 'plan.confirmed', requestRevision: 'plan.revision.requested', cancel: 'plan.cancelled' } as const;
  if (decisions.length !== 1 || decisions[0].type !== expected[command.response.kind]
    || todos.length !== (command.response.kind === 'confirm' ? 1 : 0)) throw new Error('plan_command_event_batch_invalid');
}

function admitEvent(snapshot: LoopSnapshot, event: NewSessionEvent): void {
  const { state, events } = snapshot;
  if (event.sessionId !== state.sessionId) throw new Error('session_event_identity_mismatch');
  const runId = 'runId' in event ? event.runId : undefined;
  const pendingProvider = state.contextCompositions.some((receipt) => receipt.runId === runId
    && !state.providerTurns[receipt.providerRequestId]);
  const userInput = event.type === 'input.accepted' || event.type === 'message.committed' && event.payload.role !== 'assistant';
  if (runId && event.type !== 'run.started' && !userInput
    && (state.run?.runId !== runId || state.tokenUsageHistory[runId]?.outcome)) {
    throw new Error('session_event_run_not_active');
  }
  switch (event.type) {
    case 'session.created':
      if (state.revision !== 0) throw new Error('session_creation_duplicate');
      break;
    case 'run.started':
      if (state.run && ['running', 'waiting', 'releasing', 'releaseFailed'].includes(state.run.status)) {
        throw new Error('session_run_already_active');
      }
      break;
    case 'conversation.revised': {
      const source = snapshot.journalEvents.find((item) => item.sequence === event.payload.fromSequence);
      if (event.payload.throughSequence !== state.revision || source?.type !== 'input.accepted'
        || source.payload.messageId !== event.payload.messageId) {
        throw new Error('conversation_revision_range_invalid');
      }
      break;
    }
    case 'message.committed':
    case 'narrative.committed':
      if ('providerRequestId' in event.payload) {
        const requestId = event.payload.providerRequestId;
        if (state.messages.some((message) => message.role === 'assistant' && message.runId === runId
          && message.providerRequestId === requestId)) throw new Error('provider_output_duplicate');
      }
      break;
    case 'interaction.requested':
      if (state.activities['interaction:' + event.payload.interactionId]) throw new Error('interaction_identity_duplicate');
      // Provider-origin calls must belong to the unfinished composition.
    case 'tool.requested':
    case 'plan.published':
    case 'session.control.rejected':
      if (!pendingProvider) throw new Error('provider_turn_composition_missing');
      break;
    case 'todo.seeded':
    case 'todo.reconciled':
      if (state.activePlanRef?.planId !== event.payload.sourcePlanId
        || state.activePlanRef.revision !== event.payload.sourcePlanRevision) throw new Error('todo_source_plan_inactive');
      break;
    case 'todo.progressed': {
      if (event.callId && !pendingProvider) throw new Error('provider_turn_composition_missing');
      const error = planProgressEvidence(events, event.runId, event.payload.sourceFactRef, event.payload.updates);
      if (error) throw new Error(error.code);
      break;
    }
    case 'plan.superseded':
      if (event.payload.planId === event.payload.supersededByPlanId
        && event.payload.revision === event.payload.supersededByRevision) throw new Error('plan_supersede_invalid');
      break;
    case 'plan.invalidated':
      if (state.activePlanRef?.planId !== event.payload.planId || state.activePlanRef.revision !== event.payload.revision) {
        throw new Error('plan_invalidation_inactive');
      }
      break;
    case 'context.compaction.requested':
      if (event.payload.coveredThroughSequence > state.revision) throw new Error('context_compaction_cutoff_invalid');
      if (events.some((item) => item.type === 'context.compaction.requested'
        && (item.payload.compactionId === event.payload.compactionId
          || item.payload.providerRequestId === event.payload.providerRequestId))) throw new Error('context_compaction_identity_duplicate');
      break;
    case 'context.compacted': {
      const request = events.find((item) => item.type === 'context.compaction.requested'
        && item.runId === runId && item.payload.compactionId === event.payload.compactionId);
      if (!request || request.type !== 'context.compaction.requested') throw new Error('context_compaction_request_missing');
      if (request.payload.providerRequestId !== event.payload.providerRequestId
        || request.payload.trigger !== event.payload.trigger
        || request.payload.coveredThroughSequence !== event.payload.coveredThroughSequence) throw new Error('context_compaction_completion_mismatch');
      if (events.some((item) => item.type === 'context.compacted'
        && item.payload.compactionId === event.payload.compactionId)) throw new Error('context_compaction_completion_invalid');
      break;
    }
    case 'run.tools.prepared':
      if (pendingProvider) throw new Error('provider_turn_still_active');
      break;
    case 'context.composed': {
      if (pendingProvider) throw new Error('provider_turn_still_active');
      const compaction = events.some((item) => item.type === 'context.compaction.requested'
        && item.runId === runId && item.payload.providerRequestId === event.payload.providerRequestId);
      if ((event.payload.purpose === 'contextCompaction') !== compaction) throw new Error('context_composition_purpose_mismatch');
      const runtime = state.runRuntimeSnapshots[event.runId];
      const view = state.runToolViews[event.runId] ?? runtime;
      if (event.payload.kernelCatalogSnapshotRef && event.payload.kernelCatalogSnapshotRef !== view.kernelCatalogSnapshotRef) {
        throw new Error('tool_request_binding_missing');
      }
      const hosted = event.payload.tools.filter((tool) => tool.origin === 'providerHosted').length;
      if (hosted !== Number(event.payload.purpose === 'agent' && runtime.webSearch.owner === 'providerHosted')) {
        throw new Error('context_composition_search_owner_mismatch');
      }
      break;
    }
    case 'provider.turn.settled':
      if (event.payload.outcome === 'completed' && event.payload.hostedWebSearchCalls
        && state.runRuntimeSnapshots[event.runId].webSearch.owner !== 'providerHosted') throw new Error('provider_hosted_search_owner_mismatch');
      break;
    case 'run.finishing': {
      if (pendingProvider) throw new Error('run_finishing_state_invalid');
      const finalMessageId = 'finalMessageId' in event.payload ? event.payload.finalMessageId : undefined;
      if (finalMessageId
        && !state.messages.some((message) => message.role === 'assistant' && message.runId === runId
          && message.messageId === finalMessageId)) throw new Error('run_final_message_missing');
      break;
    }
    case 'run.runtime.released': {
      const view = state.runToolViews[event.runId] ?? state.runRuntimeSnapshots[event.runId];
      if (event.payload.pluginInstanceRefs.length !== view.selectedPlugins.plugins.length) throw new Error('run_runtime_release_plugin_mismatch');
      break;
    }
    case 'tool.started':
    case 'tool.interrupted': {
      const request = pendingToolRequests(events, event.runId).find((item) => item.callId === event.callId);
      if (!request || request.payload.attemptId !== event.payload.attemptId
        || event.type === 'tool.started' && state.runRuntimeReleases[event.runId]) throw new Error('tool_attempt_state_invalid');
      break;
    }
    case 'run.settled':
      if (pendingToolRequests(events, event.runId).length) throw new Error('run_tool_result_missing');
      break;
  }
}
