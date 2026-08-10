import React, { useEffect, useMemo, useState } from 'react';
import type { AgentInputAttachmentV2, FileTreeNode } from '@deepcode/protocol';
import { getFileTree } from '../../services/runtimeAdapter';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { t, type UiLanguage } from '../../i18n';

interface PickerItem {
  kind: AgentInputAttachmentV2['kind'];
  path: string;
  name: string;
  folderId: string;
}

interface ContextAttachmentPickerProps {
  query: string;
  language: UiLanguage;
  onPick: (attachment: AgentInputAttachmentV2) => void;
  onError?: (message: string) => void;
}

function normalizeWorkspaceRelativePath(path: string): string | null {
  if (
    path.trim() !== path
    || new TextEncoder().encode(path).byteLength > 4096
    || /[\u0000-\u001f\u007f-\u009f]/u.test(path)
  ) {
    return null;
  }
  const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (
    !normalized.trim()
    || normalized.startsWith('/')
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.includes('\0')
  ) {
    return null;
  }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function flatten(
  nodes: FileTreeNode[],
  folderId: string,
  acc: PickerItem[] = []
): PickerItem[] | null {
  for (const node of nodes) {
    const path = normalizeWorkspaceRelativePath(node.path);
    if (!path) return null;
    acc.push({
      kind: node.type,
      path,
      name: node.name,
      folderId,
    });
    if (node.children && !flatten(node.children, folderId, acc)) return null;
  }
  return acc;
}

const ContextAttachmentPicker: React.FC<ContextAttachmentPickerProps> = ({
  query,
  language,
  onPick,
  onError,
}) => {
  const activeFolderId = useWorkspaceStore((state) => state.activeFolderId);
  const workspace = useWorkspaceStore((state) => state.current);
  const [items, setItems] = useState<PickerItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const folderId = activeFolderId ?? workspace?.folders[0]?.id;
    if (!folderId || !workspace?.folders.some((folder) => folder.id === folderId)) {
      setItems([]);
      return;
    }
    let disposed = false;
    setLoading(true);
    void getFileTree(folderId).then((result) => {
      if (disposed) return;
      setLoading(false);
      if (!result.ok || !result.data) {
        setItems([]);
        onError?.(result.message ?? t(language, 'agent.attachment.loadFailed'));
        return;
      }
      const flattened = flatten(result.data, folderId);
      if (!flattened) {
        setItems([]);
        onError?.(t(language, 'agent.attachment.invalidWorkspacePath'));
        return;
      }
      setItems(flattened);
    });
    return () => {
      disposed = true;
    };
  }, [activeFolderId, language, onError, workspace]);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return items
      .filter((item) => (
        !normalizedQuery
        || item.path.toLowerCase().includes(normalizedQuery)
        || item.name.toLowerCase().includes(normalizedQuery)
      ))
      .slice(0, 40);
  }, [items, query]);

  return (
    <div className="agent-attachment-picker">
      {filtered.map((item) => (
        <button
          key={`${item.folderId}:${item.path}`}
          type="button"
          onMouseDown={(event) => {
            event.preventDefault();
            const currentActiveFolderId = activeFolderId ?? workspace?.folders[0]?.id;
            const folderStillBound = workspace?.folders.some((folder) => folder.id === item.folderId);
            const path = normalizeWorkspaceRelativePath(item.path);
            if (!folderStillBound || item.folderId !== currentActiveFolderId || !path) {
              onError?.(t(language, 'agent.attachment.invalidWorkspacePath'));
              return;
            }
            onPick({
              kind: item.kind,
              path,
              folderId: item.folderId,
              scope: 'message',
            });
          }}
        >
          <span>
            {item.kind === 'directory'
              ? t(language, 'agent.attachment.folder')
              : t(language, 'agent.attachment.file')}
          </span>
          <strong>{item.path}</strong>
        </button>
      ))}
      {loading && (
        <div className="agent-attachment-picker__empty">
          {t(language, 'agent.attachment.loading')}
        </div>
      )}
      {!loading && filtered.length === 0 && (
        <div className="agent-attachment-picker__empty">
          {t(language, 'agent.attachment.noMatches')}
        </div>
      )}
    </div>
  );
};

export default ContextAttachmentPicker;
