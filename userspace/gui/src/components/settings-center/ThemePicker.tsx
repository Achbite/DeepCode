import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import UiIcon from '../../icons/registry';
import type { GuiAccentColor, GuiResolvedTheme } from '../../theme/deepcodeGuiTheme';
import { paletteColor, type PaletteOverrides } from '../../theme/palette';
import { nextEnabledIndex } from '../shared/keyboardNavigation';

export interface ThemeChoice { id: string; name: string; colors: PaletteOverrides }
export function ThemeBadge({ colors, mode, accent }: { colors: PaletteOverrides; mode: GuiResolvedTheme; accent: GuiAccentColor }) {
  return <span className="theme-picker__badge" aria-hidden="true" style={{
    background: paletteColor(colors, mode, 'background', accent),
    color: paletteColor(colors, mode, 'accent', accent),
    borderColor: paletteColor(colors, mode, 'border-strong', accent),
  }}>Aa</span>;
}

export default function ThemePicker({ label, choices, selected, mode, accent, disabled, onSelect }: {
  label: string; choices: ThemeChoice[]; selected: string; mode: GuiResolvedTheme; accent: GuiAccentColor;
  disabled: boolean; onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocus = useRef(false);
  const id = useId();
  const current = choices.find((choice) => choice.id === selected)!;
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const popup = menu.current;
    const anchor = trigger.current.getBoundingClientRect();
    // The top layer escapes card overflow and settings scroll-container clipping.
    popup.showPopover();
    const margin = 8;
    const gap = 5;
    const width = Math.min(300, anchor.width, window.innerWidth - margin * 2);
    popup.style.width = `${width}px`;
    const height = Math.min(320, popup.scrollHeight + 2);
    const below = Math.max(0, window.innerHeight - anchor.bottom - gap - margin);
    const above = Math.max(0, anchor.top - gap - margin);
    const opensAbove = below < height && above > below;
    const maxHeight = Math.min(320, opensAbove ? above : below);
    popup.style.maxHeight = `${maxHeight}px`;
    popup.style.left = `${Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin))}px`;
    popup.style.top = `${opensAbove ? anchor.top - gap - Math.min(height, maxHeight) : anchor.bottom + gap}px`;
    const dismissOnLayoutChange = (event: Event) => {
      // Scrolling the option list itself keeps it open; moving its anchor dismisses it.
      if (event.target instanceof Node && popup.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener('resize', dismissOnLayoutChange);
    window.addEventListener('scroll', dismissOnLayoutChange, true);
    return () => {
      if (popup.matches(':popover-open')) popup.hidePopover();
      window.removeEventListener('resize', dismissOnLayoutChange);
      window.removeEventListener('scroll', dismissOnLayoutChange, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    options.current[choices.findIndex((choice) => choice.id === selected)]?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => {
    if (!open && !disabled && restoreFocus.current) {
      restoreFocus.current = false;
      if (document.activeElement === document.body || root.current?.contains(document.activeElement)) trigger.current?.focus();
    }
  }, [open, disabled]);
  const close = () => { restoreFocus.current = true; setOpen(false); trigger.current?.focus(); };
  return <div className="theme-picker" ref={root} onBlur={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
  }} onKeyDown={(event) => {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  }}>
    <span id={`${id}-label`}>{label}</span>
    <button type="button" className="theme-picker__trigger" ref={trigger} disabled={disabled}
      aria-labelledby={`${id}-label ${id}-value`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpen((value) => !value)} onKeyDown={(event) => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>
      <ThemeBadge colors={current.colors} mode={mode} accent={accent} /><span id={`${id}-value`}>{current.name}</span><UiIcon name="chevronDown" size={14} />
    </button>
    {open && <div ref={menu} popover="manual" className="theme-picker__menu" id={id} role="listbox" aria-labelledby={`${id}-label`} data-native-overlay
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index = nextEnabledIndex(choices.map(() => true), options.current.indexOf(document.activeElement as HTMLButtonElement), event.key);
        options.current[index]?.focus();
      }}>
      {choices.map((choice, index) => <button key={choice.id} type="button" role="option" aria-selected={selected === choice.id}
        tabIndex={-1} ref={(element) => { options.current[index] = element; }} onClick={() => { onSelect(choice.id); close(); }}>
        <ThemeBadge colors={choice.colors} mode={mode} accent={accent} /><span>{choice.name}</span>
        {selected === choice.id && <UiIcon name="check" size={16} />}
      </button>)}
    </div>}
  </div>;
}
