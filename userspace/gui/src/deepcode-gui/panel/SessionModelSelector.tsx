import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentSessionProfileMigration,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { getLlmProfiles } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';

interface SessionModelSelectorProps {
  language: UiLanguage;
  locked: boolean;
  onAvailabilityChange: (available: boolean) => void;
}

interface ProfilesUpdatedDetail {
  profileMigrations?: AgentSessionProfileMigration[];
}

function profileProvider(profile: LlmProviderProfile): string {
  return profile.providerFlavor ?? profile.kind;
}

function profileLabel(profile: LlmProviderProfile, language: UiLanguage): string {
  const effort = profile.reasoningEffort ?? t(language, 'agent.profile.reasoningDefault');
  return `${profile.name} · ${profileProvider(profile)}/${profile.model} · ${effort}`;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  locked,
  onAvailabilityChange,
}) => {
  const session = useAgentSessionStore((state) => state.session);
  const profileSelectionBusy = useAgentSessionStore((state) => state.profileSelectionBusy);
  const selectProfile = useAgentSessionStore((state) => state.selectProfile);
  const refreshSessionProfile = useAgentSessionStore((state) => state.refreshSessionProfile);
  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [migrationNotice, setMigrationNotice] = useState<string | null>(null);

  const loadProfiles = useCallback(async (): Promise<LlmProviderProfile[]> => {
    let result;
    try {
      result = await getLlmProfiles();
    } catch {
      setProfiles([]);
      setLoadState('error');
      onAvailabilityChange(false);
      return [];
    }
    if (!result.ok || !result.data) {
      setProfiles([]);
      setLoadState('error');
      onAvailabilityChange(false);
      return [];
    }
    const enabledProfiles = result.data.profiles.filter((profile) => profile.enabled);
    setProfiles(enabledProfiles);
    setLoadState('ready');
    onAvailabilityChange(enabledProfiles.length > 0);
    return enabledProfiles;
  }, [onAvailabilityChange]);

  useEffect(() => {
    setLoadState('loading');
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    const onProfilesUpdated = (event: Event) => {
      const detail = (event as CustomEvent<ProfilesUpdatedDetail>).detail;
      const migration = detail?.profileMigrations?.find((item) => item.sessionId === session?.id);
      void (async () => {
        const nextProfiles = await loadProfiles();
        if (!migration) return;
        await refreshSessionProfile();
        const migratedProfile = nextProfiles.find((profile) => profile.id === migration.toProfileId);
        setMigrationNotice(t(language, 'agent.profile.migrated', {
          profile: migratedProfile?.name ?? migration.toProfileId,
        }));
      })();
    };
    window.addEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
  }, [language, loadProfiles, refreshSessionProfile, session?.id]);

  const selectedProfileId = session?.profileId ?? '';
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
            ? profileLabel(selectedProfile, language)
            : t(language, 'agent.profile.selector');

  return (
    <div className="deepcode-session-model">
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
              {profileLabel(profile, language)}
            </option>
          ))}
        </select>
      </label>
      <span
        className="deepcode-session-model__context"
        aria-label={t(language, 'agent.profile.contextPlaceholder')}
        aria-disabled="true"
        title={t(language, 'agent.profile.contextUnavailable')}
      >
        --%
      </span>
      {migrationNotice && (
        <span className="deepcode-session-model__notice" role="status">
          {migrationNotice}
          <button
            type="button"
            aria-label="×"
            onClick={() => setMigrationNotice(null)}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
};

export default SessionModelSelector;
