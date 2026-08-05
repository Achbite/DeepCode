import type {
  AgentEvent,
  AgentTimelineBlock,
  AgentTimelineDecisionRequest,
  AgentTimelineInteractionProjection,
  AgentTimelineNarrativeKind,
  AgentTimelinePermissionRequestView,
  AgentTimelineResult,
  AgentTimelineRunProjection,
  AgentTimelineStatus,
  AgentTimelineStructuredProjection,
  AgentTimelineTaskProjection,
  AgentTimelineTaskProjectionItem,
  AgentTimelineTokenUsageProjection,
  AgentTimelineTurn,
  AgentTimelineTurnPart,
  AgentTimelineWorkAttention,
  AgentTimelineWorkOperation,
  AgentTimelineWorkOperationStatus,
  AgentTimelineWorkSegment,
} from '@deepcode/protocol';
import {
  AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2,
  AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1,
  AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2,
  AGENT_TIMELINE_READABLE_REVIEW_SCHEMA_V2,
} from '@deepcode/protocol';
import {
  decodeAgentInputAttachmentsV2,
} from './kernel-v2/inputAttachmentsV2.js';

export const NARRATIVE_TIMELINE_SCHEMA_VERSION =
  AGENT_SHARED_CONVERSATION_PROJECTION_SCHEMA_V2;
export const NARRATIVE_TIMELINE_SHAPE_VERSION =
  AGENT_SHARED_CONVERSATION_WORK_SEGMENTS_SHAPE_V1;

export interface PendingPermissionProjection {
  request: AgentTimelinePermissionRequestView;
}

export interface NarrativeTimelineProjectionInput {
  sessionId: string;
  events: AgentEvent[];
  auxiliaryEvents?: AgentEvent[];
  generatedAt?: string;
}

interface MutableTurn {
  id: string;
  sequence: number;
  sessionId: string;
  runId?: string;
  inputId?: string;
  controlEpoch?: number;
  status: AgentTimelineStatus;
  startedAt?: string;
  completedAt?: string;
  blocks: AgentTimelineBlock[];
  workSegments: AgentTimelineWorkSegment[];
  parts: AgentTimelineTurnPart[];
  activeWorkSegmentId?: string;
  providerStreamSequences: Map<string, number>;
  terminalEvent?: AgentEvent;
}

interface ProjectionContext {
  readonly sessionId: string;
  readonly committedEventIds: ReadonlySet<string>;
  readonly turns: MutableTurn[];
  readonly turnsByRunId: Map<string, MutableTurn>;
  readonly turnsByInputId: Map<string, MutableTurn>;
  readonly turnsByControlEpoch: Map<string, MutableTurn>;
  readonly turnsByProviderTurnId: Map<string, MutableTurn>;
  currentTurn?: MutableTurn;
}

export function buildNarrativeTimelineProjection(
  input: NarrativeTimelineProjectionInput
): AgentTimelineResult {
  const committedEventIds = new Set(input.events.map((event) => event.id));
  const auxiliaryEvents = (input.auxiliaryEvents ?? []).filter(
    (event) => !committedEventIds.has(event.id)
  );
  const currentRunEvents = eventsForLatestRun(input.events);
  const context: ProjectionContext = {
    sessionId: input.sessionId,
    committedEventIds,
    turns: [],
    turnsByRunId: new Map(),
    turnsByInputId: new Map(),
    turnsByControlEpoch: new Map(),
    turnsByProviderTurnId: new Map(),
  };

  for (const event of [...input.events, ...auxiliaryEvents]) {
    if (
      event.sessionId !== input.sessionId
      || privateProjectionEvent(event)
    ) {
      continue;
    }
    const payload = recordValue(event.payload);
    const runId = stringValue(payload?.runId);
    const turn = projectionTurn(context, event, payload, runId);
    const providerOutputProjected = projectProviderOutputIntoTurn(
      turn,
      event,
      payload,
      committedEventIds.has(event.id)
    );
    projectWorkEventIntoTurn(
      turn,
      event,
      payload,
      committedEventIds.has(event.id)
    );
    const block = providerOutputProjected
      ? null
      : projectionBlock(
          event,
          payload,
          turn.blocks.length,
          committedEventIds.has(event.id)
        );
    if (block) {
      upsertTurnBlock(turn, block);
      updateTurnStatus(turn, event, payload, block);
      if (block.providerPhase === 'commentary') {
        turn.activeWorkSegmentId = undefined;
      }
    } else {
      updateTurnStatusFromEvent(turn, event, payload);
    }
    settleProjectionLifecycle(turn, event, payload);
  }

  const interactionProjection = buildInteractionProjection(currentRunEvents);
  const turns = settleInteractionBlocks(
    context.turns
      .filter(
        (turn) =>
          turn.blocks.length > 0
          || turn.workSegments.length > 0
      )
      .map<AgentTimelineTurn>((turn, turnIndex) => ({
        id: turn.id,
        sequence: turnIndex,
        sessionId: turn.sessionId,
        status: turn.status,
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        blocks: turn.blocks.map((block, blockIndex) => ({
          ...block,
          sequence: blockIndex,
        })),
        workSegments: finalizeTurnWorkSegments(turn).map(
          (segment, segmentIndex) => ({
            ...segment,
            sequence: segmentIndex,
          })
        ),
        parts: [...turn.parts],
      })),
    input.events,
    interactionProjection?.pending
  );
  const events = [...input.events, ...auxiliaryEvents];
  const projection: AgentTimelineResult = {
    schemaVersion: NARRATIVE_TIMELINE_SCHEMA_VERSION,
    shapeVersion: NARRATIVE_TIMELINE_SHAPE_VERSION,
    sessionId: input.sessionId,
    revision: input.events.length,
    sourceEventVersion: input.events.length,
    generatedAt: input.generatedAt
      ?? input.events.at(-1)?.ts
      ?? new Date(0).toISOString(),
    turns,
    eventCount: input.events.length,
    taskProjection: buildTaskProjection(currentRunEvents),
    interactionProjection,
    runProjection: buildRunProjection(
      input.events,
      turns,
      interactionProjection?.pending
    ),
    tokenUsageProjection:
      buildTokenUsageProjection(input.events),
  };
  stripUndefinedProjectionFields(projection);
  assertNativeWriterSharedConversationProjectionV2(projection);
  return projection;
}

/**
 * Applies one already-durable Provider text delta to the current public
 * projection. This is deliberately narrow: every non-composing event still
 * goes through the canonical full projector and reconciles at a snapshot
 * boundary.
 */
export function appendProviderComposingProjectionV2(
  current: AgentTimelineResult,
  event: AgentEvent
): AgentTimelineResult {
  assertNativeWriterSharedConversationProjectionV2(current);
  const payload = recordValue(event.payload);
  const runId = stringValue(payload?.runId);
  const providerTurnId = stringValue(payload?.providerTurnId);
  const projectionKind = stringValue(payload?.projectionKind);
  const controlEpoch = nonnegativeIntegerValue(payload?.controlEpoch);
  const streamSequence = nonnegativeIntegerValue(payload?.streamSequence);
  const textOrdinal = nonnegativeIntegerValue(payload?.textOrdinal);
  const textDelta = textContentValue(payload?.content);
  const providerPhase = stringValue(payload?.providerPhase);
  if (
    event.sessionId !== current.sessionId
    || event.kind !== 'assistant_msg'
    || projectionKind !== 'provider.composing'
    || !runId
    || !providerTurnId
    || controlEpoch === undefined
    || controlEpoch === 0
    || streamSequence === undefined
    || streamSequence === 0
    || textOrdinal === undefined
    || textOrdinal === 0
    || textDelta === undefined
    || (providerPhase !== undefined && providerPhase !== 'commentary')
  ) {
    throw new Error('session_projection_provider_composing_invalid');
  }
  const runProjection = current.runProjection;
  if (
    !runProjection
    || runProjection.runId !== runId
    || runProjection.status === 'succeeded'
    || runProjection.status === 'failed'
    || runProjection.status === 'cancelled'
  ) {
    throw new Error('session_projection_provider_composing_run_invalid');
  }
  const turnIndex = runProjection.turnId
    ? current.turns.findIndex((turn) => turn.id === runProjection.turnId)
    : current.turns.findLastIndex((turn) =>
        turn.id.startsWith(`turn:${runId}:`)
      );
  if (turnIndex < 0) {
    throw new Error('session_projection_provider_composing_turn_missing');
  }
  const turn = current.turns[turnIndex]!;
  const blockPrefix = `provider:${runId}:${providerTurnId}:text:`;
  const lastStreamSequence = turn.blocks
    .filter((block) => block.id.startsWith(blockPrefix))
    .reduce(
      (count, block) =>
        count + block.provenance.sourceEventRefs.length,
      0
    );
  if (streamSequence !== lastStreamSequence + 1) {
    throw new Error('session_projection_provider_composing_sequence_invalid');
  }
  const blockId = `${blockPrefix}${textOrdinal}`;
  const blockIndex = turn.blocks.findIndex((block) => block.id === blockId);
  const existing = blockIndex < 0 ? undefined : turn.blocks[blockIndex];
  const combinedText = `${existing?.bodyMarkdown ?? ''}${textDelta}`;
  const block: AgentTimelineBlock = existing
    ? {
        ...existing,
        revision: (existing.revision ?? 0) + 1,
        deliveryMode: 'replay',
        durability: 'committed',
        entryRole: 'agentUpdate',
        ...(providerPhase ? { providerPhase } : {}),
        status: 'running',
        summary: combinedText,
        bodyMarkdown: combinedText,
        provenance: {
          ...existing.provenance,
          sourceEventRefs: appendUniqueStrings(
            existing.provenance.sourceEventRefs,
            [event.id]
          ),
        },
      }
    : {
        id: blockId,
        sequence: turn.blocks.length,
        revision: 1,
        deliveryMode: 'replay',
        durability: 'committed',
        kind: 'assistant',
        narrativeKind: 'assistantText',
        entryRole: 'agentUpdate',
        ...(providerPhase ? { providerPhase } : {}),
        title: 'Assistant Msg',
        summary: combinedText,
        status: 'running',
        defaultCollapsed: false,
        bodyMarkdown: combinedText,
        confirmable: false,
        provenance: {
          origin: 'provider',
          authority: 'session',
          sourceEventRefs: [event.id],
          factRefs: [],
          evidenceRefs: [],
        },
        languageBinding: {
          language: 'neutral',
          status: 'unavailable',
        },
      };
  const blocks = [...turn.blocks];
  const parts = [...turn.parts];
  if (blockIndex < 0) {
    blocks.push(block);
    parts.push({ kind: 'block', blockId });
  } else {
    blocks[blockIndex] = block;
  }
  const nextTurn: AgentTimelineTurn = {
    ...turn,
    status: 'running',
    blocks,
    parts,
  };
  delete nextTurn.completedAt;
  const turns = [...current.turns];
  turns[turnIndex] = nextTurn;
  const nextRevision = incrementProjectionCounter(
    current.revision,
    'revision'
  );
  const nextSourceEventVersion = incrementProjectionCounter(
    current.sourceEventVersion,
    'sourceEventVersion'
  );
  const nextEventCount = incrementProjectionCounter(
    current.eventCount,
    'eventCount'
  );
  const runRevision = incrementProjectionCounter(
    runProjection.revision,
    'runProjection.revision'
  );
  const waiting = runProjection.status === 'waitingUser'
    || runProjection.status === 'waitingExternal'
    || runProjection.status === 'paused';
  const next: AgentTimelineResult = {
    ...current,
    revision: nextRevision,
    sourceEventVersion: nextSourceEventVersion,
    generatedAt: event.ts,
    turns,
    eventCount: nextEventCount,
    runProjection: {
      ...runProjection,
      revision: runRevision,
      ...(waiting
        ? {}
        : {
            currentActivity: {
              code: 'provider.composing',
              updatedAt: event.ts,
            },
          }),
    },
  };
  assertNativeWriterSharedConversationProjectionV2(next);
  return next;
}

function incrementProjectionCounter(
  value: number,
  field: string
): number {
  const next = value + 1;
  if (!Number.isSafeInteger(next)) {
    throw new Error(`session_projection_${field}_exhausted`);
  }
  return next;
}

function settleInteractionBlocks(
  turns: AgentTimelineTurn[],
  events: AgentEvent[],
  pending:
    | NonNullable<AgentTimelineInteractionProjection['pending']>
    | undefined
): AgentTimelineTurn[] {
  const decisions = interactionDecisionIndex(events);
  return turns.map((turn) => ({
    ...turn,
    blocks: turn.blocks.map((block) => {
      const interaction = block.interaction;
      if (!interaction) return block;
      if (
        pending
        && pending.interactionId === interaction.interactionId
        && pending.interactionRevision === interaction.interactionRevision
      ) {
        return {
          ...block,
          interaction: {
            ...interaction,
            state: 'open',
          },
          confirmable: true,
        };
      }
      const decision = decisions.get(
        `${interaction.kind}:${interaction.targetId}`
      );
      return {
        ...block,
        interaction: {
          ...interaction,
          state: decision?.state ?? 'superseded',
          ...(decision
            ? {
                selectedDecision: {
                  decision: decision.decision,
                  source: 'button' as const,
                  ...(decision.decidedAt
                    ? { decidedAt: decision.decidedAt }
                    : {}),
                },
              }
            : {}),
        },
        confirmable: false,
      };
    }),
  }));
}

function terminalTimelineStatus(status: AgentTimelineStatus): boolean {
  return status === 'completed'
    || status === 'cancelled'
    || status === 'failed';
}

function interactionDecisionIndex(
  events: AgentEvent[]
): Map<
  string,
  {
    state: 'accepted' | 'rejected' | 'needsRevision' | 'expired';
    decision: string;
    decidedAt?: string;
  }
> {
  const decisions = new Map<
    string,
    {
      state: 'accepted' | 'rejected' | 'needsRevision' | 'expired';
      decision: string;
      decidedAt?: string;
    }
  >();
  for (const event of events) {
    const payload = recordValue(event.payload);
    if (event.kind === 'plan_review') {
      const targetId = stringValue(payload?.planId);
      if (!targetId) continue;
      const decision = stringValue(payload?.decision)
        ?? stringValue(payload?.status)
        ?? 'revise';
      decisions.set(`plan:${targetId}`, {
        state: interactionDecisionState(decision),
        decision,
        decidedAt: event.ts,
      });
      continue;
    }
    if (event.kind === 'permission_result') {
      const targetId = permissionIdentity(payload);
      if (!targetId) continue;
      const decision = stringValue(payload?.decision)
        ?? stringValue(payload?.status)
        ?? 'deny';
      decisions.set(`permission:${targetId}`, {
        state: interactionDecisionState(decision),
        decision,
        decidedAt: event.ts,
      });
      continue;
    }
    if (
      event.kind === 'review_summary'
      && stringValue(payload?.status) === 'completed'
    ) {
      const targetId = stringValue(payload?.reviewId);
      if (!targetId) continue;
      decisions.set(`review:${targetId}`, {
        state: 'accepted',
        decision: 'accept',
        decidedAt: event.ts,
      });
    }
  }
  return decisions;
}

function interactionDecisionState(
  value: string
): 'accepted' | 'rejected' | 'needsRevision' | 'expired' {
  if (value === 'accept' || value === 'accepted' || value === 'allow' || value === 'allowed') {
    return 'accepted';
  }
  if (value === 'reject' || value === 'rejected' || value === 'deny' || value === 'denied') {
    return 'rejected';
  }
  if (value === 'revise' || value === 'needsRevision') {
    return 'needsRevision';
  }
  return 'expired';
}

export function findLatestPendingPermission(
  events: AgentEvent[]
): PendingPermissionProjection | null {
  const currentRunEvents = eventsForLatestRun(events);
  const resolved = new Set<string>();
  for (let index = currentRunEvents.length - 1; index >= 0; index -= 1) {
    const event = currentRunEvents[index];
    if (!event) continue;
    const payload = recordValue(event.payload);
    if (!payload) continue;
    if (event.kind === 'permission_result') {
      const id = permissionIdentity(payload);
      if (id) resolved.add(id);
      continue;
    }
    if (event.kind !== 'permission_request') continue;
    const request = permissionRequest(payload);
    if (request && !resolved.has(request.id)) return { request };
  }
  return null;
}

export function assertSharedConversationProjectionV2(
  value: AgentTimelineResult
): void {
  assertSharedConversationProjection(value);
}

function assertNativeWriterSharedConversationProjectionV2(
  value: AgentTimelineResult
): void {
  assertSharedConversationProjection(value);
}

