import type { FastifyInstance } from 'fastify';
import type {
  ApiResponse,
  AttachPanelSnapshotResult,
  BrowserRuntimeStatusResult,
  OpenBrowserPreviewRequest,
  PanelSnapshotResult,
  SetBrowserInspectModeRequest,
} from '@deepcode/protocol';
import {
  attachPanelSnapshotToAgent,
  getBrowserRuntimeStatus,
  getSelectedPanelSnapshot,
  openBrowserPreview,
  reloadBrowserPreview,
  setBrowserInspectMode,
} from '../services/browserRuntimeService.js';

export async function registerBrowserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/browser/runtime-status', async () => {
    return {
      ok: true,
      data: getBrowserRuntimeStatus(),
    } satisfies ApiResponse<BrowserRuntimeStatusResult>;
  });

  app.post('/api/browser/open', async (request) => {
    return {
      ok: true,
      data: openBrowserPreview(request.body as OpenBrowserPreviewRequest | undefined),
    } satisfies ApiResponse<BrowserRuntimeStatusResult>;
  });

  app.post('/api/browser/reload', async () => {
    return {
      ok: true,
      data: reloadBrowserPreview(),
    } satisfies ApiResponse<BrowserRuntimeStatusResult>;
  });

  app.post('/api/browser/inspect-mode', async (request) => {
    return {
      ok: true,
      data: setBrowserInspectMode(request.body as SetBrowserInspectModeRequest),
    } satisfies ApiResponse<BrowserRuntimeStatusResult>;
  });

  app.get('/api/browser/panel-snapshot', async () => {
    return {
      ok: true,
      data: getSelectedPanelSnapshot(),
    } satisfies ApiResponse<PanelSnapshotResult>;
  });

  app.post('/api/browser/panel-snapshot/attach', async () => {
    return {
      ok: true,
      data: attachPanelSnapshotToAgent(),
    } satisfies ApiResponse<AttachPanelSnapshotResult>;
  });
}
