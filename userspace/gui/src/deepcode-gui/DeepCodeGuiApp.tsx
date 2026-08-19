import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import useAppStatusStore from '../state/appStatusStore';
import { useEditorStore, getTabId } from '../state/editorStore';
import { useSettingsStore } from '../state/settingsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { normalizeUiLanguage, setActiveUiLanguage, t } from '../i18n';
import {
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
  resolveGuiTheme,
} from '../theme/deepcodeGuiTheme';
import {
  APP_CLOSE_REQUEST_EVENT,
  closeAppWindow,
  getHealth,
  getHostStartupStatus,
  getRuntimeStatus,
  healthVersion,
  startKernelAfterPermission,
  warmupTerminalRuntime,
} from '../services/runtimeAdapter';
import './deepcodeGui.css';
import './styles/deepcodeDesignTokens.css';
import './styles/deepcodeShell.css';

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

function startupStatusMessage(status: {
  message: string;
  code: string;
  reasonCode?: string;
  diagnosticRef?: string;
}): string {
  const details = [status.code, status.reasonCode, status.diagnosticRef].filter(Boolean);
  return details.length > 0
    ? `${status.message} (${details.join(' · ')})`
    : status.message;
}

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
    const startupStatus = start.data?.status;
    if (start.data?.blocked || startupStatus?.phase === 'failed') {
      setApiStatus('error');
      const message = startupStatus
        ? startupStatusMessage(startupStatus)
        : start.data?.message || t(language, 'deepcodeGui.kernelStart.failed');
      setErrorMessage(message);
      setKernelStartMessage(message);
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

    const message = startupStatus
      ? startupStatusMessage(startupStatus)
      : start.data?.message || t(language, 'deepcodeGui.kernelStart.waitingHealth');
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
    const preference = normalizeGuiThemePreference(effectiveSettings['gui.colorTheme']);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const applyTheme = () => {
      document.documentElement.dataset.themePreference = preference;
      document.documentElement.dataset.theme = resolveGuiTheme(preference, media.matches);
    };
    applyTheme();
    if (preference !== 'system') return;
    media.addEventListener('change', applyTheme);
    return () => media.removeEventListener('change', applyTheme);
  }, [effectiveSettings]);

  useEffect(() => {
    document.documentElement.dataset.accent = normalizeGuiAccentColor(
      effectiveSettings['gui.accentColor']
    );
  }, [effectiveSettings]);

  useEffect(() => {
    setActiveUiLanguage(language);
    document.documentElement.lang = language;
    window.localStorage.setItem('deepcode.ui.language', language);
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    let timeout: number | null = null;
    const check = async () => {
      await getRuntimeStatus();
      if (cancelled) return;
      const result = await getHealth();
      if (cancelled) return;
      if (result.ok && result.data) {
        setApiStatus('connected');
        setServerVersion(healthVersion(result.data));
        setKernelStartMessage(null);
        timeout = window.setTimeout(() => void check(), 30000);
      } else {
        const startup = await getHostStartupStatus();
        if (cancelled) return;
        if (startup.ok && startup.data) {
          const message = startupStatusMessage(startup.data);
          setKernelStartMessage(message);
          if (startup.data.phase === 'starting' || startup.data.phase === 'idle') {
            setApiStatus('checking');
            timeout = window.setTimeout(() => void check(), 500);
          } else {
            setApiStatus('error');
            setErrorMessage(message);
            timeout = window.setTimeout(() => void check(), 5000);
          }
        } else {
          setApiStatus('error');
          setErrorMessage(result.message || t(language, 'app.apiUnavailable'));
          timeout = window.setTimeout(() => void check(), 5000);
        }
      }
    };
    const cancelFirstPaint = afterFirstPaint(() => {
      void check();
    });
    return () => {
      cancelled = true;
      cancelFirstPaint();
      if (timeout) window.clearTimeout(timeout);
    };
  }, [language, setApiStatus, setErrorMessage, setKernelStartMessage, setServerVersion]);

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
