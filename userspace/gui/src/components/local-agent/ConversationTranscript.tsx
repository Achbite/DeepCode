import React, { useLayoutEffect, useRef, useState } from 'react';
import type { MessageFeedback, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useConversationHost } from './ConversationHost';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { PresentedCommittedContent } from '../../presentation/PresentationRuntime';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import { FileChanges, roundChangeActivities } from './FileChanges';
import { ReasoningHistory } from './ReasoningDetails';
import { PlanPreviewCard } from './PlanPreviewCard';
import ProviderStageStatus from './ProviderStageStatus';
import { BufferedMarkdown, MarkdownContent, MarkdownInline } from './BufferedMarkdown';
import PlanCard from './PlanCard';
import { ToolActivityGroup, ProviderHostedDraftGroup } from './ToolActivityDetails';
import { conversationRounds, type ProjectionItem, type AssistantDraftItem } from './conversationItems';
import type { ConversationViewport } from './useConversationViewport';
import { formatBytes } from './conversationFormatting';

interface ConversationTranscriptProps {
  language: UiLanguage;
  loading: boolean;
  showReasoning?: boolean;
  completedRuns: Set<string>;
  onDisplayed(identity: string, text: string): void;
  projection: SessionProjection | null;
  activeProject: { title: string } | undefined;
  hasConversationContent: boolean;
  conversationItems: ProjectionItem[];
  draftItems: AssistantDraftItem[];
  presentation: PresentedCommittedContent;
  viewport: ConversationViewport;
  openWorkspaceResource: (workspaceId: string, logicalPath: string) => Promise<void>;
  setUiActionError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function ConversationTranscript({
  language,
  showReasoning = false,
  completedRuns,
  onDisplayed,
  loading,
  projection,
  activeProject,
  hasConversationContent,
  conversationItems,
  draftItems,
  presentation,
  viewport,
  openWorkspaceResource,
  setUiActionError,
}: ConversationTranscriptProps) {
  const host = useConversationHost();
  const { transcriptRef, messageEndRef, setLatestFollowMode } = viewport;
  const onPlanToggle = (card: HTMLElement, expanded: boolean) => {
    const body = viewport.bodyRef.current;
    if (body && !expanded) {
      // Bring the summary back into view before removing the long document.
      const cardTop = body.scrollTop + card.getBoundingClientRect().top - body.getBoundingClientRect().top;
      body.scrollTop = Math.min(body.scrollTop, Math.max(0, cardTop));
    }
    setLatestFollowMode(false);
  };
  const assistantDraft = projection?.assistantDraft ?? null;
  const submitting = useLocalAgentStore((state) => state.submitting);
  const setMessageFeedback = useLocalAgentStore((state) => state.setMessageFeedback);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const currentSessionRef = useRef({ sessionId: projection?.sessionId });
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  if (currentSessionRef.current.sessionId !== projection?.sessionId) currentSessionRef.current = { sessionId: projection?.sessionId };
  useLayoutEffect(() => {
    setCopiedMessageId(null);
    return () => clearTimeout(copyTimerRef.current);
  }, [projection?.sessionId]);
  const committedProviderContent = (identity: string | undefined, content: string, committed: React.ReactNode): React.ReactNode => {
    if (!identity) throw new Error('conversation_timeline_stream_missing');
    // Custom presentation renderers retain their output; the builtin Markdown keeps its stream node.
    if (!React.isValidElement(committed) || committed.type !== MarkdownContent) return <CommittedPresentation identity={identity} text={content} onDisplayed={onDisplayed}>{committed}</CommittedPresentation>;
    return <BufferedMarkdown text={content} streamIdentity={identity} streaming={false} onDisplayed={onDisplayed} />;
  };

  const copyAssistantMessage = async (messageId: string, content: string) => {
    const requestedView = currentSessionRef.current;
    try {
      await host.copyText(content);
      if (currentSessionRef.current !== requestedView) return;
      setCopiedMessageId(messageId);
      setUiActionError(null);
      clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopiedMessageId((current) => current === messageId ? null : current);
      }, 1_500);
    } catch (copyError) {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const updateMessageFeedback = async (
    messageId: string,
    feedback: MessageFeedback | null,
  ) => {
    const requestedView = currentSessionRef.current;
    try {
      await setMessageFeedback(messageId, feedback);
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(null);
    } catch (feedbackError) {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(feedbackError instanceof Error
        ? feedbackError.message
        : String(feedbackError));
    }
  };

  const openTranscriptLink = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (event.button !== 0 && event.button !== 1)) return;
    const anchor = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>('a[href]')
      : null;
    if (!anchor || !event.currentTarget.contains(anchor)) return;
    const href = anchor.getAttribute('href') ?? '';
    if (!/^https?:\/\//i.test(href)) return;
    event.preventDefault();
    const requestedView = currentSessionRef.current;
    void host.openExternalLink(href).then(() => {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(null);
    }).catch((error: unknown) => {
      if (currentSessionRef.current !== requestedView) return;
      setUiActionError(error instanceof Error ? error.message : String(error));
    });
  };

