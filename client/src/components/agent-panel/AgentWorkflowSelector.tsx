import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentWorkflowConfig,
  AgentWorkflowStage,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { AGENT_WORKFLOW_STAGES } from '@deepcode/protocol';

interface AgentWorkflowSelectorProps {
  profiles: LlmProviderProfile[];
  config: AgentWorkflowConfig | null;
  disabled?: boolean;
  onChange: (config: AgentWorkflowConfig) => void;
}

const STAGE_LABELS: Record<AgentWorkflowStage, string> = {
  plan: 'Plan model',
  check: 'Check model',
  complete: 'Complete model',
  review: 'Review model',
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
        title="Agent workflow model routing"
      >
        plan-check-complete-review
      </button>
      {open && (
        <div className="agent-workflow-selector__popover">
          <div className="agent-workflow-selector__title">Workflow Models</div>
          {validProfiles.length === 0 && (
            <div className="agent-workflow-selector__empty">
              Configure and save a valid LLM profile first.
            </div>
          )}
          {AGENT_WORKFLOW_STAGES.map((stage) => (
            <label key={stage} className="agent-workflow-selector__row">
              <span>{STAGE_LABELS[stage]}</span>
              <select
                value={current[stage]?.profileId ?? ''}
                disabled={disabled}
                onChange={(event) => updateStage(stage, event.target.value)}
              >
                <option value="">Skip</option>
                {validProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name} · {profile.model}
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
