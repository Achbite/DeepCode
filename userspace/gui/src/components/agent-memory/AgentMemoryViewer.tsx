import React, { useMemo, useState } from 'react';
import type { MemoryItemV4, SessionMemorySnapshot } from '@deepcode/session-core';
import { t, type UiLanguage } from '../../i18n';
import './agentMemoryViewer.css';

type MemoryScopeView = 'project' | 'session';

interface AgentMemoryViewerProps {
  language: UiLanguage;
  title: string;
  subtitle?: string;
  snapshots: SessionMemorySnapshot[];
  defaultScope?: MemoryScopeView;
  loading?: boolean;
  error?: string | null;
  sessionLabels?: Record<string, string>;
  onRefresh?: () => void;
  onClose?: () => void;
}

const AgentMemoryViewer: React.FC<AgentMemoryViewerProps> = ({
  language,
  title,
  subtitle,
  snapshots,
  defaultScope = 'project',
  loading = false,
  error,
  sessionLabels = {},
  onRefresh,
  onClose,
}) => {
  const [scope, setScope] = useState<MemoryScopeView>(defaultScope);
  const [query, setQuery] = useState('');
  const projectItems = useMemo(
    () => dedupeMemoryItems(snapshots.flatMap((snapshot) => [
      ...snapshot.projectMemoryItems,
      ...(snapshot.pendingProjectMemoryCandidates ?? []),
    ])),
    [snapshots]
  );
  const sessionItems = useMemo(
    () => dedupeMemoryItems(snapshots.flatMap((snapshot) => snapshot.sessionMemoryItems)),
    [snapshots]
  );
  const activeItems = scope === 'project' ? projectItems : sessionItems;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleItems = normalizedQuery
    ? activeItems.filter((item) => memoryItemSearchText(item).includes(normalizedQuery))
    : activeItems;
  const sourceEventCount = snapshots.reduce((sum, snapshot) => sum + snapshot.sourceEventCount, 0);

  return (
    <section className="agent-memory-viewer" aria-label={title}>
      <header className="agent-memory-viewer__header">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="agent-memory-viewer__actions">
          {onRefresh && (
            <button type="button" onClick={onRefresh} disabled={loading}>
              {t(language, 'memory.refresh')}
            </button>
          )}
          {onClose && (
            <button type="button" onClick={onClose} aria-label={t(language, 'memory.close')}>
              {t(language, 'memory.close')}
            </button>
          )}
        </div>
      </header>

      <div className="agent-memory-viewer__summary">
        <span>{t(language, 'memory.sourceSessions', { count: String(snapshots.length) })}</span>
        <span>{t(language, 'memory.sourceEvents', { count: String(sourceEventCount) })}</span>
        <span>{t(language, 'memory.projectSoftCap')}</span>
        <span>{t(language, 'memory.sessionSoftCap')}</span>
      </div>

      <div className="agent-memory-viewer__toolbar">
        <div className="agent-memory-viewer__tabs" role="tablist">
          <button
            type="button"
            className={scope === 'project' ? 'active' : ''}
            onClick={() => setScope('project')}
          >
            {t(language, 'memory.projectMemory')} ({projectItems.length})
          </button>
          <button
            type="button"
            className={scope === 'session' ? 'active' : ''}
            onClick={() => setScope('session')}
          >
            {t(language, 'memory.sessionMemory')} ({sessionItems.length})
          </button>
        </div>
        <label className="agent-memory-viewer__search">
          <span>{t(language, 'memory.search')}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t(language, 'memory.searchPlaceholder')}
          />
        </label>
      </div>

      {error && <div className="agent-memory-viewer__status agent-memory-viewer__status--error">{error}</div>}
      {loading && <div className="agent-memory-viewer__status">{t(language, 'memory.loading')}</div>}

      {snapshots.length > 1 && (
        <details className="agent-memory-viewer__sessions">
          <summary>{t(language, 'memory.sessionList')}</summary>
          <ul>
            {snapshots.map((snapshot) => (
              <li key={snapshot.sessionId ?? snapshot.generatedAt}>
                <span>{sessionLabels[snapshot.sessionId ?? ''] ?? snapshot.sessionId ?? t(language, 'memory.unknownSession')}</span>
                <small>{t(language, 'memory.sourceEvents', { count: String(snapshot.sourceEventCount) })}</small>
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="agent-memory-viewer__items">
        {visibleItems.length === 0 && !loading ? (
          <div className="agent-memory-viewer__empty">{t(language, 'memory.empty')}</div>
        ) : (
          visibleItems.map((item) => (
            <article key={item.id} className="agent-memory-item">
              <div className="agent-memory-item__meta">
                <span>{localizedMemoryValue(language, 'scope', item.scope)}</span>
                <span>{localizedMemoryValue(language, 'kind', item.kind)}</span>
                <span>{localizedMemoryValue(language, 'authority', item.authority)}</span>
                <span>{localizedMemoryValue(language, 'compression', item.compression?.mode ?? 'raw')}</span>
                {item.governance && (
                  <>
                    <span>{localizedMemoryValue(language, 'status', item.governance.status)}</span>
                    <span>{localizedMemoryValue(language, 'risk', item.governance.riskClass)}</span>
                  </>
                )}
              </div>
              <p>{item.content}</p>
              <dl>
                <div>
                  <dt>{t(language, 'memory.freshness')}</dt>
                  <dd>{memoryFreshnessText(item, language)}</dd>
                </div>
                <div>
                  <dt>{t(language, 'memory.sourceRefs')}</dt>
                  <dd>{memorySourceRefsText(item, language)}</dd>
                </div>
              </dl>
            </article>
          ))
        )}
      </div>
    </section>
  );
};

function dedupeMemoryItems(items: MemoryItemV4[]): MemoryItemV4[] {
  const seen = new Set<string>();
  const result: MemoryItemV4[] = [];
  for (const item of items) {
    const key = item.id || `${item.scope}:${item.kind}:${item.authority}:${item.content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function memoryItemSearchText(item: MemoryItemV4): string {
  return [
    item.scope,
    item.kind,
    item.authority,
    item.governance?.status,
    item.governance?.riskClass,
    item.content,
    item.freshness.path,
    item.freshness.query,
    item.freshness.symbol,
  ].filter(Boolean).join(' ').toLowerCase();
}

function localizedMemoryValue(
  language: UiLanguage,
  group: 'scope' | 'kind' | 'authority' | 'compression' | 'status' | 'risk',
  value: string
): string {
  return t(language, `memory.${group}.${value}`);
}

function memoryFreshnessText(item: MemoryItemV4, language: UiLanguage): string {
  const parts = [
    item.freshness.path ? `path=${item.freshness.path}` : '',
    item.freshness.query ? `query=${item.freshness.query}` : '',
    item.freshness.symbol ? `symbol=${item.freshness.symbol}` : '',
    item.freshness.contentHash ? `hash=${item.freshness.contentHash}` : '',
    item.freshness.lastVerifiedAt ? `verified=${item.freshness.lastVerifiedAt}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || t(language, 'memory.none');
}

function memorySourceRefsText(item: MemoryItemV4, language: UiLanguage): string {
  const refs = [
    ...item.sourceRefs.eventIds,
    ...(item.sourceRefs.resourcePacketIds ?? []),
    ...(item.sourceRefs.resourceBlockKeys ?? []),
    ...(item.sourceRefs.ledgerRefs ?? []),
    ...(item.sourceRefs.auditRefs ?? []),
  ];
  return refs.length ? refs.join(', ') : t(language, 'memory.none');
}

export default AgentMemoryViewer;
