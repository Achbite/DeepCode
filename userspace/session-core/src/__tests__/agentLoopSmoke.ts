import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
} from '@deepcode/protocol';
import {
  dependencyFactsForTask,
  taskDependencyFactsFromKernelEvents,
} from '../accepted-plan/index.js';
import { SessionDriverLoop } from '../index.js';
import { assert } from './smokeHelpers.js';
import {
  fakeKernel,
  genericTaskPlanProposal,
  planKernel,
} from './smokeFixtures.js';

declare const process: {
  env: Record<string, string | undefined>;
};

type SmokeCase = {
  id: string;
  run: () => Promise<void>;
};

type ReadScenarioResult = {
  result: AgentSessionResult;
  resolvedPaths: string[];
};

const NOW = '2026-01-01T00:00:00.000Z';

async function main(): Promise<void> {
  assertControllerInvocation();
  const cases: SmokeCase[] = [
    { id: 'agent.answer_roundtrip', run: assertAnswerRoundTrip },
    { id: 'agent.resource_tool_result_resumes_loop', run: assertResourceToolResultResumesLoop },
    { id: 'regression.resource_loop_continues_past_former_limit', run: assertResourceLoopContinuesPastFormerLimit },
    {
      id: 'regression.typed_completion_fact_bridge',
      run: assertTypedCompletionFactBridge,
    },
    { id: 'agent.plan_requires_user_acceptance', run: assertPlanRequiresUserAcceptance },
  ];

  for (const smokeCase of cases) {
    try {
      await smokeCase.run();
      console.log(`[PASS] ${smokeCase.id}`);
    } catch (error) {
      throw new Error(`[FAIL] ${smokeCase.id}`, { cause: error });
    }
  }
}

function assertControllerInvocation(): void {
  if (
    process.env.DEEPCODE_TEST_CONTROLLER !== '1' ||
    process.env.DEEPCODE_TEST_SUITE_ID !== 'session.smoke'
  ) {
    throw new Error('Session smoke is internal; use bash ./test.sh --profile smoke.');
  }
}

async function assertAnswerRoundTrip(): Promise<void> {
  const instruction = 'Summarize the available generic context.';
  const session = testSession('session-smoke-answer');
  const events: AgentEvent[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: eventAppender(session, events),
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('answer smoke expects the streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      assertProviderReceivedUserInstruction(request, instruction);
      assert(
        hasProviderTool(request, 'session.submit_answer'),
        'the planning profile registers the answer semantic tool'
      );
      return semanticToolResponse(
        'session.submit_answer',
        { content: 'The available generic context was summarized.' },
        'answer-roundtrip',
        onEvent
      );
    },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: instruction,
  });

  assert(hasEvent(result.events, 'user_msg'), 'the user instruction enters the Session event stream');
  assert(
    hasFinalAssistantContent(result.events, 'The available generic context was summarized.'),
    'the Agent loop settles with the submitted final answer'
  );
  assert(!hasEvent(result.events, 'error'), 'the answer round trip does not settle as an error');
}

async function assertResourceToolResultResumesLoop(): Promise<void> {
  const requestedPath = 'generic-smoke-input.txt';
  const scenario = await runReadScenario({
    id: 'read-tool-result',
    nextPath: (turn) => turn === 1 ? requestedPath : undefined,
  });

  assert(
    wasResolved(scenario.resolvedPaths, requestedPath),
    `the selected read tool crosses the Kernel ResourceResolve boundary: paths=${JSON.stringify(scenario.resolvedPaths)} events=${JSON.stringify(scenario.result.events.map((event) => ({ kind: event.kind, payload: event.payload })))}`
  );
  assert(hasEvent(scenario.result.events, 'tool_result'), 'the Kernel resource fact is recorded for the Agent');
  assert(
    hasFinalAssistantContent(
      scenario.result.events,
      'The requested generic resource facts were incorporated.'
    ),
    'the Agent resumes from the tool fact and submits the final answer'
  );
}

