import type { AgentEvent, AgentTimelineDelta, ProjectionDelta } from '@deepcode/protocol';
import {
  applyAgentTimelineDelta,
  CanonicalTimelineProjector,
} from '../timelineDelta.js';
import { assert, assertEqual, randomSmokeToken } from './smokeHelpers.js';

function event(
  sessionId: string,
  id: string,
  kind: AgentEvent['kind'],
  payload: unknown,
  offsetMs = 0
): AgentEvent {
  return {
    id,
    sessionId,
    kind,
    payload,
    ts: new Date(Date.now() + offsetMs).toISOString(),
  };
}

function applyAll(
  timeline: ReturnType<CanonicalTimelineProjector['snapshot']>,
  deltas: AgentTimelineDelta[]
) {
  return deltas.reduce((current, delta) => {
    const applied = applyAgentTimelineDelta(current, delta);
    assert(applied.status !== 'gap', `canonical delta ${delta.op} must apply without a gap`);
    return applied.timeline;
  }, timeline);
}

function run(): void {
  const token = randomSmokeToken('timeline');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const turnId = `turn-${token}`;
  const user = event(sessionId, `user-${token}`, 'user_msg', { content: `request-${token}` });
  const projector = new CanonicalTimelineProjector(sessionId, [user]);
  let rendered = projector.snapshot();

  const first: ProjectionDelta = {
    type: 'reasoning_delta',
    seq: 1,
    sessionId,
    runId,
    turnId,
    channel: 'reasoning',
    source: 'provider',
    status: 'streaming',
    delta: `reasoning-${token}`,
  };
  const firstDeltas = projector.push(first);
  assert(firstDeltas.some((delta) => delta.op === 'block.started'), 'first live text emits block.started');
  rendered = applyAll(rendered, firstDeltas);

  const second: ProjectionDelta = {
    ...first,
    seq: 2,
    delta: `-continued-${token}`,
  };
  const secondDeltas = projector.push(second);
  const append = secondDeltas.find((delta) => delta.op === 'text.append');
  assert(Boolean(append), 'growing live text emits text.append');
  rendered = applyAll(rendered, secondDeltas);
  const reasoningBlock = rendered.turns.flatMap((turn) => turn.blocks)
    .find((block) => block.narrativeKind === 'thinking');
  assertEqual(
    reasoningBlock?.bodyMarkdown,
    `${first.delta}${second.delta}`,
    'text.append preserves streamed content order'
  );
  assertEqual(reasoningBlock?.deliveryMode, 'live', 'provider deltas remain live delivery while streaming');

  if (append?.op === 'text.append') {
    const duplicate = applyAgentTimelineDelta(rendered, append);
    assertEqual(duplicate.status, 'duplicate', 'reapplying the same text delta is idempotent');
    const gap = applyAgentTimelineDelta(rendered, { ...append, offset: append.offset + append.text.length + 1 });
    assertEqual(gap.status, 'gap', 'a non-contiguous text delta requests snapshot recovery');
  }

  const committedReasoning = event(sessionId, `assistant-${token}`, 'assistant_msg', {
    runId,
    turnId,
    channel: 'reasoning',
    source: 'provider',
    status: 'completed',
    content: `${first.delta}${second.delta}`,
  }, 1);
  const committed = projector.commit([user, committedReasoning]);
  assert(
    committed.deltas.some((delta) => delta.op === 'block.committed'),
    'committed facts replace their live block in place'
  );
  rendered = applyAll(rendered, committed.deltas);
  assertEqual(
    rendered.turns.flatMap((turn) => turn.blocks).filter((block) => block.narrativeKind === 'thinking').length,
    1,
    'live and committed reasoning do not render duplicate blocks'
  );
  assertEqual(
    rendered.turns.flatMap((turn) => turn.blocks).find((block) => block.narrativeKind === 'thinking')?.deliveryMode,
    'replay',
    'committed reasoning settles without replaying the live text'
  );

  const internalStage: ProjectionDelta = {
    type: 'stage_delta',
    seq: 3,
    sessionId,
    runId,
    turnId,
    stage: 'stage.changed',
    status: 'completed',
    source: 'session',
  };
  assertEqual(projector.push(internalStage).length, 0, 'internal orchestration stages do not enter the canonical timeline');
  assertEqual(
    projector.push({
      ...internalStage,
      seq: 4,
      stage: 'accepted_plan.task_savepoint',
    }).length,
    0,
    'accepted-plan savepoints remain internal projection facts'
  );

  const target = `target-${randomSmokeToken('path')}`;
  const activityEvent = event(sessionId, `activity-${token}`, 'workflow_stage', {
    activity: {
      activityId: `activity-${token}`,
      kind: 'editFileCompleted',
      status: 'completed',
      title: `activity-${token}`,
      summary: `summary-${token}`,
      source: 'kernel',
      operation: 'delete',
      targets: [target],
    },
  }, 2);
  const workspace = new CanonicalTimelineProjector(sessionId, [user, activityEvent]).snapshot().workspaceProjection;
  assertEqual(workspace?.revision, 1, 'workspace refresh derives from structured edit operations');
  assertEqual(workspace?.changedTargets[0], target, 'workspace refresh retains the structured target');

  const planId = `plan-${randomSmokeToken('decision')}`;
  const planCard = event(sessionId, `plan-card-${token}`, 'plan_card', {
    runId,
    planId,
    status: 'pending',
    confirmable: true,
    summary: `plan-summary-${token}`,
  }, 3);
  const acceptedPlan = event(sessionId, `plan-accepted-${token}`, 'plan_review', {
    runId,
    planId,
    status: 'accepted',
    summary: `accepted-summary-${token}`,
    messageKey: 'session.driver.planReviewAccepted',
  }, 4);
  const decisionTimeline = new CanonicalTimelineProjector(
    sessionId,
    [user, planCard, acceptedPlan]
  ).snapshot();
  const decisionBlocks = decisionTimeline.turns.flatMap((turn) => turn.blocks);
  assertEqual(
    new Set(decisionBlocks.map((block) => block.id)).size,
    decisionBlocks.length,
    'plan facts and projected user decisions have globally unique block ids'
  );
  assertEqual(
    decisionBlocks.filter((block) => block.narrativeKind === 'plan').length,
    1,
    'a plan decision does not create a second plan card'
  );
  const acceptedUserBlock = decisionBlocks.find((block) =>
    block.narrativeKind === 'user' && block.events.some((item) => item.id === acceptedPlan.id)
  );
  assert(Boolean(acceptedUserBlock), 'accepted plan decision projects as a distinct user input block');
  assertEqual(
    decisionBlocks.find((block) => block.narrativeKind === 'plan')?.defaultCollapsed,
    true,
    'an accepted plan remains available as a collapsed plan card'
  );

  const decisionProjector = new CanonicalTimelineProjector(sessionId, [user]);
  let liveDecisionTimeline = decisionProjector.snapshot();
  liveDecisionTimeline = applyAll(
    liveDecisionTimeline,
    decisionProjector.commit([user, planCard]).deltas
  );
  liveDecisionTimeline = applyAll(
    liveDecisionTimeline,
    decisionProjector.commit([user, planCard, acceptedPlan]).deltas
  );
  const liveDecisionBlocks = liveDecisionTimeline.turns.flatMap((turn) => turn.blocks);
  assertEqual(
    liveDecisionBlocks.filter((block) => block.narrativeKind === 'plan').length,
    1,
    'accepting a live plan updates the existing plan card without a duplicate'
  );
  assertEqual(
    new Set(liveDecisionBlocks.map((block) => block.id)).size,
    liveDecisionBlocks.length,
    'live plan acceptance keeps block ids globally unique'
  );

  const bufferedDecisionProjector = new CanonicalTimelineProjector(sessionId, [user]);
  let bufferedDecisionTimeline = applyAll(
    bufferedDecisionProjector.snapshot(),
    bufferedDecisionProjector.commit([user, planCard]).deltas
  );
  assertEqual(
    bufferedDecisionTimeline.turns.flatMap((turn) => turn.blocks)
      .find((block) => block.narrativeKind === 'plan')?.deliveryMode,
    'buffered',
    'a newly committed plan uses buffered delivery'
  );
  const unrelatedActivity = event(sessionId, `activity-after-plan-${token}`, 'workflow_stage', {
    activity: {
      activityId: `activity-after-plan-${token}`,
      kind: 'toolExecution',
      status: 'completed',
      title: `activity-after-plan-${token}`,
      summary: `activity-after-plan-summary-${token}`,
      source: 'kernel',
      operation: 'exec',
      toolName: 'process.exec',
      targets: [],
    },
  }, 5);
  bufferedDecisionTimeline = applyAll(
    bufferedDecisionTimeline,
    bufferedDecisionProjector.commit([user, planCard, unrelatedActivity]).deltas
  );
  assertEqual(
    bufferedDecisionTimeline.turns.flatMap((turn) => turn.blocks)
      .find((block) => block.narrativeKind === 'plan')?.deliveryMode,
    'buffered',
    'later committed facts do not interrupt an existing buffered plan playback'
  );

  const reviewId = `review-${randomSmokeToken('decision')}`;
  const waitingReview = event(sessionId, `review-waiting-${token}`, 'review_summary', {
    runId,
    reviewId,
    status: 'waitingUserReview',
    confirmable: true,
    summary: `review-summary-${token}`,
  }, 5);
  const acceptedReview = event(sessionId, `review-accepted-${token}`, 'review_summary', {
    runId,
    reviewId,
    status: 'accepted',
    confirmable: false,
    summary: `accepted-review-${token}`,
    messageKey: 'review.decision.accepted.summary',
  }, 6);
  const reviewTimeline = new CanonicalTimelineProjector(
    sessionId,
    [user, waitingReview, acceptedReview]
  ).snapshot();
  const reviewBlocks = reviewTimeline.turns.flatMap((turn) => turn.blocks);
  assertEqual(
    reviewBlocks.filter((block) => block.narrativeKind === 'review').length,
    1,
    'accepting a review resolves the existing review card without creating a second card'
  );
  assertEqual(
    reviewBlocks.find((block) => block.narrativeKind === 'review')?.status,
    'completed',
    'the waiting review card settles after the accepted decision'
  );
  const acceptedReviewUserBlock = reviewBlocks.find((block) =>
    block.narrativeKind === 'user' && block.events.some((item) => item.id === acceptedReview.id)
  );
  assert(Boolean(acceptedReviewUserBlock), 'accepted review decision projects as a user input bubble');
  assertEqual(
    (acceptedReviewUserBlock?.events[0]?.payload as Record<string, unknown>)?.contentKey,
    'review.decision.accepted.userBubble',
    'accepted review user bubble uses the localized decision label'
  );

  const reasoningOne = event(sessionId, `reasoning-one-${token}`, 'assistant_msg', {
    channel: 'reasoning',
    content: `reasoning-one-${token}`,
  }, 5);
  const reasoningTwo = event(sessionId, `reasoning-two-${token}`, 'assistant_msg', {
    channel: 'reasoning',
    content: `reasoning-two-${token}`,
  }, 6);
  const reasoningTimeline = new CanonicalTimelineProjector(
    sessionId,
    [user, reasoningOne, reasoningTwo]
  ).snapshot();
  assertEqual(
    reasoningTimeline.turns.flatMap((turn) => turn.blocks)
      .filter((block) => block.narrativeKind === 'thinking').length,
    2,
    'separate provider reasoning items remain separate collapsible blocks'
  );

  const diagnostic = event(sessionId, `diagnostic-${token}`, 'assistant_msg', {
    channel: 'final',
    diagnostic: true,
    diagnosticCode: `code-${token}`,
    content: `internal-detail-${token}`,
  }, 7);
  const diagnosticBlock = new CanonicalTimelineProjector(sessionId, [user, diagnostic])
    .snapshot()
    .turns.flatMap((turn) => turn.blocks)
    .find((block) => block.narrativeKind === 'diagnostic');
  assert(Boolean(diagnosticBlock), 'structured provider diagnostics use the diagnostic projection');
  assertEqual(diagnosticBlock?.bodyMarkdown, undefined, 'raw diagnostic content is not rendered as assistant text');
}

run();
