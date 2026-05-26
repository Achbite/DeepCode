import type {
  AttachPanelSnapshotResult,
  BrowserActionResult,
  BrowserRuntimeAction,
  BrowserRuntimeCapabilities,
  BrowserRuntimeStatusResult,
  OpenBrowserPreviewRequest,
  PanelSnapshotResult,
  SetBrowserInspectModeRequest,
} from '@deepcode/protocol';

const NOT_IMPLEMENTED_MESSAGE =
  'Internal browser runtime is a skeleton only. Real preview loading, DOM capture, and Agent attachment are reserved for a later stage.';

let currentUrl: string | null = null;
let inspectState: BrowserRuntimeStatusResult['inspectState'] = 'off';
let lastAction: BrowserRuntimeAction | null = null;
let lastActionAt: string | null = null;
let lastActionResult: BrowserActionResult | null = null;
let attached = false;

const CAPABILITIES: BrowserRuntimeCapabilities = {
  status: 'available',
  openTargetRecording: 'available',
  reloadRecording: 'available',
  inspectModeRecording: 'available',
  domCapture: 'reserved',
  agentAttachment: 'reserved',
};

function recordAction(action: BrowserRuntimeAction, result: BrowserActionResult): void {
  lastAction = action;
  lastActionAt = new Date().toISOString();
  lastActionResult = result;
}

export function getBrowserRuntimeStatus(): BrowserRuntimeStatusResult {
  const status: BrowserRuntimeStatusResult['status'] = 'idle';
  const snapshot = null;
  return {
    status,
    inspectState,
    currentUrl,
    message: NOT_IMPLEMENTED_MESSAGE,
    snapshot,
    lastAction,
    lastActionAt,
    capabilities: CAPABILITIES,
    diagnostics: {
      currentUrl,
      runtimeStatus: status,
      inspectState,
      hasSnapshot: Boolean(snapshot),
      attached,
      lastAction,
      lastActionAt,
      lastActionResult,
    },
  };
}

export function openBrowserPreview(
  request: OpenBrowserPreviewRequest = {}
): BrowserRuntimeStatusResult {
  currentUrl = request.url?.trim() || currentUrl || null;
  recordAction('open', currentUrl ? 'ok' : 'unavailable');
  return {
    ...getBrowserRuntimeStatus(),
    message: currentUrl
      ? `Preview target recorded: ${currentUrl}. Real loading is not implemented yet.`
      : NOT_IMPLEMENTED_MESSAGE,
  };
}

export function reloadBrowserPreview(): BrowserRuntimeStatusResult {
  recordAction('reload', 'ok');
  return {
    ...getBrowserRuntimeStatus(),
    message: 'Reload requested. Real browser reload is not implemented yet.',
  };
}

export function setBrowserInspectMode(
  request: SetBrowserInspectModeRequest
): BrowserRuntimeStatusResult {
  inspectState = request?.inspectState ?? 'off';
  recordAction('inspect', 'ok');
  return {
    ...getBrowserRuntimeStatus(),
    message: `Inspect mode set to ${inspectState}. DOM selection is not implemented yet.`,
  };
}

export function getSelectedPanelSnapshot(): PanelSnapshotResult {
  recordAction('snapshot', 'reserved');
  return {
    snapshot: null,
    message: 'No panel snapshot is available yet. DOM capture is reserved for a later stage.',
  };
}

export function attachPanelSnapshotToAgent(): AttachPanelSnapshotResult {
  attached = false;
  recordAction('attach', 'reserved');
  return {
    attached: false,
    snapshot: null,
    message: 'Panel snapshot attachment is reserved for a later stage.',
  };
}
