import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import useAppStatusStore from '../state/appStatusStore';
import { useEditorStore, getTabId } from '../state/editorStore';
import { useSettingsStore } from '../state/settingsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { normalizeUiLanguage, setActiveUiLanguage, t } from '../i18n';
import {
  APP_CLOSE_REQUEST_EVENT,
  closeAppWindow,
  getHealth,
  getRuntimeStatus,
  healthVersion,
  startKernelAfterPermission,
  warmupTerminalRuntime,
} from '../services/runtimeAdapter';
import './deepcodeGui.css';

const DeepCodeWorkbenchLayout = lazy(() => import('./layout/DeepCodeWorkbenchLayout'));

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

const EMPTY_WORKSPACE_SETTINGS: Record<string, unknown> = {};

const BootFallback: React.FC<{ language: ReturnType<typeof normalizeUiLanguage> }> = ({ language }) => (
  <div className="deepcode-gui-boot-shell">
    <div className="deepcode-gui-boot-shell__title">DeepCode-GUI</div>
    <div className="deepcode-gui-boot-shell__body">{t(language, 'deepcodeGui.boot.starting')}</div>
  </div>
);

const DeepCodeGuiApp: React.FC = () => {
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
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const connectedReloadDoneRef = useRef(false);
  const [kernelStartBusy, setKernelStartBusy] = useState(false);
  const [kernelStartMessage, setKernelStartMessage] = useState<string | null>(null);
  const dirtySignature = useEditorStore((s) =>
    s.tabs
      .flatMap((tab) =>
        tab.kind === 'file' && tab.isDirty ? [`${getTabId(tab)}:${tab.version}`] : []
      )
      .join('|')
  );

  const saveCurrentActiveFile = useCallback(async () => {
    const { activeTabId, tabs, saveFile } = useEditorStore.getState();
    const activeTab = tabs.find((tab) => getTabId(tab) === activeTabId);
    if (activeTab?.kind !== 'file') return false;
    return saveFile(getTabId(activeTab));
  }, []);

  const retryKernelStart = useCallback(async () => {
    setKernelStartBusy(true);
    setKernelStartMessage(null);
    setApiStatus('checking');
    const start = await startKernelAfterPermission();
    if (!start.ok) {
      setApiStatus('error');
      const message = start.message || t(language, 'deepcodeGui.kernelStart.failed');
      setErrorMessage(message);
      setKernelStartMessage(message);
      setKernelStartBusy(false);
      return;
    }
    if (start.data?.blocked) {
      setApiStatus('error');
      setErrorMessage(start.data.message);
      setKernelStartMessage(start.data.message);
      setKernelStartBusy(false);
      return;
    }

    for (let attempt = 0; attempt < 24; attempt += 1) {
      const result = await getHealth();
      if (result.ok && result.data) {
        setApiStatus('connected');
        setServerVersion(healthVersion(result.data));
        setKernelStartMessage(null);
        setKernelStartBusy(false);
        return;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }

    const message = start.data?.message || t(language, 'deepcodeGui.kernelStart.waitingHealth');
    setApiStatus('error');
    setErrorMessage(message);
    setKernelStartMessage(message);
    setKernelStartBusy(false);
  }, [language, setApiStatus, setErrorMessage, setServerVersion]);

  useEffect(() => {
    document.documentElement.dataset.product = 'deepcode-gui';
    return afterFirstPaint(() => {
      void loadWorkspace();
      void loadUserSettings();
    });
  }, [loadWorkspace, loadUserSettings]);

  useEffect(() => {
    if (apiStatus !== 'connected' || connectedReloadDoneRef.current) return;
    connectedReloadDoneRef.current = true;
    void loadWorkspace();
    void loadUserSettings();
  }, [apiStatus, loadUserSettings, loadWorkspace]);

  useEffect(() => {
    syncWorkspaceSettings(workspaceSettings);
  }, [workspaceSettings, syncWorkspaceSettings]);

  useEffect(() => {
    document.documentElement.dataset.theme = String(
      effectiveSettings['gui.colorTheme'] ?? 'deepcode-gui-light'
    );
  }, [effectiveSettings]);

  useEffect(() => {
    setActiveUiLanguage(language);
    document.documentElement.lang = language;
    window.localStorage.setItem('deepcode.ui.language', language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const check = async () => {
      await getRuntimeStatus();
      if (cancelled) return;
      const result = await getHealth();
      if (cancelled) return;
      if (result.ok && result.data) {
        setApiStatus('connected');
        setServerVersion(healthVersion(result.data));
      } else {
        setApiStatus('error');
        setErrorMessage(result.message || t(language, 'app.apiUnavailable'));
      }
    };
    const cancelFirstPaint = afterFirstPaint(() => {
      void check();
      interval = setInterval(() => void check(), 30000);
    });
    return () => {
      cancelled = true;
      cancelFirstPaint();
      if (interval) clearInterval(interval);
    };
  }, [language, setApiStatus, setErrorMessage, setServerVersion]);

  useEffect(() => {
    let disconnect: (() => void) | null = null;
    const cancel = afterFirstPaint(() => {
      void import('../services/heartbeatSocket').then((heartbeat) => {
        heartbeat.connectHeartbeat();
        disconnect = heartbeat.disconnectHeartbeat;
      });
    });
    return () => {
      cancel();
      disconnect?.();
    };
  }, []);

  useEffect(() => {
    const terminalPrewarm = String(effectiveSettings['terminal.integrated.prewarm'] ?? 'afterStartup');
    if (terminalPrewarm !== 'afterStartup') return;
    const id = window.setTimeout(() => {
      void warmupTerminalRuntime();
    }, 1800);
    return () => window.clearTimeout(id);
  }, [effectiveSettings]);

  useEffect(() => {
    const autoSave = String(effectiveSettings['files.autoSave'] ?? 'off');
    if (autoSave !== 'afterDelay' || !dirtySignature) return;
    const delay = Number(effectiveSettings['files.autoSaveDelay'] ?? 1000);
    const id = window.setTimeout(() => {
      void useEditorStore.getState().saveAllDirtyFiles();
    }, Number.isFinite(delay) ? Math.max(250, delay) : 1000);
    return () => window.clearTimeout(id);
  }, [dirtySignature, effectiveSettings]);

  useEffect(() => {
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
      }
      if (key === 'w' && !isEditableTarget(event.target)) {
        event.preventDefault();
        const { activeTabId, closeTab } = useEditorStore.getState();
        if (activeTabId) closeTab(activeTabId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveCurrentActiveFile]);

  useEffect(() => {
    const close = () => {
      void closeAppWindow();
    };
    window.addEventListener(APP_CLOSE_REQUEST_EVENT, close);
    return () => window.removeEventListener(APP_CLOSE_REQUEST_EVENT, close);
  }, []);

  return (
    <Suspense fallback={<BootFallback language={language} />}>
      <DeepCodeWorkbenchLayout
        apiStatus={apiStatus}
        wsStatus={wsStatus}
        serverVersion={serverVersion}
        lastHeartbeatAt={lastHeartbeatAt}
        kernelStartBusy={kernelStartBusy}
        kernelStartMessage={kernelStartMessage}
        onRetryKernelStart={retryKernelStart}
      />
    </Suspense>
  );
};

export default DeepCodeGuiApp;
