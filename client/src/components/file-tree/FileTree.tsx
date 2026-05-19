/**
 * 文件树组件
 *
 * 显示当前活动 WorkspaceFolder 下的目录结构，支持展开/折叠目录、点击文件打开。
 * 顶部显示当前工作区与活动 folder；包含 Open Workspace / 切换 folder 入口。
 *
 * Open Workspace 点击后默认弹出 WorkspaceOpenDialog（可视化选目录 / .code-workspace）；
 * Tauri 阶段可考虑切换为原生 plugin-dialog，但合同套接口不变：
 * 在 Web 上接入 server 的 /api/fs/browse 、在 Tauri 上可接入 invoke('pick_workspace_path')。
 */
import React, { useState, useEffect, useCallback } from 'react';
import { getFileTree } from '../../services/apiClient';
import type { FileTreeNode } from '@deepcode/protocol';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { useUiStore } from '../../state/uiStore';

interface FileTreeProps {
  onFileSelect: (filePath: string, folderId: string) => void;
  selectedTabId: string | null;
}

const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, selectedTabId }) => {
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const activeFolderId = useWorkspaceStore((s) => s.activeFolderId);
  const selectFolder = useWorkspaceStore((s) => s.selectFolder);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);
  // closeAllFileTabs / openWorkspace 调用迁移到 WorkspaceOpenDialog 内部，
  // FileTree 仅负责发起对话框 + 刷新当前 folder 的目录。

  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- 加载目录树（按 activeFolderId） ----
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
  }, [loadTree]);

  // ---- Open Workspace 入口（可视化对话框）----
  const handleOpenWorkspace = () => {
    showWorkspaceOpenDialog();
  };

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
            onClick={() => toggleDir(node.path)}
            style={{
              padding: '3px 8px 3px 12px',
              paddingLeft: 12 + depth * 16,
              fontSize: 13,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              color: '#ccc',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.background =
                'rgba(255,255,255,0.05)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.background = 'transparent';
            }}
          >
            <span style={{ fontSize: 10, width: 12 }}>
              {isExpanded ? '▼' : '▶'}
            </span>
            <span>📁</span>
            <span>{node.name}</span>
          </div>
          {isExpanded &&
            node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    // 文件节点
    return (
      <div
        key={node.path}
        onClick={() => {
          if (activeFolderId) onFileSelect(node.path, activeFolderId);
        }}
        style={{
          padding: '3px 8px 3px 12px',
          paddingLeft: 12 + (depth + 1) * 16,
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          background: isSelected ? 'rgba(0,122,204,0.3)' : 'transparent',
          color: isSelected ? '#fff' : '#ccc',
        }}
        onMouseEnter={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLElement).style.background =
              'rgba(255,255,255,0.05)';
          }
        }}
        onMouseLeave={(e) => {
          if (!isSelected) {
            (e.currentTarget as HTMLElement).style.background = 'transparent';
          }
        }}
      >
        <span>📄</span>
        <span>{node.name}</span>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* ---- 顶部：Explorer + 工作区信息 + 操作 ---- */}
      <div
        style={{
          padding: '8px 16px',
          fontSize: 11,
          fontWeight: 'bold',
          textTransform: 'uppercase' as const,
          letterSpacing: 0.5,
          borderBottom: '1px solid #444',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Explorer</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={handleOpenWorkspace}
            style={{
              background: 'none',
              border: '1px solid #555',
              color: '#ccc',
              cursor: 'pointer',
              fontSize: 11,
              padding: '1px 6px',
              borderRadius: 3,
              textTransform: 'none' as const,
              letterSpacing: 0,
              fontWeight: 'normal' as const,
            }}
            title="打开工作区（目录 或 .code-workspace）"
          >
            Open…
          </button>
          <button
            onClick={loadTree}
            style={{
              background: 'none',
              border: 'none',
              color: '#888',
              cursor: 'pointer',
              fontSize: 14,
              padding: 0,
            }}
            title="刷新"
          >
            🔄
          </button>
        </div>
      </div>

      {/* ---- 工作区摘要 ---- */}
      {workspace && (
        <div
          style={{
            padding: '6px 16px',
            fontSize: 12,
            color: '#aaa',
            borderBottom: '1px solid #2c2c2c',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <div>
            <span style={{ color: '#888' }}>Workspace:</span>{' '}
            <span style={{ color: '#ddd' }}>{workspace.name}</span>
            <span style={{ color: '#666', marginLeft: 6 }}>
              [{workspace.source}]
            </span>
            {fallbackUsed && (
              <span style={{ color: '#d19a66', marginLeft: 6 }}>fallback</span>
            )}
          </div>
          {workspace.folders.length > 1 ? (
            <div>
              <span style={{ color: '#888' }}>Folder:</span>{' '}
              <select
                value={activeFolderId ?? ''}
                onChange={(e) => selectFolder(e.target.value)}
                style={{
                  background: '#1e1e1e',
                  color: '#ddd',
                  border: '1px solid #444',
                  fontSize: 12,
                  marginLeft: 4,
                }}
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
              <span style={{ color: '#888' }}>Folder:</span>{' '}
              <span style={{ color: '#ccc' }}>{workspace.folders[0].name}</span>
            </div>
          ) : null}
        </div>
      )}

      {loading && (
        <div style={{ padding: 16, color: '#888', fontSize: 12 }}>加载中...</div>
      )}
      {error && (
        <div style={{ padding: 16, color: '#f44', fontSize: 12 }}>{error}</div>
      )}
      {!loading && !error && (
        <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
          {tree.map((node) => renderNode(node))}
        </div>
      )}
    </div>
  );
};

export default FileTree;
