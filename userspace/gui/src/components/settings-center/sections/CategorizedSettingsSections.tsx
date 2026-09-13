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
import ProjectEnvironmentSettings from './ProjectEnvironmentSettings';
import WorkspaceSandboxSettings from './WorkspaceSandboxSettings';

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
  'gui.showReasoning',
] as const;
const AGENT_INSTRUCTION_KEYS = ['agent.systemPrompt'] as const;
const AGENT_RESPONSE_KEYS = ['agent.responseLanguage'] as const;
const AGENT_SHELL_KEYS = ['agent.windows.shell', 'agent.windows.gitBashPath'] as const;
const AGENT_PERMISSION_KEYS = [
  'agent.permissions.workspaceMutation',
  'agent.permissions.engineeringDecisions',
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
                compact
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
  category?: 'agent' | 'environment' | 'permissions' | 'services';
}

export const AgentSettingsSection: React.FC<AgentSettingsSectionProps> = ({ query = '', category = 'agent' }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const sources = useSettingsStore((state) => state.sources);
  const loading = useSettingsStore((state) => state.loading);
  const pendingNextRunActivation = useSettingsStore(
    (state) => state.pendingNextRunActivation,
  );
  const errorMessage = useSettingsStore((state) => state.errorMessage);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const resetUserSetting = useSettingsStore((state) => state.resetUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const available = useMemo(() => agentSettingDefinitions(), []);
  const environment = useSettingsStore((state) => state.environment);
  const shellSettings = useMemo(() => definitionsFor(AGENT_SHELL_KEYS, available, language, query), [available, language, query]);
  const shell = environment?.shell as { executable?: string; dialect?: string } | undefined;
  const commands = Array.isArray(environment?.developerCommands) ? environment.developerCommands.filter((item): item is string => typeof item === 'string') : [];
  const chinese = language === 'zh-CN';
  const response = useMemo(
    () => definitionsFor(AGENT_RESPONSE_KEYS, available, language, query),
    [available, language, query],
  );
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
  const groups = category === 'agent' ? [response, instructions]
    : category === 'environment' ? [shellSettings]
      : category === 'permissions' ? [permissions] : [web];
  const onChange = (key: string, value: UserSettingValue) => {
    void patchUserSetting(key, value);
  };
  const renderCard = (title: string | null, definitions: readonly SettingDefinition[]) => {
    if (definitions.length === 0) return null;
    return (
      <section className="settings-group">
        {title && <h3 className="settings-card__title">{title}</h3>}
        <div className="settings-card settings-card__body">
          {definitions.map((definition) => (
            <SettingsField
              key={definition.key}
              definition={definition}
              value={effectiveSettings[definition.key]}
              source={sources[definition.key] ?? 'default'}
              language={language}
              disabled={loading}
              compact
              onChange={onChange}
              onReset={(key) => void resetUserSetting(key)}
            />
          ))}
        </div>
      </section>
    );
  };

  return (
    <div>
      <h2 className="settings-title">{t(language, category === 'services' ? 'settings.agent.webTools' : `settings.nav.${category}`)}</h2>
      {pendingNextRunActivation && (
        <div className="settings-activation-notice">
          {t(language, 'settings.agent.nextRunActivationPending')}
        </div>
      )}
      {category === 'agent' && renderCard(null, response)}
      {category === 'environment' && renderCard('Windows Shell', shellSettings)}
      {category === 'environment' && !query && <ProjectEnvironmentSettings chinese={chinese} />}
      {category === 'environment' && !query && <WorkspaceSandboxSettings chinese={chinese} />}
      {category === 'environment' && !query && <div className="settings-card">
        <h3 className="settings-card__title">{chinese ? '环境上下文' : 'Environment context'}</h3>
        <div className="settings-card__body">
          <div className="settings-field settings-field--compact">
            <div className="settings-field__main">
              <div className="settings-field__label">{chinese ? '稳定的执行环境' : 'Stable execution environment'}</div>
              <p className="settings-field__description">{chinese ? '会话复用已保存的环境。修改设置或刷新后，后续运行重新检测；当前任务保持原环境。' : 'Sessions reuse saved observations. Settings changes or refresh apply to subsequent runs; active work keeps its environment.'}</p>
            </div>
            <button className="settings-button" disabled={loading} onClick={() => void patchUserSetting('agent.environmentRevision', Number(effectiveSettings['agent.environmentRevision'] ?? 0) + 1)}>{chinese ? '刷新环境' : 'Refresh environment'}</button>
          </div>
          {environment && <div className="settings-field__description">
            <p>{chinese ? '本机检测' : 'Local observation'}: {String(environment.os)} · {String(environment.arch)} · {shell?.dialect ?? '—'}</p>
            <p style={{ overflowWrap: 'anywhere' }}>{shell?.executable || (chinese ? '未找到所选 Shell' : 'Selected shell not found')}</p>
            <p>{chinese ? '可用开发命令' : 'Developer commands'}: {commands.join(' · ') || '—'}</p>
          </div>}
        </div>
      </div>}

      {category === 'agent' && renderCard(t(language, 'settings.agent.instructions'), instructions)}
      {category === 'permissions' && renderCard(null, permissions)}
      {category === 'services' && renderCard(null, web)}
      {errorMessage && <div className="settings-error">{errorMessage}</div>}
      {groups.every((group) => group.length === 0) && (
        <div className="settings-card">
          <div className="settings-card__body">{t(language, 'settings.noSearchMatch')}</div>
        </div>
      )}
    </div>
  );
};
