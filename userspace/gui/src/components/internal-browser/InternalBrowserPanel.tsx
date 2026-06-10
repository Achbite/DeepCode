import './internalBrowser.css';
import type React from 'react';
import { useEffect, useState } from 'react';
import type {
  BrowserRuntimeCapability,
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
const CAPABILITY_ORDER: BrowserRuntimeCapability[] = [
  'status',
  'openTargetRecording',
  'reloadRecording',
  'inspectModeRecording',
  'domCapture',
  'agentAttachment',
];

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

function translatedValue(
  language: UiLanguage,
  keyPrefix: string,
  value?: string | null
): string {
  return value ? t(language, `${keyPrefix}.${value}`) : t(language, 'browser.none');
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

  const applyRuntime = (
    data: BrowserRuntimeStatusResult,
    nextMessage?: string
  ) => {
    setRuntime(data);
    setSnapshot(data.snapshot ?? null);
    setAttached(data.diagnostics?.attached ?? false);
    setMessage(nextMessage ?? statusMessage(data, language));
  };

  const refreshRuntime = async (nextMessage?: string) => {
    const response = await getBrowserRuntimeStatus();
    if (response.ok && response.data) {
      applyRuntime(response.data, nextMessage);
    }
  };

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
        applyRuntime(response.data);
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
  const previewUrl = runtime?.currentUrl || url;

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
                applyRuntime(response.data);
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
                applyRuntime(response.data);
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
                applyRuntime(response.data);
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
                await refreshRuntime(
                  response.data.message ?? t(language, 'browser.message.snapshotUnavailable')
                );
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
                await refreshRuntime(
                  response.data.message ?? t(language, 'browser.message.attachmentReserved')
                );
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
          {previewUrl ? (
            <iframe
              key={previewUrl}
              className="internal-browser-panel__frame"
              title="DeepCode internal browser"
              src={previewUrl}
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            />
          ) : (
            <div className="internal-browser-panel__placeholder">
              <strong>{t(language, 'browser.skeletonTitle')}</strong>
              <span>{busy ? t(language, 'browser.processing') : message}</span>
              <small>{t(language, 'browser.skeletonHint')}</small>
            </div>
          )}
        </section>
        <aside className="internal-browser-panel__inspector">
          <div className="internal-browser-panel__meta">
            <div>
              <span>{t(language, 'browser.status')}</span>
              <strong>{translatedValue(language, 'browser.runtimeStatus', runtime?.status ?? 'idle')}</strong>
            </div>
            <div>
              <span>{t(language, 'browser.inspect')}</span>
              <strong>{translatedValue(language, 'browser.inspectState', inspectState)}</strong>
            </div>
          </div>
          <section className="browser-test-status-card">
            <div className="browser-test-status-card__title">
              {t(language, 'browser.testStatus')}
            </div>
            <div className="browser-test-status-card__capabilities">
              {CAPABILITY_ORDER.map((capability) => {
                const state = runtime?.capabilities?.[capability] ?? 'reserved';
                return (
                  <div key={capability} className="browser-test-status-card__capability">
                    <span>{t(language, `browser.capability.${capability}`)}</span>
                    <strong className={`browser-test-status-card__state browser-test-status-card__state--${state}`}>
                      {t(language, `browser.capabilityState.${state}`)}
                    </strong>
                  </div>
                );
              })}
            </div>
            <dl className="browser-test-status-card__diagnostics">
              <div>
                <dt>{t(language, 'browser.currentUrl')}</dt>
                <dd>{runtime?.diagnostics?.currentUrl || t(language, 'browser.none')}</dd>
              </div>
              <div>
                <dt>{t(language, 'browser.lastAction')}</dt>
                <dd>{translatedValue(language, 'browser.action', runtime?.diagnostics?.lastAction)}</dd>
              </div>
              <div>
                <dt>{t(language, 'browser.lastActionAt')}</dt>
                <dd>{runtime?.diagnostics?.lastActionAt || t(language, 'browser.none')}</dd>
              </div>
              <div>
                <dt>{t(language, 'browser.lastActionResult')}</dt>
                <dd>{translatedValue(language, 'browser.actionResult', runtime?.diagnostics?.lastActionResult)}</dd>
              </div>
              <div>
                <dt>{t(language, 'browser.hasSnapshot')}</dt>
                <dd>{runtime?.diagnostics?.hasSnapshot ? t(language, 'browser.yes') : t(language, 'browser.no')}</dd>
              </div>
              <div>
                <dt>{t(language, 'browser.snapshotAttached')}</dt>
                <dd>{runtime?.diagnostics?.attached ? t(language, 'browser.yes') : t(language, 'browser.no')}</dd>
              </div>
            </dl>
          </section>
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
