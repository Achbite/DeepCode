import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentWorkflowConfig,
  AgentWorkflowStage,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { AGENT_WORKFLOW_STAGES } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface AgentWorkflowSelectorProps {
  profiles: LlmProviderProfile[];
  config: AgentWorkflowConfig | null;
  language: UiLanguage;
  disabled?: boolean;
  onChange: (config: AgentWorkflowConfig) => void;
}

const STAGE_LABEL_KEYS: Record<AgentWorkflowStage, string> = {
  plan: 'agent.workflow.planModel',
  check: 'agent.workflow.checkModel',
  complete: 'agent.workflow.completeModel',
  review: 'agent.workflow.reviewModel',
};

function emptyConfig(): AgentWorkflowConfig {
  return Object.fromEntries(
    AGENT_WORKFLOW_STAGES.map((stage) => [stage, {}])
  ) as AgentWorkflowConfig;
}

function isValidProfile(profile: LlmProviderProfile): boolean {
  return profile.enabled !== false && (profile.kind === 'ollama' || Boolean(profile.secretRef));
}

const AgentWorkflowSelector: React.FC<AgentWorkflowSelectorProps> = ({
  profiles,
  config,
  language,
  disabled,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const validProfiles = useMemo(() => profiles.filter(isValidProfile), [profiles]);
  const current = config ?? emptyConfig();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const updateStage = (stage: AgentWorkflowStage, profileId: string) => {
    onChange({
      ...current,
      [stage]: profileId ? { profileId } : {},
    });
  };

  return (
    <div className="agent-workflow-selector" ref={rootRef}>
      <button
        className="agent-workflow-selector__button"
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title={t(language, 'agent.workflow.routing')}
      >
        plan-check-complete-review
      </button>
      {open && (
        <div className="agent-workflow-selector__popover">
          <div className="agent-workflow-selector__title">
            {t(language, 'agent.workflow.title')}
          </div>
          {validProfiles.length === 0 && (
            <div className="agent-workflow-selector__empty">
              {t(language, 'agent.workflow.noProfile')}
            </div>
          )}
          {AGENT_WORKFLOW_STAGES.map((stage) => (
            <label key={stage} className="agent-workflow-selector__row">
              <span>{t(language, STAGE_LABEL_KEYS[stage])}</span>
              <select
                value={current[stage]?.profileId ?? ''}
                disabled={disabled}
                onChange={(event) => updateStage(stage, event.target.value)}
              >
                <option value="">{t(language, 'agent.workflow.skip')}</option>
                {validProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.model}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentWorkflowSelector;
