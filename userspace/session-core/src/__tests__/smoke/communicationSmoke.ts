import type {
  AgentEvent,
  ApiResponse,
  KernelReply,
  LlmChatResult,
} from '@deepcode/protocol';
import { SessionDriverLoop } from '../../index.js';
import {
  NOW,
  assert,
  assertProviderReceivedInstruction,
  eventAppender,
  hasEvent,
  hasFinalAssistantContent,
  hasProviderTool,
  runResourceScenario,
  semanticToolResponse,
  smokeKernel,
  testSession,
  type SmokeCase,
} from './harness.js';

export const smokeCases: SmokeCase[] = [
  { id: 'communication.answer_roundtrip', run: answerRoundtrip },
  { id: 'communication.context_survives_tool_resume', run: contextSurvivesToolResume },
];

async function answerRoundtrip(): Promise<void> {
  const instruction = 'Summarize the currently available runtime context.';
  const session = testSession('session-smoke-answer');
  const events: AgentEvent[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: eventAppender(session, events),
    kernelCommand: async (request): Promise<KernelReply> => smokeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('communication smoke uses the streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      assertProviderReceivedInstruction(request, instruction);
      assert(
        hasProviderTool(request, 'session.submit_answer'),
        'the provider profile must expose session.submit_answer'
      );
      return semanticToolResponse(
        'session.submit_answer',
        { content: 'The current runtime context was summarized.' },
        'answer-roundtrip',
        onEvent
      );
    },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({ sessionId: session.id, content: instruction });
  assert(hasEvent(result.events, 'user_msg'), 'the user instruction must enter Session events');
  assert(
    hasFinalAssistantContent(result.events, 'The current runtime context was summarized.'),
    'the submitted answer must become the final Session message'
  );
  assert(!hasEvent(result.events, 'error'), 'the answer path must not settle as an error');
}

async function contextSurvivesToolResume(): Promise<void> {
  const path = 'notes/runtime-context.md';
  const scenario = await runResourceScenario({
    id: 'communication-context-resume',
    paths: [path],
    instruction: 'Read the selected runtime note and answer using that exact fact.',
  });

  assert(
    scenario.providerRequests.length >= 2,
    'a resource result must resume provider execution without fixing the internal turn count'
  );
  assert(hasEvent(scenario.result.events, 'tool_result'), 'the Kernel resource fact must be recorded');
  assert(
    hasFinalAssistantContent(
      scenario.result.events,
      'The requested runtime facts were incorporated.'
    ),
    'the resumed provider turn must be able to submit the final answer'
  );
}
