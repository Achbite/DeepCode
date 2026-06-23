/**
 * 审批中心占位组件
 * 阶段 8 接入补丁审批中心
 */
import React from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';

const ApprovalCenterPlaceholder: React.FC = () => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  return (
    <div className="placeholder-content">
      ApprovalCenterPlaceholder
      <div className="stage-hint">{t(language, 'placeholder.approval')}</div>
    </div>
  );
};

export default ApprovalCenterPlaceholder;
