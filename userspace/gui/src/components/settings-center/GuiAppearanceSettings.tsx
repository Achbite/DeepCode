import React, { useEffect, useMemo, useState } from 'react';
import type { TokenUsageRoundProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import {
  useSettingsStore,
  type SettingDefinition,
  type SettingSource,
} from '../../state/settingsStore';
import {
  GUI_ACCENT_COLORS,
  GUI_THEME_PREFERENCES,
  normalizeGuiAccentColor,
  normalizeGuiThemePreference,
  type GuiAccentColor,
  type GuiThemePreference,
} from '../../theme/deepcodeGuiTheme';
import { useLocalAgentStore } from '../../state/localAgentStore';
import {
  completeInputCacheMetric,
  type InputCacheMetric,
} from '../../utils/providerUsage';

interface GuiAppearanceSettingsProps {
  definitions: SettingDefinition[];
  language: UiLanguage;
}

const EMPTY_TOKEN_USAGE_HISTORY: TokenUsageRoundProjection[] = [];

function sourceLabel(source: SettingSource, language: UiLanguage): string {
  switch (source) {
    case 'workspace':
      return t(language, 'settings.source.workspace');
    case 'user':
      return t(language, 'settings.source.user');
    default:
      return t(language, 'settings.source.default');
  }
}

function optionLabel(definition: SettingDefinition, value: string): string {
  return definition.options?.find((option) => option.value === value)?.label ?? value;
}

interface AppearanceSettingHeaderProps {
  definition: SettingDefinition;
  source: SettingSource;
  language: UiLanguage;
  disabled: boolean;
  onReset: () => void;
}

const AppearanceSettingHeader: React.FC<AppearanceSettingHeaderProps> = ({
  definition,
  source,
  language,
  disabled,
  onReset,
}) => (
  <div className="settings-appearance__header">
    <div>
      <div className="settings-field__title-row">
        <span className="settings-field__label">{definition.label}</span>
        <span className={`settings-field__source settings-field__source--${source}`}>
          {sourceLabel(source, language)}
        </span>
      </div>
      <div className="settings-field__key">{definition.key}</div>
      <div className="settings-field__description">{definition.description}</div>
    </div>
    {source === 'user' && (
      <button
        className="settings-field__reset"
        type="button"
        disabled={disabled}
        onClick={onReset}
      >
        {t(language, 'settings.reset')}
      </button>
    )}
  </div>
);

const GuiAppearanceSettings: React.FC<GuiAppearanceSettingsProps> = ({
  definitions,
  language,
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const tokenUsage = useLocalAgentStore((state) => state.projection?.tokenUsage ?? null);
  const tokenUsageHistory = useLocalAgentStore((state) => (
    state.projection?.tokenUsageHistory ?? EMPTY_TOKEN_USAGE_HISTORY
  ));
  const [usagePage, setUsagePage] = useState(0);
  const themeDefinition = definitions.find((definition) => definition.key === 'gui.colorTheme');
  const accentDefinition = definitions.find((definition) => definition.key === 'gui.accentColor');
  const theme = normalizeGuiThemePreference(effectiveSettings['gui.colorTheme']);
  const accent = normalizeGuiAccentColor(effectiveSettings['gui.accentColor']);
  const themeSource = themeDefinition ? sources[themeDefinition.key] ?? 'default' : 'default';
  const accentSource = accentDefinition ? sources[accentDefinition.key] ?? 'default' : 'default';
  const themeDisabled = loading || themeSource === 'workspace';
  const accentDisabled = loading || accentSource === 'workspace';
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

  if (!themeDefinition && !accentDefinition) return null;

  const selectTheme = (value: GuiThemePreference, disabled: boolean) => {
    if (!disabled && value !== theme) void patchUserSetting('gui.colorTheme', value);
  };
  const selectAccent = (value: GuiAccentColor, disabled: boolean) => {
    if (!disabled && value !== accent) void patchUserSetting('gui.accentColor', value);
  };

  return (
    <div className="settings-card settings-appearance">
      <h3 className="settings-card__title">{t(language, 'settings.gui.appearance')}</h3>
      <div className="settings-appearance__body">
        {themeDefinition && (
          <section className="settings-appearance__setting">
            <AppearanceSettingHeader
              definition={themeDefinition}
              source={themeSource}
              language={language}
              disabled={themeDisabled}
              onReset={() => void resetUserSetting(themeDefinition.key)}
            />
            <div
              className="settings-theme-grid"
              role="group"
              aria-label={themeDefinition.label}
            >
              {GUI_THEME_PREFERENCES.map((value) => (
                <button
                  className="settings-theme-card"
                  type="button"
                  data-theme-choice={value}
                  aria-pressed={theme === value}
                  disabled={themeDisabled}
                  key={value}
                  onClick={() => selectTheme(value, themeDisabled)}
                >
                  <span className="settings-theme-preview" aria-hidden="true" />
                  <span>{optionLabel(themeDefinition, value)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {accentDefinition && (
          <section className="settings-appearance__setting">
            <AppearanceSettingHeader
              definition={accentDefinition}
              source={accentSource}
              language={language}
              disabled={accentDisabled}
              onReset={() => void resetUserSetting(accentDefinition.key)}
            />
            <div
              className="settings-accent-options"
              role="group"
              aria-label={accentDefinition.label}
            >
              {GUI_ACCENT_COLORS.map((value) => (
                <button
                  className="settings-accent-option"
                  type="button"
                  aria-pressed={accent === value}
                  disabled={accentDisabled}
                  key={value}
                  onClick={() => selectAccent(value, accentDisabled)}
                >
                  <span
                    className={`settings-accent-swatch settings-accent-swatch--${value}`}
                    aria-hidden="true"
                  />
                  <span>{optionLabel(accentDefinition, value)}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        <section className="settings-appearance__setting">
          <div className="settings-appearance__header">
            <div>
              <div className="settings-field__title-row">
                <span className="settings-field__label">
                  {language === 'zh-CN' ? '当前会话总用量' : 'Current session totals'}
                </span>
              </div>
              <div className="settings-field__description">
                {language === 'zh-CN'
                  ? '只读显示 Session 共享投影中的 Provider 用量与缓存事实。'
                  : 'Read-only Provider usage and cache facts from the shared Session projection.'}
              </div>
            </div>
          </div>
          <div className="settings-token-usage">
            <UsageStat
              label={language === 'zh-CN' ? 'Provider 调用' : 'Provider calls'}
              value={tokenUsage ? formatCount(tokenUsage.providerCallCount) : 'N/A'}
            />
            <UsageStat
              label={language === 'zh-CN' ? '输入 Token' : 'Input tokens'}
              value={tokenUsage ? formatCount(tokenUsage.inputTokens) : 'N/A'}
            />
            <UsageStat
              label={language === 'zh-CN' ? '输出 Token' : 'Output tokens'}
              value={tokenUsage ? formatCount(tokenUsage.outputTokens) : 'N/A'}
            />
            <UsageStat
              label={language === 'zh-CN' ? '总缓存命中率' : 'Total cache hit rate'}
              value={cacheHitRate(aggregateCache)}
            />
            <UsageStat
              label={language === 'zh-CN' ? '缓存读取 Token' : 'Cache-read tokens'}
              value={aggregateCache ? formatCount(aggregateCache.hitTokens) : 'N/A'}
            />
            <UsageStat
              label={language === 'zh-CN' ? '缓存未命中 Token' : 'Cache-miss tokens'}
              value={aggregateCache ? formatCount(aggregateCache.missTokens) : 'N/A'}
            />
          </div>
          <p className="settings-token-usage__note">
            {language === 'zh-CN'
              ? `Provider 缓存字段报告 ${tokenUsage?.cacheReportedCallCount ?? 0}/${tokenUsage?.providerCallCount ?? 0} 次；仅全部调用均报告时，按缓存读取输入 / 输入 Token 显示精确命中率。`
              : `Provider cache fields reported for ${tokenUsage?.cacheReportedCallCount ?? 0}/${tokenUsage?.providerCallCount ?? 0} calls; an exact hit rate is shown only when every call reports it, using cache-read input divided by input tokens.`}
          </p>
          <div className="settings-token-rounds">
            <div className="settings-token-rounds__heading">
              <div>
                <strong>{language === 'zh-CN' ? 'Provider 缓存命中历史' : 'Provider cache hit history'}</strong>
                <span>
                  {language === 'zh-CN'
                    ? '从新到旧排列；每页 10 条。每条汇总当前会话该轮内全部 Provider 调用。'
                    : 'Newest first, 10 per page. Each row aggregates every Provider call in that round for the current session.'}
                </span>
              </div>
              <span>{tokenUsageHistory.length}</span>
            </div>
            {visibleUsageRounds.length === 0 ? (
              <div className="settings-token-rounds__empty">
                {language === 'zh-CN' ? '当前对话还没有用量记录。' : 'No usage rounds for this conversation yet.'}
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
                >{language === 'zh-CN' ? '上一页' : 'Previous'}</button>
                <span>{effectiveUsagePage + 1} / {usagePageCount}</span>
                <button
                  type="button"
                  disabled={effectiveUsagePage + 1 >= usagePageCount}
                  onClick={() => setUsagePage((page) => Math.min(usagePageCount - 1, page + 1))}
                >{language === 'zh-CN' ? '下一页' : 'Next'}</button>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="settings-card__hint">{t(language, 'settings.gui.scopeHint')}</div>
    </div>
  );
};

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
  const missWidth = cache ? (cache.missTokens / cache.inputTokens) * 100 : 0;
  const inputWidth = cache
    ? Math.max(0, 100 - cacheWidth - missWidth)
    : round.inputTokens > 0 ? 100 : 0;
  return (
    <div className="settings-token-request">
      <div className="settings-token-request__header">
        <div className="settings-token-request__title">
          <span>#{ordinal}</span>
          <strong title={round.title}>{round.title}</strong>
        </div>
        <div className="settings-token-request__total">
          {formatCount(round.inputTokens + round.outputTokens)}
        </div>
      </div>
      <div className="settings-token-request__meta">
        <span>{formatRoundTime(round.startedAt)}</span>
        <span>
          {language === 'zh-CN'
            ? `${round.providerCallCount} 次 Provider 调用`
            : `${round.providerCallCount} Provider call(s)`}
        </span>
        <span>{roundOutcome(round, language)}</span>
        <span>{language === 'zh-CN' ? '缓存命中' : 'Cache hit'} {cacheHitRate(cache)}</span>
      </div>
      <div
        className="settings-token-request__track"
        role="img"
        aria-label={inputCacheAriaLabel(round.inputTokens, cache, language)}
      >
        <div className="settings-token-request__total-bar" style={{ width: '100%' }}>
          <span className="settings-token-request__segment settings-token-request__segment--cache" style={{ width: `${cacheWidth}%` }} />
          <span className="settings-token-request__segment settings-token-request__segment--miss" style={{ width: `${missWidth}%` }} />
          <span className="settings-token-request__segment settings-token-request__segment--input" style={{ width: `${inputWidth}%` }} />
        </div>
      </div>
      <div className="settings-token-request__legend">
        <span>{language === 'zh-CN' ? '输入' : 'Input'} {formatCount(round.inputTokens)}</span>
        <span>{language === 'zh-CN' ? '输出' : 'Output'} {formatCount(round.outputTokens)}</span>
        <span>
          {language === 'zh-CN' ? '缓存读取' : 'Cache read'} {cache
            ? formatCount(cache.hitTokens)
            : 'N/A'}
        </span>
        <span>
          {language === 'zh-CN' ? '缓存未命中' : 'Cache miss'} {cache
            ? formatCount(cache.missTokens)
            : 'N/A'}
        </span>
      </div>
    </div>
  );
};

function cacheHitRate(cache: InputCacheMetric | null): string {
  if (!cache) return 'N/A';
  return `${Math.round(cache.hitPercent)}%`;
}

function inputCacheAriaLabel(
  inputTokens: number,
  cache: InputCacheMetric | null,
  language: UiLanguage,
): string {
  if (!cache) {
    return language === 'zh-CN'
      ? `输入 ${formatCount(inputTokens)} Token；缓存用量未知`
      : `${formatCount(inputTokens)} input tokens; cache usage unknown`;
  }
  return language === 'zh-CN'
    ? `输入 ${formatCount(cache.inputTokens)} Token；缓存读取 ${formatCount(cache.hitTokens)}；缓存未命中 ${formatCount(cache.missTokens)}`
    : `${formatCount(cache.inputTokens)} input tokens; ${formatCount(cache.hitTokens)} cache-read and ${formatCount(cache.missTokens)} cache-miss tokens`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(value);
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
  if (!round.outcome) return language === 'zh-CN' ? '进行中' : 'Running';
  const labels = {
    completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    indeterminate: ['结果待确认', 'Indeterminate'],
  } as const;
  return labels[round.outcome][language === 'zh-CN' ? 0 : 1];
}

export default GuiAppearanceSettings;