function assertSharedConversationProjection(
  value: AgentTimelineResult
): void {
  if (
    !recordValue(value)
    || value.schemaVersion !== NARRATIVE_TIMELINE_SCHEMA_VERSION
    || value.shapeVersion !== NARRATIVE_TIMELINE_SHAPE_VERSION
    || !nonemptyString(value.sessionId)
    || !nonnegativeInteger(value.revision)
    || !nonnegativeInteger(value.sourceEventVersion)
    || !nonemptyString(value.generatedAt)
    || !nonnegativeInteger(value.eventCount)
    || value.eventCount > value.sourceEventVersion
    || !Array.isArray(value.turns)
    || (
      value.tokenUsageProjection !== undefined
      && !validTokenUsageProjection(value.tokenUsageProjection)
    )
    || (
      value.taskProjection !== undefined
      && !validTaskProjection(value.taskProjection)
    )
    || (
      value.interactionProjection !== undefined
      && !validInteractionProjection(value.interactionProjection)
    )
    || (
      value.workspaceProjection !== undefined
      && !validWorkspaceProjection(value.workspaceProjection)
    )
    || (
      value.runProjection !== undefined
      && !validRunProjection(value.runProjection)
    )
  ) {
    throw new Error('session_projection_v2_invalid');
  }
  const rootKeys = new Set([
    'schemaVersion',
    'shapeVersion',
    'sessionId',
    'revision',
    'sourceEventVersion',
    'generatedAt',
    'turns',
    'eventCount',
    'taskProjection',
    'interactionProjection',
    'runProjection',
    'tokenUsageProjection',
    'workspaceProjection',
  ]);
  if (Object.keys(value).some((key) => !rootKeys.has(key))) {
    throw new Error('session_projection_v2_root_field_invalid');
  }
  const turnIds = new Set<string>();
  const blockIds = new Set<string>();
  const workSegmentIds = new Set<string>();
  const operationIds = new Set<string>();
  const workSegmentTurnIds = new Map<string, string>();
  const operationSegmentIds = new Map<string, string>();
  for (const [turnIndex, turn] of value.turns.entries()) {
    if (
      !recordValue(turn)
      || !nonemptyString(turn.id)
      || turnIds.has(turn.id)
      || turn.sessionId !== value.sessionId
      || !timelineStatus(turn.status)
      || !Array.isArray(turn.blocks)
      || !Array.isArray(turn.workSegments)
      || !Array.isArray(turn.parts)
      || (
        turn.sequence !== undefined
        && !nonnegativeInteger(turn.sequence)
      )
      || (
        turn.startedAt !== undefined
        && typeof turn.startedAt !== 'string'
      )
      || (
        turn.completedAt !== undefined
        && typeof turn.completedAt !== 'string'
      )
      || Object.keys(turn).some(
        (key) =>
          key !== 'id'
          && key !== 'sequence'
          && key !== 'sessionId'
          && key !== 'status'
          && key !== 'startedAt'
          && key !== 'completedAt'
          && key !== 'blocks'
          && key !== 'workSegments'
          && key !== 'parts'
      )
      || containsPrivateProjectionData(turn)
      || turn.sequence !== turnIndex
      || !validNativeTurnLifecycle(turn)
    ) {
      throw new Error('session_projection_v2_turn_invalid');
    }
    turnIds.add(turn.id);
    const localBlockIds = new Set<string>();
    for (const [blockIndex, block] of turn.blocks.entries()) {
      if (
        !isSharedConversationBlockV2(block)
        || blockIds.has(block.id)
        || block.sequence !== blockIndex
      ) {
        throw new Error('session_projection_v2_block_invalid');
      }
      blockIds.add(block.id);
      localBlockIds.add(block.id);
    }
    const localWorkSegmentIds = new Set<string>();
    for (const [segmentIndex, segment] of turn.workSegments.entries()) {
      if (
        !isSharedConversationWorkSegmentV1(segment)
        || workSegmentIds.has(segment.id)
        || segment.sequence !== segmentIndex
      ) {
        throw new Error('session_projection_v2_work_segment_invalid');
      }
      workSegmentIds.add(segment.id);
      localWorkSegmentIds.add(segment.id);
      workSegmentTurnIds.set(segment.id, turn.id);
      for (const operation of segment.operations) {
        if (operationIds.has(operation.operationId)) {
          throw new Error('session_projection_v2_operation_duplicate');
        }
        operationIds.add(operation.operationId);
        operationSegmentIds.set(operation.operationId, segment.id);
      }
    }
    const referencedBlocks = new Set<string>();
    const referencedSegments = new Set<string>();
    for (const part of turn.parts) {
      const record = recordValue(part);
      if (
        !record
        || (
          record.kind === 'block'
          && (
            Object.keys(record).length !== 2
            || !nonemptyString(record.blockId)
            || !localBlockIds.has(record.blockId)
            || referencedBlocks.has(record.blockId)
          )
        )
        || (
          record.kind === 'workSegment'
          && (
            Object.keys(record).length !== 2
            || !nonemptyString(record.workSegmentId)
            || !localWorkSegmentIds.has(record.workSegmentId)
            || referencedSegments.has(record.workSegmentId)
          )
        )
        || (
          record.kind !== 'block'
          && record.kind !== 'workSegment'
        )
      ) {
        throw new Error('session_projection_v2_part_invalid');
      }
      if (record.kind === 'block') {
        referencedBlocks.add(record.blockId as string);
      } else {
        referencedSegments.add(record.workSegmentId as string);
      }
    }
    if (
      referencedBlocks.size !== localBlockIds.size
      || referencedSegments.size !== localWorkSegmentIds.size
    ) {
      throw new Error('session_projection_v2_part_reference_incomplete');
    }
  }
  if (
    value.taskProjection !== undefined
    && !taskProjectionReferencesExist(value.taskProjection, blockIds)
  ) {
    throw new Error('session_projection_v2_task_reference_invalid');
  }
  if (
    value.interactionProjection !== undefined
    && !interactionProjectionReferencesExist(
      value.interactionProjection,
      blockIds
    )
  ) {
    throw new Error('session_projection_v2_interaction_reference_invalid');
  }
  if (
    value.runProjection?.turnId !== undefined
    && !turnIds.has(value.runProjection.turnId)
  ) {
    throw new Error('session_projection_v2_run_turn_reference_invalid');
  }
  const currentActivity = value.runProjection?.currentActivity;
  if (currentActivity !== undefined && currentActivity !== null) {
    const turnId = value.runProjection?.turnId;
    const workSegmentId = currentActivity.workSegmentId;
    const operationId = currentActivity.operationId;
    if (
      workSegmentId !== undefined
      && (
        turnId === undefined
        || workSegmentTurnIds.get(workSegmentId) !== turnId
      )
    ) {
      throw new Error('session_projection_v2_activity_segment_reference_invalid');
    }
    if (
      operationId !== undefined
      && (
        workSegmentId === undefined
        || operationSegmentIds.get(operationId) !== workSegmentId
      )
    ) {
      throw new Error('session_projection_v2_activity_operation_reference_invalid');
    }
  }
}

export function isSharedConversationProjectionV2(
  value: unknown
): value is AgentTimelineResult {
  try {
    assertSharedConversationProjectionV2(value as AgentTimelineResult);
    return true;
  } catch {
    return false;
  }
}

export function isSharedConversationBlockV2(
  value: unknown
): value is AgentTimelineBlock {
  const block = recordValue(value);
  const provenance = recordValue(block?.provenance);
  const languageBinding = recordValue(block?.languageBinding);
  if (
    !block
    || !nonemptyString(block.id)
    || !nonemptyString(block.title)
    || typeof block.summary !== 'string'
    || !timelineStatus(block.status)
    || typeof block.defaultCollapsed !== 'boolean'
    || (block.durability !== 'live' && block.durability !== 'committed')
    || !entryRole(block.entryRole)
    || (
      block.providerPhase !== undefined
      && block.providerPhase !== 'commentary'
      && block.providerPhase !== 'final_answer'
    )
    || (
      block.sequence !== undefined
      && !nonnegativeInteger(block.sequence)
    )
    || (
      block.revision !== undefined
      && !nonnegativeInteger(block.revision)
    )
    || !provenance
    || !projectionOrigin(provenance.origin)
    || !projectionAuthority(provenance.authority)
    || !stringArray(provenance.sourceEventRefs)
    || !stringArray(provenance.factRefs)
    || !stringArray(provenance.evidenceRefs)
    || !validProvenance(provenance)
    || !languageBinding
    || !projectionLanguage(languageBinding.language)
    || !languageStatus(languageBinding.status)
    || !validLanguageBinding(languageBinding)
    || !validTimelineAttachments(block.attachments)
    || !validNativeBlockSemantics(block)
    || !validNativeBlockDetails(block)
  ) {
    return false;
  }
  const keys = new Set([
    'id',
    'sequence',
    'revision',
    'deliveryMode',
    'durability',
    'kind',
    'narrativeKind',
    'entryRole',
    'providerPhase',
    'title',
    'summary',
    'status',
    'defaultCollapsed',
    'bodyMarkdown',
    'localizedContent',
    'structuredProjection',
    'decisionRequest',
    'interaction',
    'confirmable',
    'attachments',
    'displayHints',
    'evidenceRefs',
    'provenance',
    'languageBinding',
    'taskProjectionRef',
  ]);
  return !Object.keys(block).some((key) => !keys.has(key))
    && !containsPrivateProjectionData(block);
}

function validNativeBlockSemantics(
  block: Record<string, unknown>
): boolean {
  if (block.kind === 'user') {
    return block.narrativeKind === 'user'
      && block.entryRole === 'userMessage'
      && block.providerPhase === undefined
      && recordValue(block.provenance)?.origin === 'user'
      && recordValue(block.provenance)?.authority === 'user';
  }
  if (block.kind === 'assistant') {
    if (
      block.narrativeKind !== 'assistantText'
      || recordValue(block.provenance)?.origin !== 'provider'
      || recordValue(block.provenance)?.authority !== 'session'
    ) {
      return false;
    }
    if (block.providerPhase === 'commentary') {
      return block.entryRole === 'agentUpdate';
    }
    if (block.providerPhase === 'final_answer') {
      return block.entryRole === 'finalAnswer';
    }
    return block.providerPhase === undefined
      && (
        block.entryRole === 'agentUpdate'
        || block.entryRole === 'finalAnswer'
      );
  }
  if (block.providerPhase !== undefined) return false;
  if (block.kind === 'plan') {
    return block.narrativeKind === 'plan'
      && block.entryRole === 'interaction';
  }
  if (block.kind === 'permission') {
    return block.narrativeKind === 'permission'
      && block.entryRole === 'interaction';
  }
  if (block.kind === 'review') {
    return block.narrativeKind === 'review'
      && block.entryRole === 'interaction';
  }
  return block.kind === 'error'
    && block.narrativeKind === 'diagnostic'
    && block.entryRole === 'diagnostic';
}

function validNativeBlockDetails(
  block: Record<string, unknown>
): boolean {
  return (
    block.deliveryMode === undefined
    || block.deliveryMode === 'live'
    || block.deliveryMode === 'buffered'
    || block.deliveryMode === 'replay'
  )
    && (
      block.bodyMarkdown === undefined
      || typeof block.bodyMarkdown === 'string'
    )
    && (
      block.localizedContent === undefined
      || validLocalizedText(block.localizedContent)
    )
    && (
      block.structuredProjection === undefined
      || validStructuredProjection(block.structuredProjection)
    )
    && (
      block.decisionRequest === undefined
      || validDecisionRequest(block.decisionRequest)
    )
    && (
      block.interaction === undefined
      || validInteractionView(block.interaction)
    )
    && (
      block.confirmable === undefined
      || typeof block.confirmable === 'boolean'
    )
    && (
      block.displayHints === undefined
      || validDisplayHints(block.displayHints)
    )
    && (
      block.evidenceRefs === undefined
      || stringArray(block.evidenceRefs)
    )
    && (
      block.taskProjectionRef === undefined
      || nonemptyString(block.taskProjectionRef)
    )
    && (
      block.interaction === undefined
      || block.kind === 'plan'
      || block.kind === 'permission'
    )
    && (
      block.structuredProjection === undefined
      || (
        block.kind === 'plan'
        && recordValue(block.structuredProjection)?.kind === 'plan'
      )
      || (
        block.kind === 'review'
        && recordValue(block.structuredProjection)?.kind === 'review'
      )
    )
    && (
      block.decisionRequest === undefined
      || (
        block.interaction !== undefined
        && jsonLikeEqual(
          block.decisionRequest,
          recordValue(block.interaction)?.decisionRequest
        )
      )
    );
}

function validProvenance(
  provenance: Record<string, unknown>
): boolean {
  return exactKeys(provenance, [
    'origin',
    'authority',
    'sourceEventRefs',
    'factRefs',
    'evidenceRefs',
  ]);
}

function validLanguageBinding(
  languageBinding: Record<string, unknown>
): boolean {
  return exactOptionalKeys(languageBinding, [
    'language',
    'status',
  ], [
    'revision',
    'sourceTurnId',
  ])
    && (
      languageBinding.revision === undefined
      || nonnegativeInteger(languageBinding.revision)
    )
    && (
      languageBinding.sourceTurnId === undefined
      || nonemptyString(languageBinding.sourceTurnId)
    );
}

function validLocalizedText(value: unknown): boolean {
  const localized = recordValue(value);
  return Boolean(
    localized
    && exactOptionalKeys(localized, [], [
      'text',
      'messageKey',
      'messageArgs',
    ])
    && (
      localized.text === undefined
      || typeof localized.text === 'string'
    )
    && (
      localized.messageKey === undefined
      || nonemptyString(localized.messageKey)
    )
    && (
      localized.messageArgs === undefined
      || validStringRecord(localized.messageArgs)
    )
    && (
      localized.text !== undefined
      || localized.messageKey !== undefined
    )
  );
}

function validStructuredProjection(value: unknown): boolean {
  const projection = recordValue(value);
  if (
    !projection
    || !exactOptionalKeys(projection, [
      'kind',
      'schemaVersion',
      'sections',
    ], [
      'title',
      'titleKey',
      'titleArgs',
      'summary',
      'summaryKey',
      'messageArgs',
    ])
    || (projection.kind !== 'plan' && projection.kind !== 'review')
    || !nonemptyString(projection.schemaVersion)
    || !Array.isArray(projection.sections)
    || (
      projection.title !== undefined
      && typeof projection.title !== 'string'
    )
    || (
      projection.titleKey !== undefined
      && !nonemptyString(projection.titleKey)
    )
    || (
      projection.titleArgs !== undefined
      && !validStringRecord(projection.titleArgs)
    )
    || (
      projection.summary !== undefined
      && typeof projection.summary !== 'string'
    )
    || (
      projection.summaryKey !== undefined
      && !nonemptyString(projection.summaryKey)
    )
    || (
      projection.messageArgs !== undefined
      && !validStringRecord(projection.messageArgs)
    )
  ) {
    return false;
  }
  const sectionIds = new Set<string>();
  return projection.sections.every((value) => {
    const section = recordValue(value);
    if (
      !section
      || !exactOptionalKeys(section, [
        'sectionId',
        'titleKey',
        'items',
      ], [
        'titleArgs',
        'emptyMessageKey',
      ])
      || !nonemptyString(section.sectionId)
      || sectionIds.has(section.sectionId)
      || !nonemptyString(section.titleKey)
      || (
        section.titleArgs !== undefined
        && !validStringRecord(section.titleArgs)
      )
      || (
        section.emptyMessageKey !== undefined
        && !nonemptyString(section.emptyMessageKey)
      )
      || !Array.isArray(section.items)
    ) {
      return false;
    }
    sectionIds.add(section.sectionId);
    const itemIds = new Set<string>();
    return section.items.every((value) => {
      const item = recordValue(value);
      if (
        !item
        || !exactOptionalKeys(item, [
          'itemId',
          'kind',
        ], [
          'text',
          'messageKey',
          'messageArgs',
          'status',
          'targetRefs',
          'auditRefs',
          'objective',
          'acceptanceCriteria',
          'failureConditions',
        ])
        || !nonemptyString(item.itemId)
        || itemIds.has(item.itemId)
        || !nonemptyString(item.kind)
        || (
          item.text !== undefined
          && typeof item.text !== 'string'
        )
        || (
          item.messageKey !== undefined
          && !nonemptyString(item.messageKey)
        )
        || (
          item.messageArgs !== undefined
          && !validStringRecord(item.messageArgs)
        )
        || (
          item.status !== undefined
          && !nonemptyString(item.status)
        )
        || (
          item.targetRefs !== undefined
          && !stringArray(item.targetRefs)
        )
        || (
          item.auditRefs !== undefined
          && !stringArray(item.auditRefs)
        )
        || (
          item.objective !== undefined
          && typeof item.objective !== 'string'
        )
        || (
          item.acceptanceCriteria !== undefined
          && !stringArray(item.acceptanceCriteria)
        )
        || (
          item.failureConditions !== undefined
          && !stringArray(item.failureConditions)
        )
      ) {
        return false;
      }
      itemIds.add(item.itemId);
      return true;
    });
  });
}

function validDecisionRequest(value: unknown): boolean {
  const request = recordValue(value);
  if (
    !request
    || !exactOptionalKeys(request, [
      'allowsFreeform',
      'options',
    ], [
      'id',
      'reason',
      'summary',
    ])
    || typeof request.allowsFreeform !== 'boolean'
    || !Array.isArray(request.options)
    || (
      request.id !== undefined
      && !nonemptyString(request.id)
    )
    || (
      request.reason !== undefined
      && typeof request.reason !== 'string'
    )
    || (
      request.summary !== undefined
      && typeof request.summary !== 'string'
    )
  ) {
    return false;
  }
  const optionIds = new Set<string>();
  return request.options.every((value) => {
    const option = recordValue(value);
    if (
      !option
      || !exactOptionalKeys(option, [
        'id',
        'label',
      ], [
        'description',
        'recommended',
      ])
      || !nonemptyString(option.id)
      || optionIds.has(option.id)
      || !nonemptyString(option.label)
      || (
        option.description !== undefined
        && typeof option.description !== 'string'
      )
      || (
        option.recommended !== undefined
        && typeof option.recommended !== 'boolean'
      )
    ) {
      return false;
    }
    optionIds.add(option.id);
    return true;
  });
}

