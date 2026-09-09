import type { ActivityProjection, AssistantDraftBlockProjection, SessionProjection } from '@deepcode/protocol';

export type ProjectionItem =
  | {
      type: 'message';
      sequence: number;
      streamId?: string;
      value: SessionProjection['messages'][number];
    }
  | {
      type: 'narrative';
      sequence: number;
      streamId: string;
      value: SessionProjection['narratives'][number];
    }
  | { type: 'plan'; sequence: number; value: SessionProjection['plans'][number] }
  | {
      type: 'toolGroup';
      sequence: number;
      groupId: string;
      values: ActivityProjection[];
    };

export type AssistantDraftItem =
  | { type: 'planPreview'; value: NonNullable<NonNullable<SessionProjection['assistantDraft']>['planPreview']>; key: string }
  | {
      type: 'text';
      block: Exclude<AssistantDraftBlockProjection, { kind: 'providerHosted' }>;
    }
  | {
      type: 'providerHostedGroup';
      groupId: string;
      blocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>>;
    };

export function assistantDraftItems(
  draft: SessionProjection['assistantDraft'],
): AssistantDraftItem[] {
  if (!draft) return [];
  const items: AssistantDraftItem[] = [];
  let hostedBlocks: Array<Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>> = [];
  const flushHostedBlocks = (): void => {
    if (hostedBlocks.length === 0) return;
    items.push({
      type: 'providerHostedGroup',
      groupId: `draft-hosted:${draft.turnId}:${hostedBlocks[0]!.outputIndex}`,
      blocks: hostedBlocks,
    });
    hostedBlocks = [];
  };
  for (const block of draft.blocks) {
    if (block.kind !== 'providerHosted') {
      flushHostedBlocks();
      items.push({ type: 'text', block });
      continue;
    }
    hostedBlocks.push(block);
  }
  flushHostedBlocks();
  if (draft.planPreview) {
    const preview = draft.planPreview;
    const index = preview.outputIndex === undefined ? -1 : items.findIndex((item) => {
      const outputIndex = item.type === 'text' ? item.block.outputIndex : item.type === 'providerHostedGroup' ? item.blocks[0]?.outputIndex : undefined;
      return outputIndex !== undefined && outputIndex > preview.outputIndex!;
    });
    items.splice(index < 0 ? items.length : index, 0, { type: 'planPreview', value: preview, key: `${draft.turnId}:plan:${preview.providerCallId}` });
  }
  return items;
}

export function projectionItems(projection: SessionProjection | null): ProjectionItem[] {
  if (!projection) return [];
  const items = projection.timeline.map((item): ProjectionItem => {
    switch (item.kind) {
      case 'message':
        return {
          type: 'message',
          sequence: item.sequence,
          ...(item.streamId !== undefined ? { streamId: item.streamId } : {}),
          value: requiredProjectionValue(
            projection.messages,
            (message) => message.messageId === item.messageId,
            'conversation_timeline_message_missing',
          ),
        };
      case 'narrative':
        return {
          type: 'narrative',
          sequence: item.sequence,
          streamId: item.streamId,
          value: requiredProjectionValue(
            projection.narratives,
            (narrative) => narrative.narrativeId === item.narrativeId,
            'conversation_timeline_narrative_missing',
          ),
        };
      case 'plan':
        return {
          type: 'plan',
          sequence: item.sequence,
          value: requiredProjectionValue(
            projection.plans,
            (plan) => plan.planId === item.planId && plan.revision === item.revision,
            'conversation_timeline_plan_missing',
          ),
        };
      case 'toolGroup':
        return {
          type: 'toolGroup',
          sequence: item.sequence,
          groupId: item.timelineId,
          values: item.activityIds.map((activityId) => requiredProjectionValue(
            projection.activities,
            (activity) => activity.activityId === activityId,
            'conversation_timeline_activity_missing',
          )),
        };
    }
  });
  const grouped: ProjectionItem[] = [];
  for (const item of items) {
    const previous = grouped.at(-1);
    if (item.type === 'toolGroup' && previous?.type === 'toolGroup'
      && item.values[0]?.runId === previous.values[0]?.runId) {
      previous.values.push(...item.values);
    } else grouped.push(item);
  }
  return grouped;
}

function requiredProjectionValue<Value>(
  values: readonly Value[],
  predicate: (value: Value) => boolean,
  error: string,
): Value {
  const value = values.find(predicate);
  if (!value) throw new Error(error);
  return value;
}

export type ConversationRow = { key: string; item?: ProjectionItem; draft?: AssistantDraftItem };
export interface ConversationRound { key: string; runId: string; rows: ConversationRow[] }

/** Stream identity keeps a text row in place when Session commits it to the timeline. */
export function conversationRounds(items: ProjectionItem[], drafts: AssistantDraftItem[], currentRunId?: string): ConversationRound[] {
  const rounds: ConversationRound[] = [];
  const append = (runId: string, row: ConversationRow) => {
    let round = rounds.at(-1);
    if (!round || round.runId !== runId) {
      round = { key: runId || row.key, runId, rows: [] };
      rounds.push(round);
    }
    round.rows.push(row);
  };
  const committedStreams = new Set<string>();
  for (const item of items) {
    const streamId = item.type === 'message' || item.type === 'narrative' ? item.streamId : undefined;
    if (streamId) committedStreams.add(streamId);
    const key = streamId ?? (item.type === 'message' ? item.value.messageId : item.type === 'toolGroup' ? item.groupId : `${item.type}:${item.sequence}`);
    append(item.type === 'toolGroup' ? item.values[0]!.runId : item.value.runId ?? '', { key, item });
  }
  if (currentRunId) {
    for (const draft of drafts) {
      if (draft.type === 'text' && committedStreams.has(draft.block.streamId)) continue;
      const key = draft.type === 'text' ? draft.block.streamId : draft.type === 'planPreview' ? draft.key : draft.groupId;
      append(currentRunId, { key, draft });
    }
    if (rounds.at(-1)?.runId !== currentRunId) rounds.push({ key: currentRunId, runId: currentRunId, rows: [] });
  }
  return rounds;
}
