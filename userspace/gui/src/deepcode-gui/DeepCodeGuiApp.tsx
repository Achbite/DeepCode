import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import useAppStatusStore from '../state/appStatusStore';
import { useEditorStore, getTabId } from '../state/editorStore';
import { useSettingsStore } from '../state/settingsStore';
import { useWorkspaceStore } from '../state/workspaceStore';
import { useLocalAgentStore } from '../state/localAgentStore';
import { normalizeUiLanguage, setActiveUiLanguage, t, type UiLanguage } from '../i18n';
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

const HOST_STARTUP_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  host_startup_idle: 'deepcodeGui.hostStartup.idle',
  host_startup_status_unavailable: 'deepcodeGui.hostStartup.statusUnavailable',
  host_startup_permission_blocked: 'deepcodeGui.hostStartup.permissionBlocked',
  host_startup_external: 'deepcodeGui.hostStartup.external',
  host_startup_starting: 'deepcodeGui.hostStartup.starting',
  host_startup_ready: 'deepcodeGui.hostStartup.ready',
  host_startup_port_in_use: 'deepcodeGui.hostStartup.portInUse',
  host_startup_lock_unavailable: 'deepcodeGui.hostStartup.lockUnavailable',
  host_startup_resolving_binaries: 'deepcodeGui.hostStartup.resolvingBinaries',
  host_startup_executable_directory_unavailable:
    'deepcodeGui.hostStartup.executableDirectoryUnavailable',
  host_startup_daemon_binary_missing: 'deepcodeGui.hostStartup.daemonBinaryMissing',
  host_startup_proxy_binary_missing: 'deepcodeGui.hostStartup.proxyBinaryMissing',
  host_startup_spawning_daemon: 'deepcodeGui.hostStartup.spawningDaemon',
  host_startup_daemon_spawn_failed: 'deepcodeGui.hostStartup.daemonSpawnFailed',
  host_startup_daemon_log_capture_failed: 'deepcodeGui.hostStartup.daemonLogCaptureFailed',
  host_startup_waiting_daemon_identity: 'deepcodeGui.hostStartup.waitingDaemonIdentity',
  host_startup_daemon_identity_failed: 'deepcodeGui.hostStartup.daemonIdentityFailed',
  host_startup_waiting_daemon_recovery: 'deepcodeGui.hostStartup.waitingDaemonRecovery',
  host_startup_daemon_recovery_failed: 'deepcodeGui.hostStartup.daemonRecoveryFailed',
  host_startup_spawning_proxy: 'deepcodeGui.hostStartup.spawningProxy',
  host_startup_proxy_spawn_failed: 'deepcodeGui.hostStartup.proxySpawnFailed',
  host_startup_proxy_log_capture_failed: 'deepcodeGui.hostStartup.proxyLogCaptureFailed',
  host_startup_waiting_proxy_identity: 'deepcodeGui.hostStartup.waitingProxyIdentity',
  host_startup_proxy_identity_failed: 'deepcodeGui.hostStartup.proxyIdentityFailed',
  host_startup_waiting_proxy_health: 'deepcodeGui.hostStartup.waitingProxyHealth',
  host_startup_process_exited: 'deepcodeGui.hostStartup.processExited',
  host_startup_process_status_failed: 'deepcodeGui.hostStartup.processStatusFailed',
  host_startup_health_timeout: 'deepcodeGui.hostStartup.healthTimeout',
};

function startupStatusMessage(
  language: UiLanguage,
  status: {
    code: string;
    reasonCode?: string;
    diagnosticRef?: string;
  },
): string {
  const messageKey = HOST_STARTUP_MESSAGE_KEYS[status.code];
  const message = messageKey
    ? t(language, messageKey)
    : t(language, 'deepcodeGui.hostStartup.unknown', { code: status.code });
  const details = [status.code, status.reasonCode, status.diagnosticRef].filter(Boolean);
  return details.length > 0
    ? `${message} (${details.join(' · ')})`
    : message;
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
        ? startupStatusMessage(language, startupStatus)
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
      ? startupStatusMessage(language, startupStatus)
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
    void useLocalAgentStore.getState().initialize();
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
          const message = startupStatusMessage(language, startup.data);
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