function validInteractionView(value: unknown): boolean {
  const interaction = recordValue(value);
  const selected = recordValue(interaction?.selectedDecision);
  return Boolean(
    interaction
    && exactOptionalKeys(interaction, [
      'interactionId',
      'interactionRevision',
      'targetId',
      'kind',
      'state',
    ], [
      'runId',
      'decisionRequest',
      'selectedDecision',
    ])
    && nonemptyString(interaction.interactionId)
    && nonemptyString(interaction.interactionRevision)
    && nonemptyString(interaction.targetId)
    && (
      interaction.kind === 'plan'
      || interaction.kind === 'permission'
    )
    && interactionState(interaction.state)
    && (
      interaction.runId === undefined
      || nonemptyString(interaction.runId)
    )
    && (
      interaction.decisionRequest === undefined
      || validDecisionRequest(interaction.decisionRequest)
    )
    && (
      interaction.selectedDecision === undefined
      || (
        selected
        && exactOptionalKeys(selected, [
          'decision',
          'source',
        ], [
          'decidedAt',
        ])
        && nonemptyString(selected.decision)
        && (
          selected.source === 'button'
          || selected.source === 'freeText'
        )
        && (
          selected.decidedAt === undefined
          || nonemptyString(selected.decidedAt)
        )
      )
    )
    && (
      interaction.state === 'open'
      || interaction.state === 'submitting'
      || selected !== undefined
      || interaction.state === 'superseded'
      || interaction.state === 'expired'
    )
  );
}

function validDisplayHints(value: unknown): boolean {
  const hints = recordValue(value);
  return Boolean(
    hints
    && exactOptionalKeys(hints, [], [
      'density',
      'evidenceMode',
      'collapseAfterComplete',
      'checkpointKind',
      'showInTaskList',
      'taskListLabel',
      'taskListSummary',
      'phase',
    ])
    && (
      hints.density === undefined
      || hints.density === 'normal'
      || hints.density === 'compact'
      || hints.density === 'debug'
    )
    && (
      hints.evidenceMode === undefined
      || hints.evidenceMode === 'inline'
      || hints.evidenceMode === 'collapsed'
      || hints.evidenceMode === 'debugOnly'
    )
    && (
      hints.collapseAfterComplete === undefined
      || typeof hints.collapseAfterComplete === 'boolean'
    )
    && (
      hints.checkpointKind === undefined
      || [
        'turnStart',
        'llmProposal',
        'resourceFact',
        'userGuidance',
        'permission',
        'review',
        'final',
        'diagnostic',
      ].includes(String(hints.checkpointKind))
    )
    && (
      hints.showInTaskList === undefined
      || typeof hints.showInTaskList === 'boolean'
    )
    && (
      hints.taskListLabel === undefined
      || typeof hints.taskListLabel === 'string'
    )
    && (
      hints.taskListSummary === undefined
      || typeof hints.taskListSummary === 'string'
    )
    && (
      hints.phase === undefined
      || hints.phase === 'explore'
      || hints.phase === 'execute'
    )
  );
}

function validTaskProjection(value: unknown): boolean {
  const projection = recordValue(value);
  if (
    !projection
    || !exactKeys(projection, ['title', 'items'])
    || typeof projection.title !== 'string'
    || !Array.isArray(projection.items)
  ) {
    return false;
  }
  const itemIds = new Set<string>();
  return projection.items.every((value) => {
    const item = recordValue(value);
    if (
      !item
      || !exactOptionalKeys(item, [
        'id',
        'title',
        'summary',
        'status',
        'blockId',
        'narrativeKind',
      ], [
        'settlementKind',
      ])
      || !nonemptyString(item.id)
      || itemIds.has(item.id)
      || typeof item.title !== 'string'
      || typeof item.summary !== 'string'
      || !timelineStatus(item.status)
      || !nonemptyString(item.blockId)
      || !timelineNarrativeKind(item.narrativeKind)
      || (
        item.settlementKind !== undefined
        && item.settlementKind !== 'sessionEvidenceSatisfied'
      )
    ) {
      return false;
    }
    itemIds.add(item.id);
    return true;
  });
}

function taskProjectionReferencesExist(
  value: AgentTimelineTaskProjection,
  blockIds: ReadonlySet<string>
): boolean {
  return value.items.every((item) => blockIds.has(item.blockId));
}

function validInteractionProjection(value: unknown): boolean {
  const projection = recordValue(value);
  if (
    !projection
    || !exactOptionalKeys(projection, [], ['pending'])
  ) {
    return false;
  }
  if (projection.pending === undefined) return true;
  const pending = recordValue(projection.pending);
  if (
    !pending
    || !nonemptyString(pending.interactionId)
    || !nonemptyString(pending.interactionRevision)
    || !nonemptyString(pending.targetId)
  ) {
    return false;
  }
  const optionalDisplayKeys = [
    'blockId',
    'title',
    'summary',
  ];
  if (pending.kind === 'permission') {
    return exactOptionalKeys(pending, [
      'kind',
      'interactionId',
      'interactionRevision',
      'targetId',
      'requestId',
      'request',
    ], [
      'runId',
      ...optionalDisplayKeys,
    ])
      && nonemptyString(pending.requestId)
      && pending.requestId === pending.targetId
      && validPermissionRequestView(pending.request)
      && recordValue(pending.request)?.id === pending.requestId
      && (
        pending.runId === undefined
        || nonemptyString(pending.runId)
      )
      && validOptionalDisplayStrings(pending);
  }
  if (pending.kind === 'plan') {
    return exactOptionalKeys(pending, [
      'kind',
      'interactionId',
      'interactionRevision',
      'targetId',
      'runId',
      'planId',
    ], optionalDisplayKeys)
      && nonemptyString(pending.runId)
      && nonemptyString(pending.planId)
      && pending.planId === pending.targetId
      && validOptionalDisplayStrings(pending);
  }
  return false;
}

function interactionProjectionReferencesExist(
  value: AgentTimelineInteractionProjection,
  blockIds: ReadonlySet<string>
): boolean {
  return value.pending?.blockId === undefined
    || blockIds.has(value.pending.blockId);
}

function validOptionalDisplayStrings(
  value: Record<string, unknown>
): boolean {
  return ['blockId', 'title', 'summary'].every(
    (key) =>
      value[key] === undefined
      || (
        typeof value[key] === 'string'
        && (
          key !== 'blockId'
          || nonemptyString(value[key])
        )
      )
  );
}

function validPermissionRequestView(value: unknown): boolean {
  const request = recordValue(value);
  if (
    !request
    || !exactOptionalKeys(request, [
      'id',
      'toolName',
      'riskLevel',
      'summary',
    ], [
      'runId',
      'requestKind',
      'permissionBundleId',
      'contractId',
      'affectedOperationIds',
      'toolId',
      'diff',
      'argumentsPreview',
    ])
    || !nonemptyString(request.id)
    || !nonemptyString(request.toolName)
    || (
      request.riskLevel !== 'low'
      && request.riskLevel !== 'medium'
      && request.riskLevel !== 'high'
      && request.riskLevel !== 'critical'
    )
    || typeof request.summary !== 'string'
    || (
      request.runId !== undefined
      && !nonemptyString(request.runId)
    )
    || (
      request.requestKind !== undefined
      && request.requestKind !== 'runtimePermission'
      && request.requestKind !== 'scopeExpansion'
    )
    || (
      request.permissionBundleId !== undefined
      && !nonemptyString(request.permissionBundleId)
    )
    || (
      request.contractId !== undefined
      && !nonemptyString(request.contractId)
    )
    || (
      request.affectedOperationIds !== undefined
      && !stringArray(request.affectedOperationIds)
    )
    || (
      request.toolId !== undefined
      && !nonemptyString(request.toolId)
    )
    || (
      request.diff !== undefined
      && typeof request.diff !== 'string'
    )
    || (
      request.argumentsPreview !== undefined
      && typeof request.argumentsPreview !== 'string'
    )
  ) {
    return false;
  }
  return true;
}

function validWorkspaceProjection(value: unknown): boolean {
  const projection = recordValue(value);
  return Boolean(
    projection
    && exactKeys(projection, ['revision', 'changedTargets'])
    && nonnegativeInteger(projection.revision)
    && stringArray(projection.changedTargets)
  );
}

function validNativeTurnLifecycle(
  turn: AgentTimelineTurn
): boolean {
  if (terminalTimelineStatus(turn.status)) {
    return nonemptyString(turn.completedAt);
  }
  return turn.completedAt === undefined;
}

function isSharedConversationWorkSegmentV1(
  value: unknown
): value is AgentTimelineWorkSegment {
  const segment = recordValue(value);
  const provenance = recordValue(segment?.provenance);
  if (
    !segment
    || !nonemptyString(segment.id)
    || !nonnegativeInteger(segment.revision)
    || !nonnegativeInteger(segment.sequence)
    || !workSegmentLifecycle(segment.lifecycle)
    || (
      segment.attention !== null
      && !validWorkAttention(segment.attention)
    )
    || !Array.isArray(segment.operations)
    || !provenance
    || !projectionOrigin(provenance.origin)
    || !projectionAuthority(provenance.authority)
    || !stringArray(provenance.sourceEventRefs)
    || !stringArray(provenance.factRefs)
    || !stringArray(provenance.evidenceRefs)
    || !validProvenance(provenance)
    || !stringArray(segment.factRefs)
    || (
      segment.startedAt !== undefined
      && typeof segment.startedAt !== 'string'
    )
    || (
      segment.completedAt !== undefined
      && typeof segment.completedAt !== 'string'
    )
    || (
      segment.lifecycle === 'active'
      && segment.completedAt !== undefined
    )
    || (
      segment.lifecycle !== 'active'
      && !nonemptyString(segment.completedAt)
    )
    || containsPrivateProjectionData(segment)
  ) {
    return false;
  }
  const keys = new Set([
    'id',
    'revision',
    'sequence',
    'lifecycle',
    'attention',
    'operations',
    'startedAt',
    'completedAt',
    'provenance',
    'factRefs',
  ]);
  if (Object.keys(segment).some((key) => !keys.has(key))) return false;
  const operationIds = new Set<string>();
  return segment.operations.every((operation) => {
    if (
      !validWorkOperation(operation)
      || operationIds.has(operation.operationId)
    ) {
      return false;
    }
    operationIds.add(operation.operationId);
    return true;
  });
}

function validWorkOperation(value: unknown): value is AgentTimelineWorkOperation {
  const operation = recordValue(value);
  if (
    !operation
    || !nonemptyString(operation.operationId)
    || !nonemptyString(operation.toolId)
    || !workOperationStatus(operation.status)
    || (
      operation.invocationId !== undefined
      && !nonemptyString(operation.invocationId)
    )
    || (
      operation.displayName !== undefined
      && typeof operation.displayName !== 'string'
    )
    || (
      operation.canonicalAction !== undefined
      && typeof operation.canonicalAction !== 'string'
    )
    || (
      operation.effectSummary !== undefined
      && typeof operation.effectSummary !== 'string'
    )
    || (
      operation.startedAt !== undefined
      && typeof operation.startedAt !== 'string'
    )
    || (
      operation.completedAt !== undefined
      && typeof operation.completedAt !== 'string'
    )
    || !stringArray(operation.resourceRefs)
    || !stringArray(operation.factRefs)
    || !stringArray(operation.effectRefs)
    || (
      operation.targets !== undefined
      && !stringArray(operation.targets)
    )
    || (
      operation.attempts !== undefined
      && !Array.isArray(operation.attempts)
    )
    || containsPrivateProjectionData(operation)
  ) {
    return false;
  }
  const keys = new Set([
    'operationId',
    'invocationId',
    'attempts',
    'toolId',
    'displayName',
    'status',
    'canonicalAction',
    'targets',
    'effectSummary',
    'resourceRefs',
    'factRefs',
    'effectRefs',
    'startedAt',
    'completedAt',
  ]);
  if (Object.keys(operation).some((key) => !keys.has(key))) return false;
  const attemptIds = new Set<string>();
  return (operation.attempts ?? []).every((value) => {
    const attempt = recordValue(value);
    if (
      !attempt
      || !nonemptyString(attempt.attemptId)
      || attemptIds.has(attempt.attemptId)
      || (
        attempt.status !== undefined
        && !workOperationStatus(attempt.status)
      )
      || (
        attempt.startedAt !== undefined
        && !nonemptyString(attempt.startedAt)
      )
      || (
        attempt.completedAt !== undefined
        && !nonemptyString(attempt.completedAt)
      )
      || Object.keys(attempt).some(
        (key) =>
          key !== 'attemptId'
          && key !== 'status'
          && key !== 'startedAt'
          && key !== 'completedAt'
      )
    ) {
      return false;
    }
    attemptIds.add(attempt.attemptId);
    return true;
  });
}

function validWorkAttention(value: unknown): boolean {
  const attention = recordValue(value);
  return Boolean(
    attention
    && (
      attention.kind === 'capability'
      || attention.kind === 'denial'
      || attention.kind === 'failure'
      || attention.kind === 'observedEffectFailure'
      || attention.kind === 'indeterminate'
    )
    && (
      attention.status === 'unresolved'
      || attention.status === 'resolved'
    )
    && nonemptyString(attention.summary)
    && (
      attention.operationId === undefined
      || nonemptyString(attention.operationId)
    )
    && stringArray(attention.factRefs)
    && Object.keys(attention).every(
      (key) =>
        key === 'kind'
        || key === 'status'
        || key === 'summary'
        || key === 'operationId'
        || key === 'factRefs'
    )
  );
}

function validTimelineAttachments(value: unknown): boolean {
  if (value === undefined) return true;
  try {
    decodeAgentInputAttachmentsV2(value);
    return true;
  } catch {
    return false;
  }
}

function validTokenUsageProjection(value: unknown): boolean {
  const projection = recordValue(value);
  const totals = recordValue(projection?.totals);
  const requests = projection?.requests;
  if (
    !projection
    || Object.keys(projection).some(
      (key) => key !== 'totals' && key !== 'requests'
    )
    || !totals
    || !validTokenUsageTotals(totals)
    || !Array.isArray(requests)
  ) {
    return false;
  }
  const requestIds = new Set<string>();
  return requests.every((value) => {
    const request = recordValue(value);
    const valid = Boolean(
      request
      && Object.keys(request).every((key) => new Set([
        'requestId',
        'turnId',
        'userEventId',
        'title',
        'startedAt',
        'completedAt',
        'stages',
        'promptCacheHitTokens',
        'promptCacheMissTokens',
        'cachedTokens',
        'promptTokens',
        'completionTokens',
        'totalTokens',
        'providerCallCount',
        'providers',
      ]).has(key))
      && nonemptyString(request.requestId)
      && nonemptyString(request.turnId)
      && nonemptyString(request.userEventId)
      && nonemptyString(request.title)
      && (
        request.startedAt === undefined
        || nonemptyString(request.startedAt)
      )
      && (
        request.completedAt === undefined
        || nonemptyString(request.completedAt)
      )
      && stringArray(request.stages)
      && validTokenUsageTotals(request)
    );
    if (!valid || !request) return false;
    const requestId = request.requestId as string;
    if (requestIds.has(requestId)) return false;
    requestIds.add(requestId);
    return true;
  });
}

function validTokenUsageTotals(value: Record<string, unknown>): boolean {
  const numericFields = [
    'promptCacheHitTokens',
    'promptCacheMissTokens',
    'cachedTokens',
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'providerCallCount',
  ];
  return numericFields.every(
    (field) =>
      typeof value[field] === 'number'
      && Number.isSafeInteger(value[field])
      && Number(value[field]) >= 0
      && Number(value[field]) <= MAX_PROVIDER_USAGE_TOKENS_V2
  )
    && Array.isArray(value.providers)
    && value.providers.every(
      (provider) =>
        typeof provider === 'string'
        && provider.length > 0
        && provider.trim() === provider
        && new TextEncoder().encode(provider).byteLength <= 1024
    );
}

function projectionTurn(
  context: ProjectionContext,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  runId: string | undefined
): MutableTurn {
  const inputId = event.kind === 'user_msg'
    ? stringValue(payload?.inputId) ?? event.id
    : undefined;
  const controlEpoch = nonnegativeIntegerValue(payload?.controlEpoch);
  const providerTurnId = stringValue(payload?.providerTurnId);
  const runKey = runId ?? context.sessionId;
  const inputKey = inputId ? `${runKey}:${inputId}` : undefined;
  const epochKey = controlEpoch === undefined
    ? undefined
    : `${runKey}:${controlEpoch}`;

  if (event.kind === 'user_msg') {
    const existing = inputKey
      ? context.turnsByInputId.get(inputKey)
      : undefined;
    if (existing) {
      context.currentTurn = existing;
      return existing;
    }
    return createProjectionTurn(
      context,
      event,
      runId,
      inputId,
      controlEpoch
    );
  }
  if (providerTurnId) {
    const providerTurn =
      context.turnsByProviderTurnId.get(`${runKey}:${providerTurnId}`);
    if (providerTurn) {
      context.currentTurn = providerTurn;
      return providerTurn;
    }
  }
  if (epochKey) {
    const epochTurn = context.turnsByControlEpoch.get(epochKey);
    if (epochTurn) {
      if (providerTurnId) {
        context.turnsByProviderTurnId.set(
          `${runKey}:${providerTurnId}`,
          epochTurn
        );
      }
      context.currentTurn = epochTurn;
      return epochTurn;
    }
  }
  if (runId) {
    const existing = context.turnsByRunId.get(runId);
    if (existing) {
      if (providerTurnId) {
        context.turnsByProviderTurnId.set(
          `${runKey}:${providerTurnId}`,
          existing
        );
      }
      context.currentTurn = existing;
      return existing;
    }
  }
  if (!runId && context.currentTurn) {
    return context.currentTurn;
  }
  const created = createProjectionTurn(
    context,
    event,
    runId,
    undefined,
    controlEpoch
  );
  if (providerTurnId) {
    context.turnsByProviderTurnId.set(
      `${runKey}:${providerTurnId}`,
      created
    );
  }
  return created;
}

