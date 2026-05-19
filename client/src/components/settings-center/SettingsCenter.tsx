/**
 * DeepCode Settings 中心
 *
 * 设计意图（参考 VSCode）：
 *   1. ⚙️ 按钮位于左下角 Activity Bar，点击后不展开侧边栏，
 *      而是在主编辑区"新建/聚焦"一个 Settings Tab，与文件 Tab 平级；
 *   2. 设置中心采用左侧导航 + 右侧详情的布局，把 Skill / Prompt /
 *      Doctor / Ruler 这类高级配置统一收纳，避免污染文件树；
 *   3. 每一个左侧菜单项对应一个独立 Section 组件，方便阶段 2-3 替换
 *      占位实现为真实表单。
 *
 * 当前阶段使用状态由组件内部 useState 维护即可；如果未来 Settings 之间
 * 需要跨标签页保留滚动位置或表单未保存状态，再迁移到 Zustand。
 */
import React, { useState } from 'react';
import './settingsCenter.css';
import CommonSettingsSection from './sections/CommonSettingsSection';
import SkillRuntimeSection from './sections/SkillRuntimeSection';
import PromptProfilesSection from './sections/PromptProfilesSection';
import RuntimeDoctorSection from './sections/RuntimeDoctorSection';
import RulerRulesSection from './sections/RulerRulesSection';

/** 内部菜单 ID */
type SettingsKey = 'common' | 'skill' | 'prompt' | 'doctor' | 'ruler';

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
  const [activeKey, setActiveKey] = useState<SettingsKey>('common');

  const renderBody = () => {
    switch (activeKey) {
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
      {/* ---- 左侧导航 ---- */}
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

      {/* ---- 右侧内容 ---- */}
      <section className="settings-body">{renderBody()}</section>
    </div>
  );
};

export default SettingsCenter;
