import React, { useEffect, useRef } from 'react';
import type { PlanOperation, PlanProjection, WorkspaceBindingDisplay } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import { PlanDocument } from './PlanDocument';
import { useConversationRowState } from './ConversationVirtualRow';

interface PlanCardProps {
  plan: PlanProjection;
  active: boolean;
  previousPlan?: PlanProjection;
  workspaceBindings?: readonly WorkspaceBindingDisplay[];
  language: UiLanguage;
  onToggle?: (card: HTMLElement, expanded: boolean) => void;
}

const PlanCard: React.FC<PlanCardProps> = ({
  plan,
  active,
  previousPlan,
  workspaceBindings = [],
  language,
  onToggle,
}) => {
  const cardRef = useRef<HTMLElement>(null);
  const previousStatus = useRef(plan.status);
  const [expanded, setExpanded] = useConversationRowState(`plan:${plan.revision}:${plan.status}:expanded`, false);
  const toggle = (next: boolean) => {
    if (cardRef.current) onToggle?.(cardRef.current, next);
    setExpanded(next);
  };

  useEffect(() => {
    if (previousStatus.current !== plan.status) {
      if (plan.status === 'confirmed') setExpanded(false);
      previousStatus.current = plan.status;
    }
  }, [plan.status]);

  const status = t(language, `agent.plan.status.${plan.status}`);
  const stepCount = t(language, 'agent.plan.stepCount', { count: plan.steps.length });

  return (
    <article ref={cardRef} className={`local-agent__plan-card local-agent__plan-card--${plan.status}`}>
      {expanded ? (
        <div className="local-agent__plan-document">
          <button
            type="button"
            className="local-agent__plan-document-meta"
            aria-expanded="true"
            aria-label={t(language, 'agent.plan.collapse')}
            onClick={() => toggle(false)}
          >
            <DeepCodeShellIcon name="activity" />
            <span>
              {t(language, 'agent.plan.documentLabel')}
              {' · '}
              {t(language, 'agent.plan.revision', { revision: plan.revision })}
              {active ? ` · ${t(language, 'agent.plan.active')}` : ''}
            </span>
            <span className="local-agent__plan-card-status">{status}</span>
            <DeepCodeShellIcon name="chevronDown" />
          </button>
          <PlanCardContent plan={plan} previousPlan={previousPlan} workspaceBindings={workspaceBindings} language={language} />
        </div>
      ) : (
        <button
          type="button"
          className="local-agent__plan-card-summary"
          aria-expanded="false"
          aria-label={t(language, 'agent.plan.expand')}
          onClick={() => toggle(true)}
        >
          <DeepCodeShellIcon name="activity" />
          <strong><MarkdownInline>{plan.title}</MarkdownInline></strong>
          <span className="local-agent__plan-card-status">{status} · {stepCount}</span>
          <span className="local-agent__plan-card-chevron" aria-hidden="true">
            <DeepCodeShellIcon name="chevronRight" />
          </span>
        </button>
      )}
    </article>
  );
};

