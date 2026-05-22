import type {
  AttachPanelSnapshotResult,
  BrowserRuntimeStatusResult,
  OpenBrowserPreviewRequest,
  PanelSnapshotResult,
  SetBrowserInspectModeRequest,
} from '@deepcode/protocol';

const NOT_IMPLEMENTED_MESSAGE =
  'Internal browser runtime is a skeleton only. Real preview loading, DOM capture, and Agent attachment are reserved for a later stage.';

let currentUrl: string | null = null;
let inspectState: BrowserRuntimeStatusResult['inspectState'] = 'off';

export function getBrowserRuntimeStatus(): BrowserRuntimeStatusResult {
  return {
    status: 'idle',
    inspectState,
    currentUrl,
    message: NOT_IMPLEMENTED_MESSAGE,
    snapshot: null,
  };
}

export function openBrowserPreview(
  request: OpenBrowserPreviewRequest = {}
): BrowserRuntimeStatusResult {
  currentUrl = request.url?.trim() || currentUrl || null;
  return {
    ...getBrowserRuntimeStatus(),
    message: currentUrl
      ? `Preview target recorded: ${currentUrl}. Real loading is not implemented yet.`
      : NOT_IMPLEMENTED_MESSAGE,
  };
}

export function reloadBrowserPreview(): BrowserRuntimeStatusResult {
  return {
    ...getBrowserRuntimeStatus(),
    message: 'Reload requested. Real browser reload is not implemented yet.',
  };
}

export function setBrowserInspectMode(
  request: SetBrowserInspectModeRequest
): BrowserRuntimeStatusResult {
  inspectState = request?.inspectState ?? 'off';
  return {
    ...getBrowserRuntimeStatus(),
    message: `Inspect mode set to ${inspectState}. DOM selection is not implemented yet.`,
  };
}

export function getSelectedPanelSnapshot(): PanelSnapshotResult {
  return {
    snapshot: null,
    message: 'No panel snapshot is available yet. DOM capture is reserved for a later stage.',
  };
}

export function attachPanelSnapshotToAgent(): AttachPanelSnapshotResult {
  return {
    attached: false,
    snapshot: null,
    message: 'Panel snapshot attachment is reserved for a later stage.',
  };
}
