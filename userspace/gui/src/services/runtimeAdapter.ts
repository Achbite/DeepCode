import type { ApiResponse, HealthStatus } from '@deepcode/protocol';
import * as api from './apiClient';

type TauriCoreApi = {
  invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCoreApi };
  }
}

export const APP_CLOSE_REQUEST_EVENT = 'deepcode:app-close-request';

export interface RuntimeStatus {
  runtime: 'web';
  version: string;
  platform: string;
  arch?: string;
}

export interface KernelStartResult {
  started: boolean;
  blocked: boolean;
  message: string;
  status: HostStartupStatusV1;
}

export interface HostStartupStatusV1 {
  schemaVersion: 'deepcode.host-shell.startup-status.v1';
  revision: number;
  attemptId: string;
  mode: 'managed' | 'connectOnly';
  phase: 'idle' | 'starting' | 'ready' | 'external' | 'blocked' | 'failed' | 'stopped';
  stage: string;
  code: string;
  reasonCode?: string;
  message: string;
  retryable: boolean;
  ownsProcesses: boolean;
  diagnosticRef?: string;
  updatedAt: string;
}

function tauriInvoke(): TauriCoreApi['invoke'] | null {
  return window.__TAURI__?.core?.invoke ?? null;
}

async function windowCommand(
  command: 'minimize' | 'toggleMaximize' | 'close',
  fallback?: () => void,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      await invoke({
        minimize: 'deepcode_window_minimize',
        toggleMaximize: 'deepcode_window_toggle_maximize',
        close: 'deepcode_window_close',
      }[command]);
    } catch (error) {
      console.warn(`[window] ${command} failed`, error);
    }
    return;
  }
  fallback?.();
}

export async function minimizeAppWindow(): Promise<void> {
  await windowCommand('minimize');
}

export async function toggleMaximizeAppWindow(): Promise<void> {
  await windowCommand('toggleMaximize');
}

export function requestCloseAppWindow(): void {
  window.dispatchEvent(new CustomEvent(APP_CLOSE_REQUEST_EVENT));
}

export async function closeAppWindow(): Promise<void> {
  await windowCommand('close', () => window.close());
}

export function healthVersion(health?: HealthStatus): string {
  return health?.version || health?.buildCommit || 'unknown';
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const health = await api.getHealth();
  return {
    runtime: 'web',
    version: health.ok ? healthVersion(health.data) : 'unknown',
    platform: navigator.platform,
  };
}

export async function startKernelAfterPermission(): Promise<ApiResponse<KernelStartResult>> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return {
      ok: false,
      error: 'kernel_start_unavailable',
      message: '仅桌面壳可以重新启动本地 Daemon。',
    };
  }
  try {
    return { ok: true, data: await invoke<KernelStartResult>('deepcode_start_kernel_after_permission') };
  } catch (error) {
    return { ok: false, error: 'kernel_start_failed', message: String(error) };
  }
}

export async function getHostStartupStatus(): Promise<ApiResponse<HostStartupStatusV1>> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return {
      ok: false,
      error: 'host_startup_status_unavailable',
      message: '仅桌面壳提供启动状态。',
    };
  }
  try {
    return { ok: true, data: await invoke<HostStartupStatusV1>('deepcode_host_startup_status') };
  } catch (error) {
    return { ok: false, error: 'host_startup_status_failed', message: String(error) };
  }
}

export async function getDefaultWorkspacePath(): Promise<ApiResponse<string | null>> {
  if (document.documentElement.dataset.product === 'deepcode-gui') {
    const invoke = tauriInvoke();
    if (invoke) {
      try {
        return { ok: true, data: await invoke<string | null>('deepcode_default_workspace_path') };
      } catch (error) {
        return { ok: false, error: 'default_workspace_failed', message: String(error) };
      }
    }
  }
  const response = await api.getDefaultWorkspacePath();
  return response.ok
    ? { ok: true, data: response.data?.path ?? null }
    : { ok: false, error: response.error, message: response.message };
}

export const getHealth = api.getHealth;
export const getCurrentWorkspace = api.getCurrentWorkspace;
export const openWorkspace = api.openWorkspace;
export const saveWorkspaceFile = api.saveWorkspaceFile;
export const patchWorkspaceSettings = api.patchWorkspaceSettings;
export const getInitialLocations = api.getInitialLocations;
export const browsePath = api.browsePath;
export const getFileTree = api.getFileTree;
export const readFile = api.readFile;
export const codeSearch = api.codeSearch;
export const getGitStatus = api.getGitStatus;
export const getGitDiff = api.getGitDiff;
export const getUserSettings = api.getUserSettings;
export const patchUserSettings = api.patchUserSettings;
export const getLlmProfiles = api.getLlmProfiles;
export const patchLlmProfiles = api.patchLlmProfiles;
export const probeLlmProfile = api.probeLlmProfile;
export const getShellEnvironment = api.getShellEnvironment;
export const getTerminalCapabilities = api.getTerminalCapabilities;
export const getTerminalWarmupStatus = api.getTerminalWarmupStatus;
export const warmupTerminalRuntime = api.warmupTerminalRuntime;
export const listTerminalSessions = api.listTerminalSessions;
export const createTerminalSession = api.createTerminalSession;
export const sendTerminalInput = api.sendTerminalInput;
export const resizeTerminalSession = api.resizeTerminalSession;
export const updateTerminalSession = api.updateTerminalSession;
export const restartTerminalSession = api.restartTerminalSession;
export const deleteTerminalSession = api.deleteTerminalSession;
export const getTerminalEvents = api.getTerminalEvents;
export const getBrowserRuntimeStatus = api.getBrowserRuntimeStatus;
export const openBrowserPreview = api.openBrowserPreview;
export const reloadBrowserPreview = api.reloadBrowserPreview;
export const setBrowserInspectMode = api.setBrowserInspectMode;
