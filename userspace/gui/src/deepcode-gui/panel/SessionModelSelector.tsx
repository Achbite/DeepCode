import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextCompositionPartitionKind,
  ContextCompositionProjection,
  ContextUsageProjection,
  LlmProviderProfile,
  TokenUsageProjection,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { inputCacheMetric, type InputCacheMetric } from '../../utils/providerUsage';
import {
  buildContextCompositionLayout,
  CONTEXT_FOCUS_USED_PERCENT,
} from './contextCompositionLayout';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  selectedProfileId: string | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  tokenUsage: TokenUsageProjection | null;
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
  percentScope?: 'window';
}

interface ContextBarSegment {
  metric: ContextDisplayMetric;
  truePercent: number;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  profiles,
  selectedProfileId,
  contextUsage,
  contextCompositions,
  tokenUsage,
  busy = false,
  onProfileChange,
}) => {
  const [contextOpen, setContextOpen] = useState(false);
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
        if (
          contextCompositions[index].purpose === 'agent'
          && contextCompositions[index].providerRequestId === contextUsage.providerRequestId
        ) {
          return contextCompositions[index];
        }
      }
      return null;
    }
    return [...contextCompositions].reverse().find((receipt) => receipt.purpose === 'agent') ?? null;
  }, [contextCompositions, contextUsage]);
  const capacityMetrics = useMemo(
    () => buildCapacityMetrics(contextUsage, language),
    [contextUsage, language],
  );
  const requestSections = useMemo(
    () => buildRequestSections(contextReceipt, language),
    [contextReceipt, language],
  );
  const compositionSegments = useMemo(
    () => buildCompositionSegments(contextUsage, capacityMetrics, requestSections),
    [capacityMetrics, contextUsage, requestSections],
  );
  const focusedContextKey = hoverContextKey;
  const activeContextKey = focusedContextKey ?? 'input';
  const compositionLayout = useMemo(
    () => buildContextCompositionLayout(
      compositionSegments.map((segment) => ({
        key: segment.metric.key,
        truePercent: segment.truePercent,
      })),
      focusedContextKey,
    ),
    [compositionSegments, focusedContextKey],
  );
  const focusableCompositionKeys = useMemo(
    () => compositionSegments
      .filter((segment) => segment.metric.key !== 'free' && segment.truePercent > 0)
      .map((segment) => segment.metric.key),
    [compositionSegments],
  );
  const detailMetrics = useMemo(() => {
    const output = capacityMetrics.find((metric) => metric.key === 'output');
    return output ? [...requestSections, output] : requestSections;
  }, [capacityMetrics, requestSections]);
  const activeMetric = [...capacityMetrics, ...requestSections]
    .find((metric) => metric.key === activeContextKey)
    ?? capacityMetrics[0];
  const cache = inputCacheMetric(tokenUsage);
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

  useEffect(() => {
    if (!contextOpen) setHoverContextKey(null);
  }, [contextOpen]);

  const interactionProps = (key: ContextFocusKey) => ({
    onPointerEnter: () => setHoverContextKey(key),
    onPointerLeave: () => setHoverContextKey(null),
    onFocus: () => setHoverContextKey(key),
    onBlur: () => setHoverContextKey(null),
  });

  const focusCompositionAtPointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (focusableCompositionKeys.length === 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width <= 0) return;
    const pointerPercent = Math.max(
      0,
      Math.min(100, ((event.clientX - bounds.left) / bounds.width) * 100),
    );
    if (pointerPercent >= CONTEXT_FOCUS_USED_PERCENT) {
      setHoverContextKey(null);
      return;
    }
    const slotWidth = CONTEXT_FOCUS_USED_PERCENT / focusableCompositionKeys.length;
    const slotIndex = Math.min(
      focusableCompositionKeys.length - 1,
      Math.floor(pointerPercent / slotWidth),
    );
    setHoverContextKey(focusableCompositionKeys[slotIndex]);
  };

  const moveCompositionFocus = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    if (focusableCompositionKeys.length === 0) return;
    event.preventDefault();
    const currentIndex = focusedContextKey === null
      ? -1
      : focusableCompositionKeys.indexOf(focusedContextKey);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const start = currentIndex < 0
      ? (direction > 0 ? -1 : 0)
      : currentIndex;
    const nextIndex = (
      start + direction + focusableCompositionKeys.length
    ) % focusableCompositionKeys.length;
    setHoverContextKey(focusableCompositionKeys[nextIndex]);
  };

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

            <div className="deepcode-session-model__composition-stage">
              {contextUsage ? (
                <button
                  type="button"
                  className={[
                    'deepcode-session-model__composition-bar',
                    compositionLayout.focused ? 'is-focused' : '',
                  ].filter(Boolean).join(' ')}
                  aria-label={`${t(language, 'agent.context.composition')}: ${metricAriaLabel(activeMetric, language)}`}
                  onPointerMove={focusCompositionAtPointer}
                  onPointerLeave={() => setHoverContextKey(null)}
                  onFocus={() => {
                    if (focusedContextKey === null) setHoverContextKey(focusableCompositionKeys[0] ?? null);
                  }}
                  onBlur={() => setHoverContextKey(null)}
                  onKeyDown={moveCompositionFocus}
                >
                  {compositionSegments.map((segment, index) => (
                    <span
                      key={segment.metric.key}
                      className={[
                        'deepcode-session-model__composition-segment',
                        compositionLayout.focused
                          && segment.metric.key === focusedContextKey
                          ? 'is-active'
                          : '',
                      ].filter(Boolean).join(' ')}
                      data-context-key={segment.metric.key}
                      style={{ width: `${compositionLayout.widths[index] ?? 0}%` }}
                    />
                  ))}
                </button>
              ) : (
                <div className="deepcode-session-model__composition-bar deepcode-session-model__composition-bar--unknown">
                  {t(language, 'common.notAvailable')}
                </div>
              )}
            </div>

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
                <strong>
                  {t(language, 'agent.context.inputCache')}
                  {cache && !cache.complete && ` · ${t(language, 'agent.context.cachePartial', {
                    reported: cache.reportedCallCount,
                    calls: cache.providerCallCount,
                  })}`}
                </strong>
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
              {detailMetrics.length > 0
                ? detailMetrics.map((section) => (
                    <button
                      type="button"
                      key={section.key}
                      data-context-key={section.key}
                      className={section.key === activeContextKey ? 'is-active' : ''}
                      {...interactionProps(section.key)}
                    >
                      <span />
                      <strong>{section.label}</strong>
                      <small>{section.itemCount === undefined
                        ? ''
                        : formatItemCount(section.itemCount, language)}</small>
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
      percentScope: 'window',
    },
    {
      key: 'output',
      label: labels.output,
      tokens: usage.outputTokens,
      percent: percentOf(usage.outputTokens, usage.contextWindowTokens),
      percentScope: 'window',
    },
    {
      key: 'free',
      label: labels.free,
      tokens: freeTokens,
      percent: percentOf(freeTokens, usage.contextWindowTokens),
      percentScope: 'window',
    },
  ];
}

