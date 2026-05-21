import './workbenchLayout.css';
import React, { useEffect, useState } from 'react';
import FileTree from '../../components/file-tree/FileTree';
import CodeEditor from '../../components/editor/CodeEditor';
import TerminalPlaceholder from '../../components/terminal/TerminalPlaceholder';
import GitPanelPlaceholder from '../../components/git-panel/GitPanelPlaceholder';
import AgentPanelPlaceholder from '../../components/agent-panel/AgentPanelPlaceholder';
import SettingsCenter from '../../components/settings-center/SettingsCenter';
import WorkspaceOpenDialog from '../../components/workspace-open-dialog/WorkspaceOpenDialog';
import CodeWorkspaceChoiceDialog from '../../components/code-workspace-choice-dialog/CodeWorkspaceChoiceDialog';
import WindowControls from '../../components/window-controls/WindowControls';
import {
  useEditorStore,
  buildFileTabId,
} from '../../state/editorStore';
import { useAgentSessionStore } from '../../state/agentSessionStore';

interface WorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
}

type SidebarPanel = 'explorer' | 'git' | 'search';
type ActivityIconName = SidebarPanel | 'settings' | 'account';
type PanelResizeKind = 'sidebar' | 'agent' | 'bottom';

const SIDEBAR_WIDTH_KEY = 'deepcode.layout.sidebarWidth';
const AGENT_WIDTH_KEY = 'deepcode.layout.agentWidth';
const BOTTOM_HEIGHT_KEY = 'deepcode.layout.bottomHeight';

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readStoredLayoutSize(
  key: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof window === 'undefined') return fallback;
  const stored = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(stored)) return fallback;
  return clampNumber(stored, min, max);
}

const ActivityIcon: React.FC<{ name: ActivityIconName }> = ({ name }) => {
  const commonProps = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'explorer':
      return (
        <svg {...commonProps}>
          <path d="M3.5 6.5h6l1.8 2h9.2v9.8a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2V6.5Z" />
          <path d="M3.5 6.5V5.7a1.2 1.2 0 0 1 1.2-1.2h4.6l1.7 2" />
        </svg>
      );
    case 'git':
      return (
        <svg {...commonProps}>
          <circle cx="6.5" cy="5.8" r="2.1" />
          <circle cx="17.5" cy="18.2" r="2.1" />
          <circle cx="6.5" cy="18.2" r="2.1" />
          <path d="M6.5 7.9v8.2" />
          <path d="M8.3 6.9c4.6.6 7.1 2.9 8 9.2" />
        </svg>
      );
    case 'search':
      return (
        <svg {...commonProps}>
          <circle cx="10.5" cy="10.5" r="6" />
          <path d="m15 15 5 5" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.2-2-3.4-2.2 1a8.6 8.6 0 0 0-2.6-1.5L14.3 3h-4.6l-.4 2.4a8.6 8.6 0 0 0-2.6 1.5l-2.2-1-2 3.4 2 1.2a7.8 7.8 0 0 0 0 3l-2 1.2 2 3.4 2.2-1a8.6 8.6 0 0 0 2.6 1.5l.4 2.4h4.6l.4-2.4a8.6 8.6 0 0 0 2.6-1.5l2.2 1 2-3.4-2.1-1.2Z" />
        </svg>
      );
    case 'account':
      return (
        <svg {...commonProps}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      );
    default:
      return null;
  }
};

const getLanguageLabel = (filePath?: string | null) => {
  if (!filePath) return 'Plain Text';
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext || ext === filePath) return 'Plain Text';
  const known: Record<string, string> = {
    ts: 'TypeScript',
    tsx: 'TypeScript React',
    js: 'JavaScript',
    jsx: 'JavaScript React',
    json: 'JSON',
    md: 'Markdown',
    css: 'CSS',
    html: 'HTML',
    rs: 'Rust',
  };
  return known[ext] ?? ext.toUpperCase();
};

