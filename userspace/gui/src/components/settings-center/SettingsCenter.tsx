import React, { useState } from 'react';
import './settingsCenter.css';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import WorkspaceSection from './sections/WorkspaceSection';
import CommonSettingsSection from './sections/CommonSettingsSection';
import SkillRuntimeSection from './sections/SkillRuntimeSection';
import PromptProfilesSection from './sections/PromptProfilesSection';
import RuntimeDoctorSection from './sections/RuntimeDoctorSection';
import RulerRulesSection from './sections/RulerRulesSection';
import LlmSection from './sections/LlmSection';
import McpServicesSection from './sections/McpServicesSection';

type SettingsKey =
  | 'workspace'
  | 'common'
  | 'llm'
  | 'skill'
  | 'mcp'
  | 'prompt'
  | 'doctor'
  | 'ruler';

interface SettingsCenterProps {
  apiStatus: string;
  wsStatus: string;
  serverVersion?: string;
}

interface NavItem {
  key: SettingsKey;
  icon: string;
  label: string;
}

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
}) => {
  const [activeKey, setActiveKey] = useState<SettingsKey>('workspace');
  const [searchQuery, setSearchQuery] = useState('');
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const navItems: NavItem[] = [
    { key: 'workspace', icon: 'WS', label: t(language, 'settings.nav.workspace') },
    { key: 'common', icon: 'CM', label: t(language, 'settings.nav.common') },
    { key: 'llm', icon: 'AI', label: t(language, 'settings.nav.llm') },
    { key: 'skill', icon: 'SK', label: t(language, 'settings.nav.skill') },
    { key: 'mcp', icon: 'MC', label: t(language, 'settings.nav.mcp') },
    { key: 'prompt', icon: 'PR', label: t(language, 'settings.nav.prompt') },
    { key: 'doctor', icon: 'DR', label: t(language, 'settings.nav.doctor') },
    { key: 'ruler', icon: 'RL', label: t(language, 'settings.nav.ruler') },
  ];

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
          />
        );
      case 'llm':
        return <LlmSection />;
      case 'skill':
        return <SkillRuntimeSection />;
      case 'mcp':
        return <McpServicesSection />;
      case 'prompt':
        return <PromptProfilesSection />;
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
              if (event.target.value.trim()) setActiveKey('common');
            }}
            placeholder={t(language, 'settings.search.placeholder')}
          />
        </label>
        {navItems.map((item) => (
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
      </nav>
      <section className="settings-body">{renderBody()}</section>
    </div>
  );
};

export default SettingsCenter;
