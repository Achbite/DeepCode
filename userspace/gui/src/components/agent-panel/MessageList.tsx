import React from 'react';
import type {
  AgentTimelineAttachment,
  AgentTimelineBlock,
  AgentTimelineCurrentActivity,
  AgentTimelineResult,
  AgentTimelineWorkAttention,
  AgentTimelineWorkOperation,
  AgentTimelineWorkOperationStatus,
  AgentTimelineWorkSegment,
} from '@deepcode/protocol';
import ActivityIndicator from './ActivityIndicator';
import {
  AnswerSettlementStatus,
  isAnswerBusy,
  isAnswerCommitted,
} from './AnswerSettlementStatus';
import { t, type UiLanguage } from '../../i18n';
import MarkdownContent from './LazyMarkdownContent';
import {
  FinalFactReceipt,
  hasStructuredProjection,
  StructuredProjectionContent,
  structuredProjectionText,
} from './StructuredProjectionContent';

interface MessageListProps {
  timeline: AgentTimelineResult;
  loading?: boolean;
  language: UiLanguage;
}

function blockText(block: AgentTimelineBlock, language: UiLanguage): string {
  return structuredProjectionText(block.structuredProjection, language) ||
    block.bodyMarkdown ||
    block.summary;
}

function AttachmentChips({
  attachments,
  language,
}: {
  attachments: AgentTimelineAttachment[];
  language: UiLanguage;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="agent-message-attachments" aria-label={t(language, 'agent.message.attachments')}>
      {attachments.map((attachment) => (
        <span
          key={`${attachment.scope}:${attachment.attachmentId}`}
          className={`agent-message-attachment agent-message-attachment--${attachment.scope}`}
          title={attachment.displayName}
        >
          <span className="agent-message-attachment__kind">
            {attachment.kind === 'directory'
              ? t(language, 'agent.composer.dir')
              : t(language, 'agent.composer.file')}
          </span>
          <span className="agent-message-attachment__path">{attachment.displayName}</span>
        </span>
      ))}
    </div>
  );
}

function UserBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  return (
    <article className="agent-message agent-message--user_msg">
      <div className="agent-message__body agent-message__body--plain">{blockText(block, language)}</div>
      <AttachmentChips attachments={block.attachments ?? []} language={language} />
    </article>
  );
}

function AssistantBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const assistantText = block.bodyMarkdown || block.summary;
  return (
    <article
      className={`agent-message agent-message--assistant_msg${block.answerState ? ` agent-message--answer-${block.answerState}` : ''}`}
      data-answer-state={block.answerState}
      aria-busy={isAnswerBusy(block.answerState)}
    >
      <div className="agent-message__body agent-message__body--markdown">
        <MarkdownContent content={assistantText} />
      </div>
      <AnswerSettlementStatus
        answerState={block.answerState}
        language={language}
      />
      {isAnswerCommitted(block.answerState) && (
        <FinalFactReceipt
          projection={block.structuredProjection}
          language={language}
        />
      )}
    </article>
  );
}

function StructuredBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const kind = block.kind === 'plan' ? 'plan' : 'review';
  const open = block.status === 'running' || block.status === 'waiting' || !block.defaultCollapsed;
  return (
    <details className={`agent-flow-card agent-projection-block agent-flow-card--${kind}`} open={open}>
      <summary className="agent-projection-block__summary">
        <span className={`agent-projection-status agent-projection-status--${block.status}`} />
        <span>{block.title}</span>
      </summary>
      <div className="agent-projection-block__content">
        {hasStructuredProjection(block.structuredProjection, kind) ? (
          <StructuredProjectionContent
            projection={block.structuredProjection}
            language={language}
          />
        ) : (
          <MarkdownContent content={blockText(block, language)} />
        )}
      </div>
    </details>
  );
}

function StatusBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const open = block.status === 'running'
    || block.status === 'waiting'
    || block.status === 'blocked'
    || block.status === 'failed'
    || !block.defaultCollapsed;
  return (
    <details
      className={`agent-flow-card agent-projection-block agent-projection-block--${block.kind}`}
      open={open}
    >
      <summary className="agent-projection-block__summary">
        <span className={`agent-projection-status agent-projection-status--${block.status}`} />
        <span>{block.title}</span>
      </summary>
      <div className="agent-projection-block__content">
        <MarkdownContent content={blockText(block, language)} />
      </div>
    </details>
  );
}

function ProjectedBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  switch (block.kind) {
    case 'user':
      return <UserBlock block={block} language={language} />;
    case 'assistant':
      return <AssistantBlock block={block} language={language} />;
    case 'plan':
    case 'review':
      return <StructuredBlock block={block} language={language} />;
    case 'permission':
    case 'userIntervention':
    case 'error':
      return <StatusBlock block={block} language={language} />;
  }
}

