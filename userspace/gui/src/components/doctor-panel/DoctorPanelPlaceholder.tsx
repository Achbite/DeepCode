/**
 * Doctor 面板占位组件
 * 阶段 2 接入 Runtime Doctor
 */
import React from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';

const DoctorPanelPlaceholder: React.FC = () => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  return (
    <div className="placeholder-content">
      DoctorPanelPlaceholder
      <div className="stage-hint">{t(language, 'placeholder.doctor')}</div>
    </div>
  );
};

export default DoctorPanelPlaceholder;
