import type { AgentMode } from './agent.js';
import type { ToolDefinition } from './tools.js';

export const DEFAULT_AGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'fs.read',
    description: 'Read a text file from the active workspace.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
      },
    },
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
  },
  {
    name: 'fs.list',
    description: 'List a workspace directory tree with a bounded depth.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
        depth: { type: 'number' },
      },
    },
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
  },
  {
    name: 'fs.diff',
    description: 'Preview a file diff without writing content.',
    inputSchema: {
      type: 'object',
      required: ['path', 'newContent'],
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
        newContent: { type: 'string' },
      },
    },
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
  },
  {
    name: 'code.search',
    description: 'Search text across the workspace with bounded results.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        isRegex: { type: 'boolean' },
        include: { type: 'array', items: { type: 'string' } },
        folderId: { type: 'string' },
      },
    },
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
  },
  {
    name: 'shell.propose',
    description: 'Return a proposed shell command. The command is never executed.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    riskLevel: 'medium',
    needsApproval: false,
    allowedModes: ['plan', 'askBeforeWrite'],
  },
  {
    name: 'fs.write',
    description: 'Write a text file after an explicit permission approval.',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        folderId: { type: 'string' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
];

export function listDefaultAgentTools(mode?: AgentMode): ToolDefinition[] {
  return mode
    ? DEFAULT_AGENT_TOOL_DEFINITIONS.filter((tool) => tool.allowedModes.includes(mode))
    : DEFAULT_AGENT_TOOL_DEFINITIONS;
}

export function findDefaultAgentTool(name: string): ToolDefinition | undefined {
  return DEFAULT_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
