/**
 * Prompt Profiles 板块
 *
 * 阶段 6：接入真实用户设置，支持新建、编辑、删除与默认 profile 选择。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../../state/settingsStore';

interface PromptProfile {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  enabled: boolean;
}

function safeParseProfiles(raw: unknown): PromptProfile[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        id: String(item.id || `prompt-${Date.now()}`),
        name: String(item.name || 'Prompt Profile'),
        description: String(item.description || ''),
        systemPrompt: String(item.systemPrompt || ''),
        enabled: item.enabled !== false,
      }));
  } catch {
    return [];
  }
}

function createProfile(): PromptProfile {
  return {
    id: `prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: 'New Prompt Profile',
    description: '',
    systemPrompt:
      'You are DeepCode Agent. Work inside the current workspace and explain important risks before making changes.',
    enabled: true,
  };
}

const PromptProfilesSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const loading = useSettingsStore((s) => s.loading);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);

  const storedProfiles = useMemo(
    () => safeParseProfiles(effectiveSettings['prompt.profiles']),
    [effectiveSettings]
  );
  const [profiles, setProfiles] = useState<PromptProfile[]>(storedProfiles);
  const [defaultProfileId, setDefaultProfileId] = useState(
    String(effectiveSettings['prompt.defaultProfileId'] ?? 'default-agent')
  );
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setProfiles(storedProfiles);
    setDefaultProfileId(
      String(effectiveSettings['prompt.defaultProfileId'] ?? 'default-agent')
    );
  }, [effectiveSettings, storedProfiles]);

  const updateProfile = (id: string, patch: Partial<PromptProfile>) => {
    setProfiles((prev) =>
      prev.map((profile) => (profile.id === id ? { ...profile, ...patch } : profile))
    );
  };

  const save = async () => {
    setMessage(null);
    const nextDefault = profiles.some((profile) => profile.id === defaultProfileId)
      ? defaultProfileId
      : profiles[0]?.id ?? '';
    await patchUserSetting('prompt.defaultProfileId', nextDefault);
    await patchUserSetting('prompt.profiles', JSON.stringify(profiles, null, 2));
    setDefaultProfileId(nextDefault);
    setMessage('Prompt profiles saved');
  };

  return (
    <div>
      <h2 className="settings-title">Prompt Profiles</h2>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <div>
            <h3 className="settings-card__title">Profiles</h3>
            <p className="settings-card__body">
              Profiles define the system prompt used by Agent conversations.
            </p>
          </div>
          <button
            className="settings-action-button"
            onClick={() => {
              const profile = createProfile();
              setProfiles((prev) => [...prev, profile]);
              setDefaultProfileId((prev) => prev || profile.id);
            }}
            disabled={loading}
          >
            Add Profile
          </button>
        </div>

        {profiles.length > 0 && (
          <label className="settings-default-row">
            <span>Default profile</span>
            <select
              className="settings-field__select"
              value={defaultProfileId}
              onChange={(event) => setDefaultProfileId(event.target.value)}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="settings-list-editor">
          {profiles.map((profile) => (
            <div className="prompt-profile-row" key={profile.id}>
              <div className="prompt-profile-row__meta">
                <label className="settings-inline-check">
                  <input
                    type="checkbox"
                    checked={profile.enabled}
                    onChange={(event) =>
                      updateProfile(profile.id, { enabled: event.target.checked })
                    }
                  />
                  Enabled
                </label>
                <input
                  className="settings-field__input"
                  value={profile.name}
                  onChange={(event) =>
                    updateProfile(profile.id, { name: event.target.value })
                  }
                  placeholder="Profile name"
                />
                <input
                  className="settings-field__input settings-field__input--wide"
                  value={profile.description}
                  onChange={(event) =>
                    updateProfile(profile.id, { description: event.target.value })
                  }
                  placeholder="Description"
                />
                <button
                  className="settings-action-button"
                  onClick={() =>
                    setProfiles((prev) =>
                      prev.filter((item) => item.id !== profile.id)
                    )
                  }
                >
                  Remove
                </button>
              </div>
              <textarea
                className="settings-textarea"
                value={profile.systemPrompt}
                onChange={(event) =>
                  updateProfile(profile.id, { systemPrompt: event.target.value })
                }
                placeholder="System prompt"
              />
            </div>
          ))}
        </div>

        <div className="settings-card__footer-row">
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading || profiles.length === 0}
          >
            Save Prompt Profiles
          </button>
          {message && <span className="settings-save-message">{message}</span>}
        </div>
      </div>
    </div>
  );
};

export default PromptProfilesSection;
