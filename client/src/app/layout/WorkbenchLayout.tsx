/**
 * 工作台总布局
 *
 * 结构（VSCode 还原版）：
 *   - 48px Activity Bar：上方 Explorer / Source Control / Search，底部 ⚙️ Settings / 👤 Accounts；
 *   - ⚙️ 在主编辑区切换到 Settings Tab；
 *   - file Tab id 为 `${folderId}::${path}` 复合形式。
 */
import './workbenchLayout.css';
import React, { useState } from 'react';
import FileTree from '../../components/file-tree/FileTree';
import CodeEditor from '../../components/editor/CodeEditor';
import TerminalPlaceholder from '../../components/terminal/TerminalPlaceholder';
import GitPanelPlaceholder from '../../components/git-panel/GitPanelPlaceholder';
import AgentPanelPlaceholder from '../../components/agent-panel/AgentPanelPlaceholder';
import ApprovalCenterPlaceholder from '../../components/approval-center/ApprovalCenterPlaceholder';
import SettingsCenter from '../../components/settings-center/SettingsCenter';
import WorkspaceOpenDialog from '../../components/workspace-open-dialog/WorkspaceOpenDialog';
import {
  useEditorStore,
  SETTINGS_TAB_ID,
  buildFileTabId,
} from '../../state/editorStore';

interface WorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
}

type SidebarPanel = 'explorer' | 'git' | 'search';

