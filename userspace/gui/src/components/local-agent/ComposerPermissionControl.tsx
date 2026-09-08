import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import type { AgentComposer } from './useAgentComposer';

export function ComposerPermissionControl({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const { permissionControlRef, permissionMenuOpen, setPermissionMenuOpen, setAttachmentMenuOpen } = composer;
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const runtimeEffectiveSettings = useSettingsStore((state) => state.runtimeEffectiveSettings);
  const settingsPendingNextRunActivation = useSettingsStore(
    (state) => state.pendingNextRunActivation,
  );
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  return (
    <div ref={permissionControlRef} className="local-agent__permission-control">
      <button
        type="button"
        className="local-agent__permission-summary"
        aria-expanded={permissionMenuOpen}
        onClick={() => {
          setPermissionMenuOpen((open) => !open);
          setAttachmentMenuOpen(false);
        }}
      >
        {t(
          language,
          runtimeEffectiveSettings['agent.permissions.workspaceMutation'] === 'allow'
            ? 'agent.permission.summary.allow'
            : 'agent.permission.summary.plan',
          {
            external: t(
              language,
              runtimeEffectiveSettings['agent.permissions.external'] === 'allow'
                ? 'agent.permission.allow'
                : runtimeEffectiveSettings['agent.permissions.external'] === 'deny'
                  ? 'agent.permission.deny'
                  : 'agent.permission.ask',
            ),
          },
        )}
      </button>
      {permissionMenuOpen && (
        <div className="local-agent__permission-menu">
          {settingsPendingNextRunActivation && (
            <div className="local-agent__permission-activation-notice">
              {t(language, 'agent.permission.nextRunActivationPending')}
            </div>
          )}
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
