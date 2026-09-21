import { decodeShellCommandRules, isShellAuthorizationScope, sessionAuthorizationScope, type ShellAuthorizationScope } from '@deepcode/protocol';
import { useSettingsStore } from '../../state/settingsStore';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useLayoutEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import type { AgentComposer } from './useAgentComposer';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { planOperationDetail } from './planReview';

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
  const proposedScope = pendingApproval?.preview.authorizationScope;
  const offeredScopes = pendingApproval?.preview.authorizationScopes ?? [];
  const approvalScope = isShellAuthorizationScope(proposedScope) && offeredScopes.includes(proposedScope) ? proposedScope : undefined;
  const sessionScope = approvalScope && sessionAuthorizationScope(approvalScope);
  const approvalRef = useRef<HTMLElement>(null);
  const sessionBrowser = pendingApproval?.preview.authorizationScope === 'sessionBrowser';
  const runHostShell = pendingApproval?.preview.authorizationScopes?.includes('runHostShell');
  const runCommand = pendingApproval?.preview.authorizationScopes?.includes('runCommand');
  const projection = useLocalAgentStore(state => state.projection);
  const setPermissions = useLocalAgentStore(state => state.setPermissions);
  const savedRules = useSettingsStore(state => state.effectiveSettings['agent.permissions.commandRules']);
  const patchSetting = useSettingsStore(state => state.patchUserSetting);
  const [ruleDecision, setRuleDecision] = useState<'allow' | 'ask' | 'deny'>('allow');
  const [ruleSaved, setRuleSaved] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const reviewing = pendingApproval?.preview.approvalReviewer === 'agent' && projection?.run?.status === 'running';
  useLayoutEffect(() => { setRuleSaved(false); setRuleError(null); }, [pendingApproval?.approvalId]);
  const saveRule = async () => {
    if (!pendingApproval?.preview.authorizationContext) return;
    try {
      const rules = decodeShellCommandRules(savedRules);
      const context = pendingApproval.preview.authorizationContext;
      const next = JSON.stringify([...rules.filter(rule => JSON.stringify(rule.context) !== JSON.stringify(context)), { decision: ruleDecision, context }]);
      const saved = await patchSetting('agent.permissions.commandRules', next);
      if (!saved) throw new Error(useSettingsStore.getState().errorMessage ?? 'Could not save command rule');
      await setPermissions({ 'agent.permissions.commandRules': next });
      setRuleSaved(true);
    } catch (error) { setRuleError(error instanceof Error ? error.message : String(error)); }
  };
  const confirmation = pendingInteraction?.kind === 'confirmation';
  useLayoutEffect(() => {
    if (pendingApproval && document.activeElement === document.body) approvalRef.current?.focus({ preventScroll: true });
  }, [pendingApproval?.approvalId]);
  const answerApproval = async (decision: 'allow' | 'deny', scope?: ShellAuthorizationScope) => {
    if (!pendingApproval || submitting || reviewing) return;
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
                  ? (language === 'zh-CN' ? (pendingScopeAddition ? '计划范围调整' : '方案确认') : 'Review plan')
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
                ? pendingScopeAddition ? <>
                  <MarkdownContent decisionProse>{pendingScopeAddition.reason}</MarkdownContent>
                  <ul>{pendingScopeAddition.operations.map((operation, index) => <li key={index}>
                    <code>{(projection?.workspaceBindings.length ?? 0) > 1 ? `${projection?.workspaceBindings.find(binding => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}{planOperationDetail(operation, language)}</code>
                  </li>)}</ul>
                </> : <MarkdownInline>{pendingPlan.title}</MarkdownInline>
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
              void answerApproval(event.key === 'Escape' ? 'deny' : 'allow', event.key === 'Enter' ? approvalScope : undefined);
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
          {pendingApproval.preview.review && <p>{pendingApproval.preview.review.reason}</p>}
          {pendingApproval.preview.fileAccess && <dl className="local-agent__file-access">
            {(['read', 'write'] as const).map(access => pendingApproval.preview.fileAccess![access].length > 0 && <div key={access}>
              <dt>{t(language, `agent.permission.file.${access}`)}</dt>
              <dd>{pendingApproval.preview.fileAccess![access].map(path => <code key={path} title={path}>{path}</code>)}</dd>
            </div>)}
          </dl>}
          {reviewing && <p role="status">{t(language, 'agent.permission.reviewing')} <button type="button"
            onClick={() => void setPermissions({ 'agent.permissions.shell': 'ask' }).catch(() => {})}>{t(language, 'agent.permission.takeOver')}</button></p>}
          <div className="local-agent__decision-controls">
          {(sessionBrowser || pendingApproval.preview.effects.length > 0
            || pendingApproval.preview.logicalTargets.length > 0) ? (
            <details className="local-agent__decision-scope">
              <summary>
                <span>{t(language, 'agent.approval.scope')}</span>
                <DeepCodeShellIcon name="chevronDown" />
              </summary>
              {sessionBrowser && <pre className="local-agent__decision-command"><code>{pendingApproval.preview.summary}</code></pre>}
              {runCommand && <p>{t(language, 'agent.permission.grantHelp')}</p>}
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
              {runCommand && <div className="local-agent__permission-save-rule">
                <select aria-label={t(language, 'settings.commandRules.title')} value={ruleDecision} onChange={event => setRuleDecision(event.target.value as 'allow' | 'ask' | 'deny')}>
                  {(['allow', 'ask', 'deny'] as const).map(mode => <option key={mode} value={mode}>{t(language, `agent.permission.${mode}`)}</option>)}
                </select>
                <button type="button" disabled={submitting || reviewing || ruleSaved} onClick={() => void saveRule()}>{t(language, ruleSaved ? 'agent.permission.ruleSaved' : 'agent.permission.saveRule')}</button>
                {ruleError && <p role="alert">{ruleError}</p>}
              </div>}

            </details>
          ) : <span />}
          <div className="local-agent__decision-actions">
            {sessionScope && offeredScopes.includes(sessionScope) && <button
              type="button"
              className="local-agent__decision-session"
              title={t(language, `agent.permission.scope.${sessionScope}`)}
              disabled={submitting || reviewing}
              onClick={() => void answerApproval('allow', sessionScope)}
            >{t(language, 'agent.approval.allowSession')}</button>}
            <button
              type="button"
              aria-label={t(language, 'agent.approval.deny')}
              aria-keyshortcuts="Escape"
              disabled={submitting || reviewing}
              onClick={() => void answerApproval('deny')}
            ><span>{t(language, 'agent.approval.deny')}</span><kbd aria-hidden="true">Esc</kbd></button>
            <button
              type="button"
              className="local-agent__decision-allow"
              aria-label={t(language, sessionBrowser ? 'agent.approval.allowSession' : approvalScope ? 'agent.approval.allowRun' : 'agent.approval.allow')}
              title={approvalScope ? t(language, `agent.permission.scope.${approvalScope}`) : undefined}
              aria-keyshortcuts="Enter"
              disabled={submitting || reviewing}
              onClick={() => void answerApproval('allow', approvalScope)}
            ><span>{t(language, sessionBrowser ? 'agent.approval.allowSession' : approvalScope ? 'agent.approval.allowRun' : 'agent.approval.allow')}</span><kbd aria-hidden="true">↵</kbd></button>
          </div>
          </div>
        </section>
      )}
    </>
  );
}
