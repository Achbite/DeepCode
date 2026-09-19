import UiIcon from '../../icons/registry';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ContextCompositionProjection, ContextUsageProjection, LlmProviderProfile, ModelConnection, LlmReasoningEffort } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { ContextUsageControl } from './ContextUsageControl';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  connections?: readonly ModelConnection[];
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  onProfileChange: (profileId: string) => void | Promise<void>;
  onReasoningEffortChange: (effort: LlmReasoningEffort) => void | Promise<void>;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  profiles,
  connections = [],
  selectedProfileId,
  reasoningEffortOverride,
  contextUsage,
  contextCompositions,
  busy = false,
  onProfileChange,
  onReasoningEffortChange,
}) => {
  const [menu, setMenu] = useState<'connections' | 'models' | 'reasoning' | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const [contextOpen, setContextOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const enabled = useMemo(
    () => profiles.filter((profile) => profile.enabled),
    [profiles],
  );
  const selected = profiles.find((profile) => profile.id === selectedProfileId);
  const disabled = busy || enabled.length === 0;
  const unavailable = Boolean(selectedProfileId) && !selected?.enabled;
  const title = (selected?.name ?? selectedProfileId ?? t(language, 'agent.profile.selectionRequired'))
    + (unavailable ? ` · ${t(language, selected ? 'agent.profile.disabled' : 'agent.profile.missing')}` : '');
  const effectiveEffort = reasoningEffortOverride ?? selected?.reasoningEffort;
  const selectorEffortLabel = selected?.enabled && selected.thinking !== 'disabled' && effectiveEffort
    ? t(language, `settings.llm.effort.${effectiveEffort}`)
    : null;
  const effortLabel = selected?.thinking === 'disabled'
    ? t(language, 'agent.profile.thinkingDisabled')
    : selectorEffortLabel ?? (language === 'zh-CN' ? '选择强度' : 'Choose level');
  const selectionLabel = selectorEffortLabel ? `${title} · ${selectorEffortLabel}` : title;
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
      else if (menu === 'models') setMenu('connections');
      else closeMenu();
      return;
    }
    if (event.key === 'ArrowLeft' && menu === 'models') { event.preventDefault(); setMenu('connections'); return; }
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
        title={selectionLabel} disabled={disabled} aria-label={`${t(language, 'agent.profile.selector')}：${selectionLabel}`}
        aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? menuId : undefined}
        onClick={() => { setContextOpen(false); setConnectionId(selected?.connectionId ?? null); setMenu((current) => current ? null : 'connections'); }}>
        <span>{title}</span>
        {selectorEffortLabel && <span className="deepcode-session-model__selector-effort">{selectorEffortLabel}</span>}
        <UiIcon name="chevronDown" size={14} />
      </button>
      {menu && (
        <div ref={menuRef} id={menuId} role="menu" className="deepcode-session-model__menu"
          aria-label={menu === 'connections' ? (language === 'zh-CN' ? '选择连接' : 'Choose connection') : t(language, menu === 'models' ? 'agent.profile.selector' : 'settings.llm.reasoningEffort')}
          onKeyDown={menuKeyDown}>
          {menu === 'connections' ? <>
            <div className="deepcode-session-model__menu-title">{language === 'zh-CN' ? '选择连接' : 'Choose connection'}</div>
            {connections.map(connection => <button key={connection.id} type="button" role="menuitem" disabled={!enabled.some(p => p.connectionId === connection.id)} onClick={() => { setConnectionId(connection.id); setMenu('models'); }}>
              <span>{connection.name}</span><span className="deepcode-session-model__effort-value">{connection.billingMode === 'subscription' ? 'Coding Plan' : 'API'}</span><span aria-hidden="true">›</span>
            </button>)}
          </> : menu === 'models' ? <>
            <button type="button" role="menuitem" className="deepcode-session-model__menu-back" onClick={() => setMenu('connections')}>‹ {connections.find(c => c.id === connectionId)?.name}</button>
            <div className="deepcode-session-model__menu-title">{t(language, 'agent.profile.selector')}</div>
            <div className="deepcode-session-model__model-list">
              {unavailable && <button type="button" role="menuitemradio" aria-checked="true" disabled><span>{title}</span></button>}
              {enabled.filter(profile => profile.connectionId === connectionId).map((profile) => (
                <button key={profile.id} type="button" role="menuitemradio" aria-checked={selected?.id === profile.id}
                  disabled={busy} onClick={async () => { await onProfileChange(profile.id); closeMenu(); }}>
                  <span>{profile.name}</span><span className="deepcode-session-model__tick" aria-hidden="true">{selected?.id === profile.id ? <DeepCodeShellIcon name="check" size={14} /> : null}</span>
                </button>
              ))}
            </div>
            <div className="deepcode-session-model__menu-divider" role="separator" />
            <button type="button" role="menuitem" disabled={busy || !selected?.enabled || selected.thinking === 'disabled'}
              onKeyDown={(event) => { if (event.key === 'ArrowRight') { event.preventDefault(); setMenu('reasoning'); } }}
              onClick={() => setMenu('reasoning')}>
              <span>{t(language, 'settings.llm.reasoningEffort')}</span>
              <span className="deepcode-session-model__effort-value">{effortLabel}</span><span aria-hidden="true">›</span>
            </button>
          </> : <>
            <button type="button" role="menuitem" className="deepcode-session-model__menu-back" onClick={() => setMenu('models')}>
              <span aria-hidden="true">‹</span><span>{t(language, 'settings.llm.reasoningEffort')}</span>
            </button>
            {(['low', 'medium', 'high', 'max'] as const).map((effort) => (
              <button key={effort} type="button" role="menuitemradio" disabled={busy || !selected?.enabled || selected.thinking === 'disabled'}
                aria-checked={effectiveEffort === effort}
                onClick={async () => { await onReasoningEffortChange(effort); setMenu('models'); }}>
                <span>{t(language, `settings.llm.effort.${effort}`)}</span>
                <span className="deepcode-session-model__tick" aria-hidden="true">{effectiveEffort === effort ? <DeepCodeShellIcon name="check" size={14} /> : null}</span>
              </button>
            ))}
          </>}
        </div>
      )}
    </div>
  );
};

export default SessionModelSelector;
