import React, { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../../i18n';

type RulerRuleSource = 'system' | 'user' | 'workspace' | 'project';

interface RulerRule {
  id: string;
  name: string;
  source: RulerRuleSource;
  priority: number;
  path: string;
  content: string;
  enabled: boolean;
}

const SOURCE_OPTIONS: RulerRuleSource[] = ['system', 'user', 'workspace', 'project'];

function normalizeSource(value: unknown): RulerRuleSource {
  return SOURCE_OPTIONS.includes(value as RulerRuleSource)
    ? (value as RulerRuleSource)
    : 'user';
}

function safeParseRules(raw: unknown): RulerRule[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || `rule-${Date.now()}`),
        name: String(item.name || 'Agent Rule'),
        source: normalizeSource(item.source),
        priority: Number.isFinite(Number(item.priority))
          ? Number(item.priority)
          : 50,
        path: String(item.path || ''),
        content: String(item.content || ''),
        enabled: item.enabled !== false,
      }));
  } catch {
    return [];
  }
}

function createRule(): RulerRule {
  return {
    id: `rule-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Workspace Rule',
    source: 'workspace',
    priority: 50,
    path: '.deepcode/rules/workspace.md',
    content:
      'Read the relevant files before proposing changes. Prefer small patches and keep user-authored edits intact.',
    enabled: true,
  };
}

const RulerRulesSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const loading = useSettingsStore((s) => s.loading);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);

  const storedRules = useMemo(
    () => safeParseRules(effectiveSettings['ruler.rules']),
    [effectiveSettings]
  );

  const [enabled, setEnabled] = useState(
    Boolean(effectiveSettings['ruler.enabled'] ?? true)
  );
  const [rules, setRules] = useState<RulerRule[]>(storedRules);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setEnabled(Boolean(effectiveSettings['ruler.enabled'] ?? true));
    setRules(storedRules);
  }, [effectiveSettings, storedRules]);

  const updateRule = (id: string, patch: Partial<RulerRule>) => {
    setRules((prev) =>
      prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
    );
  };

  const save = async () => {
    setMessage(null);
    await patchUserSetting('ruler.enabled', enabled);
    await patchUserSetting('ruler.rules', JSON.stringify(rules, null, 2));
    setMessage(t(language, 'settings.ruler.saved'));
  };

  const enabledCount = rules.filter((rule) => rule.enabled).length;

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.ruler.title')}</h2>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <div>
            <h3 className="settings-card__title">{t(language, 'settings.ruler.engine')}</h3>
            <p className="settings-card__body">
              {t(language, 'settings.ruler.body')}
            </p>
          </div>
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t(language, 'settings.common.enabled')}
          </label>
        </div>

        <div className="settings-card__hint">
          {t(language, 'settings.ruler.activeCount', { count: enabledCount })}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{t(language, 'settings.ruler.rules')}</h3>
          <button
            className="settings-action-button"
            onClick={() => setRules((prev) => [...prev, createRule()])}
            disabled={loading}
          >
            {t(language, 'settings.ruler.addRule')}
          </button>
        </div>

        {rules.length === 0 && (
          <div className="settings-card__hint">
            {t(language, 'settings.ruler.empty')}
          </div>
        )}

        <div className="settings-list-editor">
          {rules.map((rule) => (
            <div className="ruler-rule-row" key={rule.id}>
              <div className="ruler-rule-row__meta">
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    onChange={(event) =>
                      updateRule(rule.id, { enabled: event.target.checked })
                    }
                  />
                  {t(language, 'settings.common.enabled')}
                </label>
                <input
                  className="settings-field__input"
                  value={rule.name}
                  onChange={(event) =>
                    updateRule(rule.id, { name: event.target.value })
                  }
                  placeholder={t(language, 'settings.ruler.ruleName')}
                />
                <select
                  className="settings-field__select"
                  value={rule.source}
                  onChange={(event) =>
                    updateRule(rule.id, {
                      source: normalizeSource(event.target.value),
                    })
                  }
                >
                  {SOURCE_OPTIONS.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
                <input
                  className="settings-field__input settings-field__input--compact"
                  type="number"
                  value={rule.priority}
                  onChange={(event) =>
                    updateRule(rule.id, {
                      priority: Number(event.target.value) || 0,
                    })
                  }
                  title={t(language, 'settings.ruler.priorityTitle')}
                />
                <button
                  className="settings-action-button"
                  onClick={() =>
                    setRules((prev) => prev.filter((item) => item.id !== rule.id))
                  }
                >
                  {t(language, 'settings.common.remove')}
                </button>
              </div>

              <input
                className="settings-field__input settings-field__input--wide"
                value={rule.path}
                onChange={(event) =>
                  updateRule(rule.id, { path: event.target.value })
                }
                placeholder=".continue/rules/backend.md or .deepcode/rules/team.md"
              />
              <textarea
                className="settings-textarea"
                value={rule.content}
                onChange={(event) =>
                  updateRule(rule.id, { content: event.target.value })
                }
                placeholder={t(language, 'settings.ruler.ruleContent')}
              />
            </div>
          ))}
        </div>

        <div className="settings-card__footer-row">
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
          >
            {t(language, 'settings.ruler.save')}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default RulerRulesSection;