export function PlanCardContent({ plan, previousPlan, workspaceBindings = [], language }: Omit<PlanCardProps, 'active' | 'onToggle'>) {
  return <>
    {previousPlan && <PlanRevisionDetails previous={previousPlan} current={plan} language={language} workspaceBindings={workspaceBindings} />}
    <PlanDocument title={plan.title} summary={plan.summary} steps={plan.steps} language={language}>
      {plan.mutationManifest.length > 0 && (
        <details className="local-agent__plan-manifest">
          <summary>{t(language, 'agent.plan.mutationManifest', { count: plan.mutationManifest.length })}</summary>
          <ul>{plan.mutationManifest.map((operation, index) => (
            <li key={`${operation.workspaceId}:${operation.operation}:${planOperationDetail(operation)}:${index}`}>
              <code>
                {workspaceBindings.length > 1 ? `${workspaceBindings.find((binding) => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}
                {planOperationDetail(operation, language)}
              </code>
            </li>
          ))}</ul>
        </details>
      )}
    </PlanDocument>
  </>;
}

function planOperationDetail(operation: PlanOperation, language: UiLanguage = 'zh-CN'): string {
  const chinese = language === 'zh-CN';
  if (operation.operation === 'bash') {
    const scope = operation.executionScope === 'host' ? (chinese ? '宿主机' : 'Host') : (chinese ? '工作区' : 'Workspace');
    const paths = operation.writablePaths?.map((target) => target.path + (target.kind === 'directory' ? '/' : '')).join(', ');
    const mode = (chinese ? '允许修改' : 'May modify') + (paths ? `: ${paths}` : '');
    return `${chinese ? '执行命令' : 'Run command'} · ${scope} · ${mode}${operation.command ? `\n${operation.command}` : ''}${operation.terminal ? (chinese ? ' · 交互终端' : ' · Interactive terminal') : ''}`;
  }
  const label = operation.operation === 'fs.delete' ? (chinese ? '删除' : 'Delete')
    : operation.operation === 'fs.write' ? (chinese ? '写入' : 'Write') : (chinese ? '编辑' : 'Edit');
  const directory = operation.targetKind === 'directoryTree'
    ? operation.operation === 'fs.delete' ? (chinese ? '（删除目录树）' : ' (delete directory tree)')
      : (chinese ? '（目录内文件，含新建）' : ' (descendant files, including new files)') : '';
  return `${label} · ${operation.target}${directory}`;
}

function PlanRevisionDetails({ previous, current, language, workspaceBindings }: {
  previous: PlanProjection; current: PlanProjection; language: UiLanguage; workspaceBindings: readonly WorkspaceBindingDisplay[];
}) {
  const chinese = language === 'zh-CN';
  const operationText = (operation: PlanOperation) => `${workspaceBindings.length > 1
    ? `${workspaceBindings.find((binding) => binding.workspaceId === operation.workspaceId)?.displayName ?? operation.workspaceId} · ` : ''}${planOperationDetail(operation, language)}`;
  const added = current.mutationManifest.filter((item) => !previous.mutationManifest.some((old) => JSON.stringify(old) === JSON.stringify(item)));
  const removed = previous.mutationManifest.filter((item) => !current.mutationManifest.some((next) => JSON.stringify(next) === JSON.stringify(item)));
  return <section className="conversation-plan-revision-note conversation-markdown">
    <p>{planRevisionSummary(previous, current, language)}</p>
    {(added.length > 0 || removed.length > 0) && <ul>
      {added.map((operation, index) => <li key={`add:${index}`}>{chinese ? '新增范围：' : 'Added scope: '}<code>{operationText(operation)}</code></li>)}
      {removed.map((operation, index) => <li key={`remove:${index}`}>{chinese ? '移除范围：' : 'Removed scope: '}<del><code>{operationText(operation)}</code></del></li>)}
    </ul>}
    {previous.steps.filter((step) => !current.steps.some((next) => next.stepId === step.stepId)).map((step) => <div key={`removed:${step.stepId}`}>
      <p>{chinese ? '移除阶段：' : 'Removed phase: '}<del><MarkdownInline>{step.title}</MarkdownInline></del></p>
      {(step.verification ?? []).map((item, index) => <div key={index}>{chinese ? '移除验收：' : 'Removed verification: '}<MarkdownContent>{item}</MarkdownContent></div>)}
    </div>)}
    {current.steps.map((step) => {
      const old = previous.steps.find((item) => item.stepId === step.stepId);
      const removedChecks = (old?.verification ?? []).filter((item) => !step.verification?.includes(item));
      const addedChecks = (step.verification ?? []).filter((item) => !old?.verification?.includes(item));
      const detailsChanged = old && (old.title !== step.title || old.details !== step.details);
      if (old && !detailsChanged && !removedChecks.length && !addedChecks.length) return null;
      return <div key={step.stepId}>
        <p><strong>{chinese ? old ? '调整阶段：' : '新增阶段：' : old ? 'Changed phase: ' : 'Added phase: '}<MarkdownInline>{step.title}</MarkdownInline></strong></p>
        {removedChecks.map((item, index) => <div key={`remove:${index}`}>{chinese ? '移除验收：' : 'Removed verification: '}<MarkdownContent>{item}</MarkdownContent></div>)}
        {addedChecks.map((item, index) => <div key={`add:${index}`}>{chinese ? '新增验收：' : 'Added verification: '}<MarkdownContent>{item}</MarkdownContent></div>)}
        {detailsChanged && <details><summary>{chinese ? '阶段正文变化' : 'Phase text changes'}</summary>
          <p>{chinese ? '修订前' : 'Before'}</p><MarkdownContent>{`${old.title}\n\n${old.details}`}</MarkdownContent>
          <p>{chinese ? '修订后' : 'After'}</p><MarkdownContent>{`${step.title}\n\n${step.details}`}</MarkdownContent>
        </details>}
      </div>;
    })}
  </section>;
}

function planRevisionSummary(previous: PlanProjection, current: PlanProjection, language: UiLanguage): string {
  const added = current.steps.filter((step) => !previous.steps.some((old) => old.stepId === step.stepId)).length;
  const removed = previous.steps.filter((step) => !current.steps.some((next) => next.stepId === step.stepId)).length;
  const changed = current.steps.filter((step) => previous.steps.some((old) => old.stepId === step.stepId
    && (old.title !== step.title || old.details !== step.details || JSON.stringify(old.verification) !== JSON.stringify(step.verification)))).length;
  const scopeChanged = JSON.stringify(previous.mutationManifest) !== JSON.stringify(current.mutationManifest);
  return language === 'zh-CN'
    ? `本次修订：新增 ${added} 步 · 调整 ${changed} 步 · 移除 ${removed} 步${scopeChanged ? ' · 执行范围有变化，请核对后确认' : ''}`
    : `Revision: ${added} added · ${changed} changed · ${removed} removed${scopeChanged ? ' · Execution scope changed; review before confirming' : ''}`;
}

export default PlanCard;
