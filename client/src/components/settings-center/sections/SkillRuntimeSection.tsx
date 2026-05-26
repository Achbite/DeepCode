/**
 * Skill Runtime 板块
 *
 * 阶段 6：接入真实用户设置，支持配置 Python runtime 与 Skill 挂载目录。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../../i18n';

interface SkillMount {
  id: string;
  name: string;
  path: string;
  description: string;
  enabled: boolean;
}

function safeParseMounts(raw: unknown): SkillMount[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || `skill-${Date.now()}`),
        name: String(item.name || 'Local Skill'),
        path: String(item.path || ''),
        description: String(item.description || ''),
        enabled: item.enabled !== false,
      }));
  } catch {
    return [];
  }
}

function createMount(): SkillMount {
  return {
    id: `skill-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'Local Skill',
    path: '',
    description: '',
    enabled: true,
  };
}

const SkillRuntimeSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const loading = useSettingsStore((s) => s.loading);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);

  const storedMounts = useMemo(
    () => safeParseMounts(effectiveSettings['skills.mounts']),
    [effectiveSettings]
  );

  const [pythonPath, setPythonPath] = useState(
    String(effectiveSettings['skills.pythonPath'] ?? 'python')
  );
  const [autoLoad, setAutoLoad] = useState(
    Boolean(effectiveSettings['skills.autoLoad'] ?? true)
  );
  const [mounts, setMounts] = useState<SkillMount[]>(storedMounts);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setPythonPath(String(effectiveSettings['skills.pythonPath'] ?? 'python'));
    setAutoLoad(Boolean(effectiveSettings['skills.autoLoad'] ?? true));
    setMounts(storedMounts);
  }, [effectiveSettings, storedMounts]);

  const updateMount = (id: string, patch: Partial<SkillMount>) => {
    setMounts((prev) =>
      prev.map((mount) => (mount.id === id ? { ...mount, ...patch } : mount))
    );
  };

  const save = async () => {
    setMessage(null);
    await patchUserSetting('skills.pythonPath', pythonPath.trim() || 'python');
    await patchUserSetting('skills.autoLoad', autoLoad);
    await patchUserSetting('skills.mounts', JSON.stringify(mounts, null, 2));
    setMessage(t(language, 'settings.skill.saved'));
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.skill.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.skill.runtime')}</h3>
        <div className="settings-form-grid">
          <label>
            <span>{t(language, 'settings.skill.pythonPath')}</span>
            <input
              className="settings-field__input"
              value={pythonPath}
              onChange={(event) => setPythonPath(event.target.value)}
              placeholder="python"
            />
          </label>
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {t(language, 'settings.skill.autoLoad')}
          </label>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{t(language, 'settings.skill.mounts')}</h3>
          <button
            className="settings-action-button"
            onClick={() => setMounts((prev) => [...prev, createMount()])}
            disabled={loading}
          >
            {t(language, 'settings.skill.addMount')}
          </button>
        </div>

        {mounts.length === 0 && (
          <div className="settings-card__hint">
            {t(language, 'settings.skill.emptyMounts')}
          </div>
        )}

        <div className="settings-list-editor">
          {mounts.map((mount) => (
            <div className="settings-list-row" key={mount.id}>
              <label className="settings-inline-check">
                <input
                  type="checkbox"
                  checked={mount.enabled}
                  onChange={(event) =>
                    updateMount(mount.id, { enabled: event.target.checked })
                  }
                />
                {t(language, 'settings.common.enabled')}
              </label>
              <input
                className="settings-field__input"
                value={mount.name}
                onChange={(event) =>
                  updateMount(mount.id, { name: event.target.value })
                }
                placeholder={t(language, 'settings.skill.displayName')}
              />
              <input
                className="settings-field__input settings-field__input--wide"
                value={mount.path}
                onChange={(event) =>
                  updateMount(mount.id, { path: event.target.value })
                }
                placeholder="E:/Dev-Agent/skills/my-skill"
              />
              <input
                className="settings-field__input settings-field__input--wide"
                value={mount.description}
                onChange={(event) =>
                  updateMount(mount.id, { description: event.target.value })
                }
                placeholder={t(language, 'settings.skill.description')}
              />
              <button
                className="settings-action-button"
                onClick={() =>
                  setMounts((prev) => prev.filter((item) => item.id !== mount.id))
                }
              >
                {t(language, 'settings.common.remove')}
              </button>
            </div>
          ))}
        </div>

        <div className="settings-card__footer-row">
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
          >
            {t(language, 'settings.skill.save')}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default SkillRuntimeSection;