function createProjectionTurn(
  context: ProjectionContext,
  event: AgentEvent,
  runId: string | undefined,
  inputId: string | undefined,
  controlEpoch: number | undefined
): MutableTurn {
  const runKey = runId ?? context.sessionId;
  const previousRunTurn = runId
    ? context.turnsByRunId.get(runId)
    : context.currentTurn;
  if (
    inputId
    && previousRunTurn
    && previousRunTurn.status !== 'completed'
    && previousRunTurn.status !== 'cancelled'
    && previousRunTurn.status !== 'failed'
  ) {
    previousRunTurn.status = 'cancelled';
    previousRunTurn.completedAt = nondecreasingTimestamp(
      previousRunTurn.startedAt,
      event.ts
    );
    previousRunTurn.terminalEvent = event;
    settleTerminalTurnArtifacts(previousRunTurn, event);
  }
  const id = inputId
    ? `turn:${runKey}:input:${inputId}`
    : runId
      ? `turn:${runId}:${context.turns.length + 1}`
      : `turn:${event.id}`;
  const turn: MutableTurn = {
    id,
    sequence: context.turns.length,
    sessionId: context.sessionId,
    runId,
    inputId,
    controlEpoch,
    status: 'running',
    startedAt: event.ts,
    blocks: [],
    workSegments: [],
    parts: [],
    providerStreamSequences: new Map(),
  };
  context.turns.push(turn);
  if (runId) context.turnsByRunId.set(runId, turn);
  if (inputId) {
    context.turnsByInputId.set(`${runKey}:${inputId}`, turn);
  }
  if (controlEpoch !== undefined) {
    context.turnsByControlEpoch.set(
      `${runKey}:${controlEpoch}`,
      turn
    );
  }
  context.currentTurn = turn;
  return turn;
}

function upsertTurnBlock(
  turn: MutableTurn,
  block: AgentTimelineBlock
): void {
  const existingIndex = turn.blocks.findIndex(
    (candidate) => candidate.id === block.id
  );
  if (existingIndex === -1) {
    turn.blocks.push(block);
    turn.parts.push({ kind: 'block', blockId: block.id });
    return;
  }
  turn.blocks[existingIndex] = {
    ...block,
    sequence:
      turn.blocks[existingIndex]?.sequence
      ?? block.sequence,
  };
}

function projectProviderOutputIntoTurn(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  committed: boolean
): boolean {
  const projectionKind = stringValue(payload?.projectionKind);
  const providerTurnId = stringValue(payload?.providerTurnId);
  if (projectionKind === 'provider.composing') {
    return projectProviderComposingIntoTurn(
      turn,
      event,
      payload,
      committed
    );
  }
  const items = arrayRecords(payload?.orderedItems);
  if (
    !providerTurnId
    || items.length === 0
    || (
      projectionKind !== 'provider.completed'
      && projectionKind !== 'diagnostic'
    )
  ) {
    return false;
  }

  const hasTools = items.some((item) => item.kind === 'toolCall');
  const terminalScope = stringValue(payload?.terminalScope);
  const textRoles = providerTextSettledRoles(
    items,
    hasTools,
    stringValue(payload?.outputKind),
    terminalScope
  );
  const desiredParts: AgentTimelineTurnPart[] = [];
  const relatedBlockIds = new Set<string>();
  const relatedSegmentIds = new Set<string>();
  let providerGroupIndex = 0;
  let activeProviderSegment: AgentTimelineWorkSegment | undefined;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === 'text') {
      const phase = stringValue(item.phase);
      const text = textContentValue(item.text);
      if (
        !text
        || (
          phase !== 'commentary'
          && phase !== 'final_answer'
          && phase !== 'unknown'
        )
      ) {
        continue;
      }
      const settledRole = textRoles.get(index) ?? 'commentary';
      let combinedText = text;
      let lastIndex = index;
      let explicitPhase: 'commentary' | 'final_answer' | undefined =
        phase === 'commentary'
          ? 'commentary'
          : phase === 'final_answer' && settledRole === 'finalAnswer'
            ? 'final_answer'
            : undefined;
      if (settledRole === 'finalAnswer') {
        while (lastIndex + 1 < items.length) {
          const next = items[lastIndex + 1]!;
          const nextPhase = stringValue(next.phase);
          const nextText = textContentValue(next.text);
          if (
            next.kind !== 'text'
            || !nextText
            || textRoles.get(lastIndex + 1) !== 'finalAnswer'
          ) {
            break;
          }
          combinedText += nextText;
          lastIndex += 1;
          if (nextPhase !== explicitPhase) explicitPhase = undefined;
        }
      }
      const textOrdinal = nonnegativeIntegerValue(item.textOrdinal)
        ?? index + 1;
      const blockId = [
        'provider',
        stringValue(payload?.runId) ?? 'run',
        providerTurnId,
        'text',
        textOrdinal,
      ].join(':');
      const syntheticPayload: Record<string, unknown> = {
        runId: payload?.runId,
        providerTurnId,
        projectionKind: 'provider.outputText',
        outputKind: payload?.outputKind,
        status: 'completed',
        content: combinedText,
        ...(terminalScope ? { terminalScope } : {}),
        ...(explicitPhase ? { providerPhase: explicitPhase } : {}),
      };
      const syntheticEvent: AgentEvent = {
        id: event.id,
        sessionId: event.sessionId,
        ts: event.ts,
        kind: 'assistant_msg',
        payload: syntheticPayload,
      };
      const block = projectionBlock(
        syntheticEvent,
        syntheticPayload,
        turn.blocks.length,
        committed
      );
      if (block) {
        const existing = turn.blocks.find(
          (candidate) => candidate.id === blockId
        );
        block.id = blockId;
        block.revision = (existing?.revision ?? 0) + 1;
        block.entryRole = settledRole === 'commentary'
          ? 'agentUpdate'
          : 'finalAnswer';
        block.bodyMarkdown = combinedText;
        block.summary = combinedText;
        block.provenance.sourceEventRefs = appendUniqueStrings(
          existing?.provenance.sourceEventRefs ?? [],
          [event.id]
        );
        upsertTurnBlock(turn, block);
        updateTurnStatus(
          turn,
          syntheticEvent,
          syntheticPayload,
          block
        );
        relatedBlockIds.add(blockId);
        desiredParts.push({ kind: 'block', blockId });
      }
      if (settledRole === 'commentary') {
        activeProviderSegment = undefined;
        turn.activeWorkSegmentId = undefined;
      }
      index = lastIndex;
      continue;
    }

    if (item.kind !== 'toolCall') continue;
    const operationId = stringValue(item.operationId);
    const toolId = stringValue(item.toolId);
    if (!operationId || !toolId) continue;
    if (!activeProviderSegment) {
      providerGroupIndex += 1;
      activeProviderSegment = providerWorkSegment(
        turn,
        providerTurnId,
        providerGroupIndex,
        event
      );
      relatedSegmentIds.add(activeProviderSegment.id);
      desiredParts.push({
        kind: 'workSegment',
        workSegmentId: activeProviderSegment.id,
      });
    }
    const operation = moveOrEnsureProviderOperation(
      turn,
      activeProviderSegment,
      operationId,
      toolId,
      event.ts
    );
    const status = providerQueueOperationStatus(item);
    if (
      !terminalWorkOperationStatus(operation.status)
      || operation.status === status
    ) {
      operation.status = status;
    }
    const invocationId = stringValue(item.invocationId);
    if (invocationId) operation.invocationId = invocationId;
    const terminalFactId = stringValue(item.terminalFactId);
    if (terminalFactId) {
      operation.factRefs = appendUniqueStrings(
        operation.factRefs,
        [terminalFactId]
      );
    }
    if (terminalWorkOperationStatus(operation.status)) {
      operation.completedAt = event.ts;
    }
    touchWorkSegment(
      activeProviderSegment,
      event,
      terminalFactId ? [terminalFactId] : []
    );
    turn.activeWorkSegmentId = activeProviderSegment.id;
  }

  pruneEmptyWorkSegments(turn);
  reorderProviderParts(
    turn,
    desiredParts,
    relatedBlockIds,
    relatedSegmentIds
  );
  return true;
}

function projectProviderComposingIntoTurn(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  committed: boolean
): boolean {
  const runId = stringValue(payload?.runId);
  const providerTurnId = stringValue(payload?.providerTurnId);
  const textOrdinal = nonnegativeIntegerValue(payload?.textOrdinal);
  const streamSequence = nonnegativeIntegerValue(payload?.streamSequence);
  const textDelta = textContentValue(payload?.content);
  const providerPhase = stringValue(payload?.providerPhase);
  const controlEpoch = nonnegativeIntegerValue(payload?.controlEpoch);
  if (
    !runId
    || !providerTurnId
    || textOrdinal === undefined
    || textOrdinal === 0
    || streamSequence === undefined
    || streamSequence === 0
    || controlEpoch === undefined
    || controlEpoch === 0
    || (
      turn.controlEpoch !== undefined
      && turn.controlEpoch !== controlEpoch
    )
    || textDelta === undefined
    || (
      providerPhase !== undefined
      && providerPhase !== 'commentary'
    )
  ) {
    throw new Error('session_projection_provider_composing_invalid');
  }
  const lastStreamSequence = turn.providerStreamSequences.get(
    providerTurnId
  );
  if (
    (lastStreamSequence === undefined && streamSequence !== 1)
    || (
      lastStreamSequence !== undefined
      && streamSequence !== lastStreamSequence + 1
    )
  ) {
    throw new Error('session_projection_provider_composing_sequence_invalid');
  }
  turn.providerStreamSequences.set(providerTurnId, streamSequence);
  const blockId = [
    'provider',
    runId,
    providerTurnId,
    'text',
    textOrdinal,
  ].join(':');
  const existing = turn.blocks.find(
    (candidate) => candidate.id === blockId
  );
  const block = projectionBlock(
    event,
    payload,
    turn.blocks.length,
    committed
  );
  if (!block) {
    throw new Error('session_projection_provider_composing_invalid');
  }
  block.id = blockId;
  block.revision = (existing?.revision ?? 0) + 1;
  block.entryRole = 'agentUpdate';
  block.status = 'running';
  block.bodyMarkdown = `${existing?.bodyMarkdown ?? ''}${textDelta}`;
  block.summary = block.bodyMarkdown;
  block.provenance.sourceEventRefs = appendUniqueStrings(
    existing?.provenance.sourceEventRefs ?? [],
    [event.id]
  );
  upsertTurnBlock(turn, block);
  turn.status = 'running';
  turn.completedAt = undefined;
  turn.activeWorkSegmentId = undefined;
  return true;
}

function providerTextSettledRoles(
  items: Array<Record<string, unknown>>,
  hasTools: boolean,
  outputKind: string | undefined,
  terminalScope: string | undefined
): Map<number, 'commentary' | 'finalAnswer'> {
  const roles = new Map<number, 'commentary' | 'finalAnswer'>();
  items.forEach((item, index) => {
    if (item.kind === 'text') roles.set(index, 'commentary');
  });
  if (
    hasTools
    || terminalScope !== 'turn'
    || outputKind !== 'answer'
  ) {
    return roles;
  }
  const firstFinalIndex = items.findIndex(
    (item) => item.kind === 'text' && item.phase === 'final_answer'
  );
  const lastCommentaryIndex = items.findLastIndex(
    (item) => item.kind === 'text' && item.phase === 'commentary'
  );
  items.forEach((item, index) => {
    if (
      item.kind === 'text'
      && (
        firstFinalIndex >= 0
          ? index >= firstFinalIndex
          : index > lastCommentaryIndex && item.phase === 'unknown'
      )
    ) {
      roles.set(index, 'finalAnswer');
    }
  });
  return roles;
}

function providerWorkSegment(
  turn: MutableTurn,
  providerTurnId: string,
  groupIndex: number,
  event: AgentEvent
): AgentTimelineWorkSegment {
  const id = `work:${turn.id}:provider:${providerTurnId}:${groupIndex}`;
  const existing = turn.workSegments.find((segment) => segment.id === id);
  if (existing) return existing;
  const segment: AgentTimelineWorkSegment = {
    id,
    revision: 1,
    sequence: turn.workSegments.length,
    lifecycle: 'active',
    attention: null,
    operations: [],
    startedAt: event.ts,
    provenance: {
      origin: 'session',
      authority: 'kernel',
      sourceEventRefs: [event.id],
      factRefs: [],
      evidenceRefs: [],
    },
    factRefs: [],
  };
  turn.workSegments.push(segment);
  turn.parts.push({ kind: 'workSegment', workSegmentId: id });
  return segment;
}

function moveOrEnsureProviderOperation(
  turn: MutableTurn,
  target: AgentTimelineWorkSegment,
  operationId: string,
  toolId: string,
  startedAt: string
): AgentTimelineWorkOperation {
  const source = turn.workSegments.find((segment) =>
    segment.operations.some((operation) =>
      operation.operationId === operationId
    )
  );
  const existing = source?.operations.find((operation) =>
    operation.operationId === operationId
  );
  if (!source || !existing || source === target) {
    return ensureWorkOperation(
      target,
      operationId,
      toolId,
      startedAt,
      'preparing'
    );
  }
  source.operations = source.operations.filter((operation) =>
    operation.operationId !== operationId
  );
  if (source.attention?.operationId === operationId) {
    target.attention = source.attention;
    source.attention = null;
  }
  target.operations.push(existing);
  target.provenance.sourceEventRefs = appendUniqueStrings(
    target.provenance.sourceEventRefs,
    source.provenance.sourceEventRefs
  );
  target.provenance.factRefs = appendUniqueStrings(
    target.provenance.factRefs,
    existing.factRefs
  );
  target.factRefs = appendUniqueStrings(
    target.factRefs,
    existing.factRefs
  );
  return existing;
}

function providerQueueOperationStatus(
  item: Record<string, unknown>
): AgentTimelineWorkOperationStatus {
  const status = stringValue(item.status);
  if (status === 'pending') return 'preparing';
  if (status === 'submitting') return 'queued';
  if (status === 'awaitingCapability') return 'awaitingCapability';
  if (status === 'awaitingInvocation') return 'running';
  if (status === 'completed') return 'completed';
  if (status === 'unexecuted') return 'unexecuted';
  if (status !== 'aborted') return 'preparing';
  const terminalFactKind = stringValue(item.terminalFactKind);
  if (terminalFactKind) return workStatusForFactKind(terminalFactKind);
  const reason = stringValue(item.settlementReason);
  if (
    reason === 'userInput'
    || reason === 'runCancelled'
    || reason === 'userRequested'
  ) {
    return 'cancelled';
  }
  if (reason === 'controlEpochSuperseded') return 'stale';
  if (reason === 'indeterminate') return 'indeterminate';
  return 'failed';
}

function pruneEmptyWorkSegments(turn: MutableTurn): void {
  const removed = new Set(
    turn.workSegments
      .filter((segment) => segment.operations.length === 0)
      .map((segment) => segment.id)
  );
  if (removed.size === 0) return;
  turn.workSegments = turn.workSegments.filter(
    (segment) => !removed.has(segment.id)
  );
  turn.parts = turn.parts.filter(
    (part) =>
      part.kind !== 'workSegment'
      || !removed.has(part.workSegmentId)
  );
  if (
    turn.activeWorkSegmentId
    && removed.has(turn.activeWorkSegmentId)
  ) {
    turn.activeWorkSegmentId = undefined;
  }
}

function reorderProviderParts(
  turn: MutableTurn,
  desired: AgentTimelineTurnPart[],
  blockIds: Set<string>,
  segmentIds: Set<string>
): void {
  if (desired.length === 0) return;
  const related = (part: AgentTimelineTurnPart): boolean =>
    part.kind === 'block'
      ? blockIds.has(part.blockId)
      : segmentIds.has(part.workSegmentId);
  const anchor = turn.parts.findIndex(related);
  const retained = turn.parts.filter((part) => !related(part));
  retained.splice(anchor < 0 ? retained.length : anchor, 0, ...desired);
  turn.parts = retained;
}

