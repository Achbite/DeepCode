import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentInputAttachmentV2, FileTreeNode } from '@deepcode/protocol';
import { getFileTree } from '../../services/runtimeAdapter';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { t, type UiLanguage } from '../../i18n';
import '../workspace-open-dialog/workspaceOpenDialog.css';

interface UserAttachmentDialogProps {
  visible: boolean;
  language: UiLanguage;
  onClose: () => void;
  onPick: (attachment: AgentInputAttachmentV2) => void;
}

interface AttachmentEntry {
  kind: AgentInputAttachmentV2['kind'];
  path: string;
  name: string;
}

function normalizeWorkspaceRelativePath(
  path: string,
  allowWorkspaceRoot = false
): string | null {
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
  if (parts.length > 0) return parts.join('/');
  return allowWorkspaceRoot ? '.' : null;
}

function flattenNodes(
  nodes: FileTreeNode[],
  acc: AttachmentEntry[] = []
): AttachmentEntry[] | null {
  for (const node of nodes) {
    const path = normalizeWorkspaceRelativePath(node.path);
    if (!path) return null;
    acc.push({
      kind: node.type,
      path,
      name: node.name,
    });
    if (node.children && !flattenNodes(node.children, acc)) return null;
  }
  return acc;
}

function parentPath(path: string): string {
  const normalized = normalizeWorkspaceRelativePath(path, true);
  if (!normalized || normalized === '.') return '.';
  const segments = normalized.split('/');
  segments.pop();
  return segments.join('/') || '.';
}

