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
  hasProviderTool,
  semanticToolResponse,
  smokeKernel,
  testSession,
  type SmokeCase,
} from './harness.js';

export const smokeCases: SmokeCase[] = [
  { id: 'authorization.plan_waits_for_user', run: planWaitsForUser },
];

async function planWaitsForUser(): Promise<void> {
  const instruction = 'Prepare a reviewable plan before changing runtime-output.txt.';
  const session = testSession('session-smoke-plan');
  const events: AgentEvent[] = [];
  const kernelCommands: string[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: eventAppender(session, events),
    kernelCommand: async (request): Promise<KernelReply> => {
      kernelCommands.push(request.command.kind);
      return smokeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('authorization smoke uses the streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      assertProviderReceivedInstruction(request, instruction);
      assert(
        hasProviderTool(request, 'session.submit_plan'),
        'the planning provider profile must expose session.submit_plan'
      );
      return semanticToolResponse(
        'session.submit_plan',
        {
          title: 'Review runtime output change',
          summary: 'Create one reviewed runtime output after user acceptance.',
          tasks: [{
            taskId: 'task-runtime-output',
            title: 'Create runtime output',
            target: ['runtime-output.txt'],
            toolId: 'fs.create',
            args: {},
            dependencies: [],
            acceptanceCriteria: ['Kernel facts identify runtime-output.txt.'],
            failureCriteria: ['Stop if another target is required.'],
          }],
          risks: ['The workspace write remains subject to Kernel permission policy.'],
          reviewCheckpoints: ['Review the target before execution.'],
        },
        'submit-plan',
        onEvent
      );
    },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${events.length + kernelCommands.length + 1}`,
  });

  const result = await loop.runUserTurn({ sessionId: session.id, content: instruction });
  assert(
    result.events.some((event) =>
      event.kind === 'plan_card' && Boolean((event.payload as any)?.taskPlan)
    ),
    'the submitted plan must become a user-reviewable plan card'
  );
  assert(
    !kernelCommands.includes('actionBatchSubmit'),
    'Session must not submit executable work before the user accepts the plan'
  );
}
