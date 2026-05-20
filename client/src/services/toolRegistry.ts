import type { AgentMode, ToolDefinition } from '@deepcode/protocol';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'fs.read',
    description: 'Read a text file from the current workspace.',
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
      },
      required: ['path'],
    },
  },
  {
    name: 'fs.write',
    description: 'Write text content to a workspace file after user approval.',
    riskLevel: 'medium',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fs.list',
    description: 'List files and directories under a workspace path.',
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
        depth: { type: 'number' },
      },
    },
  },
  {
    name: 'fs.diff',
    description: 'Create a unified diff preview for a proposed file edit.',
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['plan', 'askBeforeWrite'],
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
        newContent: { type: 'string' },
      },
      required: ['path', 'newContent'],
    },
  },
  {
    name: 'code.search',
    description: 'Search text across workspace files.',
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        isRegex: { type: 'boolean' },
        include: { type: 'array', items: { type: 'string' } },
        folderId: { type: 'string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'shell.propose',
    description: 'Propose a shell command as dry-run text. It never executes.',
    riskLevel: 'medium',
    needsApproval: true,
    allowedModes: ['plan', 'askBeforeWrite'],
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['command'],
    },
  },
];

export function getAllowedTools(mode: AgentMode): ToolDefinition[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.allowedModes.includes(mode));
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}