function projectWorkEventIntoTurn(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  _committed: boolean
): void {
  const projectionKind = stringValue(payload?.projectionKind);
  if (event.kind === 'tool_call') {
    const operationId = stringValue(payload?.operationId);
    if (!operationId) return;
    const segment = segmentForOperation(turn, operationId, event);
    const replyKind = stringValue(payload?.status);
    const replyReason = stringValue(payload?.replyReason);
    const status: AgentTimelineWorkOperationStatus =
      replyKind === 'admitted' ? 'queued'
        : replyKind === 'awaitingCapability'
          ? 'awaitingCapability'
          : replyKind === 'rejected'
            ? rejectedOperationStatus(replyReason)
            : 'preparing';
    const operation = ensureWorkOperation(
      segment,
      operationId,
      stringValue(payload?.toolId) ?? 'kernel.tool',
      event.ts,
      status
    );
    operation.status = status;
    const invocationId = stringValue(payload?.invocationId);
    if (invocationId) operation.invocationId = invocationId;
    if (terminalWorkOperationStatus(status)) {
      operation.completedAt = event.ts;
    }
    if (status === 'awaitingCapability') {
      segment.attention = workAttention(
        'capability',
        'unresolved',
        'Canonical capability approval is required.',
        operationId,
        []
      );
    } else if (status === 'denied') {
      segment.attention = workAttention(
        'denial',
        'resolved',
        'Kernel rejected the operation before execution.',
        operationId,
        []
      );
    } else if (status === 'failed') {
      segment.attention = workAttention(
        'failure',
        'resolved',
        'Kernel rejected the operation before execution.',
        operationId,
        []
      );
    }
    touchWorkSegment(segment, event, []);
    return;
  }

  if (projectionKind === 'capability.awaiting') {
    const operationId = stringValue(payload?.operationId);
    if (!operationId) return;
    const segment = segmentForOperation(turn, operationId, event);
    const operation = ensureWorkOperation(
      segment,
      operationId,
      stringValue(payload?.toolId)
        ?? stringValue(payload?.toolName)
        ?? 'kernel.tool',
      event.ts,
      'awaitingCapability'
    );
    operation.status = 'awaitingCapability';
    const invocationId = stringValue(payload?.invocationId);
    if (invocationId) operation.invocationId = invocationId;
    segment.attention = workAttention(
      'capability',
      'unresolved',
      stringValue(payload?.summary)
        ?? 'Canonical capability approval is required.',
      operationId,
      stringArrayValue(payload?.factIds)
    );
    touchWorkSegment(
      segment,
      event,
      stringArrayValue(payload?.factIds)
    );
    return;
  }

  if (projectionKind === 'authorization.decided') {
    applyAuthorizationDecisionToWork(turn, event, payload);
    return;
  }

  if (projectionKind === 'kernelFacts.reconciled') {
    for (const value of arrayRecords(payload?.operationFacts)) {
      applyCanonicalWorkFact(turn, event, value);
    }
    return;
  }

  if (projectionKind === 'run.cancelled') {
    for (const segment of turn.workSegments) {
      for (const operation of segment.operations) {
        if (!terminalWorkOperationStatus(operation.status)) {
          operation.status = 'cancelled';
          operation.completedAt = event.ts;
        }
      }
      segment.lifecycle = 'cancelled';
      segment.completedAt = event.ts;
      touchWorkSegment(segment, event, []);
    }
    turn.activeWorkSegmentId = undefined;
    return;
  }

  if (
    event.kind === 'error'
    && stringValue(payload?.operationId)
  ) {
    const operationId = stringValue(payload?.operationId)!;
    const segment = segmentForOperation(turn, operationId, event);
    const operation = ensureWorkOperation(
      segment,
      operationId,
      stringValue(payload?.toolId) ?? 'kernel.tool',
      event.ts,
      'failed'
    );
    operation.status = 'failed';
    operation.completedAt = event.ts;
    segment.attention = workAttention(
      'failure',
      'unresolved',
      stringValue(payload?.message)
        ?? stringValue(payload?.summary)
        ?? 'The operation failed.',
      operationId,
      stringArrayValue(payload?.factIds)
    );
    touchWorkSegment(
      segment,
      event,
      stringArrayValue(payload?.factIds)
    );
  }
}

function segmentForOperation(
  turn: MutableTurn,
  operationId: string,
  event: AgentEvent
): AgentTimelineWorkSegment {
  for (let index = turn.workSegments.length - 1; index >= 0; index -= 1) {
    const segment = turn.workSegments[index];
    if (
      segment
      && segment.operations.some(
        (operation) => operation.operationId === operationId
      )
    ) {
      return segment;
    }
  }
  const active = turn.activeWorkSegmentId
    ? turn.workSegments.find(
        (segment) => segment.id === turn.activeWorkSegmentId
      )
    : undefined;
  if (active) return active;
  const segment: AgentTimelineWorkSegment = {
    id: `work:${turn.id}:${turn.workSegments.length + 1}`,
    revision: 1,
    sequence: turn.workSegments.length,
    lifecycle: 'active',
    attention: null,
    operations: [],
    startedAt: event.ts,
    provenance: {
      origin: 'session',
      authority: 'kernel',
      sourceEventRefs: [event.id],
      factRefs: [],
      evidenceRefs: [],
    },
    factRefs: [],
  };
  turn.workSegments.push(segment);
  turn.parts.push({
    kind: 'workSegment',
    workSegmentId: segment.id,
  });
  turn.activeWorkSegmentId = segment.id;
  return segment;
}

function ensureWorkOperation(
  segment: AgentTimelineWorkSegment,
  operationId: string,
  toolId: string,
  startedAt: string,
  status: AgentTimelineWorkOperationStatus
): AgentTimelineWorkOperation {
  const existing = segment.operations.find(
    (operation) => operation.operationId === operationId
  );
  if (existing) {
    if (
      existing.toolId === 'kernel.tool'
      && toolId !== 'kernel.tool'
    ) {
      existing.toolId = toolId;
      existing.displayName = toolId;
    }
    return existing;
  }
  const operation: AgentTimelineWorkOperation = {
    operationId,
    toolId,
    displayName: toolId,
    status,
    resourceRefs: [],
    factRefs: [],
    effectRefs: [],
    startedAt,
  };
  segment.operations.push(operation);
  return operation;
}

function applyAuthorizationDecisionToWork(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): void {
  const operationId = stringValue(payload?.operationId);
  const factId = stringValue(payload?.factId);
  const factKind = stringValue(payload?.factKind);
  const allowed =
    factKind === 'capabilityIssued'
    || factKind === 'expansionAllowed';
  const denied =
    factKind === 'capabilityDenied'
    || factKind === 'expansionDenied';
  if (!operationId || !factId || (!allowed && !denied)) return;
  const segment = turn.workSegments.find((candidate) =>
    candidate.operations.some((operation) =>
      operation.operationId === operationId
    )
  );
  const operation = segment?.operations.find((candidate) =>
    candidate.operationId === operationId
  );
  if (!segment || !operation) return;
  const factRefs = [factId];
  if (allowed) {
    if (segment.attention?.operationId === operationId) {
      segment.attention = {
        ...segment.attention,
        status: 'resolved',
        factRefs: appendUniqueStrings(
          segment.attention.factRefs,
          factRefs
        ),
      };
    }
  } else if (operation.status === 'denied') {
    segment.attention = workAttention(
      'denial',
      'resolved',
      stringValue(payload?.guidance)
        ?? 'The requested capability was denied.',
      operationId,
      factRefs
    );
  }
  operation.factRefs = appendUniqueStrings(
    operation.factRefs,
    factRefs
  );
  touchWorkSegment(segment, event, factRefs);
}

function applyCanonicalWorkFact(
  turn: MutableTurn,
  sourceEvent: AgentEvent,
  fact: Record<string, unknown>
): void {
  const operationId = stringValue(fact.operationId);
  const factId = stringValue(fact.factId);
  if (!operationId || !factId) return;
  const segment = segmentForOperation(turn, operationId, sourceEvent);
  const factKind = stringValue(fact.factKind) ?? 'unknown';
  const toolId = stringValue(fact.toolId) ?? 'kernel.tool';
  const operation = ensureWorkOperation(
    segment,
    operationId,
    toolId,
    stringValue(fact.recordedAt) ?? sourceEvent.ts,
    workStatusForFactKind(factKind)
  );
  const nextStatus = workStatusForFactKind(factKind);
  if (
    nextStatus !== 'preparing'
    || operation.status === 'preparing'
  ) {
    operation.status = nextStatus;
  }
  const invocationId = stringValue(fact.invocationId);
  if (invocationId) operation.invocationId = invocationId;
  const attemptId = stringValue(fact.attemptId);
  if (attemptId) {
    const existingAttempt = operation.attempts?.find(
      (attempt) => attempt.attemptId === attemptId
    );
    const attemptStatus = nextStatus === 'preparing'
      ? undefined
      : nextStatus;
    if (existingAttempt) {
      if (attemptStatus) existingAttempt.status = attemptStatus;
      if (
        terminalWorkOperationStatus(nextStatus)
        && !existingAttempt.completedAt
      ) {
        existingAttempt.completedAt =
          stringValue(fact.recordedAt) ?? sourceEvent.ts;
      }
    } else {
      operation.attempts = [
        ...(operation.attempts ?? []),
        {
          attemptId,
          ...(attemptStatus ? { status: attemptStatus } : {}),
          startedAt:
            stringValue(fact.recordedAt) ?? sourceEvent.ts,
          ...(terminalWorkOperationStatus(nextStatus)
            ? {
                completedAt:
                  stringValue(fact.recordedAt) ?? sourceEvent.ts,
              }
            : {}),
        },
      ];
    }
  }
  const resourceRefs = stringArrayValue(fact.resourceIds);
  operation.resourceRefs = appendUniqueStrings(
    operation.resourceRefs,
    resourceRefs
  );
  const canonicalTargets = stringArrayValue(fact.targets);
  operation.targets = appendUniqueStrings(
    operation.targets ?? [],
    canonicalTargets
  );
  operation.factRefs = appendUniqueStrings(
    operation.factRefs,
    [factId]
  );
  const effectId = stringValue(fact.effectId);
  if (effectId) {
    operation.effectRefs = appendUniqueStrings(
      operation.effectRefs,
      [effectId]
    );
  }
  const canonicalAction = stringValue(fact.canonicalAction);
  if (canonicalAction) operation.canonicalAction = canonicalAction;
  const effectSummary = stringValue(fact.effectSummary)
    ?? safeEffectSummary(factKind, resourceRefs.length);
  if (effectSummary) operation.effectSummary = effectSummary;
  if (terminalWorkOperationStatus(nextStatus)) {
    operation.completedAt =
      stringValue(fact.recordedAt) ?? sourceEvent.ts;
  }
  if (nextStatus === 'failedAfterObservedEffect') {
    segment.attention = workAttention(
      'observedEffectFailure',
      'unresolved',
      'The tool failed after an observable effect.',
      operationId,
      [factId]
    );
  } else if (nextStatus === 'indeterminate') {
    segment.attention = workAttention(
      'indeterminate',
      'unresolved',
      'The final effect state is indeterminate.',
      operationId,
      [factId]
    );
  } else if (nextStatus === 'failed') {
    segment.attention = workAttention(
      'failure',
      'resolved',
      'The tool failed before an observable effect.',
      operationId,
      [factId]
    );
  } else if (nextStatus === 'denied') {
    segment.attention = workAttention(
      'denial',
      'resolved',
      'The requested capability was denied.',
      operationId,
      [factId]
    );
  } else if (nextStatus === 'awaitingCapability') {
    segment.attention = workAttention(
      'capability',
      'unresolved',
      'Canonical capability approval is required.',
      operationId,
      [factId]
    );
  } else if (
    segment.attention?.operationId === operationId
    && operation.status === 'completed'
  ) {
    segment.attention = {
      ...segment.attention,
      status: 'resolved',
      factRefs: appendUniqueStrings(
        segment.attention.factRefs,
        [factId]
      ),
    };
  }
  touchWorkSegment(segment, sourceEvent, [factId]);
}

function touchWorkSegment(
  segment: AgentTimelineWorkSegment,
  event: AgentEvent,
  factRefs: string[]
): void {
  segment.revision += 1;
  segment.provenance.sourceEventRefs = appendUniqueStrings(
    segment.provenance.sourceEventRefs,
    [event.id]
  );
  segment.provenance.factRefs = appendUniqueStrings(
    segment.provenance.factRefs,
    factRefs
  );
  segment.factRefs = appendUniqueStrings(
    segment.factRefs,
    factRefs
  );
}

function workAttention(
  kind: AgentTimelineWorkAttention['kind'],
  status: AgentTimelineWorkAttention['status'],
  summary: string,
  operationId: string | undefined,
  factRefs: string[]
): AgentTimelineWorkAttention {
  return {
    kind,
    status,
    summary,
    ...(operationId ? { operationId } : {}),
    factRefs: [...new Set(factRefs)],
  };
}

function rejectedOperationStatus(
  reason: string | undefined
): AgentTimelineWorkOperationStatus {
  if (
    reason === 'runBusy'
    || reason === 'capacityExceeded'
  ) {
    return 'queued';
  }
  if (reason === 'staleControlEpoch') return 'stale';
  if (reason === 'indeterminateRecoveryRequired') {
    return 'indeterminate';
  }
  return 'unexecuted';
}

function workStatusForFactKind(
  factKind: string
): AgentTimelineWorkOperationStatus {
  if (
    factKind === 'toolIntentAdmitted'
    || factKind === 'toolAttemptPrepared'
    || factKind === 'capabilityIssued'
    || factKind === 'expansionAllowed'
  ) {
    return 'queued';
  }
  if (
    factKind === 'toolExecutionStarted'
    || factKind === 'toolCancellationObserved'
    || factKind === 'toolDeadlineObserved'
    || factKind === 'toolObserved'
    || factKind === 'toolObservedAfterCancel'
    || factKind === 'toolObservedAfterDeadline'
    || factKind === 'toolObservedAfterCancelAndDeadline'
  ) {
    return 'running';
  }
  if (factKind === 'toolCompleted') return 'completed';
  if (
    factKind === 'toolFailedBeforeEffect'
    || factKind === 'toolTimedOutBeforeEffect'
  ) {
    return 'failed';
  }
  if (factKind === 'toolCancelledBeforeEffect') return 'cancelled';
  if (factKind === 'toolFailedAfterObservedEffect') {
    return 'failedAfterObservedEffect';
  }
  if (factKind === 'toolIndeterminate') return 'indeterminate';
  if (
    factKind === 'capabilityDenied'
    || factKind === 'expansionDenied'
  ) {
    return 'denied';
  }
  if (factKind === 'capabilityAwaiting') {
    return 'awaitingCapability';
  }
  return 'preparing';
}

function safeEffectSummary(
  factKind: string,
  resourceCount: number
): string | undefined {
  if (!factKind.startsWith('toolObserved')) return undefined;
  return resourceCount > 0
    ? `Observed effect on ${resourceCount} canonical resource(s).`
    : 'Observed canonical tool effect.';
}

function finalizeTurnWorkSegments(
  turn: MutableTurn
): AgentTimelineWorkSegment[] {
  return turn.workSegments.map((segment) => {
    const operations = segment.operations.map((operation) => ({
      ...operation,
      resourceRefs: [...operation.resourceRefs],
      factRefs: [...operation.factRefs],
      effectRefs: [...operation.effectRefs],
      ...(operation.targets
        ? { targets: [...operation.targets] }
        : {}),
      ...(operation.attempts
        ? { attempts: operation.attempts.map((attempt) => ({ ...attempt })) }
        : {}),
    }));
    const allTerminal =
      operations.length > 0
      && operations.every((operation) =>
        terminalWorkOperationStatus(operation.status)
      );
    let lifecycle: AgentTimelineWorkSegment['lifecycle'] =
      segment.lifecycle === 'active'
        ? allTerminal ? 'completed' : 'active'
        : segment.lifecycle;
    if (
      allTerminal
      && operations.every((operation) =>
        operation.status === 'cancelled'
        || operation.status === 'stale'
        || operation.status === 'unexecuted'
      )
    ) {
      lifecycle = 'cancelled';
    }
    if (turn.status === 'cancelled' && !allTerminal) {
      lifecycle = 'cancelled';
    } else if (turn.status === 'failed' && !allTerminal) {
      lifecycle = 'failed';
    }
    const completedAt = lifecycle === 'active'
      ? undefined
      : latestTimestamp([
          ...operations.map((operation) => operation.completedAt),
          turn.completedAt,
          segment.completedAt,
        ]);
    return {
      ...segment,
      lifecycle,
      operations,
      ...(completedAt ? { completedAt } : {}),
    };
  });
}

function terminalWorkOperationStatus(
  status: AgentTimelineWorkOperationStatus
): boolean {
  return status === 'completed'
    || status === 'denied'
    || status === 'failed'
    || status === 'failedAfterObservedEffect'
    || status === 'indeterminate'
    || status === 'cancelled'
    || status === 'stale'
    || status === 'unexecuted';
}

function appendUniqueStrings(
  current: string[],
  additional: string[]
): string[] {
  return [...new Set([...current, ...additional])];
}

function latestTimestamp(
  values: Array<string | undefined>
): string | undefined {
  return values
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => {
      const leftTime = Date.parse(left);
      const rightTime = Date.parse(right);
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
        return rightTime - leftTime;
      }
      return right.localeCompare(left);
    })[0];
}

