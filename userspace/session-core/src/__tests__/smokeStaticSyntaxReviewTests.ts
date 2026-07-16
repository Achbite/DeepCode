import type { LlmChatRequest, ProjectionDelta } from '@deepcode/protocol';
import type { AcceptedTaskPlanContext } from '../driver/execution/index.js';
import { ContextFrameBuilder } from '../driver/context/contextFrameBuilder.js';
import {
  AcceptedPlanStaticSyntaxReviewCoordinator,
  type AcceptedPlanStaticSyntaxReviewState,
  ReviewAssembler,
} from '../driver/review/index.js';
import {
  assert,
  assertEqual,
  randomSmokeToken,
  smokePromptEnvelope,
} from './smokeHelpers.js';

export async function assertAcceptedPlanStaticSyntaxReviewCoordinatorBuildsEvents(): Promise<void> {
  const token = randomSmokeToken('static-review');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const targetPath = `generated-${token}.ts`;
  const state: AcceptedPlanStaticSyntaxReviewState = {
    sessionId,
    runId,
    userRequest: `review generated files for ${token}`,
    generatedArtifactEvidence: new Map(),
    resourcePackets: [],
  };
  const deltas: ProjectionDelta[] = [];
  let providerStage = '';
  let providerMessages: LlmChatRequest['messages'] = [];
  const coordinator = new AcceptedPlanStaticSyntaxReviewCoordinator({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    emitProjectionDelta: async (_state, delta) => {
      deltas.push(delta);
    },
    runStaticSyntaxReview: async ({ stage, messages }) => {
      providerStage = stage;
      providerMessages = messages;
      return {
        toolCalls: [{
          callId: `static-review-${token}`,
          index: 0,
          name: 'session.submit_static_review',
          arguments: {
            summary: `summary-${token}`,
            issues: [{
              targetRef: targetPath,
              severity: 'warning',
              message: `issue-${token}`,
            }],
          },
        }],
      };
    },
    event: (nextSessionId, kind, payload) => ({
      id: `event-${token}`,
      sessionId: nextSessionId,
      ts: `ts-${token}`,
      kind,
      payload,
    }),
    reviewAssembler: {
      staticSyntaxReviewPacket: () => ({
        planId,
        files: [{
          targetPath,
          language: 'typescript',
          content: `const value${token.replace(/-/g, '')} = 1;`,
          contentHash: `hash-${token}`,
        }],
      }),
      staticSyntaxReviewMessages: () => [{
        role: 'user',
        content: `packet-${token}`,
      }],
      normalizeStaticSyntaxIssues: (value: unknown) => Array.isArray(value)
        ? value.map((item) => ({ ...(item as Record<string, unknown>), targetPath: (item as Record<string, unknown>).targetRef }))
        : [],
    } as unknown as ReviewAssembler,
    contextFrameBuilder: new ContextFrameBuilder(),
  });

  const events = await coordinator.run({
    profileId: `profile-${token}`,
    state,
    prompt: smokePromptEnvelope(`stable-${token}`),
    accepted: { planId } as unknown as AcceptedTaskPlanContext,
    batch: {},
    batchEvents: [],
  });

  assertEqual(deltas.length, 1, 'static syntax review coordinator emits running projection delta');
  assertEqual(deltas[0]?.sessionId, sessionId, 'static syntax review delta carries session id');
  assertEqual((deltas[0]?.payload as any)?.messageKey, 'session.driver.acceptedPlanStaticSyntaxReviewRunning', 'static syntax review delta carries i18n key');
  assertEqual(providerStage, 'accepted_plan_static_syntax_review', 'static syntax review coordinator uses expected provider stage');
  assertEqual(providerMessages.length, 2, 'static syntax review coordinator emits a side-call system and user message');
  assert(String(providerMessages[0]?.content ?? '').includes('review-v1'), 'static syntax review uses the stable review provider profile');
  assert(String(providerMessages[1]?.content ?? '').includes('ProviderTurnContract:'), 'static syntax review coordinator renders a ProviderTurnContract wrapper');
  assert(String(providerMessages[1]?.content ?? '').includes(`packet-${token}`), 'static syntax review coordinator preserves assembler packet content');
  assertEqual(state.modelContextBundle?.providerTurnContract.turnMode, 'reviewAnswer', 'static syntax review stores side-call turn mode');
  assertEqual(state.modelContextBundle?.providerTurnContract.requiredKind, 'staticSyntaxReview', 'static syntax review stores required side-call kind');
  assertEqual(events.length, 1, 'static syntax review coordinator returns one workflow event');
  assertEqual(events[0]?.kind, 'workflow_stage', 'static syntax review coordinator emits workflow stage event');
  const payload = events[0]?.payload as Record<string, any>;
  assertEqual(payload.stage, 'accepted_plan.static_syntax_review', 'static syntax review event uses accepted plan static review stage');
  assertEqual(payload.status, 'blocked', 'static syntax review marks issues as blocked');
  assertEqual(payload.messageKey, 'session.driver.acceptedPlanStaticSyntaxReviewBlocked', 'static syntax review event carries blocked i18n key');
  assertEqual(payload.issues?.[0]?.targetPath, targetPath, 'static syntax review event carries normalized issue target');
}

