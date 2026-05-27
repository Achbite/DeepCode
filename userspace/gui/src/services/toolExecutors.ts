import type {
  CodeSearchInput,
  FsDiffInput,
  FsListInput,
  FsReadInput,
  FsWriteInput,
  ShellProposeInput,
  ToolCall,
  ToolResult,
} from '@deepcode/protocol';
import {
  codeSearch,
  getFileTree,
  readFile,
  writeFile,
} from './runtimeAdapter';

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function simpleDiff(path: string, oldText: string, newText: string): string {
  if (oldText === newText) return `--- ${path}\n+++ ${path}\n`;
  const oldLines = oldText.split(/\r?\n/);
  const newLines = newText.split(/\r?\n/);
  const body: string[] = [`--- ${path}`, `+++ ${path}`, '@@'];
  const max = Math.max(oldLines.length, newLines.length);
  for (let i = 0; i < max; i++) {
    if (oldLines[i] === newLines[i]) {
      body.push(` ${oldLines[i] ?? ''}`);
    } else {
      if (oldLines[i] !== undefined) body.push(`-${oldLines[i]}`);
      if (newLines[i] !== undefined) body.push(`+${newLines[i]}`);
    }
  }
  return body.join('\n');
}

export async function executeToolCall(toolCall: ToolCall): Promise<ToolResult> {
  try {
    const args = asRecord(toolCall.arguments);
    switch (toolCall.name) {
      case 'fs.read': {
        const input = args as unknown as FsReadInput;
        const result = await readFile(input.path, input.folderId);
        return result.ok
          ? { callId: toolCall.id, ok: true, output: result.data }
          : { callId: toolCall.id, ok: false, error: result.message };
      }
      case 'fs.write': {
        const input = args as unknown as FsWriteInput;
        const result = await writeFile(input.path, input.content, input.folderId);
        return result.ok
          ? { callId: toolCall.id, ok: true, output: result.data }
          : { callId: toolCall.id, ok: false, error: result.message };
      }
      case 'fs.list': {
        const input = args as unknown as FsListInput;
        const result = await getFileTree(input.folderId, input.path);
        return result.ok
          ? { callId: toolCall.id, ok: true, output: { entries: result.data } }
          : { callId: toolCall.id, ok: false, error: result.message };
      }
      case 'fs.diff': {
        const input = args as unknown as FsDiffInput;
        const current = await readFile(input.path, input.folderId);
        if (!current.ok || !current.data) {
          return { callId: toolCall.id, ok: false, error: current.message };
        }
        return {
          callId: toolCall.id,
          ok: true,
          output: {
            unifiedDiff: simpleDiff(input.path, current.data.content, input.newContent),
          },
        };
      }
      case 'code.search': {
        const result = await codeSearch(args as unknown as CodeSearchInput);
        return result.ok
          ? { callId: toolCall.id, ok: true, output: result.data }
          : { callId: toolCall.id, ok: false, error: result.message };
      }
      case 'shell.propose': {
        const input = args as unknown as ShellProposeInput;
        return {
          callId: toolCall.id,
          ok: true,
          output: { command: input.command, reason: input.reason, dryRun: true },
        };
      }
      default:
        return { callId: toolCall.id, ok: false, error: `未知工具: ${toolCall.name}` };
    }
  } catch (err) {
    return {
      callId: toolCall.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
