import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  PrivateAnalysisItemV1,
  PrivateAnalysisLeaseReceiptV1,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import {
  getPrivateAnalysis,
  mintPrivateAnalysisLease,
  revokePrivateAnalysisLease,
} from '../../services/runtimeAdapter';

interface PrivateAnalysisViewerProps {
  sessionId: string;
  language: UiLanguage;
  onClose: () => void;
}

const PrivateAnalysisViewer: React.FC<PrivateAnalysisViewerProps> = ({
  sessionId,
  language,
  onClose,
}) => {
  const [items, setItems] = useState<PrivateAnalysisItemV1[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const leaseRef = useRef<PrivateAnalysisLeaseReceiptV1 | null>(null);
  const cursorRef = useRef<string | undefined>(undefined);
  const disposedRef = useRef(false);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  useEffect(() => {
    disposedRef.current = false;
    const controller = new AbortController();
    let pollTimer: number | undefined;

    const readToTail = async (capability: string): Promise<boolean> => {
      let cursor = cursorRef.current;
      for (let page = 0; page < 128; page += 1) {
        const result = await getPrivateAnalysis(
          sessionId,
          capability,
          { afterCursor: cursor, limit: 50 },
          controller.signal
        );
        if (disposedRef.current || controller.signal.aborted) return false;
        if (!result.ok || !result.data) {
          setError(result.message ?? result.error ?? t(language, 'deepcodeGui.analysis.loadFailed'));
          return false;
        }
        const pageItems = result.data.items;
        if (pageItems.length > 0) {
          setItems((current) => {
            const byId = new Map(current.map((item) => [item.analysisId, item]));
            for (const item of pageItems) byId.set(item.analysisId, item);
            return [...byId.values()].sort((left, right) =>
              Number(left.startedAtUnixMs) - Number(right.startedAtUnixMs)
            );
          });
        }
        cursor = result.data.nextCursor ?? cursor;
        cursorRef.current = cursor;
        if (!result.data.hasMore) return true;
        if (!result.data.nextCursor) {
          setError(t(language, 'deepcodeGui.analysis.cursorInvalid'));
          return false;
        }
      }
      setError(t(language, 'deepcodeGui.analysis.pageLimit'));
      return false;
    };

    const scheduleFollow = (capability: string) => {
      pollTimer = window.setTimeout(async () => {
        if (disposedRef.current) return;
        const caughtUp = await readToTail(capability);
        if (disposedRef.current) return;
        setFollowing(caughtUp);
        if (caughtUp) scheduleFollow(capability);
      }, 2_500);
    };

    void (async () => {
      const lease = await mintPrivateAnalysisLease(
        sessionId,
        `gui-private-analysis-${globalThis.crypto.randomUUID()}`
      );
      if (disposedRef.current || controller.signal.aborted) {
        if (lease.ok && lease.data) {
          void revokePrivateAnalysisLease(sessionId, lease.data.capability);
        }
        return;
      }
      if (!lease.ok || !lease.data) {
        setError(lease.message ?? lease.error ?? t(language, 'deepcodeGui.analysis.leaseFailed'));
        setLoading(false);
        return;
      }
      leaseRef.current = lease.data;
      const caughtUp = await readToTail(lease.data.capability);
      if (disposedRef.current) return;
      setLoading(false);
      setFollowing(caughtUp);
      if (caughtUp) scheduleFollow(lease.data.capability);
    })();

    return () => {
      disposedRef.current = true;
      controller.abort();
      if (pollTimer !== undefined) window.clearTimeout(pollTimer);
      const lease = leaseRef.current;
      leaseRef.current = null;
      if (lease?.sessionId === sessionId) {
        void revokePrivateAnalysisLease(sessionId, lease.capability);
      }
    };
  }, [language, sessionId]);

  const latestUserTurnId = useMemo(
    () => items.at(-1)?.userTurnId,
    [items]
  );

  return (
    <div className="deepcode-private-analysis" role="dialog" aria-modal="true">
      <div className="deepcode-private-analysis__backdrop" onClick={onClose} />
      <section className="deepcode-private-analysis__panel">
        <header>
          <div>
            <h2>{t(language, 'deepcodeGui.analysis.title')}</h2>
            <p>{t(language, 'deepcodeGui.analysis.privateHint')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t(language, 'window.close')}>×</button>
        </header>
        <div className="deepcode-private-analysis__status">
          {loading
            ? t(language, 'deepcodeGui.analysis.loading')
            : following
              ? t(language, 'deepcodeGui.analysis.following')
              : t(language, 'deepcodeGui.analysis.ready')}
        </div>
        {error && <div className="deepcode-private-analysis__error">{error}</div>}
        <div className="deepcode-private-analysis__items">
          {!loading && items.length === 0 && (
            <div className="deepcode-private-analysis__empty">
              {t(language, 'deepcodeGui.analysis.empty')}
            </div>
          )}
          {items.map((item) => (
            <details
              key={item.analysisId}
              open={item.userTurnId === latestUserTurnId}
              className="deepcode-private-analysis__item"
            >
              <summary>
                <span>{item.boundary}</span>
                <code>{item.requestId}</code>
                <time>{new Date(Number(item.startedAtUnixMs)).toLocaleTimeString()}</time>
                <strong data-status={item.status}>{item.status}</strong>
              </summary>
              {item.reasonCode && <p className="deepcode-private-analysis__reason">{item.reasonCode}</p>}
              {item.tools.length > 0 && (
                <ul>
                  {item.tools.map((tool) => (
                    <li key={`${item.analysisId}:${tool.name}:${tool.stage}`}>
                      <code>{tool.name}</code> · {tool.stage}
                    </li>
                  ))}
                </ul>
              )}
              <pre>{item.reasoning}</pre>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
};

export default PrivateAnalysisViewer;
