import React, { useMemo } from 'react';
import type { UserSettingValue } from '@deepcode/protocol';
import { normalizeUiLanguage, t, type UiLanguage } from '../../../i18n';
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

interface QueryProps {
  query?: string;
}

interface PlaceholderProps {
  integration: 'github' | 'skill' | 'mcp';
}

const GUI_APPEARANCE_SETTING_KEYS = [
  'gui.colorTheme',
  'gui.accentColor',
] as const;

const GUI_INTERFACE_SETTING_KEYS = [
  'workbench.language',
  'gui.timelineDensity',
  'gui.typewriterAnimation',
  'gui.collapseCompletedThinking',
] as const;

const AGENT_SETTING_KEYS = [
  'agent.defaultMode',
  'agent.defaultWorkflow',
  'agent.requirementConfirmationMode',
  'agent.reviewContinuationMode',
  'agent.interventionLevel',
  'agent.memory.projectMode',
  'agent.git.commitMessageMode',
] as const;

const EDITABLE_PERMISSION_KEYS = [
  'agent.permissions.autonomyMode',
  'agent.permissions.webRead',
  'agent.permissions.privateWebRead',
] as const;

const PUBLIC_WEB_SETTING_KEYS = [
  'agent.web.search.endpointTemplate',
  'agent.web.search.authHeaderName',
  'agent.web.search.authSecretRef',
] as const;

const KERNEL_OWNED_PERMISSION_KEYS = [
  'agent.permissions.workspaceRead',
  'agent.permissions.workspaceWrite',
  'agent.permissions.processExec',
  'agent.permissions.gitWrite',
  'agent.permissions.browserControl',
  'agent.permissions.providerEgress',
  'agent.shell.autoExecuteCommands',
  'agent.shell.commandBlacklist',
] as const;

function allDefinitions(): SettingDefinition[] {
  const definitions = [
    ...shellPreferenceSettingDefinitions('editor').filter(
      (definition) => definition.key === 'workbench.language'
    ),
    ...shellPreferenceSettingDefinitions('gui'),
    ...agentSettingDefinitions(),
  ];
  return [...new Map(definitions.map((definition) => [definition.key, definition])).values()];
}

function definitionsForKeys(
  keys: readonly string[],
  language: UiLanguage,
  query: string
): SettingDefinition[] {
  const byKey = new Map(allDefinitions().map((definition) => [definition.key, definition]));
  const normalizedQuery = query.trim().toLowerCase();
  return keys.flatMap((key) => {
    const definition = byKey.get(key);
    if (!definition) return [];
    const localized = localizeSettingDefinition(definition, language);
    if (!normalizedQuery) return [localized];
    const searchable = [
      localized.key,
      localized.label,
      localized.description,
      definition.label,
      definition.description,
    ].join(' ').toLowerCase();
    return searchable.includes(normalizedQuery) ? [localized] : [];
  });
}

interface SettingsCardProps {
  title: string;
  definitions: SettingDefinition[];
  language: UiLanguage;
  emptyText: string;
  hint?: string;
  locked?: boolean;
}

const SettingsCard: React.FC<SettingsCardProps> = ({
  title,
  definitions,
  language,
  emptyText,
  hint,
  locked = false,
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);

  const handleChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };

  return (
    <div className={`settings-card${locked ? ' settings-card--locked' : ''}`}>
      <h3 className="settings-card__title">
        <span>{title}</span>
        {locked && (
          <span className="settings-card__lock-badge">
            {t(language, 'settings.permissions.kernelOwnedBadge')}
          </span>
        )}
      </h3>
      <div className="settings-card__body">
        {definitions.length === 0 ? (
          <div>{emptyText}</div>
        ) : (
          definitions.map((definition) => (
            <SettingsField
              key={definition.key}
              definition={definition}
              value={effectiveSettings[definition.key]}
              source={sources[definition.key] ?? 'default'}
              language={language}
              disabled={locked || loading || sources[definition.key] === 'workspace'}
              onChange={handleChange}
              onReset={locked ? undefined : (key) => void resetUserSetting(key)}
            />
          ))
        )}
      </div>
      {hint && <div className="settings-card__hint">{hint}</div>}
    </div>
  );
};

