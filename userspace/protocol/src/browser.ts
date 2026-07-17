export type InternalBrowserMode = 'code' | 'browser';

export type BrowserRuntimeStatus = 'idle' | 'starting' | 'running' | 'error';

export type BrowserInspectState = 'off' | 'selecting' | 'selected';

export type BrowserRuntimeAction =
  | 'open'
  | 'reload'
  | 'inspect'
  | 'click'
  | 'type'
  | 'scroll';

export type BrowserRuntimeCapability =
  | 'status'
  | 'openTargetRecording'
  | 'reloadRecording'
  | 'inspectModeRecording';

export type BrowserCapabilityState = 'available' | 'reserved';

export type BrowserActionResult = 'ok' | 'reserved' | 'unavailable';

export type BrowserRuntimeCapabilities = Record<
  BrowserRuntimeCapability,
  BrowserCapabilityState
>;

export interface BrowserRuntimeDiagnostics {
  currentUrl?: string | null;
  runtimeStatus: BrowserRuntimeStatus;
  inspectState: BrowserInspectState;
  lastAction?: BrowserRuntimeAction | null;
  lastActionAt?: string | null;
  lastActionResult?: BrowserActionResult | null;
}

export interface BrowserRuntimeStatusResult {
  status: BrowserRuntimeStatus;
  inspectState: BrowserInspectState;
  currentUrl?: string | null;
  message?: string;
  lastAction?: BrowserRuntimeAction | null;
  lastActionAt?: string | null;
  capabilities?: BrowserRuntimeCapabilities;
  diagnostics?: BrowserRuntimeDiagnostics;
}

export interface OpenBrowserPreviewRequest {
  url?: string;
}

export interface SetBrowserInspectModeRequest {
  inspectState: BrowserInspectState;
}
