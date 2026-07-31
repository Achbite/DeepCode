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
} from '@deepcode/protocol';
import {
  AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2,
  AGENT_TIMELINE_READABLE_REVIEW_SCHEMA_V2,
} from '@deepcode/protocol';
import {
  decodeAgentInputAttachmentsV2,
} from './kernel-v2/inputAttachmentsV2.js';

export const NARRATIVE_TIMELINE_SCHEMA_VERSION =
  'deepcode.shared-conversation-projection.v2' as const;

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
    if (event.sessionId !== input.sessionId || hiddenProjectionEvent(event)) {
      continue;
    }
    const payload = recordValue(event.payload);
    const runId = stringValue(payload?.runId);
    const turn = projectionTurn(context, event, payload, runId);
    const block = projectionBlock(
      event,
      payload,
      turn.blocks.length,
      committedEventIds.has(event.id)
    );
    if (!block) continue;
    const existing = turn.blocks.findIndex((candidate) => candidate.id === block.id);
    if (existing === -1) {
      turn.blocks.push(block);
    } else {
      turn.blocks[existing] = {
        ...block,
        sequence: turn.blocks[existing]?.sequence ?? block.sequence,
      };
    }
    updateTurnStatus(turn, event, payload, block);
  }

  const interactionProjection = buildInteractionProjection(currentRunEvents);
  const turns = convergeTerminalTurnBlocks(settleInteractionBlocks(
    context.turns
      .filter((turn) => turn.blocks.length > 0)
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
      })),
    input.events,
    interactionProjection?.pending
  ));
  const events = [...input.events, ...auxiliaryEvents];
  const projection: AgentTimelineResult = {
    schemaVersion: NARRATIVE_TIMELINE_SCHEMA_VERSION,
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
    runProjection: buildRunProjection(input.events),
    tokenUsageProjection:
      buildTokenUsageProjection(input.events),
  };
  stripUndefinedProjectionFields(projection);
  assertSharedConversationProjectionV2(projection);
  return projection;
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

