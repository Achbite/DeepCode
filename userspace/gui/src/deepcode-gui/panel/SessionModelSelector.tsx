import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextCompositionPartitionKind,
  ContextCompositionProjection,
  ContextUsageProjection,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { inputCacheMetric, type InputCacheMetric } from '../../utils/providerUsage';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  selectedProfileId: string | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  onProfileChange: (profileId: string) => void | Promise<void>;
}

type ContextFocusKey = 'input' | 'output' | 'free' | ContextCompositionPartitionKind;

interface ContextDisplayMetric {
  key: ContextFocusKey;
  label: string;
  tokens: number | null;
  percent: number | null;
  itemCount?: number;
  estimated?: boolean;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  profiles,
  selectedProfileId,
  contextUsage,
  contextCompositions,
  busy = false,
  onProfileChange,
}) => {
  const [contextOpen, setContextOpen] = useState(false);
  const [pinnedContextKey, setPinnedContextKey] = useState<ContextFocusKey>('input');
  const [hoverContextKey, setHoverContextKey] = useState<ContextFocusKey | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const enabled = useMemo(
    () => profiles.filter((profile) => profile.enabled),
    [profiles],
  );
  const selected = enabled.find((profile) => profile.id === selectedProfileId);
  const disabled = busy || enabled.length === 0;
  const title = selected?.name ?? t(language, 'agent.profile.selectionRequired');
  const contextPercent = contextUsage
    ? percentOf(
        contextUsage.inputTokens + contextUsage.outputTokens,
        contextUsage.contextWindowTokens,
      )
    : null;
  const contextLabel = contextPercent === null
    ? t(language, 'common.notAvailable')
    : `${Math.round(contextPercent)}%`;
  const contextTitle = contextUsage
    ? t(language, 'agent.context.windowUsage', {
        used: formatTokens(contextUsage.inputTokens + contextUsage.outputTokens, language),
        capacity: formatTokens(contextUsage.contextWindowTokens, language),
      })
    : t(language, 'common.notAvailable');
  const contextReceipt = useMemo(() => {
    if (contextUsage) {
      for (let index = contextCompositions.length - 1; index >= 0; index -= 1) {
        if (contextCompositions[index].providerRequestId === contextUsage.providerRequestId) {
          return contextCompositions[index];
        }
      }
      return null;
    }
    return contextCompositions.at(-1) ?? null;
  }, [contextCompositions, contextUsage]);
  const capacityMetrics = useMemo(
    () => buildCapacityMetrics(contextUsage, language),
    [contextUsage, language],
  );
  const requestSections = useMemo(
    () => buildRequestSections(contextReceipt, language),
    [contextReceipt, language],
  );
  const activeContextKey = hoverContextKey ?? pinnedContextKey;
  const activeMetric = [...capacityMetrics, ...requestSections]
    .find((metric) => metric.key === activeContextKey)
    ?? capacityMetrics[0];
  const cache = inputCacheMetric(contextUsage);
  const hasContextFacts = Boolean(contextUsage || contextReceipt);

  useEffect(() => {
    if (!contextOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) setContextOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [contextOpen]);

  useEffect(() => {
    if (!hasContextFacts) setContextOpen(false);
  }, [hasContextFacts]);

  const interactionProps = (key: ContextFocusKey) => ({
    onPointerEnter: () => setHoverContextKey(key),
    onPointerLeave: () => setHoverContextKey(null),
    onFocus: () => setHoverContextKey(key),
    onBlur: () => setHoverContextKey(null),
    onClick: () => setPinnedContextKey(key),
  });

  return (
    <div ref={rootRef} className="deepcode-session-model">
      <button
        type="button"
        className={`deepcode-session-model__context${contextPercent === null ? ' deepcode-session-model__context--unknown' : ''}`}
        style={{ '--deepcode-context-percent': `${contextPercent ?? 0}%` } as React.CSSProperties}
        aria-label={contextLabel}
        aria-expanded={contextOpen}
        disabled={!hasContextFacts}
        title={contextTitle}
        onClick={() => setContextOpen((open) => !open)}
      >
        <span>{contextLabel}</span>
      </button>
      {contextOpen && hasContextFacts && (
        <section
          className="deepcode-session-model__context-popover"
          role="dialog"
          aria-label={t(language, 'agent.context.window')}
        >
          <header>
            <strong>{t(language, 'agent.context.window')}</strong>
          </header>
          <div className="deepcode-session-model__context-body">
            <div className="deepcode-session-model__context-total">
              <span>{t(language, 'agent.context.used')}</span>
              <strong>{contextTitle}</strong>
              <span>{contextLabel}</span>
            </div>
            <div
              className="deepcode-session-model__usage-track"
              role="progressbar"
              aria-label={contextTitle}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={contextPercent === null ? undefined : Math.round(contextPercent)}
            >
              <span style={{ width: `${contextPercent ?? 0}%` }} />
            </div>

            {contextUsage ? (
              <div
                className="deepcode-session-model__composition-bar"
                role="group"
                aria-label={t(language, 'agent.context.composition')}
              >
                {capacityMetrics.map((metric) => (
                  <button
                    type="button"
                    key={metric.key}
                    data-context-key={metric.key}
                    className={metric.key === activeContextKey ? 'is-active' : ''}
                    style={{ flexBasis: `${metric.percent ?? 0}%` }}
                    aria-label={metricAriaLabel(metric, language)}
                    aria-pressed={metric.key === pinnedContextKey}
                    {...interactionProps(metric.key)}
                  />
                ))}
              </div>
            ) : (
              <div className="deepcode-session-model__composition-bar deepcode-session-model__composition-bar--unknown">
                {t(language, 'common.notAvailable')}
              </div>
            )}

            <div className="deepcode-session-model__context-detail" aria-live="polite">
              <span data-context-key={activeMetric.key} />
              <div>
                <strong>{activeMetric.label}</strong>
                {activeMetric.itemCount !== undefined && (
                  <small>{formatItemCount(activeMetric.itemCount, language)}</small>
                )}
              </div>
              <span>{metricValue(activeMetric, language)}</span>
            </div>

            <div className="deepcode-session-model__cache">
              <div className="deepcode-session-model__cache-head">
                <strong>{t(language, 'agent.context.inputCache')}</strong>
                <span>{cache
                  ? `${formatPercent(cache.hitPercent)}%`
                  : t(language, 'common.notAvailable')}</span>
              </div>
              {cache ? (
                <>
                  <div
                    className="deepcode-session-model__cache-track"
                    role="img"
                    aria-label={cacheAriaLabel(cache, language)}
                  >
                    <span style={{ width: `${cache.hitPercent}%` }} />
                    <span />
                  </div>
                  <div className="deepcode-session-model__cache-legend">
                    <span>{t(language, 'agent.context.cacheHit')} {formatTokens(cache.hitTokens, language)}</span>
                    <span>{t(language, 'agent.context.cacheMiss')} {formatTokens(cache.missTokens, language)}</span>
                  </div>
                </>
              ) : (
                <div className="deepcode-session-model__cache-empty">
                  {t(language, 'common.notAvailable')}
                </div>
              )}
            </div>

            <div className="deepcode-session-model__context-sections">
              {requestSections.length > 0
                ? requestSections.map((section) => (
                    <button
                      type="button"
                      key={section.key}
                      data-context-key={section.key}
                      className={section.key === activeContextKey ? 'is-active' : ''}
                      aria-pressed={section.key === pinnedContextKey}
                      {...interactionProps(section.key)}
                    >
                      <span />
                      <strong>{section.label}</strong>
                      <small>{formatItemCount(section.itemCount ?? 0, language)}</small>
                      <span>{metricValue(section, language)}</span>
                    </button>
                  ))
                : (
                    <div className="deepcode-session-model__context-sections-empty">
                      {t(language, 'common.notAvailable')}
                    </div>
                  )}
            </div>
          </div>
        </section>
      )}
      <label className="deepcode-session-model__selector" title={title}>
          <span className="deepcode-session-model__label">
            {t(language, 'agent.profile.selector')}
          </span>
          <select
            value={selected?.id ?? ''}
            disabled={disabled}
            aria-label={t(language, 'agent.profile.selector')}
            onChange={(event) => {
              if (event.target.value) void onProfileChange(event.target.value);
            }}
          >
            {!selected && (
              <option value="">
                {enabled.length === 0
                  ? t(language, 'agent.profile.unavailable')
                  : t(language, 'agent.profile.selectionRequired')}
              </option>
            )}
            {enabled.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.model}
              </option>
            ))}
          </select>
      </label>
    </div>
  );
};