function projectionBlock(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  sequence: number,
  committed: boolean
): AgentTimelineBlock | null {
  if (!semanticHistoryBlockEvent(event)) return null;
  const kind = String(event.kind);
  const runId = stringValue(payload?.runId);
  const blockId = logicalBlockId(event, payload);
  const status = eventStatus(event, payload);
  const title = eventTitle(event, payload);
  const summary = eventSummary(event, payload);
  const bodyMarkdown = eventBody(event, payload);
  const narrativeKind = eventNarrativeKind(kind);
  const entry = eventEntryRole(kind);
  const origin = eventOrigin(kind);
  const authority = origin === 'kernel' ? 'kernel'
    : origin === 'user' ? 'user'
      : 'session';
  const interaction = interactionForEvent(event, payload);
  const structuredProjection = structuredProjectionForEvent(event, payload);
  const permission = event.kind === 'permission_request'
    ? permissionRequest(payload)
    : null;
  const providerPhase =
    payload?.providerPhase === 'commentary'
    || payload?.providerPhase === 'final_answer'
      ? payload.providerPhase
      : undefined;
  const attachments = event.kind === 'user_msg'
    ? decodeAgentInputAttachmentsV2(payload?.attachments)
    : undefined;
  return {
    id: blockId,
    sequence,
    revision: sequence + 1,
    deliveryMode: committed ? 'replay' : 'live',
    durability: committed ? 'committed' : 'live',
    kind: eventBlockKind(kind),
    narrativeKind,
    entryRole:
      kind === 'assistant_msg' && providerPhase === 'commentary'
        ? 'agentUpdate'
        : entry,
    ...(providerPhase ? { providerPhase } : {}),
    title,
    summary,
    status,
    defaultCollapsed: defaultCollapsed(kind, status),
    ...(bodyMarkdown ? { bodyMarkdown } : {}),
    ...(structuredProjection ? { structuredProjection } : {}),
    ...(interaction?.decisionRequest
      ? { decisionRequest: interaction.decisionRequest }
      : {}),
    ...(interaction
      ? {
          interaction: {
            interactionId: interaction.interactionId,
            interactionRevision: event.id,
            targetId: interaction.targetId,
            kind: interaction.kind,
            runId,
            state: 'open',
            decisionRequest: interaction.decisionRequest,
          },
          confirmable: true,
        }
      : { confirmable: false }),
    ...(permission ? { evidenceRefs: [permission.id] } : {}),
    ...(attachments && attachments.length > 0
      ? { attachments }
      : {}),
    provenance: {
      origin,
      authority,
      sourceEventRefs: [event.id],
      factRefs: stringArrayValue(payload?.factIds),
      evidenceRefs: permission ? [permission.id] : [],
    },
    languageBinding: {
      language: 'neutral',
      status: 'unavailable',
    },
    ...(narrativeKind === 'plan'
      ? { taskProjectionRef: `tasks:${stringValue(payload?.planId) ?? event.id}` }
      : {}),
  };
}

function semanticHistoryBlockEvent(event: AgentEvent): boolean {
  return event.kind === 'user_msg'
    || event.kind === 'assistant_msg'
    || event.kind === 'plan_card'
    || event.kind === 'permission_request'
    || event.kind === 'review_summary'
    || event.kind === 'error';
}

function logicalBlockId(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): string {
  const runId = stringValue(payload?.runId) ?? 'run';
  const providerTurnId = stringValue(payload?.providerTurnId);
  const projectionKind = stringValue(payload?.projectionKind);
  if (
    providerTurnId
    && (
      projectionKind === 'provider.started'
      || projectionKind === 'provider.completed'
      || projectionKind === 'provider.stale'
      || projectionKind === 'diagnostic'
    )
  ) {
    return `provider:${runId}:${providerTurnId}`;
  }
  if (event.kind === 'plan_card') {
    return `plan:${runId}:${stringValue(payload?.planId) ?? event.id}`;
  }
  if (event.kind === 'permission_request') {
    return `permission:${runId}:${permissionIdentity(payload) ?? event.id}`;
  }
  if (event.kind === 'review_summary') {
    return `review:${runId}:${stringValue(payload?.reviewId) ?? event.id}`;
  }
  return `event:${event.id}`;
}

function updateTurnStatus(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  block: AgentTimelineBlock
): void {
  if (block.status === 'failed') {
    if (event.kind === 'error' && !wholeTurnErrorEvent(event, payload)) {
      return;
    }
    turn.status = 'failed';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    turn.terminalEvent = event;
    return;
  }
  if (block.status === 'cancelled') {
    turn.status = 'cancelled';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    turn.terminalEvent = event;
    return;
  }
  if (
    event.kind === 'assistant_msg'
    && (
      payload?.providerPhase === 'final_answer'
      || (
        payload?.providerPhase !== 'commentary'
        && stringValue(payload?.terminalScope) === 'turn'
        && stringValue(payload?.outputKind) === 'answer'
        && stringValue(payload?.status) === 'completed'
      )
    )
  ) {
    turn.status = 'completed';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    turn.terminalEvent = event;
    return;
  }
  if (
    turn.status === 'completed'
    || turn.status === 'cancelled'
    || turn.status === 'failed'
  ) {
    return;
  }
  if (block.status === 'waiting') {
    turn.status = 'waiting';
    turn.completedAt = undefined;
    return;
  }
  turn.status = 'running';
  turn.completedAt = undefined;
}

function updateTurnStatusFromEvent(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): void {
  if (wholeTurnErrorEvent(event, payload)) {
    turn.status = 'failed';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    turn.terminalEvent = event;
    return;
  }
  if (event.kind !== 'session_run_state') return;
  const status = stringValue(payload?.status);
  const projectionKind = stringValue(payload?.projectionKind);
  if (projectionKind === 'run.cancelled' || status === 'cancelled') {
    turn.status = 'cancelled';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    turn.terminalEvent = event;
    return;
  }
  if (status === 'failed') {
    turn.status = 'failed';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    turn.terminalEvent = event;
    return;
  }
  if (status === 'waiting') {
    turn.status = 'waiting';
    turn.completedAt = undefined;
    return;
  }
  if (
    status === 'completed'
    && stringValue(payload?.reason) === 'waitCleared'
  ) {
    turn.status = 'running';
    turn.completedAt = undefined;
  }
}

function settleProjectionLifecycle(
  turn: MutableTurn,
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): void {
  if (stringValue(payload?.projectionKind) === 'provider.stale') {
    const providerTurnId = stringValue(payload?.providerTurnId);
    if (providerTurnId) {
      settleProviderTurnArtifacts(turn, event, providerTurnId);
    }
  }
  if (
    terminalTimelineStatus(turn.status)
    && turn.terminalEvent?.id === event.id
  ) {
    settleTerminalTurnArtifacts(turn, event);
  }
}

function settleProviderTurnArtifacts(
  turn: MutableTurn,
  event: AgentEvent,
  providerTurnId: string
): void {
  const runId = turn.runId ?? 'run';
  const blockPrefix = `provider:${runId}:${providerTurnId}:text:`;
  for (const block of turn.blocks) {
    if (
      !block.id.startsWith(blockPrefix)
      || terminalTimelineStatus(block.status)
    ) {
      continue;
    }
    settleTimelineBlock(block, event, 'cancelled');
  }
  const segmentMarker = `:provider:${providerTurnId}:`;
  for (const segment of turn.workSegments) {
    if (
      segment.lifecycle !== 'active'
      || !segment.id.includes(segmentMarker)
    ) {
      continue;
    }
    if (
      segment.operations.length > 0
      && segment.operations.every((operation) =>
        terminalWorkOperationStatus(operation.status)
      )
    ) {
      continue;
    }
    segment.lifecycle = 'cancelled';
    segment.completedAt = event.ts;
    touchWorkSegment(segment, event, []);
  }
}

function settleTerminalTurnArtifacts(
  turn: MutableTurn,
  event: AgentEvent
): void {
  if (!terminalTimelineStatus(turn.status)) return;
  for (const block of turn.blocks) {
    if (
      terminalTimelineStatus(block.status)
      || block.status === 'blocked'
      || block.interaction?.state === 'open'
    ) {
      continue;
    }
    settleTimelineBlock(
      block,
      event,
      block.kind === 'user' ? 'completed' : turn.status
    );
  }
  if (turn.status === 'completed') return;
  for (const segment of turn.workSegments) {
    if (segment.lifecycle !== 'active') continue;
    if (
      segment.operations.length > 0
      && segment.operations.every((operation) =>
        terminalWorkOperationStatus(operation.status)
      )
    ) {
      // A later turn-level failure cannot rewrite already-settled operation
      // facts. The finalizer derives completed/cancelled from those terminal
      // operation statuses without attaching the later error to the segment.
      continue;
    }
    segment.lifecycle = turn.status === 'cancelled'
      ? 'cancelled'
      : 'failed';
    segment.completedAt = event.ts;
    touchWorkSegment(segment, event, []);
  }
}

function settleTimelineBlock(
  block: AgentTimelineBlock,
  event: AgentEvent,
  status: AgentTimelineStatus
): void {
  block.revision = (block.revision ?? 0) + 1;
  block.status = status;
  block.provenance.sourceEventRefs = appendUniqueStrings(
    block.provenance.sourceEventRefs,
    [event.id]
  );
}

function buildTaskProjection(events: AgentEvent[]): AgentTimelineTaskProjection | undefined {
  let planEvent: AgentEvent | undefined;
  for (const event of events) {
    if (event.kind === 'plan_card') planEvent = event;
  }
  if (!planEvent) return undefined;
  const payload = recordValue(planEvent.payload);
  const tasks = Array.isArray(payload?.tasks) ? payload.tasks : [];
  if (tasks.length === 0) return undefined;
  const statusByTask = taskStatusIndex(events);
  const planId = stringValue(payload?.planId) ?? planEvent.id;
  const runId = stringValue(payload?.runId) ?? 'run';
  const items = tasks.flatMap<AgentTimelineTaskProjectionItem>((value, index) => {
    const task = recordValue(value);
    if (!task) return [];
    const manifest = recordValue(task.manifest);
    const id = stringValue(task.taskId)
      ?? stringValue(task.planActionId)
      ?? stringValue(manifest?.planActionId)
      ?? `plan-action-${index + 1}`;
    const toolId = stringValue(task.toolId)
      ?? stringValue(manifest?.toolId)
      ?? 'kernel.tool';
    const operationId = stringValue(task.operationId)
      ?? stringValue(manifest?.operationId);
    return [{
      id,
      title: stringValue(task.title) ?? toolId,
      summary: stringValue(task.objective)
        ?? (operationId ? `operationId=${operationId}` : toolId),
      status: statusByTask.get(id) ?? 'queued',
      blockId: `plan:${runId}:${planId}`,
      narrativeKind: 'plan',
      ...(statusByTask.get(id) === 'completed'
        ? { settlementKind: 'sessionEvidenceSatisfied' as const }
        : {}),
    }];
  });
  return items.length > 0
    ? {
        title: stringValue(payload?.title) ?? 'Plan',
        items,
      }
    : undefined;
}

function taskStatusIndex(events: AgentEvent[]): Map<string, AgentTimelineStatus> {
  const result = new Map<string, AgentTimelineStatus>();
  for (const event of events) {
    if (event.kind !== 'workflow_stage' && event.kind !== 'tool_call') continue;
    const payload = recordValue(event.payload);
    const id = stringValue(payload?.planActionId);
    if (!id) continue;
    result.set(id, eventStatus(event, payload));
  }
  return result;
}

function buildInteractionProjection(
  events: AgentEvent[]
): AgentTimelineInteractionProjection | undefined {
  let pending: NonNullable<AgentTimelineInteractionProjection['pending']> | undefined;
  const terminalRunIds = new Set<string>();
  for (const event of events) {
    const payload = recordValue(event.payload);
    const explicitRunId = stringValue(payload?.runId);
    const runId = explicitRunId ?? 'run';
    if (
      explicitRunId
      && canonicalTerminalRunEvent(event, payload)
    ) {
      terminalRunIds.add(explicitRunId);
      if (pendingInteractionRunId(pending) === explicitRunId) {
        pending = undefined;
      }
      continue;
    }
    if (explicitRunId && terminalRunIds.has(explicitRunId)) {
      continue;
    }
    if (event.kind === 'plan_card') {
      const planId = stringValue(payload?.planId) ?? event.id;
      if (payload?.confirmable === false) {
        if (
          pending?.kind === 'plan'
          && pending.runId === runId
        ) {
          pending = undefined;
        }
        continue;
      }
      pending = {
        kind: 'plan',
        interactionId: `plan:${planId}`,
        interactionRevision: event.id,
        targetId: planId,
        runId,
        planId,
        blockId: logicalBlockId(event, payload),
        title: eventTitle(event, payload),
        summary: eventSummary(event, payload),
      };
      continue;
    }
    if (event.kind === 'plan_review' && pending?.kind === 'plan') {
      const planId = stringValue(payload?.planId);
      if (!planId || pending.planId === planId) pending = undefined;
      continue;
    }
    if (event.kind === 'permission_request') {
      const request = permissionRequest(payload);
      if (!request) continue;
      pending = {
        kind: 'permission',
        interactionId: `permission:${request.id}`,
        interactionRevision: event.id,
        targetId: request.id,
        requestId: request.id,
        request,
        blockId: logicalBlockId(event, payload),
        title: eventTitle(event, payload),
        summary: request.summary,
      };
      continue;
    }
    if (event.kind === 'permission_result' && pending?.kind === 'permission') {
      const id = permissionIdentity(payload);
      if (!id || pending.requestId === id) pending = undefined;
      continue;
    }
  }
  return pending ? { pending } : undefined;
}

function pendingInteractionRunId(
  pending:
    | NonNullable<AgentTimelineInteractionProjection['pending']>
    | undefined
): string | undefined {
  return pending?.kind === 'plan'
    ? pending.runId
    : pending?.request.runId;
}

function canonicalTerminalRunEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): boolean {
  if (wholeTurnErrorEvent(event, payload)) return true;
  if (
    event.kind === 'assistant_msg'
    && (
      payload?.providerPhase === 'final_answer'
      || (
        payload?.providerPhase !== 'commentary'
        && stringValue(payload?.terminalScope) === 'turn'
        && stringValue(payload?.outputKind) === 'answer'
        && stringValue(payload?.status) === 'completed'
      )
    )
  ) {
    return true;
  }
  if (event.kind !== 'session_run_state') return false;
  const status = stringValue(payload?.status);
  return status === 'cancelled'
    || status === 'failed'
    || (
      status === 'completed'
      && stringValue(payload?.reason) !== 'waitCleared'
    );
}

function buildRunProjection(
  events: AgentEvent[],
  turns: AgentTimelineTurn[],
  pendingInteraction:
    | NonNullable<AgentTimelineInteractionProjection['pending']>
    | undefined
): AgentTimelineRunProjection | undefined {
  const runId = latestExplicitRunId(events);
  if (!runId) return undefined;

  let status: AgentTimelineRunProjection['status'] = 'active';
  let phase: AgentTimelineRunProjection['phase'] = 'preparing';
  let currentActivity: AgentTimelineRunProjection['currentActivity'] = null;
  let wait: AgentTimelineRunProjection['wait'] = null;
  for (const event of events) {
    const payload = recordValue(event.payload);
    if (stringValue(payload?.runId) !== runId) continue;
    if (privateProjectionEvent(event)) {
      if (activityCodeForEvent(event, payload) === 'provider.reasoning') {
        currentActivity = {
          code: 'provider.reasoning',
          updatedAt: event.ts,
        };
      }
      continue;
    }
    if (event.kind === 'user_msg') {
      status = 'active';
      phase = 'preparing';
      currentActivity = null;
      wait = null;
    }
    const activityCode = activityCodeForEvent(event, payload);
    if (
      activityCode
      && status !== 'waitingUser'
      && status !== 'waitingExternal'
      && status !== 'paused'
    ) {
      const summary = stringValue(payload?.summary);
      const operationId = stringValue(payload?.operationId);
      const workSegmentId = stringValue(payload?.workSegmentId);
      currentActivity = {
        code: activityCode,
        ...(summary ? { summary } : {}),
        ...(operationId ? { operationId } : {}),
        ...(workSegmentId ? { workSegmentId } : {}),
        updatedAt: event.ts,
      };
    }
    const projectionKind = stringValue(payload?.projectionKind);
    if (
      projectionKind === 'provider.completed'
      || projectionKind === 'provider.stale'
    ) {
      currentActivity = null;
      if (
        projectionKind === 'provider.completed'
        && status !== 'waitingUser'
        && status !== 'waitingExternal'
        && status !== 'paused'
      ) {
        phase = 'validating';
      }
    }
    if (
      status !== 'waitingUser'
      && status !== 'waitingExternal'
      && status !== 'paused'
    ) {
      if (event.kind === 'tool_call') phase = 'executing';
      if (event.kind === 'tool_result') phase = 'validating';
    }
    if (
      event.kind === 'assistant_msg'
      && (
        payload?.providerPhase === 'final_answer'
        || (
        payload?.providerPhase !== 'commentary'
          && stringValue(payload?.terminalScope) === 'turn'
          && stringValue(payload?.outputKind) === 'answer'
          && stringValue(payload?.status) === 'completed'
        )
      )
    ) {
      status = 'succeeded';
      phase = 'settled';
      currentActivity = null;
      wait = null;
    }
    if (
      wholeTurnErrorEvent(event, payload)
    ) {
      status = 'failed';
      phase = 'settled';
      currentActivity = null;
      wait = null;
    }
    if (event.kind === 'session_run_state') {
      const next = stringValue(payload?.status);
      if (next === 'waiting') {
        const reason = stringValue(payload?.reason);
        const waitKind =
          reason === 'capability'
          || reason === 'plan'
          || reason === 'scopeExpansion'
          || reason === 'userDecision'
            ? 'user'
            : reason === 'manualRecovery'
              || reason === 'indeterminate'
              ? 'paused'
              : 'external';
        status = waitKind === 'user'
          ? 'waitingUser'
          : waitKind === 'paused'
            ? 'paused'
            : 'waitingExternal';
        phase = 'waiting';
        currentActivity = null;
        wait = {
          kind: waitKind,
          ...(reason ? { reason } : {}),
          ...(stringValue(payload?.targetId)
            ? { interactionId: stringValue(payload?.targetId) }
            : {}),
        };
      } else if (next === 'cancelled') {
        status = 'cancelled';
        phase = 'settled';
        currentActivity = null;
        wait = null;
      } else if (next === 'failed') {
        status = 'failed';
        phase = 'settled';
        currentActivity = null;
        wait = null;
      } else if (next === 'completed') {
        if (stringValue(payload?.reason) === 'waitCleared') {
          if (
            status !== 'succeeded'
            && status !== 'failed'
            && status !== 'cancelled'
          ) {
            status = 'active';
            phase = 'processing';
          }
          wait = null;
        } else {
          status = 'succeeded';
          phase = 'settled';
          currentActivity = null;
          wait = null;
        }
      } else {
        status = 'active';
        phase = 'processing';
        wait = null;
      }
    }
  }
  const turn = turns.findLast((candidate) =>
    candidate.id.startsWith(`turn:${runId}:`)
  ) ?? turns.at(-1);
  if (currentActivity?.operationId) {
    const segment = turn?.workSegments.find((candidate) =>
      candidate.operations.some((operation) =>
        operation.operationId === currentActivity?.operationId
      )
    );
    if (segment) {
      currentActivity = {
        ...currentActivity,
        workSegmentId: segment.id,
      };
    } else {
      const { operationId: _operationId, ...withoutOperation } =
        currentActivity;
      currentActivity = withoutOperation;
    }
  }
  if (
    currentActivity?.workSegmentId
    && !turn?.workSegments.some((segment) =>
      segment.id === currentActivity?.workSegmentId
    )
  ) {
    const { workSegmentId: _workSegmentId, ...withoutSegment } =
      currentActivity;
    currentActivity = withoutSegment;
  }
  const pendingRunId = pendingInteraction?.kind === 'plan'
    ? pendingInteraction.runId
    : pendingInteraction?.request.runId;
  if (
    pendingInteraction
    && pendingRunId === runId
    && status !== 'succeeded'
    && status !== 'failed'
    && status !== 'cancelled'
  ) {
    status = 'waitingUser';
    phase = 'waiting';
    currentActivity = null;
    wait = {
      kind: 'user',
      reason: pendingInteraction.kind === 'plan'
        ? 'plan'
        : 'scopeExpansion',
      interactionId: pendingInteraction.interactionId,
    };
  }
  return {
    runId,
    ...(turn ? { turnId: turn.id } : {}),
    revision: events.length,
    status,
    phase,
    currentActivity,
    wait,
    languageBinding: {
      language: 'neutral',
      status: 'unavailable',
    },
  };
}

function wholeTurnErrorEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): boolean {
  return event.kind === 'error'
    && eventStatus(event, payload) === 'failed'
    && (
      !stringValue(payload?.operationId)
      || payload?.terminalScope === 'turn'
    );
}

function activityCodeForEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): NonNullable<
  AgentTimelineRunProjection['currentActivity']
>['code'] | undefined {
  const explicit = stringValue(payload?.currentActivityCode);
  if (timelineCurrentActivityCode(explicit)) return explicit;
  const projectionKind = stringValue(payload?.projectionKind);
  if (projectionKind === 'provider.started') {
    return 'provider.awaitingFirstByte';
  }
  if (projectionKind === 'provider.reasoning') {
    return 'provider.reasoning';
  }
  if (projectionKind === 'provider.composing') {
    return 'provider.composing';
  }
  if (projectionKind === 'toolIntent.submitted') {
    return stringValue(payload?.status) === 'admitted'
      ? 'kernel.executing'
      : 'session.admitting';
  }
  if (projectionKind === 'kernelFacts.reconciled') {
    return 'session.validating';
  }
  if (
    projectionKind === 'plan.persisted'
    || projectionKind === 'review.revised'
  ) {
    return 'session.persisting';
  }
  if (
    projectionKind === 'wait.changed'
    && stringValue(payload?.reason) === 'backpressure'
  ) {
    return 'retry.backoff';
  }
  return undefined;
}

function eventsForLatestRun(events: AgentEvent[]): AgentEvent[] {
  const runId = latestExplicitRunId(events);
  if (!runId) return events;
  return events.filter((event) => {
    const payload = recordValue(event.payload);
    return stringValue(payload?.runId) === runId;
  });
}

function latestExplicitRunId(events: AgentEvent[]): string | undefined {
  return events.reduce<string | undefined>((latest, event) => {
    const payload = recordValue(event.payload);
    return stringValue(payload?.runId) ?? latest;
  }, undefined);
}

const MAX_PROVIDER_USAGE_TOKENS_V2 = 1_000_000_000_000;

interface ProviderUsageCountersV2 {
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  cachedTokens: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface ProviderUsageOutcomeV2 {
  providerProfileId: string;
  provider?: string;
  model?: string;
  usage: ProviderUsageCountersV2;
}

function buildTokenUsageProjection(
  events: AgentEvent[]
): AgentTimelineTokenUsageProjection | undefined {
  const latestUserEventByRun = new Map<string, AgentEvent>();
  const providerStartByTurn = new Map<
    string,
    { event: AgentEvent; runId: string }
  >();
  const completedOutcomeByTurn = new Map<
    string,
    ProviderUsageOutcomeV2
  >();
  const requests: AgentTimelineTokenUsageProjection['requests'] = [];

  for (const event of events) {
    const payload = recordValue(event.payload);
    const runId = stringValue(payload?.runId);
    if (event.kind === 'user_msg' && runId) {
      latestUserEventByRun.set(runId, event);
    }
    const providerTurnId = stringValue(payload?.providerTurnId);
    if (
      payload?.projectionKind === 'provider.started'
      && runId
      && providerTurnId
    ) {
      const turnKey = providerUsageTurnKey(runId, providerTurnId);
      if (!providerStartByTurn.has(turnKey)) {
        providerStartByTurn.set(turnKey, { event, runId });
      }
      continue;
    }
    if (
      payload?.projectionKind !== 'provider.completed'
      || !runId
      || !providerTurnId
    ) {
      continue;
    }

    const outcome = recordValue(payload?.providerOutcome);
    if (!outcome) {
      throw new Error('session_projection_v2_provider_outcome_invalid');
    }
    const providerProfileId = boundedProviderIdentity(
      outcome.providerProfileId,
      'providerProfileId'
    );
    const provider = optionalBoundedProviderIdentity(
      outcome.provider,
      'provider'
    );
    const model = optionalBoundedProviderIdentity(
      outcome.model,
      'model'
    );
    const usage = providerUsageCountersV2(outcome.usage);
    const turnKey = providerUsageTurnKey(runId, providerTurnId);
    const completedOutcome: ProviderUsageOutcomeV2 = {
      providerProfileId,
      provider,
      model,
      usage,
    };
    const previousOutcome = completedOutcomeByTurn.get(turnKey);
    if (previousOutcome) {
      if (!sameProviderUsageOutcomeV2(
        previousOutcome,
        completedOutcome
      )) {
        throw new Error(
          'session_projection_v2_provider_outcome_conflict'
        );
      }
      continue;
    }
    completedOutcomeByTurn.set(turnKey, completedOutcome);
    const providers = provider
      ? [provider]
      : [providerProfileId];
    const userEvent = latestUserEventByRun.get(runId);
    const started = providerStartByTurn.get(
      providerUsageTurnKey(runId, providerTurnId)
    );
    requests.push({
      requestId: providerTurnId,
      turnId: providerTurnId,
      userEventId: userEvent?.id ?? event.id,
      title: model
        ? `${providers[0]} / ${model}`
        : providers[0]!,
      startedAt: started?.event.ts,
      completedAt: event.ts,
      stages: ['provider.completed'],
      providerCallCount: 1,
      providers,
      ...usage,
    });
  }

  if (requests.length === 0) return undefined;
  const totals = requests.reduce<ProviderUsageCountersV2>(
    (current, request) => ({
      promptCacheHitTokens: checkedProviderUsageSum(
        current.promptCacheHitTokens,
        request.promptCacheHitTokens
      ),
      promptCacheMissTokens: checkedProviderUsageSum(
        current.promptCacheMissTokens,
        request.promptCacheMissTokens
      ),
      cachedTokens: checkedProviderUsageSum(
        current.cachedTokens,
        request.cachedTokens
      ),
      promptTokens: checkedProviderUsageSum(
        current.promptTokens,
        request.promptTokens
      ),
      completionTokens: checkedProviderUsageSum(
        current.completionTokens,
        request.completionTokens
      ),
      totalTokens: checkedProviderUsageSum(
        current.totalTokens,
        request.totalTokens
      ),
    }),
    {
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      cachedTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    }
  );
  return {
    requests,
    totals: {
      ...totals,
      providerCallCount: requests.length,
      providers: [...new Set(
        requests.flatMap((request) => request.providers)
      )].sort(),
    },
  };
}

function sameProviderUsageOutcomeV2(
  left: ProviderUsageOutcomeV2,
  right: ProviderUsageOutcomeV2
): boolean {
  return left.providerProfileId === right.providerProfileId
    && left.provider === right.provider
    && left.model === right.model
    && left.usage.promptCacheHitTokens
      === right.usage.promptCacheHitTokens
    && left.usage.promptCacheMissTokens
      === right.usage.promptCacheMissTokens
    && left.usage.cachedTokens === right.usage.cachedTokens
    && left.usage.promptTokens === right.usage.promptTokens
    && left.usage.completionTokens === right.usage.completionTokens
    && left.usage.totalTokens === right.usage.totalTokens;
}

function providerUsageCountersV2(value: unknown): ProviderUsageCountersV2 {
  if (value === undefined) {
    return {
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 0,
      cachedTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
  }
  const usage = recordValue(value);
  if (!usage) {
    throw new Error('session_projection_v2_provider_usage_invalid');
  }
  const promptTokens = providerUsageField(
    usage,
    [['prompt_tokens'], ['promptTokens'], ['input_tokens'], ['inputTokens']]
  );
  const completionTokens = providerUsageField(
    usage,
    [
      ['completion_tokens'],
      ['completionTokens'],
      ['output_tokens'],
      ['outputTokens'],
    ]
  );
  const cachedTokens = providerUsageField(
    usage,
    [
      ['cached_tokens'],
      ['cachedTokens'],
      ['input_tokens_details', 'cached_tokens'],
      ['inputTokensDetails', 'cachedTokens'],
      ['cache_read_input_tokens'],
      ['cacheReadInputTokens'],
    ]
  );
  const promptCacheHitTokens = providerUsageField(
    usage,
    [
      ['prompt_cache_hit_tokens'],
      ['promptCacheHitTokens'],
      ['cache_read_input_tokens'],
      ['cacheReadInputTokens'],
    ]
  );
  const promptCacheMissTokens = providerUsageField(
    usage,
    [
      ['prompt_cache_miss_tokens'],
      ['promptCacheMissTokens'],
      ['cache_creation_input_tokens'],
      ['cacheCreationInputTokens'],
    ]
  );
  const explicitTotal = providerUsageField(
    usage,
    [['total_tokens'], ['totalTokens']]
  );
  return {
    promptCacheHitTokens,
    promptCacheMissTokens,
    cachedTokens,
    promptTokens,
    completionTokens,
    totalTokens: explicitTotal > 0
      ? explicitTotal
      : checkedProviderUsageSum(promptTokens, completionTokens),
  };
}

function providerUsageField(
  usage: Record<string, unknown>,
  paths: readonly (readonly string[])[]
): number {
  for (const path of paths) {
    let value: unknown = usage;
    for (const segment of path) {
      value = recordValue(value)?.[segment];
    }
    if (value === undefined) continue;
    if (
      typeof value !== 'number'
      || !Number.isSafeInteger(value)
      || value < 0
      || value > MAX_PROVIDER_USAGE_TOKENS_V2
    ) {
      throw new Error('session_projection_v2_provider_usage_invalid');
    }
    return value;
  }
  return 0;
}

function checkedProviderUsageSum(left: number, right: number): number {
  const sum = left + right;
  if (
    !Number.isSafeInteger(sum)
    || sum > MAX_PROVIDER_USAGE_TOKENS_V2
  ) {
    throw new Error('session_projection_v2_provider_usage_overflow');
  }
  return sum;
}

function providerUsageTurnKey(
  runId: string,
  providerTurnId: string
): string {
  return `${runId}:${providerTurnId}`;
}

function boundedProviderIdentity(
  value: unknown,
  _field: string
): string {
  const identity = optionalBoundedProviderIdentity(value, _field);
  if (!identity) {
    throw new Error('session_projection_v2_provider_identity_invalid');
  }
  return identity;
}

function optionalBoundedProviderIdentity(
  value: unknown,
  _field: string
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new Error('session_projection_v2_provider_identity_invalid');
  }
  return value;
}

function interactionForEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): {
  interactionId: string;
  targetId: string;
  kind: 'plan' | 'permission';
  decisionRequest?: AgentTimelineDecisionRequest;
} | null {
  if (event.kind === 'plan_card' && payload?.confirmable !== false) {
    const id = stringValue(payload?.planId) ?? event.id;
    return {
      interactionId: `plan:${id}`,
      targetId: id,
      kind: 'plan',
      decisionRequest: standardDecisionRequest(),
    };
  }
  if (event.kind === 'permission_request') {
    const id = permissionIdentity(payload);
    return id
      ? {
          interactionId: `permission:${id}`,
          targetId: id,
          kind: 'permission',
          decisionRequest: standardDecisionRequest(),
        }
      : null;
  }
  return null;
}

function standardDecisionRequest(): AgentTimelineDecisionRequest {
  return {
    allowsFreeform: true,
    options: [
      { id: 'accept', label: 'Accept' },
      { id: 'reject', label: 'Reject' },
      { id: 'revise', label: 'Revise' },
    ],
  };
}

function structuredProjectionForEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): AgentTimelineStructuredProjection | null {
  if (event.kind === 'plan_card') {
    const readable = recordValue(payload?.readablePlan);
    return structuredProjectionFromRecord('plan', readable, payload);
  }
  if (event.kind === 'review_summary') {
    const review = recordValue(payload?.review);
    return Array.isArray(review?.sections)
      ? structuredProjectionFromRecord('review', review, payload)
      : reviewStructuredProjectionV2(review, payload);
  }
  return null;
}

function structuredProjectionFromRecord(
  kind: 'plan' | 'review',
  value: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined
): AgentTimelineStructuredProjection {
  const sections = Array.isArray(value?.sections)
    ? value.sections.flatMap((sectionValue) => {
        const section = recordValue(sectionValue);
        const sectionId = stringValue(section?.sectionId);
        if (!section || !sectionId) return [];
        const items = Array.isArray(section?.items)
          ? section.items.flatMap((itemValue) => {
              const item = recordValue(itemValue);
              const itemId = stringValue(item?.itemId);
              if (!item || !itemId) return [];
              const metadata = recordValue(item.metadata);
              return [{
                itemId,
                kind: stringValue(item.kind) ?? 'text',
                text: stringValue(item.text),
                messageKey: stringValue(item.messageKey),
                messageArgs: stringRecord(item.messageArgs),
                status: stringValue(item.status),
                targetRefs: stringArrayValue(item.targetRefs),
                auditRefs: stringArrayValue(item.auditRefs),
                objective: stringValue(item.objective)
                  ?? stringValue(metadata?.objective),
                acceptanceCriteria: stringArrayValue(
                  item.acceptanceCriteria ?? metadata?.acceptance
                ),
                failureConditions: stringArrayValue(
                  item.failureConditions ?? metadata?.failure
                ),
              }];
            })
          : [];
        return [{
          sectionId,
          titleKey: stringValue(section.titleKey) ?? `session.projection.${kind}.${sectionId}`,
          titleArgs: stringRecord(section.titleArgs),
          emptyMessageKey: stringValue(section.emptyMessageKey),
          items,
        }];
      })
    : [];
  return {
    kind,
    schemaVersion: stringValue(value?.schemaVersion)
      ?? (
        kind === 'plan'
          ? AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2
          : AGENT_TIMELINE_READABLE_REVIEW_SCHEMA_V2
      ),
    title: stringValue(value?.title) ?? stringValue(fallback?.title),
    titleKey: stringValue(value?.titleKey),
    titleArgs: stringRecord(value?.titleArgs),
    summary: stringValue(value?.summary) ?? stringValue(fallback?.summary),
    summaryKey: stringValue(value?.summaryKey),
    messageArgs: stringRecord(value?.messageArgs),
    sections,
  };
}

function reviewStructuredProjectionV2(
  review: Record<string, unknown> | undefined,
  fallback: Record<string, unknown> | undefined
): AgentTimelineStructuredProjection {
  const categories: Array<{
    key: string;
    titleKey: string;
    values: unknown;
  }> = [
    {
      key: 'planned',
      titleKey: 'session.projection.review.section.planned',
      values: review?.planned,
    },
    {
      key: 'scopeExpansions',
      titleKey: 'session.projection.review.section.scopeExpansions',
      values: review?.scopeExpansions,
    },
    {
      key: 'actualEffects',
      titleKey: 'session.projection.review.section.actualEffects',
      values: review?.actualEffects,
    },
    {
      key: 'unexecuted',
      titleKey: 'session.projection.review.section.unexecuted',
      values: review?.unexecuted,
    },
    {
      key: 'denied',
      titleKey: 'session.projection.review.section.denied',
      values: review?.denied,
    },
    {
      key: 'rejections',
      titleKey: 'session.projection.review.section.rejections',
      values: review?.rejections,
    },
    {
      key: 'cleanup',
      titleKey: 'session.projection.review.section.cleanup',
      values: review?.cleanup,
    },
    {
      key: 'indeterminate',
      titleKey: 'session.projection.review.section.indeterminate',
      values: review?.indeterminate,
    },
  ];
  return {
    kind: 'review',
    schemaVersion: AGENT_TIMELINE_READABLE_REVIEW_SCHEMA_V2,
    title: stringValue(fallback?.title) ?? 'Review',
    summary: stringValue(fallback?.summary)
      ?? 'Review derived from canonical Kernel facts.',
    sections: categories.map((category) => ({
      sectionId: category.key,
      titleKey: category.titleKey,
      emptyMessageKey:
        `session.projection.review.empty.${category.key}`,
      items: arrayRecords(category.values).map((item, index) =>
        reviewProjectionItem(category.key, item, index)
      ),
    })),
  };
}

