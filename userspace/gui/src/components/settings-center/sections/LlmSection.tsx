import { useSettingsSearchEntries } from '../settingsSearch';
import React, { useEffect, useMemo, useState } from 'react';
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_LLM_MODEL_OPTIONS,
  DEEPSEEK_OPENAI_BASE_URL,
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
  LlmProfilesResult,
} from '@deepcode/protocol';
import {
  getLlmProfiles,
  patchLlmProfiles,
  probeLlmProfile,
} from '../../../services/runtimeAdapter';
import { useSettingsStore } from '../../../state/settingsStore';
import { normalizeUiLanguage, t, type UiLanguage } from '../../../i18n';

const PROVIDERS: LlmProviderKind[] = ['openaiCompatible', 'responses', 'anthropic', 'ollama'];

const PROVIDER_FLAVORS: LlmProviderFlavor[] = [
  'openai',
  'deepseek',
  'zhipu',
  'moonshot',
];

const INVALID_PROFILE_STORE_SCHEMA = 'invalid_llm_profile_store_schema';

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
      name: 'DeepSeek Flash',
      kind: 'responses',
      providerFlavor: 'deepseek',
      baseUrl: DEEPSEEK_OPENAI_BASE_URL,
      model: 'deepseek-flash',
      contextWindowTokens: 1000000,
      maxOutputTokens: 384000,
      temperature: 0.2,
      reasoningEffort: 'high',
      thinking: 'enabled',
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
      enabled: true,
    },
  },
  {
    labelKey: 'settings.llm.preset.deepseekAnthropic',
    profile: {
      name: 'DeepSeek Flash (Anthropic)',
      kind: 'anthropic',
      providerFlavor: 'deepseek',
      baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
      model: 'deepseek-flash',
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
      name: 'GLM 5.3',
      kind: 'openaiCompatible',
      providerFlavor: 'zhipu',
      baseUrl: GLM_OPENAI_BASE_URL,
      model: 'glm-5.3',
      contextWindowTokens: 1000000,
      maxOutputTokens: 131072,
      thinking: 'enabled',
      reasoningEffort: 'max',
      enabled: true,
    },
  },
  {
    labelKey: 'settings.llm.preset.kimi',
    profile: {
      name: 'Kimi K3',
      kind: 'openaiCompatible',
      providerFlavor: 'moonshot',
      baseUrl: KIMI_OPENAI_BASE_URL,
      model: 'kimi-k3',
      contextWindowTokens: 1000000,
      maxOutputTokens: 32768,
      reasoningEffort: 'max',
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
    name: 'OpenAI GPT-6 Astra',
    kind: 'responses',
    providerFlavor: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6-astra',
    contextWindowTokens: 1050000,
    maxOutputTokens: 128000,
    reasoningEffort: 'high',
    hostedWebSearch: 'web_search',
    enabled: false,
  };
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

type ProfileReadState = { status: 'loading' | 'loaded' } | { status: 'failed'; error: string };
type ProfileFeedback = { tone: 'error' | 'success'; message: string };

export function LlmProfileReadNotice({ state, hasProfiles, language }: {
  state: ProfileReadState; hasProfiles: boolean; language: UiLanguage;
}) {
  if (state.status === 'failed') {
    return <div className="settings-error" role="alert">
      {t(language, 'settings.llm.loadFailed')}: {state.error}
    </div>;
  }
  if (state.status !== 'loaded' || hasProfiles) return null;
  return <div className="settings-card__hint">{t(language, 'settings.llm.empty')}</div>;
}

const LlmSection: React.FC = () => {
  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([]);
  const [savedProfiles, setSavedProfiles] = useState<LlmProviderProfile[]>([]);
  const [profileRead, setProfileRead] = useState<ProfileReadState>({ status: 'loading' });
  const [defaultProfileId, setDefaultProfileId] = useState<string | undefined>();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [storeRepairRequired, setStoreRepairRequired] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    kind: 'save' | 'remove' | 'default'; profileId?: string;
  } | null>(null);
  const [profileFeedback, setProfileFeedback] = useState<Record<string, ProfileFeedback>>({});
  const [defaultFeedback, setDefaultFeedback] = useState<ProfileFeedback | null>(null);
  const [probeState, setProbeState] = useState<Record<string, string>>({});
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );

  const hasProfiles = profiles.length > 0;
  const profileStoreWritable = profileRead.status === 'loaded' || storeRepairRequired;

  const load = async () => {
    setLoading(true);
    setProfileRead({ status: 'loading' });
    setDefaultFeedback(null);
    const result = await getLlmProfiles();
    if (result.data && (result.ok || result.error === INVALID_PROFILE_STORE_SCHEMA)) {
      setProfiles(result.data.profiles);
      setSavedProfiles(result.data.profiles);
      setSecrets({});
      setProfileFeedback({});
      setProbeState({});
      setDefaultProfileId(result.data.defaultProfileId);
      setStoreRepairRequired(!result.ok);
      setProfileRead(result.ok
        ? { status: 'loaded' }
        : { status: 'failed', error: result.message ?? result.error! });
    } else {
      setStoreRepairRequired(result.error === INVALID_PROFILE_STORE_SCHEMA);
      setProfileRead({ status: 'failed', error: result.message ?? result.error ?? t(language, 'settings.llm.loadFailed') });
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
    if (storeRepairRequired && profile.enabled) {
      setDefaultProfileId((prev) => prev ?? profile.id);
    }
  };

  const removeDraft = (id: string) => {
    setProfiles((prev) => prev.filter((profile) => profile.id !== id));
    setSecrets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

    setProfileFeedback((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setProbeState((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const acceptSavedResult = (data: LlmProfilesResult) => {
    setSavedProfiles(data.profiles);
    setDefaultProfileId(data.defaultProfileId);
    setStoreRepairRequired(false);
    setProfileRead({ status: 'loaded' });
    window.dispatchEvent(new CustomEvent('deepcode:llm-profiles-updated'));
  };

  const save = async (profile: LlmProviderProfile) => {
    if (loading || pendingAction || !profileStoreWritable) return;
    setPendingAction({ kind: 'save', profileId: profile.id });
    setProfileFeedback((prev) => {
      const next = { ...prev };
      delete next[profile.id];
      return next;
    });
    const result = await patchLlmProfiles({
      profile,
      ...(storeRepairRequired && defaultProfileId ? { defaultProfileId } : {}),
      ...(secrets[profile.id] ? { secrets: { [profile.id]: secrets[profile.id] } } : {}),
    });
    if (result.ok && result.data) {
      const savedProfile = result.data.profiles.find((item) => item.id === profile.id);
      if (savedProfile) {
        setProfiles((prev) => prev.map((item) => item.id === profile.id ? savedProfile : item));
        setSecrets((prev) => {
          const next = { ...prev };
          delete next[profile.id];
          return next;
        });
        acceptSavedResult(result.data);
        setProfileFeedback((prev) => ({
          ...prev, [profile.id]: { tone: 'success', message: t(language, 'settings.llm.saved') },
        }));
      } else {
        setProfileFeedback((prev) => ({
          ...prev, [profile.id]: { tone: 'error', message: t(language, 'settings.llm.savedProfileMissing') },
        }));
      }
    } else {
      setProfileFeedback((prev) => ({
        ...prev, [profile.id]: { tone: 'error', message: result.message ?? result.error ?? t(language, 'settings.llm.saveFailed') },
      }));
    }
    setPendingAction(null);
  };

  const removeProfile = async (id: string) => {
    if (loading || pendingAction) return;
    if (!savedProfiles.some((profile) => profile.id === id)) {
      removeDraft(id);
      if (storeRepairRequired && defaultProfileId === id) setDefaultProfileId(undefined);
      return;
    }
    if (!profileStoreWritable) return;
    setPendingAction({ kind: 'remove', profileId: id });
    const result = await patchLlmProfiles({ removeProfileId: id });
    if (result.ok && result.data) {
      removeDraft(id);
      acceptSavedResult(result.data);
    } else {
      setProfileFeedback((prev) => ({
        ...prev, [id]: { tone: 'error', message: result.message ?? result.error ?? t(language, 'settings.llm.removeFailed') },
      }));
    }
    setPendingAction(null);
  };

  const saveDefault = async (id: string) => {
    if (loading || pendingAction) return;
    setDefaultFeedback(null);
    if (storeRepairRequired) {
      setDefaultProfileId(id);
      return;
    }
    if (!profileStoreWritable) return;
    setPendingAction({ kind: 'default' });
    const result = await patchLlmProfiles({ defaultProfileId: id });
    if (result.ok && result.data) {
      acceptSavedResult(result.data);
      setDefaultFeedback({ tone: 'success', message: t(language, 'settings.llm.defaultSaved') });
    } else {
      setDefaultFeedback({ tone: 'error', message: result.message ?? result.error ?? t(language, 'settings.llm.saveFailed') });
    }
    setPendingAction(null);
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
    () => (storeRepairRequired ? profiles : savedProfiles)
      .filter((profile) => profile.enabled)
      .map((profile) => ({ id: profile.id, name: profile.name })),
    [profiles, savedProfiles, storeRepairRequired]
  );

  const defaultValid = defaultOptions.some((profile) => profile.id === defaultProfileId);
  useSettingsSearchEntries('llm-profiles', profiles.map((profile) => ({ id: `profile-${profile.id}`, title: profile.name || profile.model, keywords: [profile.model, profile.baseUrl, profile.kind].join(' '), category: 'llm' })));
  const showDefaultControl = savedProfiles.length > 0 || !!defaultProfileId
    || (storeRepairRequired && hasProfiles);
  const selectedDefault = (storeRepairRequired ? profiles : savedProfiles)
    .find((profile) => profile.id === defaultProfileId);

  return (
    <div className="llm-settings">
      <h2 className="settings-title">{t(language, 'settings.llm.title')}</h2>

      <div className="llm-settings__content">
        {storeRepairRequired && (
          <div className="settings-recovery-notice" role="alert">
            {t(language, 'settings.llm.repairInvalidStore')}
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
          <select
            className="settings-field__select"
            aria-label={t(language, 'settings.llm.addPreset')}
            value=""
            onChange={(event) => {
              const preset = PROFILE_PRESETS.find((item) => item.labelKey === event.target.value);
              if (preset) addProfile(preset.profile);
            }}
            disabled={loading}
          >
            <option value="" disabled>{t(language, 'settings.llm.addPreset')}</option>
            {PROFILE_PRESETS.map((preset) => (
              <option key={preset.labelKey} value={preset.labelKey}>
                {t(language, preset.labelKey)}
              </option>
            ))}
          </select>
          <button
            className="settings-action-button llm-settings__reload"
            onClick={() => void load()}
            disabled={loading || !!pendingAction}
          >
            {t(language, 'settings.common.reload')}
          </button>
        </div>

        {showDefaultControl && !storeRepairRequired && (
          <div className="llm-default-row">
            <span>{language === 'zh-CN' ? '最近使用的模型' : 'Last used model'}</span>
            <span>{selectedDefault?.name ?? (language === 'zh-CN' ? '尚未提交任务' : 'No task submitted yet')}</span>
          </div>
        )}
        {showDefaultControl && storeRepairRequired && (
          <label className="llm-default-row">
            <span>{t(language, 'settings.llm.defaultProfile')}</span>
            <select
              className="settings-field__select"
              value={defaultProfileId ?? ''}
              onChange={(e) => void saveDefault(e.target.value)}
              disabled={loading || !!pendingAction || !profileStoreWritable || defaultOptions.length === 0}
            >
              {!defaultValid && <option value={defaultProfileId ?? ''} disabled>
                {selectedDefault?.name ?? defaultProfileId ?? t(language, 'agent.profile.selectionRequired')}
                {defaultProfileId ? ` · ${t(language, selectedDefault ? 'agent.profile.disabled' : 'agent.profile.missing')}` : ''}
              </option>}
              {defaultOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {storeRepairRequired && defaultOptions.length > 0 && (
          <p className="llm-settings__default-hint">
            {t(language, 'settings.llm.defaultRepairHint')}
          </p>
        )}
        {defaultFeedback && (
          <div
            className={defaultFeedback.tone === 'error' ? 'settings-error' : 'llm-profile__status'}
            role={defaultFeedback.tone === 'error' ? 'alert' : 'status'}
          >
            {defaultFeedback.message}
          </div>
        )}

        {showDefaultControl && !defaultValid && <p className="settings-card__hint" role="alert">
          {t(language, 'settings.llm.defaultUnavailable')}
        </p>}

        <LlmProfileReadNotice state={profileRead} hasProfiles={hasProfiles} language={language} />

        <div className="llm-profile-list">
          {profiles.map((profile) => {
            const savedProfile = savedProfiles.find((item) => item.id === profile.id);
            const hasUnsavedChanges = !savedProfile
              || JSON.stringify(profile) !== JSON.stringify(savedProfile)
              || !!secrets[profile.id];
            const feedback = profileFeedback[profile.id];
            return (
            <fieldset
              id={`setting-profile-${profile.id}`} tabIndex={-1}
              className="llm-profile"
              key={profile.id}
              aria-label={profile.name || t(language, 'settings.llm.profileName')}
              disabled={loading || pendingAction?.profileId === profile.id}
            >
              <div className="llm-profile__header">
                <label className="llm-profile__name">
                  <span>{t(language, 'settings.llm.profileName')}</span>
                  <input
                    className="settings-field__input"
                    value={profile.name}
                    onChange={(e) => updateProfile(profile.id, { name: e.target.value })}
                    placeholder={t(language, 'settings.llm.profileName')}
                  />
                </label>
                <label className="llm-profile__protocol">
                  <span>{t(language, 'settings.llm.protocol')}</span>
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
                </label>
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
              <div className="llm-profile__actions">
                <button
                  className="settings-action-button"
                  onClick={() => void probe(profile.id)}
                  disabled={
                    loading || !!pendingAction || !profileStoreWritable
                    || !savedProfile || hasUnsavedChanges
                    || (savedProfile.kind !== 'ollama' && !savedProfile.secretRef)
                  }
                  title={hasUnsavedChanges
                    ? t(language, 'settings.llm.saveBeforeProbe')
                    : t(language, 'settings.llm.probe')}
                >
                  {t(language, 'settings.llm.probe')}
                </button>
                <button
                  className="settings-action-button llm-profile__remove"
                  onClick={() => void removeProfile(profile.id)}
                  disabled={loading || !!pendingAction || (!!savedProfile && !profileStoreWritable)}
                  title={savedProfile && defaultProfileId === profile.id
                    ? t(language, 'settings.llm.removeDefaultHint')
                    : t(language, 'settings.common.remove')}
                >
                  {t(language, 'settings.common.remove')}
                </button>
                <button
                  className="settings-action-button llm-profile__save"
                  onClick={() => void save(profile)}
                  disabled={loading || !!pendingAction || !profileStoreWritable}
                >
                  {t(language, pendingAction?.kind === 'save' && pendingAction.profileId === profile.id
                    ? 'settings.llm.savingProfile'
                    : 'settings.llm.saveProfile')}
                </button>
              </div>
              {feedback && (
                <div
                  className={feedback.tone === 'error' ? 'settings-error' : 'llm-profile__status'}
                  role={feedback.tone === 'error' ? 'alert' : 'status'}
                >
                  {feedback.message}
                </div>
              )}
              {probeState[profile.id] && (
                <div className="llm-profile__status" role="status">
                  {probeState[profile.id]}
                </div>
              )}
            </fieldset>
            );
          })}
        </div>

        <datalist id="llm-model-options">
          {[
            ...DEEPSEEK_LLM_MODEL_OPTIONS,
            ...GLM_LLM_MODEL_OPTIONS,
            ...KIMI_LLM_MODEL_OPTIONS,
          ].map((model) => <option key={model} value={model} />)}
        </datalist>

      </div>
    </div>
  );
};

export default LlmSection;