const WorkbenchLayout: React.FC<WorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  lastHeartbeatAt,
}) => {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const saveMessage = useEditorStore((s) => s.saveMessage);
  const openFile = useEditorStore((s) => s.openFile);
  const openSettings = useEditorStore((s) => s.openSettings);
  const closeTab = useEditorStore((s) => s.closeTab);
  const updateContent = useEditorStore((s) => s.updateContent);
  const saveFile = useEditorStore((s) => s.saveFile);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);

  const activeTab = tabs.find((t) => {
    const id = t.kind === 'file' ? buildFileTabId(t.folderId, t.path) : t.id;
    return id === activeTabId;
  });
  const activeFile = activeTab && activeTab.kind === 'file' ? activeTab : null;
  const isSettingsActive = activeTab?.kind === 'settings';

  const [activeSidebar, setActiveSidebar] = useState<SidebarPanel>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);

  const toggleSidebarPanel = (panel: SidebarPanel) => {
    if (activeSidebar === panel && sidebarVisible) {
      setSidebarVisible(false);
    } else {
      setActiveSidebar(panel);
      setSidebarVisible(true);
    }
  };

  const renderSidebarContent = () => {
    switch (activeSidebar) {
      case 'explorer':
        return (
          <FileTree
            onFileSelect={(p, fid) => openFile(p, fid)}
            selectedTabId={activeFile ? buildFileTabId(activeFile.folderId, activeFile.path) : null}
          />
        );
      case 'git':
        return (
          <>
            <div className="panel-header">Source Control</div>
            <GitPanelPlaceholder />
          </>
        );
      case 'search':
        return (
          <>
            <div className="panel-header">Search</div>
            <div className="placeholder-content">
              SearchPanelPlaceholder
              <div className="stage-hint">(后续阶段接入工作区搜索)</div>
            </div>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className={`workbench-layout ${
        !sidebarVisible ? 'workbench-layout--no-sidebar' : ''
      }`}
    >
      {/* ---- 顶栏 ---- */}
      <header className="header">
        <div className="header__title">
          <strong>DeepCode</strong>
          <span className="header__subtitle">Workspace</span>
          {serverVersion && (
            <span className="header__version">v{serverVersion}</span>
          )}
        </div>
        <div className="status-group">
          {saveMessage && <span className="header__save-msg">{saveMessage}</span>}
          <div className="status-item">
            <div className={`status-dot ${apiStatus}`} />
            <span>API: {apiStatus}</span>
          </div>
          <div className="status-item">
            <div className={`status-dot ${wsStatus}`} />
            <span>WS: {wsStatus}</span>
          </div>
          {lastHeartbeatAt && (
            <span className="header__heartbeat">
              最后心跳: {lastHeartbeatAt}
            </span>
          )}
        </div>
      </header>

      {/* ---- 活动栏 ---- */}
      <div className="activity-bar">
        <div className="activity-bar__top">
          <div
            className={`activity-icon ${
              activeSidebar === 'explorer' && sidebarVisible ? 'active' : ''
            }`}
            title="文件资源管理器"
            onClick={() => toggleSidebarPanel('explorer')}
          >
            📁
          </div>
          <div
            className={`activity-icon ${
              activeSidebar === 'git' && sidebarVisible ? 'active' : ''
            }`}
            title="Source Control"
            onClick={() => toggleSidebarPanel('git')}
          >
            🌿
          </div>
          <div
            className={`activity-icon ${
              activeSidebar === 'search' && sidebarVisible ? 'active' : ''
            }`}
            title="Search"
            onClick={() => toggleSidebarPanel('search')}
          >
            🔍
          </div>
        </div>

        <div className="activity-bar__bottom">
          <div
            className={`activity-icon ${isSettingsActive ? 'active' : ''}`}
            title="Settings"
            onClick={() => openSettings()}
          >
            ⚙️
          </div>
          <div
            className="activity-icon activity-icon--disabled"
            title="Accounts (占位)"
          >
            👤
          </div>
        </div>
      </div>

      {/* ---- 侧边栏 ---- */}
      {sidebarVisible && (
        <aside className="sidebar panel">{renderSidebarContent()}</aside>
      )}

      {/* ---- 中间：编辑器 ---- */}
      <main className="editor-area panel">
        {tabs.length > 0 && (
          <div className="editor-tabs">
            {tabs.map((tab) => {
              const id = tab.kind === 'file'
                ? buildFileTabId(tab.folderId, tab.path)
                : tab.id;
              const isActive = id === activeTabId;
              const title = tab.kind === 'file'
                ? `[${tab.folderId}] ${tab.path}`
                : tab.title;
              const label = tab.kind === 'file'
                ? `📄 ${tab.path.split('/').pop()}`
                : `⚙️ ${tab.title}`;
              const isDirty = tab.kind === 'file' ? tab.isDirty : false;

              return (
                <div
                  key={id}
                  onClick={() => setActiveTab(id)}
                  className={`editor-tab ${
                    isActive ? 'editor-tab--active' : ''
                  } ${tab.kind === 'settings' ? 'editor-tab--settings' : ''}`}
                  title={title}
                >
                  <span
                    className="editor-tab__close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(id);
                    }}
                  >
                    ✕
                  </span>
                  <span className="editor-tab__name">{label}</span>
                  {isDirty && <span className="editor-tab__dirty">●</span>}
                </div>
              );
            })}
          </div>
        )}

        {isSettingsActive ? (
          <SettingsCenter
            apiStatus={apiStatus}
            wsStatus={wsStatus}
            serverVersion={serverVersion}
          />
        ) : (
          <CodeEditor
            filePath={activeFile?.path ?? null}
            modelKey={
              activeFile
                ? buildFileTabId(activeFile.folderId, activeFile.path)
                : null
            }
            content={activeFile?.content ?? ''}
            onContentChange={(content) => {
              if (activeFile) {
                updateContent(
                  buildFileTabId(activeFile.folderId, activeFile.path),
                  content
                );
              }
            }}
            isDirty={activeFile?.isDirty ?? false}
            binary={activeFile?.binary ?? false}
            sizeBytes={activeFile?.sizeBytes ?? 0}
            onSave={(modelKey) => saveFile(modelKey)}
          />
        )}
      </main>

      {/* ---- 右侧：Agent 面板 ---- */}
      <aside className="agent-panel panel">
        <div className="panel-header">Agent Runtime</div>
        <AgentPanelPlaceholder />
      </aside>

      {/* ---- 底部面板 ---- */}
      <footer className="bottom-panel panel">
        <div className="bottom-tabs">
          <div className="tab active">Terminal</div>
          <div className="tab">Approval Center</div>
        </div>
        <div className="bottom-panel__content">
          <TerminalPlaceholder />
          <ApprovalCenterPlaceholder />
        </div>
      </footer>

      {/* ---- 全局模态：可视化 Open Workspace ---- */}
      <WorkspaceOpenDialog />
    </div>
  );
};

export default WorkbenchLayout;
