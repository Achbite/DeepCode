import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import type { AgentComposer } from './useAgentComposer';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';

export function ComposerDecisionPanels({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const {
    pendingPlan,
    pendingScopeAddition,
    pendingInteraction,
    pendingApproval,
    submitting,
    submitPlanDecision,
    respondInteraction,
    respondApproval,
  } = composer;
  const sendDecision = async (text: string) => {
    if (!pendingInteraction || !text.trim() || submitting) return;
    try {
      await respondInteraction(text);
    } catch {
      // The store reports the original command error; the shared draft is retained.
    }
  };
  return (
    <>
      {(pendingPlan || pendingInteraction) && (
        <section className={`local-agent__interaction-panel${pendingPlan ? ' local-agent__interaction-panel--plan' : ''}`}>
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