function convergeTerminalTurnBlocks(
  turns: AgentTimelineTurn[]
): AgentTimelineTurn[] {
  return turns.map((turn) => {
    if (!terminalTimelineStatus(turn.status)) return turn;
    return {
      ...turn,
      blocks: turn.blocks.map((block) => {
        if (
          terminalTimelineStatus(block.status)
          || block.status === 'blocked'
          || block.interaction?.state === 'open'
        ) {
          return block;
        }
        const status: AgentTimelineStatus =
          block.kind === 'user' ? 'completed' : turn.status;
        return {
          ...block,
          status,
          ...(block.activity
            ? {
                activity: {
                  ...block.activity,
                  status,
                },
              }
            : {}),
        };
      }),
    };
  });
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
  if (
    !recordValue(value)
    || value.schemaVersion !== NARRATIVE_TIMELINE_SCHEMA_VERSION
    || !nonemptyString(value.sessionId)
    || !nonnegativeInteger(value.revision)
    || !nonnegativeInteger(value.sourceEventVersion)
    || !nonemptyString(value.generatedAt)
    || !nonnegativeInteger(value.eventCount)
    || !Array.isArray(value.turns)
    || (
      value.tokenUsageProjection !== undefined
      && !validTokenUsageProjection(value.tokenUsageProjection)
    )
  ) {
    throw new Error('session_projection_v2_invalid');
  }
  const rootKeys = new Set([
    'schemaVersion',
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
  for (const turn of value.turns) {
    if (
      !recordValue(turn)
      || !nonemptyString(turn.id)
      || turnIds.has(turn.id)
      || turn.sessionId !== value.sessionId
      || !timelineStatus(turn.status)
      || !Array.isArray(turn.blocks)
    ) {
      throw new Error('session_projection_v2_turn_invalid');
    }
    turnIds.add(turn.id);
    for (const block of turn.blocks) {
      if (!isSharedConversationBlockV2(block) || blockIds.has(block.id)) {
        throw new Error('session_projection_v2_block_invalid');
      }
      blockIds.add(block.id);
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
    || !provenance
    || !projectionOrigin(provenance.origin)
    || !projectionAuthority(provenance.authority)
    || !stringArray(provenance.sourceEventRefs)
    || !stringArray(provenance.factRefs)
    || !stringArray(provenance.evidenceRefs)
    || !languageBinding
    || !projectionLanguage(languageBinding.language)
    || !languageStatus(languageBinding.status)
    || !validTimelineAttachments(block.attachments)
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
    'activity',
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
  return requests.every((value) => {
    const request = recordValue(value);
    return Boolean(
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

function projectionBlock(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined,
  sequence: number,
  committed: boolean
): AgentTimelineBlock | null {
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
  const activity = activityForEvent(event, payload);
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
    entryRole: entry,
    ...(activity ? { activity } : {}),
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
    turn.status = 'failed';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    return;
  }
  if (block.status === 'cancelled') {
    turn.status = 'cancelled';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
    return;
  }
  if (
    event.kind === 'assistant_msg'
    || (event.kind === 'review_summary' && stringValue(payload?.status) === 'completed')
  ) {
    turn.status = 'completed';
    turn.completedAt = nondecreasingTimestamp(turn.startedAt, event.ts);
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
  for (const event of events) {
    const payload = recordValue(event.payload);
    const runId = stringValue(payload?.runId) ?? 'run';
    if (event.kind === 'plan_card' && payload?.confirmable !== false) {
      const planId = stringValue(payload?.planId) ?? event.id;
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

function buildRunProjection(events: AgentEvent[]): AgentTimelineRunProjection | undefined {
  const runId = latestExplicitRunId(events);
  if (!runId) return undefined;

  let status: AgentTimelineRunProjection['status'] = 'active';
  let phase: AgentTimelineRunProjection['phase'] = 'preparing';
  let waitReason: string | undefined;
  let activeInteractionId: string | undefined;
  for (const event of events) {
    const payload = recordValue(event.payload);
    if (stringValue(payload?.runId) !== runId) continue;
    if (event.kind === 'tool_call') phase = 'executing';
    if (event.kind === 'tool_result') phase = 'validating';
    if (event.kind === 'assistant_msg') {
      status = 'succeeded';
      phase = 'settled';
    }
    if (
      event.kind === 'error'
      && eventStatus(event, payload) === 'failed'
    ) {
      status = 'failed';
      phase = 'settled';
    }
    if (event.kind === 'session_run_state') {
      const next = stringValue(payload?.status);
      if (next === 'waiting') {
        status = 'waitingUser';
        phase = 'waiting';
        waitReason = stringValue(payload?.reason);
        activeInteractionId = stringValue(payload?.targetId);
      } else if (next === 'cancelled') {
        status = 'cancelled';
        phase = 'settled';
      } else if (next === 'failed') {
        status = 'failed';
        phase = 'settled';
      } else if (next === 'completed') {
        if (stringValue(payload?.reason) === 'waitCleared') {
          status = 'active';
          phase = 'processing';
          waitReason = undefined;
          activeInteractionId = undefined;
        } else {
          status = 'succeeded';
          phase = 'settled';
        }
      } else {
        status = 'active';
        phase = 'processing';
        waitReason = undefined;
        activeInteractionId = undefined;
      }
    }
  }
  return {
    runId,
    revision: events.length,
    status,
    phase,
    ...(waitReason ? { waitReason } : {}),
    ...(activeInteractionId ? { activeInteractionId } : {}),
    languageBinding: {
      language: 'neutral',
      status: 'unavailable',
    },
  };
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

function buildTokenUsageProjection(
  events: AgentEvent[]
): AgentTimelineTokenUsageProjection | undefined {
  const latestUserEventByRun = new Map<string, AgentEvent>();
  const providerStartByTurn = new Map<
    string,
    { event: AgentEvent; runId: string }
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
      providerStartByTurn.set(
        providerUsageTurnKey(runId, providerTurnId),
        { event, runId }
      );
      continue;
    }
    if (
      payload?.projectionKind !== 'provider.completed'
      || !runId
      || !providerTurnId
    ) {
      continue;
    }

    const outcome = recordValue(payload.providerOutcome);
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

function activityForEvent(
  event: AgentEvent,
  payload: Record<string, unknown> | undefined
): AgentTimelineBlock['activity'] | undefined {
  if (
    event.kind !== 'tool_call'
    && event.kind !== 'tool_result'
    && event.kind !== 'workflow_stage'
  ) {
    return undefined;
  }
  const runId = stringValue(payload?.runId);
  const planActionId = stringValue(payload?.planActionId);
  const status = eventStatus(event, payload);
  return {
    activityId: `activity:${event.id}`,
    activityRevision: 1,
    kind: event.kind === 'tool_call' || event.kind === 'tool_result'
      ? 'toolExecution'
      : 'reviewCheckpoint',
    status,
    title: eventTitle(event, payload),
    summary: eventSummary(event, payload),
    source: event.kind === 'workflow_stage' ? 'session' : 'kernel',
    ...(runId ? { runId } : {}),
    ...(planActionId ? { actionIds: [planActionId] } : {}),
    ...(stringValue(payload?.toolName)
      ? { toolName: stringValue(payload?.toolName) }
      : {}),
    ...(stringValue(payload?.operationId)
      ? { operation: stringValue(payload?.operationId) }
      : {}),
  };
}

function hiddenProjectionEvent(event: AgentEvent): boolean {
  const payload = recordValue(event.payload);
  const channel = stringValue(payload?.channel);
  const visibility = stringValue(payload?.visibility);
  return channel === 'reasoning'
    || channel === 'thinking'
    || visibility === 'trace'
    || visibility === 'hidden'
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
    key === 'events'
    || key === 'payload'
    || key === 'kernelEvent'
    || key === 'rawProvider'
    || key === 'reasoningContent'
    || containsPrivateProjectionData(nested)
  );
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
  return 'operationEvidence';
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
  if (kind === 'tool_call' || kind === 'workflow_stage') return 'activityGroup';
  if (kind === 'tool_result' || kind === 'permission_result') return 'evidence';
  if (kind === 'error') return 'diagnostic';
  return 'agentUpdate';
}

function eventBlockKind(kind: string): AgentTimelineBlock['kind'] {
  if (kind === 'user_msg') return 'user';
  if (kind === 'assistant_msg') return 'assistant';
  if (kind === 'plan_card' || kind === 'plan_review') return 'plan';
  if (kind === 'permission_request' || kind === 'permission_result') return 'permission';
  if (kind === 'review_summary') return 'review';
  if (kind === 'error') return 'error';
  return 'stage';
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

function entryRole(value: unknown): boolean {
  return value === 'userMessage'
    || value === 'agentUpdate'
    || value === 'activityGroup'
    || value === 'evidence'
    || value === 'interaction'
    || value === 'finalAnswer'
    || value === 'diagnostic';
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
