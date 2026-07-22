import React, { useState } from 'react';
import type { AgentTimelineTokenUsageProjection } from '@deepcode/protocol';
import type { SettingsSurface } from '@deepcode/protocol';
import './settingsCenter.css';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import WorkspaceSection from './sections/WorkspaceSection';
import CommonSettingsSection from './sections/CommonSettingsSection';
import TokenStatsSection from './sections/TokenStatsSection';
import SkillRuntimeSection from './sections/SkillRuntimeSection';
import SessionBoundarySection from './sections/SessionBoundarySection';
import RuntimeDoctorSection from './sections/RuntimeDoctorSection';
import RulerRulesSection from './sections/RulerRulesSection';
import LlmSection from './sections/LlmSection';
import McpServicesSection from './sections/McpServicesSection';
import {
  AgentSettingsSection,
  GuiSettingsSection,
  PermissionSettingsSection,
  UnavailableIntegrationSection,
} from './sections/CategorizedSettingsSections';

type SettingsKey =
  | 'workspace'
  | 'common'
  | 'gui'
  | 'agent'
  | 'permissions'
  | 'token'
  | 'llm'
  | 'github'
  | 'skill'
  | 'mcp'
  | 'sessionBoundary'
  | 'doctor'
  | 'ruler';

interface SettingsCenterProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
  tokenUsageProjection?: AgentTimelineTokenUsageProjection | null;
  surface?: Extract<SettingsSurface, 'editor' | 'gui'>;
}

interface NavItem {
  key: SettingsKey;
  icon: string;
  label: string;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
  tokenUsageProjection,
  surface = 'editor',
}) => {
  const [activeKey, setActiveKey] = useState<SettingsKey>(surface === 'gui' ? 'gui' : 'workspace');
  const [searchQuery, setSearchQuery] = useState('');
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const navGroups = surface === 'gui' ? guiNavGroups(language) : editorNavGroups(language);

  const renderBody = () => {
    switch (activeKey) {
      case 'workspace':
        return <WorkspaceSection />;
      case 'common':
        return (
          <CommonSettingsSection
            apiStatus={apiStatus}
            wsStatus={wsStatus}
            serverVersion={serverVersion}
            query={searchQuery}
            surface={surface}
          />
        );
      case 'gui':
        return (
          <GuiSettingsSection
            apiStatus={apiStatus}
            wsStatus={wsStatus}
            serverVersion={serverVersion}
            query={searchQuery}
          />
        );
      case 'agent':
        return <AgentSettingsSection query={searchQuery} />;
      case 'permissions':
        return <PermissionSettingsSection query={searchQuery} />;
      case 'token':
        return <TokenStatsSection tokenUsageProjection={tokenUsageProjection} />;
      case 'llm':
        return <LlmSection />;
      case 'skill':
        return surface === 'gui'
          ? <UnavailableIntegrationSection integration="skill" />
          : <SkillRuntimeSection />;
      case 'mcp':
        return surface === 'gui'
          ? <UnavailableIntegrationSection integration="mcp" />
          : <McpServicesSection />;
      case 'github':
        return <UnavailableIntegrationSection integration="github" />;
      case 'sessionBoundary':
        return <SessionBoundarySection />;
      case 'doctor':
        return <RuntimeDoctorSection />;
      case 'ruler':
        return <RulerRulesSection />;
      default:
        return null;
    }
  };

  return (
    <div className="settings-center">
      <nav className="settings-nav">
        <div className="settings-nav__title">
          {t(language, 'settings.title')}
        </div>
        <label className="settings-search" aria-label={t(language, 'settings.search.placeholder')}>
          <span>{t(language, 'settings.search.label')}</span>
          <input
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              if (event.target.value.trim()) setActiveKey(surface === 'gui' ? 'gui' : 'common');
            }}
            placeholder={t(language, 'settings.search.placeholder')}
          />
        </label>
        {navGroups.map((group, index) => (
          <div className="settings-nav-group" key={group.label ?? `group-${index}`}>
            {group.label && <div className="settings-nav-group__label">{group.label}</div>}
            {group.items.map((item) => (
              <button
                key={item.key}
                className={`settings-nav-item ${
                  activeKey === item.key ? 'settings-nav-item--active' : ''
                }`}
                onClick={() => setActiveKey(item.key)}
                type="button"
              >
                <span className="settings-nav-item__icon">{item.icon}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="settings-body">{renderBody()}</section>
    </div>
  );
};

function editorNavGroups(language: ReturnType<typeof normalizeUiLanguage>): NavGroup[] {
  return [{ items: [
    { key: 'workspace', icon: 'WS', label: t(language, 'settings.nav.workspace') },
    { key: 'common', icon: 'CM', label: t(language, 'settings.nav.common') },
    { key: 'token', icon: 'TK', label: t(language, 'settings.nav.token') },
    { key: 'llm', icon: 'AI', label: t(language, 'settings.nav.llm') },
    { key: 'skill', icon: 'SK', label: t(language, 'settings.nav.skill') },
    { key: 'mcp', icon: 'MC', label: t(language, 'settings.nav.mcp') },
    { key: 'sessionBoundary', icon: 'SB', label: t(language, 'settings.nav.sessionBoundary') },
    { key: 'doctor', icon: 'DR', label: t(language, 'settings.nav.doctor') },
    { key: 'ruler', icon: 'RL', label: t(language, 'settings.nav.ruler') },
  ] }];
}

function guiNavGroups(language: ReturnType<typeof normalizeUiLanguage>): NavGroup[] {
  return [
    {
      label: t(language, 'settings.navGroup.personal'),
      items: [
        { key: 'gui', icon: 'GU', label: t(language, 'settings.nav.gui') },
        { key: 'agent', icon: 'AG', label: t(language, 'settings.nav.agent') },
        { key: 'permissions', icon: 'PM', label: t(language, 'settings.nav.permissions') },
        { key: 'token', icon: 'TK', label: t(language, 'settings.nav.token') },
      ],
    },
    {
      label: t(language, 'settings.navGroup.models'),
      items: [
        { key: 'llm', icon: 'AI', label: t(language, 'settings.nav.llm') },
        { key: 'github', icon: 'GH', label: t(language, 'settings.nav.github') },
        { key: 'skill', icon: 'SK', label: t(language, 'settings.nav.skill') },
        { key: 'mcp', icon: 'MC', label: t(language, 'settings.nav.mcp') },
      ],
    },
    {
      label: t(language, 'settings.navGroup.system'),
      items: [
        { key: 'sessionBoundary', icon: 'SB', label: t(language, 'settings.nav.sessionBoundary') },
        { key: 'doctor', icon: 'DR', label: t(language, 'settings.nav.doctor') },
        { key: 'ruler', icon: 'RL', label: t(language, 'settings.nav.ruler') },
      ],
    },
  ];
}

export default SettingsCenter;
