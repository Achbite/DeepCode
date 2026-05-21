/**
 * 文件树组件
 *
 * VSCode 风格资源管理器基础交互：
 *   - 当前焦点目录决定 toolbar 新建文件 / 文件夹落点；
 *   - 右键菜单按资源类型显示 Explorer 操作；
 *   - 文件 / 文件夹均支持 inline rename；
 *   - 文件树右键可把文件 / 文件夹添加到当前 Agent 对话。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  getFileTree,
  createFile,
  createFolder,
  renameEntry,
} from '../../services/runtimeAdapter';
import type { FileTreeNode } from '@deepcode/protocol';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useUiStore } from '../../state/uiStore';
import {
  useEditorStore,
  buildFileTabId,
} from '../../state/editorStore';
import { useAgentSessionStore } from '../../state/agentSessionStore';
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

type PendingCreateKind = 'file' | 'folder';

interface ResourceTarget {
  kind: 'file' | 'directory';
  path: string;
  name: string;
  folderId: string;
}

interface PendingCreate {
  kind: PendingCreateKind;
  parentPath: string;
}

interface PendingRename {
  target: ResourceTarget;
}

interface ContextMenuState {
  x: number;
  y: number;
  target: ResourceTarget;
}

function getDepthClass(depth: number): string {
  return `file-tree__row--depth-${Math.max(0, Math.min(depth, 12))}`;
}

function basename(path: string): string {
  if (!path) return '';
  return path.split('/').filter(Boolean).pop() ?? path;
}

function parentPathOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function joinPath(parentPath: string, name: string): string {
  const trimmed = name.trim().replace(/^\/+|\/+$/g, '');
  return parentPath ? `${parentPath}/${trimmed}` : trimmed;
}

function replacePathPrefix(path: string, oldPath: string, newPath: string): string {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) {
    return `${newPath}/${path.slice(oldPath.length + 1)}`;
  }
  return path;
}

const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, selectedTabId }) => {
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const treeRevision = useWorkspaceStore((s) => s.treeRevision);
  const bumpTreeRevision = useWorkspaceStore((s) => s.bumpTreeRevision);
  const getActiveFolder = useWorkspaceStore((s) => s.getActiveFolder);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);
  const renamePathInTabs = useEditorStore((s) => s.renamePathInTabs);
  const addAgentAttachment = useAgentSessionStore((s) => s.addAttachment);

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const rootTarget: ResourceTarget | null = activeFolderId
    ? {
        kind: 'directory',
        path: '',
        name: getActiveFolder()?.name ?? 'Workspace Root',
        folderId: activeFolderId,
      }
    : null;

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

  useEffect(() => {
    loadTree();
  }, [loadTree, treeRevision]);

  useEffect(() => {
    const close = () => setContextMenu(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
        setPendingCreate(null);
        setPendingRename(null);
      }
    };
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const getCreateParentPath = (): string => {
    if (!selectedResource) return '';
    return selectedResource.kind === 'directory'
      ? selectedResource.path
      : parentPathOf(selectedResource.path);
  };

  const focusTarget = (target: ResourceTarget) => {
    setSelectedResource(target);
  };

  const startCreate = (kind: PendingCreateKind, parentPath = getCreateParentPath()) => {
    if (!activeFolderId) return;
    setPendingCreate({ kind, parentPath });
    setPendingRename(null);
    setPendingError(null);
    if (parentPath) {
      setExpandedDirs((prev) => new Set(prev).add(parentPath));
    }
  };

  const startRename = (target: ResourceTarget) => {
    setSelectedResource(target);
    setPendingCreate(null);
    setPendingRename({ target });
    setPendingError(null);
    setContextMenu(null);
  };

  const cancelInlineEdit = () => {
    setPendingCreate(null);
    setPendingRename(null);
    setPendingError(null);
  };

  const submitCreate = useCallback(
    async (name: string) => {
      if (!pendingCreate || !activeFolderId) return;
      const trimmed = name.trim();
      if (!trimmed) {
        cancelInlineEdit();
        return;
      }
      const target = joinPath(pendingCreate.parentPath, trimmed);
      const result =
        pendingCreate.kind === 'file'
          ? await createFile(target, '', activeFolderId)
          : await createFolder(target, activeFolderId);

      if (result.ok) {
        setPendingCreate(null);
        setPendingError(null);
        bumpTreeRevision();
        if (pendingCreate.kind === 'file') {
          void onFileSelect(target, activeFolderId);
        } else {
          setExpandedDirs((prev) => new Set(prev).add(target));
          setSelectedResource({
            kind: 'directory',
            path: target,
            name: basename(target),
            folderId: activeFolderId,
          });
        }
      } else if (result.error === 'file_already_exists') {
        setPendingError(`已存在：${trimmed}`);
      } else {
        setPendingError(result.message || '创建失败');
      }
    },
    [pendingCreate, activeFolderId, bumpTreeRevision, onFileSelect]
  );

  const submitRename = useCallback(
    async (name: string) => {
      if (!pendingRename) return;
      const trimmed = name.trim();
      if (!trimmed) {
        cancelInlineEdit();
        return;
      }
      if (/[\\/]/.test(trimmed)) {
        setPendingError('重命名只修改当前名称，不支持路径分隔符');
        return;
      }
      const { target } = pendingRename;
      const nextPath = joinPath(parentPathOf(target.path), trimmed);
      if (nextPath === target.path) {
        cancelInlineEdit();
        return;
      }
      const result = await renameEntry(target.path, nextPath, target.folderId);
      if (result.ok && result.data) {
        setExpandedDirs((prev) => {
          const next = new Set<string>();
          for (const path of prev) {
            next.add(replacePathPrefix(path, target.path, nextPath));
          }
          return next;
        });
        renamePathInTabs(target.folderId, target.path, nextPath);
        setSelectedResource({
          ...target,
          path: nextPath,
          name: trimmed,
        });
        setPendingRename(null);
        setPendingError(null);
        bumpTreeRevision();
      } else if (result.error === 'file_already_exists') {
        setPendingError(`已存在：${trimmed}`);
      } else {
        setPendingError(result.message || '重命名失败');
      }
    },
    [pendingRename, renamePathInTabs, bumpTreeRevision]
  );

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  const openContextMenu = (
    event: React.MouseEvent,
    target: ResourceTarget
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedResource(target);
    setContextMenu({ x: event.clientX, y: event.clientY, target });
  };

  const addToAgent = (target: ResourceTarget, scope: 'message' | 'session' = 'message') => {
    addAgentAttachment({
      kind: target.kind,
      path: target.path,
      folderId: target.folderId,
      source: 'contextMenu',
      scope,
    });
    setContextMenu(null);
  };

  const isSelected = (target: ResourceTarget, activeFileSelected = false) => {
    if (selectedResource) {
      return (
        selectedResource.folderId === target.folderId &&
        selectedResource.path === target.path &&
        selectedResource.kind === target.kind
      );
    }
    return activeFileSelected;
  };

  const renderCreateRow = (parentPath: string, depth: number) => {
    if (!pendingCreate || pendingCreate.parentPath !== parentPath) return null;
    return (
      <InlineEditRow
        key={`create:${parentPath}:${pendingCreate.kind}`}
        depth={depth}
        kind={pendingCreate.kind === 'file' ? 'file' : 'directory'}
        initialValue=""
        placeholder={pendingCreate.kind === 'file' ? '文件名' : '文件夹名'}
        onSubmit={submitCreate}
        onCancel={cancelInlineEdit}
      />
    );
  };

  const renderNode = (
    node: FileTreeNode,
    depth: number = 0
  ): React.ReactNode => {
    if (!activeFolderId) return null;
    const target: ResourceTarget = {
      kind: node.type,
      path: node.path,
      name: node.name,
      folderId: activeFolderId,
    };
    const isRenaming =
      pendingRename?.target.folderId === target.folderId &&
      pendingRename.target.path === target.path;

    if (isRenaming) {
      return (
        <InlineEditRow
          key={`rename:${target.path}`}
          depth={node.type === 'directory' ? depth : depth + 1}
          kind={node.type}
          initialValue={node.name}
          placeholder="新名称"
          onSubmit={submitRename}
          onCancel={cancelInlineEdit}
        />
      );
    }

    if (node.type === 'directory') {
      const isExpanded = expandedDirs.has(node.path);
      const selected = isSelected(target);
      return (
        <div key={node.path}>
          <div
            className={`file-tree__row ${getDepthClass(depth)} ${
              selected ? 'file-tree__row--selected' : ''
            }`}
            onClick={() => {
              focusTarget(target);
              toggleDir(node.path);
            }}
            onContextMenu={(event) => openContextMenu(event, target)}
          >
            <span className="file-tree__chevron">
              {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
            </span>
            <span className="file-tree__icon">
              {isExpanded ? <FolderOpenIcon /> : <FolderIcon />}
            </span>
            <span className="file-tree__name">{node.name}</span>
          </div>
          {isExpanded && (
            <>
              {renderCreateRow(node.path, depth + 1)}
              {node.children?.map((child) => renderNode(child, depth + 1))}
            </>
          )}
        </div>
      );
    }

    const tabIdForThis = `${activeFolderId}::${node.path}`;
    const activeFileSelected = selectedTabId === tabIdForThis;
    const selected = isSelected(target, activeFileSelected);

    return (
      <div
        key={node.path}
        className={
          `file-tree__row ${getDepthClass(depth + 1)}` +
          (selected ? ' file-tree__row--selected' : '')
        }
        onClick={() => {
          setSelectedResource(target);
          onFileSelect(node.path, activeFolderId);
        }}
        onContextMenu={(event) => openContextMenu(event, target)}
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
            onClick={() => bumpTreeRevision()}
            disabled={!activeFolderId}
            title="刷新文件树"
            aria-label="刷新"
          >
            <RefreshIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={showWorkspaceOpenDialog}
            title="打开工作区（目录或 .code-workspace）"
            aria-label="打开工作区"
          >
            <FolderOpenIcon />
          </button>
        </div>
      </div>

      {loading && (
        <div className="file-tree__status file-tree__status--loading">加载中...</div>
      )}
      {error && (
        <div className="file-tree__status file-tree__status--error">{error}</div>
      )}
      {!loading && !error && (
        <div
          className="file-tree__body"
          onContextMenu={(event) => {
            if (event.currentTarget === event.target && rootTarget) {
              openContextMenu(event, rootTarget);
            }
          }}
        >
          {renderCreateRow('', 1)}
          {pendingError && (
            <div className="file-tree__new-error">{pendingError}</div>
          )}
          {tree.map((node) => renderNode(node))}
        </div>
      )}

      {contextMenu && (
        <ExplorerContextMenu
          state={contextMenu}
          onNewFile={() => {
            startCreate('file', contextMenu.target.kind === 'directory'
              ? contextMenu.target.path
              : parentPathOf(contextMenu.target.path));
            setContextMenu(null);
          }}
          onNewFolder={() => {
            startCreate('folder', contextMenu.target.kind === 'directory'
              ? contextMenu.target.path
              : parentPathOf(contextMenu.target.path));
            setContextMenu(null);
          }}
          onRename={() => startRename(contextMenu.target)}
          onAddToAgent={() => addToAgent(contextMenu.target, 'message')}
          onAddToAgentSession={() => addToAgent(contextMenu.target, 'session')}
        />
      )}
    </div>
  );
};

interface InlineEditRowProps {
  depth: number;
  kind: 'file' | 'directory';
  initialValue: string;
  placeholder: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

const InlineEditRow: React.FC<InlineEditRowProps> = ({
  depth,
  kind,
  initialValue,
  placeholder,
  onSubmit,
  onCancel,
}) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className={`file-tree__row ${getDepthClass(depth)}`}>
      <span className="file-tree__icon">
        {kind === 'file' ? <FileIcon /> : <FolderIcon />}
      </span>
      <input
        ref={inputRef}
        className="file-tree__new-input"
        value={value}
        placeholder={placeholder}
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
        onBlur={onCancel}
      />
    </div>
  );
};

interface ExplorerContextMenuProps {
  state: ContextMenuState;
  onNewFile: () => void;
  onNewFolder: () => void;
  onRename: () => void;
  onAddToAgent: () => void;
  onAddToAgentSession: () => void;
}

const ExplorerContextMenu: React.FC<ExplorerContextMenuProps> = ({
  state,
  onNewFile,
  onNewFolder,
  onRename,
  onAddToAgent,
  onAddToAgentSession,
}) => (
  <div
    className="file-tree__context-menu"
    style={{ left: state.x, top: state.y }}
    onClick={(event) => event.stopPropagation()}
  >
    <div className="file-tree__context-title">
      {state.target.path || state.target.name}
    </div>
    <button onClick={onNewFile}>New File</button>
    <button onClick={onNewFolder}>New Folder</button>
    {state.target.path && <button onClick={onRename}>Rename</button>}
    <div className="file-tree__context-separator" />
    <button onClick={onAddToAgent}>Add to Agent Message</button>
    <button onClick={onAddToAgentSession}>Pin to Agent Session</button>
  </div>
);

export default FileTree;
