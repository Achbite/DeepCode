import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContextCompositionCategoryKind,
  ContextCompositionProjection,
  ContextUsageProjection,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface SessionModelSelectorProps {
  language: UiLanguage;
  profiles: readonly LlmProviderProfile[];
  selectedProfileId: string | null;
  contextUsage: ContextUsageProjection | null;
  contextCompositions: readonly ContextCompositionProjection[];
  busy?: boolean;
  readOnly?: boolean;
  onProfileChange: (profileId: string) => void | Promise<void>;
}

const SessionModelSelector: React.FC<SessionModelSelectorProps> = ({
  language,
  profiles,
  selectedProfileId,
  contextUsage,
  contextCompositions,
  busy = false,
  readOnly = false,
  onProfileChange,
}) => {
  const [contextOpen, setContextOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const enabled = useMemo(
    () => profiles.filter((profile) => profile.enabled),
    [profiles],
  );
  const selected = enabled.find((profile) => profile.id === selectedProfileId);
  const disabled = busy || enabled.length === 0;
  const title = selected?.name ?? t(language, 'agent.profile.selectionRequired');
  const contextPercent = contextUsage
    ? Math.min(100, Math.round(
      ((contextUsage.inputTokens + contextUsage.outputTokens) / contextUsage.contextWindowTokens)
        * 100,
    ))
    : null;
  const contextLabel = contextPercent === null ? 'N/A' : `${contextPercent}%`;
  const contextTitle = contextUsage
    ? `${contextUsage.inputTokens + contextUsage.outputTokens} / ${contextUsage.contextWindowTokens} tokens`
    : (language === 'zh-CN' ? '上下文用量尚不可用' : 'Context usage unavailable');
  const contextReceipt = useMemo(() => {
    if (contextUsage) {
      for (let index = contextCompositions.length - 1; index >= 0; index -= 1) {
        if (contextCompositions[index].providerRequestId === contextUsage.providerRequestId) {
          return contextCompositions[index];
        }
      }
      return null;
    }
    return contextCompositions.at(-1) ?? null;
  }, [contextCompositions, contextUsage]);

  useEffect(() => {
    if (!contextOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) setContextOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [contextOpen]);

  useEffect(() => {
    if (!contextReceipt) setContextOpen(false);
  }, [contextReceipt]);

  return (
    <div ref={rootRef} className="deepcode-session-model">
      <button
        type="button"
        className={`deepcode-session-model__context${contextPercent === null ? ' deepcode-session-model__context--unknown' : ''}`}
        style={{ '--deepcode-context-percent': `${contextPercent ?? 0}%` } as React.CSSProperties}
        aria-label={contextLabel}
        aria-expanded={contextOpen}
        disabled={!contextReceipt}
        title={contextTitle}
        onClick={() => setContextOpen((open) => !open)}
      >
        <span>{contextLabel}</span>
      </button>
      {contextOpen && contextReceipt && (
        <section
          className="deepcode-session-model__context-popover"
          role="dialog"
          aria-label={language === 'zh-CN' ? '上下文构成' : 'Context composition'}
        >
          <header>
            <strong>{language === 'zh-CN' ? '上下文构成' : 'Context composition'}</strong>
            <span>
              {contextReceipt.responseConstraint === 'answerOnly'
                ? (language === 'zh-CN' ? '仅回答续轮' : 'Answer-only continuation')
                : (language === 'zh-CN' ? '普通续轮' : 'Normal continuation')}
            </span>
          </header>
          <div className="deepcode-session-model__context-groups">
            {contextReceipt.categories.map((category) => (
              <div className="deepcode-session-model__context-group" key={category.kind}>
                <div>
                  <strong>{contextCategoryLabel(category.kind, language)}</strong>
                  <span>{category.itemCount}</span>
                </div>
                {category.items.length > 0 && (
                  <ul>
                    {category.items.map((item) => <li key={item.itemId}>{item.label}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
      {readOnly ? (
        <span className="deepcode-session-model__history-label">
          {language === 'zh-CN' ? '旧版只读历史' : 'Legacy read-only history'}
        </span>
      ) : (
        <label className="deepcode-session-model__selector" title={title}>
          <span className="deepcode-session-model__label">
            {t(language, 'agent.profile.selector')}
          </span>
          <select
            value={selected?.id ?? ''}
            disabled={disabled}
            aria-label={t(language, 'agent.profile.selector')}
            onChange={(event) => {
              if (event.target.value) void onProfileChange(event.target.value);
            }}
          >
            {!selected && (
              <option value="">
                {enabled.length === 0
                  ? t(language, 'agent.profile.unavailable')
                  : t(language, 'agent.profile.selectionRequired')}
              </option>
            )}
            {enabled.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} · {profile.model}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
};

function contextCategoryLabel(
  kind: ContextCompositionCategoryKind,
  language: UiLanguage,
): string {
  const labels: Record<ContextCompositionCategoryKind, readonly [string, string]> = {
    instructions: ['系统与会话指令', 'System and session instructions'],
    workspaceBindings: ['目录索引', 'Directory indexes'],
    sessionControls: ['Session 控制接口', 'Session controls'],
    journalMessages: ['对话消息', 'Conversation messages'],
    contextProviders: ['上下文插件', 'Context plugins'],
    messageAttachments: ['消息附件', 'Message attachments'],
    tools: ['工具目录', 'Tool catalog'],
  };
  return labels[kind][language === 'zh-CN' ? 0 : 1];
}

export default SessionModelSelector;
