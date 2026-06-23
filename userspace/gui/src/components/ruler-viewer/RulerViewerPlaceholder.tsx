/**
 * Ruler 查看器占位组件
 * 阶段 2 接入 Ruler 生效清单
 */
import React from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';

const RulerViewerPlaceholder: React.FC = () => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  return (
    <div className="placeholder-content">
      RulerViewerPlaceholder
      <div className="stage-hint">{t(language, 'placeholder.ruler')}</div>
    </div>
  );
};

export default RulerViewerPlaceholder;
