/**
 * Prompt Profiles 板块（Settings 中心）
 *
 * 管理不同场景下的大模型系统提示词模板。
 * 阶段 2 接入：可以新建 / 编辑 / 删除 / 切换 Prompt Profile。
 */
import React from 'react';
import PromptSettingsPlaceholder from '../../prompt-settings/PromptSettingsPlaceholder';

const PromptProfilesSection: React.FC = () => (
  <div>
    <h2 className="settings-title">Prompt Profiles</h2>

    <div className="settings-card">
      <h3 className="settings-card__title">提示词模板</h3>
      <p className="settings-card__body">
        管理不同场景下的大模型系统提示词模板；阶段 2 接入后可在此新建、编辑、切换 Profile。
      </p>
      <div className="settings-card__inline-placeholder">
        <PromptSettingsPlaceholder />
      </div>
    </div>
  </div>
);

export default PromptProfilesSection;