function reviewProjectionItem(
  category: string,
  item: Record<string, unknown>,
  index: number
): AgentTimelineStructuredProjection['sections'][number]['items'][number] {
  const factId = stringValue(item.factId);
  const planActionId = stringValue(item.planActionId)
    ?? stringArrayValue(item.planActionIds)[0];
  const operationId = stringValue(item.operationId);
  const invocationId = stringValue(item.invocationId);
  const effectId = stringValue(item.effectId);
  const toolId = stringValue(item.toolId);
  const factKind = stringValue(item.factKind);
  const reason = stringValue(item.reason);
  const details = recordValue(item.details);
  const identity = factId
    ?? effectId
    ?? invocationId
    ?? operationId
    ?? planActionId
    ?? `${category}-${index + 1}`;
  const text = [
    toolId,
    factKind,
    reason,
    operationId ? `operation=${operationId}` : undefined,
    effectId ? `effect=${effectId}` : undefined,
    details ? canonicalDetailSummary(details) : undefined,
  ].filter((value): value is string => Boolean(value)).join(' | ');
  return {
    itemId: identity,
    kind: category,
    text: text || identity,
    status: category,
    targetRefs: stringArrayValue(item.resourceIds),
    auditRefs: [
      factId,
      invocationId,
      effectId,
    ].filter((value): value is string => Boolean(value)),
    objective: planActionId
      ? `planActionId=${planActionId}`
      : undefined,
  };
}

function canonicalDetailSummary(
  details: Record<string, unknown>
): string {
  const entries = Object.entries(details)
    .filter(([, value]) =>
      typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean'
    )
    .slice(0, 6)
    .map(([key, value]) => `${key}=${String(value)}`);
  return entries.join('; ');
}

function permissionRequest(
  payload: Record<string, unknown> | undefined
): AgentTimelinePermissionRequestView | null {
  const id = permissionIdentity(payload);
  if (!id) return null;
  const risk = stringValue(payload?.riskLevel);
  const argumentsPreview = payload?.argumentsPreview;
  return {
    id,
    runId: stringValue(payload?.runId),
    requestKind: stringValue(payload?.requestKind) === 'runtimePermission'
      ? 'runtimePermission'
      : 'scopeExpansion',
    permissionBundleId: stringValue(payload?.permissionBundleId),
    contractId: stringValue(payload?.contractId),
    affectedOperationIds: stringArrayValue(payload?.affectedOperationIds),
    toolId: stringValue(payload?.toolId),
    toolName: stringValue(payload?.toolName) ?? 'kernel.tool',
    riskLevel:
      risk === 'low' || risk === 'high' || risk === 'critical'
        ? risk
        : 'medium',
    summary: stringValue(payload?.summary) ?? 'Review the canonical Kernel scope.',
    diff: stringValue(payload?.diff),
    argumentsPreview: typeof argumentsPreview === 'string'
      ? argumentsPreview
      : argumentsPreview === undefined
        ? undefined
        : JSON.stringify(argumentsPreview),
  };
}

function permissionIdentity(
  payload: Record<string, unknown> | undefined
): string | undefined {
  return stringValue(payload?.permissionId)
    ?? stringValue(payload?.previewId)
    ?? stringValue(payload?.id);
}

function privateProjectionEvent(event: AgentEvent): boolean {
  const payload = recordValue(event.payload);
  const channel = stringValue(payload?.channel);
  const visibility = stringValue(payload?.visibility);
  return channel === 'reasoning'
    || channel === 'thinking'
    || visibility === 'hidden'
    || Object.keys(payload ?? {}).some(privateProjectionField)
    || payload?.reasoningTrace === true
    || String(event.kind).includes('reasoning');
}

function nondecreasingTimestamp(
  startedAt: string | undefined,
  candidate: string
): string {
  if (!startedAt) return candidate;
  const started = Date.parse(startedAt);
  const completed = Date.parse(candidate);
  return Number.isFinite(started)
    && Number.isFinite(completed)
    && completed < started
    ? startedAt
    : candidate;
}

function containsPrivateProjectionData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateProjectionData);
  const record = recordValue(value);
  if (!record) return false;
  return Object.entries(record).some(([key, nested]) =>
    privateProjectionField(key)
    || containsPrivateProjectionData(nested)
  );
}

function privateProjectionField(key: string): boolean {
  const normalized = key
    .replace(/[_\-\s]/gu, '')
    .toLocaleLowerCase('en-US');
  return normalized === 'events'
    || normalized === 'payload'
    || normalized === 'kernelevent'
    || normalized === 'rawprovider'
    || normalized === 'rawupstreamenvelope'
    || normalized === 'providertrace'
    || normalized === 'rawarguments'
    || normalized === 'reasoning'
    || normalized === 'reasoningcontent'
    || normalized === 'reasoningtrace'
    || normalized === 'thinking'
    || normalized === 'thinkingdelta'
    || normalized === 'analysis'
    || normalized === 'chainofthought';
}

function eventStatus(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): AgentTimelineStatus {
  const status = stringValue(payload?.status);
  if (timelineStatus(status)) return status;
  if (status === 'awaitingUserApproval' || status === 'awaitingUserDecision') {
    return 'waiting';
  }
  if (status === 'awaitingCapability' || status === 'waitingUserReview') {
    return 'waiting';
  }
  if (status === 'skipped') return 'cancelled';
  if (status === 'allowed' || status === 'accepted' || status === 'reconciled') {
    return 'completed';
  }
  if (status === 'denied' || status === 'rejected' || status === 'needsRevision') {
    return 'blocked';
  }
  if (event.kind === 'permission_request' || event.kind === 'plan_card') {
    return 'waiting';
  }
  if (event.kind === 'error') return 'failed';
  if (event.kind === 'assistant_msg' || event.kind === 'tool_result') {
    return 'completed';
  }
  return 'running';
}

function eventTitle(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): string {
  return stringValue(payload?.title)
    ?? stringValue(payload?.toolName)
    ?? eventTitleFallback(String(event.kind));
}

function eventSummary(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): string {
  return stringValue(payload?.summary)
    ?? stringValue(payload?.message)
    ?? stringValue(payload?.content)
    ?? eventTitleFallback(String(event.kind));
}

function eventBody(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): string | undefined {
  if (event.kind === 'user_msg' || event.kind === 'assistant_msg') {
    return stringValue(payload?.content);
  }
  if (event.kind === 'error') {
    return stringValue(payload?.message) ?? stringValue(payload?.summary);
  }
  return stringValue(payload?.userPlan)
    ?? stringValue(payload?.guidance)
    ?? stringValue(payload?.summary);
}

function eventTitleFallback(kind: string): string {
  return kind.split('_').map((part) =>
    part.length > 0 ? `${part[0]?.toUpperCase()}${part.slice(1)}` : part
  ).join(' ');
}

function eventNarrativeKind(kind: string): AgentTimelineNarrativeKind {
  if (kind === 'user_msg') return 'user';
  if (kind === 'assistant_msg') return 'assistantText';
  if (kind === 'plan_card' || kind === 'plan_review') return 'plan';
  if (kind === 'permission_request' || kind === 'permission_result') return 'permission';
  if (kind === 'review_summary') return 'review';
  if (kind === 'error') return 'diagnostic';
  throw new Error('session_projection_v2_history_block_kind_invalid');
}

function eventEntryRole(kind: string): AgentTimelineBlock['entryRole'] {
  if (kind === 'user_msg') return 'userMessage';
  if (kind === 'assistant_msg') return 'finalAnswer';
  if (
    kind === 'plan_card'
    || kind === 'permission_request'
    || kind === 'review_summary'
  ) {
    return 'interaction';
  }
  if (kind === 'error') return 'diagnostic';
  throw new Error('session_projection_v2_history_block_kind_invalid');
}

function eventBlockKind(kind: string): AgentTimelineBlock['kind'] {
  if (kind === 'user_msg') return 'user';
  if (kind === 'assistant_msg') return 'assistant';
  if (kind === 'plan_card' || kind === 'plan_review') return 'plan';
  if (kind === 'permission_request' || kind === 'permission_result') return 'permission';
  if (kind === 'review_summary') return 'review';
  if (kind === 'error') return 'error';
  throw new Error('session_projection_v2_history_block_kind_invalid');
}

function eventOrigin(kind: string): AgentTimelineBlock['provenance']['origin'] {
  if (kind === 'user_msg') return 'user';
  if (
    kind === 'tool_call'
    || kind === 'tool_result'
    || kind === 'permission_request'
    || kind === 'permission_result'
  ) {
    return 'kernel';
  }
  if (kind === 'assistant_msg') return 'provider';
  return 'session';
}

function defaultCollapsed(kind: string, status: AgentTimelineStatus): boolean {
  return status === 'completed'
    && kind !== 'assistant_msg'
    && kind !== 'user_msg'
    && kind !== 'plan_card'
    && kind !== 'review_summary';
}

function stripUndefinedProjectionFields(value: AgentTimelineResult): void {
  if (!value.taskProjection) delete value.taskProjection;
  if (!value.interactionProjection) delete value.interactionProjection;
  if (!value.runProjection) delete value.runProjection;
  if (!value.tokenUsageProjection) delete value.tokenUsageProjection;
}

function timelineStatus(value: unknown): value is AgentTimelineStatus {
  return value === 'queued'
    || value === 'running'
    || value === 'waiting'
    || value === 'blocked'
    || value === 'completed'
    || value === 'cancelled'
    || value === 'failed';
}

function validRunProjection(value: unknown): boolean {
  const run = recordValue(value);
  const languageBinding = recordValue(run?.languageBinding);
  if (
    !run
    || !nonemptyString(run.runId)
    || !nonnegativeInteger(run.revision)
    || !runProjectionStatus(run.status)
    || !runProjectionPhase(run.phase)
    || !Object.prototype.hasOwnProperty.call(run, 'currentActivity')
    || !Object.prototype.hasOwnProperty.call(run, 'wait')
    || !languageBinding
    || !projectionLanguage(languageBinding.language)
    || !languageStatus(languageBinding.status)
    || !validLanguageBinding(languageBinding)
    || (
      run.turnId !== undefined
      && !nonemptyString(run.turnId)
    )
    || (
      run.taskId !== undefined
      && !nonemptyString(run.taskId)
    )
  ) {
    return false;
  }
  const currentActivity = run.currentActivity;
  if (
    currentActivity !== undefined
    && currentActivity !== null
  ) {
    const activity = recordValue(currentActivity);
    if (
      !activity
      || !timelineCurrentActivityCode(activity.code)
      || !nonemptyString(activity.updatedAt)
      || (
        activity.summary !== undefined
        && typeof activity.summary !== 'string'
      )
      || (
        activity.operationId !== undefined
        && !nonemptyString(activity.operationId)
      )
      || (
        activity.workSegmentId !== undefined
        && !nonemptyString(activity.workSegmentId)
      )
      || Object.keys(activity).some(
        (key) =>
          key !== 'code'
          && key !== 'summary'
          && key !== 'operationId'
          && key !== 'workSegmentId'
          && key !== 'updatedAt'
      )
    ) {
      return false;
    }
  }
  const wait = run.wait;
  if (wait !== undefined && wait !== null) {
    const waitRecord = recordValue(wait);
    if (
      !waitRecord
      || (
        waitRecord.kind !== 'user'
        && waitRecord.kind !== 'external'
        && waitRecord.kind !== 'paused'
      )
      || Object.keys(waitRecord).some(
        (key) =>
          key !== 'kind'
          && key !== 'reason'
          && key !== 'interactionId'
      )
      || (
        waitRecord.reason !== undefined
        && typeof waitRecord.reason !== 'string'
      )
      || (
        waitRecord.interactionId !== undefined
        && !nonemptyString(waitRecord.interactionId)
      )
    ) {
      return false;
    }
  }
  const keys = new Set([
    'runId',
    'turnId',
    'taskId',
    'revision',
    'status',
    'phase',
    'currentActivity',
    'wait',
    'languageBinding',
  ]);
  if (
    Object.keys(run).some((key) => !keys.has(key))
    || containsPrivateProjectionData(run)
  ) {
    return false;
  }
  const terminal =
    run.status === 'succeeded'
    || run.status === 'failed'
    || run.status === 'cancelled';
  if (terminal) {
    return run.phase === 'settled'
      && run.currentActivity === null
      && run.wait === null;
  }
  if (run.phase === 'settled') return false;
  if (run.status === 'waitingUser') {
    return run.phase === 'waiting'
      && run.currentActivity === null
      && recordValue(run.wait)?.kind === 'user';
  }
  if (run.status === 'waitingExternal') {
    return run.phase === 'waiting'
      && run.currentActivity === null
      && recordValue(run.wait)?.kind === 'external';
  }
  if (run.status === 'paused') {
    return run.phase === 'waiting'
      && run.currentActivity === null
      && recordValue(run.wait)?.kind === 'paused';
  }
  return run.status === 'active'
    && run.phase !== 'waiting'
    && run.wait === null;
}

function runProjectionStatus(
  value: unknown
): value is AgentTimelineRunProjection['status'] {
  return value === 'active'
    || value === 'waitingUser'
    || value === 'waitingExternal'
    || value === 'paused'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'cancelled';
}

function runProjectionPhase(
  value: unknown
): value is AgentTimelineRunProjection['phase'] {
  return value === 'preparing'
    || value === 'processing'
    || value === 'executing'
    || value === 'validating'
    || value === 'waiting'
    || value === 'settled';
}

function timelineCurrentActivityCode(
  value: unknown
): value is NonNullable<
  AgentTimelineRunProjection['currentActivity']
>['code'] {
  return value === 'session.admitting'
    || value === 'provider.awaitingFirstByte'
    || value === 'provider.reasoning'
    || value === 'provider.composing'
    || value === 'resource.resolving'
    || value === 'kernel.executing'
    || value === 'session.validating'
    || value === 'session.persisting'
    || value === 'retry.backoff';
}

function workSegmentLifecycle(
  value: unknown
): value is AgentTimelineWorkSegment['lifecycle'] {
  return value === 'active'
    || value === 'completed'
    || value === 'cancelled'
    || value === 'failed';
}

function workOperationStatus(
  value: unknown
): value is AgentTimelineWorkOperationStatus {
  return value === 'preparing'
    || value === 'queued'
    || value === 'running'
    || value === 'awaitingCapability'
    || value === 'completed'
    || value === 'denied'
    || value === 'failed'
    || value === 'failedAfterObservedEffect'
    || value === 'indeterminate'
    || value === 'cancelled'
    || value === 'stale'
    || value === 'unexecuted';
}

function entryRole(value: unknown): boolean {
  return value === 'userMessage'
    || value === 'agentUpdate'
    || value === 'interaction'
    || value === 'finalAnswer'
    || value === 'diagnostic';
}

function timelineBlockKind(value: unknown): boolean {
  return value === 'user'
    || value === 'assistant'
    || value === 'permission'
    || value === 'plan'
    || value === 'review'
    || value === 'error';
}

function timelineNarrativeKind(value: unknown): boolean {
  return value === 'user'
    || value === 'assistantText'
    || value === 'plan'
    || value === 'permission'
    || value === 'review'
    || value === 'diagnostic';
}

function interactionState(value: unknown): boolean {
  return value === 'open'
    || value === 'submitting'
    || value === 'accepted'
    || value === 'rejected'
    || value === 'needsRevision'
    || value === 'superseded'
    || value === 'expired';
}

function projectionOrigin(value: unknown): boolean {
  return value === 'user'
    || value === 'session'
    || value === 'kernel'
    || value === 'provider';
}

function projectionAuthority(value: unknown): boolean {
  return value === 'user' || value === 'session' || value === 'kernel';
}

function projectionLanguage(value: unknown): boolean {
  return value === 'neutral' || value === 'zh-CN' || value === 'en-US';
}

function languageStatus(value: unknown): boolean {
  return value === 'pending'
    || value === 'resolved'
    || value === 'fallback'
    || value === 'superseded'
    || value === 'unavailable';
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[]
): boolean {
  const requiredSet = new Set(required);
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  )
    && Object.keys(value).every((key) => requiredSet.has(key));
}

function exactOptionalKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[]
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  )
    && Object.keys(value).every((key) => allowed.has(key));
}

function validStringRecord(value: unknown): boolean {
  const record = recordValue(value);
  return Boolean(
    record
    && Object.values(record).every(
      (item) => typeof item === 'string'
    )
  );
}

function jsonLikeEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalJsonValue(left))
    === JSON.stringify(canonicalJsonValue(right));
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJsonValue);
  }
  const record = recordValue(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalJsonValue(record[key])])
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function textContentValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string');
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === 'string' && item.trim().length > 0
      )
    : [];
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const record = recordValue(item);
        return record ? [record] : [];
      })
    : [];
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = recordValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string'
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function nonnegativeInteger(value: unknown): boolean {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0;
}

function nonnegativeIntegerValue(value: unknown): number | undefined {
  return nonnegativeInteger(value) ? value as number : undefined;
}