function WorkOperation({
  operation,
  language,
}: {
  operation: AgentTimelineWorkOperation;
  language: UiLanguage;
}) {
  const title = operation.displayName?.trim()
    || operation.canonicalAction?.trim()
    || operation.toolId;
  return (
    <li className={`agent-projection-operation agent-projection-operation--${operation.status}`}>
      <div className="agent-projection-operation__head">
        <span className={`agent-projection-status agent-projection-operation__status agent-projection-operation__status--${operation.status}`} />
        <span className="agent-projection-operation__title">{title}</span>
        <span className="agent-projection-operation__state">
          {workOperationStatusLabel(operation.status, language)}
        </span>
      </div>
      {operation.retry && (
        <div
          className="agent-projection-operation__retry"
          title={operation.retry.predecessorOperationId}
        >
          {language === 'zh-CN'
            ? `第 ${operation.retry.retryOrdinal} 次尝试 · 纠正前序操作`
            : `Attempt ${operation.retry.retryOrdinal} · corrects prior operation`}
        </div>
      )}
      {operation.resourcePresentation.length > 0 && (
        <div className="agent-projection-operation__targets">
          {operation.resourcePresentation.map((target) => target.label).join(' · ')}
        </div>
      )}
      {operation.effectSummary && (
        <div className="agent-projection-operation__effect">
          {t(language, 'agent.work.effectObserved')}
        </div>
      )}
    </li>
  );
}

function WorkSegment({
  segment,
  language,
}: {
  segment: AgentTimelineWorkSegment;
  language: UiLanguage;
}) {
  const forceOpen = segment.attention?.status === 'unresolved';
  const [open, setOpen] = React.useState(forceOpen);

  React.useEffect(() => {
    if (forceOpen) {
      setOpen(true);
    }
  }, [forceOpen]);

  return (
    <details
      className={`agent-projection-work agent-projection-work--${segment.lifecycle}`}
      open={open}
      onToggle={(event) => {
        const requestedOpen = event.currentTarget.open;
        if (forceOpen && !requestedOpen) {
          event.currentTarget.open = true;
          return;
        }
        setOpen(requestedOpen);
      }}
    >
      <summary className="agent-projection-work__summary">
        <span className={`agent-projection-status agent-projection-work__status agent-projection-work__status--${segment.lifecycle}`} />
        <span className="agent-projection-work__title">
          {workSegmentSummary(segment, language)}
        </span>
        {segment.attention && (
          <span className={`agent-projection-work__attention agent-projection-work__attention--${segment.attention.status}`}>
            {segment.attention.status === 'unresolved'
              ? (language === 'zh-CN' ? '需要处理' : 'Needs attention')
              : (language === 'zh-CN' ? '已处理' : 'Resolved')}
          </span>
        )}
      </summary>
      <div className="agent-projection-work__content">
        {segment.attention && (
          <div className={`agent-projection-work__attention-summary agent-projection-work__attention-summary--${segment.attention.status}`}>
            {workAttentionLabel(segment.attention, language)}
          </div>
        )}
        <ol className="agent-projection-work__operations">
          {segment.operations.map((operation) => (
            <WorkOperation
              key={operation.operationId}
              operation={operation}
              language={language}
            />
          ))}
        </ol>
      </div>
    </details>
  );
}

function CurrentActivity({
  activity,
  language,
}: {
  activity: AgentTimelineCurrentActivity | null;
  language: UiLanguage;
}) {
  return (
    <div className="agent-projection-current-activity" role="status" aria-live="polite">
      <ActivityIndicator
        activityKey={activity
          ? `${activity.activityId}:${activity.revision}`
          : 'transport-pending'}
        label={currentActivityLabel(activity, language)}
        variant={activity?.code === 'retry.backoff' ? 'retry' : 'default'}
      />
    </div>
  );
}

function currentActivityLabel(
  activity: AgentTimelineCurrentActivity | null,
  language: UiLanguage
): string {
  if (!activity) return language === 'zh-CN' ? '正在处理' : 'Working';
  if (activity.message?.text) return activity.message.text;
  const labels: Record<string, readonly [string, string]> = {
    'session.admitting': ['正在接收请求', 'Admitting request'],
    'provider.awaitingFirstByte': ['正在等待模型响应', 'Waiting for model response'],
    'provider.reasoning': ['模型正在思考', 'Model is reasoning'],
    'provider.composing': ['正在组织回复', 'Composing response'],
    'resource.resolving': ['正在解析资源', 'Resolving resources'],
    'kernel.executing': ['正在执行工具', 'Executing tools'],
    'session.validating': ['正在校验结果', 'Validating result'],
    'session.persisting': ['正在保存会话', 'Saving session'],
    'retry.backoff': ['正在等待重试', 'Waiting to retry'],
  };
  const known = labels[String(activity.code)];
  if (!known) return t(language, 'agent.activity.working');
  return t(language, `agent.activity.${activity.code}`);
}

function workAttentionLabel(
  attention: AgentTimelineWorkAttention,
  language: UiLanguage
): string {
  return t(language, `agent.work.attention.${attention.kind}`);
}

