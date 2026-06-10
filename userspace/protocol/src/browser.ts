export type InternalBrowserMode = 'code' | 'browser';

export type BrowserRuntimeStatus = 'idle' | 'starting' | 'running' | 'error';

export type BrowserInspectState = 'off' | 'selecting' | 'selected';

export type BrowserRuntimeAction =
  | 'open'
  | 'reload'
  | 'inspect'
  | 'snapshot'
  | 'attach'
  | 'click'
  | 'type'
  | 'scroll';

export type BrowserRuntimeCapability =
  | 'status'
  | 'openTargetRecording'
  | 'reloadRecording'
  | 'inspectModeRecording'
  | 'domCapture'
  | 'agentAttachment';

export type BrowserCapabilityState = 'available' | 'reserved';

export type BrowserActionResult = 'ok' | 'reserved' | 'unavailable';

export interface BrowserBoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelSemanticSnapshot {
  id: string;
  url: string;
  capturedAt: string;
  selector: string;
  panelKind?: string;
  panelTitle?: string;
  boundingRect?: BrowserBoundingRect;
  textContent?: string;
  aria?: Record<string, string>;
  classNames?: string[];
  styleTokens?: Record<string, string>;
  domOutline?: string;
  sourceHints?: string[];
  relatedFiles?: string[];
}

export type BrowserRuntimeCapabilities = Record<
  BrowserRuntimeCapability,
  BrowserCapabilityState
>;

export interface BrowserRuntimeDiagnostics {
  currentUrl?: string | null;
  runtimeStatus: BrowserRuntimeStatus;
  inspectState: BrowserInspectState;
  hasSnapshot: boolean;
  attached: boolean;
  lastAction?: BrowserRuntimeAction | null;
  lastActionAt?: string | null;
  lastActionResult?: BrowserActionResult | null;
}

export interface BrowserRuntimeStatusResult {
  status: BrowserRuntimeStatus;
  inspectState: BrowserInspectState;
  currentUrl?: string | null;
  message?: string;
  snapshot?: PanelSemanticSnapshot | null;
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

export interface PanelSnapshotResult {
  snapshot: PanelSemanticSnapshot | null;
  message?: string;
}

export interface AttachPanelSnapshotResult {
  attached: boolean;
  snapshot: PanelSemanticSnapshot | null;
  message?: string;
}
