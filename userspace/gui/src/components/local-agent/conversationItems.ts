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
  return items;
}

export function projectionItems(projection: SessionProjection | null): ProjectionItem[] {
  if (!projection) return [];
  return projection.timeline.map((item): ProjectionItem => {
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
