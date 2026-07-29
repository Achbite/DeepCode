import React from 'react';
import type {
  AgentTimelineAttachment,
  AgentTimelineBlock,
  AgentTimelineResult,
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
    <article className="agent-message agent-message--user">
      <div className="agent-message__role">{t(language, 'agent.message.user')}</div>
      <div className="agent-message__body agent-message__body--plain">{blockText(block, language)}</div>
      <AttachmentChips attachments={block.attachments ?? []} language={language} />
    </article>
  );
}

function TextBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const text = blockText(block, language);
  const className = block.narrativeKind === 'assistantNarration'
    ? 'agent-message agent-message--assistant agent-message--narration'
    : 'agent-message agent-message--assistant';
  return (
    <article className={className}>
      <div className="agent-message__body agent-message__body--markdown">
        <MarkdownContent content={text} />
      </div>
    </article>
  );
}

function ThinkingBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const open = block.status === 'running' || block.status === 'waiting' || !block.defaultCollapsed;
  return (
    <details className="agent-trace-group" open={open}>
      <summary>
        <span className={`agent-trace-group__dot agent-trace-group__dot--${block.status}`} />
        <span>{block.title || t(language, 'agent.message.thinking')}</span>
      </summary>
      <div className="agent-trace-group__content">
        <MarkdownContent content={blockText(block, language)} />
      </div>
    </details>
  );
}

function StructuredBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const kind = block.narrativeKind === 'plan' ? 'plan' : 'review';
  const open = block.status === 'running' || block.status === 'waiting' || !block.defaultCollapsed;
  return (
    <details className={`agent-flow-card agent-flow-card--${kind}`} open={open}>
      <summary>
        <span className={`agent-flow-card__status agent-flow-card__status--${block.status}`} />
        <span>{block.title}</span>
      </summary>
      <div className="agent-flow-card__content">
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

function OperationBlock({ block }: { block: AgentTimelineBlock }) {
  const activity = block.activity;
  const open = block.status === 'running' || block.status === 'failed' || !block.defaultCollapsed;
  const targets = activity?.targets ?? [];
  return (
    <details className="agent-flow-card agent-flow-card--tool" open={open}>
      <summary>
        <span className={`agent-flow-card__status agent-flow-card__status--${block.status}`} />
        <span>{block.title}</span>
      </summary>
      <div className="agent-flow-card__content">
        {block.summary && <div className="agent-flow-card__summary">{block.summary}</div>}
        {(activity?.operation || activity?.toolName || targets.length > 0) && (
          <div className="agent-flow-card__meta">
            {[activity?.operation, activity?.toolName, ...targets].filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    </details>
  );
}

function GenericBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  const open = block.status === 'running' || block.status === 'waiting' || block.status === 'failed' || !block.defaultCollapsed;
  return (
    <details className={`agent-flow-card agent-flow-card--${block.kind}`} open={open}>
      <summary>
        <span className={`agent-flow-card__status agent-flow-card__status--${block.status}`} />
        <span>{block.title}</span>
      </summary>
      <div className="agent-flow-card__content">
        <MarkdownContent content={blockText(block, language)} />
      </div>
    </details>
  );
}

function ProjectedBlock({ block, language }: { block: AgentTimelineBlock; language: UiLanguage }) {
  if (block.narrativeKind === 'user' || block.kind === 'user') {
    return <UserBlock block={block} language={language} />;
  }
  if (block.narrativeKind === 'thinking' || block.kind === 'thinking') {
    return <ThinkingBlock block={block} language={language} />;
  }
  if (block.narrativeKind === 'assistantNarration' || block.narrativeKind === 'assistantText' || block.kind === 'assistant') {
    return <TextBlock block={block} language={language} />;
  }
  if (block.narrativeKind === 'plan' || block.narrativeKind === 'review' || block.kind === 'plan' || block.kind === 'review') {
    return <StructuredBlock block={block} language={language} />;
  }
  if (block.narrativeKind === 'operationEvidence' || block.narrativeKind === 'verification') {
    return <OperationBlock block={block} />;
  }
  return <GenericBlock block={block} language={language} />;
}

const MessageList: React.FC<MessageListProps> = ({ timeline, loading = false, language }) => {
  const blocks = React.useMemo(
    () => timeline.turns.flatMap((turn) => turn.blocks),
    [timeline]
  );
  return (
    <div className="agent-message-list">
      {blocks.length === 0 && !loading && (
        <div className="agent-empty-state">
          <div className="agent-empty-state__title">{t(language, 'agent.message.readyTitle')}</div>
          <div className="agent-empty-state__subtle">{t(language, 'agent.message.readyBody')}</div>
        </div>
      )}
      {blocks.map((block) => (
        <ProjectedBlock key={block.id} block={block} language={language} />
      ))}
      {loading && (
        <div className="agent-thinking">
          <span className="agent-spinner" />
          <span>{t(language, 'agent.message.thinking')}</span>
        </div>
      )}
    </div>
  );
};

export default MessageList;
