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
    name: 'shell.exec',
    description: 'Run a command in an Agent-owned temporary shell after explicit approval.',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
        reason: { type: 'string' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
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
  {
    name: 'fs.delete',
    description: 'Delete a workspace file after explicit high-risk permission approval.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        folderId: { type: 'string' },
        reason: { type: 'string' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'web.search',
    description: 'Search the public web as untrusted evidence after network approval.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'web.fetch',
    description: 'Fetch an http/https page as untrusted evidence after network approval.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        maxBytes: { type: 'number' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'git.status',
    description: 'Read workspace Git status.',
    inputSchema: { type: 'object', properties: {} },
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
  },
  {
    name: 'git.diff',
    description: 'Read workspace Git diff.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        staged: { type: 'boolean' },
      },
    },
    riskLevel: 'low',
    needsApproval: false,
    allowedModes: ['readOnly', 'plan', 'askBeforeWrite'],
  },
  {
    name: 'git.stage',
    description: 'Stage workspace-relative paths after approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'git.unstage',
    description: 'Unstage workspace-relative paths after approval.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        paths: { type: 'array', items: { type: 'string' } },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'git.commit',
    description: 'Create a local Git commit after approval. Does not push.',
    inputSchema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'git.push',
    description: 'Push the current branch to a configured remote after explicit push approval.',
    inputSchema: {
      type: 'object',
      properties: {
        remote: { type: 'string' },
        branch: { type: 'string' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.open',
    description: 'Open a URL in the Editor internal browser after approval.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: { url: { type: 'string' } },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.reload',
    description: 'Reload the Editor internal browser after approval.',
    inputSchema: { type: 'object', properties: {} },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.snapshot',
    description: 'Capture a semantic snapshot from the Editor internal browser.',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' } },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.inspect',
    description: 'Toggle or set internal browser inspect mode after approval.',
    inputSchema: {
      type: 'object',
      properties: { inspectState: { type: 'string' } },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.click',
    description: 'Click a selector in the internal browser after approval.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: { selector: { type: 'string' } },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.type',
    description: 'Type text into a selector in the internal browser after approval.',
    inputSchema: {
      type: 'object',
      required: ['selector', 'text'],
      properties: {
        selector: { type: 'string' },
        text: { type: 'string' },
      },
    },
    riskLevel: 'high',
    needsApproval: true,
    allowedModes: ['askBeforeWrite'],
  },
  {
    name: 'browser.scroll',
    description: 'Scroll the internal browser after approval.',
    inputSchema: {
      type: 'object',
      properties: { deltaY: { type: 'number' } },
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
