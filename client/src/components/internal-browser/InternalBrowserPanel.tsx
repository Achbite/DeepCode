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
import { useSettingsStore } from '../../state/settingsStore';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';

const DEFAULT_PREVIEW_URL = 'http://127.0.0.1:5173/';

type BrowserAction =
  | 'idle'
  | 'status'
  | 'open'
  | 'reload'
  | 'inspect'
  | 'snapshot'
  | 'attach';

function statusMessage(
  runtime: BrowserRuntimeStatusResult | null,
  language: UiLanguage
): string {
  if (!runtime) return t(language, 'browser.status.idle');
  return runtime.message ?? t(language, 'browser.status.runtime', { status: runtime.status });
}

const InternalBrowserPanel: React.FC = () => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const [url, setUrl] = useState(DEFAULT_PREVIEW_URL);
  const [runtime, setRuntime] = useState<BrowserRuntimeStatusResult | null>(null);
  const [snapshot, setSnapshot] = useState<PanelSemanticSnapshot | null>(null);
  const [message, setMessage] = useState(t(language, 'browser.message.reserved'));
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
        setMessage(statusMessage(response.data, language));
      } else {
        setMessage(response.message ?? t(language, 'browser.message.statusUnavailable'));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const inspectState: BrowserInspectState = runtime?.inspectState ?? 'off';
  const busy = activeAction !== 'idle';

  return (
    <div className="internal-browser-panel">
      <div className="internal-browser-panel__toolbar">
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          aria-label={t(language, 'browser.previewUrl')}
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
                setMessage(statusMessage(response.data, language));
              } else {
                setMessage(response.message ?? t(language, 'browser.message.openUnavailable'));
              }
            })
          }
        >
          {t(language, 'browser.open')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            runAction('reload', async () => {
              const response = await reloadBrowserPreview();
              if (response.ok && response.data) {
                setRuntime(response.data);
                setMessage(statusMessage(response.data, language));
              } else {
                setMessage(response.message ?? t(language, 'browser.message.reloadUnavailable'));
              }
            })
          }
        >
          {t(language, 'browser.reload')}
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
                setMessage(statusMessage(response.data, language));
              } else {
                setMessage(response.message ?? t(language, 'browser.message.inspectUnavailable'));
              }
            })
          }
        >
          {inspectState === 'selecting'
            ? t(language, 'browser.stopInspect')
            : t(language, 'browser.inspect')}
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
                setMessage(response.data.message ?? t(language, 'browser.message.snapshotUnavailable'));
              } else {
                setMessage(response.message ?? t(language, 'browser.message.snapshotCaptureUnavailable'));
              }
            })
          }
        >
          {t(language, 'browser.snapshot')}
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
                setMessage(response.data.message ?? t(language, 'browser.message.attachmentReserved'));
              } else {
                setMessage(response.message ?? t(language, 'browser.message.attachUnavailable'));
              }
            })
          }
        >
          {t(language, 'browser.attachSnapshot')}
        </button>
      </div>

      <div className="internal-browser-panel__body">
        <section className="internal-browser-panel__preview">
          <div className="internal-browser-panel__placeholder">
            <strong>{t(language, 'browser.skeletonTitle')}</strong>
            <span>{busy ? t(language, 'browser.processing') : message}</span>
            <small>{t(language, 'browser.skeletonHint')}</small>
          </div>
        </section>
        <aside className="internal-browser-panel__inspector">
          <div className="internal-browser-panel__meta">
            <div>
              <span>{t(language, 'browser.status')}</span>
              <strong>{runtime?.status ?? 'idle'}</strong>
            </div>
            <div>
              <span>{t(language, 'browser.inspect')}</span>
              <strong>{inspectState}</strong>
            </div>
          </div>
          <PanelSnapshotCard
            snapshot={snapshot}
            message={message}
            attached={attached}
            language={language}
          />
        </aside>
      </div>
    </div>
  );
};

export default InternalBrowserPanel;
