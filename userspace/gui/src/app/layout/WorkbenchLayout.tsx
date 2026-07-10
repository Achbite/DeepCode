import './workbenchLayout.css';
import React, { Suspense, lazy, useEffect, useState } from 'react';
import type { InternalBrowserMode } from '@deepcode/protocol';
import GitPanelPlaceholder from '../../components/git-panel/GitPanelPlaceholder';
import WindowControls from '../../components/window-controls/WindowControls';
import BrowserModeSwitch from '../../components/internal-browser/BrowserModeSwitch';
import ActivityIcon from './ActivityIcon';
import EmptyEditorSurface from './EmptyEditorSurface';
import { normalizeUiLanguage, t } from '../../i18n';
import {
  useEditorStore,
  buildFileTabId,
} from '../../state/editorStore';
import { useSettingsStore } from '../../state/settingsStore';

interface WorkbenchLayoutProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  lastHeartbeatAt?: string;
}

type SidebarPanel = 'explorer' | 'git' | 'search';
type PanelResizeKind = 'sidebar' | 'agent' | 'bottom';
type HydrationPhase = 'shell' | 'primary' | 'idle';

const FileTree = lazy(() => import('../../components/file-tree/FileTree'));
const CodeEditor = lazy(() => import('../../components/editor/CodeEditor'));
const TerminalPlaceholder = lazy(() => import('../../components/terminal/TerminalPlaceholder'));
const AgentPanelPlaceholder = lazy(() => import('../../components/agent-panel/AgentPanelPlaceholder'));
const SettingsCenter = lazy(() => import('../../components/settings-center/SettingsCenter'));
const InternalBrowserPanel = lazy(() => import('../../components/internal-browser/InternalBrowserPanel'));
const WorkspaceOpenDialog = lazy(() => import('../../components/workspace-open-dialog/WorkspaceOpenDialog'));
const CodeWorkspaceChoiceDialog = lazy(() => import('../../components/code-workspace-choice-dialog/CodeWorkspaceChoiceDialog'));

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

const PanelFallback: React.FC<{ label: string }> = ({ label }) => (
  <div className="workbench-panel-fallback">{label}</div>
);

