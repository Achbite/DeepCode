import React, { useEffect, useMemo, useState } from 'react';
import type { TokenUsageRoundProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { completeInputCacheMetric, type InputCacheMetric } from '../../utils/providerUsage';

const EMPTY_TOKEN_USAGE_HISTORY: TokenUsageRoundProjection[] = [];

export default function ModelUsageSettings({ language }: { language: UiLanguage }) {
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const tokenUsage = useLocalAgentStore((state) => state.projection?.tokenUsage ?? null);
  const tokenUsageHistory = useLocalAgentStore((state) => (
    state.projection?.tokenUsageHistory ?? EMPTY_TOKEN_USAGE_HISTORY
  ));
  const [usagePage, setUsagePage] = useState(0);
  const usagePageCount = Math.max(1, Math.ceil(tokenUsageHistory.length / 10));
  const effectiveUsagePage = Math.min(usagePage, usagePageCount - 1);
  const visibleUsageRounds = useMemo(
    () => tokenUsageHistory.slice(effectiveUsagePage * 10, effectiveUsagePage * 10 + 10),
    [effectiveUsagePage, tokenUsageHistory],
  );
  const aggregateCache = completeInputCacheMetric(tokenUsage);

  useEffect(() => {
    setUsagePage(0);
  }, [sessionId, tokenUsageHistory.length]);

  return <div className="settings-card settings-card__body">
        <section className="settings-appearance__setting">
          <div className="settings-appearance__header">
            <div>
              <div className="settings-field__title-row">
                <span className="settings-field__label">
                  {t(language, 'settings.gui.usage.title')}
                </span>
              </div>
            </div>
          </div>
          <div className="settings-token-usage">
            <UsageStat
              label={t(language, 'settings.gui.usage.providerCalls')}
              value={tokenUsage
                ? formatCount(tokenUsage.providerCallCount, language)
                : t(language, 'common.notAvailable')}
            />
            <UsageStat
              label={t(language, 'settings.gui.usage.inputTokens')}
              value={tokenUsage
                ? formatCount(tokenUsage.inputTokens, language)
                : t(language, 'common.notAvailable')}
            />
            <UsageStat
              label={t(language, 'settings.gui.usage.outputTokens')}
              value={tokenUsage
                ? formatCount(tokenUsage.outputTokens, language)
                : t(language, 'common.notAvailable')}
            />
            <UsageStat
              label={t(language, 'settings.gui.usage.totalCacheHitRate')}
              value={cacheHitRate(aggregateCache, language)}
            />
            <UsageStat
              label={t(language, 'settings.gui.usage.cacheReadTokens')}
              value={aggregateCache
                ? formatCount(aggregateCache.hitTokens, language)
                : t(language, 'common.notAvailable')}
            />
            <UsageStat
              label={t(language, 'settings.gui.usage.cacheMissTokens')}
              value={aggregateCache
                ? formatCount(aggregateCache.missTokens, language)
                : t(language, 'common.notAvailable')}
            />
          </div>
          <p className="settings-token-usage__note">
            {t(language, 'settings.gui.usage.cacheCoverage', {
              reported: tokenUsage?.reportedCallCount ?? 0,
              total: tokenUsage?.providerCallCount ?? 0,
            })}
          </p>
          <div className="settings-token-rounds">
            <div className="settings-token-rounds__heading">
              <div>
                <strong>{t(language, 'settings.gui.usage.historyTitle')}</strong>
              </div>
              <span>{tokenUsageHistory.length}</span>
            </div>
            {visibleUsageRounds.length === 0 ? (
              <div className="settings-token-rounds__empty">
                {t(language, 'settings.gui.usage.historyEmpty')}
              </div>
            ) : (
              <div className="settings-token-requests settings-token-requests--rounds">
                {visibleUsageRounds.map((round, index) => (
                  <UsageRound
                    key={round.runId}
                    round={round}
                    ordinal={effectiveUsagePage * 10 + index + 1}
                    language={language}
                  />
                ))}
              </div>
            )}
            {usagePageCount > 1 && (
              <div className="settings-token-pagination">
                <button
                  type="button"
                  disabled={effectiveUsagePage === 0}
                  onClick={() => setUsagePage((page) => Math.max(0, page - 1))}
                >{t(language, 'settings.common.previous')}</button>
                <span>{effectiveUsagePage + 1} / {usagePageCount}</span>
                <button
                  type="button"
                  disabled={effectiveUsagePage + 1 >= usagePageCount}
                  onClick={() => setUsagePage((page) => Math.min(usagePageCount - 1, page + 1))}
                >{t(language, 'settings.common.next')}</button>
              </div>
            )}
          </div>
        </section>
  </div>;
}

const UsageStat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="settings-token-usage__item">
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const UsageRound: React.FC<{
  round: TokenUsageRoundProjection;
  ordinal: number;
  language: UiLanguage;
}> = ({ round, ordinal, language }) => {
  const cache = completeInputCacheMetric(round);
  const cacheWidth = cache ? cache.hitPercent : 0;
  return (
    <div className="settings-token-request">
      <div className="settings-token-request__header">
        <div className="settings-token-request__title">
          <span>#{ordinal}</span>
          <strong title={round.title}>{round.title}</strong>
        </div>
        <div className="settings-token-request__total">
          {formatCount(round.inputTokens + round.outputTokens, language)}
        </div>
      </div>
      <div className="settings-token-request__meta">
        <span>{formatRoundTime(round.startedAt)}</span>
        <span>
          {t(language, 'settings.gui.usage.roundProviderCalls', {
            count: formatCount(round.providerCallCount, language),
          })}
        </span>
        <span>{roundOutcome(round, language)}</span>
        <span>{t(language, 'settings.gui.usage.cacheHit')} {cacheHitRate(cache, language)}</span>
      </div>
      <div
        className="settings-token-request__track"
        role="img"
        aria-label={inputCacheAriaLabel(round.inputTokens, cache, language)}
      >
        <div className="settings-token-request__total-bar" style={{ width: '100%' }}>
          <span className="settings-token-request__segment settings-token-request__segment--cache" style={{ width: `${cacheWidth}%` }} />
          <span className="settings-token-request__segment settings-token-request__segment--miss" style={{ flex: '1 1 0' }} />
        </div>
      </div>
      <div className="settings-token-request__legend">
        <span>{t(language, 'settings.gui.usage.input')} {formatCount(round.inputTokens, language)}</span>
        <span>{t(language, 'settings.gui.usage.output')} {formatCount(round.outputTokens, language)}</span>
        <span>
          {t(language, 'settings.gui.usage.cacheRead')} {cache
            ? formatCount(cache.hitTokens, language)
            : t(language, 'common.notAvailable')}
        </span>
        <span>
          {t(language, 'settings.gui.usage.cacheMiss')} {cache
            ? formatCount(cache.missTokens, language)
            : t(language, 'common.notAvailable')}
        </span>
      </div>
    </div>
  );
};

function cacheHitRate(cache: InputCacheMetric | null, language: UiLanguage): string {
  if (!cache) return t(language, 'common.notAvailable');
  return `${Math.round(cache.hitPercent)}%`;
}

function inputCacheAriaLabel(
  inputTokens: number,
  cache: InputCacheMetric | null,
  language: UiLanguage,
): string {
  if (!cache) {
    return t(language, 'settings.gui.usage.cacheUnknownAria', {
      input: formatCount(inputTokens, language),
    });
  }
  return t(language, 'settings.gui.usage.cacheAria', {
    input: formatCount(cache.inputTokens, language),
    hit: formatCount(cache.hitTokens, language),
    miss: formatCount(cache.missTokens, language),
  });
}

function formatCount(value: number, language: UiLanguage): string {
  return new Intl.NumberFormat(language).format(value);
}

function formatRoundTime(value: string): string {
  const epochMillis = /^\d+$/u.test(value) ? Number(value) : Number.NaN;
  const date = new Date(Number.isFinite(epochMillis) ? epochMillis : value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function roundOutcome(round: TokenUsageRoundProjection, language: UiLanguage): string {
  return t(language, `settings.gui.usage.outcome.${round.outcome ?? 'running'}`);
}
