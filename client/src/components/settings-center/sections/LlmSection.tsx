import React, { useEffect, useMemo, useState } from 'react';
import type { LlmProviderKind, LlmProviderProfile } from '@deepcode/protocol';
import {
  getLlmProfiles,
  patchLlmProfiles,
  probeLlmProfile,
} from '../../../services/runtimeAdapter';

const PROVIDERS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: 'openaiCompatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'codex', label: 'Codex' },
  { value: 'ollama', label: 'Ollama' },
];

function createProfile(): LlmProviderProfile {
  const id = `profile-${Date.now()}`;
  return {
    id,
    name: 'OpenAI Compatible',
    kind: 'openaiCompatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    enabled: true,
  };
}

const LlmSection: React.FC = () => {
  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | undefined>();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [storePath, setStorePath] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [probeState, setProbeState] = useState<Record<string, string>>({});

  const hasProfiles = profiles.length > 0;

  const load = async () => {
    setLoading(true);
    setMessage(null);
    const result = await getLlmProfiles();
    if (result.ok && result.data) {
      setProfiles(result.data.profiles);
      setDefaultProfileId(result.data.defaultProfileId);
      setStorePath(result.data.storePath);
    } else {
      setMessage(result.message ?? '加载 LLM profiles 失败');
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const updateProfile = (
    id: string,
    patch: Partial<LlmProviderProfile>
  ) => {
    setProfiles((prev) =>
      prev.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile
      )
    );
  };

  const addProfile = () => {
    const profile = createProfile();
    setProfiles((prev) => [...prev, profile]);
    setDefaultProfileId((prev) => prev ?? profile.id);
  };

  const removeProfile = (id: string) => {
    setProfiles((prev) => prev.filter((profile) => profile.id !== id));
    setSecrets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setDefaultProfileId((prev) =>
      prev === id ? profiles.find((profile) => profile.id !== id)?.id : prev
    );
  };

  const save = async () => {
    setLoading(true);
    setMessage(null);
    const result = await patchLlmProfiles({
      profiles,
      defaultProfileId,
      secrets,
    });
    if (result.ok && result.data) {
      setProfiles(result.data.profiles);
      setDefaultProfileId(result.data.defaultProfileId);
      setStorePath(result.data.storePath);
      setSecrets({});
      setMessage('LLM profiles 已保存');
    } else {
      setMessage(result.message ?? '保存 LLM profiles 失败');
    }
    setLoading(false);
  };

  const probe = async (profileId: string) => {
    setProbeState((prev) => ({ ...prev, [profileId]: '探活中...' }));
    const result = await probeLlmProfile({ profileId });
    if (result.ok && result.data) {
      setProbeState((prev) => ({
        ...prev,
        [profileId]: result.data!.ok
          ? `OK ${result.data!.latencyMs ?? 0}ms`
          : result.data!.error ?? '探活失败',
      }));
    } else {
      setProbeState((prev) => ({
        ...prev,
        [profileId]: result.message ?? '探活失败',
      }));
    }
  };

  const defaultOptions = useMemo(
    () => profiles.map((profile) => ({ id: profile.id, name: profile.name })),
    [profiles]
  );

  return (
    <div>
      <h2 className="settings-title">LLM Providers</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">Provider Profiles</h3>
        <p className="settings-card__body">
          配置 Agent Runtime 使用的模型。API key 使用本地加密存储，profile 中只保存 secretRef。
        </p>

        <div className="settings-toolbar-row">
          <button
            className="settings-action-button"
            onClick={addProfile}
            disabled={loading}
          >
            Add Profile
          </button>
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading || !hasProfiles}
          >
            Save
          </button>
          <button
            className="settings-action-button"
            onClick={() => void load()}
            disabled={loading}
          >
            Reload
          </button>
        </div>

        {defaultOptions.length > 0 && (
          <label className="llm-default-row">
            <span>Default profile</span>
            <select
              className="settings-field__select"
              value={defaultProfileId ?? ''}
              onChange={(e) => setDefaultProfileId(e.target.value)}
            >
              {defaultOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {profiles.length === 0 && (
          <div className="settings-card__hint">
            暂无 LLM profile。点击 Add Profile 创建第一个 OpenAI-compatible 配置。
          </div>
        )}

        <div className="llm-profile-list">
          {profiles.map((profile) => (
            <div className="llm-profile" key={profile.id}>
              <div className="llm-profile__header">
                <input
                  className="settings-field__input"
                  value={profile.name}
                  onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                  placeholder="Profile name"
                />
                <select
                  className="settings-field__select"
                  value={profile.kind}
                  onChange={(e) =>
                    updateProfile(profile.id, {
                      kind: e.target.value as LlmProviderKind,
                    })
                  }
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider.value} value={provider.value}>
                      {provider.label}
                    </option>
                  ))}
                </select>
                <label className="llm-profile__enabled">
                  <input
                    type="checkbox"
                    checked={profile.enabled}
                    onChange={(e) =>
                      updateProfile(profile.id, { enabled: e.target.checked })
                    }
                  />
                  Enabled
                </label>
              </div>

              <div className="llm-profile__grid">
                <label>
                  <span>Base URL</span>
                  <input
                    className="settings-field__input"
                    value={profile.baseUrl ?? ''}
                    onChange={(e) =>
                      updateProfile(profile.id, { baseUrl: e.target.value })
                    }
                    placeholder="https://api.openai.com/v1"
                  />
                </label>
                <label>
                  <span>Model</span>
                  <input
                    className="settings-field__input"
                    value={profile.model}
                    onChange={(e) =>
                      updateProfile(profile.id, { model: e.target.value })
                    }
                    placeholder="gpt-4o-mini"
                  />
                </label>
                <label>
                  <span>API Key</span>
                  <input
                    className="settings-field__input"
                    type="password"
                    value={secrets[profile.id] ?? ''}
                    onChange={(e) =>
                      setSecrets((prev) => ({
                        ...prev,
                        [profile.id]: e.target.value,
                      }))
                    }
                    placeholder={profile.secretRef ? 'Configured' : 'Paste key to save'}
                  />
                </label>
              </div>

              <div className="llm-profile__actions">
                <button
                  className="settings-action-button"
                  onClick={() => void probe(profile.id)}
                  disabled={loading || !profile.secretRef || !!secrets[profile.id]}
                  title={secrets[profile.id] ? '请先保存新 API key 后再探活' : 'Probe'}
                >
                  Probe
                </button>
                <button
                  className="settings-action-button"
                  onClick={() => removeProfile(profile.id)}
                  disabled={loading}
                >
                  Remove
                </button>
                {probeState[profile.id] && (
                  <span className="llm-profile__status">
                    {probeState[profile.id]}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        {storePath && (
          <div className="settings-card__hint">Profile store: {storePath}</div>
        )}
        {message && <div className="settings-error">{message}</div>}
      </div>
    </div>
  );
};

export default LlmSection;
