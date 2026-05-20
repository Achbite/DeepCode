/**
 * 文件树组件（阶段 4 / S4-1 + S4-2 重构版）
 *
 * 改造目标：
 *   1. 全部使用 Codicons inline SVG，移除旧文本图标。
 *   2. 工具栏对齐 VSCode 顺序：[New File] [New Folder] [Refresh]，hover 标题行才显。
 *   3. 抽出 inline style 到 fileTree.css，颜色 / 间距走 CSS 变量。
 *   4. useEffect 依赖加 treeRevision，Open Workspace 后强制刷新。
 *   5. 新建文件 / 新建文件夹采用 VSCode 风格 inline 输入：Enter 提交 / Esc 取消 / 失焦取消。
 *
 * 主体逻辑保留：
 *   - getFileTree 走 runtimeAdapter 双轨；
 *   - 由父组件传入 onFileSelect / selectedTabId；
 *   - Open Workspace 入口由 uiStore 弹模态对话框承担。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  getFileTree,
  createFile,
  createFolder,
} from '../../services/runtimeAdapter';
import type { FileTreeNode } from '@deepcode/protocol';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useUiStore } from '../../state/uiStore';
import {
  ChevronRightIcon,
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  FileIcon,
  RefreshIcon,
  NewFileIcon,
  NewFolderIcon,
} from './icons';
import './fileTree.css';

interface FileTreeProps {
  onFileSelect: (filePath: string, folderId: string) => void;
  selectedTabId: string | null;
}

// 待新建条目类型；null 表示当前没有新建中的输入
type PendingCreateKind = 'file' | 'folder';

interface PendingCreate {
  kind: PendingCreateKind;
  /** 新建项相对 folder 根的父目录 POSIX 路径；空串表示 folder 根 */
  parentPath: string;
}

function getDepthClass(depth: number): string {
  return `file-tree__row--depth-${Math.max(0, Math.min(depth, 12))}`;
}