async function assertResourceLoopContinuesPastFormerLimit(): Promise<void> {
  const requestedPaths = Array.from({ length: 5 }, (_, index) => `generic-history-${index + 1}.txt`);
  const scenario = await runReadScenario({
    id: 'read-past-former-limit',
    nextPath: (turn) => requestedPaths[turn - 1],
  });

  assert(
    requestedPaths.every((path) => wasResolved(scenario.resolvedPaths, path)),
    'the Agent can gather every requested fact beyond the former four-read loop limit'
  );
  assert(hasFinalAssistantMessage(scenario.result.events), 'the multi-read Agent loop converges to an answer');
  assert(
    !scenario.result.events.some((event) => event.id.includes('native_tool_loop_exhausted')),
    'the removed fixed-round exhaustion failure does not return'
  );
}

async function assertPlanRequiresUserAcceptance(): Promise<void> {
  const instruction = 'Prepare a reviewed plan before changing the generic output file.';
  const session = testSession('session-smoke-write-plan');
  const events: AgentEvent[] = [];
  const kernelCommands: string[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  let providerTurns = 0;
  const loop = new SessionDriverLoop({
    appendEvents: eventAppender(session, events),
    kernelCommand: async (request): Promise<KernelReply> => {
      kernelCommands.push(request.command.kind);
      return planKernel(request, session.id, submittedPlans);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('write-tool smoke expects the streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      providerTurns += 1;
      if (providerTurns !== 1) {
        throw new Error('planning smoke should settle after one submitted plan');
      }
      assertProviderReceivedUserInstruction(request, instruction);
      assert(
        hasProviderTool(request, 'session.submit_plan'),
        'the planning profile registers the plan semantic tool'
      );
      const proposal = genericTaskPlanProposal();
      return semanticToolResponse(
        'session.submit_plan',
        proposal.taskPlan as Record<string, unknown>,
        'submit-reviewed-plan',
        onEvent
      );
    },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${events.length + kernelCommands.length + providerTurns + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: instruction,
  });

  assert(
    result.events.some((event) => event.kind === 'plan_card' && Boolean((event.payload as any)?.taskPlan)),
    'the Agent instruction becomes a user-reviewable task plan'
  );
  assert(
    !kernelCommands.includes('actionBatchSubmit'),
    'the Session does not submit executable work before the user accepts the plan'
  );
}

async function assertTypedCompletionFactBridge(): Promise<void> {
  const taskId = 'task-smoke-typed-completion';
  const runId = 'run-smoke-typed-completion';
  const workUnitId = 'work-smoke-typed-completion';
  const path = 'generic-typed-completion.txt';
  const facts = taskDependencyFactsFromKernelEvents(taskId, [
    {
      payload: {
        kernelEvent: {
          kind: 'work_unit.completed',
          runId,
          workUnitId,
        },
      },
    },
    {
      payload: {
        kernelEvent: {
          kind: 'tool.completed',
          runId,
          fact: {
            ok: true,
            toolCallId: 'call-smoke-typed-completion',
            toolId: 'fs.create',
            operationKind: 'fsCreate',
            output: {
              path,
              contentHash: 'hash-smoke-typed-completion',
              sizeBytes: 17,
              kernelContext: { workUnitId },
            },
            error: null,
          },
        },
      },
    },
  ]);

  assert(facts.length === 1, 'paired typed Kernel completion facts produce one task dependency fact');
  assert(facts[0]?.path === path, 'the typed completion bridge preserves the Kernel-observed target');
  assert(
    dependencyFactsForTask(facts, [taskId]).length === 1,
    'the next task can consume the completed dependency fact'
  );
}

async function runReadScenario(input: {
  id: string;
  nextPath: (turn: number) => string | undefined;
}): Promise<ReadScenarioResult> {
  const instruction = 'Read the generic resources needed to answer, then finish the response.';
  const session = testSession(`session-smoke-${input.id}`);
  const events: AgentEvent[] = [];
  const resolvedPaths: string[] = [];
  const requestedPaths: string[] = [];
  let providerTurns = 0;
  const loop = new SessionDriverLoop({
    appendEvents: eventAppender(session, events),
    kernelCommand: async (request): Promise<KernelReply> => {
      collectResolvedPaths(request, resolvedPaths);
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('read-tool smoke expects the streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      providerTurns += 1;
      assertProviderReceivedUserInstruction(request, instruction);
      assertProviderReceivedResourceFacts(request, requestedPaths);
      const path = input.nextPath(providerTurns);
      if (path) {
        assert(
          hasProviderTool(request, 'session.request_resources'),
          'the current provider profile registers the resource request semantic tool'
        );
        requestedPaths.push(path);
        return semanticToolResponse(
          'session.request_resources',
          {
            reason: `Resolve ${path} for the current answer.`,
            requests: [{
              kind: 'fileText',
              path,
              reason: `Read ${path} before answering.`,
            }],
          },
          `resource-${input.id}-${providerTurns}`,
          onEvent
        );
      }
      assert(
        hasProviderTool(request, 'session.submit_answer'),
        'the resumed provider profile registers the answer semantic tool'
      );
      return semanticToolResponse(
        'session.submit_answer',
        { content: 'The requested generic resource facts were incorporated.' },
        `answer-${input.id}-${providerTurns}`,
        onEvent
      );
    },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${events.length + resolvedPaths.length + providerTurns + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: instruction,
    attachments: [{
      kind: 'directory',
      path: 'generic-smoke-project',
      absolutePath: '/tmp/generic-smoke-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  return { result, resolvedPaths };
}

function testSession(id: string): AgentSession {
  return {
    id,
    mode: 'plan',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function eventAppender(
  session: AgentSession,
  events: AgentEvent[]
): (sessionId: string, nextEvents: AgentEvent[]) => Promise<AgentSessionResult> {
  return async (_sessionId, nextEvents) => {
    events.push(...nextEvents);
    return {
      session: { ...session, eventCount: events.length },
      events: [...events],
    };
  };
}

function collectResolvedPaths(request: KernelCommandEnvelope, resolvedPaths: string[]): void {
  if (request.command.kind !== 'resourceResolve') return;
  const manifest = request.command.request.manifest as Record<string, any>;
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const entry of entries) {
    const path = String(entry.path ?? entry.resourceRef ?? '').trim();
    if (path) resolvedPaths.push(path);
  }
}

function wasResolved(resolvedPaths: string[], requestedPath: string): boolean {
  return resolvedPaths.some((path) => path.endsWith(requestedPath));
}

function hasProviderTool(request: LlmChatRequest, name: string): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === name));
}

function assertProviderReceivedUserInstruction(
  request: LlmChatRequest,
  instruction: string
): void {
  assert(
    request.messages.some((message) =>
      message.role === 'user' && message.content.includes(instruction)
    ),
    'the provider request contains the current user instruction'
  );
}

function assertProviderReceivedResourceFacts(
  request: LlmChatRequest,
  expectedPaths: string[]
): void {
  if (expectedPaths.length === 0) return;
  const toolFacts = request.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');
  assert(
    toolFacts.includes('resolved generic content'),
    'the resumed provider request contains the Kernel-observed resource content'
  );
  for (const path of expectedPaths) {
    assert(
      toolFacts.includes(path),
      `the resumed provider request contains the Kernel resource fact for ${path}`
    );
  }
}

async function semanticToolResponse(
  name: string,
  argumentsValue: Record<string, unknown>,
  callId: string,
  onEvent: (event: LlmChatStreamEvent) => void | Promise<void>
): Promise<ApiResponse<LlmChatResult>> {
  const chunk: LlmChatResult['chunks'][number] = {
    type: 'tool_call',
    index: 0,
    callId,
    toolCallDelta: {
      id: callId,
      index: 0,
      name,
      argumentsDelta: JSON.stringify(argumentsValue),
    },
  };
  await onEvent({ type: 'provider_tool_call_delta', chunk });
  return {
    ok: true,
    data: {
      chunks: [chunk, { type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: callId, name, arguments: argumentsValue }],
      },
    },
  };
}

function hasEvent(events: AgentEvent[], kind: AgentEvent['kind']): boolean {
  return events.some((event) => event.kind === kind);
}

function hasFinalAssistantMessage(events: AgentEvent[]): boolean {
  return events.some((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
}

function hasFinalAssistantContent(events: AgentEvent[], content: string): boolean {
  return events.some((event) =>
    event.kind === 'assistant_msg' &&
    (event.payload as any)?.channel === 'final' &&
    (event.payload as any)?.content === content
  );
}

main().catch((error) => {
  console.error(error);
  throw error;
});
