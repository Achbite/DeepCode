import React, { useMemo } from 'react';
import type { UserSettingValue } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../../i18n';
import { localizeSettingDefinition } from '../../../settingsLocalization';
import {
  agentSettingDefinitions,
  shellPreferenceSettingDefinitions,
  useSettingsStore,
  type SettingDefinition,
} from '../../../state/settingsStore';
import GuiAppearanceSettings from '../GuiAppearanceSettings';
import SettingsField from '../SettingsField';

interface RuntimeProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  query?: string;
}

const APPEARANCE_KEYS = ['gui.colorTheme', 'gui.accentColor'] as const;
const INTERFACE_KEYS = [
  'workbench.language',
  'gui.navigationDensity',
  'gui.showContextRail',
] as const;
const AGENT_INSTRUCTION_KEYS = ['agent.systemPrompt'] as const;
const AGENT_PERMISSION_KEYS = [
  'agent.permissions.networkRead',
  'agent.permissions.external',
] as const;
const AGENT_WEB_KEYS = [
  'agent.web.search.endpointTemplate',
  'agent.web.search.authHeaderName',
  'agent.web.search.authSecretRef',
] as const;

function guiDefinitions(): SettingDefinition[] {
  return [
    ...shellPreferenceSettingDefinitions('editor').filter(
      (definition) => definition.key === 'workbench.language',
    ),
    ...shellPreferenceSettingDefinitions('gui'),
  ];
}

function definitionsFor(
  keys: readonly string[],
  available: readonly SettingDefinition[],
  language: ReturnType<typeof normalizeUiLanguage>,
  query: string,
): SettingDefinition[] {
  const byKey = new Map(available.map((definition) => [definition.key, definition]));
  const normalizedQuery = query.trim().toLowerCase();
  return keys.flatMap((key) => {
    const original = byKey.get(key);
    if (!original) return [];
    const definition = localizeSettingDefinition(original, language);
    if (!normalizedQuery) return [definition];
    return [definition.key, definition.label, definition.description]
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery)
      ? [definition]
      : [];
  });
}

export const GuiSettingsSection: React.FC<RuntimeProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  query = '',
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const errorMessage = useSettingsStore((state) => state.errorMessage);
  const storePath = useSettingsStore((state) => state.storePath);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const appearance = useMemo(
    () => definitionsFor(APPEARANCE_KEYS, guiDefinitions(), language, query),
    [language, query],
  );
  const preferences = useMemo(
    () => definitionsFor(INTERFACE_KEYS, guiDefinitions(), language, query),
    [language, query],
  );
  const onChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.gui.title')}</h2>
      <GuiAppearanceSettings definitions={appearance} language={language} />
      {preferences.length > 0 && (
        <div className="settings-card">
          <h3 className="settings-card__title">{t(language, 'settings.gui.preferences')}</h3>
          <div className="settings-card__body">
            {preferences.map((definition) => (
              <SettingsField
                key={definition.key}
                definition={definition}
                value={effectiveSettings[definition.key]}
                source={sources[definition.key] ?? 'default'}
                language={language}
                disabled={loading}
                onChange={onChange}
                onReset={(key) => void resetUserSetting(key)}
              />
            ))}
          </div>
        </div>
      )}
      {!query.trim() && (
        <div className="settings-card settings-runtime-card">
          <h3 className="settings-card__title">{t(language, 'settings.runtime.title')}</h3>
          <table className="settings-kv">
            <tbody>
              <tr><td>{t(language, 'settings.runtime.product')}</td><td>DeepCode</td></tr>
              <tr><td>{t(language, 'settings.runtime.serverVersion')}</td><td>{serverVersion ?? '-'}</td></tr>
              <tr><td>{t(language, 'settings.runtime.apiStatus')}</td><td>{apiStatus}</td></tr>
              <tr><td>{t(language, 'settings.runtime.wsStatus')}</td><td>{wsStatus}</td></tr>
              <tr>
                <td>{t(language, 'settings.runtime.userSettingsFile')}</td>
                <td>{storePath
                  ? t(language, 'settings.runtime.loaded')
                  : t(language, 'settings.runtime.notLoaded')}</td>
              </tr>
            </tbody>
          </table>
          {errorMessage && <div className="settings-error">{errorMessage}</div>}
        </div>
      )}
    </div>
  );
};

interface AgentSettingsSectionProps {
  query?: string;
}

export const AgentSettingsSection: React.FC<AgentSettingsSectionProps> = ({ query = '' }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const restartRequired = useSettingsStore((state) => state.restartRequired);
  const errorMessage = useSettingsStore((state) => state.errorMessage);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const available = useMemo(() => agentSettingDefinitions(), []);
  const instructions = useMemo(
    () => definitionsFor(AGENT_INSTRUCTION_KEYS, available, language, query),
    [available, language, query],
  );
  const permissions = useMemo(
    () => definitionsFor(AGENT_PERMISSION_KEYS, available, language, query),
    [available, language, query],
  );
  const web = useMemo(
    () => definitionsFor(AGENT_WEB_KEYS, available, language, query),
    [available, language, query],
  );
  const onChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };
  const renderCard = (title: string, definitions: readonly SettingDefinition[]) => {
    if (definitions.length === 0) return null;
    return (
      <div className="settings-card">
        <h3 className="settings-card__title">{title}</h3>
        <div className="settings-card__body">
          {definitions.map((definition) => (
            <SettingsField
              key={definition.key}
              definition={definition}
              value={effectiveSettings[definition.key]}
              source={sources[definition.key] ?? 'default'}
              language={language}
              disabled={loading}
              onChange={onChange}
              onReset={(key) => void resetUserSetting(key)}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.agent.title')}</h2>
      <div className="settings-boundary-notice">
        {t(language, 'settings.agent.scopeHint')}
      </div>
      {restartRequired && (
        <div className="settings-restart-notice">
          {t(language, 'settings.agent.restartRequired')}
        </div>
      )}
      {renderCard(t(language, 'settings.agent.instructions'), instructions)}
      {renderCard(t(language, 'settings.agent.permissions'), permissions)}
      {renderCard(t(language, 'settings.agent.webTools'), web)}
      {errorMessage && <div className="settings-error">{errorMessage}</div>}
      {instructions.length + permissions.length + web.length === 0 && (
        <div className="settings-card">
          <div className="settings-card__body">{t(language, 'settings.noSearchMatch')}</div>
        </div>
      )}
    </div>
  );
};