function workSegmentSummary(segment: AgentTimelineWorkSegment, language: UiLanguage): string {
  const count = segment.operations.length;
  const currentOperation = segment.activeOperationId
    ? segment.operations.find((operation) =>
        operation.operationId === segment.activeOperationId
      )
    : undefined;
  if (segment.lifecycle === 'active' && currentOperation) {
    const action = activeOperationActionLabel(currentOperation, language);
    const targets = currentOperation.resourcePresentation
      .map((target) => target.label.trim())
      .filter(Boolean)
      .join(' · ');
    return targets ? `${action} ${targets}` : action;
  }
  if (language === 'zh-CN') return `工作 ${count} 项`;
  return `${count} ${count === 1 ? 'operation' : 'operations'}`;
}

function activeOperationActionLabel(
  operation: AgentTimelineWorkOperation,
  language: UiLanguage
): string {
  const labels: Record<string, readonly [string, string, string]> = {
    'fs.list': ['查看', 'Inspecting', 'inspect'],
    'fs.glob': ['搜索', 'Searching', 'search'],
    'fs.read': ['读取', 'Reading', 'read'],
    'fs.diff': ['比较', 'Comparing', 'compare'],
    'fs.create': ['创建', 'Creating', 'create'],
    'fs.write': ['写入', 'Writing', 'write'],
    'fs.edit': ['修改', 'Editing', 'edit'],
    'fs.delete': ['删除', 'Deleting', 'delete'],
    'fs.ensure_directory': ['创建目录', 'Creating a directory', 'create a directory'],
    'code.grep': ['搜索', 'Searching', 'search'],
    'document.read': ['读取', 'Reading', 'read'],
    'web.search': ['搜索网页', 'Searching the web', 'search the web'],
    'web.fetch': ['读取网页', 'Reading a web page', 'read a web page'],
  };
  const label = labels[operation.toolId];
  const name = operation.displayName?.trim()
    || operation.canonicalAction?.trim()
    || operation.toolId;
  const action = language === 'zh-CN'
    ? label?.[0] ?? `执行 ${name}`
    : operation.status === 'running'
      ? label?.[1] ?? `Running ${name}`
      : label?.[2] ?? `run ${name}`;
  if (operation.status === 'running') {
    return language === 'zh-CN' ? `正在${action}` : action;
  }
  if (operation.status === 'preparing') {
    return t(language, 'agent.work.action.preparing', { action });
  }
  if (operation.status === 'queued') {
    return t(language, 'agent.work.action.queued', { action });
  }
  if (operation.status === 'awaitingCapability') {
    return t(language, 'agent.work.action.awaitingCapability', { action });
  }
  return `${workOperationStatusLabel(operation.status, language)} · ${name}`;
}

function workOperationStatusLabel(
  status: AgentTimelineWorkOperationStatus,
  language: UiLanguage
): string {
  const labels: Record<AgentTimelineWorkOperationStatus, readonly [string, string]> = {
    preparing: ['准备中', 'Preparing'],
    queued: ['已排队', 'Queued'],
    running: ['执行中', 'Running'],
    awaitingCapability: ['等待授权', 'Awaiting permission'],
    completed: ['已完成', 'Completed'],
    denied: ['已拒绝', 'Denied'],
    failed: ['失败', 'Failed'],
    failedAfterObservedEffect: ['执行后失败', 'Failed after effect'],
    indeterminate: ['状态不确定', 'Indeterminate'],
    cancelled: ['已取消', 'Cancelled'],
    stale: ['已失效', 'Stale'],
    unexecuted: ['未执行', 'Not executed'],
  };
  const label = labels[status];
  return language === 'zh-CN' ? label[0] : label[1];
}

const MessageList: React.FC<MessageListProps> = ({ timeline, loading = false, language }) => {
  const hasParts = timeline.turns.some((turn) => turn.parts.length > 0);
  const currentActivity = timeline.runProjection?.currentActivity ?? null;
  const waitingForUser = timeline.runProjection?.status === 'waitingUser'
    || timeline.runProjection?.wait?.kind === 'user';

  return (
    <div className="agent-message-list">
      {!hasParts && !loading && (
        <div className="agent-empty-state">
          <div className="agent-empty-state__title">{t(language, 'agent.message.readyTitle')}</div>
          <div className="agent-empty-state__subtle">{t(language, 'agent.message.readyBody')}</div>
        </div>
      )}
      {timeline.turns.map((turn) => {
        const blocksById = new Map(turn.blocks.map((block) => [block.id, block]));
        const workSegmentsById = new Map(
          turn.workSegments.map((segment) => [segment.id, segment])
        );
        return (
          <React.Fragment key={turn.id}>
            {turn.parts.map((part) => {
              if (part.kind === 'block') {
                const block = blocksById.get(part.blockId);
                return block
                  ? <ProjectedBlock key={`block:${block.id}`} block={block} language={language} />
                  : null;
              }
              const segment = workSegmentsById.get(part.workSegmentId);
              return segment
                ? <WorkSegment key={`work:${segment.id}`} segment={segment} language={language} />
                : null;
            })}
          </React.Fragment>
        );
      })}
      {!waitingForUser && (currentActivity || loading) && (
        <CurrentActivity activity={currentActivity} language={language} />
      )}
    </div>
  );
};

export default MessageList;
