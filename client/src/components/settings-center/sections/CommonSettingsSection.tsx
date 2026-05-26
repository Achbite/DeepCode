import React, { useMemo } from 'react';
import SettingsField from '../SettingsField';
import {
  SETTING_DEFINITIONS,
  useSettingsStore,
  type SettingDefinition,
} from '../../../state/settingsStore';
import type { UserSettingValue } from '@deepcode/protocol';
import { normalizeUiLanguage, t, type UiLanguage } from '../../../i18n';
import { localizeSettingDefinition } from '../../../settingsLocalization';

interface CommonSettingsSectionProps {
  serverVersion?: string;
  apiStatus: string;
  wsStatus: string;
  query?: string;
}

const GROUP_TITLE_KEYS: Record<string, string> = {
  workbench: 'settings.group.workbench',
  editor: 'settings.group.editor',
  files: 'settings.group.files',
  keyboard: 'settings.group.keyboard',
  explorer: 'settings.group.explorer',
  terminal: 'settings.group.terminal',
  agent: 'settings.group.agent',
};

const GROUP_ORDER = ['workbench', 'editor', 'files', 'keyboard', 'explorer', 'terminal', 'agent'];

function groupTitle(group: string, language: UiLanguage): string {
  const key = GROUP_TITLE_KEYS[group];
  return key ? t(language, key) : group;
}

function matchesQuery(
  definition: SettingDefinition,
  query: string,
  original: SettingDefinition
): boolean {
  if (!query.trim()) return true;
  const target = [
    definition.key,
    definition.label,
    definition.description,
    definition.group,
    original.label,
    original.description,
  ].join(' ').toLowerCase();
  return target.includes(query.trim().toLowerCase());
}

function groupDefinitions(query: string, language: UiLanguage): Record<string, SettingDefinition[]> {
  return SETTING_DEFINITIONS
    .map((definition) => ({
      original: definition,
      localized: localizeSettingDefinition(definition, language),
    }))
    .filter(({ localized, original }) => matchesQuery(localized, query, original))
    .reduce<Record<string, SettingDefinition[]>>((acc, item) => {
      if (!acc[item.localized.group]) acc[item.localized.group] = [];
      acc[item.localized.group].push(item.localized);
      return acc;
    }, {});
}

const CommonSettingsSection: React.FC<CommonSettingsSectionProps> = ({
  serverVersion,
  apiStatus,
  wsStatus,
  query = '',
}) => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const sources = useSettingsStore((s) => s.sources);
  const loading = useSettingsStore((s) => s.loading);
  const errorMessage = useSettingsStore((s) => s.errorMessage);
  const storePath = useSettingsStore((s) => s.storePath);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const resetUserSetting = useSettingsStore((s) => s.resetUserSetting);

  const grouped = useMemo(() => groupDefinitions(query, language), [language, query]);
  const orderedGroups = useMemo(
    () => GROUP_ORDER.filter((group) => grouped[group]?.length),
    [grouped]
  );

  const handleChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.common.title')}</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">
          {t(language, 'settings.runtime.title')}
        </h3>
        <table className="settings-kv">
          <tbody>
            <tr>
              <td>{t(language, 'settings.runtime.product')}</td>
              <td>DeepCode</td>
            </tr>
            <tr>
              <td>{t(language, 'settings.runtime.serverVersion')}</td>
              <td>{serverVersion ?? '-'}</td>
            </tr>
            <tr>
              <td>{t(language, 'settings.runtime.apiStatus')}</td>
              <td>{apiStatus}</td>
            </tr>
            <tr>
              <td>{t(language, 'settings.runtime.wsStatus')}</td>
              <td>{wsStatus}</td>
            </tr>
            <tr>
              <td>{t(language, 'settings.runtime.userSettingsFile')}</td>
              <td>{storePath ?? t(language, 'settings.runtime.notLoaded')}</td>
            </tr>
          </tbody>
        </table>
        {errorMessage && <div className="settings-error">{errorMessage}</div>}
      </div>

      {orderedGroups.length === 0 && (
        <div className="settings-card">
          <div className="settings-card__body">
            {t(language, 'settings.noSearchMatch')}
          </div>
        </div>
      )}

      {orderedGroups.map((group) => (
        <div className="settings-card" key={group}>
          <h3 className="settings-card__title">{groupTitle(group, language)}</h3>
          <div className="settings-card__body">
            {group === 'workbench' && (
              <div className="settings-card__inline-placeholder">
                {t(language, 'settings.workbench.i18n.prefix')}
                <code>config/i18n/*.json</code>
                {t(language, 'settings.workbench.i18n.suffix')}
              </div>
            )}
            {(grouped[group] ?? []).map((definition) => (
              <SettingsField
                key={definition.key}
                definition={definition}
                value={effectiveSettings[definition.key]}
                source={sources[definition.key] ?? 'default'}
                language={language}
                disabled={loading || sources[definition.key] === 'workspace'}
                onChange={handleChange}
                onReset={(key) => void resetUserSetting(key)}
              />
            ))}
          </div>
          <div className="settings-card__hint">
            {t(language, 'settings.workspaceHint')}
          </div>
        </div>
      ))}
    </div>
  );
};

export default CommonSettingsSection;
