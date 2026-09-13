import React, { useEffect, useState } from 'react';
import type { ConversationProject } from '@deepcode/protocol';
import { getConversationCatalog } from '../../../services/localAgentApi';
import { useSettingsStore } from '../../../state/settingsStore';

type ProjectEnvironment = { kind: 'native' } | { kind: 'wsl'; distribution: string; worker: string };

export default function ProjectEnvironmentSettings({ chinese }: { chinese: boolean }) {
  const encoded = useSettingsStore((state) => String(state.effectiveSettings['agent.projectEnvironments'] ?? '{}'));
  const environment = useSettingsStore((state) => state.environment);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const [projects, setProjects] = useState<ConversationProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [target, setTarget] = useState<ProjectEnvironment>({ kind: 'native' });
  const [error, setError] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void getConversationCatalog(controller.signal).then((catalog) => {
      if (controller.signal.aborted) return;
      setProjects(catalog.projects);
      setProjectId((current) => current || catalog.projects[0]?.id || '');
    }).catch((error: unknown) => { if (!controller.signal.aborted) setError(String(error)); });
    return () => controller.abort();
  }, []);
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
    <h3 className="settings-card__title">{chinese ? '项目执行环境' : 'Project execution environment'}</h3>
    <div className="settings-card settings-card__body">
      <label className="settings-field settings-field--compact"><span>{chinese ? '项目' : 'Project'}</span>
        <select className="settings-field__select" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={saving || projects.length === 0}>
          {projects.length === 0 && <option value="">{chinese ? '暂无项目' : 'No projects'}</option>}
          {projects.map((project) => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select></label>
      {projectId && <>
        <label className="settings-field settings-field--compact"><span>{chinese ? '运行位置' : 'Run tools in'}</span>
          <select className="settings-field__select" value={target.kind} disabled={saving}
            onChange={(event) => setTarget(event.target.value === 'wsl' ? { kind: 'wsl', distribution: '', worker: 'deepcode-kernel-daemon' } : { kind: 'native' })}>
            <option value="native">{chinese ? '本机（使用全局 Shell 设置）' : 'Native (global shell preference)'}</option>
            <option value="wsl" disabled={environment?.os !== 'windows'}>WSL</option>
          </select></label>
        {target.kind === 'wsl' && <>
          <label className="settings-field settings-field--compact"><span>{chinese ? 'WSL 发行版' : 'WSL distribution'}</span>
            <input className="settings-field__input" value={target.distribution} disabled={saving} placeholder="Ubuntu" onChange={(event) => setTarget({ ...target, distribution: event.target.value })} /></label>
          <label className="settings-field settings-field--compact"><span>{chinese ? 'Linux Kernel 可执行文件' : 'Linux Kernel executable'}</span>
            <input className="settings-field__input" value={target.worker} disabled={saving} placeholder="/opt/deepcode/deepcode-kernel-daemon" onChange={(event) => setTarget({ ...target, worker: event.target.value })} /></label>
          <p>{chinese ? '使用发行版内安装的当前版本 Linux Kernel。文件操作与 Bash 一起在该环境执行；不会启动另一个会话服务。项目目录需要能从该发行版访问。' : 'Use the current Linux Kernel installed inside the distribution. File operations and Bash execute together there; no second Session service is started. The project directory must be accessible from that distribution.'}</p>
        </>}
        <p className="settings-card__inline-placeholder">{chinese ? '环境变更从下一次运行生效。WSL 仅在 Windows 主机可选，不会在工具失败后自动切换。' : 'Changes apply to the next run. WSL is available on Windows hosts and is never selected automatically after a tool failure.'}</p>
        <div className="settings-actions"><button className="settings-button" disabled={saving || !!configurationError || (target.kind === 'wsl' && (!target.distribution.trim() || !target.worker.trim()))} onClick={() => void save()}>{chinese ? '保存项目环境' : 'Save project environment'}</button></div>
      </>}
      {(configurationError || error) && <p className="settings-error" role="alert">{configurationError || error}</p>}
    </div>
  </section>;
}
