import React, { useMemo } from 'react';
import SettingsField from '../SettingsField';
import {
  SETTING_DEFINITIONS,
  useSettingsStore,
  type SettingDefinition,
} from '../../../state/settingsStore';
import type { UserSettingValue } from '@deepcode/protocol';

interface CommonSettingsSectionProps {
  serverVersion?: string;
  apiStatus: string;
  wsStatus: string;
  query?: string;
}

const GROUP_TITLES: Record<string, string> = {
  workbench: 'Workbench',
  editor: 'Editor',
  files: 'Files',
  keyboard: 'Keyboard',
  explorer: 'Explorer',
  terminal: 'Terminal',
  agent: 'Agent',
};

const GROUP_ORDER = ['workbench', 'editor', 'files', 'keyboard', 'explorer', 'terminal', 'agent'];

function matchesQuery(definition: SettingDefinition, query: string): boolean {
  if (!query.trim()) return true;
  const target = [
    definition.key,
    definition.label,
    definition.description,
    definition.group,
  ].join(' ').toLowerCase();
  return target.includes(query.trim().toLowerCase());
}

function groupDefinitions(query = ''): Record<string, SettingDefinition[]> {
  return SETTING_DEFINITIONS
    .filter((definition) => matchesQuery(definition, query))
    .reduce<Record<string, SettingDefinition[]>>((acc, item) => {
      if (!acc[item.group]) acc[item.group] = [];
      acc[item.group].push(item);
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
  const sources = useSettingsStore((s) => s.sources);
  const loading = useSettingsStore((s) => s.loading);
  const errorMessage = useSettingsStore((s) => s.errorMessage);
  const storePath = useSettingsStore((s) => s.storePath);
  const patchUserSetting = useSettingsStore((s) => s.patchUserSetting);
  const resetUserSetting = useSettingsStore((s) => s.resetUserSetting);

  const grouped = useMemo(() => groupDefinitions(query), [query]);
  const orderedGroups = useMemo(
    () => GROUP_ORDER.filter((group) => grouped[group]?.length),
    [grouped]
  );

  const handleChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };

  return (
    <div>
      <h2 className="settings-title">Common Settings</h2>

      <div className="settings-card">
        <h3 className="settings-card__title">Runtime Information</h3>
        <table className="settings-kv">
          <tbody>
            <tr>
              <td>Product</td>
              <td>DeepCode</td>
            </tr>
            <tr>
              <td>Server version</td>
              <td>{serverVersion ?? '-'}</td>
            </tr>
            <tr>
              <td>API status</td>
              <td>{apiStatus}</td>
            </tr>
            <tr>
              <td>WebSocket status</td>
              <td>{wsStatus}</td>
            </tr>
            <tr>
              <td>User settings file</td>
              <td>{storePath ?? 'Not loaded yet'}</td>
            </tr>
          </tbody>
        </table>
        {errorMessage && <div className="settings-error">{errorMessage}</div>}
      </div>

      {orderedGroups.length === 0 && (
        <div className="settings-card">
          <div className="settings-card__body">No settings match the current search.</div>
        </div>
      )}

      {orderedGroups.map((group) => (
        <div className="settings-card" key={group}>
          <h3 className="settings-card__title">{GROUP_TITLES[group] ?? group}</h3>
          <div className="settings-card__body">
            {group === 'workbench' && (
              <div className="settings-card__inline-placeholder">
                Language packs are reserved under <code>config/i18n/*.json</code>. Changing the display language is stored now; full UI reload/localization wiring lands in a later stage.
              </div>
            )}
            {(grouped[group] ?? []).map((definition) => (
              <SettingsField
                key={definition.key}
                definition={definition}
                value={effectiveSettings[definition.key]}
                source={sources[definition.key] ?? 'default'}
                disabled={loading || sources[definition.key] === 'workspace'}
                onChange={handleChange}
                onReset={(key) => void resetUserSetting(key)}
              />
            ))}
          </div>
          <div className="settings-card__hint">
            Workspace-sourced values are controlled by the current workspace and must be changed in workspace settings.
          </div>
        </div>
      ))}
    </div>
  );
};

export default CommonSettingsSection;
