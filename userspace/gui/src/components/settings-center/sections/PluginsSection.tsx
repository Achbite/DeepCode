import React, { useEffect, useState } from 'react';
import type { SkillSettingsItem } from '@deepcode/protocol';
import { normalizeUiLanguage, t } from '../../../i18n';
import { getSkillSettings } from '../../../services/localAgentApi';
import { useSettingsStore } from '../../../state/settingsStore';
import ProjectFolderDialog from '../../workspace-open-dialog/ProjectFolderDialog';
import DeepCodeShellIcon from '../../shared/DeepCodeShellIcon';

interface SkillMount {
  id: string;
  path: string;
  enabled?: boolean;
  activationMediaTypes?: string[];
}

function decodeMounts(encoded: string): SkillMount[] {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === 'object'
    && typeof item.id === 'string' && typeof item.path === 'string'
    && (item.enabled === undefined || typeof item.enabled === 'boolean')
    && (item.activationMediaTypes === undefined || (Array.isArray(item.activationMediaTypes)
      && item.activationMediaTypes.every((type: unknown) => typeof type === 'string'))))) {
    throw new Error('skills.mounts must be a list of Skill sources.');
  }
  return value;
}

export default function PluginsSection({ query = '' }: { query?: string }) {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const storeError = useSettingsStore((state) => state.errorMessage);
  const pending = useSettingsStore((state) => state.pendingNextRunActivation);
  const language = normalizeUiLanguage(settings['workbench.language']);
  const chinese = language === 'zh-CN';
  const encoded = String(settings['skills.mounts'] ?? '[]');
  const [mounts, setMounts] = useState<SkillMount[]>([]);
  const [skills, setSkills] = useState<SkillSettingsItem[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<{ sourceId?: string } | null>(null);
  const [manualPath, setManualPath] = useState('');

  useEffect(() => {
    try {
      setMounts(decodeMounts(encoded));
      setConfigError(null);
      setDirty(false);
    } catch (error) {
      setConfigError(String(error));
    }
  }, [encoded]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSkills([]);
    setListError(null);
    void getSkillSettings(controller.signal).then((items) => {
      if (!controller.signal.aborted) setSkills(items);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setListError(String(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [encoded, revision]);

  const update = (next: SkillMount[]) => { setMounts(next); setDirty(true); };
  const addSource = (path: string) => {
    if (!mounts.some((mount) => mount.path === path)) {
      update([...mounts, { id: `skill-${crypto.randomUUID()}`, path, enabled: true }]);
    }
  };
  const selectSource = (path: string) => {
    if (selection?.sourceId) {
      update(mounts.map((mount) => mount.id === selection.sourceId ? { ...mount, path } : mount));
    } else addSource(path);
    setSelection(null);
  };
  const save = async () => {
    setSaving(true);
    try {
      const result = await patchUserSetting('skills.mounts', JSON.stringify(mounts));
      if (result) { setDirty(false); setRevision((value) => value + 1); }
    } finally { setSaving(false); }
  };
  const shown = skills.filter((skill) => `${skill.displayName} ${skill.description} ${skill.source}`
    .toLowerCase().includes(query.trim().toLowerCase()));

  return <div>
    <h2 className="settings-title">{t(language, 'settings.nav.plugins')}</h2>
    <p className="settings-section-description">{chinese
      ? '管理 Agent 使用的文本 Skill。MCP 服务与其他插件也将在此集中管理。'
      : 'Manage text Skills for your Agent. MCP services and other plugins will also be managed here.'}</p>
    {pending && <p className="settings-activation-notice">{t(language, 'settings.agent.nextRunActivationPending')}</p>}
    <section className="settings-group">
      <h3 className="settings-card__title">{chinese ? 'Skill 来源' : 'Skill sources'}</h3>
      <div className="settings-card settings-card__body settings-skill-sources">
        <p className="settings-plugin-description">{chinese
          ? '选择包含 SKILL.md 的文件夹，或添加单个 SKILL.md 文件。'
          : 'Choose a folder containing Skills, or add an individual SKILL.md file.'}</p>
        {configError && <p role="alert" className="settings-error">{configError}</p>}
        {!configError && mounts.length === 0 && <p className="settings-plugin-empty">{chinese
          ? '尚未添加自定义来源。内置 Skill 已列在下方。'
          : 'No custom sources yet. Built-in Skills are listed below.'}</p>}
        {!configError && mounts.map((mount, index) => <div className="settings-plugin-source" key={mount.id}>
          <input type="checkbox" checked={mount.enabled !== false} disabled={saving}
            aria-label={`${chinese ? '启用' : 'Enable'} ${mount.path || mount.id}`}
            onChange={(event) => update(mounts.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item))} />
          <div className="settings-plugin-source__path">
            <strong>{mount.path.replace(/[\\/]+$/u, '').split(/[\\/]/u).at(-1) || (chinese ? '未选择来源' : 'No source selected')}</strong>
            <span title={mount.path} dir="auto">{mount.path || (chinese ? '选择文件夹或 SKILL.md 文件' : 'Choose a folder or SKILL.md file')}</span>
          </div>
          <div className="settings-plugin-source__actions">
            <button type="button" className="settings-button" disabled={saving} onClick={() => setSelection({
              sourceId: mount.id,
            })}>{chinese ? '更改…' : 'Change…'}</button>
            <button type="button" className="settings-button settings-button--quiet" disabled={saving}
              aria-label={`${chinese ? '移除来源' : 'Remove source'} ${mount.path || index + 1}`}
              onClick={() => update(mounts.filter((_, i) => i !== index))}>{chinese ? '移除' : 'Remove'}</button>
          </div>
        </div>)}
        <div className="settings-actions settings-plugin-actions">
          <button type="button" className="settings-button" disabled={saving || !!configError} onClick={() => setSelection({})}>
            <DeepCodeShellIcon name="plus" />{chinese ? '添加来源…' : 'Add source…'}</button>
          <button type="button" className="settings-button settings-button--primary settings-plugin-save" disabled={saving || !!configError || !dirty || mounts.some((mount) => !mount.path.trim())} onClick={() => void save()}>{saving ? (chinese ? '正在保存…' : 'Saving…') : (chinese ? '保存更改' : 'Save changes')}</button>
        </div>
        <details className="settings-plugin-manual">
          <summary>{chinese ? '手动输入路径' : 'Enter a path manually'}</summary>
          <form className="settings-plugin-manual__form" onSubmit={(event) => {
            event.preventDefault();
            if (!manualPath.trim() || saving || configError) return;
            addSource(manualPath.trim()); setManualPath('');
          }}>
            <input className="settings-field__input" value={manualPath} disabled={saving || !!configError}
              aria-label={chinese ? 'Skill 文件或目录的完整路径' : 'Full path to a Skill file or folder'}
              placeholder={chinese ? 'Skill 文件或目录的完整路径' : 'Full path to a Skill file or folder'}
              onChange={(event) => setManualPath(event.target.value)} />
            <button type="submit" className="settings-button" disabled={saving || !!configError || !manualPath.trim()}>{chinese ? '添加' : 'Add'}</button>
          </form>
        </details>
        {storeError && <p role="alert" className="settings-error">{storeError}</p>}
      </div>
    </section>
    <section className="settings-group">
      <h3 className="settings-card__title"><span>{chinese ? '可用 Skill' : 'Available Skills'}{!loading && !listError ? ` · ${shown.length}` : ''}</span>
        <button className="settings-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>{chinese ? '刷新列表' : 'Refresh list'}</button></h3>
      <div className="settings-card settings-card__body" aria-busy={loading}>
        {loading && <p>{chinese ? '正在读取 Skill…' : 'Loading Skills…'}</p>}
        {listError && <p role="alert" className="settings-error">{listError}</p>}
        {!loading && !listError && shown.length === 0 && <p>{query ? t(language, 'settings.noSearchMatch') : (chinese ? '暂无可用 Skill。' : 'No Skills available.')}</p>}
        {shown.map((skill) => <div className="settings-plugin-item" key={skill.id}>
          <div className="settings-plugin-item__heading"><strong>{skill.displayName}</strong><span>{skill.source === 'builtin' ? (chinese ? '内置' : 'Built in') : (chinese ? '已加载' : 'Loaded')}</span></div>
          <p>{skill.description}</p>
        </div>)}
      </div>
    </section>
    {selection && <ProjectFolderDialog language={language} selectionMode="path"
      title={chinese ? '选择 Skill 来源' : 'Choose a Skill source'}
      filters={[{ name: 'Skill (SKILL.md)', extensions: ['md'] }]}
      onCancel={() => setSelection(null)} onSelect={selectSource} />}
  </div>;
}
