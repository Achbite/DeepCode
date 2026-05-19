/**
 * Skill Runtime 板块（Settings 中心）
 *
 * 设计意图：将 Python Skill Runtime 这类"高级配置"从左侧 Activity Bar 迁出，
 * 统一放入 Settings 中心，遵循 VSCode 把 Skill / Extensions / Profiles 收纳
 * 在 Settings UI 内的交互范式。
 *
 * 阶段 1 只用占位组件展示 Skill 列表与运行状态，阶段 3 接入真实 Skill 注册表。
 */
import React from 'react';
import SkillPanelPlaceholder from '../../skill-panel/SkillPanelPlaceholder';

const SkillRuntimeSection: React.FC = () => (
  <div>
    <h2 className="settings-title">Skill Runtime</h2>

    <div className="settings-card">
      <h3 className="settings-card__title">Python Skills 挂载</h3>
      <p className="settings-card__body">
        配置当前 Agent 可用的外部工具与 Python 技能挂载路径；阶段 3 接入后可在此搜索、启停 Skill。
      </p>
      <div className="settings-card__inline-placeholder">
        <SkillPanelPlaceholder />
      </div>
    </div>
  </div>
);

export default SkillRuntimeSection;
