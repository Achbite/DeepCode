import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import '../settingsCenter.css';
import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../../state/settingsStore';

type ProjectEnvironment = { kind: 'native'; shell?: 'auto' | 'powershell7' | 'windowsPowerShell' | 'gitBash'; gitBashPath?: string } | { kind: 'wsl'; distribution: string; worker: string };

export default function ProjectEnvironmentSettings({ chinese, projectId }: { chinese: boolean; projectId: string }) {
  const encoded = useSettingsStore((state) => String(state.effectiveSettings['agent.projectEnvironments'] ?? '{}'));
  const environment = useSettingsStore((state) => state.environment);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const [target, setTarget] = useState<ProjectEnvironment>({ kind: 'native' });
  const [error, setError] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    try {
      const values = JSON.parse(encoded) as Record<string, ProjectEnvironment>;
      if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Invalid project execution settings');
      const next = values[projectId] ?? { kind: 'native' };
      if (!['native', 'wsl'].includes(next.kind)) throw new Error('Invalid project execution environment');
      setTarget(next);
      setConfigurationError(null);
    } catch (error) { setConfigurationError(String(error)); }
  }, [encoded, projectId]);
  let savedTarget: ProjectEnvironment = { kind: 'native' };
  try { savedTarget = JSON.parse(encoded)[projectId] ?? savedTarget; } catch { /* The configuration error is shown below. */ }
  const dirty = JSON.stringify(target) !== JSON.stringify(savedTarget);
  useInterfaceReloadGuard(dirty, chinese ? '工作区环境' : 'Workspace environment', saving);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await patch('agent.projectEnvironments', JSON.stringify({ ...JSON.parse(encoded), [projectId]: target }));
      if (result === null) setError(useSettingsStore.getState().errorMessage);
    } catch (error) { setError(String(error)); }
    finally { setSaving(false); }
  };
  return <section className="settings-group">
    <h3 className="settings-card__title">{chinese ? '运行 Shell' : 'Execution shell'}</h3>
    <div className="settings-card settings-card__body">
      {projectId && <>
        <label className="settings-field settings-field--compact"><span>{chinese ? '运行位置' : 'Run tools in'}</span>
          <select className="settings-field__select" value={target.kind} disabled={saving}
            onChange={(event) => setTarget(event.target.value === 'wsl' ? { kind: 'wsl', distribution: '', worker: 'deepcode-kernel-daemon' } : { kind: 'native' })}>
            <option value="native">{chinese ? '本机' : 'Native'}</option>
            {(environment?.os === 'windows' || target.kind === 'wsl') && <option value="wsl" disabled={environment?.os !== 'windows'}>WSL</option>}
          </select></label>
        {target.kind === 'native' && environment?.os === 'windows' && <>
          <label className="settings-field settings-field--compact"><span>Shell</span>
            <select className="settings-field__select" disabled={saving} value={target.shell ?? ''} onChange={event => setTarget({ ...target, shell: (event.target.value || undefined) as Extract<ProjectEnvironment, {kind: 'native'}>['shell'] })}>
              <option value="">{chinese ? '使用全局默认' : 'Global default'}</option>
              <option value="auto">{chinese ? '自动检测' : 'Auto detect'}</option>
              <option value="powershell7">PowerShell 7</option><option value="windowsPowerShell">Windows PowerShell</option><option value="gitBash">Git Bash</option>
            </select></label>
          {target.shell === 'gitBash' && <label className="settings-field settings-field--compact"><span>{chinese ? 'Git Bash 路径' : 'Git Bash path'}</span>
            <input className="settings-field__input" disabled={saving} value={target.gitBashPath ?? ''} placeholder={chinese ? '留空自动检测' : 'Auto detect when empty'} onChange={event => setTarget({ ...target, gitBashPath: event.target.value })} /></label>}
        </>}
        {target.kind === 'wsl' && <>
          <label className="settings-field settings-field--compact"><span>{chinese ? 'WSL 发行版' : 'WSL distribution'}</span>
            <input className="settings-field__input" value={target.distribution} disabled={saving} placeholder="Ubuntu" onChange={(event) => setTarget({ ...target, distribution: event.target.value })} /></label>
          <label className="settings-field settings-field--compact"><span>{chinese ? 'Linux Kernel 可执行文件' : 'Linux Kernel executable'}</span>
            <input className="settings-field__input" value={target.worker} disabled={saving} placeholder="/opt/deepcode/deepcode-kernel-daemon" onChange={(event) => setTarget({ ...target, worker: event.target.value })} /></label>
        </>}
        <div className="settings-actions"><button className="settings-button" disabled={!dirty || saving || !!configurationError || (target.kind === 'wsl' && (!target.distribution.trim() || !target.worker.trim()))} onClick={() => void save()}>{chinese ? '保存环境' : 'Save environment'}</button></div>
      </>}
      {(configurationError || error) && <p className="settings-error" role="alert">{configurationError || error}</p>}
    </div>
  </section>;
}
