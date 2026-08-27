import React, { useEffect, useMemo, useState } from 'react';
import { normalizeUiLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';

interface SkillMount {
  id: string;
  path: string;
  enabled: boolean;
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
      return [{ id: record.id, path: record.path, enabled: record.enabled !== false }];
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
  };
}

const SkillRuntimeSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const zh = language === 'zh-CN';
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
    await patchUserSetting('skills.autoLoad', autoLoad);
    await patchUserSetting('skills.mounts', JSON.stringify(mounts, null, 2));
    setMessage(zh ? '已保存；重启本地 Daemon 后生效。' : 'Saved; restart the local daemon to apply.');
  };

  return (
    <div>
      <h2 className="settings-title">{zh ? 'Skills' : 'Skills'}</h2>
      <div className="settings-card">
        <div className="settings-card__body">
          <label className="settings-inline-check">
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(event) => setAutoLoad(event.target.checked)}
            />
            {zh ? '启动时加载本地 SKILL.md' : 'Load local SKILL.md files at startup'}
          </label>
          <p className="settings-card__hint">
            {zh
              ? '每个挂载目录中的 SKILL.md 作为指令插件参与同一个 Agent Loop，不产生独立运行时。'
              : 'SKILL.md files contribute instructions to the same Agent loop; they do not create another runtime.'}
          </p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <h3 className="settings-card__title">{zh ? '本地挂载' : 'Local mounts'}</h3>
          <button
            type="button"
            className="settings-action-button"
            onClick={() => setMounts((current) => [...current, newMount()])}
            disabled={loading}
          >
            {zh ? '添加' : 'Add'}
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
                  {zh ? '启用' : 'Enabled'}
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
                  {zh ? '移除' : 'Remove'}
                </button>
              </div>
              <input
                className="settings-field__input settings-field__input--wide"
                value={mount.path}
                onChange={(event) => update(mount.id, { path: event.target.value })}
                placeholder={zh ? 'SKILL.md 或其父目录的绝对路径' : 'Absolute path to SKILL.md or its parent'}
              />
            </div>
          ))}
          {mounts.length === 0 && (
            <div className="settings-card__hint">{zh ? '尚未配置 Skill。' : 'No Skills configured.'}</div>
          )}
        </div>
        <div className="settings-card__footer-row">
          <button
            type="button"
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading}
          >
            {zh ? '保存' : 'Save'}
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default SkillRuntimeSection;