function buildCapacityMetrics(
  usage: ContextUsageProjection | null,
  language: UiLanguage,
): ContextDisplayMetric[] {
  const labels = {
    input: t(language, 'agent.context.capacity.input'),
    output: t(language, 'agent.context.capacity.output'),
    free: t(language, 'agent.context.capacity.free'),
  };
  if (!usage) {
    return [
      { key: 'input', label: labels.input, tokens: null, percent: null },
      { key: 'output', label: labels.output, tokens: null, percent: null },
      { key: 'free', label: labels.free, tokens: null, percent: null },
    ];
  }
  const freeTokens = Math.max(
    0,
    usage.contextWindowTokens - usage.inputTokens - usage.outputTokens,
  );
  return [
    {
      key: 'input',
      label: labels.input,
      tokens: usage.inputTokens,
      percent: percentOf(usage.inputTokens, usage.contextWindowTokens),
    },
    {
      key: 'output',
      label: labels.output,
      tokens: usage.outputTokens,
      percent: percentOf(usage.outputTokens, usage.contextWindowTokens),
    },
    {
      key: 'free',
      label: labels.free,
      tokens: freeTokens,
      percent: percentOf(freeTokens, usage.contextWindowTokens),
    },
  ];
}

function buildRequestSections(
  receipt: ContextCompositionProjection | null,
  language: UiLanguage,
): ContextDisplayMetric[] {
  if (!receipt) return [];
  return receipt.partitions.map((partition) => ({
    key: partition.kind,
    label: contextPartitionLabel(partition.kind, language),
    tokens: partition.tokenSource === 'sessionEstimated'
      ? partition.estimatedInputTokens ?? null
      : null,
    percent: null,
    itemCount: partition.itemCount,
    estimated: partition.tokenSource === 'sessionEstimated',
  }));
}

