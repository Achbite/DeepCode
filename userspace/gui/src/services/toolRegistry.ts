import type { AgentMode, ToolDefinition } from '@deepcode/protocol';
import {
  findDefaultAgentTool,
  listDefaultAgentTools,
} from '@deepcode/protocol';

export const TOOL_DEFINITIONS: ToolDefinition[] = listDefaultAgentTools();

export function getAllowedTools(mode: AgentMode): ToolDefinition[] {
  return listDefaultAgentTools(mode);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return findDefaultAgentTool(name);
}
