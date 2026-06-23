/**
 * Skill 面板占位组件
 * 阶段 3 接入 Python Skill Runtime
 */
import React from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';

const SkillPanelPlaceholder: React.FC = () => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  return (
    <div className="placeholder-content">
      SkillPanelPlaceholder
      <div className="stage-hint">{t(language, 'placeholder.skill')}</div>
    </div>
  );
};

export default SkillPanelPlaceholder;
