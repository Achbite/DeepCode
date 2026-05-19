/**
 * 文件树组件
 * 显示工作区目录结构，支持展开/折叠目录、点击文件打开编辑
 */
import React, { useState, useEffect, useCallback } from 'react';
import { getFileTree } from '../../services/apiClient';
import type { FileTreeNode } from '@deepcode/protocol';

interface FileTreeProps {
  /** 文件被选中时的回调 */
  onFileSelect: (filePath: string) => void;
  /** 当前选中的文件路径 */
  selectedFile: string | null;
}

const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, selectedFile }) => {
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- 加载目录树 ----
  const loadTree = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await getFileTree();
    if (result.ok && result.data) {
      setTree(result.data as FileTreeNode[]);
    } else {
      setError(result.message || '加载文件树失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // ---- 目录展开/折叠 ----
  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  // ---- 渲染树节点 ----
  const renderNode = (node: FileTreeNode, depth: number = 0): React.ReactNode => {
    const isExpanded = expandedDirs.has(node.path);
    const isSelected = selectedFile === node.path;

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
              (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
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
          {isExpanded && node.children?.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    // 文件节点
    return (
      <div
        key={node.path}
        onClick={() => onFileSelect(node.path)}
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
            (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.05)';
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
      <div style={{
        padding: '8px 16px',
        fontSize: 11,
        fontWeight: 'bold',
        textTransform: 'uppercase' as const,
        letterSpacing: 0.5,
        borderBottom: '1px solid #444',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span>Explorer</span>
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
