/**
 * 工作台总布局
 *
 * VSCode 还原版交互：
 *   - 最左侧 48px Activity Bar：上方放 Explorer / Source Control / Search（占位），
 *     下方放 ⚙️ Settings / 👤 Accounts（占位）；
 *   - ⚙️ 不再展开侧边栏，而是在主编辑区"新建/聚焦"一个 Settings Tab，
 *     与文件 Tab 平级，可关闭、可切换；
 *   - Skill / Prompt / Doctor / Ruler 等"高级配置"被收纳到 Settings 中心内，
 *     不再出现在 Activity Bar 上，避免污染左侧文件树；
 *   - Settings 与文件 Tab 共用同一组 Tab 栏，复用 closeTab / setActiveTab 行为。
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
import { useEditorStore, SETTINGS_TAB_ID } from '../../state/editorStore';

interface WorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
}

/** 左侧 Activity Bar 中可展开的侧边栏面板 */
type SidebarPanel = 'explorer' | 'git' | 'search';

const WorkbenchLayout: React.FC<WorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  lastHeartbeatAt,
}) => {
  // ---- 编辑器全局 store 选择性订阅 ----
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const saveMessage = useEditorStore((s) => s.saveMessage);
  const openFile = useEditorStore((s) => s.openFile);
  const openSettings = useEditorStore((s) => s.openSettings);
  const closeTab = useEditorStore((s) => s.closeTab);
  const updateContent = useEditorStore((s) => s.updateContent);
  const saveFile = useEditorStore((s) => s.saveFile);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);

  // 当前活跃 Tab + 派生
  const activeTab = tabs.find(
    (t) => (t.kind === 'file' ? t.path : t.id) === activeTabId
  );
  const activeFile = activeTab && activeTab.kind === 'file' ? activeTab : null;
  const isSettingsActive = activeTab?.kind === 'settings';

  const [activeSidebar, setActiveSidebar] = useState<SidebarPanel>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);

  // ---- 切换 Activity Bar 上的视图（仅 file/git/search） ----
  const toggleSidebarPanel = (panel: SidebarPanel) => {
    if (activeSidebar === panel && sidebarVisible) {
      setSidebarVisible(false);
    } else {
      setActiveSidebar(panel);
      setSidebarVisible(true);
    }
  };

  // ---- ⚙️ Settings 入口：在主编辑区打开 Settings Tab，不展开侧边栏 ----
  const handleOpenSettings = () => {
    openSettings();
  };

  // ---- 渲染侧边栏内容（仅 file/git/search） ----
  const renderSidebarContent = () => {
    switch (activeSidebar) {
      case 'explorer':
        return (
          <FileTree
            onFileSelect={openFile}
            selectedFile={activeFile?.path ?? null}
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

      {/* ---- 活动栏（VSCode 还原：上下分组） ---- */}
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

        {/* ⚙️ Settings 与 👤 Accounts 固定在底部，与 VSCode 行为一致 */}
        <div className="activity-bar__bottom">
          <div
            className={`activity-icon ${isSettingsActive ? 'active' : ''}`}
            title="Settings"
            onClick={handleOpenSettings}
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
        {/* ---- Tab 栏（file + settings 共用） ---- */}
        {tabs.length > 0 && (
          <div className="editor-tabs">
            {tabs.map((tab) => {
              const id = tab.kind === 'file' ? tab.path : tab.id;
              const isActive = id === activeTabId;
              const title = tab.kind === 'file' ? tab.path : tab.title;
              const label =
                tab.kind === 'file'
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

        {/* ---- 主体：Settings 优先于 CodeEditor ---- */}
        {isSettingsActive ? (
          <SettingsCenter
            apiStatus={apiStatus}
            wsStatus={wsStatus}
            serverVersion={serverVersion}
          />
        ) : (
          <CodeEditor
            filePath={activeFile?.path ?? null}
            content={activeFile?.content ?? ''}
            onContentChange={(content) => {
              if (activeFile) {
                updateContent(activeFile.path, content);
              }
            }}
            isDirty={activeFile?.isDirty ?? false}
            binary={activeFile?.binary ?? false}
            sizeBytes={activeFile?.sizeBytes ?? 0}
            onSave={saveFile}
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
    </div>
  );
};

export default WorkbenchLayout;
