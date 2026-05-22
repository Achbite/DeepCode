import './internalBrowser.css';
import type React from 'react';
import { useEffect, useState } from 'react';
import type {
  BrowserInspectState,
  BrowserRuntimeStatusResult,
  PanelSemanticSnapshot,
} from '@deepcode/protocol';
import {
  attachPanelSnapshotToAgent,
  getBrowserRuntimeStatus,
  getSelectedPanelSnapshot,
  openBrowserPreview,
  reloadBrowserPreview,
  setBrowserInspectMode,
} from '../../services/runtimeAdapter';
import PanelSnapshotCard from './PanelSnapshotCard';

const DEFAULT_PREVIEW_URL = 'http://127.0.0.1:5173/';

type BrowserAction =
  | 'idle'
  | 'status'
  | 'open'
  | 'reload'
  | 'inspect'
  | 'snapshot'
  | 'attach';

function statusMessage(runtime: BrowserRuntimeStatusResult | null): string {
  if (!runtime) return 'Browser runtime skeleton is idle.';
  return runtime.message ?? `Browser runtime is ${runtime.status}.`;
}

const InternalBrowserPanel: React.FC = () => {
  const [url, setUrl] = useState(DEFAULT_PREVIEW_URL);
  const [runtime, setRuntime] = useState<BrowserRuntimeStatusResult | null>(null);
  const [snapshot, setSnapshot] = useState<PanelSemanticSnapshot | null>(null);
  const [message, setMessage] = useState('Browser preview skeleton is reserved for Stage 7.');
  const [activeAction, setActiveAction] = useState<BrowserAction>('idle');
  const [attached, setAttached] = useState(false);

  const runAction = async (
    action: BrowserAction,
    fn: () => Promise<void>
  ) => {
    setActiveAction(action);
    try {
      await fn();
    } finally {
      setActiveAction('idle');
    }
  };

  useEffect(() => {
    let cancelled = false;
    void runAction('status', async () => {
      const response = await getBrowserRuntimeStatus();
      if (cancelled) return;
      if (response.ok && response.data) {
        setRuntime(response.data);
        setSnapshot(response.data.snapshot ?? null);
        setMessage(statusMessage(response.data));
      } else {
        setMessage(response.message ?? 'Browser runtime status is not available.');
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const inspectState: BrowserInspectState = runtime?.inspectState ?? 'off';
  const busy = activeAction !== 'idle';

  return (
    <div className="internal-browser-panel">
      <div className="internal-browser-panel__toolbar">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label="Preview URL"
          placeholder="http://127.0.0.1:5173/"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            runAction('open', async () => {
              const response = await openBrowserPreview({ url });
              if (response.ok && response.data) {
                setRuntime(response.data);
                setMessage(statusMessage(response.data));
              } else {
                setMessage(response.message ?? 'Open preview is not implemented yet.');
              }
            })
          }
        >
          Open
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            runAction('reload', async () => {
              const response = await reloadBrowserPreview();
              if (response.ok && response.data) {
                setRuntime(response.data);
                setMessage(statusMessage(response.data));
              } else {
                setMessage(response.message ?? 'Reload preview is not implemented yet.');
              }
            })
          }
        >
          Reload
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            runAction('inspect', async () => {
              const nextState: BrowserInspectState = inspectState === 'selecting' ? 'off' : 'selecting';
              const response = await setBrowserInspectMode({ inspectState: nextState });
              if (response.ok && response.data) {
                setRuntime(response.data);
                setMessage(statusMessage(response.data));
              } else {
                setMessage(response.message ?? 'Inspect mode is not implemented yet.');
              }
            })
          }
        >
          {inspectState === 'selecting' ? 'Stop Inspect' : 'Inspect'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            runAction('snapshot', async () => {
              const response = await getSelectedPanelSnapshot();
              if (response.ok && response.data) {
                setSnapshot(response.data.snapshot);
                setAttached(false);
                setMessage(response.data.message ?? 'Panel snapshot is not available yet.');
              } else {
                setMessage(response.message ?? 'Panel snapshot capture is not implemented yet.');
              }
            })
          }
        >
          Snapshot
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            runAction('attach', async () => {
              const response = await attachPanelSnapshotToAgent();
              if (response.ok && response.data) {
                setSnapshot(response.data.snapshot);
                setAttached(response.data.attached);
                setMessage(response.data.message ?? 'Panel snapshot attachment is reserved.');
              } else {
                setMessage(response.message ?? 'Attach snapshot is not implemented yet.');
              }
            })
          }
        >
          Attach Snapshot
        </button>
      </div>

      <div className="internal-browser-panel__body">
        <section className="internal-browser-panel__preview">
          <div className="internal-browser-panel__placeholder">
            <strong>Internal Browser Skeleton</strong>
            <span>{busy ? 'Processing placeholder action...' : message}</span>
            <small>No dev server, iframe, DOM capture, or Agent injection is started in this stage.</small>
          </div>
        </section>
        <aside className="internal-browser-panel__inspector">
          <div className="internal-browser-panel__meta">
            <div>
              <span>Status</span>
              <strong>{runtime?.status ?? 'idle'}</strong>
            </div>
            <div>
              <span>Inspect</span>
              <strong>{inspectState}</strong>
            </div>
          </div>
          <PanelSnapshotCard snapshot={snapshot} message={message} attached={attached} />
        </aside>
      </div>
    </div>
  );
};

export default InternalBrowserPanel;
