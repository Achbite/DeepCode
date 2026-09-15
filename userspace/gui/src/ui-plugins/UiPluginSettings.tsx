import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../state/settingsStore';
import ProjectFolderDialog from '../components/workspace-open-dialog/ProjectFolderDialog';
import type { UiLanguage } from '../i18n';
import { UiPluginShowcase } from './UiPluginShowcase';
import { useUiPlugins } from './UiPlugins';
import { decodePluginSources } from './source';
import { errorText } from './runtime';
import type { UiPluginSource } from './types';

export default function UiPluginSettings({ language, query = '' }: { language: UiLanguage; query?: string }) {
  const chinese = language === 'zh-CN';
  const encoded = String(useSettingsStore((state) => state.effectiveSettings['workbench.uiPlugins']) ?? '[]');
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const { entries, connectionError, refresh } = useUiPlugins();
  const [sources, setSources] = useState<UiPluginSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [path, setPath] = useState('');
  useEffect(() => { try { setSources(decodePluginSources(encoded)); setError(null); } catch (reason) { setError(errorText(reason)); } }, [encoded]);
  const save = async (next: UiPluginSource[]) => {
    setSaving(true); setError(null);
    try {
      const result = await patch('workbench.uiPlugins', JSON.stringify(next));
      if (result) setSources(next);
      else setError(useSettingsStore.getState().errorMessage ?? 'UI plugin settings were not saved.');
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  const add = (nextPath: string) => {
    setChoosing(false);
    if (!sources.some((source) => source.path === nextPath)) void save([...sources, { path: nextPath, enabled: true }]);
  };
  const statusLabels = chinese ? { active: '已加载 · 自动更新', loading: '正在加载…', disabled: '已停用', error: '加载失败' }
    : { active: 'Loaded · Live updates', loading: 'Loading…', disabled: 'Disabled', error: 'Load failed' };
  return <section className="settings-group">
    <h3 className="settings-card__title">{chinese ? '界面插件' : 'UI plugins'}
      <button type="button" className="settings-button" onClick={()=>refresh?.()} disabled={!sources.length}>{chinese ? '刷新插件' : 'Refresh plugins'}</button>
    </h3>
    <div className="settings-card settings-card__body settings-skill-sources">
      {sources.length === 0 && <p className="settings-plugin-empty">{chinese ? '尚未添加界面插件。' : 'No UI plugins added.'}</p>}
      {sources.filter((source) => `${source.path} ${entries.find((entry)=>entry.path===source.path)?.manifest?.name??''}`.toLowerCase().includes(query.toLowerCase())).map((source) => {
        const entry = entries.find((item) => item.path === source.path);
        return <div className="settings-plugin-item" key={source.path}>
          <div className="settings-plugin-source">
            <input type="checkbox" checked={source.enabled} disabled={saving} aria-label={`${chinese ? '启用界面插件' : 'Enable UI plugin'} ${entry?.manifest?.name ?? source.path}`}
              onChange={(event) => void save(sources.map((item) => item.path === source.path ? { ...item, enabled: event.target.checked } : item))} />
            <div className="settings-plugin-source__path"><strong>{entry?.manifest?.name ?? source.path.split(/[\\/]/).at(-1)}</strong><span title={source.path}>{source.path}</span>
              <span className="settings-ui-plugin__status">{!source.enabled ? statusLabels.disabled : entry ? statusLabels[entry.status] : (chinese ? '等待加载' : 'Waiting to load')}</span></div>
            <button type="button" className="settings-button settings-button--quiet" disabled={saving} onClick={() => void save(sources.filter((item) => item.path !== source.path))}>{chinese ? '移除' : 'Remove'}</button>
          </div>
          {entry?.error && <p role="alert" className="settings-error">{entry.error}</p>}
        </div>;
      })}
      <div className="settings-actions"><button type="button" className="settings-button" disabled={saving} onClick={() => setChoosing(true)}>{chinese ? '添加界面插件…' : 'Add UI plugin…'}</button></div>
      <details className="settings-plugin-manual"><summary>{chinese ? '手动输入路径' : 'Enter a path manually'}</summary>
        <form className="settings-plugin-manual__form" onSubmit={(event) => { event.preventDefault(); if (path.trim() && !saving) { add(path.trim()); setPath(''); } }}>
          <input className="settings-field__input" aria-label={chinese ? '界面插件文件夹路径' : 'UI plugin folder path'} value={path} onChange={(event) => setPath(event.target.value)} />
          <button className="settings-button" type="submit" disabled={saving || !path.trim()}>{chinese ? '添加' : 'Add'}</button>
        </form></details>
      {(error || connectionError) && <p role="alert" className="settings-error">{error ?? connectionError}</p>}
    </div>
    {!query && <UiPluginShowcase language={language}/>}
    {choosing && <ProjectFolderDialog language={language} title={chinese ? '选择界面插件文件夹' : 'Choose UI plugin folder'} onCancel={() => setChoosing(false)} onSelect={add} />}
  </section>;
}