function buildCompositionSegments(
  usage: ContextUsageProjection | null,
  capacityMetrics: readonly ContextDisplayMetric[],
  requestSections: readonly ContextDisplayMetric[],
): ContextBarSegment[] {
  if (!usage || usage.contextWindowTokens <= 0) return [];
  const input = capacityMetrics.find((metric) => metric.key === 'input');
  const output = capacityMetrics.find((metric) => metric.key === 'output');
  const free = capacityMetrics.find((metric) => metric.key === 'free');
  if (!input || !output || !free) return [];

  const inputPercent = precisePercentOf(usage.inputTokens, usage.contextWindowTokens);
  const sectionWeight = requestSections.reduce(
    (total, section) => total + Math.max(0, section.percent ?? 0),
    0,
  );
  const inputSegments = requestSections.length > 0 && sectionWeight > 0
    ? requestSections.map((section) => ({
        metric: section,
        truePercent: inputPercent * (Math.max(0, section.percent ?? 0) / sectionWeight),
      }))
    : [{ metric: input, truePercent: inputPercent }];

  return [
    ...inputSegments,
    {
      metric: output,
      truePercent: precisePercentOf(usage.outputTokens, usage.contextWindowTokens),
    },
    {
      metric: free,
      truePercent: precisePercentOf(
        Math.max(0, usage.contextWindowTokens - usage.inputTokens - usage.outputTokens),
        usage.contextWindowTokens,
      ),
    },
  ];
}

function buildRequestSections(
  receipt: ContextCompositionProjection | null,
  language: UiLanguage,
): ContextDisplayMetric[] {
  if (!receipt) return [];
  const hasCompleteTokenEstimate = receipt.partitions.every((partition) => (
    partition.tokenSource === 'sessionEstimated'
    && partition.estimatedInputTokens !== undefined
  ));
  const totalWeight = receipt.partitions.reduce((total, partition) => (
    total + (hasCompleteTokenEstimate
      ? partition.estimatedInputTokens ?? 0
      : partition.requestShapeUnits)
  ), 0);
  return receipt.partitions.map((partition) => ({
    key: partition.kind,
    label: contextPartitionLabel(partition.kind, language),
    tokens: partition.tokenSource === 'sessionEstimated'
      ? partition.estimatedInputTokens ?? null
      : null,
    percent: percentOf(
      hasCompleteTokenEstimate
        ? partition.estimatedInputTokens ?? 0
        : partition.requestShapeUnits,
      totalWeight,
    ),
    itemCount: partition.itemCount,
    estimated: true,
  }));
}

function contextPartitionLabel(
  kind: ContextCompositionPartitionKind,
  language: UiLanguage,
): string {
  return t(language, `agent.context.partition.${kind}`);
}

function metricValue(metric: ContextDisplayMetric, language: UiLanguage): string {
  if (metric.tokens === null) {
    return metric.percent === null
      ? t(language, 'agent.context.tokensUnavailable')
      : t(language, 'agent.context.estimatedShare', {
          percent: formatPercent(metric.percent, true),
        });
  }
  const formattedPercent = metric.percent === null
    ? null
    : formatPercent(metric.percent, Boolean(metric.estimated));
  const percent = formattedPercent === null
    ? ''
    : metric.percentScope === 'window'
      ? ` · ${t(language, 'agent.context.windowShare', { percent: formattedPercent })}`
      : ` · ${formattedPercent}%`;
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
  return t(language, cache.complete
    ? 'agent.context.cacheAria'
    : 'agent.context.cachePartialAria', {
    input: formatTokens(cache.inputTokens, language),
    hit: formatTokens(cache.hitTokens, language),
    miss: formatTokens(cache.missTokens, language),
    reported: cache.reportedCallCount,
    calls: cache.providerCallCount,
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

function formatPercent(value: number, estimated = false): string {
  if (!Number.isFinite(value) || value === 0) return '0';
  const fractionDigits = estimated
    ? 1
    : value < 0.1
      ? 4
      : value < 10
        ? 3
        : 1;
  return value
    .toFixed(fractionDigits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
}

function percentOf(value: number, total: number): number | null {
  if (total <= 0) return null;
  return precisePercentOf(value, total);
}

function precisePercentOf(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

export default SessionModelSelector;
