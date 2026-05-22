export type InternalBrowserMode = 'code' | 'browser';

export type BrowserRuntimeStatus = 'idle' | 'starting' | 'running' | 'error';

export type BrowserInspectState = 'off' | 'selecting' | 'selected';

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

export interface BrowserRuntimeStatusResult {
  status: BrowserRuntimeStatus;
  inspectState: BrowserInspectState;
  currentUrl?: string | null;
  message?: string;
  snapshot?: PanelSemanticSnapshot | null;
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
