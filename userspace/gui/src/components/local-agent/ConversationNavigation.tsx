import React, { useEffect, useState } from 'react';
import type { ConversationNavigationEntry } from './conversationWindow';
import type { ConversationViewport } from './useConversationViewport';
import type { UiLanguage } from '../../i18n';

export function ConversationNavigation({ entries, viewport, onNavigate, language }: {
  entries: ConversationNavigationEntry[];
  viewport: ConversationViewport;
  onNavigate(entry: ConversationNavigationEntry): void;
  language: UiLanguage;
}) {
  const [active, setActive] = useState<string>();
  const [preview, setPreview] = useState<ConversationNavigationEntry | null>(null);
  useEffect(() => {
    const body = viewport.bodyRef.current;
    if (!body) return;
    let frame: number | null = null;
    const keys = new Set(entries.map((entry) => entry.key));
    const update = () => {
      frame = null;
      const top = body.getBoundingClientRect().top + 40;
      let selected: string | undefined = entries[0]?.key;
      for (const node of body.querySelectorAll<HTMLElement>('[data-conversation-anchor]')) {
        if (!keys.has(node.dataset.conversationAnchor!)) continue;
        if (node.getBoundingClientRect().top > top && selected) break;
        selected = node.dataset.conversationAnchor;
      }
      setActive(selected);
    };
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    schedule();
    body.addEventListener('scroll', schedule, { passive: true });
    return () => {
      body.removeEventListener('scroll', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [entries, viewport.bodyRef]);
  if (entries.length < 2) return null;
  const zh = language === 'zh-CN';
  return <nav className="conversation-navigation" aria-label={zh ? '对话导航' : 'Conversation navigation'}>
    <div className="conversation-navigation__ticks">
      {entries.map((entry, index) => <button
        type="button" key={entry.key}
        aria-current={active === entry.key ? 'location' : undefined}
        aria-label={`${zh ? '跳至消息' : 'Go to message'} ${index + 1}: ${entry.label}`}
        onMouseEnter={() => setPreview(entry)} onMouseLeave={() => setPreview(null)}
        onFocus={() => setPreview(entry)} onBlur={() => setPreview(null)}
        onClick={() => onNavigate(entry)}
      ><span /></button>)}
    </div>
    {preview && <div className="conversation-navigation__preview" role="tooltip">{preview.label}</div>}
  </nav>;
}
