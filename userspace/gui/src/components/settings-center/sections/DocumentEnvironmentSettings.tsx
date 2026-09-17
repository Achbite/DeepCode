import React from 'react';
import type { UiLanguage } from '../../../i18n';
import { agentSettingDefinitions, useSettingsStore } from '../../../state/settingsStore';
import { localizeSettingDefinition } from '../../../settingsLocalization';
import SettingsField from '../SettingsField';
import { matchesSettingsQuery } from '../settingsSearch';

export default function DocumentEnvironmentSettings({ language, query = '' }: { language: UiLanguage; query?: string }) {
  const key = 'agent.documents.pythonPath';
  const value = useSettingsStore((state) => state.effectiveSettings[key]);
  const source = useSettingsStore((state) => state.sources[key] ?? 'default');
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const reset = useSettingsStore((state) => state.resetUserSetting);
  const definition = localizeSettingDefinition(agentSettingDefinitions().find((entry) => entry.key === key)!, language);
  if (!matchesSettingsQuery(query, definition.label, definition.description ?? '', 'PDF Python WeasyPrint document environment 文档 环境')) return null;
  return <section className="settings-card">
    <h3 className="settings-card__title">{language === 'zh-CN' ? 'PDF 生成环境' : 'PDF generation environment'}</h3>
    <div className="settings-card__body">
      <SettingsField definition={definition} value={value} source={source} language={language}
        onChange={(setting, next) => patch(setting, typeof next === 'string' ? next.trim() : next)}
        onReset={reset} />
    </div>
  </section>;
}