const UserAttachmentDialog: React.FC<UserAttachmentDialogProps> = ({
  visible,
  language,
  onClose,
  onPick,
}) => {
  const workspace = useWorkspaceStore((state) => state.current);
  const activeFolderId = useWorkspaceStore((state) => state.activeFolderId);
  const [folderId, setFolderId] = useState('');
  const [directory, setDirectory] = useState('.');
  const [entries, setEntries] = useState<AttachmentEntry[]>([]);
  const [selected, setSelected] = useState<AttachmentEntry | null>(null);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<AgentInputAttachmentV2['scope']>('message');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);

  const loadDirectory = async (nextFolderId: string, nextDirectory: string): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    const boundFolder = workspace?.folders.find((folder) => folder.id === nextFolderId);
    const safeDirectory = normalizeWorkspaceRelativePath(nextDirectory, true);
    if (!boundFolder || !safeDirectory) {
      setError(t(language, 'agent.attachment.invalidWorkspacePath'));
      return;
    }
    setLoading(true);
    setError(null);
    setSelected(null);
    const result = await getFileTree(nextFolderId, safeDirectory);
    if (loadGenerationRef.current !== generation) return;
    if (!result.ok || !result.data) {
      setEntries([]);
      setError(result.message ?? t(language, 'agent.attachment.loadFailed'));
      setLoading(false);
      return;
    }
    const nextEntries = flattenNodes(result.data);
    if (!nextEntries) {
      setEntries([]);
      setError(t(language, 'agent.attachment.invalidWorkspacePath'));
      setLoading(false);
      return;
    }
    setFolderId(nextFolderId);
    setDirectory(safeDirectory);
    setEntries(nextEntries);
    setLoading(false);
  };

  useEffect(() => {
    if (!visible) {
      loadGenerationRef.current += 1;
      setSelected(null);
      setEntries([]);
      setQuery('');
      setError(null);
      setDirectory('.');
      return;
    }
    const initialFolderId = (
      activeFolderId && workspace?.folders.some((folder) => folder.id === activeFolderId)
    )
      ? activeFolderId
      : workspace?.folders[0]?.id;
    if (!initialFolderId) {
      setError(t(language, 'agent.attachment.noWorkspace'));
      return;
    }
    void loadDirectory(initialFolderId, '.');
    return () => {
      loadGenerationRef.current += 1;
    };
  }, [activeFolderId, language, visible, workspace]);

  useEffect(() => {
    if (!visible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, visible]);

  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return entries;
    return entries.filter((entry) => (
      entry.name.toLowerCase().includes(normalizedQuery)
      || entry.path.toLowerCase().includes(normalizedQuery)
    ));
  }, [entries, query]);

  const pick = () => {
    const boundFolder = workspace?.folders.find((folder) => folder.id === folderId);
    const candidate = selected ?? {
      kind: 'directory' as const,
      path: directory,
      name: directory,
    };
    const path = normalizeWorkspaceRelativePath(candidate.path);
    if (!boundFolder || !path) {
      setError(t(language, 'agent.attachment.invalidWorkspacePath'));
      return;
    }
    onPick({
      kind: candidate.kind,
      path,
      folderId: boundFolder.id,
      scope,
    });
    onClose();
  };

  if (!visible) return null;

  return (
    <div className="ws-open-dialog__backdrop" onClick={onClose}>
      <div
        className="ws-open-dialog agent-attachment-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t(language, 'agent.attachmentDialog.title')}
      >
        <div className="ws-open-dialog__header">
          <span>{t(language, 'agent.attachmentDialog.title')}</span>
          <button
            className="ws-open-dialog__close"
            onClick={onClose}
            title={t(language, 'window.close')}
            type="button"
          >
            ×
          </button>
        </div>

        <div className="ws-open-dialog__addressbar agent-attachment-dialog__controls">
          <span
            className="agent-attachment-dialog__workspace-folder"
            title={t(language, 'agent.attachmentDialog.workspaceFolder')}
          >
            {workspace?.folders.find((folder) => folder.id === folderId)?.name
              ?? t(language, 'agent.attachment.noWorkspace')}
          </span>
          <button
            className="ws-open-dialog__btn"
            type="button"
            disabled={directory === '.'}
            onClick={() => void loadDirectory(folderId, parentPath(directory))}
          >
            {t(language, 'workspaceDialog.up')}
          </button>
          <span className="agent-attachment-dialog__relative-path" title={directory}>
            {directory}
          </span>
          <input
            className="ws-open-dialog__address"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(language, 'agent.attachmentDialog.search')}
          />
        </div>

        <main className="ws-open-dialog__main agent-attachment-dialog__main">
          {loading && (
            <div className="ws-open-dialog__placeholder">
              {t(language, 'agent.attachment.loading')}
            </div>
          )}
          {error && <div className="ws-open-dialog__error">{error}</div>}
          {!loading && !error && visibleEntries.length === 0 && (
            <div className="ws-open-dialog__placeholder">
              {t(language, 'agent.attachment.noMatches')}
            </div>
          )}
          {!loading && !error && visibleEntries.length > 0 && (
            <ul className="ws-open-dialog__entries">
              {visibleEntries.map((entry) => {
                const isSelected = selected?.kind === entry.kind && selected.path === entry.path;
                return (
                  <li
                    key={`${entry.kind}:${entry.path}`}
                    className={`ws-open-dialog__entry${isSelected ? ' ws-open-dialog__entry--selected' : ''}`}
                    onClick={() => setSelected(entry)}
                    onDoubleClick={() => {
                      if (entry.kind === 'directory') {
                        void loadDirectory(folderId, entry.path);
                        return;
                      }
                      setSelected(entry);
                    }}
                    title={entry.path}
                  >
                    <span className="ws-open-dialog__entry-icon">
                      {entry.kind === 'directory' ? 'DIR' : 'FILE'}
                    </span>
                    <span className="ws-open-dialog__entry-name">{entry.path}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info agent-attachment-dialog__scope">
            <label>
              <input
                type="radio"
                name="attachment-scope"
                value="message"
                checked={scope === 'message'}
                onChange={() => setScope('message')}
              />
              {t(language, 'agent.attachmentDialog.messageScope')}
            </label>
            <label>
              <input
                type="radio"
                name="attachment-scope"
                value="session"
                checked={scope === 'session'}
                onChange={() => setScope('session')}
              />
              {t(language, 'agent.attachmentDialog.sessionScope')}
            </label>
          </div>
          <div className="ws-open-dialog__footer-actions">
            <button className="ws-open-dialog__btn" onClick={onClose} type="button">
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={loading || !folderId || (!selected && directory === '.')}
              onClick={pick}
              type="button"
            >
              {selected
                ? t(language, 'agent.attachmentDialog.addSelected')
                : t(language, 'agent.attachmentDialog.addCurrentFolder')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UserAttachmentDialog;
