import type {
  AgentActionParseRequest,
  AgentActionParseResult,
  AgentFixtureRunRequest,
  AgentFixtureRunResult,
} from '@deepcode/protocol';
import {
  AgentActionParser,
  AgentWorkflowRunner,
  ToolExecutorRouter,
} from '@deepcode/agent-core';
import { executeAgentTool, permissionGate } from './toolService.js';

const parser = new AgentActionParser();

function createRunner(): AgentWorkflowRunner {
  const router = new ToolExecutorRouter();
  for (const toolName of [
    'fs.read',
    'fs.list',
    'fs.diff',
    'fs.write',
    'code.search',
    'shell.propose',
    'shell.exec',
  ]) {
    router.register(toolName, executeAgentTool);
  }
  return new AgentWorkflowRunner(parser, permissionGate, router);
}

export function parseAgentActions(request: AgentActionParseRequest): AgentActionParseResult {
  return parser.parse(request);
}

export async function runAgentFixture(
  request: AgentFixtureRunRequest
): Promise<AgentFixtureRunResult> {
  const runner = createRunner();
  return runner.run({
    ...request,
    sessionId: request.sessionId ?? `fixture-${Date.now()}`,
  });
}
