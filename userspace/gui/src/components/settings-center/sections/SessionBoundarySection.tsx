import React from 'react';
import { useSettingsStore } from '../../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../../i18n';

const SESSION_BOUNDARY_ITEMS = [
  {
    id: 'protocol-contract',
    kind: 'session',
    priority: 0,
    title: 'Kernel–Session v2 Contract',
    detail: 'Session uses the versioned Kernel ABI for ToolContext, ToolIntent, decisions, and facts.',
  },
  {
    id: 'builtin-system',
    kind: 'session',
    priority: 1,
    title: 'Builtin Session System Prompt',
    detail: 'Session owns orchestration instructions and injects the Kernel tool block without rewriting its semantics.',
  },
  {
    id: 'tool-context',
    kind: 'session',
    priority: 11,
    title: 'ToolContext / Kernel Facts',
    detail: 'Kernel resolves scoped resources and records canonical facts; Session reduces those facts into provider context.',
  },
  {
    id: 'audit-only',
    kind: 'session',
    priority: 99,
    title: 'Audit-only refs',
    detail: 'Canonical fact and audit refs remain immutable references rather than editable prompt content.',
  },
] as const;

const SessionBoundarySection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.sessionBoundary.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.sessionBoundary.summary')}</h3>
        <p className="settings-card__body">{t(language, 'settings.sessionBoundary.body')}</p>
        <div className="settings-card__hint">{t(language, 'settings.sessionBoundary.readonly')}</div>
      </div>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.sessionBoundary.items')}</h3>
        <div className="settings-list-editor">
          {SESSION_BOUNDARY_ITEMS.map((layer) => (
            <div className="session-boundary-row" key={layer.id}>
              <div className="session-boundary-row__meta">
                <span className="settings-pill">{layer.kind}</span>
                <strong>{layer.title}</strong>
                <span>{t(language, 'settings.sessionBoundary.priority', { priority: layer.priority })}</span>
              </div>
              <div className="settings-card__hint">{layer.detail}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SessionBoundarySection;
