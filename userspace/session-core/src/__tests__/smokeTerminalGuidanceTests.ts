import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelReply,
  LlmChatResult,
} from '@deepcode/protocol';
import {
  collectUserGuidanceEvents,
  SessionDriverLoop,
} from '../index.js';
import {
  assert,
  assertEqual,
} from './smokeHelpers.js';
import {
  fakeKernel,
} from './smokeFixtures.js';

export async function assertSessionDriverLoopTerminalAnswerGuidanceRevision(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-terminal-guidance',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        events.push({
          id: 'guidance-terminal-generic',
          sessionId: 'session-terminal-guidance',
          ts: '2026-01-01T00:00:00.500Z',
          kind: 'user_guidance',
          payload: {
            content: 'Include a generic evaluation dashboard and visible metrics.',
            guidance: 'Include a generic evaluation dashboard and visible metrics.',
            targetRunId: 'run-generic',
            status: 'queued',
            source: 'user',
            effectiveCheckpoint: 'nextProviderCall',
          },
        });
        return semanticAnswerResponse('answer-initial-generic', 'Initial generic plan without metrics.');
      }
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(promptText.includes('ProviderTurnContract:'), 'guidance revision prompt is admitted through ProviderTurnContract');
      assert(promptText.includes('Unshown draft answer'), 'guidance revision prompt carries unshown draft answer');
      assert(promptText.includes('Include a generic evaluation dashboard'), 'guidance revision prompt carries queued user guidance');
      events.push({
        id: 'guidance-during-revision-generic',
        sessionId: 'session-terminal-guidance',
        ts: '2026-01-01T00:00:00.750Z',
        kind: 'user_guidance',
        payload: {
          content: 'Keep the final project plan concise.',
          guidance: 'Keep the final project plan concise.',
          targetRunId: 'run-generic',
          status: 'queued',
          source: 'user',
          effectiveCheckpoint: 'nextProviderCall',
        },
      });
      return semanticToolResponse('answer-revised-generic', 'session.submit_answer', {
        content: 'Revised generic plan with an evaluation dashboard and visible metrics.',
        narration: 'I will merge the new evaluation-dashboard guidance into the current answer.',
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-terminal-guidance',
    content: 'Plan a generic learning project.',
  });

  const finalMessages = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
  assertEqual(llmCalls, 2, 'terminal queued guidance triggers one guidance revision provider call');
  assertEqual(finalMessages.length, 1, 'draft answer is replaced by a single final answer');
  assert(String((finalMessages[0]?.payload as any)?.content ?? '').includes('evaluation dashboard'), 'final answer applies queued guidance');
  assertEqual(Boolean((finalMessages[0]?.payload as any)?.guidanceRevision), true, 'final answer records guidance revision metadata');
  assertEqual(
    Array.isArray((finalMessages[0]?.payload as any)?.appliedGuidanceIds) &&
      (finalMessages[0]?.payload as any).appliedGuidanceIds.includes('guidance-terminal-generic'),
    true,
    'final answer records applied guidance ids'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'session' &&
      String((event.payload as any)?.content ?? '').includes('received your update')
    ),
    true,
    'session transition message follows the user language before guidance revision'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'llm' &&
      String((event.payload as any)?.content ?? '').includes('evaluation-dashboard')
    ),
    true,
    'LLM narration transition is visible when returned'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'user_guidance' &&
      (event.payload as any)?.status === 'consumed' &&
      (event.payload as any)?.guidanceId === 'guidance-terminal-generic' &&
      (event.payload as any)?.appliedAtProviderStage === 'guidance_revision'
    ),
    true,
    'consumed guidance records guidance revision provider checkpoint'
  );
  const remainingGuidance = collectUserGuidanceEvents(result.events, 'run-generic');
  assertEqual(
    remainingGuidance.some((item) => item.id === 'guidance-during-revision-generic'),
    true,
    'guidance arriving during guidance revision remains queued for a later checkpoint'
  );
}

export async function assertSessionDriverLoopTerminalGuidanceRevisionFallback(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-terminal-guidance-fallback',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        events.push({
          id: 'guidance-terminal-fallback-generic',
          sessionId: 'session-terminal-guidance-fallback',
          ts: '2026-01-01T00:00:00.500Z',
          kind: 'user_guidance',
          payload: {
            content: 'Add a generic evaluation view.',
            guidance: 'Add a generic evaluation view.',
            targetRunId: 'run-generic',
            status: 'queued',
            source: 'user',
            effectiveCheckpoint: 'nextProviderCall',
          },
        });
        return semanticAnswerResponse('answer-initial-fallback-generic', 'Initial fallback answer.');
      }
      return semanticToolResponse('invalid-guidance-kind', 'session.submit_plan', {
        title: 'Invalid guidance revision plan',
        summary: 'This planning directive is not allowed in the review answer profile.',
        tasks: [],
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-terminal-guidance-fallback',
    content: 'Plan another generic learning project.',
  });

  const finalMessages = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
  assertEqual(llmCalls, 2, 'terminal guidance fallback attempts one revision call');
  assertEqual(finalMessages.length, 1, 'fallback path still produces one final answer');
  assertEqual(String((finalMessages[0]?.payload as any)?.content ?? ''), 'Initial fallback answer.', 'fallback final answer uses initial draft');
  assertEqual(Boolean((finalMessages[0]?.payload as any)?.guidanceRevisionFailed), true, 'fallback final answer records guidance revision failure');
  assertEqual(result.events.some((event) => event.kind === 'error'), true, 'guidance revision failure records a diagnostic event');
}

function semanticAnswerResponse(callId: string, content: string): ApiResponse<LlmChatResult> {
  return semanticToolResponse(callId, 'session.submit_answer', { content });
}

function semanticToolResponse(
  callId: string,
  name: string,
  argumentsValue: Record<string, unknown>
): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'reasoning_delta', content: 'generic reasoning' }, { type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: '',
        reasoningContent: 'generic reasoning',
        toolCalls: [{
          id: callId,
          name,
          arguments: argumentsValue,
        }],
      },
    },
  };
}
