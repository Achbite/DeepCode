import React, { useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_LLM_PROVIDER_PROFILES,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_LLM_MODEL_OPTIONS,
  DEEPSEEK_OPENAI_BASE_URL,
  DEPRECATED_DEEPSEEK_LLM_MODELS,
  GLM_LLM_MODEL_OPTIONS,
  GLM_OPENAI_BASE_URL,
  KIMI_LLM_MODEL_OPTIONS,
  KIMI_OPENAI_BASE_URL,
} from '@deepcode/protocol';
import type {
  LlmProviderFlavor,
  LlmHostedWebSearch,
  LlmProviderKind,
  LlmProviderProfile,
} from '@deepcode/protocol';
import {
  getLlmProfiles,
  patchLlmProfiles,
  probeLlmProfile,
} from '../../../services/runtimeAdapter';
import { useSettingsStore } from '../../../state/settingsStore';
import { normalizeUiLanguage, t } from '../../../i18n';

const PROVIDERS: LlmProviderKind[] = ['openaiCompatible', 'responses', 'anthropic', 'ollama'];

const PROVIDER_FLAVORS: LlmProviderFlavor[] = [
  'openai',
  'deepseek',
  'zhipu',
  'moonshot',
];

const INVALID_PROFILE_STORE_SCHEMA = 'invalid_llm_profile_store_schema';
const DEFAULT_REPLACEMENT_PROFILE_ID = 'deepseek-v4-pro-openai';

type ProfileWithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type NewProfile = ProfileWithoutId<LlmProviderProfile>;
type ProfileCommonPatch = Partial<
  Omit<LlmProviderProfile, 'kind'>
>;