const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, selectedTabId }) => {
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const treeRevision = useWorkspaceStore((s) => s.treeRevision);
  const bumpTreeRevision = useWorkspaceStore((s) => s.bumpTreeRevision);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCreate | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  // ---- 加载目录树（按 activeFolderId + treeRevision 触发） ----
  const loadTree = useCallback(async () => {
    if (!activeFolderId) {
      setTree([]);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await getFileTree(activeFolderId);
    if (result.ok && result.data) {
      setTree(result.data as FileTreeNode[]);
    } else {
      setError(result.message || '加载文件树失败');
    }
    setLoading(false);
  }, [activeFolderId]);

  // 关键：依赖 [activeFolderId, treeRevision]，工作区切换或主动 bump 都会重拉
  useEffect(() => {
    loadTree();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolderId, treeRevision]);

  // ---- Open Workspace 入口 ----
  const handleOpenWorkspace = () => {
    showWorkspaceOpenDialog();
  };

  // ---- 工具栏：刷新 / 新建文件 / 新建文件夹 ----
  const handleRefresh = () => {
    bumpTreeRevision();
  };

  const startCreate = (kind: PendingCreateKind) => {
    setPending({ kind, parentPath: '' });
    setPendingError(null);
  };

  const cancelCreate = () => {
    setPending(null);
    setPendingError(null);
  };

  const submitCreate = useCallback(
    async (name: string) => {
      if (!pending || !activeFolderId) return;
      const trimmed = name.trim();
      if (!trimmed) {
        cancelCreate();
        return;
      }
      // 拼接完整相对路径；POSIX 风格
      const target = pending.parentPath
        ? `${pending.parentPath}/${trimmed}`
        : trimmed;

      const result =
        pending.kind === 'file'
          ? await createFile(target, '', activeFolderId)
          : await createFolder(target, activeFolderId);

      if (result.ok) {
        setPending(null);
        setPendingError(null);
        bumpTreeRevision();
      } else if (result.error === 'file_already_exists') {
        setPendingError(`已存在：${trimmed}`);
      } else {
        setPendingError(result.message || '创建失败');
      }
    },
    [pending, activeFolderId, bumpTreeRevision]
  );

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  // ---- 渲染节点 ----
  const renderNode = (
    node: FileTreeNode,
    depth: number = 0
  ): React.ReactNode => {
    const isExpanded = expandedDirs.has(node.path);
    const tabIdForThis = activeFolderId
      ? `${activeFolderId}::${node.path}`
      : null;
    const isSelected = tabIdForThis !== null && selectedTabId === tabIdForThis;

    if (node.type === 'directory') {
      return (
        <div key={node.path}>
          <div
            className={`file-tree__row ${getDepthClass(depth)}`}
            onClick={() => toggleDir(node.path)}
          >
            <span className="file-tree__chevron">
              {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            </span>
            <span className="file-tree__icon">
              {isExpanded ? <FolderOpenIcon /> : <FolderIcon />}
            </span>
            <span className="file-tree__name">{node.name}</span>
          </div>
          {isExpanded &&
            node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    return (
      <div
        key={node.path}
        className={
          `file-tree__row ${getDepthClass(depth + 1)}` +
          (isSelected ? ' file-tree__row--selected' : '')
        }
        onClick={() => {
          if (activeFolderId) onFileSelect(node.path, activeFolderId);
        }}
      >
        <span className="file-tree__icon">
          <FileIcon />
        </span>
        <span className="file-tree__name">{node.name}</span>
      </div>
    );
  };

  return (
    <div className="file-tree">
      {/* ---- 顶部：Explorer + 工具栏（hover 时显） ---- */}
      <div className="file-tree__titlebar">
        <span>Explorer</span>
        <div className="file-tree__toolbar">
          <button
            className="file-tree__toolbar-btn"
            onClick={() => startCreate('file')}
            disabled={!activeFolderId}
            title="新建文件"
            aria-label="新建文件"
          >
            <NewFileIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={() => startCreate('folder')}
            disabled={!activeFolderId}
            title="新建文件夹"
            aria-label="新建文件夹"
          >
            <NewFolderIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={handleRefresh}
            disabled={!activeFolderId}
            title="刷新文件树"
            aria-label="刷新"
          >
            <RefreshIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={handleOpenWorkspace}
            title="打开工作区（目录或 .code-workspace）"
            aria-label="打开工作区"
          >
            <FolderOpenIcon />
          </button>
        </div>
      </div>

      {/* ---- 工作区摘要 ---- */}
      {workspace && (
        <div className="file-tree__summary">
          <div>
            <span>Workspace:</span>{' '}
            <span className="file-tree__summary-name">{workspace.name}</span>
            <span className="file-tree__summary-source">
              [{workspace.source}]
            </span>
            {fallbackUsed && (
              <span className="file-tree__summary-fallback">fallback</span>
            )}
          </div>
          {workspace.folders.length > 1 ? (
            <div>
              <span>Folder:</span>{' '}
              <select
                className="file-tree__summary-folder-select"
                value={activeFolderId ?? ''}
                onChange={(e) => selectFolder(e.target.value)}
              >
                {workspace.folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          ) : workspace.folders.length === 1 ? (
            <div>
              <span>Folder:</span>{' '}
              <span className="file-tree__summary-name">
                {workspace.folders[0].name}
              </span>
            </div>
          ) : null}
        </div>
      )}

      {/* ---- 内容区 ---- */}
      {loading && (
        <div className="file-tree__status file-tree__status--loading">加载中...</div>
      )}
      {error && (
        <div className="file-tree__status file-tree__status--error">{error}</div>
      )}
      {!loading && !error && (
        <div className="file-tree__body">
          {/* 新建文件 / 新建文件夹 inline 输入；置于树顶部 */}
          {pending && (
            <NewItemRow
              kind={pending.kind}
              onSubmit={submitCreate}
              onCancel={cancelCreate}
            />
          )}
          {pendingError && (
            <div className="file-tree__new-error">{pendingError}</div>
          )}
          {tree.map((node) => renderNode(node))}
        </div>
      )}
    </div>
  );
};

// ---- inline 输入子组件（VSCode 风格：Enter 提交 / Esc 取消 / 失焦取消）----

interface NewItemRowProps {
  kind: PendingCreateKind;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

const NewItemRow: React.FC<NewItemRowProps> = ({ kind, onSubmit, onCancel }) => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className={`file-tree__row ${getDepthClass(1)}`}>
      <span className="file-tree__icon">
        {kind === 'file' ? <FileIcon /> : <FolderIcon />}
      </span>
      <input
        ref={inputRef}
        className="file-tree__new-input"
        value={value}
        placeholder={kind === 'file' ? '文件名（可包含子路径，如 a/b.txt）' : '文件夹名'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit(value);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={() => {
          // 默认失焦取消（与 VSCode 一致；避免误提交）
          onCancel();
        }}
      />
    </div>
  );
};

export default FileTree;
