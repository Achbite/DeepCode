import React, { useEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import type { AgentComposer } from './useAgentComposer';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { shouldSubmitComposerKey } from './composerKeyboard';

export function ComposerDecisionPanels({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const {
    pendingPlan,
    pendingScopeAddition,
    pendingInteraction,
    pendingApproval,
    submitting,
    submitPlanDecision,
    respondInteraction,
    respondPlan,
    respondApproval,
  } = composer;
  const decisionKey = pendingPlan ? `plan:${pendingPlan.planId}:${pendingPlan.revision}`
    : pendingInteraction ? `interaction:${pendingInteraction.interactionId}` : '';
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[decisionKey] ?? '';
  const setDraft = (text: string) => setDrafts((current) => ({ ...current, [decisionKey]: text }));
  const composing = useRef({ active: false, commitPending: false });
  const compositionFrame = useRef<number | null>(null);
  useEffect(() => () => { if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current); }, []);
  const beginComposition = () => { composing.current.active = true; };
  const endComposition = () => {
    composing.current = { active: false, commitPending: true };
    if (compositionFrame.current !== null) cancelAnimationFrame(compositionFrame.current);
    compositionFrame.current = requestAnimationFrame(() => { composing.current.commitPending = false; compositionFrame.current = null; });
  };
  const sendDecision = async (text: string) => {
    if (!text.trim() || submitting) return;
    const submitted = draft;
    try {
      if (pendingPlan) await respondPlan({ kind: 'requestRevision', text });
      else if (pendingInteraction) await respondInteraction(text);
      else return;
      setDrafts((current) => current[decisionKey] === submitted ? { ...current, [decisionKey]: '' } : current);
    } catch {
      // Keep this decision draft; the store reports the original command error.
    }
  };
  const submitOnComposerEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposerKey({ key: event.key, shiftKey: event.shiftKey, repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, composing.current)) return;
    event.preventDefault();
    void sendDecision(draft);
  };
  return (
    <>
      {(pendingPlan || pendingInteraction) && (
        <section className={`local-agent__interaction-panel${pendingPlan ? ' local-agent__interaction-panel--plan' : ''}`}
          onKeyDown={(event) => {
            if (pendingPlan && event.key === 'Escape' && !event.repeat && !event.nativeEvent.isComposing
              && !composing.current.active && !event.defaultPrevented) {
              event.preventDefault();
              void submitPlanDecision({ kind: 'cancel' });
            }
          }}>
          <div
            className="local-agent__interaction-document-scroll"
            tabIndex={0}
            role="region"
            aria-label={t(language, 'agent.interaction.details')}
          >
            <header className="local-agent__interaction-panel-heading">
              {pendingPlan
                ? <strong><MarkdownInline>{pendingScopeAddition
                  ? (language === 'zh-CN' ? '确认新增执行范围' : 'Confirm additional execution scope')
                  : t(language, 'agent.plan.confirmQuestion', { title: pendingPlan.title })}</MarkdownInline></strong>
                : <MarkdownContent>{pendingInteraction?.prompt ?? ''}</MarkdownContent>}
              {pendingPlan && (
                <button
                  type="button"
                  className="local-agent__interaction-close"
                  aria-label={t(language, 'agent.plan.ignoreAndStop')}
                  title={t(language, 'agent.plan.ignoreAndStop')}
                  disabled={submitting}
                  onClick={() => void submitPlanDecision({ kind: 'cancel' })}
                >×</button>
              )}
            </header>
            <ol className="local-agent__interaction-options">
              {pendingPlan ? (
                <li>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitPlanDecision({ kind: 'confirm' })}
                  >
                    <span className="local-agent__interaction-option-copy">
                      <b>{pendingScopeAddition
                        ? (language === 'zh-CN' ? '确认新增范围' : 'Confirm added scope')
                        : t(language, 'agent.plan.adopt')}</b>
                      <small>{pendingScopeAddition
                        ? (language === 'zh-CN' ? '继续当前阶段，保留已有进度' : 'Continue the current phases and preserve progress')
                        : t(language, 'agent.plan.adoptTodoHint')}</small>
                    </span>
                    <span className="local-agent__interaction-option-chevron" aria-hidden="true">
                      <DeepCodeShellIcon name="chevronRight" />
                    </span>
                  </button>
                </li>
              ) : pendingInteraction?.options?.map((option, index) => (
                <li key={option.id}>
                  <button
                    type="button"
                    disabled={submitting}
                    title={option.description ? `${option.label}\n\n${option.description}` : option.label}
                    onClick={() => {
                      void sendDecision(option.label);
                    }}
                  >
                    <span className="local-agent__interaction-option-marker" aria-hidden="true">
                      {index + 1}
                    </span>
                    <span className="local-agent__interaction-option-copy">
                      <b><MarkdownInline>{option.label}</MarkdownInline></b>
                      {option.description && (
                        <span className="local-agent__interaction-option-description">
                          <MarkdownInline>{option.description}</MarkdownInline>
                        </span>
                      )}
                    </span>
                    <span className="local-agent__interaction-option-chevron" aria-hidden="true">
                      <DeepCodeShellIcon name="chevronRight" />
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
          {(pendingPlan || pendingInteraction?.allowFreeform) && (
            <div className="local-agent__interaction-composer">
              <span className="local-agent__interaction-compose-mark" aria-hidden="true">
                <DeepCodeShellIcon name="compose" />
              </span>
              <textarea
                value={draft}
                rows={1}
                placeholder={pendingPlan
                  ? t(language, 'agent.composer.placeholder.plan')
                  : t(language, 'agent.composer.placeholder.interaction')}
                onChange={(event) => setDraft(event.target.value)}
                onCompositionStart={beginComposition}
                onCompositionEnd={endComposition}
                onKeyDown={submitOnComposerEnter}
              />
              <button type="button" disabled={submitting || !draft.trim()} onClick={() => void sendDecision(draft)}>
                {pendingPlan ? (language === 'zh-CN' ? '提交修改意见' : 'Request changes') : (language === 'zh-CN' ? '回答' : 'Answer')}
              </button>
              {pendingPlan ? (
                <button
                  type="button"
                  className="local-agent__interaction-secondary"
                  disabled={submitting}
                  onClick={() => void submitPlanDecision({ kind: 'cancel' })}
                >
                  <span>{t(language, 'agent.plan.ignoreAndStop')}</span>
                  <kbd>Esc</kbd>
                </button>
              ) : (
                <button
                  type="button"
                  className="local-agent__interaction-secondary"
                  disabled={submitting}
                  onClick={() => {
                    void sendDecision(t(language, 'agent.interaction.skip'));
                  }}
                >{t(language, 'agent.interaction.skip')}</button>
              )}
            </div>
          )}
        </section>
      )}
      {pendingApproval && (
        <section
          className="local-agent__decision"
          aria-labelledby={`approval-${pendingApproval.approvalId}`}
        >
          <header className="local-agent__decision-heading">
            <span className="local-agent__decision-mark" aria-hidden="true">
              <DeepCodeShellIcon name="tool" />
            </span>
            <span className="local-agent__decision-title">
              <strong id={`approval-${pendingApproval.approvalId}`}>
                {t(language, 'agent.approval.question')}
              </strong>
              <small>{t(language, 'agent.approval.required')}</small>
            </span>
          </header>
          <pre className="local-agent__decision-command">
            <code>{pendingApproval.preview.summary}</code>
          </pre>
          {(pendingApproval.preview.effects.length > 0
            || pendingApproval.preview.logicalTargets.length > 0) && (
            <details className="local-agent__decision-scope">
              <summary>
                <span>{t(language, 'agent.approval.scope')}</span>
                <DeepCodeShellIcon name="chevronDown" />
              </summary>
              <dl>
                {pendingApproval.preview.effects.length > 0 && (
                  <div>
                    <dt>{t(language, 'agent.approval.effects')}</dt>
                    <dd>{pendingApproval.preview.effects.map((effect) => (
                      <code key={effect}>{effect}</code>
                    ))}</dd>
                  </div>
                )}
                {pendingApproval.preview.logicalTargets.length > 0 && (
                  <div>
                    <dt>{t(language, 'agent.approval.targets')}</dt>
                    <dd>{pendingApproval.preview.logicalTargets.map((target) => (
                      <code key={target}>{target}</code>
                    ))}</dd>
                  </div>
                )}
              </dl>
            </details>
          )}
          <div className="local-agent__decision-actions">
            <button
              type="button"
              disabled={submitting}
              onClick={() => void respondApproval('deny')}
            >{t(language, 'agent.approval.deny')}</button>
            <button
              type="button"
              className="local-agent__button--primary"
              disabled={submitting}
              onClick={() => void respondApproval('allow')}
            >{t(language, 'agent.approval.allow')}</button>
          </div>
        </section>
      )}
    </>
  );
}
