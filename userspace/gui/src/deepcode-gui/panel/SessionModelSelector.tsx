import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextCompositionCategoryKind,
  ContextCompositionProjection,
  ContextUsageProjection,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  selectedProfileId: string | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  readOnly?: boolean;
  onProfileChange: (profileId: string) => void | Promise<void>;
}

type ContextFocusKey = 'input' | 'output' | 'free' | ContextCompositionCategoryKind;

interface ContextDisplayMetric {
  key: ContextFocusKey;
  label: string;
  tokens: number | null;
  percent: number | null;
  itemCount?: number;
  estimated?: boolean;
}

const CONTEXT_SECTION_ORDER: readonly ContextCompositionCategoryKind[] = [
  'instructions',
  'sessionControls',
  'tools',
  'workspaceBindings',
  'contextProviders',
  'journalMessages',
  'messageAttachments',
];

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  profiles,
  selectedProfileId,
  contextUsage,
  contextCompositions,
  busy = false,
  readOnly = false,
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
  const contextLabel = contextPercent === null ? 'N/A' : `${Math.round(contextPercent)}%`;
  const contextTitle = contextUsage
    ? `${formatTokens(contextUsage.inputTokens + contextUsage.outputTokens, language)} / ${formatTokens(contextUsage.contextWindowTokens, language)} Token`
    : 'N/A';
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
  const cache = buildCacheMetric(contextUsage);
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
          aria-label={language === 'zh-CN' ? '上下文窗口' : 'Context window'}
        >
          <header>
            <strong>{language === 'zh-CN' ? '上下文窗口' : 'Context window'}</strong>
          </header>
          <div className="deepcode-session-model__context-body">
            <div className="deepcode-session-model__context-total">
              <span>{language === 'zh-CN' ? '已用上下文' : 'Context used'}</span>
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
                aria-label={language === 'zh-CN' ? '上下文用量构成' : 'Context usage composition'}
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
                N/A
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
                <strong>{language === 'zh-CN' ? '输入缓存' : 'Input cache'}</strong>
                <span>{cache.percent === null ? 'N/A' : `${formatPercent(cache.percent)}%`}</span>
              </div>
              {cache.percent !== null ? (
                <>
                  <div
                    className="deepcode-session-model__cache-track"
                    role="img"
                    aria-label={cacheAriaLabel(cache, language)}
                  >
                    <span style={{ width: `${cache.percent}%` }} />
                    <span />
                  </div>
                  <div className="deepcode-session-model__cache-legend">
                    <span>{language === 'zh-CN' ? '命中' : 'Hit'} {formatTokens(cache.hit!, language)}</span>
                    <span>{language === 'zh-CN' ? '未命中' : 'Miss'} {formatTokens(cache.miss!, language)}</span>
                  </div>
                </>
              ) : (
                <div className="deepcode-session-model__cache-empty">N/A</div>
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
                : <div className="deepcode-session-model__context-sections-empty">N/A</div>}
            </div>
          </div>
        </section>
      )}
      {readOnly ? (
        <span className="deepcode-session-model__history-label">
          {language === 'zh-CN' ? '旧版只读历史' : 'Legacy read-only history'}
        </span>
      ) : (
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
      )}
    </div>
  );
};

function buildCapacityMetrics(
  usage: ContextUsageProjection | null,
  language: UiLanguage,
): ContextDisplayMetric[] {
  const labels = language === 'zh-CN'
    ? { input: 'Provider 输入', output: 'Provider 输出', free: '空闲' }
    : { input: 'Provider input', output: 'Provider output', free: 'Free' };
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
  if (receipt.partitions) {
    return receipt.partitions.map((partition) => ({
      key: partition.kind,
      label: contextCategoryLabel(partition.kind, language),
      tokens: partition.tokenSource === 'sessionEstimated'
        ? partition.estimatedInputTokens ?? null
        : null,
      percent: null,
      itemCount: partition.itemCount,
      estimated: partition.tokenSource === 'sessionEstimated',
    }));
  }
  const counts = Object.fromEntries(
    CONTEXT_SECTION_ORDER.map((kind) => [kind, 0]),
  ) as Record<ContextCompositionCategoryKind, number>;
  if (receipt.messages) {
    for (const message of receipt.messages) {
      counts[message.contributionKind] += 1;
      counts.messageAttachments += message.attachments.length;
    }
    counts.workspaceBindings += receipt.workspaceBindings.length;
    counts.tools += receipt.tools.length;
  } else {
    for (const category of receipt.categories) counts[category.kind] += category.itemCount;
  }
  return CONTEXT_SECTION_ORDER.map((kind) => ({
    key: kind,
    label: contextCategoryLabel(kind, language),
    tokens: null,
    percent: null,
    itemCount: counts[kind],
  }));
}

function buildCacheMetric(usage: ContextUsageProjection | null): {
  hit: number | null;
  miss: number | null;
  percent: number | null;
} {
  const hit = usage?.cacheReadInputTokens;
  const miss = usage?.cacheMissInputTokens;
  if (hit === undefined || miss === undefined || hit + miss === 0) {
    return { hit: null, miss: null, percent: null };
  }
  return { hit, miss, percent: percentOf(hit, hit + miss) };
}

function contextCategoryLabel(
  kind: ContextCompositionCategoryKind,
  language: UiLanguage,
): string {
  const labels: Record<ContextCompositionCategoryKind, readonly [string, string]> = {
    instructions: ['系统与会话指令', 'System and session instructions'],
    workspaceBindings: ['目录索引', 'Directory indexes'],
    sessionControls: ['Session 控制接口', 'Session controls'],
    journalMessages: ['对话消息', 'Conversation messages'],
    contextProviders: ['上下文提供项', 'Context providers'],
    messageAttachments: ['消息附件', 'Message attachments'],
    tools: ['工具目录', 'Tool catalog'],
  };
  return labels[kind][language === 'zh-CN' ? 0 : 1];
}

function metricValue(metric: ContextDisplayMetric, language: UiLanguage): string {
  if (metric.tokens === null) return 'N/A Token';
  const percent = metric.percent === null ? '' : ` · ${formatPercent(metric.percent)}%`;
  const estimate = metric.estimated ? '≈' : '';
  return `${estimate}${formatTokens(metric.tokens, language)} Token${percent}`;
}

function metricAriaLabel(metric: ContextDisplayMetric, language: UiLanguage): string {
  return `${metric.label} ${metricValue(metric, language)}`;
}

function cacheAriaLabel(
  cache: { hit: number | null; miss: number | null; percent: number | null },
  language: UiLanguage,
): string {
  if (cache.hit === null || cache.miss === null || cache.percent === null) return 'N/A';
  return language === 'zh-CN'
    ? `缓存命中 ${formatTokens(cache.hit, language)} Token，未命中 ${formatTokens(cache.miss, language)} Token`
    : `Cache hit ${formatTokens(cache.hit, language)} tokens and miss ${formatTokens(cache.miss, language)} tokens`;
}

function formatItemCount(value: number, language: UiLanguage): string {
  return language === 'zh-CN' ? `${value} 项` : `${value} item${value === 1 ? '' : 's'}`;
}

function formatTokens(value: number, language: UiLanguage): string {
  return value.toLocaleString(language === 'zh-CN' ? 'zh-CN' : 'en-US');
}

function formatPercent(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function percentOf(value: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.min(100, Math.round((value / total) * 1_000) / 10);
}

export default SessionModelSelector;