  const renderItem = (item: ProjectionItem): React.ReactNode => item.type === 'message' ? (
        <article
          className={`local-agent__message local-agent__message--${item.value.role}`}
        >
          <div className="local-agent__message-content">
            {item.value.replyToInteraction && <InteractionReplyQuote prompt={item.value.replyToInteraction.prompt} />}
            {item.value.role === 'assistant'
              ? committedProviderContent(
                  item.streamId,
                  item.value.content,
                  presentation.content(`message:${item.value.messageId}:content`),
                )
              : item.value.replyToInteraction ? <MarkdownContent>{item.value.content}</MarkdownContent>
              : presentation.content(`message:${item.value.messageId}:content`)}
            {item.value.filesystemReferences.length > 0 && (
              <div className="local-agent__message-attachments">
                {item.value.filesystemReferences.map((reference) => (
                  <button type="button"
                    onClick={() => { if (reference.kind === 'file') void openWorkspaceResource(reference.workspaceId, reference.logicalPath); }}
                    className={reference.kind === 'directory'
                      ? 'local-agent__message-directory'
                      : undefined}
                    key={reference.referenceId}
                  >
                    <DeepCodeShellIcon name={reference.kind === 'directory'
                      ? 'folder'
                      : 'artifact'} />
                    {reference.displayName}
                    {reference.kind === 'file' && (
                      <small>{formatBytes(reference.byteLength, language)}</small>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          {item.value.role === 'assistant' && (
            <div
              className="local-agent__message-actions"
              aria-label={t(language, 'agent.message.actions')}
            >
              <button
                type="button"
                className="conversation-copy-button"
                aria-label={copiedMessageId === item.value.messageId
                  ? t(language, 'agent.message.copied')
                  : t(language, 'agent.message.copyResponse')}
                onClick={() => void copyAssistantMessage(item.value.messageId, item.value.content)}
              >
                <DeepCodeShellIcon name="copy" />
                <span className="conversation-copy-hint" role="status">{copiedMessageId === item.value.messageId
                  ? t(language, 'agent.message.copied')
                  : t(language, 'agent.message.copy')}</span>
              </button>
              <button
                    type="button"
                    className={item.value.feedback === 'up' ? 'is-selected' : ''}
                    aria-pressed={item.value.feedback === 'up'}
                    title={t(language, 'agent.message.helpful')}
                    aria-label={t(language, 'agent.message.helpful')}
                    disabled={submitting}
                    onClick={() => void updateMessageFeedback(
                      item.value.messageId,
                      item.value.feedback === 'up' ? null : 'up',
                    )}
                  >
                    <DeepCodeShellIcon name="thumbUp" />
              </button>
              <button
                    type="button"
                    className={item.value.feedback === 'down' ? 'is-selected' : ''}
                    aria-pressed={item.value.feedback === 'down'}
                    title={t(language, 'agent.message.notHelpful')}
                    aria-label={t(language, 'agent.message.notHelpful')}
                    disabled={submitting}
                    onClick={() => void updateMessageFeedback(
                      item.value.messageId,
                      item.value.feedback === 'down' ? null : 'down',
                    )}
                  >
                    <DeepCodeShellIcon name="thumbDown" />
              </button>
            </div>
          )}
        </article>
      ) : item.type === 'narrative' ? (
        <article className="local-agent__narrative">
          <div>
            {committedProviderContent(
              item.streamId,
              item.value.content,
              presentation.content(`narrative:${item.value.narrativeId}`),
            )}
          </div>
        </article>
      ) : item.type === 'plan' ? (
        <PlanCard
          key={`plan:${item.value.planId}:${item.value.revision}`}
          plan={item.value}
          previousPlan={projection?.plans.find((plan) => plan.planId === item.value.planId && plan.revision === item.value.revision - 1)}
          workspaceBindings={projection?.workspaceBindings}
          active={samePlanReference(projection?.activePlanRef, item.value)}
          language={language}
          onToggle={onPlanToggle}
        />
      ) : (
        <ToolActivityGroup
          sessionId={projection!.sessionId}
          activities={item.values}
          key={item.groupId}
          language={language}
          onExpand={() => setLatestFollowMode(false)}
          onOpenWorkspaceResource={openWorkspaceResource}
        />
      );
  const renderDraft = (item: AssistantDraftItem): React.ReactNode => item.type === 'text' ? (
        <article
          className={item.block.kind === 'narrative'
            ? 'local-agent__narrative local-agent__narrative--draft'
            : 'local-agent__message local-agent__message--assistant local-agent__message--draft'}
        >
          <div className={item.block.kind === 'narrative'
            ? undefined
            : 'local-agent__message-content'}
          >
            <BufferedMarkdown
              text={item.block.content}
              streamIdentity={item.block.streamId}
            />
          </div>
        </article>
      ) : item.type === 'planPreview' ? <PlanPreviewCard preview={item.value} key={item.key} language={language} onToggle={onPlanToggle} /> : (
        <ProviderHostedDraftGroup
          blocks={item.blocks}
          key={item.groupId}
          language={language}
          onExpand={() => setLatestFollowMode(false)}
        />
      );
  const providerStatus = <>
      {projection?.run && projection.run.status !== 'completed' && (
        <ProviderStageStatus run={projection.run} language={language}
          reasoning={showReasoning && assistantDraft ? { sessionId: projection.sessionId, requestId: assistantDraft.turnId } : undefined}
          key={`${projection.run.runId}:${assistantDraft?.turnId ?? 'idle'}`}
          activity={assistantDraft?.runId === projection.run.runId ? assistantDraft.activity : undefined}
          toolPending={projection.activities.some((activity) => activity.runId === projection.run?.runId
            && activity.kind === 'tool' && ['requested', 'active', 'waiting'].includes(activity.status))} />
      )}
</>;
  const rounds = conversationRounds(conversationItems, draftItems, projection?.run?.runId);

  return (
    <div
      ref={transcriptRef}
      className="local-agent__transcript"
      onClick={openTranscriptLink}
      onAuxClick={openTranscriptLink}
    >
      {loading && !projection && (
        <div className="local-agent__empty">{t(language, 'agent.chat.opening')}</div>
      )}
      {!hasConversationContent && !loading && (
        <div className="local-agent__empty local-agent__empty--welcome">
          <strong>
            {activeProject
              ? t(language, 'agent.chat.welcomeProject', { project: activeProject.title })
              : t(language, 'agent.chat.welcomeDefault')}
          </strong>
        </div>
      )}
      {rounds.map((round) => {
        const current = projection?.run?.runId === round.runId;
        const completed = completedRuns.has(round.runId);
        const terminal = current && ['failed', 'cancelled', 'indeterminate'].includes(projection!.run!.status);
        const rows = round.rows.map((row) => ({
          key: row.key,
          process: row.item ? row.item.type !== 'message' : row.draft?.type !== 'text' || row.draft.block.kind === 'narrative',
          required: row.item?.type === 'plan' && samePlanReference(projection?.pendingPlan, row.item.value),
          content: row.item ? renderItem(row.item) : renderDraft(row.draft!),
        }));
        if (current && !completed) rows.push({ key: 'provider-status', process: true, required: false, content: providerStatus });
        if (showReasoning && projection && completed) rows.push({ key: 'reasoning-history', process: true, required: false, content: <ReasoningHistory sessionId={projection.sessionId} runId={round.runId} /> });
        return <ConversationRoundView key={`${projection?.sessionId}:${round.key}`} completed={completed} followingLatest={viewport.followingLatest} rows={rows}>
          {(completed || terminal) && <FileChanges activities={roundChangeActivities(projection, round.runId)} />}
        </ConversationRoundView>;
      })}
      {projection?.terminalError && (
        <article className="local-agent__terminal-error">
          <strong>{projection.terminalError.code}</strong>
          <span>{projection.terminalError.message}</span>
        </article>
      )}
      <div ref={messageEndRef} />
    </div>
  );
}

function samePlanReference(
  reference: { planId: string; revision: number } | null | undefined,
  plan: { planId: string; revision: number },
): boolean {
  return reference?.planId === plan.planId && reference.revision === plan.revision;
}

function ConversationRoundView({ completed, followingLatest, rows, children }: {
  completed: boolean; followingLatest: boolean;
  rows: Array<{ key: string; process: boolean; required: boolean; content: React.ReactNode }>;
  children: React.ReactNode;
}) {
  const [disclosure, setDisclosure] = useState({ completed, open: false });
  if (disclosure.completed !== completed) setDisclosure({ completed, open: completed && !followingLatest });
  const expanded = !completed || disclosure.open;
  const firstProcess = rows.find((row) => row.process)?.key;
  return <section className="conversation-round">
    {rows.map((row) => <React.Fragment key={row.key}>
      {completed && row.key === firstProcess && <button className="conversation-process-toggle" type="button" aria-expanded={expanded} onClick={() => setDisclosure({ completed, open: !expanded })}>
        <DeepCodeShellIcon name="tool" /><span>{expanded ? '执行过程' : '查看执行过程'}</span><DeepCodeShellIcon name="chevronDown" className="conversation-disclosure-chevron" />
      </button>}
      <div data-conversation-anchor={row.key} hidden={row.process && !expanded && !row.required}>{(!row.process || expanded || row.required) && row.content}</div>
    </React.Fragment>)}
    {children}
  </section>;
}

function CommittedPresentation({ identity, text, onDisplayed, children }: { identity: string; text: string; onDisplayed(identity: string, text: string): void; children: React.ReactNode }) {
  useLayoutEffect(() => onDisplayed(identity, text), [identity, text, onDisplayed]);
  return <>{children}</>;
}

export function InteractionReplyQuote({ prompt }: { prompt: string }) {
  return <details className="conversation-answered-question">
    <summary><span><MarkdownInline>{prompt.split(/\n\s*\n/)[0]!}</MarkdownInline></span><DeepCodeShellIcon name="chevronDown" /></summary>
    <div className="conversation-answered-question-body"><MarkdownContent>{prompt}</MarkdownContent></div>
  </details>;
}
