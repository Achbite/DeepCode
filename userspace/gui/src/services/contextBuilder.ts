import type { AgentContextAttachment, AgentContextSnapshot } from '@deepcode/protocol';
import { getFileTree, readFile } from './runtimeAdapter';
import { useEditorStore } from '../state/editorStore';
import { useWorkspaceStore } from '../state/workspaceStore';

const MAX_CONTEXT_CHARS = 40000;
const MAX_FILE_CHARS = 12000;
const MAX_TREE_ENTRIES = 300;

function dedupeAttachments(
  attachments: AgentContextAttachment[]
): AgentContextAttachment[] {
  const byKey = new Map<string, AgentContextAttachment>();
  for (const attachment of attachments) {
    const key = `${attachment.folderId ?? ''}:${attachment.path}`;
    const existing = byKey.get(key);
    if (!existing || attachment.scope === 'session') {
      byKey.set(key, attachment);
    }
  }
  return [...byKey.values()];
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = text.slice(0, Math.floor(max * 0.65));
  const tail = text.slice(text.length - Math.floor(max * 0.25));
  return {
    text: `${head}\n\n[... truncated ...]\n\n${tail}`,
    truncated: true,
  };
}

function flattenTree(entries: any[], depth = 0, acc: string[] = []): string[] {
  if (acc.length >= MAX_TREE_ENTRIES) return acc;
  for (const entry of entries ?? []) {
    if (acc.length >= MAX_TREE_ENTRIES) break;
    acc.push(`${'  '.repeat(depth)}- ${entry.type === 'directory' ? '[dir]' : '[file]'} ${entry.path}`);
    if (entry.type === 'directory' && entry.children) {
      flattenTree(entry.children, depth + 1, acc);
    }
  }
  return acc;
}

export async function buildAgentContextSnapshot(
  attachments: AgentContextAttachment[]
): Promise<AgentContextSnapshot> {
  const activeFile = useEditorStore.getState().getActiveFile();
  const activeFolder = useWorkspaceStore.getState().getActiveFolder();
  const parts: string[] = [];
  let truncated = false;

  const normalized = dedupeAttachments(attachments);
  if (normalized.length > 0) {
    parts.push('## 强绑定上下文');
  }

  for (const attachment of normalized) {
    if (attachment.kind === 'file') {
      const result = await readFile(attachment.path, attachment.folderId);
      if (result.ok && result.data) {
        const clipped = clip(result.data.content, MAX_FILE_CHARS);
        truncated = truncated || clipped.truncated;
        parts.push(
          `### file:${result.data.path}\n` +
          `folderId: ${result.data.folderId}\n` +
          '```text\n' +
          clipped.text +
          '\n```'
        );
      } else {
        parts.push(`### file:${attachment.path}\n读取失败: ${result.message}`);
      }
      continue;
    }

    const result = await getFileTree(attachment.folderId, attachment.path);
    if (result.ok && result.data) {
      const lines = flattenTree(result.data);
      if (lines.length >= MAX_TREE_ENTRIES) truncated = true;
      parts.push(
        `### directory:${attachment.path || '.'}\n` +
        `folderId: ${attachment.folderId ?? activeFolder?.id ?? ''}\n` +
        '```text\n' +
        lines.join('\n') +
        '\n```'
      );
    } else {
      parts.push(`### directory:${attachment.path}\n读取失败: ${result.message}`);
    }
  }

  if (activeFile) {
    const clipped = clip(activeFile.content, 8000);
    truncated = truncated || clipped.truncated;
    parts.push(
      `## 当前打开文件\n### file:${activeFile.path}\n` +
      '```text\n' +
      clipped.text +
      '\n```'
    );
  }

  if (activeFolder) {
    parts.push(
      `## 当前 workspace folder\n${activeFolder.name} (${activeFolder.id}) -> ${activeFolder.absolutePath}`
    );
  }

  const joined = parts.join('\n\n');
  const clippedAll = clip(joined, MAX_CONTEXT_CHARS);
  return {
    attachments: normalized,
    promptText: clippedAll.text,
    truncated: truncated || clippedAll.truncated,
  };
}
