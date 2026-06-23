import React from 'react';
import type { AgentEvent, AgentTimelineTokenUsageProjection } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';
import {
  deriveTokenUsageStats,
  formatPercent,
  formatTokenCount,
  type TokenUsageRequestStats,
  type TokenUsageStats,
} from '../../../utils/tokenUsageStats';

interface TokenStatsSectionProps {
  events: AgentEvent[];
  tokenUsageProjection?: AgentTimelineTokenUsageProjection | null;
}

interface TokenBarRowProps {
  label: string;
  value: number;
  maxValue: number;
  tone?: 'cache' | 'miss' | 'completion' | 'neutral';
}

const TokenStatsSection: React.FC<TokenStatsSectionProps> = ({ events, tokenUsageProjection }) => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const stats = deriveTokenUsageStats(events, tokenUsageProjection);
  const maxValue = Math.max(
    stats.promptCacheHitTokens,
    stats.promptCacheMissTokens,
    stats.promptTokens,
    stats.completionTokens,
    stats.totalTokens,
    1
  );

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.token.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.token.overview')}</h3>
        <div className="settings-token-overview">
          <TokenMetric
            label={t(language, 'settings.token.cacheHitRate')}
            value={formatPercent(stats.cacheHitRate)}
            muted={!stats.hasCacheData}
          />
          <TokenMetric
            label={t(language, 'settings.token.totalTokens')}
            value={formatTokenCount(stats.totalTokens)}
            muted={!stats.hasTokenData}
          />
          <TokenMetric
            label={t(language, 'settings.token.requestCount')}
            value={formatTokenCount(stats.requestCount)}
            muted={stats.requestCount === 0}
          />
        </div>
        <div className="settings-card__hint">{t(language, 'settings.token.scopeHint')}</div>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.token.chart')}</h3>
        <div className="settings-token-bars">
          <TokenBarRow
            label={t(language, 'settings.token.cacheHitTokens')}
            value={stats.promptCacheHitTokens}
            maxValue={maxValue}
            tone="cache"
          />
          <TokenBarRow
            label={t(language, 'settings.token.cacheMissTokens')}
            value={stats.promptCacheMissTokens}
            maxValue={maxValue}
            tone="miss"
          />
          <TokenBarRow
            label={t(language, 'settings.token.promptTokens')}
            value={stats.promptTokens}
            maxValue={maxValue}
            tone="neutral"
          />
          <TokenBarRow
            label={t(language, 'settings.token.completionTokens')}
            value={stats.completionTokens}
            maxValue={maxValue}
            tone="completion"
          />
        </div>
        {!stats.hasTokenData && (
          <div className="settings-card__body settings-token-empty">
            {t(language, 'settings.token.empty')}
          </div>
        )}
      </div>

      <TokenRequestBreakdown stats={stats} />
      <TokenDetails stats={stats} />
    </div>
  );
};

const TokenMetric: React.FC<{ label: string; value: string; muted?: boolean }> = ({
  label,
  value,
  muted = false,
}) => (
  <div className={`settings-token-metric${muted ? ' settings-token-metric--muted' : ''}`}>
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);

