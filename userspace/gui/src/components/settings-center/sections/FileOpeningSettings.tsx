import React from 'react';
import type { UiLanguage } from '../../../i18n';
import { useSettingsStore } from '../../../state/settingsStore';

export default function FileOpeningSettings({ language, query = '' }: { language: UiLanguage; query?: string }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const chinese = language === 'zh-CN';
  if (query && !'文件 打开 阅读 reader vscode file open'.includes(query.trim().toLowerCase())) return null;
  return <section className="settings-card"><h3 className="settings-card__title">{chinese ? '文件与阅读' : 'Files and reading'}</h3><div className="settings-card__body">
    <label className="settings-field settings-field--compact"><span>{chinese ? '文本文件默认打开方式' : 'Open text files with'}</span>
      <select className="settings-field__select" value={String(settings['gui.defaultFileOpen'] ?? 'reader')} onChange={(event) => void patch('gui.defaultFileOpen', event.target.value)}>
        <option value="reader">DeepCode Reader</option><option value="vscode">Visual Studio Code</option>
      </select></label>
  </div></section>;
}
