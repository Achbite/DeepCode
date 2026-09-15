import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import type { AgentComposer } from './useAgentComposer';

export function ComposerPermissionControl({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const { permissionControlRef, permissionMenuOpen, setPermissionMenuOpen, setAttachmentMenuOpen } = composer;
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const runtimeEffectiveSettings = useSettingsStore((state) => state.runtimeEffectiveSettings);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const summary = t(language,
    runtimeEffectiveSettings['agent.permissions.workspaceMutation'] === 'allow'
      ? 'agent.permission.summary.allow' : 'agent.permission.summary.plan',
    { external: t(language,
      runtimeEffectiveSettings['agent.permissions.external'] === 'allow' ? 'agent.permission.allow'
        : runtimeEffectiveSettings['agent.permissions.external'] === 'deny' ? 'agent.permission.deny' : 'agent.permission.ask') },
  );
  return (
    <div ref={permissionControlRef} className="local-agent__permission-control">
      <button
        type="button"
        className="local-agent__permission-summary"
        aria-label={t(language, 'settings.nav.permissions')}
        title={summary}
        aria-expanded={permissionMenuOpen}
        onClick={() => {
          setPermissionMenuOpen((open) => !open);
          setAttachmentMenuOpen(false);
        }}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6Z"/><path d="m8 12 3 3 5-6"/></svg>
        <span>{summary}</span>
      </button>
      {permissionMenuOpen && (
        <div className="local-agent__permission-menu">
          <div className="local-agent__permission-invariant">
            <span>{t(language, 'agent.permission.workspaceRead')}</span>
            <strong>{t(language, 'agent.permission.workspaceReadAllowed')}</strong>
          </div>
          {permissionSetting(
            t(language, 'agent.permission.workspaceMutation'),
            'agent.permissions.workspaceMutation',
            effectiveSettings,
            patchUserSetting,
            [
              {
                value: 'plan',
                label: t(language, 'agent.permission.workspaceMutationPlan'),
              },
              {
                value: 'allow',
                label: t(language, 'agent.permission.workspaceMutationAllow'),
              },
            ],
            'plan',
          )}
          {permissionSetting(
            t(language, 'agent.permission.engineeringDecisions'),
            'agent.permissions.engineeringDecisions',
            effectiveSettings,
            patchUserSetting,
            [
              {
                value: 'ask',
                label: t(language, 'agent.permission.engineeringDecisionsAsk'),
              },
              {
                value: 'delegate',
                label: t(language, 'agent.permission.engineeringDecisionsDelegate'),
              },
            ],
            'ask',
          )}
          {permissionSetting(
            t(language, 'agent.permission.networkRead'),
            'agent.permissions.networkRead',
            effectiveSettings,
            patchUserSetting,
            [
              { value: 'allow', label: t(language, 'agent.permission.allow') },
              { value: 'ask', label: t(language, 'agent.permission.ask') },
              { value: 'deny', label: t(language, 'agent.permission.deny') },
            ],
            'ask',
          )}
          {permissionSetting(
            t(language, 'agent.permission.externalEffects'),
            'agent.permissions.external',
            effectiveSettings,
            patchUserSetting,
            [
              { value: 'allow', label: t(language, 'agent.permission.allow') },
              { value: 'ask', label: t(language, 'agent.permission.ask') },
              { value: 'deny', label: t(language, 'agent.permission.deny') },
            ],
            'ask',
          )}
        </div>
      )}
    </div>
  );
}

function permissionSetting(
  label: string,
  key: string,
  settings: Record<string, unknown>,
  patch: (key: string, value: string) => Promise<unknown>,
  options: readonly {value: string; label: string}[],
  defaultValue: string,
): React.ReactNode {
  return (
    <label>
      <span>{label}</span>
      <select
        value={String(settings[key] ?? defaultValue)}
        onChange={(event) => void patch(key, event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}
