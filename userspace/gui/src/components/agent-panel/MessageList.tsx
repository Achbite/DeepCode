import React from 'react';
import type {
  AgentTimelineAttachment,
  AgentTimelineBlock,
  AgentTimelineCurrentActivity,
  AgentTimelineResult,
  AgentTimelineWorkOperation,
  AgentTimelineWorkOperationStatus,
  AgentTimelineWorkSegment,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import MarkdownContent from './LazyMarkdownContent';
import {
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
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.scope}:${attachment.folderId ?? ''}:${attachment.path}:${index}`}
          className={`agent-message-attachment agent-message-attachment--${attachment.scope}`}
          title={attachment.path}
        >
          <span className="agent-message-attachment__kind">
            {attachment.kind === 'directory'
              ? t(language, 'agent.composer.dir')
              : t(language, 'agent.composer.file')}
          </span>
          <span className="agent-message-attachment__path">{attachment.path || '.'}</span>
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
  return (
    <article className="agent-message agent-message--assistant_msg">
      <div className="agent-message__body agent-message__body--markdown">
        <MarkdownContent content={blockText(block, language)} />
      </div>
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
      {operation.targets && operation.targets.length > 0 && (
        <div className="agent-projection-operation__targets">
          {operation.targets.join(' · ')}
        </div>
      )}
      {operation.effectSummary && (
        <div className="agent-projection-operation__effect">
          {operation.effectSummary}
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
  const forceOpen = segment.lifecycle === 'active'
    || segment.attention?.status === 'unresolved';
  const previousLifecycle = React.useRef(segment.lifecycle);
  const [open, setOpen] = React.useState(
    forceOpen || segment.lifecycle !== 'completed'
  );

  React.useEffect(() => {
    const wasActive = previousLifecycle.current === 'active';
    previousLifecycle.current = segment.lifecycle;
    if (forceOpen) {
      setOpen(true);
    } else if (wasActive && segment.lifecycle === 'completed') {
      setOpen(false);
    }
  }, [forceOpen, segment.lifecycle]);

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
            {segment.attention.summary}
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
      <span className="agent-projection-current-activity__dot" />
      <span>{currentActivityLabel(activity, language)}</span>
    </div>
  );
}

function currentActivityLabel(
  activity: AgentTimelineCurrentActivity | null,
  language: UiLanguage
): string {
  if (!activity) return language === 'zh-CN' ? '正在处理' : 'Working';
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
  if (!known) return language === 'zh-CN' ? '正在处理' : 'Working';
  return activity.summary?.trim() || (language === 'zh-CN' ? known[0] : known[1]);
}

function workSegmentSummary(segment: AgentTimelineWorkSegment, language: UiLanguage): string {
  const count = segment.operations.length;
  if (language === 'zh-CN') return `工作 ${count} 项`;
  return `${count} ${count === 1 ? 'operation' : 'operations'}`;
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
      {(currentActivity || loading) && (
        <CurrentActivity activity={currentActivity} language={language} />
      )}
    </div>
  );
};

export default MessageList;
