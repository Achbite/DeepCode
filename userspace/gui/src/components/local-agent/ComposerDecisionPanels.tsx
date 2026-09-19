import React, { useLayoutEffect, useRef } from 'react';
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
  const approvalRef = useRef<HTMLElement>(null);
  const sessionBrowser = pendingApproval?.preview.authorizationScope === 'sessionBrowser';
  const runHostShell = pendingApproval?.preview.authorizationScope === 'runHostShell';
  const confirmation = pendingInteraction?.kind === 'confirmation';
  useLayoutEffect(() => {
    if (pendingApproval && document.activeElement === document.body) approvalRef.current?.focus({ preventScroll: true });
  }, [pendingApproval?.approvalId]);
  const answerApproval = async (decision: 'allow' | 'deny', scope?: 'runHostShell') => {
    if (!pendingApproval || submitting) return;
    try { await respondApproval(decision, scope); } catch { /* The store retains the original error. */ }
  };
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
              <span className="local-agent__interaction-caption">
                <DeepCodeShellIcon name={pendingPlan ? 'artifact' : 'question'} size={17} />
                {pendingPlan
                  ? (language === 'zh-CN' ? (pendingScopeAddition ? '新增执行范围' : '方案确认') : 'Review plan')
                  : (language === 'zh-CN' ? (confirmation ? '确认' : '问题') : (confirmation ? 'Confirmation' : 'Question'))}
              </span>
              {(pendingPlan || pendingInteraction?.allowFreeform) && <button
                type="button"
                className="local-agent__interaction-close"
                aria-label={language === 'zh-CN' ? (pendingPlan ? '关闭方案确认' : confirmation ? '关闭确认' : '关闭问题') : (pendingPlan ? 'Close plan review' : confirmation ? 'Close confirmation' : 'Close question')}
                title={t(language, pendingPlan ? 'agent.plan.ignoreAndStop' : 'agent.interaction.skip')}
                disabled={submitting}
                onClick={() => pendingPlan
                  ? void submitPlanDecision({ kind: 'cancel' })
                  : void sendDecision(t(language, 'agent.interaction.skip'))}
              ><DeepCodeShellIcon name="close" size={15} /></button>}
            </header>
            <div className="local-agent__interaction-prompt">
              {pendingPlan
                ? <MarkdownInline>{pendingPlan.title}</MarkdownInline>
                : <MarkdownContent decisionProse>{pendingInteraction?.prompt ?? ''}</MarkdownContent>}
            </div>
            <ol className="local-agent__interaction-options">
              {pendingPlan ? <li>
                <button type="button" disabled={submitting}
                  title={pendingScopeAddition ? (language === 'zh-CN' ? '继续当前阶段，保留已有进度' : 'Continue the current phases and preserve progress') : undefined}
                  onClick={() => void submitPlanDecision({ kind: 'confirm' })}>
                  <span className="local-agent__interaction-option-marker" aria-hidden="true">1</span>
                  <span className="local-agent__interaction-option-copy"><b>{language === 'zh-CN'
                    ? (pendingScopeAddition ? '确认新增范围' : '确认执行')
                    : (pendingScopeAddition ? 'Confirm added scope' : 'Confirm plan')}</b></span>
                </button>
              </li> : pendingInteraction?.options?.map((option, index) => (
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
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </section>
      )}
      {pendingApproval && (
        <section
          ref={approvalRef}
          tabIndex={-1}
          className="local-agent__decision"
          aria-labelledby={`approval-${pendingApproval.approvalId}`}
          onKeyDown={(event) => {
            if (event.repeat || event.nativeEvent.isComposing || event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
            if (event.key === 'Escape' || (event.key === 'Enter' && event.target === approvalRef.current)) {
              event.preventDefault();
              event.stopPropagation();
              void answerApproval(event.key === 'Escape' ? 'deny' : 'allow');
            }
          }}
        >
          <header className="local-agent__decision-heading">
            <span className="local-agent__decision-mark" aria-hidden="true">
              <DeepCodeShellIcon name={sessionBrowser ? 'browser' : 'shield'} />
            </span>
            <span>{sessionBrowser ? (language === 'zh-CN' ? '内置浏览器' : 'Browser') : (language === 'zh-CN' ? '工具权限' : 'Tool permission')}</span>
          </header>
          <strong className="local-agent__decision-title" id={`approval-${pendingApproval.approvalId}`}>
                {sessionBrowser
                  ? (language === 'zh-CN' ? '允许当前对话使用内置浏览器？' : 'Allow browser use in this conversation?')
                  : t(language, 'agent.approval.question')}
          </strong>
          {!sessionBrowser && <pre className="local-agent__decision-command">
            <code>{pendingApproval.preview.summary}</code>
          </pre>}
          <div className="local-agent__decision-controls">
          {(sessionBrowser || pendingApproval.preview.effects.length > 0
            || pendingApproval.preview.logicalTargets.length > 0) ? (
            <details className="local-agent__decision-scope">
              <summary>
                <span>{t(language, 'agent.approval.scope')}</span>
                <DeepCodeShellIcon name="chevronDown" />
              </summary>
              {sessionBrowser && <pre className="local-agent__decision-command"><code>{pendingApproval.preview.summary}</code></pre>}
              {runHostShell && <p>{language === 'zh-CN'
                ? '以宿主用户权限执行命令。本轮授权限于相同工作目录绑定和执行环境，在本轮结束、失败或取消后失效。'
                : 'Commands run with host-user privileges. This grant applies to the same workspace binding and environment until this run ends, fails or is cancelled.'}</p>}
              <dl>
                {runHostShell && typeof pendingApproval.preview.authorizationContext?.workspaceRoot === 'string' && <div>
                  <dt>{language === 'zh-CN' ? '工作目录' : 'Workspace'}</dt>
                  <dd><code>{pendingApproval.preview.authorizationContext.workspaceRoot}</code></dd>
                </div>}
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
          ) : <span />}
          <div className={`local-agent__decision-actions${runHostShell ? ' local-agent__decision-actions--run' : ''}`}>
            {runHostShell && <button type="button" className="local-agent__decision-run" disabled={submitting}
              title={language === 'zh-CN' ? '本轮内相同工作目录和执行环境的宿主 Shell' : 'Host shell in this workspace and environment for this run'}
              onClick={() => void answerApproval('allow', 'runHostShell')}
            >{language === 'zh-CN' ? '允许本轮' : 'Allow this run'}</button>}
            <button
              type="button"
              aria-label={t(language, 'agent.approval.deny')}
              aria-keyshortcuts="Escape"
              disabled={submitting}
              onClick={() => void answerApproval('deny')}
            ><span>{t(language, 'agent.approval.deny')}</span><kbd aria-hidden="true">Esc</kbd></button>
            <button
              type="button"
              className="local-agent__decision-allow"
              aria-label={sessionBrowser ? (language === 'zh-CN' ? '允许此对话' : 'Allow this conversation') : (language === 'zh-CN' ? '允许一次' : 'Allow once')}
              aria-keyshortcuts="Enter"
              disabled={submitting}
              onClick={() => void answerApproval('allow')}
            ><span>{sessionBrowser ? (language === 'zh-CN' ? '允许此对话' : 'Allow this conversation') : (language === 'zh-CN' ? '允许一次' : 'Allow once')}</span><kbd aria-hidden="true">↵</kbd></button>
          </div>
          </div>
        </section>
      )}
    </>
  );
}
