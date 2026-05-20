/**
 * WorkspaceOpenDialog —— "Open Workspace" 可视化对话框
 *
 * 行为参考 VSCode 的 "File ▸ Open Folder..." / "File ▸ Open Workspace from File..."：
 *   - 顶部地址栏显示当前浏览的绝对路径，可手动输入或点击 [Up] 回退
 *   - 左侧 Quick Locations 提供 Home / Drives / Current Workspace 快捷入口
 *   - 右侧列表展示当前目录下的子项；目录单击进入；.code-workspace 文件高亮
 *   - 底部三个动作：Cancel / Open as Folder（目录打开）/ Open File（仅 .code-workspace 时启用）
 *
 * 浏览器同源策略下无法直接拿到本地绝对路径，因此**列目录由 server 端完成**：
 *   - GET /api/fs/browse?path=<abs>
 *   - GET /api/fs/initial-locations
 * 用户最终选定的绝对路径再走 POST /api/workspaces/open 切换工作区。
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  browsePath,
  getInitialLocations,
  pickWorkspacePath,
  getRuntimeType,
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
  // 地址栏输入：未提交前与浏览结果分离，按 Enter 或点击 Go 才提交
  const [addressInput, setAddressInput] = useState('');
  // 用户在右侧列表中选中的条目（高亮 + Open File 启用条件）
  const [selectedEntry, setSelectedEntry] = useState<BrowseEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  // ---- 打开对话框时加载初始位置；关闭时清理状态 ----
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
        // 默认进入第一个起点（Home）；若失败由列表层报错
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

  // ---- 浏览到指定路径 ----
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

  // ---- 列表过滤：默认隐藏 . 开头的隐藏项 ----
  const visibleEntries = useMemo<BrowseEntry[]>(() => {
    if (!browseResult) return [];
    return showHidden
      ? browseResult.entries
      : browseResult.entries.filter((e) => !e.hidden);
  }, [browseResult, showHidden]);

  // ---- 双击 / 单击逻辑 ----
  const handleEntryClick = (entry: BrowseEntry) => {
    setSelectedEntry(entry);
  };
  const handleEntryDoubleClick = (entry: BrowseEntry) => {
    if (entry.type === 'directory') {
      navigateTo(entry.absolutePath);
    } else if (entry.isCodeWorkspace) {
      // 双击 .code-workspace 等价于 Open File
      handleOpenFile(entry);
    }
  };

  // ---- 打开当前目录作为 Folder ----
  const handleOpenFolder = async () => {
    if (!browseResult) return;
    closeAllFileTabs();
    const result = await openWorkspace(browseResult.absolutePath);
    if (result.ok) {
      hide();
    } else {
      setError(`打开工作区失败：${result.message}`);
    }
  };

  // ---- 打开 .code-workspace 文件 ----
  const handleOpenFile = async (entry: BrowseEntry) => {
    if (!entry.isCodeWorkspace) return;
    closeAllFileTabs();
    const result = await openWorkspace(entry.absolutePath);
    if (result.ok) {
      hide();
    } else {
      setError(`打开工作区失败：${result.message}`);
    }
  };

  // ---- 地址栏 Enter 提交 ----
  const handleAddressKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && addressInput.trim() !== '') {
      navigateTo(addressInput.trim());
    }
  };

  // ---- ESC 关闭 ----
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, hide]);

  if (!visible) return null;

  const canOpenFile = selectedEntry?.type === 'file' && selectedEntry.isCodeWorkspace;

  return (
    <div className="ws-open-dialog__backdrop" onClick={hide}>
      <div
        className="ws-open-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* ---- 标题栏 ---- */}
        <div className="ws-open-dialog__header">
          <span>Open Workspace</span>
          <button
            className="ws-open-dialog__close"
            onClick={hide}
            title="关闭 (Esc)"
          >
            ✕
          </button>
        </div>

        {/* ---- 地址栏 ---- */}
        <div className="ws-open-dialog__addressbar">
          <button
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && navigateTo(browseResult.parentPath)}
            title="上一级"
          >
            ↑ Up
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            placeholder="输入或粘贴绝对路径，按 Enter 跳转"
            onChange={(e) => setAddressInput(e.target.value)}
            onKeyDown={handleAddressKeyDown}
          />
          <button
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && navigateTo(addressInput.trim())}
          >
            Go
          </button>
          {getRuntimeType() === 'tauri' && (
            <button
              className="ws-open-dialog__btn"
              onClick={async () => {
                const result = await pickWorkspacePath();
                if (result.ok && result.data) {
                  closeAllFileTabs();
                  const wsResult = await openWorkspace(result.data);
                  if (wsResult.ok) {
                    hide();
                  } else {
                    setError(`打开工作区失败：${wsResult.message}`);
                  }
                }
              }}
              title="使用系统原生对话框选择目录"
            >
              📂 Native…
            </button>
          )}
          <label className="ws-open-dialog__toggle" title="显示以 . 开头的隐藏项">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            <span>显示隐藏项</span>
          </label>
        </div>

        {/* ---- 主体：左侧快捷入口 + 右侧列表 ---- */}
        <div className="ws-open-dialog__body">
          <aside className="ws-open-dialog__sidebar">
            <div className="ws-open-dialog__sidebar-title">Quick Locations</div>
            {locations.map((loc) => (
              <div
                key={`${loc.kind}::${loc.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => navigateTo(loc.absolutePath)}
                title={loc.absolutePath}
              >
                <span className="ws-open-dialog__sidebar-icon">
                  {loc.kind === 'home' ? '🏠' : loc.kind === 'drive' ? '💽' : '📂'}
                </span>
                <span>{loc.label}</span>
              </div>
            ))}
          </aside>

          <main className="ws-open-dialog__main">
            {loading && <div className="ws-open-dialog__placeholder">加载中…</div>}
            {error && (
              <div className="ws-open-dialog__error">{error}</div>
            )}
            {!loading && !error && visibleEntries.length === 0 && (
              <div className="ws-open-dialog__placeholder">（空目录）</div>
            )}
            {!loading && !error && visibleEntries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {visibleEntries.map((entry) => {
                  const isSelected =
                    selectedEntry?.absolutePath === entry.absolutePath;
                  return (
                    <li
                      key={entry.absolutePath}
                      className={
                        'ws-open-dialog__entry' +
                        (isSelected ? ' ws-open-dialog__entry--selected' : '') +
                        (entry.isCodeWorkspace ? ' ws-open-dialog__entry--code-workspace' : '')
                      }
                      onClick={() => handleEntryClick(entry)}
                      onDoubleClick={() => handleEntryDoubleClick(entry)}
                      title={entry.absolutePath}
                    >
                      <span className="ws-open-dialog__entry-icon">
                        {entry.type === 'directory'
                          ? '📁'
                          : entry.isCodeWorkspace
                            ? '🗂️'
                            : '📄'}
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

        {/* ---- 底部动作栏 ---- */}
        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info">
            {browseResult && (
              <span>
                Selected:{' '}
                <strong>
                  {selectedEntry
                    ? selectedEntry.absolutePath
                    : browseResult.absolutePath}
                </strong>
              </span>
            )}
          </div>
          <div className="ws-open-dialog__footer-actions">
            <button className="ws-open-dialog__btn" onClick={hide}>
              Cancel
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--secondary"
              disabled={!canOpenFile}
              onClick={() => selectedEntry && handleOpenFile(selectedEntry)}
              title={canOpenFile ? '打开 .code-workspace 文件' : '请选中一个 .code-workspace 文件'}
            >
              Open File
            </button>
            <button
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!browseResult}
              onClick={handleOpenFolder}
              title="把当前目录作为工作区打开"
            >
              Open as Folder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WorkspaceOpenDialog;
