/**
 * DeepCode Settings 中心
 *
 * 设计意图（参考 VSCode）：
 *   1. ⚙️ 按钮位于左下角 Activity Bar，点击在主编辑区"新建/聚焦"一个 Settings Tab；
 *   2. 设置中心采用左侧导航 + 右侧详情；
 *   3. Workspace / Common / Skill / Prompt / Doctor / Ruler 等高级配置统一收纳。
 */
import React, { useState } from 'react';
import './settingsCenter.css';
import WorkspaceSection from './sections/WorkspaceSection';
import CommonSettingsSection from './sections/CommonSettingsSection';
import SkillRuntimeSection from './sections/SkillRuntimeSection';
import PromptProfilesSection from './sections/PromptProfilesSection';
import RuntimeDoctorSection from './sections/RuntimeDoctorSection';
import RulerRulesSection from './sections/RulerRulesSection';

type SettingsKey =
  | 'workspace'
  | 'common'
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
  { key: 'workspace', icon: '🗂', label: 'Workspace' },
  { key: 'common', icon: '🛠', label: 'Common Settings' },
  { key: 'skill', icon: '🛠️', label: 'Skill Runtime' },
  { key: 'prompt', icon: '📝', label: 'Prompt Profiles' },
  { key: 'doctor', icon: '🩺', label: 'Runtime Doctor' },
  { key: 'ruler', icon: '📏', label: 'Ruler Rules' },
];

const SettingsCenter: React.FC<SettingsCenterProps> = ({
  apiStatus,
  wsStatus,
  serverVersion,
}) => {
  const [activeKey, setActiveKey] = useState<SettingsKey>('workspace');

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
          />
        );
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
        {NAV_ITEMS.map((item) => (
          <div
            key={item.key}
            className={`settings-nav-item ${
              activeKey === item.key ? 'settings-nav-item--active' : ''
            }`}
            onClick={() => setActiveKey(item.key)}
          >
            <span className="settings-nav-item__icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </nav>
      <section className="settings-body">{renderBody()}</section>
    </div>
  );
};

export default SettingsCenter;
