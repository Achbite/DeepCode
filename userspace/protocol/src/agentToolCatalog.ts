import type { AgentMode } from './agent.js';
import type { ToolDefinition } from './tools.js';

export function listDefaultAgentTools(_mode?: AgentMode): ToolDefinition[] {
  return [];
}

export function findDefaultAgentTool(_name: string): ToolDefinition | undefined {
  return undefined;
}
