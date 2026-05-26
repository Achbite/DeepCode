import React, { useEffect, useMemo, useState } from 'react';
import type { AgentContextAttachment, FileTreeNode } from '@deepcode/protocol';
import { getFileTree } from '../../services/runtimeAdapter';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { t, type UiLanguage } from '../../i18n';

interface PickerItem {
  kind: 'file' | 'directory';
  path: string;
  name: string;
  folderId: string;
}

interface ContextAttachmentPickerProps {
  query: string;
  language: UiLanguage;
  onPick: (attachment: AgentContextAttachment) => void;
}

function flatten(
  nodes: FileTreeNode[],
  folderId: string,
  acc: PickerItem[] = []
): PickerItem[] {
  for (const node of nodes) {
    acc.push({
      kind: node.type,
      path: node.path,
      name: node.name,
      folderId,
    });
    if (node.children) flatten(node.children, folderId, acc);
  }
  return acc;
}

const ContextAttachmentPicker: React.FC<ContextAttachmentPickerProps> = ({
  query,
  language,
  onPick,
}) => {
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const [items, setItems] = useState<PickerItem[]>([]);

  useEffect(() => {
    if (!activeFolderId) {
      setItems([]);
      return;
    }
    let disposed = false;
    getFileTree(activeFolderId).then((result) => {
      if (disposed) return;
      setItems(result.ok && result.data ? flatten(result.data, activeFolderId) : []);
    });
    return () => {
      disposed = true;
    };
  }, [activeFolderId]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return items
      .filter((item) => item.path.toLowerCase().includes(q))
      .slice(0, 40);
  }, [items, query]);

  return (
    <div className="agent-attachment-picker">
      {filtered.map((item) => (
        <button
          key={`${item.folderId}:${item.path}`}
          onMouseDown={(event) => {
            event.preventDefault();
            onPick({
              kind: item.kind,
              path: item.path,
              folderId: item.folderId,
              source: 'mention',
              scope: 'message',
            });
          }}
        >
          <span>{item.kind === 'directory'
            ? t(language, 'agent.attachment.folder')
            : t(language, 'agent.attachment.file')}
          </span>
          <strong>{item.path}</strong>
        </button>
      ))}
      {filtered.length === 0 && (
        <div className="agent-attachment-picker__empty">
          {t(language, 'agent.attachment.noMatches')}
        </div>
      )}
    </div>
  );
};

export default ContextAttachmentPicker;
