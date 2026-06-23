import type React from 'react';
import { normalizeUiLanguage, t } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';

const EmptyEditorSurface: React.FC = () => {
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  return (
    <div className="workbench-empty-editor">
      <div className="workbench-empty-editor__inner">
        <div className="workbench-empty-editor__icon" aria-hidden="true">
          FILE
        </div>
        <div>{t(language, 'editor.empty.title')}</div>
        <div className="workbench-empty-editor__hint">{t(language, 'editor.empty.hint')}</div>
      </div>
    </div>
  );
};

export default EmptyEditorSurface;
