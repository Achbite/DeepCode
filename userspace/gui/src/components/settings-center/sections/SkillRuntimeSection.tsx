import React, { useEffect, useMemo, useState } from 'react';
import { normalizeUiLanguage, t } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';

interface SkillMount {
  id: string;
  path: string;
  enabled: boolean;
  activationMediaTypes: string[];
}

function parseMounts(value: unknown): SkillMount[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.id !== 'string' || typeof record.path !== 'string') return [];
      const activationMediaTypes = Array.isArray(record.activationMediaTypes)
        ? record.activationMediaTypes.filter((value): value is string =>
          typeof value === 'string' && value.trim().length > 0)
        : [];
      return [{
        id: record.id,
        path: record.path,
        enabled: record.enabled !== false,
        activationMediaTypes,
      }];
    });
  } catch {
    return [];
  }
}

function newMount(): SkillMount {
  return {
    id: `skill-${Date.now().toString(36)}`,
    path: '',
    enabled: true,
    activationMediaTypes: [],
  };
}

const SkillRuntimeSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSettingsBatch = useSettingsStore((state) => state.patchUserSettingsBatch);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const stored = useMemo(
    () => parseMounts(effectiveSettings['skills.mounts']),
    [effectiveSettings],
  );
  const [autoLoad, setAutoLoad] = useState(Boolean(effectiveSettings['skills.autoLoad']));
  const [mounts, setMounts] = useState(stored);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setAutoLoad(Boolean(effectiveSettings['skills.autoLoad']));
    setMounts(stored);
  }, [effectiveSettings, stored]);

  const update = (id: string, patch: Partial<SkillMount>) => {
    setMounts((current) => current.map((mount) =>
      mount.id === id ? { ...mount, ...patch } : mount));
  };

  const save = async () => {
    setMessage(null);
    const activation = await patchUserSettingsBatch({
      'skills.autoLoad': autoLoad,
      'skills.mounts': JSON.stringify(mounts, null, 2),
    });
    if (!activation) return;
    setMessage(t(
      language,
      activation === 'nextRun'
        ? 'settings.runtime.nextRunActivationAfterSave'
        : 'settings.runtime.savedImmediate',
    ));
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.skill.title')}</h2>
      <div className="settings-card">
        <div className="settings-card__body">
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {t(language, 'settings.skill.autoLoad')}
          </label>
          <p className="settings-card__hint">
            {t(language, 'settings.skill.scopeHint')}
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{t(language, 'settings.skill.localMounts')}</h3>
          <button
            type="button"
            className="settings-action-button"
            onClick={() => setMounts((current) => [...current, newMount()])}
            disabled={loading}
          >
            {t(language, 'settings.common.add')}
          </button>
        </div>
        <div className="settings-list-editor">
          {mounts.map((mount) => (
            <div className="mcp-service-row" key={mount.id}>
              <div className="mcp-service-row__top">
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={mount.enabled}
                    onChange={(event) => update(mount.id, { enabled: event.target.checked })}
                  />
                  {t(language, 'settings.common.enabled')}
                </label>
                <input
                  className="settings-field__input"
                  value={mount.id}
                  onChange={(event) => update(mount.id, { id: event.target.value })}
                  placeholder="skill-id"
                />
                <button
                  type="button"
                  className="settings-action-button"
                  onClick={() => setMounts((current) =>
                    current.filter((candidate) => candidate !== mount))}
                >
                  {t(language, 'settings.common.remove')}
                </button>
              </div>
              <input
                className="settings-field__input settings-field__input--wide"
                value={mount.path}
                onChange={(event) => update(mount.id, { path: event.target.value })}
                placeholder={t(language, 'settings.skill.pathPlaceholder')}
              />
              <input
                className="settings-field__input settings-field__input--wide"
                value={mount.activationMediaTypes.join(', ')}
                onChange={(event) => update(mount.id, {
                  activationMediaTypes: event.target.value
                    .split(',')
                    .map((value) => value.trim().toLowerCase())
                    .filter(Boolean),
                })}
                placeholder={t(language, 'settings.skill.activationMediaTypesPlaceholder')}
              />
            </div>
          ))}
          {mounts.length === 0 && (
            <div className="settings-card__hint">{t(language, 'settings.skill.empty')}</div>
          )}
        </div>
        <div className="settings-card__footer-row">
          <button
            type="button"
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
          >
            {t(language, 'settings.common.save')}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default SkillRuntimeSection;
