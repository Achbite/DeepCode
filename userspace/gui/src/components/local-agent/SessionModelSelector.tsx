import React, { useEffect, useId, useRef, useState } from 'react';
import type { ContextCompositionProjection, ContextUsageProjection, LlmProviderProfile, ModelConnection, LlmReasoningEffort } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ContextUsageControl } from './ContextUsageControl';
import { UiRegion } from '../../ui-plugins/UiRegion';
import { useDisplayTheme } from '../../ui-plugins/UiPlugins';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  connections?: readonly ModelConnection[];
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  confirmed: boolean;
  onSelect(profileId: string, effort: LlmReasoningEffort | null): Promise<void>;
}

export default function SessionModelSelector({ language, profiles, connections = [], selectedProfileId,
  reasoningEffortOverride, contextUsage, contextCompositions, busy = false, confirmed, onSelect }: SessionModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null), triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId(), theme = useDisplayTheme(), chinese = language === 'zh-CN';
  const selected = profiles.find(profile => profile.id === selectedProfileId);
  const candidate = profiles.find(profile => profile.id === candidateId);
  const title = (selected?.name ?? selectedProfileId ?? (chinese ? '选择模型' : 'Choose model')) + (selectedProfileId && !selected?.enabled ? ` · ${t(language, selected ? 'agent.profile.disabled' : 'agent.profile.missing')}` : '');
  const effortLabel = selected?.thinking === 'disabled'
    ? (chinese ? '不适用' : 'Not applicable')
    : reasoningEffortOverride ? t(language, `settings.llm.effort.${reasoningEffortOverride}`) : (chinese ? '选择强度' : 'Choose level');
  const close = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled),button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const choose = async (effort: LlmReasoningEffort | null, profile = candidate) => {
    if (!profile?.enabled || busy) return;
    await onSelect(profile.id, effort); close();
  };
  return <div ref={rootRef} className="deepcode-session-model">
    <ContextUsageControl language={language} contextUsage={contextUsage} contextCompositions={contextCompositions}
      contextOpen={contextOpen} setContextOpen={setContextOpen} rootRef={rootRef}
      onToggle={() => { setOpen(false); setContextOpen(value => !value); }} />
    <UiRegion slot="composer.model" input={{ kind: 'composer.model', profiles, connections, selectedProfileId,
      reasoningEffort: reasoningEffortOverride, confirmed, busy, locale: language, theme }} actions={{ selectModel: onSelect }}>
      <button ref={triggerRef} type="button" className="deepcode-session-model__selector" disabled={busy}
        aria-label={`${title} · ${effortLabel}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        onClick={() => { setContextOpen(false); setCandidateId(selectedProfileId); setOpen(value => !value); }}>
        <span>{title}</span><span className="deepcode-session-model__selector-effort">{effortLabel}</span><DeepCodeShellIcon name="chevronDown" />
      </button>
      {open && <div id={menuId} ref={menuRef} role="menu" className="deepcode-session-model__menu deepcode-session-model__menu--combined"
        aria-label={chinese ? '模型与推理强度' : 'Model and reasoning'} onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
          if (event.key === 'Tab') setOpen(false);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
            buttons[next]?.focus();
          }
        }}>
        <div className="deepcode-session-model__model-list">
          {connections.map(connection => <React.Fragment key={connection.id}>
            <div className="deepcode-session-model__menu-title">{connection.name}</div>
            {profiles.filter(profile => profile.enabled && profile.connectionId === connection.id).map(profile => <button
              key={profile.id} type="button" role="menuitemradio" aria-checked={candidateId === profile.id} disabled={busy}
              onClick={() => {
                setCandidateId(profile.id);
                if (profile.id !== selectedProfileId && (profile.thinking === 'disabled' || profile.reasoningEffort)) {
                  void choose(profile.thinking === 'disabled' ? null : profile.reasoningEffort!, profile);
                }
              }}><span>{profile.name}</span>{candidateId === profile.id && <DeepCodeShellIcon name="check" />}</button>)}
          </React.Fragment>)}
        </div>
        <div className="deepcode-session-model__menu-divider" role="separator" />
        {candidate?.thinking === 'disabled' ? <button type="button" role="menuitem" disabled={busy} onClick={() => void choose(null)}>{chinese ? '使用此模型' : 'Use this model'}</button>
          : <><div className="deepcode-session-model__menu-title">{t(language, 'settings.llm.reasoningEffort')}</div>
            <div className="deepcode-session-model__efforts">{(['low', 'medium', 'high', 'max'] as const).filter(effort => candidate?.providerFlavor !== 'deepseek' || effort !== 'medium').map(effort => <button
              key={effort} type="button" role="menuitemradio" aria-checked={confirmed && candidateId === selectedProfileId && reasoningEffortOverride === effort}
              disabled={busy || !candidate?.enabled} onClick={() => void choose(effort)}>{t(language, `settings.llm.effort.${effort}`)}</button>)}</div></>}
      </div>}
    </UiRegion>
  </div>;
}