const WorkbenchLayout: React.FC<WorkbenchLayoutProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
}) => {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabId = useEditorStore((s) => s.activeTabId);
  const openFile = useEditorStore((s) => s.openFile);
  const openSettings = useEditorStore((s) => s.openSettings);
  const closeTab = useEditorStore((s) => s.closeTab);
  const updateContent = useEditorStore((s) => s.updateContent);
  const saveFile = useEditorStore((s) => s.saveFile);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const addAgentAttachment = useAgentSessionStore((s) => s.addAttachment);

  const activeTab = tabs.find((tab) => {
    const id = tab.kind === 'file' ? buildFileTabId(tab.folderId, tab.path) : tab.id;
    return id === activeTabId;
  });
  const activeFile = activeTab && activeTab.kind === 'file' ? activeTab : null;
  const isSettingsActive = activeTab?.kind === 'settings';

  const [activeSidebar, setActiveSidebar] = useState<SidebarPanel>('explorer');
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredLayoutSize(SIDEBAR_WIDTH_KEY, 260, 180, 420)
  );
  const [agentWidth, setAgentWidth] = useState(() =>
    readStoredLayoutSize(AGENT_WIDTH_KEY, 380, 300, 620)
  );
  const [bottomHeight, setBottomHeight] = useState(() =>
    readStoredLayoutSize(BOTTOM_HEIGHT_KEY, 220, 140, 520)
  );
  const [terminalMinimized, setTerminalMinimized] = useState(false);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(AGENT_WIDTH_KEY, String(agentWidth));
  }, [agentWidth]);

  useEffect(() => {
    window.localStorage.setItem(BOTTOM_HEIGHT_KEY, String(bottomHeight));
  }, [bottomHeight]);

  const toggleSidebarPanel = (panel: SidebarPanel) => {
    if (activeSidebar === panel && sidebarVisible) {
      setSidebarVisible(false);
      return;
    }
    setActiveSidebar(panel);
    setSidebarVisible(true);
  };

  const renderSidebarContent = () => {
    switch (activeSidebar) {
      case 'explorer':
        return (
          <FileTree
            onFileSelect={(path, folderId) => openFile(path, folderId)}
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
              Search panel is reserved for the workspace search stage.
            </div>
          </>
        );
      default:
        return null;
    }
  };

  const startPanelResize = (
    kind: PanelResizeKind,
    event: React.MouseEvent<HTMLDivElement>
  ) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startSidebarWidth = sidebarWidth;
    const startAgentWidth = agentWidth;
    const startBottomHeight = bottomHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      if (kind === 'sidebar') {
        setSidebarWidth(clampNumber(startSidebarWidth + moveEvent.clientX - startX, 180, 420));
      } else if (kind === 'agent') {
        setAgentWidth(clampNumber(startAgentWidth - (moveEvent.clientX - startX), 300, 620));
      } else {
        const maxBottomHeight = Math.max(140, window.innerHeight - 240);
        setBottomHeight(
          clampNumber(startBottomHeight - (moveEvent.clientY - startY), 140, maxBottomHeight)
        );
      }
    };

    const onMouseUp = () => {
      document.body.classList.remove('workbench-resizing');
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    document.body.classList.add('workbench-resizing');
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const layoutStyle = {
    '--sidebar-width': `${sidebarWidth}px`,
    '--agent-width': `${agentWidth}px`,
    '--bottom-height': terminalMinimized ? '0px' : `${bottomHeight}px`,
  } as React.CSSProperties;

  return (
    <div
      className={`workbench-layout ${!sidebarVisible ? 'workbench-layout--no-sidebar' : ''} ${
        terminalMinimized ? 'workbench-layout--terminal-minimized' : ''
      }`}
      style={layoutStyle}
      onContextMenu={(event) => {
        event.preventDefault();
      }}
    >
      <header className="header">
        <div className="header__title">
          <strong>DeepCode</strong>
        </div>
        <WindowControls />
      </header>

      <div className="activity-bar">
        <div className="activity-bar__top">
          <button
            className={`activity-icon ${
              activeSidebar === 'explorer' && sidebarVisible ? 'active' : ''
            }`}
            title="Explorer"
            aria-label="Explorer"
            onClick={() => toggleSidebarPanel('explorer')}
          >
            <ActivityIcon name="explorer" />
          </button>
          <button
            className={`activity-icon ${activeSidebar === 'git' && sidebarVisible ? 'active' : ''}`}
            title="Source Control"
            aria-label="Source Control"
            onClick={() => toggleSidebarPanel('git')}
          >
            <ActivityIcon name="git" />
          </button>
          <button
            className={`activity-icon ${
              activeSidebar === 'search' && sidebarVisible ? 'active' : ''
            }`}
            title="Search"
            aria-label="Search"
            onClick={() => toggleSidebarPanel('search')}
          >
            <ActivityIcon name="search" />
          </button>
        </div>

        <div className="activity-bar__bottom">
          <button
            className={`activity-icon ${isSettingsActive ? 'active' : ''}`}
            title="Settings"
            aria-label="Settings"
            onClick={() => openSettings()}
          >
            <ActivityIcon name="settings" />
          </button>
          <button
            className="activity-icon activity-icon--disabled"
            title="Accounts"
            aria-label="Accounts"
            disabled
          >
            <ActivityIcon name="account" />
          </button>
        </div>
      </div>

      {sidebarVisible && <aside className="sidebar panel">{renderSidebarContent()}</aside>}

      <main className="editor-area panel">
        {tabs.length > 0 && (
          <div className="editor-tabs">
            {tabs.map((tab) => {
              const id = tab.kind === 'file' ? buildFileTabId(tab.folderId, tab.path) : tab.id;
              const isActive = id === activeTabId;
              const title = tab.kind === 'file' ? `[${tab.folderId}] ${tab.path}` : tab.title;
              const label = tab.kind === 'file' ? tab.path.split('/').pop() : tab.title;
              const isDirty = tab.kind === 'file' ? tab.isDirty : false;

              return (
                <button
                  key={id}
                  onClick={() => setActiveTab(id)}
                  onContextMenu={(event) => {
                    if (tab.kind !== 'file') return;
                    event.preventDefault();
                    addAgentAttachment({
                      kind: 'file',
                      path: tab.path,
                      folderId: tab.folderId,
                      source: 'contextMenu',
                      scope: 'message',
                    });
                  }}
                  className={`editor-tab ${isActive ? 'editor-tab--active' : ''} ${
                    tab.kind === 'settings' ? 'editor-tab--settings' : ''
                  }`}
                  title={title}
                  type="button"
                >
                  <span className="editor-tab__name">{label}</span>
                  {isDirty && <span className="editor-tab__dirty">*</span>}
                  <span
                    className="editor-tab__close"
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(id);
                    }}
                  >
                    x
                  </span>
                </button>
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
            modelKey={activeFile ? buildFileTabId(activeFile.folderId, activeFile.path) : null}
            content={activeFile?.content ?? ''}
            onContentChange={(content) => {
              if (!activeFile) return;
              updateContent(buildFileTabId(activeFile.folderId, activeFile.path), content);
            }}
            isDirty={activeFile?.isDirty ?? false}
            binary={activeFile?.binary ?? false}
            sizeBytes={activeFile?.sizeBytes ?? 0}
            onSave={(modelKey) => saveFile(modelKey)}
          />
        )}
      </main>

      <aside className="agent-panel panel">
        <AgentPanelPlaceholder />
      </aside>

      {!terminalMinimized && (
        <footer className="bottom-panel panel">
          <div className="bottom-panel__content">
            <TerminalPlaceholder onMinimize={() => setTerminalMinimized(true)} />
          </div>
        </footer>
      )}

      <footer className="status-bar">
        <div className="status-bar__group">
          <span>{activeFile ? `${activeFile.path}${activeFile.isDirty ? '*' : ''}` : 'No file'}</span>
          <span>{getLanguageLabel(activeFile?.path)}</span>
          <span>UTF-8</span>
        </div>
        <div className="status-bar__group">
          <span>API {apiStatus}</span>
          <span>WS {wsStatus}</span>
        </div>
      </footer>

      {sidebarVisible && (
        <div
          className="workbench-resizer workbench-resizer--sidebar"
          role="separator"
          aria-label="Resize Explorer"
          onMouseDown={(event) => startPanelResize('sidebar', event)}
        />
      )}
      <div
        className="workbench-resizer workbench-resizer--agent"
        role="separator"
        aria-label="Resize Agent panel"
        onMouseDown={(event) => startPanelResize('agent', event)}
      />
      {!terminalMinimized && (
        <div
          className="workbench-resizer workbench-resizer--bottom"
          role="separator"
          aria-label="Resize Terminal panel"
          onMouseDown={(event) => startPanelResize('bottom', event)}
        />
      )}
      {terminalMinimized && (
        <button
          className="terminal-expand-button"
          type="button"
          title="Expand terminal"
          aria-label="Expand terminal"
          onClick={() => setTerminalMinimized(false)}
        >
          &gt;_
        </button>
      )}

      <WorkspaceOpenDialog />
      <CodeWorkspaceChoiceDialog />
    </div>
  );
};

export default WorkbenchLayout;
