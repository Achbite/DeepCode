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
  ShellExecInput,
  ShellProposeInput,
  ToolCall,
  ToolExecutionRequest,
  ToolResult,
} from '@deepcode/protocol';
import { PermissionGate, ToolRegistry } from '@deepcode/agent-core';
import { searchCode } from '../../services/codeSearchService.js';
import {
  readDirectoryTree,
  readFileContent,
  writeFileContent,
} from '../../services/fileService.js';
import { executeAgentShellCommand } from '../terminal/agentShellRuntime.js';
import { getUserSettings } from '../../services/userSettingsService.js';

const registry = new ToolRegistry();
const permissionGate = new PermissionGate(registry, { diffProvider: diffForToolCall });

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

function optionalNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function boolSetting(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === 'boolean' ? value : fallback;
}

function blacklistFragments(settings: Record<string, unknown>): string[] {
  const raw = settings['agent.shell.commandBlacklist'];
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function commandArgument(toolCall: ToolCall): string {
  return isRecord(toolCall.arguments) && typeof toolCall.arguments.command === 'string'
    ? toolCall.arguments.command
    : '';
}

async function agentPolicyDenyReason(toolCall: ToolCall): Promise<string | undefined> {
  const { settings } = await getUserSettings();

  switch (toolCall.name) {
    case 'fs.read':
    case 'fs.list':
    case 'fs.diff':
      if (!boolSetting(settings, 'agent.permissions.allowFileRead', true)) {
        return 'Agent file read tools are disabled in Settings.';
      }
      break;
    case 'fs.write':
      if (!boolSetting(settings, 'agent.permissions.allowFileWrite', true)) {
        return 'Agent file write tools are disabled in Settings.';
      }
      break;
    case 'code.search':
      if (!boolSetting(settings, 'agent.permissions.allowCodeSearch', true)) {
        return 'Agent code search is disabled in Settings.';
      }
      break;
    case 'shell.propose':
      if (!boolSetting(settings, 'agent.permissions.allowShellPropose', true)) {
        return 'Agent shell command proposals are disabled in Settings.';
      }
      break;
    case 'shell.exec': {
      if (!boolSetting(settings, 'agent.permissions.allowShellExec', true)) {
        return 'Agent shell execution requests are disabled in Settings.';
      }
      break;
    }
    default:
      break;
  }

  return undefined;
}

async function shellExecAutoDecision(
  request: PermissionEvaluationRequest
): Promise<PermissionDecision | undefined> {
  if (request.toolCall.name !== 'shell.exec') return undefined;

  const { settings } = await getUserSettings();
  const command = commandArgument(request.toolCall).toLowerCase();
  const blocked = blacklistFragments(settings).find((fragment) =>
    command.includes(fragment)
  );

  if (blocked) {
    const decision = await permissionGate.evaluate(request);
    return decision.action === 'ask' && decision.request
      ? {
          ...decision,
          reason: `Command matches manual approval blacklist: ${blocked}`,
          request: {
            ...decision.request,
            summary: `Command matches blacklist (${blocked}). Confirm before running in Agent temporary shell.`,
          },
        }
      : decision;
  }

  if (boolSetting(settings, 'agent.shell.autoExecuteCommands', false)) {
    return {
      action: 'allow',
      reason: 'Shell execution is allowed by Agent settings.',
    };
  }

  return undefined;
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

function success(callId: string, output: unknown): ToolResult {
  return { callId, ok: true, output };
}

function humanizeToolError(error: string): string {
  if (error.startsWith('no_workspace:')) {
    return '当前没有打开工作区。请先在 Explorer 中打开一个文件夹或 .code-workspace 文件，然后再读取、搜索或修改文件。';
  }
  return error;
}

function failure(callId: string, error: string): ToolResult {
  return { callId, ok: false, error: humanizeToolError(error) };
}

export function listAgentTools(mode?: AgentMode): ListToolsResult {
  return {
    tools: registry.list(mode),
  };
}

export async function evaluateAgentPermission(
  request: PermissionEvaluationRequest
): Promise<PermissionDecision> {
  const policyDenyReason = await agentPolicyDenyReason(request.toolCall);
  if (policyDenyReason) {
    return {
      action: 'deny',
      reason: policyDenyReason,
    };
  }
  const shellDecision = await shellExecAutoDecision(request);
  if (shellDecision) return shellDecision;
  return permissionGate.evaluate(request);
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
      case 'shell.exec': {
        const input: ShellExecInput = {
          command: stringArg(args, 'command'),
          cwd: optionalStringArg(args, 'cwd'),
          timeoutMs: optionalNumberArg(args, 'timeoutMs'),
          reason: optionalStringArg(args, 'reason'),
        };
        return success(request.toolCall.id, await executeAgentShellCommand(input));
      }
      default:
        return failure(request.toolCall.id, `Unsupported tool: ${request.toolCall.name}`);
    }
  } catch (err) {
    return failure(request.toolCall.id, err instanceof Error ? err.message : String(err));
  }
}

export { permissionGate };
