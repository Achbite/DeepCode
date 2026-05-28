/**
 * App entry.
 *
 * Boot order:
 *   1. Load workspace and user settings.
 *   2. Start runtime health check.
 *   3. Start heartbeat.
 *   4. Register editor-level shortcuts, auto-save and close guard.
 */
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import useAppStatusStore from '../state/appStatusStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useSettingsStore } from '../state/settingsStore';
import {
  getRuntimeStatus,
  warmupTerminalRuntime,
} from '../services/runtimeAdapter';
import { getTabId, useEditorStore } from '../state/editorStore';
import type { ConfirmDialogAction, ConfirmDialogData } from '../types/ui';
import { t } from '../i18n';
import './app.css';

const WorkbenchLayout = lazy(() => import('./layout/WorkbenchLayout'));

const EMPTY_WORKSPACE_SETTINGS: Record<string, unknown> = {};

const CLOSED_CONFIRM_DIALOG: ConfirmDialogData = {
  open: false,
  title: '',
  message: '',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'INPUT' ||
    target.getAttribute('role') === 'textbox' ||
    Boolean(target.closest('.monaco-editor'))
  );
}

function asNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function markStartup(name: string): void {
  if (typeof performance === 'undefined') return;
  performance.mark(name);
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.debug(`[startup] ${name}`, Math.round(performance.now()));
  }
}

function afterFirstPaint(task: () => void): () => void {
  let cancelled = false;
  const frame = window.requestAnimationFrame(() => {
    window.setTimeout(() => {
      if (!cancelled) task();
    }, 0);
  });
  return () => {
    cancelled = true;
    window.cancelAnimationFrame(frame);
  };
}

