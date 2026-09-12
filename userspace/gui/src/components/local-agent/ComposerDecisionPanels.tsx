import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import type { AgentComposer } from './useAgentComposer';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';

export function ComposerDecisionPanels({ language, composer }: { language: UiLanguage; composer: AgentComposer }) {
  const {
    pendingPlan,
    pendingInteraction,
    pendingApproval,
    submitting,
    submitPlanDecision,
    setDraft,
    respondInteraction,
    textareaRef,
    draft,
    recordComposerElementState,
    beginComposition,
    endComposition,
    submitOnComposerEnter,
    respondApproval,
  } = composer;
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
              ? <strong><MarkdownInline>{t(language, 'agent.plan.confirmQuestion', { title: pendingPlan.title })}</MarkdownInline></strong>
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
          </div>
          <ol className="local-agent__interaction-options">
            {pendingPlan ? (
              <li>
                <button
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitPlanDecision({ kind: 'confirm' })}
                >
                  <span className="local-agent__interaction-option-copy">
                    <b>{t(language, 'agent.plan.adopt')}</b>
                    <small>{t(language, 'agent.plan.adoptTodoHint')}</small>
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
                  onClick={() => {
                    setDraft('');
                    void respondInteraction(option.label).catch(() => undefined);
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
          {(pendingPlan || pendingInteraction?.allowFreeform) && (
            <div className="local-agent__interaction-composer">
              <span className="local-agent__interaction-compose-mark" aria-hidden="true">
                <DeepCodeShellIcon name="compose" />
              </span>
              <textarea
                ref={textareaRef}
                value={draft}
                rows={1}
                placeholder={pendingPlan
                  ? t(language, 'agent.composer.placeholder.plan')
                  : t(language, 'agent.composer.placeholder.interaction')}
                onChange={(event) => setDraft(event.target.value)}
                onFocus={(event) => recordComposerElementState(event.currentTarget, true)}
                onBlur={(event) => recordComposerElementState(event.currentTarget, false)}
                onSelect={(event) => recordComposerElementState(
                  event.currentTarget,
                  document.activeElement === event.currentTarget,
                )}
                onCompositionStart={beginComposition}
                onCompositionEnd={endComposition}
                onKeyDown={submitOnComposerEnter}
              />
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
                    setDraft('');
                    void respondInteraction(t(language, 'agent.interaction.skip')).catch(() => undefined);
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
