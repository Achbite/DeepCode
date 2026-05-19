/**
 * Workspace 板块（Settings 中心）
 *
 * 展示当前活动工作区的来源、folders 列表、DeepCode 命名空间设置与未支持字段。
 * 提供 Open Workspace 入口：弹出可视化对话框，与 FileTree 顶部按钮一致。
 */
import React from 'react';
import { useWorkspaceStore } from '../../../state/workspaceStore';
import { useUiStore } from '../../../state/uiStore';

const WorkspaceSection: React.FC = () => {
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const lastError = useWorkspaceStore((s) => s.lastError);
  const showWorkspaceOpenDialog = useUiStore((s) => s.showWorkspaceOpenDialog);

  const handleOpen = () => {
    showWorkspaceOpenDialog();
  };

  if (!workspace) {
    return (
      <div>
        <h2 className="settings-title">Workspace</h2>
        <div className="settings-card">
          <div className="settings-card__body">工作区尚未加载。</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="settings-title">Workspace</h2>

      {/* ---- 概览 ---- */}
      <div className="settings-card">
        <h3 className="settings-card__title">当前工作区</h3>
        <table className="settings-kv">
          <tbody>
            <tr>
              <td>名称</td>
              <td>{workspace.name}</td>
            </tr>
            <tr>
              <td>ID</td>
              <td>{workspace.id}</td>
            </tr>
            <tr>
              <td>来源类型</td>
              <td>
                {workspace.source}
                {fallbackUsed && (
                  <span style={{ color: '#d19a66', marginLeft: 8 }}>
                    (fallback)
                  </span>
                )}
              </td>
            </tr>
            {workspace.sourcePath && (
              <tr>
                <td>来源文件</td>
                <td style={{ wordBreak: 'break-all' }}>{workspace.sourcePath}</td>
              </tr>
            )}
            <tr>
              <td>打开时间</td>
              <td>{workspace.openedAt}</td>
            </tr>
          </tbody>
        </table>
        <div style={{ marginTop: 8 }}>
          <button
            onClick={handleOpen}
            style={{
              background: '#0e639c',
              color: '#fff',
              border: 'none',
              padding: '4px 12px',
              fontSize: 12,
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Open Workspace…
          </button>
          {lastError && (
            <span style={{ color: '#f48771', marginLeft: 12, fontSize: 12 }}>
              {lastError}
            </span>
          )}
        </div>
      </div>

      {/* ---- folders ---- */}
      <div className="settings-card">
        <h3 className="settings-card__title">Folders ({workspace.folders.length})</h3>
        <table className="settings-kv">
          <tbody>
            {workspace.folders.map((f) => (
              <tr key={f.id}>
                <td>{f.id}</td>
                <td>
                  <div>
                    <strong>{f.name}</strong>
                  </div>
                  <div style={{ color: '#888', fontSize: 11, wordBreak: 'break-all' }}>
                    {f.absolutePath}
                  </div>
                  {!f.isAbsolute && (
                    <div style={{ color: '#888', fontSize: 11 }}>
                      原始（相对）: {f.originalPath}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---- DeepCode 命名空间设置 ---- */}
      <div className="settings-card">
        <h3 className="settings-card__title">DeepCode 设置（只读）</h3>
        {Object.keys(workspace.settings).length === 0 ? (
          <div className="settings-card__body">
            尚未配置任何 <code>deepcode.*</code> 命名空间设置。
          </div>
        ) : (
          <table className="settings-kv">
            <tbody>
              {Object.entries(workspace.settings).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>
                    <code>{JSON.stringify(v)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="settings-card__body" style={{ marginTop: 6, color: '#888' }}>
          仅 <code>deepcode.</code> 前缀键会被纳入；编辑能力将在后续阶段开放。
        </div>
      </div>

      {/* ---- 未支持字段 ---- */}
      {workspace.unsupportedFields.length > 0 && (
        <div className="settings-card">
          <h3 className="settings-card__title">未支持字段（兼容提示）</h3>
          <table className="settings-kv">
            <tbody>
              {workspace.unsupportedFields.map((u) => (
                <tr key={u.key}>
                  <td>{u.key}</td>
                  <td>{u.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="settings-card__body" style={{ color: '#888' }}>
            DeepCode 当前不解析 VSCode 特有字段（extensions / tasks / launch / remoteAuthority）。
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkspaceSection;
