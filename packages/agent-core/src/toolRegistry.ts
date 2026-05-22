import type { AgentMode, ToolDefinition } from '@deepcode/protocol';
import {
  DEFAULT_AGENT_TOOL_DEFINITIONS,
  findDefaultAgentTool,
  listDefaultAgentTools,
} from '@deepcode/protocol';

export class ToolRegistry {
  constructor(private readonly tools: ToolDefinition[] = DEFAULT_AGENT_TOOL_DEFINITIONS) {}

  list(mode?: AgentMode): ToolDefinition[] {
    return mode
      ? this.tools.filter((tool) => tool.allowedModes.includes(mode))
      : [...this.tools];
  }

  find(name: string): ToolDefinition | undefined {
    return this.tools.find((tool) => tool.name === name) ?? findDefaultAgentTool(name);
  }
}

export function listAgentTools(mode?: AgentMode) {
  return { tools: listDefaultAgentTools(mode) };
}
