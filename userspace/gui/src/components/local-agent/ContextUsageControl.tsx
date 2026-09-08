import React, { useEffect, useMemo, useState } from 'react';
import type { ContextCompositionProjection, ContextUsageProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { lastCallInputCacheMetric } from '../../utils/providerUsage';
import { buildContextCompositionLayout, CONTEXT_FOCUS_USED_PERCENT } from './contextCompositionLayout';
import {
  buildCapacityMetrics,
  buildCompositionSegments,
  buildRequestSections,
  metricValue,
  metricAriaLabel,
  cacheAriaLabel,
  formatItemCount,
  formatTokens,
  formatPercent,
  percentOf,
  type ContextFocusKey,
} from './contextUsageMetrics';

interface ContextUsageControlProps {
  language: UiLanguage;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  contextOpen: boolean;
  setContextOpen: React.Dispatch<React.SetStateAction<boolean>>;
  rootRef: React.RefObject<HTMLDivElement | null>;
  onToggle: () => void;
}

export function ContextUsageControl({
  language,
  contextUsage,
  contextCompositions,
  contextOpen,
  setContextOpen,
  rootRef,
  onToggle,
}: ContextUsageControlProps) {
  const [hoverContextKey, setHoverContextKey] = useState<ContextFocusKey | null>(null);
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
          contextCompositions[index].providerRequestId === contextUsage.providerRequestId
        ) {
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
  const cache = lastCallInputCacheMetric(contextUsage);
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
    <>
      <button
        type="button"
        className={`deepcode-session-model__context${contextPercent === null ? ' deepcode-session-model__context--unknown' : ''}`}
        style={{ '--deepcode-context-percent': `${contextPercent ?? 0}%` } as React.CSSProperties}
        aria-label={contextLabel}
        aria-expanded={contextOpen}
        disabled={!hasContextFacts}
        title={contextTitle}
        onClick={onToggle}
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
    </>
  );
}
