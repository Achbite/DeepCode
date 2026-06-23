/**
 * 文件树组件
 *
 * VS Code-style 资源管理器基础交互：
 *   - 当前焦点目录决定 toolbar 新建文件 / 文件夹落点；
 *   - 右键菜单按资源类型显示 Explorer 操作；
 *   - 文件 / 文件夹均支持 inline rename；
 *   - 文件树右键可把文件 / 文件夹添加到当前 Agent 对话。
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { getFileTree } from '../../services/runtimeAdapter';
import type { FileTreeNode } from '@deepcode/protocol';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useUiStore } from '../../state/uiStore';
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
import { t, type UiLanguage } from '../../i18n';
import './fileTree.css';

interface FileTreeProps {
  onFileSelect: (filePath: string, folderId: string) => void;
  selectedTabId: string | null;
  language: UiLanguage;
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

function parentPathOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function absolutePathForTarget(rootPath: string, relativePath: string): string {
  const root = rootPath.replace(/\/+$/g, '');
  const relative = relativePath.replace(/^\/+/g, '');
  return relative ? `${root}/${relative}` : rootPath;
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textArea = document.createElement('textarea');
  textArea.value = text;
  textArea.setAttribute('readonly', 'true');
  textArea.style.position = 'fixed';
  textArea.style.left = '-9999px';
  document.body.appendChild(textArea);
  textArea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textArea);
  if (!copied) {
    throw new Error('clipboard copy failed');
  }
}

const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, selectedTabId, language }) => {
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const currentWorkspace = useWorkspaceStore((s) => s.current);
  const treeRevision = useWorkspaceStore((s) => s.treeRevision);
  const bumpTreeRevision = useWorkspaceStore((s) => s.bumpTreeRevision);
  const getActiveFolder = useWorkspaceStore((s) => s.getActiveFolder);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);
  const addAgentAttachment = useAgentSessionStore((s) => s.addAttachment);

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingRename, setPendingRename] = useState<PendingRename | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<ResourceTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const treeLoadInFlightRef = useRef(false);

  const rootTarget: ResourceTarget | null = activeFolderId
    ? {
        kind: 'directory',
        path: '',
        name: getActiveFolder()?.name ?? t(language, 'explorer.workspaceRoot'),
        folderId: activeFolderId,
      }
    : null;

  const loadTree = useCallback(async (options?: { silent?: boolean }) => {
    if (!activeFolderId) {
      setTree([]);
      setLoading(false);
      setError(null);
      return;
    }
    if (treeLoadInFlightRef.current) return;
    const silent = options?.silent === true;
    treeLoadInFlightRef.current = true;
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const result = await getFileTree(activeFolderId);
      if (result.ok && result.data) {
        setTree(result.data as FileTreeNode[]);
        if (!silent) setError(null);
      } else if (!silent) {
        setError(result.message || t(language, 'explorer.error.loadTree'));
      }
    } finally {
      treeLoadInFlightRef.current = false;
      if (!silent) setLoading(false);
    }
  }, [activeFolderId, language]);

  useEffect(() => {
    loadTree();
  }, [loadTree, treeRevision]);

  useEffect(() => {
    if (!activeFolderId) return;
    const shouldPoll = () =>
      document.visibilityState === 'visible' &&
      !pendingCreate &&
      !pendingRename &&
      !treeLoadInFlightRef.current;
    const refreshSilently = () => {
      if (shouldPoll()) void loadTree({ silent: true });
    };
    const timer = window.setInterval(refreshSilently, 2000);
    const onVisibilityChange = () => refreshSilently();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [activeFolderId, loadTree, pendingCreate, pendingRename]);

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
      if (noticeTimerRef.current) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const showNotice = (message: string) => {
    setNotice(message);
    if (noticeTimerRef.current) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 1800);
  };

  const showHostMutationDisabled = () => {
    const message = '文件修改需通过 Agent 计划确认后由 Kernel 执行。';
    setPendingError(message);
    showNotice(message);
  };

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
      setPendingCreate(null);
      showHostMutationDisabled();
    },
    [pendingCreate, activeFolderId]
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
        setPendingError(t(language, 'explorer.error.renameSeparator'));
        return;
      }
      if (trimmed === pendingRename.target.name) {
        cancelInlineEdit();
        return;
      }
      showHostMutationDisabled();
    },
    [pendingRename, language]
  );

  const submitDelete = useCallback(
    async (target: ResourceTarget) => {
      if (!target.path) {
        setPendingError(t(language, 'explorer.error.deleteRoot'));
        showNotice(t(language, 'explorer.error.deleteRoot'));
        return;
      }
      const confirmKey =
        target.kind === 'directory'
          ? 'explorer.confirm.deleteFolder'
          : 'explorer.confirm.deleteFile';
      const ok = window.confirm(t(language, confirmKey, { name: target.name }));
      if (!ok) {
        setContextMenu(null);
        return;
      }

      setPendingCreate(null);
      setPendingRename(null);
      showHostMutationDisabled();
      setContextMenu(null);
    },
    [language]
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
    const folder =
      currentWorkspace?.folders.find((candidate) => candidate.id === target.folderId) ??
      getActiveFolder();
    addAgentAttachment({
      kind: target.kind,
      path: target.path,
      absolutePath: folder ? absolutePathForTarget(folder.absolutePath, target.path) : undefined,
      folderId: target.folderId,
      source: 'contextMenu',
      scope,
    });
    setContextMenu(null);
  };

  const copyRelativePath = async (target: ResourceTarget) => {
    const path = target.path || '.';
    try {
      await copyTextToClipboard(path);
      showNotice(t(language, 'explorer.copy.relativeDone'));
    } catch {
      showNotice(t(language, 'explorer.copy.failed'));
    }
    setContextMenu(null);
  };

  const copyAbsolutePath = async (target: ResourceTarget) => {
    const folder =
      currentWorkspace?.folders.find((candidate) => candidate.id === target.folderId) ??
      getActiveFolder();
    if (!folder) {
      showNotice(t(language, 'explorer.copy.failed'));
      setContextMenu(null);
      return;
    }
    try {
      await copyTextToClipboard(absolutePathForTarget(folder.absolutePath, target.path));
      showNotice(t(language, 'explorer.copy.absoluteDone'));
    } catch {
      showNotice(t(language, 'explorer.copy.failed'));
    }
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
        placeholder={pendingCreate.kind === 'file'
          ? t(language, 'explorer.placeholder.fileName')
          : t(language, 'explorer.placeholder.folderName')}
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
          placeholder={t(language, 'explorer.placeholder.rename')}
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
        <span>{t(language, 'explorer.title')}</span>
        <div className="file-tree__toolbar">
          <button
            className="file-tree__toolbar-btn"
            onClick={() => startCreate('file')}
            disabled={!activeFolderId}
            title={t(language, 'explorer.newFile')}
            aria-label={t(language, 'explorer.newFile')}
          >
            <NewFileIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={() => startCreate('folder')}
            disabled={!activeFolderId}
            title={t(language, 'explorer.newFolder')}
            aria-label={t(language, 'explorer.newFolder')}
          >
            <NewFolderIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={() => bumpTreeRevision()}
            disabled={!activeFolderId}
            title={t(language, 'explorer.refresh')}
            aria-label={t(language, 'explorer.refresh')}
          >
            <RefreshIcon />
          </button>
          <button
            className="file-tree__toolbar-btn"
            onClick={showWorkspaceOpenDialog}
            title={t(language, 'explorer.openWorkspace')}
            aria-label={t(language, 'explorer.openWorkspace')}
          >
            <FolderOpenIcon />
          </button>
        </div>
      </div>

      {loading && (
        <div className="file-tree__status file-tree__status--loading">
          {t(language, 'explorer.loading')}
        </div>
      )}
      {error && (
        <div className="file-tree__status file-tree__status--error">{error}</div>
      )}
      {!activeFolderId && (
        <div className="file-tree__empty">
          <div className="file-tree__empty-title">{t(language, 'explorer.emptyTitle')}</div>
          <div className="file-tree__empty-body">
            {t(language, 'explorer.emptyBody')}
          </div>
          <button
            className="file-tree__empty-action"
            type="button"
            onClick={showWorkspaceOpenDialog}
          >
            {t(language, 'explorer.openFolder')}
          </button>
        </div>
      )}
      {activeFolderId && !loading && !error && (
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
          {notice && (
            <div className="file-tree__notice" role="status">{notice}</div>
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
          onDelete={() => void submitDelete(contextMenu.target)}
          onCopyRelativePath={() => void copyRelativePath(contextMenu.target)}
          onCopyAbsolutePath={() => void copyAbsolutePath(contextMenu.target)}
          onAddToAgent={() => addToAgent(contextMenu.target, 'message')}
          onAddToAgentSession={() => addToAgent(contextMenu.target, 'session')}
          deleting={false}
          language={language}
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
  onDelete: () => void;
  onCopyRelativePath: () => void;
  onCopyAbsolutePath: () => void;
  onAddToAgent: () => void;
  onAddToAgentSession: () => void;
  deleting: boolean;
  language: UiLanguage;
}

const ExplorerContextMenu: React.FC<ExplorerContextMenuProps> = ({
  state,
  onNewFile,
  onNewFolder,
  onRename,
  onDelete,
  onCopyRelativePath,
  onCopyAbsolutePath,
  onAddToAgent,
  onAddToAgentSession,
  deleting,
  language,
}) => {
  const runAction = (
    event: React.MouseEvent<HTMLButtonElement>,
    action: () => void
  ) => {
    event.preventDefault();
    event.stopPropagation();
    action();
  };

  return (
    <div
      className="file-tree__context-menu"
      style={{ left: state.x, top: state.y }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="file-tree__context-title">
        {state.target.path || state.target.name}
      </div>
      <button type="button" onClick={(event) => runAction(event, onNewFile)}>
        {t(language, 'explorer.newFile')}
      </button>
      <button type="button" onClick={(event) => runAction(event, onNewFolder)}>
        {t(language, 'explorer.newFolder')}
      </button>
      {state.target.path && (
        <button type="button" onClick={(event) => runAction(event, onRename)}>
          {t(language, 'explorer.rename')}
        </button>
      )}
      {state.target.path && (
        <button
          type="button"
          className="file-tree__context-danger"
          onClick={(event) => runAction(event, onDelete)}
          disabled={deleting}
        >
          {deleting ? t(language, 'explorer.delete.inProgress', { name: state.target.name }) : t(language, 'explorer.delete')}
        </button>
      )}
      <div className="file-tree__context-separator" />
      <button type="button" onClick={(event) => runAction(event, onCopyRelativePath)}>
        {t(language, 'explorer.copyRelativePath')}
      </button>
      <button type="button" onClick={(event) => runAction(event, onCopyAbsolutePath)}>
        {t(language, 'explorer.copyAbsolutePath')}
      </button>
      <div className="file-tree__context-separator" />
      <button type="button" onClick={(event) => runAction(event, onAddToAgent)}>
        {t(language, 'explorer.addToAgentMessage')}
      </button>
      <button type="button" onClick={(event) => runAction(event, onAddToAgentSession)}>
        {t(language, 'explorer.pinToAgentSession')}
      </button>
    </div>
  );
};

export default FileTree;