function scheduleIdle(task: () => void, timeout = 1200): () => void {
  if (window.requestIdleCallback) {
    const id = window.requestIdleCallback(() => task(), { timeout });
    return () => window.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(task, timeout);
  return () => window.clearTimeout(id);
}

const BootShellFallback: React.FC = () => (
  <div className="app-boot-shell" aria-label={t('zh-CN', 'app.startingAria')}>
    <div className="app-boot-shell__header">DeepCode</div>
    <div className="app-boot-shell__body">
      <div className="app-boot-shell__rail" />
      <div className="app-boot-shell__side" />
      <div className="app-boot-shell__center">{t('zh-CN', 'app.starting')}</div>
      <div className="app-boot-shell__agent" />
    </div>
    <div className="app-boot-shell__status" />
  </div>
);

async function destroyCurrentWindow(): Promise<void> {
  window.close();
}

const App: React.FC = () => {
  const {
    apiStatus,
    wsStatus,
    serverVersion,
    lastHeartbeatAt,
    setApiStatus,
    setServerVersion,
    setErrorMessage,
  } = useAppStatusStore();

  const loadWorkspace = useWorkspaceStore((s) => s.loadCurrent);
  const workspaceSettings = useWorkspaceStore((s) => s.current?.settings ?? EMPTY_WORKSPACE_SETTINGS);
  const loadUserSettings = useSettingsStore((s) => s.loadUserSettings);
  const syncWorkspaceSettings = useSettingsStore((s) => s.syncWorkspaceSettings);
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const colorTheme = String(effectiveSettings['workbench.colorTheme'] ?? 'vs-dark');
  const autoSave = String(effectiveSettings['files.autoSave'] ?? 'off');
  const autoSaveDelay = asNumber(effectiveSettings['files.autoSaveDelay'], 1000);
  const hotExit = asBoolean(effectiveSettings['files.hotExit'], true);
  const terminalPrewarm = String(
    effectiveSettings['terminal.integrated.prewarm'] ?? 'afterStartup'
  );
  const enableBasicShortcuts = asBoolean(
    effectiveSettings['keyboard.enableBasicShortcuts'],
    true
  );

  const dirtySignature = useEditorStore((s) =>
    s.tabs
      .flatMap((tab) =>
        tab.kind === 'file' && tab.isDirty
          ? [`${getTabId(tab)}:${tab.version}`]
          : []
      )
      .join('|')
  );

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogData>(CLOSED_CONFIRM_DIALOG);
  const connectedReloadDoneRef = useRef(false);

  const closeConfirmDialog = useCallback(() => {
    setConfirmDialog(CLOSED_CONFIRM_DIALOG);
  }, []);

  const saveCurrentActiveFile = useCallback(async () => {
    const { activeTabId, tabs, saveFile } = useEditorStore.getState();
    const activeTab = tabs.find((tab) => getTabId(tab) === activeTabId);
    if (activeTab?.kind !== 'file') return false;
    return saveFile(getTabId(activeTab));
  }, []);

  const showUnsavedCloseDialog = useCallback(() => {
    const { hasAnyDirtyFile, saveAllDirtyFiles, discardAllDirtyFiles } =
      useEditorStore.getState();
    if (!hasAnyDirtyFile()) return;

    const closeWindow = () => {
      closeConfirmDialog();
      window.setTimeout(() => {
        void destroyCurrentWindow();
      }, 50);
    };

    const actions: ConfirmDialogAction[] = [
      {
        label: '保存并退出',
        variant: 'primary',
        onClick: async () => {
          const ok = await saveAllDirtyFiles();
          if (ok) {
            closeWindow();
          }
        },
      },
      {
        label: '不保存',
        variant: 'danger',
        onClick: () => {
          discardAllDirtyFiles();
          closeWindow();
        },
      },
      {
        label: '取消',
        variant: 'secondary',
        onClick: closeConfirmDialog,
      },
    ];

    setConfirmDialog({
      open: true,
      title: '保存更改',
      message: '当前有未保存的文件。退出前是否保存这些更改？',
      detail: '选择“不保存”会放弃当前编辑器中的未保存内容；选择“取消”将返回 DeepCode。',
      actions,
    });
  }, [closeConfirmDialog]);

  // ---- 1. Load workspace and user settings ----
  useEffect(() => {
    return afterFirstPaint(() => {
      void loadWorkspace().finally(() => markStartup('deepcode:workspace-loaded'));
      void loadUserSettings().finally(() => markStartup('deepcode:settings-loaded'));
    });
  }, [loadWorkspace, loadUserSettings]);

  // If the desktop shell renders before the background Kernel Host is ready,
  // the first workspace/settings calls can fail. Retry once when health connects.
  useEffect(() => {
    if (apiStatus !== 'connected' || connectedReloadDoneRef.current) return;
    connectedReloadDoneRef.current = true;
    void loadWorkspace().finally(() => markStartup('deepcode:workspace-reloaded-after-connect'));
    void loadUserSettings().finally(() => markStartup('deepcode:settings-reloaded-after-connect'));
  }, [apiStatus, loadWorkspace, loadUserSettings]);

  // ---- 1.1 Workspace settings overlay ----
  useEffect(() => {
    syncWorkspaceSettings(workspaceSettings);
  }, [workspaceSettings, syncWorkspaceSettings]);

  // ---- 1.2 Theme sync ----
  useEffect(() => {
    document.documentElement.dataset.theme = colorTheme;
  }, [colorTheme]);

  // ---- 1.3 Communication warmup ----
  useEffect(() => {
    return scheduleIdle(() => {
      void import('../services/apiClient');
    });
  }, []);

  // ---- 2. Runtime status + API health ----
  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const checkRuntimeAndHealth = async () => {
      const runtimeStatus = await getRuntimeStatus();
      if (cancelled) return;

      const { getHealth } = await import('../services/apiClient');
      const result = await getHealth();
      if (cancelled) return;
      if (result.ok && result.data) {
        setApiStatus('connected');
        setServerVersion(result.data.version);
      } else {
        setApiStatus('error');
        setErrorMessage(result.message || 'API unavailable');
      }
    };

    const cancelFirstPaint = afterFirstPaint(() => {
      void (async () => {
        await checkRuntimeAndHealth();
        if (cancelled) return;
        interval = setInterval(checkRuntimeAndHealth, 30000);
      })();
    });

    return () => {
      cancelled = true;
      cancelFirstPaint();
      if (interval !== null) clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 3. Heartbeat ----
  useEffect(() => {
    let disconnect: (() => void) | null = null;
    let cancelled = false;
    const cancel = afterFirstPaint(() => {
      void import('../services/heartbeatSocket').then((heartbeat) => {
        if (cancelled) return;
        heartbeat.connectHeartbeat();
        disconnect = heartbeat.disconnectHeartbeat;
      });
    });
    return () => {
      cancelled = true;
      cancel();
      disconnect?.();
    };
  }, []);

  // ---- 3.1 Terminal runtime warmup ----
  useEffect(() => {
    if (terminalPrewarm !== 'afterStartup') return;
    let cancelIdle: (() => void) | null = null;
    const cancelFirstPaint = afterFirstPaint(() => {
      cancelIdle = scheduleIdle(() => {
        markStartup('deepcode:terminal-warmup-start');
        void warmupTerminalRuntime().finally(() =>
          markStartup('deepcode:terminal-warmup-ready')
        );
      }, 1600);
    });
    return () => {
      cancelFirstPaint();
      cancelIdle?.();
    };
  }, [terminalPrewarm]);

  // ---- 4. Basic shortcuts ----
  useEffect(() => {
    if (!enableBasicShortcuts) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      if (!ctrl) return;

      const key = event.key.toLowerCase();
      if (key === 's') {
        event.preventDefault();
        if (event.shiftKey) {
          void useEditorStore.getState().saveAllDirtyFiles();
        } else {
          void saveCurrentActiveFile();
        }
        return;
      }

      if (key === ',') {
        event.preventDefault();
        useEditorStore.getState().openSettings();
        return;
      }

      if (key === 'w' && !isEditableTarget(event.target)) {
        event.preventDefault();
        const { activeTabId, closeTab } = useEditorStore.getState();
        if (activeTabId) closeTab(activeTabId);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enableBasicShortcuts, saveCurrentActiveFile]);

  // ---- 5. Auto save ----
  useEffect(() => {
    if (autoSave !== 'afterDelay' || !dirtySignature) return;
    const delay = Math.max(250, autoSaveDelay);
    const timer = window.setTimeout(() => {
      void useEditorStore.getState().saveAllDirtyFiles();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [autoSave, autoSaveDelay, dirtySignature]);

  // ---- 6. Close guard ----
  useEffect(() => {
    if (!hotExit) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (useEditorStore.getState().hasAnyDirtyFile()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hotExit]);

  return (
    <>
      <Suspense fallback={<BootShellFallback />}>
        <WorkbenchLayout
          apiStatus={apiStatus}
          wsStatus={wsStatus}
          serverVersion={serverVersion}
          lastHeartbeatAt={lastHeartbeatAt}
        />
      </Suspense>
      {confirmDialog.open && (
        <div className="app-dialog-backdrop" role="presentation">
          <div
            className="app-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-confirm-title"
          >
            <div className="app-dialog__title" id="app-confirm-title">
              {confirmDialog.title}
            </div>
            <div className="app-dialog__message">{confirmDialog.message}</div>
            {confirmDialog.detail && (
              <div className="app-dialog__detail">{confirmDialog.detail}</div>
            )}
            <div className="app-dialog__actions">
              {(confirmDialog.actions ?? []).map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`app-dialog__button app-dialog__button--${
                    action.variant ?? 'secondary'
                  }`}
                  onClick={() => void action.onClick()}
                >
                  {action.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default App;