export async function assertAcceptedPlanStaticSyntaxReviewCoordinatorTimesOut(): Promise<void> {
  const token = randomSmokeToken('static-review-timeout');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const planId = `plan-${token}`;
  const targetPath = `generated-${token}.ts`;
  const state: AcceptedPlanStaticSyntaxReviewState = {
    sessionId,
    runId,
    userRequest: `review generated files for ${token}`,
    generatedArtifactEvidence: new Map(),
    resourcePackets: [],
  };
  const coordinator = new AcceptedPlanStaticSyntaxReviewCoordinator({
    now: () => `ts-${token}`,
    createId: (prefix) => `${prefix}-${token}`,
    staticSyntaxReviewTimeoutMs: 1,
    emitProjectionDelta: async () => undefined,
    runStaticSyntaxReview: async () => new Promise<{ toolCalls: [] }>(() => undefined),
    event: (nextSessionId, kind, payload) => ({
      id: `event-${token}`,
      sessionId: nextSessionId,
      ts: `ts-${token}`,
      kind,
      payload,
    }),
    reviewAssembler: {
      staticSyntaxReviewPacket: () => ({
        planId,
        files: [{
          targetPath,
          language: 'typescript',
          content: `const value${token.replace(/-/g, '')} = 1;`,
          contentHash: `hash-${token}`,
        }],
      }),
      staticSyntaxReviewMessages: () => [{
        role: 'user',
        content: `packet-${token}`,
      }],
      normalizeStaticSyntaxIssues: (value: unknown) => Array.isArray(value) ? value as Array<Record<string, unknown>> : [],
    } as unknown as ReviewAssembler,
    contextFrameBuilder: new ContextFrameBuilder(),
  });

  const events = await coordinator.run({
    state,
    prompt: smokePromptEnvelope(`stable-${token}`),
    accepted: { planId } as unknown as AcceptedTaskPlanContext,
    batch: {},
    batchEvents: [],
  });

  assertEqual(events.length, 1, 'static syntax review timeout still returns one workflow event');
  const payload = events[0]?.payload as Record<string, any>;
  assertEqual(payload.status, 'failed', 'static syntax review timeout is recorded as failed advisory check');
  assertEqual(payload.messageKey, 'session.driver.acceptedPlanStaticSyntaxReviewFailed', 'static syntax review timeout keeps i18n key');
  assertEqual(payload.issues?.[0]?.severity, 'warning', 'static syntax review timeout is downgraded to a warning issue');
  assert(String(payload.issues?.[0]?.message ?? '').includes('timed out'), 'static syntax review timeout records the timeout reason');
}
