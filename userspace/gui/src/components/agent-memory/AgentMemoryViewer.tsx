import React, { useEffect, useMemo } from 'react';
import type { AgentTimelineResult, AgentTimelineTokenUsageProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import './agentMemoryViewer.css';

interface AgentMemoryViewerProps {
  language: UiLanguage;
  timeline: AgentTimelineResult | null;
  sessionId?: string | null;
  refreshing?: boolean;
  onRefresh?: () => void | Promise<void>;
  onClose?: () => void;
}

const AgentMemoryViewer: React.FC<AgentMemoryViewerProps> = ({
  language,
  timeline,
  sessionId,
  refreshing = false,
  onRefresh,
  onClose,
}) => {
  const usage = useMemo(
    () => canonicalUsageForSession(timeline, sessionId ?? null),
    [timeline, sessionId]
  );

  useEffect(() => {
    if (!onClose) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <section className="agent-memory-viewer" aria-label={t(language, 'memoryV2.title')}>
      <header className="agent-memory-viewer__header">
        <div>
          <h2>{t(language, 'memoryV2.title')}</h2>
          <p>{t(language, 'memoryV2.subtitle')}</p>
        </div>
        <div className="agent-memory-viewer__actions">
          {onRefresh && (
            <button type="button" onClick={() => void onRefresh()} disabled={refreshing}>
              {refreshing
                ? t(language, 'memoryV2.refreshing')
                : t(language, 'memoryV2.refresh')}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose}>
              {t(language, 'memoryV2.close')}
            </button>
          )}
        </div>
      </header>

      {!usage ? (
        <div className="agent-memory-viewer__empty">
          <strong>{t(language, 'memoryV2.notFormed')}</strong>
          <span>{t(language, 'memoryV2.notFormedDetail')}</span>
        </div>
      ) : (
        <CanonicalUsage language={language} usage={usage} />
      )}
    </section>
  );
};

function CanonicalUsage({
  language,
  usage,
}: {
  language: UiLanguage;
  usage: AgentTimelineTokenUsageProjection;
}) {
  const labels = language === 'zh-CN'
    ? {
        title: '共享投影用量',
        cacheHit: 'Prompt 缓存命中',
        cacheMiss: 'Prompt 缓存未命中',
        completion: '生成 Token',
        total: '总 Token',
        calls: 'Provider 调用',
        requests: '请求明细',
      }
    : {
        title: 'Shared projection usage',
        cacheHit: 'Prompt cache hit',
        cacheMiss: 'Prompt cache miss',
        completion: 'Completion tokens',
        total: 'Total tokens',
        calls: 'Provider calls',
        requests: 'Requests',
      };
  const totals = usage.totals;
  return (
    <>
      <section className="agent-memory-viewer__section">
        <h3>{labels.title}</h3>
        <div className="agent-memory-viewer__stats">
          <UsageStat label={labels.cacheHit} value={totals.promptCacheHitTokens} language={language} />
          <UsageStat label={labels.cacheMiss} value={totals.promptCacheMissTokens} language={language} />
          <UsageStat label={labels.completion} value={totals.completionTokens} language={language} />
          <UsageStat label={labels.total} value={totals.totalTokens} language={language} />
          <UsageStat label={labels.calls} value={totals.providerCallCount} language={language} />
        </div>
        {totals.providers.length > 0 && (
          <p>{totals.providers.join(' · ')}</p>
        )}
      </section>

      {usage.requests.length > 0 && (
        <section className="agent-memory-viewer__section">
          <h3>{labels.requests}</h3>
          <div className="agent-memory-viewer__entries">
            {usage.requests.map((request) => (
              <article key={request.requestId}>
                <div>
                  <strong>{request.title}</strong>
                  <code>{request.requestId}</code>
                </div>
                <span>
                  {formatNumber(request.totalTokens, language)} tokens
                  {request.stages.length > 0 ? ` · ${request.stages.join(' → ')}` : ''}
                </span>
              </article>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function UsageStat({
  label,
  value,
  language,
}: {
  label: string;
  value: number;
  language: UiLanguage;
}) {
  return (
    <div>
      <strong>{formatNumber(value, language)}</strong>
      <span>{label}</span>
    </div>
  );
}

function canonicalUsageForSession(
  timeline: AgentTimelineResult | null,
  expectedSessionId: string | null
): AgentTimelineTokenUsageProjection | null {
  if (!timeline || (expectedSessionId && timeline.sessionId !== expectedSessionId)) {
    return null;
  }
  return timeline.tokenUsageProjection ?? null;
}

function formatNumber(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language === 'zh-CN' ? 'zh-CN' : 'en-US').format(value);
}

export default AgentMemoryViewer;
