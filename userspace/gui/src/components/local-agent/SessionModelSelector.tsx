import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ContextCompositionProjection, ContextUsageProjection, LlmProviderProfile, LlmReasoningEffort } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ContextUsageControl } from './ContextUsageControl';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  onProfileChange: (profileId: string) => void | Promise<void>;
  onReasoningEffortChange: (effort: LlmReasoningEffort | null) => void | Promise<void>;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  profiles,
  selectedProfileId,
  reasoningEffortOverride,
  contextUsage,
  contextCompositions,
  busy = false,
  onProfileChange,
  onReasoningEffortChange,
}) => {
  const [menu, setMenu] = useState<'models' | 'reasoning' | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [contextOpen, setContextOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const enabled = useMemo(
    () => profiles.filter((profile) => profile.enabled),
    [profiles],
  );
  const selected = enabled.find((profile) => profile.id === selectedProfileId);
  const disabled = busy || enabled.length === 0;
  const title = selected?.name ?? t(language, 'agent.profile.selectionRequired');
  const effortLabel = selected?.thinking === 'disabled'
    ? t(language, 'agent.profile.thinkingDisabled')
    : reasoningEffortOverride
      ? t(language, `settings.llm.effort.${reasoningEffortOverride}`)
      : t(language, 'agent.profile.followDefault');
  const closeMenu = () => { setMenu(null); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!menu) return undefined;
    (menuRef.current?.querySelector<HTMLButtonElement>('button[aria-checked="true"]:not(:disabled)')
      ?? menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);
  const menuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (menu === 'reasoning') setMenu('models');
      else closeMenu();
      return;
    }
    if (event.key === 'ArrowLeft' && menu === 'reasoning') { event.preventDefault(); setMenu('models'); return; }
    if (event.key === 'Tab') { setMenu(null); return; }
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const options = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  };
  return (
    <div ref={rootRef} className="deepcode-session-model">
      <ContextUsageControl
        language={language}
        contextUsage={contextUsage}
        contextCompositions={contextCompositions}
        contextOpen={contextOpen}
        setContextOpen={setContextOpen}
        rootRef={rootRef}
        onToggle={() => { setMenu(null); setContextOpen((open) => !open); }}
      />
      <button ref={triggerRef} type="button" className="deepcode-session-model__selector"
        title={title} disabled={disabled} aria-label={`${t(language, 'agent.profile.selector')}：${title}`}
        aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? menuId : undefined}
        onClick={() => { setContextOpen(false); setMenu((current) => current ? null : 'models'); }}>
        <span>{title}</span><span aria-hidden="true">⌄</span>
      </button>
      {menu && (
        <div ref={menuRef} id={menuId} role="menu" className="deepcode-session-model__menu"
          aria-label={t(language, menu === 'models' ? 'agent.profile.selector' : 'settings.llm.reasoningEffort')}
          onKeyDown={menuKeyDown}>
          {menu === 'models' ? <>
            <div className="deepcode-session-model__menu-title">{t(language, 'agent.profile.selector')}</div>
            <div className="deepcode-session-model__model-list">
              {enabled.map((profile) => (
                <button key={profile.id} type="button" role="menuitemradio" aria-checked={selected?.id === profile.id}
                  disabled={busy} onClick={async () => { await onProfileChange(profile.id); closeMenu(); }}>
                  <span>{profile.name}</span><span className="deepcode-session-model__tick" aria-hidden="true">{selected?.id === profile.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
            <div className="deepcode-session-model__menu-divider" role="separator" />
            <button type="button" role="menuitem" disabled={busy || !selected || selected.thinking === 'disabled'}
              onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); setMenu('reasoning'); } }}
              onClick={() => setMenu('reasoning')}>
              <span>{t(language, 'settings.llm.reasoningEffort')}</span>
              <span className="deepcode-session-model__effort-value">{effortLabel}</span><span aria-hidden="true">›</span>
            </button>
          </> : <>
            <button type="button" role="menuitem" className="deepcode-session-model__menu-back" onClick={() => setMenu('models')}>
              <span aria-hidden="true">‹</span><span>{t(language, 'settings.llm.reasoningEffort')}</span>
            </button>
            {([null, 'low', 'medium', 'high', 'max'] as const).map((effort) => (
              <button key={effort ?? 'default'} type="button" role="menuitemradio" disabled={busy || !selected || selected.thinking === 'disabled'}
                aria-checked={reasoningEffortOverride === effort}
                onClick={async () => { await onReasoningEffortChange(effort); setMenu('models'); }}>
                <span>{effort ? t(language, `settings.llm.effort.${effort}`) : t(language, 'agent.profile.followDefault')}</span>
                <span className="deepcode-session-model__tick" aria-hidden="true">{reasoningEffortOverride === effort ? '✓' : ''}</span>
              </button>
            ))}
          </>}
        </div>
      )}
    </div>
  );
};

export default SessionModelSelector;