const PROFILE_PRESETS: Array<{
  labelKey: string;
  profile: NewProfile;
}> = [
  {
    labelKey: 'settings.llm.preset.deepseekFlash',
    profile: {
      name: 'DeepSeek V4 Flash',
      kind: 'responses',
      providerFlavor: 'deepseek',
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      model: 'deepseek-v4-flash',
      contextWindowTokens: 1000000,
      maxOutputTokens: 384000,
      temperature: 0.2,
      reasoningEffort: 'high',
      thinking: 'enabled',
      hostedWebSearch: 'web_search',
      enabled: true,
    },
  },
  {
    labelKey: 'settings.llm.preset.deepseekPro',
    profile: {
      name: 'DeepSeek V4 Pro',
      kind: 'responses',
      providerFlavor: 'deepseek',
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      model: 'deepseek-v4-pro',
      contextWindowTokens: 1000000,
      maxOutputTokens: 384000,
      temperature: 0.2,
      reasoningEffort: 'max',
      thinking: 'enabled',
      hostedWebSearch: 'web_search',
      enabled: true,
    },
  },
  {
    labelKey: 'settings.llm.preset.deepseekAnthropic',
    profile: {
      name: 'DeepSeek V4 Flash (Anthropic)',
      kind: 'anthropic',
      providerFlavor: 'deepseek',
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
  {
    labelKey: 'settings.llm.preset.glm',
    profile: {
      name: 'GLM 5.2',
      kind: 'openaiCompatible',
      providerFlavor: 'zhipu',
      baseUrl: GLM_OPENAI_BASE_URL,
      model: 'glm-5.2',
      enabled: true,
    },
  },
  {
    labelKey: 'settings.llm.preset.kimi',
    profile: {
      name: 'Kimi K2.6',
      kind: 'openaiCompatible',
      providerFlavor: 'moonshot',
      baseUrl: KIMI_OPENAI_BASE_URL,
      model: 'kimi-k2.6',
      contextWindowTokens: 256000,
      maxOutputTokens: 32768,
      thinking: 'enabled',
      enabled: true,
    },
  },
];

function createProfile(
  preset?: NewProfile
): LlmProviderProfile {
  const id = `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  if (preset) {
    return { id, ...preset };
  }
  return {
    id,
    name: 'OpenAI Compatible',
    kind: 'openaiCompatible',
    providerFlavor: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    thinking: 'enabled',
    enabled: false,
  };
}

function currentProfileReplacementDrafts(): LlmProviderProfile[] {
  return DEFAULT_LLM_PROVIDER_PROFILES.map((profile) => ({
    ...profile,
    enabled: profile.id === DEFAULT_REPLACEMENT_PROFILE_ID,
  }));
}

function profileWithProviderKind(
  profile: LlmProviderProfile,
  kind: LlmProviderKind,
): LlmProviderProfile {
  return kind === 'responses'
    ? { ...profile, kind }
    : { ...profile, kind, hostedWebSearch: undefined };
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
  const [storeReplacementRequired, setStoreReplacementRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<'error' | 'success'>('error');
  const [probeState, setProbeState] = useState<Record<string, string>>({});
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

  const hasProfiles = profiles.length > 0;

  const load = async () => {
    setLoading(true);
    setMessage(null);
    const result = await getLlmProfiles();
    if (result.ok && result.data) {
      setProfiles(result.data.profiles);
      setDefaultProfileId(result.data.defaultProfileId);
      setStorePath(result.data.storePath);
      setStoreReplacementRequired(false);
    } else if (result.error === INVALID_PROFILE_STORE_SCHEMA) {
      const replacementDrafts = currentProfileReplacementDrafts();
      setProfiles(replacementDrafts);
      setDefaultProfileId(
        replacementDrafts.find((profile) => (
          profile.id === DEFAULT_REPLACEMENT_PROFILE_ID && profile.enabled
        ))?.id ?? replacementDrafts.find((profile) => profile.enabled)?.id
      );
      setStorePath(undefined);
      setSecrets({});
      setProbeState({});
      setStoreReplacementRequired(true);
      setMessageTone('error');
    } else {
      setMessageTone('error');
      setMessage(result.message ?? t(language, 'settings.llm.loadFailed'));
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  const updateProfile = (
    id: string,
    patch: ProfileCommonPatch
  ) => {
    setProfiles((prev) =>
      prev.map((profile) =>
        profile.id === id ? { ...profile, ...patch } : profile
      )
    );
  };

  const updateProfileProviderKind = (
    id: string,
    kind: LlmProviderKind,
  ) => {
    setProfiles((prev) =>
      prev.map((profile) =>
        profile.id === id ? profileWithProviderKind(profile, kind) : profile
      )
    );
  };

  const updateProfileEnabled = (id: string, enabled: boolean) => {
    updateProfile(id, { enabled });
  };

  const addProfile = (
    preset?: NewProfile
  ) => {
    const profile = createProfile(preset);
    setProfiles((prev) => [...prev, profile]);
    if (profile.enabled) {
      setDefaultProfileId((prev) => prev ?? profile.id);
    }
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
    const savableProfiles = profiles;
    const replacementProfileMissingApiKey = storeReplacementRequired
      ? savableProfiles.find((profile) => (
        profile.enabled
        && profile.kind !== 'ollama'
        && !profile.secretRef
        && !secrets[profile.id]?.trim()
      ))
      : undefined;
    if (replacementProfileMissingApiKey) {
      setMessageTone('error');
      setMessage(t(language, 'settings.llm.reenterRecoveredApiKey', {
        name: replacementProfileMissingApiKey.name,
      }));
      setLoading(false);
      return;
    }
    const result = await patchLlmProfiles({
      profiles: savableProfiles,
      defaultProfileId,
      secrets,
    });
    if (result.ok && result.data) {
      setProfiles(result.data.profiles);
      setDefaultProfileId(result.data.defaultProfileId);
      setStorePath(result.data.storePath);
      setSecrets({});
      setStoreReplacementRequired(false);
      setMessageTone('success');
      setMessage(t(language, 'settings.llm.saved'));
      window.dispatchEvent(new CustomEvent('deepcode:llm-profiles-updated'));
    } else {
      setMessageTone('error');
      setMessage(result.message ?? t(language, 'settings.llm.saveFailed'));
    }
    setLoading(false);
  };

  const probe = async (profileId: string) => {
    setProbeState((prev) => ({ ...prev, [profileId]: t(language, 'settings.llm.probing') }));
    const result = await probeLlmProfile({ profileId });
    if (result.ok && result.data) {
      setProbeState((prev) => ({
        ...prev,
        [profileId]: result.data!.ok
          ? t(language, 'settings.llm.probeSucceeded', {
              latency: result.data!.latencyMs ?? 0,
            })
          : result.data!.error ?? t(language, 'settings.llm.probeFailed'),
      }));
    } else {
      setProbeState((prev) => ({
        ...prev,
        [profileId]: result.message ?? t(language, 'settings.llm.probeFailed'),
      }));
    }
  };

  const defaultOptions = useMemo(
    () => profiles
      .filter((profile) => profile.enabled)
      .map((profile) => ({ id: profile.id, name: profile.name })),
    [profiles]
  );

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.llm.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">{t(language, 'settings.llm.profiles')}</h3>
        <p className="settings-card__body">
          {t(language, 'settings.llm.body')}
        </p>

        {storeReplacementRequired && (
          <div className="settings-recovery-notice" role="alert">
            {t(language, 'settings.llm.replaceInvalidStore')}
          </div>
        )}

        <div className="settings-toolbar-row">
          <button
            className="settings-action-button"
            onClick={() => addProfile()}
            disabled={loading}
          >
            {t(language, 'settings.llm.addProfile')}
          </button>
          {PROFILE_PRESETS.map((preset) => (
            <button
              className="settings-action-button"
              key={preset.labelKey}
              onClick={() => addProfile(preset.profile)}
              disabled={loading}
            >
              {t(language, preset.labelKey)}
            </button>
          ))}
          <button
            className="settings-action-button"
            onClick={() => void save()}
            disabled={loading || !hasProfiles}
          >
            {t(language, 'settings.common.save')}
          </button>
          <button
            className="settings-action-button"
            onClick={() => void load()}
            disabled={loading}
          >
            {t(language, 'settings.common.reload')}
          </button>
        </div>

        {defaultOptions.length > 0 && (
          <label className="llm-default-row">
            <span>{t(language, 'settings.llm.defaultProfile')}</span>
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
            {t(language, 'settings.llm.empty')}
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
                  placeholder={t(language, 'settings.llm.profileName')}
                />
                <select
                  className="settings-field__select"
                  value={profile.kind}
                  onChange={(e) => updateProfileProviderKind(
                    profile.id,
                    e.target.value as LlmProviderKind,
                  )}
                >
                  {PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {t(language, `settings.llm.providerKind.${provider}`)}
                    </option>
                  ))}
                </select>
                <label className="llm-profile__enabled">
                  <input
                    type="checkbox"
                    checked={profile.enabled}
                    onChange={(e) => updateProfileEnabled(
                      profile.id,
                      e.target.checked,
                    )}
                  />
                  {t(language, 'settings.common.enabled')}
                </label>
              </div>

              <div className="llm-profile__grid">
                <label>
                  <span>{t(language, 'settings.llm.providerFlavor')}</span>
                  <select
                    className="settings-field__select"
                    value={profile.providerFlavor}
                    onChange={(e) => updateProfile(profile.id, {
                      providerFlavor: e.target.value as LlmProviderFlavor,
                    })}
                  >
                    {PROVIDER_FLAVORS.map((flavor) => (
                      <option key={flavor} value={flavor}>
                        {t(language, `settings.llm.providerFlavor.${flavor}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t(language, 'settings.llm.hostedWebSearch')}</span>
                  <select
                    className="settings-field__select"
                    value={profile.hostedWebSearch ?? 'none'}
                    disabled={profile.kind !== 'responses'}
                    onChange={(e) => updateProfile(profile.id, {
                      hostedWebSearch: e.target.value === 'web_search'
                        ? 'web_search' as LlmHostedWebSearch
                        : undefined,
                    })}
                  >
                    <option value="none">
                      {t(language, 'settings.llm.hostedWebSearch.none')}
                    </option>
                    <option value="web_search">
                      {t(language, 'settings.llm.hostedWebSearch.webSearch')}
                    </option>
                  </select>
                </label>
                <label>
                  <span>{t(language, 'settings.llm.baseUrl')}</span>
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
                  <span>{t(language, 'settings.llm.model')}</span>
                  <input
                    className="settings-field__input"
                    list="llm-model-options"
                    value={profile.model}
                    onChange={(e) =>
                      updateProfile(profile.id, { model: e.target.value })
                    }
                    placeholder="deepseek-v4-flash"
                  />
                  <datalist id="llm-model-options">
                    {[
                      ...DEEPSEEK_LLM_MODEL_OPTIONS,
                      ...GLM_LLM_MODEL_OPTIONS,
                      ...KIMI_LLM_MODEL_OPTIONS,
                    ].map((model) => (
                      <option
                        key={model}
                        value={model}
                        label={
                          (DEPRECATED_DEEPSEEK_LLM_MODELS as readonly string[]).includes(model)
                            ? t(language, 'settings.llm.deprecatedModel', { model })
                            : model
                        }
                      />
                    ))}
                  </datalist>
                </label>
                <label>
                  <span>{t(language, 'settings.llm.apiKey')}</span>
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
                    placeholder={profile.secretRef
                      ? t(language, 'settings.llm.configured')
                      : t(language, 'settings.llm.pasteKey')}
                  />
                </label>
                <label>
                  <span>{t(language, 'settings.llm.contextWindowTokens')}</span>
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
                  <span>{t(language, 'settings.llm.maxOutputTokens')}</span>
                  <input
                    className="settings-field__input"
                    type="number"
                    min={1}
                    value={profile.maxOutputTokens ?? ''}
                    onChange={(e) =>
                      updateProfile(profile.id, {
                        maxOutputTokens: optionalNumber(e.target.value),
                      })
                    }
                    placeholder="384000"
                  />
                </label>
                <label>
                  <span>{t(language, 'settings.llm.thinking')}</span>
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
                    <option value="">{t(language, 'settings.source.default')}</option>
                    <option value="enabled">{t(language, 'settings.common.enabled')}</option>
                    <option value="disabled">{t(language, 'settings.common.disabled')}</option>
                  </select>
                </label>
                <label>
                  <span>{t(language, 'settings.llm.reasoningEffort')}</span>
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
                    <option value="">{t(language, 'settings.source.default')}</option>
                    <option value="low">{t(language, 'settings.llm.effort.low')}</option>
                    <option value="medium">{t(language, 'settings.llm.effort.medium')}</option>
                    <option value="high">{t(language, 'settings.llm.effort.high')}</option>
                    <option value="max">{t(language, 'settings.llm.effort.max')}</option>
                  </select>
                </label>
              </div>
              {profile.thinking === 'enabled' && (
                <div className="settings-card__hint">
                  {t(language, 'settings.llm.thinkingHint')}
                </div>
              )}
              <div className="llm-profile__actions">
                <button
                  className="settings-action-button"
                  onClick={() => void probe(profile.id)}
                  disabled={
                    loading
                    || (profile.kind !== 'ollama' && !profile.secretRef)
                    || !!secrets[profile.id]
                  }
                  title={secrets[profile.id]
                    ? t(language, 'settings.llm.saveKeyBeforeProbe')
                    : t(language, 'settings.llm.probe')}
                >
                  {t(language, 'settings.llm.probe')}
                </button>
                <button
                  className="settings-action-button"
                  onClick={() => removeProfile(profile.id)}
                  disabled={loading}
                >
                  {t(language, 'settings.common.remove')}
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
          <div className="settings-card__hint">
            {t(language, 'settings.llm.profileStoreLoaded')}
          </div>
        )}
        {message && (
          <div
            className={messageTone === 'success' ? 'settings-save-message' : 'settings-error'}
            role={messageTone === 'success' ? 'status' : 'alert'}
          >
            {message}
          </div>
        )}
      </div>
    </div>
  );
};

export default LlmSection;
