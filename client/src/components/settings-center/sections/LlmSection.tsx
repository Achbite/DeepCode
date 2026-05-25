import React, { useEffect, useMemo, useState } from 'react';
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_LLM_MODEL_OPTIONS,
  DEEPSEEK_OPENAI_BASE_URL,
  DEPRECATED_DEEPSEEK_LLM_MODELS,
} from '@deepcode/protocol';
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

const PROFILE_PRESETS: Array<{
  label: string;
  profile: Omit<LlmProviderProfile, 'id'>;
}> = [
  {
    label: 'DeepSeek Flash',
    profile: {
      name: 'DeepSeek V4 Flash',
      kind: 'openaiCompatible',
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      model: 'deepseek-v4-flash',
      contextWindowTokens: 1000000,
      maxOutputTokens: 384000,
      temperature: 0.2,
      reasoningEffort: 'high',
      thinking: 'enabled',
      enabled: true,
    },
  },
  {
    label: 'DeepSeek Pro',
    profile: {
      name: 'DeepSeek V4 Pro',
      kind: 'openaiCompatible',
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      model: 'deepseek-v4-pro',
      contextWindowTokens: 1000000,
      maxOutputTokens: 384000,
      temperature: 0.2,
      reasoningEffort: 'max',
      thinking: 'enabled',
      enabled: true,
    },
  },
  {
    label: 'DeepSeek Anthropic',
    profile: {
      name: 'DeepSeek V4 Flash (Anthropic)',
      kind: 'anthropic',
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
      model: 'deepseek-v4-flash',
      contextWindowTokens: 1000000,
      maxOutputTokens: 384000,
      temperature: 0.2,
      reasoningEffort: 'high',
      thinking: 'enabled',
      enabled: true,
    },
  },
];

function createProfile(
  preset?: Partial<Omit<LlmProviderProfile, 'id'>>
): LlmProviderProfile {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: preset?.name ?? 'OpenAI Compatible',
    kind: 'openaiCompatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    enabled: true,
    ...preset,
  };
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
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
      setMessage(result.message ?? 'Failed to load LLM profiles');
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

  const addProfile = (
    preset?: Partial<Omit<LlmProviderProfile, 'id'>>
  ) => {
    const profile = createProfile(preset);
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
      setMessage('LLM profiles saved');
      window.dispatchEvent(new CustomEvent('deepcode:llm-profiles-updated'));
    } else {
      setMessage(result.message ?? 'Failed to save LLM profiles');
    }
    setLoading(false);
  };

  const probe = async (profileId: string) => {
    setProbeState((prev) => ({ ...prev, [profileId]: 'Probing...' }));
    const result = await probeLlmProfile({ profileId });
    if (result.ok && result.data) {
      setProbeState((prev) => ({
        ...prev,
        [profileId]: result.data!.ok
          ? `OK ${result.data!.latencyMs ?? 0}ms`
          : result.data!.error ?? 'Probe failed',
      }));
    } else {
      setProbeState((prev) => ({
        ...prev,
        [profileId]: result.message ?? 'Probe failed',
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
          Configure the model used by Agent Runtime. API keys are stored in the
          local encrypted secret store; profiles only keep a secretRef.
        </p>

        <div className="settings-toolbar-row">
          <button
            className="settings-action-button"
            onClick={() => addProfile()}
            disabled={loading}
          >
            Add Profile
          </button>
          {PROFILE_PRESETS.map((preset) => (
            <button
              className="settings-action-button"
              key={preset.label}
              onClick={() => addProfile(preset.profile)}
              disabled={loading}
            >
              {preset.label}
            </button>
          ))}
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
            No LLM profile is configured. Add a generic OpenAI-compatible
            profile or use one of the DeepSeek presets.
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
                    placeholder="https://api.deepseek.com"
                  />
                </label>
                <label>
                  <span>Model</span>
                  <input
                    className="settings-field__input"
                    list="deepseek-model-options"
                    value={profile.model}
                    onChange={(e) =>
                      updateProfile(profile.id, { model: e.target.value })
                    }
                    placeholder="deepseek-v4-flash"
                  />
                  <datalist id="deepseek-model-options">
                    {DEEPSEEK_LLM_MODEL_OPTIONS.map((model) => (
                      <option
                        key={model}
                        value={model}
                        label={
                          (DEPRECATED_DEEPSEEK_LLM_MODELS as readonly string[]).includes(model)
                            ? `${model} (deprecated 2026-07-24)`
                            : model
                        }
                      />
                    ))}
                  </datalist>
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
                <label>
                  <span>Context window tokens</span>
                  <input
                    className="settings-field__input"
                    type="number"
                    min={1}
                    value={profile.contextWindowTokens ?? ''}
                    onChange={(e) =>
                      updateProfile(profile.id, {
                        contextWindowTokens: optionalNumber(e.target.value),
                      })
                    }
                    placeholder="1000000"
                  />
                </label>
                <label>
                  <span>Max output tokens</span>
                  <input
                    className="settings-field__input"
                    type="number"
                    min={1}
                    value={profile.maxOutputTokens ?? profile.maxTokens ?? ''}
                    onChange={(e) =>
                      updateProfile(profile.id, {
                        maxOutputTokens: optionalNumber(e.target.value),
                        maxTokens: undefined,
                      })
                    }
                    placeholder="384000"
                  />
                </label>
                <label>
                  <span>Thinking</span>
                  <select
                    className="settings-field__select"
                    value={profile.thinking ?? ''}
                    onChange={(e) =>
                      updateProfile(profile.id, {
                        thinking: e.target.value
                          ? (e.target.value as LlmProviderProfile['thinking'])
                          : undefined,
                      })
                    }
                  >
                    <option value="">Default</option>
                    <option value="enabled">Enabled</option>
                    <option value="disabled">Disabled</option>
                  </select>
                </label>
                <label>
                  <span>Reasoning effort</span>
                  <select
                    className="settings-field__select"
                    value={profile.reasoningEffort ?? ''}
                    onChange={(e) =>
                      updateProfile(profile.id, {
                        reasoningEffort: e.target.value
                          ? (e.target.value as LlmProviderProfile['reasoningEffort'])
                          : undefined,
                      })
                    }
                  >
                    <option value="">Default</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="max">Max</option>
                  </select>
                </label>
              </div>
              {profile.thinking === 'enabled' && (
                <div className="settings-card__hint">
                  Thinking mode providers such as DeepSeek may ignore sampling parameters like temperature.
                </div>
              )}

              <div className="llm-profile__actions">
                <button
                  className="settings-action-button"
                  onClick={() => void probe(profile.id)}
                  disabled={loading || !profile.secretRef || !!secrets[profile.id]}
                  title={secrets[profile.id] ? 'Save the new API key before probing' : 'Probe'}
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
