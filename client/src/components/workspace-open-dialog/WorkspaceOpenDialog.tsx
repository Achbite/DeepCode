import React, { useEffect, useMemo, useState } from 'react';
import {
  browsePath,
  getInitialLocations,
  getRuntimeType,
  pickWorkspacePath,
} from '../../services/runtimeAdapter';
import type {
  BrowseEntry,
  BrowsePathResult,
  InitialLocation,
} from '@deepcode/protocol';
import { useUiStore } from '../../state/uiStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useEditorStore } from '../../state/editorStore';
import './workspaceOpenDialog.css';

const WorkspaceOpenDialog: React.FC = () => {
  const visible = useUiStore((s) => s.workspaceOpenDialogVisible);
  const hide = useUiStore((s) => s.hideWorkspaceOpenDialog);
  const openWorkspace = useWorkspaceStore((s) => s.openWorkspace);
  const closeAllFileTabs = useEditorStore((s) => s.closeAllFileTabs);

  const [locations, setLocations] = useState<InitialLocation[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowsePathResult | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<BrowseEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    const result = await browsePath(absolutePath);
    if (result.ok && result.data) {
      setBrowseResult(result.data);
      setAddressInput(result.data.absolutePath);
    } else {
      setError(result.message ?? '浏览目录失败');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!visible) {
      setBrowseResult(null);
      setSelectedEntry(null);
      setError(null);
      setAddressInput('');
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      const init = await getInitialLocations();
      if (cancelled) return;
      if (init.ok && init.data) {
        setLocations(init.data.locations);
        const first = init.data.locations[0];
        if (first) {
          await navigateTo(first.absolutePath);
        } else {
          setLoading(false);
        }
      } else {
        setError(init.message ?? '加载初始位置失败');
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, hide]);

  const visibleEntries = useMemo<BrowseEntry[]>(() => {
    if (!browseResult) return [];
    return showHidden
      ? browseResult.entries
      : browseResult.entries.filter((entry) => !entry.hidden);
  }, [browseResult, showHidden]);

  const handleEntryDoubleClick = (entry: BrowseEntry) => {
    if (entry.type === 'directory') {
      void navigateTo(entry.absolutePath);
      return;
    }
    if (entry.isCodeWorkspace) {
      void handleOpenWorkspaceFile(entry);
    }
  };

  const handleOpenFolder = async () => {
    if (!browseResult) return;
    const targetPath =
      selectedEntry?.type === 'directory'
        ? selectedEntry.absolutePath
        : browseResult.absolutePath;

    closeAllFileTabs();
    const result = await openWorkspace(targetPath);
    if (result.ok) {
      hide();
      return;
    }
    setError(`打开文件夹失败: ${result.message}`);
  };

  const handleOpenWorkspaceFile = async (entry: BrowseEntry) => {
    if (!entry.isCodeWorkspace) return;
    closeAllFileTabs();
    const result = await openWorkspace(entry.absolutePath);
    if (result.ok) {
      hide();
      return;
    }
    setError(`打开工作区文件失败: ${result.message}`);
  };

  const handleNativeOpenFolder = async () => {
    const result = await pickWorkspacePath();
    if (!result.ok || !result.data) {
      if (result.error !== 'user_cancelled') {
        setError(result.message ?? '系统目录选择失败');
      }
      return;
    }
    closeAllFileTabs();
    const wsResult = await openWorkspace(result.data);
    if (wsResult.ok) {
      hide();
      return;
    }
    setError(`打开文件夹失败: ${wsResult.message}`);
  };

  const handleAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && addressInput.trim() !== '') {
      void navigateTo(addressInput.trim());
    }
  };

  if (!visible) return null;

  const canOpenWorkspaceFile = selectedEntry?.type === 'file' && selectedEntry.isCodeWorkspace;
  const selectedPath = selectedEntry?.absolutePath ?? browseResult?.absolutePath ?? '';
  const folderButtonLabel = selectedEntry?.type === 'directory'
    ? 'Open Selected Folder'
    : 'Open Current Folder';

  return (
    <div className="ws-open-dialog__backdrop" onClick={hide}>
      <div
        className="ws-open-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Open Workspace"
      >
        <div className="ws-open-dialog__header">
          <span>Open Workspace</span>
          <button
            className="ws-open-dialog__close"
            onClick={hide}
            title="Close"
            type="button"
          >
            x
          </button>
        </div>

        <div className="ws-open-dialog__addressbar">
          <button
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && void navigateTo(browseResult.parentPath)}
            title="Go to parent folder"
            type="button"
          >
            Up
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            placeholder="输入或粘贴绝对路径，按 Enter 跳转"
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={handleAddressKeyDown}
          />
          <button
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && void navigateTo(addressInput.trim())}
            type="button"
          >
            Go
          </button>
          {getRuntimeType() === 'tauri' && (
            <button
              className="ws-open-dialog__btn"
              onClick={() => void handleNativeOpenFolder()}
              title="使用系统目录选择器打开文件夹"
              type="button"
            >
              System Folder
            </button>
          )}
          <label className="ws-open-dialog__toggle" title="显示以 . 开头的隐藏项">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            <span>Hidden</span>
          </label>
        </div>

        <div className="ws-open-dialog__body">
          <aside className="ws-open-dialog__sidebar">
            <div className="ws-open-dialog__sidebar-title">Quick Locations</div>
            {locations.map((location) => (
              <button
                key={`${location.kind}::${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
                type="button"
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {location.kind === 'home' ? 'HOME' : location.kind === 'drive' ? 'DISK' : 'WS'}
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>

          <main className="ws-open-dialog__main">
            {loading && <div className="ws-open-dialog__placeholder">加载中...</div>}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="ws-open-dialog__placeholder">空目录</div>
            )}
            {!loading && !error && visibleEntries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {visibleEntries.map((entry) => {
                  const isSelected = selectedEntry?.absolutePath === entry.absolutePath;
                  return (
                    <li
                      key={entry.absolutePath}
                      className={
                        'ws-open-dialog__entry' +
                        (isSelected ? ' ws-open-dialog__entry--selected' : '') +
                        (entry.isCodeWorkspace ? ' ws-open-dialog__entry--code-workspace' : '')
                      }
                      onClick={() => setSelectedEntry(entry)}
                      onDoubleClick={() => handleEntryDoubleClick(entry)}
                      title={entry.absolutePath}
                    >
                      <span className="ws-open-dialog__entry-icon">
                        {entry.type === 'directory'
                          ? 'DIR'
                          : entry.isCodeWorkspace
                            ? 'WS'
                            : 'FILE'}
                      </span>
                      <span className="ws-open-dialog__entry-name">{entry.name}</span>
                      {entry.isCodeWorkspace && (
                        <span className="ws-open-dialog__entry-tag">workspace</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </main>
        </div>

        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info">
            {selectedPath && (
              <span>
                Selected: <strong>{selectedPath}</strong>
              </span>
            )}
          </div>
          <div className="ws-open-dialog__footer-actions">
            <button className="ws-open-dialog__btn" onClick={hide} type="button">
              Cancel
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--secondary"
              disabled={!canOpenWorkspaceFile}
              onClick={() => selectedEntry && void handleOpenWorkspaceFile(selectedEntry)}
              title="打开选中的 .code-workspace 文件"
              type="button"
            >
              Open Workspace File
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!browseResult}
              onClick={() => void handleOpenFolder()}
              title="打开选中的文件夹；未选中文件夹时打开当前目录"
              type="button"
            >
              {folderButtonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceOpenDialog;
