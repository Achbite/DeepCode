import React, { useMemo } from 'react';
import type { AgentComposerProjectionV1 } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface SessionModelSelectorProps {
  language: UiLanguage;
  composer: AgentComposerProjectionV1 | null;
  selectedProfileId?: string;
  busy?: boolean;
  onProfileChange: (profileId: string) => void | Promise<void>;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  composer,
  selectedProfileId,
  busy = false,
  onProfileChange,
}) => {
  const profiles = composer?.enabledProfiles ?? [];
  const effectiveProfileId = selectedProfileId
    ?? composer?.selectedProfileId
    ?? composer?.defaultProfileId
    ?? '';
  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profileId === effectiveProfileId),
    [effectiveProfileId, profiles]
  );
  const locked = composer ? !composer.selectionMutable : true;
  const unavailable = !composer || profiles.length === 0;
  const disabled = busy || locked || unavailable;
  const selectorTitle = !composer
    ? t(language, 'agent.profile.loading')
    : locked
      ? t(language, 'agent.profile.locked')
      : profiles.length === 0
        ? t(language, 'agent.profile.unavailable')
        : selectedProfile
          ? selectedProfile.name
          : t(language, 'agent.profile.selectionRequired');

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
          value={selectedProfile ? effectiveProfileId : ''}
          disabled={disabled}
          aria-label={t(language, 'agent.profile.selector')}
          onChange={(event) => {
            if (event.target.value) void onProfileChange(event.target.value);
          }}
        >
          {!selectedProfile && (
            <option value="">
              {!composer
                ? t(language, 'agent.profile.loading')
                : profiles.length === 0
                  ? t(language, 'agent.profile.unavailable')
                  : t(language, 'agent.profile.selectionRequired')}
            </option>
          )}
          {profiles.map((profile) => (
            <option key={profile.profileId} value={profile.profileId}>
              {profile.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
};

export default SessionModelSelector;
