import type {
  ContextCompositionReceipt,
  ProviderRequest,
  RunRuntimeSnapshot,
  SessionEvent,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';
import { LOCAL_AGENT_PROTOCOL_VERSION } from '@deepcode/protocol';
import {
  assertContextContributions,
  buildContextCompositionReceipt,
  cloneModelMessage,
  messagesFromJournal,
  runInputMessageEvent,
} from './contextComposer.js';
import type { ContextMessageContribution } from './plugins.js';
import {
  createProviderToolCodec,
  encodeProviderMessage,
  providerMessageCodecsByCallId,
} from './providerToolCodec.js';
import { sessionControlToolDefinitions } from './sessionControls.js';
import type { SessionState } from './reducer.js';

export type ContextCompactionRequestEvent = Extract<
  SessionEvent,
  { type: 'context.compaction.requested' }
>;

export interface PreparedContextCompaction {
  request: ProviderRequest;
  receipt: ContextCompositionReceipt;
}

const COMPACTION_INSTRUCTIONS = `Summarize the supplied Session history into a factual handoff that another agent can continue from.
Preserve the user's goal, confirmed decisions, constraints, unresolved issues, exact identifiers, paths, commands, errors, completed and pending work, active Plan and Todo state, and tool results.
Separate facts, inferences, and unknowns. Do not answer the task or take action. Return only the Markdown summary.`;

export function prepareContextCompaction(input: {
  sessionId: string;
  runId: string;
  runtime: RunRuntimeSnapshot;
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  events: readonly SessionEvent[];
  requestEvent: ContextCompactionRequestEvent;
}): PreparedContextCompaction {
  const cutoff = input.requestEvent.payload.coveredThroughSequence;
  const sourceEvents = input.events.filter((event) => event.sequence <= cutoff);
  const sourceMessages = messagesFromJournal(
    sourceEvents,
    input.runId,
    input.workspaceBindings,
  );
  const focus = 'focus' in input.requestEvent.payload
    ? input.requestEvent.payload.focus
    : undefined;
  const selected: ContextMessageContribution[] = [
    {
      contributionId: `context-compaction:${input.requestEvent.payload.compactionId}:instructions`,
      contributionKind: 'instructions',
      label: '上下文压缩指令',
      message: { role: 'system', content: COMPACTION_INSTRUCTIONS },
    },
    ...sourceMessages,
  ];
  if (focus) {
    selected.push({
      contributionId: `context-compaction:${input.requestEvent.payload.compactionId}:focus`,
      contributionKind: 'instructions',
      label: '后续任务焦点',
      message: {
        role: 'system',
        content: `Prioritize existing facts relevant to the following future-work focus, but do not answer it:\n${focus}`,
      },
    });
  }
  assertContextContributions(selected);
  const toolCodec = createProviderToolCodec(
    input.runtime.tools,
    sessionControlToolDefinitions(),
    input.runtime.providerToolAliases,
    input.workspaceBindings,
  );
  const journalCodecsByCallId = providerMessageCodecsByCallId(sourceEvents);
  const providerSelected = selected.map<ContextMessageContribution>((contribution) => ({
    ...contribution,
    message: encodeProviderMessage(contribution.message, toolCodec, journalCodecsByCallId),
  }));
  const request: ProviderRequest = {
    protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
    requestId: input.requestEvent.payload.providerRequestId,
    sessionId: input.sessionId,
    runId: input.runId,
    providerRuntimeRef: input.runtime.provider.providerRuntimeRef,
    profileId: input.runtime.provider.profileId,
    purpose: 'contextCompaction',
    responseConstraint: 'answerOnly',
    maxOutputTokens: input.runtime.provider.maxOutputTokens,
    workspaceBindings: input.workspaceBindings.map((binding) => ({ ...binding })),
    messages: providerSelected.map((item) => cloneModelMessage(item.message)),
    tools: [],
    hostedTools: [],
  };
  return {
    request,
    receipt: buildContextCompositionReceipt(
      request.requestId,
      'contextCompaction',
      'answerOnly',
      providerSelected,
      [],
      [],
      [],
      toolCodec.canonicalByWire,
      [],
      input.runtime,
      input.workspaceBindings,
      sourceEvents,
    ),
  };
}

export function pendingContextCompaction(
  events: readonly SessionEvent[],
  runId: string,
): ContextCompactionRequestEvent | null {
  const completed = new Set(events
    .filter((event): event is Extract<SessionEvent, { type: 'context.compacted' }> => (
      event.type === 'context.compacted' && event.runId === runId
    ))
    .map((event) => event.payload.compactionId));
  return [...events]
    .reverse()
    .find((event): event is ContextCompactionRequestEvent => (
      event.type === 'context.compaction.requested'
      && event.runId === runId
      && !completed.has(event.payload.compactionId)
    )) ?? null;
}

export function pressureCompactionCutoff(
  snapshot: { events: readonly SessionEvent[]; state: SessionState },
  runId: string,
  currentReceipt: ContextCompositionReceipt,
  runtime: RunRuntimeSnapshot,
): number | null {
  const latestCheckpoint = [...snapshot.events].reverse().find((event): event is Extract<SessionEvent, { type: 'context.compacted' }> => event.type === 'context.compacted');
  if (estimateContextInput(snapshot, currentReceipt, runtime) + runtime.provider.maxOutputTokens < runtime.provider.contextWindowTokens) return null;
  const input = runInputMessageEvent(snapshot.events, runId);
  if (!input) return null;
  const coveredThrough = latestCheckpoint?.payload.coveredThroughSequence ?? 0;
  const priorRunCutoff = input.sequence - 1;
  const priorJournalFacts = snapshot.events.some((event) => (
    event.sequence <= priorRunCutoff
    && event.sequence > coveredThrough
    && (event.type === 'message.committed' || event.type === 'narrative.committed')
  ));
  if (priorRunCutoff >= 1 && priorJournalFacts) return priorRunCutoff;

  const sameRunCutoff = snapshot.state.revision;
  if (sameRunCutoff <= coveredThrough) return null;
  const sameRunProgress = snapshot.events.some((event) => (
    event.sequence > Math.max(coveredThrough, input.sequence)
    && event.sequence <= sameRunCutoff
    && closesModelContextPrefix(event)
  ));
  return sameRunProgress ? sameRunCutoff : null;
}

function closesModelContextPrefix(event: SessionEvent): boolean {
  return event.type === 'narrative.committed'
    || event.type === 'interaction.resolved'
    || event.type === 'plan.confirmed'
    || event.type === 'plan.revision.requested'
    || event.type === 'plan.cancelled'
    || event.type === 'plan.invalidated'
    || event.type === 'todo.seeded'
    || event.type === 'todo.reconciled'
    || event.type === 'todo.progressed'
    || event.type === 'session.control.rejected'
    || event.type === 'tool.input-rejected'
    || event.type === 'tool.completed';
}

function contextShapeUnits(
  partitions: readonly { requestShapeUnits: number }[],
): number {
  return partitions.reduce((total, partition) => total + partition.requestShapeUnits, 0);
}

/** Admission estimate only: never report this as Provider token usage. */
export function estimateContextInput(
  snapshot: { events: readonly SessionEvent[]; state: SessionState },
  receipt: ContextCompositionReceipt, runtime: RunRuntimeSnapshot,
): number {
  const units = contextShapeUnits(receipt.partitions);
  const usage = snapshot.state.contextUsage;
  const prior = usage && snapshot.state.contextCompositions.find((item) => item.providerRequestId === usage.providerRequestId);
  const checkpointAfterUsage = usage && snapshot.events.some((event) => event.type === 'context.compacted' && event.sequence > usage.sequence);
  if (usage && prior && !checkpointAfterUsage && usage.providerRuntimeRef === runtime.provider.providerRuntimeRef
    && usage.contextWindowTokens === runtime.provider.contextWindowTokens) {
    const priorUnits = contextShapeUnits(prior.partitions);
    if (priorUnits > 0) return Math.ceil(usage.inputTokens * units / priorUnits);
  }
  // No prior usage exists for a first request or after a checkpoint. Bound the
  // request shape, including schemas, instead of treating unavailable usage as zero.
  return Math.ceil(units / 3);
}
