import React, { useState } from 'react';
import './settingsCenter.css';
import WorkspaceSection from './sections/WorkspaceSection';
import CommonSettingsSection from './sections/CommonSettingsSection';
import SkillRuntimeSection from './sections/SkillRuntimeSection';
import PromptProfilesSection from './sections/PromptProfilesSection';
import RuntimeDoctorSection from './sections/RuntimeDoctorSection';
import RulerRulesSection from './sections/RulerRulesSection';
import LlmSection from './sections/LlmSection';

type SettingsKey =
  | 'workspace'
  | 'common'
  | 'llm'
  | 'skill'
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

const NAV_ITEMS: NavItem[] = [
  { key: 'workspace', icon: 'WS', label: 'Workspace' },
  { key: 'common', icon: 'CM', label: 'Common Settings' },
  { key: 'llm', icon: 'AI', label: 'LLM Providers' },
  { key: 'skill', icon: 'SK', label: 'Skill Runtime' },
  { key: 'prompt', icon: 'PR', label: 'Prompt Profiles' },
  { key: 'doctor', icon: 'DR', label: 'Runtime Doctor' },
  { key: 'ruler', icon: 'RL', label: 'Ruler Rules' },
];

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
}) => {
  const [activeKey, setActiveKey] = useState<SettingsKey>('workspace');
  const [searchQuery, setSearchQuery] = useState('');

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
        <div className="settings-nav__title">DeepCode Settings</div>
        <label className="settings-search" aria-label="Search settings">
          <span>Search</span>
          <input
            value={searchQuery}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              if (event.target.value.trim()) setActiveKey('common');
            }}
            placeholder="Search settings"
          />
        </label>
        {NAV_ITEMS.map((item) => (
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