const TokenBarRow: React.FC<TokenBarRowProps> = ({ label, value, maxValue, tone = 'neutral' }) => {
  const width = Math.max(0, Math.min(100, Math.round((value / maxValue) * 100)));
  return (
    <div className="settings-token-bar-row">
      <div className="settings-token-bar-row__meta">
        <span>{label}</span>
        <strong>{formatTokenCount(value)}</strong>
      </div>
      <div className="settings-token-bar-track" aria-hidden="true">
        <div
          className={`settings-token-bar-fill settings-token-bar-fill--${tone}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
};

const TokenDetails: React.FC<{ stats: TokenUsageStats }> = ({ stats }) => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  return (
    <div className="settings-card">
      <h3 className="settings-card__title">{t(language, 'settings.token.details')}</h3>
      <table className="settings-kv">
        <tbody>
          <tr>
            <td>{t(language, 'settings.token.cacheHitTokens')}</td>
            <td>{formatTokenCount(stats.promptCacheHitTokens)}</td>
          </tr>
          <tr>
            <td>{t(language, 'settings.token.cacheMissTokens')}</td>
            <td>{formatTokenCount(stats.promptCacheMissTokens)}</td>
          </tr>
          <tr>
            <td>{t(language, 'settings.token.cachedTokens')}</td>
            <td>{formatTokenCount(stats.cachedTokens)}</td>
          </tr>
          <tr>
            <td>{t(language, 'settings.token.promptTokens')}</td>
            <td>{formatTokenCount(stats.promptTokens)}</td>
          </tr>
          <tr>
            <td>{t(language, 'settings.token.completionTokens')}</td>
            <td>{formatTokenCount(stats.completionTokens)}</td>
          </tr>
          <tr>
            <td>{t(language, 'settings.token.totalTokens')}</td>
            <td>{formatTokenCount(stats.totalTokens)}</td>
          </tr>
          <tr>
            <td>{t(language, 'settings.token.providerCalls')}</td>
            <td>{formatTokenCount(stats.providerCallCount)}</td>
          </tr>
          <tr>
            <td>Provider</td>
            <td>{stats.providerIds.length > 0 ? stats.providerIds.join(', ') : '-'}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

const TokenRequestBreakdown: React.FC<{ stats: TokenUsageStats }> = ({ stats }) => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  if (stats.requests.length === 0) return null;
  const maxTotal = Math.max(...stats.requests.map((request) => request.totalTokens), 1);
  return (
    <div className="settings-card">
      <h3 className="settings-card__title">
        {t(language, 'settings.token.requestUsage')}
      </h3>
      <div className="settings-token-requests">
        {stats.requests.map((request, index) => (
          <TokenRequestRow
            key={request.id}
            request={request}
            index={index + 1}
            maxTotal={maxTotal}
            language={language}
          />
        ))}
      </div>
    </div>
  );
};

const TokenRequestRow: React.FC<{
  request: TokenUsageRequestStats;
  index: number;
  maxTotal: number;
  language: ReturnType<typeof normalizeUiLanguage>;
}> = ({ request, index, maxTotal, language }) => {
  const total = Math.max(request.totalTokens, request.promptTokens + request.completionTokens, 1);
  const totalWidth = Math.max(4, Math.round((request.totalTokens / maxTotal) * 100));
  const hitWidth = Math.max(0, Math.min(100, (request.promptCacheHitTokens / total) * 100));
  const missWidth = Math.max(0, Math.min(100, (request.promptCacheMissTokens / total) * 100));
  const completionWidth = Math.max(0, Math.min(100, (request.completionTokens / total) * 100));
  const providerLabel = request.providerIds.length > 0 ? request.providerIds.join(', ') : '-';
  const stageLabel = request.stages.length > 0 ? request.stages.join(', ') : '-';
  const timeLabel = request.startedAt ? formatRequestTime(request.startedAt) : '';

  return (
    <div className="settings-token-request">
      <div className="settings-token-request__header">
        <div className="settings-token-request__title">
          <span>#{index}</span>
          <strong title={request.title}>{request.title}</strong>
        </div>
        <div className="settings-token-request__total">
          {formatTokenCount(request.totalTokens)}
        </div>
      </div>
      <div className="settings-token-request__meta">
        <span>{providerLabel}</span>
        <span>{t(language, 'settings.token.providerCallCount', { count: request.providerCallCount })}</span>
        <span>{formatPercent(request.cacheHitRate)}</span>
        {timeLabel && <span>{timeLabel}</span>}
      </div>
      <div className="settings-token-request__track" aria-hidden="true">
        <div className="settings-token-request__total-bar" style={{ width: `${totalWidth}%` }}>
          <span
            className="settings-token-request__segment settings-token-request__segment--cache"
            style={{ width: `${hitWidth}%` }}
          />
          <span
            className="settings-token-request__segment settings-token-request__segment--miss"
            style={{ width: `${missWidth}%` }}
          />
          <span
            className="settings-token-request__segment settings-token-request__segment--completion"
            style={{ width: `${completionWidth}%` }}
          />
        </div>
      </div>
      <div className="settings-token-request__legend">
        <span>{t(language, 'settings.token.cacheHitTokens')} {formatTokenCount(request.promptCacheHitTokens)}</span>
        <span>{t(language, 'settings.token.cacheMissTokens')} {formatTokenCount(request.promptCacheMissTokens)}</span>
        <span>{t(language, 'settings.token.completionTokens')} {formatTokenCount(request.completionTokens)}</span>
        <span>{stageLabel}</span>
      </div>
    </div>
  );
};

function formatRequestTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default TokenStatsSection;
