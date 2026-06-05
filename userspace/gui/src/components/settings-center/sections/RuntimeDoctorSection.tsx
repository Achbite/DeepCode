import React, { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../../../state/settingsStore';
import { useWorkspaceStore } from '../../../state/workspaceStore';
import { normalizeUiLanguage, t } from '../../../i18n';
import {
  getAgentPromptLayers,
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

function enabledLabel(value: boolean, language: ReturnType<typeof normalizeUiLanguage>): string {
  return value ? t(language, 'settings.common.enabled') : t(language, 'settings.common.disabled');
}

const RuntimeDoctorSection: React.FC = () => {
  const effectiveSettings = useSettingsStore((s) => s.effectiveSettings);
  const settingsError = useSettingsStore((s) => s.errorMessage);
  const settingsStorePath = useSettingsStore((s) => s.storePath);
  const workspace = useWorkspaceStore((s) => s.current);
  const fallbackUsed = useWorkspaceStore((s) => s.fallbackUsed);
  const workspaceError = useWorkspaceStore((s) => s.lastError);
  const workspaceLoading = useWorkspaceStore((s) => s.loading);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);

  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [checks, setChecks] = useState<DoctorCheck[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);

    const nextRuntime = await getRuntimeStatus();
    const llmProfiles = await getLlmProfiles();
    const agentTools = await listAgentTools();
    const promptLayers = await getAgentPromptLayers();

    const skillMounts = parseArraySetting(effectiveSettings['skills.mounts']);
    const mcpServers = parseArraySetting(effectiveSettings['mcp.servers']);
    const rulerRules = parseArraySetting(effectiveSettings['ruler.rules']);
    const rulerEnabled = Boolean(effectiveSettings['ruler.enabled']);
    const autoLoadSkills = Boolean(effectiveSettings['skills.autoLoad']);
    const autoLoadMcp = Boolean(effectiveSettings['mcp.autoLoad']);

    const nextChecks: DoctorCheck[] = [
      {
        id: 'runtime',
        title: t(language, 'settings.doctor.check.runtime'),
        status: nextRuntime.version === 'unknown' ? 'warn' : 'ok',
        detail: t(language, 'settings.doctor.detail.runtime', {
          runtime: nextRuntime.runtime,
          platform: `${nextRuntime.platform}${nextRuntime.arch ? `/${nextRuntime.arch}` : ''}`,
          version: nextRuntime.version,
        }),
      },
      {
        id: 'workspace',
        title: t(language, 'settings.doctor.check.workspace'),
        status:
          workspace && workspace.folders.length > 0
            ? fallbackUsed
              ? 'warn'
              : 'ok'
            : 'warn',
        detail:
          workspace && workspace.folders.length > 0
            ? t(language, 'settings.doctor.detail.workspace', {
                name: workspace.name,
                count: workspace.folders.length,
                fallback: fallbackUsed ? t(language, 'settings.doctor.fallbackActive') : '',
              })
            : workspaceError ?? t(language, 'settings.doctor.noWorkspace'),
      },
      {
        id: 'settings',
        title: t(language, 'settings.doctor.check.settings'),
        status: settingsError ? 'error' : settingsStorePath ? 'ok' : 'warn',
        detail: settingsError ?? settingsStorePath ?? t(language, 'settings.doctor.settingsNotLoaded'),
      },
      {
        id: 'llm',
        title: t(language, 'settings.doctor.check.llm'),
        status:
          llmProfiles.ok && llmProfiles.data && llmProfiles.data.profiles.length > 0
            ? 'ok'
            : 'warn',
        detail:
          llmProfiles.ok && llmProfiles.data
            ? t(language, 'settings.doctor.detail.llm', {
                count: llmProfiles.data.profiles.length,
                defaultProfile: llmProfiles.data.defaultProfileId ?? t(language, 'settings.doctor.notSet'),
              })
            : llmProfiles.message ?? t(language, 'settings.doctor.noLlm'),
      },
      {
        id: 'prompt',
        title: t(language, 'settings.doctor.check.prompt'),
        status: promptLayers.ok && promptLayers.data && promptLayers.data.layers.length > 0 ? 'ok' : 'warn',
        detail:
          promptLayers.ok && promptLayers.data && promptLayers.data.layers.length > 0
            ? t(language, 'settings.doctor.detail.prompt', { count: promptLayers.data.layers.length })
            : promptLayers.message ?? t(language, 'settings.doctor.noPrompt'),
      },
      {
        id: 'skills',
        title: t(language, 'settings.doctor.check.skills'),
        status: autoLoadSkills && skillMounts.length === 0 ? 'warn' : 'ok',
        detail:
          skillMounts.length > 0
            ? t(language, 'settings.doctor.detail.skills', {
                count: skillMounts.length,
                autoLoad: enabledLabel(autoLoadSkills, language),
              })
            : t(language, 'settings.doctor.noSkills', {
                autoLoad: enabledLabel(autoLoadSkills, language),
              }),
      },
      {
        id: 'mcp',
        title: t(language, 'settings.doctor.check.mcp'),
        status: autoLoadMcp && mcpServers.length === 0 ? 'warn' : 'ok',
        detail:
          mcpServers.length > 0
            ? t(language, 'settings.doctor.detail.mcp', {
                count: mcpServers.length,
                autoLoad: enabledLabel(autoLoadMcp, language),
              })
            : t(language, 'settings.doctor.noMcp', {
                autoLoad: enabledLabel(autoLoadMcp, language),
              }),
      },
      {
        id: 'ruler',
        title: t(language, 'settings.doctor.check.ruler'),
        status: rulerEnabled && rulerRules.length === 0 ? 'warn' : 'ok',
        detail:
          rulerRules.length > 0
            ? t(language, 'settings.doctor.detail.ruler', {
                count: rulerRules.length,
                engine: enabledLabel(rulerEnabled, language),
              })
            : t(language, 'settings.doctor.noRuler', {
                engine: enabledLabel(rulerEnabled, language),
              }),
      },
      {
        id: 'tools',
        title: t(language, 'settings.doctor.check.tools'),
        status:
          agentTools.ok &&
          agentTools.data &&
          agentTools.data.tools.some((tool) => tool.name === 'fs.write')
            ? 'ok'
            : 'error',
        detail:
          agentTools.ok && agentTools.data
            ? t(language, 'settings.doctor.detail.tools', { count: agentTools.data.tools.length })
            : agentTools.message ?? t(language, 'settings.doctor.toolsNotReachable'),
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
    language,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const errorCount = checks.filter((check) => check.status === 'error').length;
  const warnCount = checks.filter((check) => check.status === 'warn').length;

  return (
    <div>
      <h2 className="settings-title">{t(language, 'settings.doctor.title')}</h2>

      <div className="settings-card">
        <div className="settings-card__header-row">
          <div>
            <h3 className="settings-card__title">{t(language, 'settings.doctor.environment')}</h3>
            <p className="settings-card__body">
              {t(language, 'settings.doctor.body')}
            </p>
          </div>
          <button
            className="settings-action-button"
            onClick={() => void refresh()}
            disabled={refreshing || workspaceLoading}
          >
            {refreshing ? t(language, 'settings.doctor.checking') : t(language, 'settings.doctor.refresh')}
          </button>
        </div>

        <div className="doctor-summary">
          <span className={`doctor-pill ${errorCount > 0 ? 'doctor-pill--error' : ''}`}>
            {t(language, 'settings.doctor.errors', { count: errorCount })}
          </span>
          <span className={`doctor-pill ${warnCount > 0 ? 'doctor-pill--warn' : ''}`}>
            {t(language, 'settings.doctor.warnings', { count: warnCount })}
          </span>
          <span className="doctor-pill">
            {runtime
              ? t(language, 'settings.doctor.runtimePill', { runtime: runtime.runtime })
              : t(language, 'settings.doctor.runtimePending')}
          </span>
          {lastUpdated && (
            <span className="doctor-updated">
              {t(language, 'settings.doctor.updated', { time: lastUpdated })}
            </span>
          )}
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