function contextPartitionLabel(
  kind: ContextCompositionPartitionKind,
  language: UiLanguage,
): string {
  return t(language, `agent.context.partition.${kind}`);
}

function metricValue(metric: ContextDisplayMetric, language: UiLanguage): string {
  if (metric.tokens === null) return t(language, 'agent.context.tokensUnavailable');
  const percent = metric.percent === null ? '' : ` · ${formatPercent(metric.percent)}%`;
  const estimate = metric.estimated ? '≈' : '';
  return t(language, 'agent.context.tokenMetric', {
    estimate,
    tokens: formatTokens(metric.tokens, language),
    percent,
  });
}

function metricAriaLabel(metric: ContextDisplayMetric, language: UiLanguage): string {
  return `${metric.label} ${metricValue(metric, language)}`;
}

function cacheAriaLabel(
  cache: InputCacheMetric,
  language: UiLanguage,
): string {
  return t(language, 'agent.context.cacheAria', {
    input: formatTokens(cache.inputTokens, language),
    hit: formatTokens(cache.hitTokens, language),
    miss: formatTokens(cache.missTokens, language),
  });
}

function formatItemCount(value: number, language: UiLanguage): string {
  return t(language, 'agent.context.itemCount', {
    count: value.toLocaleString(language),
  });
}

function formatTokens(value: number, language: UiLanguage): string {
  return value.toLocaleString(language);
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function percentOf(value: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.round((value / total) * 1_000) / 10);
}

export default SessionModelSelector;