function scheduleWorkbenchIdle(task: () => void, timeout = 900): () => void {
  if (window.requestIdleCallback) {
    const id = window.requestIdleCallback(() => task(), { timeout });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, timeout);
  return () => window.clearTimeout(id);
}

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
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const settingsTitle = t(language, 'settings.title');

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
  const [editorMode, setEditorMode] = useState<InternalBrowserMode>('code');
  const [hydrationPhase, setHydrationPhase] = useState<HydrationPhase>('shell');

  const canLoadPrimary = hydrationPhase !== 'shell';
  const canLoadIdle = hydrationPhase === 'idle';

  useEffect(() => {
    if (typeof performance === 'undefined') return;
    performance.mark('deepcode:first-workbench-shell');
    window.requestAnimationFrame(() => {
      performance.mark('deepcode:first-interactive-shell');
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let idleCancel: (() => void) | null = null;
    let timeoutId: number | null = null;

    const frameId = window.requestAnimationFrame(() => {
      timeoutId = window.setTimeout(() => {
        if (cancelled) return;
        setHydrationPhase('primary');
        idleCancel = scheduleWorkbenchIdle(() => {
          if (!cancelled) setHydrationPhase('idle');
        });
      }, 0);
    });

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      idleCancel?.();
    };
  }, []);

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
        if (!canLoadPrimary) {
          return <PanelFallback label={t(language, 'workbench.loading.explorer')} />;
        }
        return (
          <Suspense fallback={<PanelFallback label={t(language, 'workbench.loading.explorer')} />}>
            <FileTree
              language={language}
              onFileSelect={(path, folderId) => openFile(path, folderId)}
              selectedTabId={activeFile ? buildFileTabId(activeFile.folderId, activeFile.path) : null}
            />
          </Suspense>
        );
      case 'git':
        return (
          <>
            <div className="panel-header">{t(language, 'workbench.sourceControl')}</div>
            <GitPanelPlaceholder language={language} />
          </>
        );
      case 'search':
        return (
          <>
            <div className="panel-header">{t(language, 'workbench.search')}</div>
            <div className="placeholder-content">
              {t(language, 'workbench.searchReserved')}
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

  const addFileTabToAgentContext = async (tab: Extract<(typeof tabs)[number], { kind: 'file' }>) => {
    const { useAgentSessionStore } = await import('../../state/agentSessionStore');
    const { useWorkspaceStore } = await import('../../state/workspaceStore');
    const folder = useWorkspaceStore
      .getState()
      .current
      ?.folders.find((candidate) => candidate.id === tab.folderId);
    const root = folder?.absolutePath.replace(/\/+$/g, '');
    const relative = tab.path.replace(/^\/+/g, '');
    useAgentSessionStore.getState().addAttachment({
      kind: 'file',
      path: tab.path,
      absolutePath: root ? `${root}/${relative}` : undefined,
      folderId: tab.folderId,
      source: 'contextMenu',
      scope: 'message',
    });
  };

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
      <header className="header" data-tauri-drag-region>
        <div className="header__title">
          <strong>DeepCode</strong>
        </div>
        <WindowControls language={language} />
      </header>

      <div className="activity-bar">
        <div className="activity-bar__top">
          <button
            className={`activity-icon ${
              activeSidebar === 'explorer' && sidebarVisible ? 'active' : ''
            }`}
            title={t(language, 'explorer.title')}
            aria-label={t(language, 'explorer.title')}
            onClick={() => toggleSidebarPanel('explorer')}
          >
            <ActivityIcon name="explorer" />
          </button>
          <button
            className={`activity-icon ${activeSidebar === 'git' && sidebarVisible ? 'active' : ''}`}
            title={t(language, 'workbench.sourceControl')}
            aria-label={t(language, 'workbench.sourceControl')}
            onClick={() => toggleSidebarPanel('git')}
          >
            <ActivityIcon name="git" />
          </button>
          <button
            className={`activity-icon ${
              activeSidebar === 'search' && sidebarVisible ? 'active' : ''
            }`}
            title={t(language, 'workbench.search')}
            aria-label={t(language, 'workbench.search')}
            onClick={() => toggleSidebarPanel('search')}
          >
            <ActivityIcon name="search" />
          </button>
        </div>

        <div className="activity-bar__bottom">
          <button
            className={`activity-icon ${isSettingsActive ? 'active' : ''}`}
            title={settingsTitle}
            aria-label={settingsTitle}
            onClick={() => openSettings()}
          >
            <ActivityIcon name="settings" />
          </button>
          <button
            className="activity-icon activity-icon--disabled"
            title={t(language, 'workbench.accounts')}
            aria-label={t(language, 'workbench.accounts')}
            disabled
          >
            <ActivityIcon name="account" />
          </button>
        </div>
      </div>

      {sidebarVisible && <aside className="sidebar panel">{renderSidebarContent()}</aside>}

      <main className="editor-area panel">
        <div className="editor-tabs">
          <div className="editor-tabs__list">
            {tabs.map((tab) => {
              const id = tab.kind === 'file' ? buildFileTabId(tab.folderId, tab.path) : tab.id;
              const isActive = id === activeTabId && editorMode === 'code';
              const title = tab.kind === 'file' ? `[${tab.folderId}] ${tab.path}` : settingsTitle;
              const label = tab.kind === 'file' ? tab.path.split('/').pop() : settingsTitle;
              const isDirty = tab.kind === 'file' ? tab.isDirty : false;

              return (
                <button
                  key={id}
                  onClick={() => {
                    setEditorMode('code');
                    setActiveTab(id);
                  }}
                  onContextMenu={(event) => {
                    if (tab.kind !== 'file') return;
                    event.preventDefault();
                    void addFileTabToAgentContext(tab);
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
          <BrowserModeSwitch mode={editorMode} language={language} onChange={setEditorMode} />
        </div>

        {editorMode === 'browser' ? (
          <Suspense fallback={<PanelFallback label={t(language, 'workbench.loading.browser')} />}>
            <InternalBrowserPanel />
          </Suspense>
        ) : isSettingsActive ? (
          <Suspense fallback={<PanelFallback label={t(language, 'workbench.loading.settings')} />}>
            <SettingsCenter
              apiStatus={apiStatus}
              wsStatus={wsStatus}
              serverVersion={serverVersion}
            />
          </Suspense>
        ) : activeFile ? (
          <Suspense fallback={<PanelFallback label={t(language, 'workbench.loading.editor')} />}>
            <CodeEditor
              filePath={activeFile.path}
              modelKey={buildFileTabId(activeFile.folderId, activeFile.path)}
              content={activeFile.content}
              onContentChange={(content) => {
                updateContent(buildFileTabId(activeFile.folderId, activeFile.path), content);
              }}
              isDirty={activeFile.isDirty}
              binary={activeFile.binary}
              sizeBytes={activeFile.sizeBytes}
              onSave={(modelKey) => saveFile(modelKey)}
            />
          </Suspense>
        ) : (
          <EmptyEditorSurface />
        )}
      </main>

      <aside className="agent-panel panel">
        {canLoadPrimary ? (
          <Suspense fallback={<PanelFallback label={t(language, 'workbench.loading.agent')} />}>
            <AgentPanelPlaceholder />
          </Suspense>
        ) : (
          <PanelFallback label={t(language, 'workbench.loading.agent')} />
        )}
      </aside>

      {!terminalMinimized && (
        <footer className="bottom-panel panel">
          <div className="bottom-panel__content">
            {canLoadIdle ? (
              <Suspense fallback={<PanelFallback label={t(language, 'workbench.loading.terminal')} />}>
                <TerminalPlaceholder language={language} onMinimize={() => setTerminalMinimized(true)} />
              </Suspense>
            ) : (
              <PanelFallback label={t(language, 'workbench.loading.terminal')} />
            )}
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
          aria-label={t(language, 'workbench.resize.explorer')}
          onMouseDown={(event) => startPanelResize('sidebar', event)}
        />
      )}
      <div
        className="workbench-resizer workbench-resizer--agent"
        role="separator"
        aria-label={t(language, 'workbench.resize.agent')}
        onMouseDown={(event) => startPanelResize('agent', event)}
      />
      {!terminalMinimized && (
        <div
          className="workbench-resizer workbench-resizer--bottom"
          role="separator"
          aria-label={t(language, 'workbench.resize.terminal')}
          onMouseDown={(event) => startPanelResize('bottom', event)}
        />
      )}
      {terminalMinimized && (
        <button
          className="terminal-expand-button"
          type="button"
          title={t(language, 'terminal.expand')}
          aria-label={t(language, 'terminal.expand')}
          onClick={() => setTerminalMinimized(false)}
        >
          &gt;_
        </button>
      )}

      {canLoadPrimary && (
        <Suspense fallback={null}>
          <WorkspaceOpenDialog />
          <CodeWorkspaceChoiceDialog />
        </Suspense>
      )}
    </div>
  );
};

export default WorkbenchLayout;
