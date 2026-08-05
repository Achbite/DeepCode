import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { LlmProviderProfile } from '@deepcode/protocol';
import { hasCompatibleReasoningTransport } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { getLlmProfiles } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import useAppStatusStore from '../../state/appStatusStore';

interface SessionModelSelectorProps {
  language: UiLanguage;
  locked: boolean;
  onAvailabilityChange: (available: boolean) => void;
}

function profileLabel(profile: LlmProviderProfile): string {
  return profile.name;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  locked,
  onAvailabilityChange,
}) => {
  const session = useAgentSessionStore((state) => state.session);
  const apiStatus = useAppStatusStore((state) => state.apiStatus);
  const profileSelectionBusy = useAgentSessionStore((state) => state.profileSelectionBusy);
  const selectProfile = useAgentSessionStore((state) => state.selectProfile);
  const refreshSessionProfile = useAgentSessionStore((state) => state.refreshSessionProfile);
  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string | undefined>();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');

  const loadProfiles = useCallback(async (): Promise<LlmProviderProfile[]> => {
    let result;
    try {
      result = await getLlmProfiles();
    } catch {
      setProfiles([]);
      setDefaultProfileId(undefined);
      setLoadState('error');
      onAvailabilityChange(false);
      return [];
    }
    if (!result.ok || !result.data) {
      setProfiles([]);
      setDefaultProfileId(undefined);
      setLoadState('error');
      onAvailabilityChange(false);
      return [];
    }
    const enabledProfiles = result.data.profiles.filter(
      (profile) => (
        profile.enabled
        && profile.thinking === 'enabled'
        && hasCompatibleReasoningTransport(profile)
      )
    );
    setProfiles(enabledProfiles);
    setDefaultProfileId(
      enabledProfiles.some((profile) => profile.id === result.data!.defaultProfileId)
        ? result.data.defaultProfileId
        : undefined
    );
    setLoadState('ready');
    onAvailabilityChange(enabledProfiles.length > 0);
    return enabledProfiles;
  }, [onAvailabilityChange]);

  useEffect(() => {
    if (apiStatus !== 'connected') {
      setLoadState(apiStatus === 'checking' ? 'loading' : 'error');
      onAvailabilityChange(false);
      return;
    }
    setLoadState('loading');
    void loadProfiles();
  }, [apiStatus, loadProfiles, onAvailabilityChange]);

  useEffect(() => {
    const onProfilesUpdated = () => {
      void (async () => {
        await loadProfiles();
        await refreshSessionProfile();
      })();
    };
    window.addEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
  }, [loadProfiles, refreshSessionProfile]);

  const selectedProfileId = session?.profileId ?? defaultProfileId ?? '';
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId),
    [profiles, selectedProfileId]
  );
  const unavailable = loadState !== 'ready' || profiles.length === 0;
  const disabled = locked || profileSelectionBusy || unavailable || !session;
  const selectorTitle = locked
    ? t(language, 'agent.profile.locked')
    : loadState === 'loading'
      ? t(language, 'agent.profile.loading')
      : loadState === 'error'
        ? t(language, 'agent.profile.loadFailed')
        : profiles.length === 0
          ? t(language, 'agent.profile.unavailable')
          : selectedProfile
            ? profileLabel(selectedProfile)
            : t(language, 'agent.profile.selector');

  return (
    <div className="deepcode-session-model">
      <span
        className="deepcode-session-model__context"
        aria-label={t(language, 'agent.profile.contextPlaceholder')}
        aria-disabled="true"
        title={t(language, 'agent.profile.contextUnavailable')}
      >
        --%
      </span>
      <label className="deepcode-session-model__selector" title={selectorTitle}>
        <span className="deepcode-session-model__label">{t(language, 'agent.profile.selector')}</span>
        <select
          value={selectedProfile ? selectedProfileId : ''}
          disabled={disabled}
          aria-label={t(language, 'agent.profile.selector')}
          onChange={(event) => void selectProfile(event.target.value)}
        >
          {!selectedProfile && (
            <option value="">
              {loadState === 'loading'
                ? t(language, 'agent.profile.loading')
                : loadState === 'error'
                  ? t(language, 'agent.profile.loadFailed')
                  : t(language, 'agent.profile.unavailable')}
            </option>
          )}
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profileLabel(profile)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};

export default SessionModelSelector;
