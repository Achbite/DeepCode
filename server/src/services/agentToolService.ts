import type {
  AgentMode,
  CodeSearchInput,
  FsDiffInput,
  FsListInput,
  FsReadInput,
  FsWriteInput,
  ListToolsResult,
  PermissionDecision,
  PermissionEvaluationRequest,
  ShellProposeInput,
  ToolCall,
  ToolDefinition,
  ToolExecutionRequest,
  ToolResult,
} from '@deepcode/protocol';
import { searchCode } from './codeSearchService.js';
import {
  readDirectoryTree,
  readFileContent,
  writeFileContent,
} from './fileService.js';

const TOOL_DEFINITIONS: ToolDefinition[] = [
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

function findTool(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing string argument: ${key}`);
  }
  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function buildLightweightDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) {
    return `--- ${path}\n+++ ${path}\n(no changes)`;
  }

  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const max = Math.max(oldLines.length, newLines.length);
  const lines: string[] = [`--- ${path}`, `+++ ${path}`];
  let emitted = 0;

  for (let index = 0; index < max; index += 1) {
    const before = oldLines[index] ?? '';
    const after = newLines[index] ?? '';
    if (before === after) continue;
    lines.push(`@@ line ${index + 1} @@`);
    if (index < oldLines.length) lines.push(`-${before}`);
    if (index < newLines.length) lines.push(`+${after}`);
    emitted += 1;
    if (emitted >= 80) {
      lines.push('... diff truncated after 80 changed lines ...');
      break;
    }
  }

  return lines.join('\n');
}

async function diffForToolCall(toolCall: ToolCall): Promise<string | undefined> {
  if (toolCall.name !== 'fs.write') return undefined;
  if (!isRecord(toolCall.arguments)) return undefined;
  const args = toolCall.arguments;
  const path = stringArg(args, 'path');
  const folderId = optionalStringArg(args, 'folderId');
  const nextContent = stringArg(args, 'content');

  let currentContent = '';
  try {
    const current = await readFileContent(folderId, path);
    currentContent = current.content;
  } catch {
    currentContent = '';
  }

  return buildLightweightDiff(path, currentContent, nextContent);
}

export function listAgentTools(mode?: AgentMode): ListToolsResult {
  return {
    tools: mode
      ? TOOL_DEFINITIONS.filter((tool) => tool.allowedModes.includes(mode))
      : TOOL_DEFINITIONS,
  };
}

export async function evaluateAgentPermission(
  request: PermissionEvaluationRequest
): Promise<PermissionDecision> {
  const tool = findTool(request.toolCall.name);
  if (!tool) {
    return {
      action: 'deny',
      reason: `Unknown tool: ${request.toolCall.name}`,
    };
  }

  if (!tool.allowedModes.includes(request.mode)) {
    return {
      action: 'deny',
      reason: `${tool.name} is not allowed in ${request.mode} mode.`,
    };
  }

  if (!tool.needsApproval) {
    return {
      action: 'allow',
      reason: `${tool.name} is allowed in ${request.mode} mode.`,
    };
  }

  const diff = await diffForToolCall(request.toolCall);
  return {
    action: 'ask',
    reason: `${tool.name} requires explicit approval before execution.`,
    request: {
      id: `perm-${request.toolCall.id}`,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      summary: `Allow ${tool.name} to modify workspace files?`,
      diff,
      argumentsPreview: request.toolCall.arguments,
    },
  };
}

function success(callId: string, output: unknown): ToolResult {
  return { callId, ok: true, output };
}

function failure(callId: string, error: string): ToolResult {
  return { callId, ok: false, error };
}

export async function executeAgentTool(
  request: ToolExecutionRequest
): Promise<ToolResult> {
  const decision = await evaluateAgentPermission({
    mode: request.mode,
    toolCall: request.toolCall,
  });

  if (decision.action === 'deny') {
    return failure(request.toolCall.id, decision.reason);
  }
  if (decision.action === 'ask' && request.approved !== true) {
    return failure(request.toolCall.id, 'approval_required');
  }

  try {
    if (!isRecord(request.toolCall.arguments)) {
      throw new Error('Tool arguments must be an object.');
    }
    const args = request.toolCall.arguments;

    switch (request.toolCall.name) {
      case 'fs.read': {
        const input: FsReadInput = {
          path: stringArg(args, 'path'),
          folderId: optionalStringArg(args, 'folderId'),
        };
        return success(
          request.toolCall.id,
          await readFileContent(input.folderId, input.path)
        );
      }
      case 'fs.list': {
        const depth = Number(args.depth ?? 2);
        const input: FsListInput = {
          path: optionalStringArg(args, 'path') ?? '',
          folderId: optionalStringArg(args, 'folderId'),
          depth: Number.isFinite(depth) ? depth : 2,
        };
        return success(
          request.toolCall.id,
          await readDirectoryTree(input.folderId, input.path, input.depth)
        );
      }
      case 'fs.diff': {
        const input: FsDiffInput = {
          path: stringArg(args, 'path'),
          folderId: optionalStringArg(args, 'folderId'),
          newContent: stringArg(args, 'newContent'),
        };
        let currentContent = '';
        try {
          const current = await readFileContent(input.folderId, input.path);
          currentContent = current.content;
        } catch {
          currentContent = '';
        }
        return success(
          request.toolCall.id,
          buildLightweightDiff(input.path, currentContent, input.newContent)
        );
      }
      case 'fs.write': {
        const input: FsWriteInput = {
          path: stringArg(args, 'path'),
          folderId: optionalStringArg(args, 'folderId'),
          content: stringArg(args, 'content'),
        };
        return success(
          request.toolCall.id,
          await writeFileContent(input.folderId, input.path, input.content)
        );
      }
      case 'code.search': {
        const includeRaw = args.include;
        const input: CodeSearchInput = {
          query: stringArg(args, 'query'),
          isRegex: Boolean(args.isRegex),
          folderId: optionalStringArg(args, 'folderId'),
          include: Array.isArray(includeRaw)
            ? includeRaw.filter((item): item is string => typeof item === 'string')
            : undefined,
        };
        return success(request.toolCall.id, await searchCode(input));
      }
      case 'shell.propose': {
        const input: ShellProposeInput = {
          command: stringArg(args, 'command'),
          reason: optionalStringArg(args, 'reason'),
        };
        return success(request.toolCall.id, {
          ...input,
          dryRun: true,
          executed: false,
        });
      }
      default:
        return failure(request.toolCall.id, `Unsupported tool: ${request.toolCall.name}`);
    }
  } catch (err) {
    return failure(request.toolCall.id, err instanceof Error ? err.message : String(err));
  }
}
