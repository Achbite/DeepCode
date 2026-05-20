import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../../../state/settingsStore';
import { useWorkspaceStore } from '../../../state/workspaceStore';
import {
  getLlmProfiles,
  getRuntimeStatus,
  listAgentTools,
  type RuntimeStatus,
} from '../../../services/runtimeAdapter';

type DoctorStatus = 'ok' | 'warn' | 'error';

interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  detail: string;
}

function parseArraySetting(raw: unknown): unknown[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'ok') return 'OK';
  if (status === 'warn') return 'WARN';
  return 'ERROR';
}

const RuntimeDoctorSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const settingsError = useSettingsStore((s) => s.errorMessage);
  const settingsStorePath = useSettingsStore((s) => s.storePath);
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const workspaceError = useWorkspaceStore((s) => s.lastError);
  const workspaceLoading = useWorkspaceStore((s) => s.loading);

  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);

    const nextRuntime = await getRuntimeStatus();
    const llmProfiles = await getLlmProfiles();
    const agentTools = await listAgentTools();

    const promptProfiles = parseArraySetting(effectiveSettings['prompt.profiles']);
    const skillMounts = parseArraySetting(effectiveSettings['skills.mounts']);
    const rulerRules = parseArraySetting(effectiveSettings['ruler.rules']);
    const rulerEnabled = Boolean(effectiveSettings['ruler.enabled']);
    const autoLoadSkills = Boolean(effectiveSettings['skills.autoLoad']);

    const nextChecks: DoctorCheck[] = [
      {
        id: 'runtime',
        title: 'Runtime bridge',
        status: nextRuntime.version === 'unknown' ? 'warn' : 'ok',
        detail: `${nextRuntime.runtime} on ${nextRuntime.platform}${
          nextRuntime.arch ? `/${nextRuntime.arch}` : ''
        }, version ${nextRuntime.version}`,
      },
      {
        id: 'workspace',
        title: 'Workspace',
        status:
          workspace && workspace.folders.length > 0
            ? fallbackUsed
              ? 'warn'
              : 'ok'
            : 'error',
        detail:
          workspace && workspace.folders.length > 0
            ? `${workspace.name}: ${workspace.folders.length} folder(s)${
                fallbackUsed ? ', fallback workspace is active' : ''
              }`
            : workspaceError ?? 'No active workspace folder is available.',
      },
      {
        id: 'settings',
        title: 'Settings store',
        status: settingsError ? 'error' : settingsStorePath ? 'ok' : 'warn',
        detail: settingsError ?? settingsStorePath ?? 'Settings store path is not loaded yet.',
      },
      {
        id: 'llm',
        title: 'LLM profiles',
        status:
          llmProfiles.ok && llmProfiles.data && llmProfiles.data.profiles.length > 0
            ? 'ok'
            : 'warn',
        detail:
          llmProfiles.ok && llmProfiles.data
            ? `${llmProfiles.data.profiles.length} profile(s), default ${
                llmProfiles.data.defaultProfileId ?? 'not set'
              }`
            : llmProfiles.message ?? 'No profile is configured yet.',
      },
      {
        id: 'prompt',
        title: 'Prompt profiles',
        status: promptProfiles.length > 0 ? 'ok' : 'warn',
        detail:
          promptProfiles.length > 0
            ? `${promptProfiles.length} prompt profile(s) configured.`
            : 'No prompt profile is configured.',
      },
      {
        id: 'skills',
        title: 'Skill mounts',
        status: autoLoadSkills && skillMounts.length === 0 ? 'warn' : 'ok',
        detail:
          skillMounts.length > 0
            ? `${skillMounts.length} skill mount(s), auto-load ${
                autoLoadSkills ? 'enabled' : 'disabled'
              }.`
            : `No external skill mount is configured, auto-load ${
                autoLoadSkills ? 'enabled' : 'disabled'
              }.`,
      },
      {
        id: 'ruler',
        title: 'Ruler rules',
        status: rulerEnabled && rulerRules.length === 0 ? 'warn' : 'ok',
        detail:
          rulerRules.length > 0
            ? `${rulerRules.length} rule(s), engine ${
                rulerEnabled ? 'enabled' : 'disabled'
              }.`
            : `No custom rules, engine ${rulerEnabled ? 'enabled' : 'disabled'}.`,
      },
      {
        id: 'tools',
        title: 'Agent tool interface',
        status:
          agentTools.ok &&
          agentTools.data &&
          agentTools.data.tools.some((tool) => tool.name === 'fs.write')
            ? 'ok'
            : 'error',
        detail:
          agentTools.ok && agentTools.data
            ? `${agentTools.data.tools.length} tool(s) registered; writes are gated by Act mode approval.`
            : agentTools.message ?? 'Agent tool interface is not reachable.',
      },
    ];

    setRuntime(nextRuntime);
    setChecks(nextChecks);
    setLastUpdated(new Date().toLocaleString());
    setRefreshing(false);
  }, [
    effectiveSettings,
    fallbackUsed,
    settingsError,
    settingsStorePath,
    workspace,
    workspaceError,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const errorCount = checks.filter((check) => check.status === 'error').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;

  return (
    <div>
      <h2 className="settings-title">Runtime Doctor</h2>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <div>
            <h3 className="settings-card__title">Environment Diagnostics</h3>
            <p className="settings-card__body">
              Checks the active runtime, workspace, settings, Agent profiles,
              skills, rules, and minimum tool bridge.
            </p>
          </div>
          <button
            className="settings-action-button"
            onClick={() => void refresh()}
            disabled={refreshing || workspaceLoading}
          >
            {refreshing ? 'Checking...' : 'Refresh'}
          </button>
        </div>

        <div className="doctor-summary">
          <span className={`doctor-pill ${errorCount > 0 ? 'doctor-pill--error' : ''}`}>
            {errorCount} errors
          </span>
          <span className={`doctor-pill ${warnCount > 0 ? 'doctor-pill--warn' : ''}`}>
            {warnCount} warnings
          </span>
          <span className="doctor-pill">
            {runtime ? `${runtime.runtime} runtime` : 'runtime pending'}
          </span>
          {lastUpdated && <span className="doctor-updated">Updated {lastUpdated}</span>}
        </div>
      </div>

      <div className="doctor-grid">
        {checks.map((check) => (
          <div
            className={`doctor-check doctor-check--${check.status}`}
            key={check.id}
          >
            <div className="doctor-check__header">
              <span>{check.title}</span>
              <span>{statusLabel(check.status)}</span>
            </div>
            <p>{check.detail}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default RuntimeDoctorSection;