export const GuiSettingsSection: React.FC<RuntimeProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  query = '',
}) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const errorMessage = useSettingsStore((state) => state.errorMessage);
  const storePath = useSettingsStore((state) => state.storePath);
  const appearanceDefinitions = useMemo(
    () => definitionsForKeys(GUI_APPEARANCE_SETTING_KEYS, language, query),
    [language, query]
  );
  const interfaceDefinitions = useMemo(
    () => definitionsForKeys(GUI_INTERFACE_SETTING_KEYS, language, query),
    [language, query]
  );
  const hasSearchMatch = appearanceDefinitions.length > 0 || interfaceDefinitions.length > 0;

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.gui.title')}</h2>
      <GuiAppearanceSettings definitions={appearanceDefinitions} language={language} />
      {interfaceDefinitions.length > 0 && (
        <SettingsCard
          title={t(language, 'settings.gui.preferences')}
          definitions={interfaceDefinitions}
          language={language}
          emptyText={t(language, 'settings.noSearchMatch')}
        />
      )}
      {query.trim() && !hasSearchMatch && (
        <div className="settings-card">
          <div className="settings-card__body">{t(language, 'settings.noSearchMatch')}</div>
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
              <tr><td>{t(language, 'settings.runtime.userSettingsFile')}</td><td>{storePath ?? t(language, 'settings.runtime.notLoaded')}</td></tr>
            </tbody>
          </table>
          {errorMessage && <div className="settings-error">{errorMessage}</div>}
        </div>
      )}
    </div>
  );
};

export const AgentSettingsSection: React.FC<QueryProps> = ({ query = '' }) => {
  const language = normalizeUiLanguage(
    useSettingsStore((state) => state.effectiveSettings['workbench.language'])
  );
  const definitions = useMemo(
    () => definitionsForKeys(AGENT_SETTING_KEYS, language, query),
    [language, query]
  );
  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.agent.title')}</h2>
      <SettingsCard
        title={t(language, 'settings.agent.behavior')}
        definitions={definitions}
        language={language}
        emptyText={t(language, 'settings.noSearchMatch')}
        hint={t(language, 'settings.agent.scopeHint')}
      />
    </div>
  );
};

export const PermissionSettingsSection: React.FC<QueryProps> = ({ query = '' }) => {
  const language = normalizeUiLanguage(
    useSettingsStore((state) => state.effectiveSettings['workbench.language'])
  );
  const editable = useMemo(
    () => definitionsForKeys(EDITABLE_PERMISSION_KEYS, language, query),
    [language, query]
  );
  const publicWeb = useMemo(
    () => definitionsForKeys(PUBLIC_WEB_SETTING_KEYS, language, query),
    [language, query]
  );
  const kernelOwned = useMemo(
    () => definitionsForKeys(KERNEL_OWNED_PERMISSION_KEYS, language, query),
    [language, query]
  );
  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.permissions.title')}</h2>
      <div className="settings-boundary-notice">
        {t(language, 'settings.permissions.boundary')}
      </div>
      <SettingsCard
        title={t(language, 'settings.permissions.editable')}
        definitions={editable}
        language={language}
        emptyText={t(language, 'settings.noSearchMatch')}
        hint={t(language, 'settings.permissions.editableHint')}
      />
      <SettingsCard
        title={t(language, 'settings.permissions.publicWeb')}
        definitions={publicWeb}
        language={language}
        emptyText={t(language, 'settings.noSearchMatch')}
        hint={t(language, 'settings.permissions.publicWebHint')}
      />
      <SettingsCard
        title={t(language, 'settings.permissions.kernelOwned')}
        definitions={kernelOwned}
        language={language}
        emptyText={t(language, 'settings.noSearchMatch')}
        hint={t(language, 'settings.permissions.kernelOwnedHint')}
        locked
      />
    </div>
  );
};

export const UnavailableIntegrationSection: React.FC<PlaceholderProps> = ({ integration }) => {
  const language = normalizeUiLanguage(
    useSettingsStore((state) => state.effectiveSettings['workbench.language'])
  );
  return (
    <div>
      <h2 className="settings-title">
        {t(language, `settings.integration.${integration}.title`)}
      </h2>
      <div className="settings-card settings-placeholder-card">
        <div className="settings-placeholder-card__mark">{integration.toUpperCase()}</div>
        <div>
          <h3>{t(language, 'settings.integration.unavailable')}</h3>
          <p>{t(language, `settings.integration.${integration}.body`)}</p>
          <p>{t(language, 'settings.integration.boundary')}</p>
        </div>
      </div>
    </div>
  );
};
