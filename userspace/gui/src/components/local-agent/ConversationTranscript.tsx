import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { MessageFeedback, SessionProjection } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { openExternalUrl } from '../../services/runtimeAdapter';
import { useLocalAgentStore } from '../../state/localAgentStore';
import type { PresentedCommittedContent } from '../../presentation/PresentationRuntime';
import DeepCodeShellIcon from '../shared/DeepCodeShellIcon';
import ProviderStageStatus from './ProviderStageStatus';
import { BufferedMarkdown } from './BufferedMarkdown';
import PlanCard from './PlanCard';
import { ToolActivityGroup, ProviderHostedDraftGroup } from './ToolActivityDetails';
import type { ProjectionItem, AssistantDraftItem } from './conversationItems';
import type { ConversationViewport } from './useConversationViewport';
import { formatBytes } from './conversationFormatting';

interface ConversationTranscriptProps {
  language: UiLanguage;
  loading: boolean;
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
  const { transcriptRef, messageEndRef, setLatestFollowMode } = viewport;
  const assistantDraft = projection?.assistantDraft ?? null;
  const submitting = useLocalAgentStore((state) => state.submitting);
  const setMessageFeedback = useLocalAgentStore((state) => state.setMessageFeedback);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [, setProviderStreamCompletionRevision] = useState(0);
  const providerStreamProgressRef = useRef(new Map<string, number>());
  const transitioningProviderStreamsRef = useRef(new Set<string>());
  const recordProviderStreamProgress = useCallback((identity: string, length: number) => {
    providerStreamProgressRef.current.set(identity, length);
  }, []);

  const finishProviderStream = useCallback((identity: string) => {
    providerStreamProgressRef.current.delete(identity);
    if (transitioningProviderStreamsRef.current.delete(identity)) {
      setProviderStreamCompletionRevision((revision) => revision + 1);
    }
  }, []);

  const committedProviderContent = (
    identity: string | undefined,
    content: string,
    committed: React.ReactNode,
  ): React.ReactNode => {
    if (!identity) throw new Error('conversation_timeline_stream_missing');
    if (!transitioningProviderStreamsRef.current.has(identity)) return committed;
    return (
      <BufferedMarkdown
        key={`committed:${identity}`}
        text={content}
        streamIdentity={identity}
        initialVisibleLength={providerStreamProgressRef.current.get(identity) ?? 0}
        onVisibleLengthChange={recordProviderStreamProgress}
        onCaughtUp={finishProviderStream}
      />
    );
  };

  useLayoutEffect(() => {
    if (!assistantDraft) return;
    for (const block of assistantDraft.blocks) {
      if (block.kind !== 'providerHosted') {
        transitioningProviderStreamsRef.current.add(block.streamId);
      }
    }
  }, [assistantDraft]);

  const copyAssistantMessage = async (messageId: string, content: string) => {
    try {
      await copyTextToClipboard(content);
      setCopiedMessageId(messageId);
      setUiActionError(null);
      window.setTimeout(() => {
        setCopiedMessageId((current) => current === messageId ? null : current);
      }, 1_500);
    } catch (copyError) {
      setUiActionError(copyError instanceof Error ? copyError.message : String(copyError));
    }
  };

  const updateMessageFeedback = async (
    messageId: string,
    feedback: MessageFeedback | null,
  ) => {
    try {
      await setMessageFeedback(messageId, feedback);
      setUiActionError(null);
    } catch (feedbackError) {
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
    void openExternalUrl(href).then(() => {
      setUiActionError(null);
    }).catch((error: unknown) => {
      setUiActionError(error instanceof Error ? error.message : String(error));
    });
  };

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
      {conversationItems.map((item) => item.type === 'message' ? (
        <article
          key={`message:${item.value.messageId}`}
          className={`local-agent__message local-agent__message--${item.value.role}`}
        >
          <div className="local-agent__message-content">
            {item.value.role === 'assistant'
              ? committedProviderContent(
                  item.streamId,
                  item.value.content,
                  presentation.content(`message:${item.value.messageId}:content`),
                )
              : presentation.content(`message:${item.value.messageId}:content`)}
            {item.value.filesystemReferences.length > 0 && (
              <div className="local-agent__message-attachments">
                {item.value.filesystemReferences.map((reference) => (
                  <span
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
                  </span>
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
                title={t(language, 'agent.message.copy')}
                aria-label={copiedMessageId === item.value.messageId
                  ? t(language, 'agent.message.copied')
                  : t(language, 'agent.message.copyResponse')}
                onClick={() => void copyAssistantMessage(item.value.messageId, item.value.content)}
              >
                <DeepCodeShellIcon name="copy" />
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
        <article className="local-agent__narrative" key={`narrative:${item.value.narrativeId}`}>
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
          active={samePlanReference(projection?.activePlanRef, item.value)}
          language={language}
        />
      ) : (
        <ToolActivityGroup
          activities={item.values}
          key={item.groupId}
          language={language}
          onExpand={() => setLatestFollowMode(false)}
          onOpenWorkspaceResource={openWorkspaceResource}
        />
      ))}
      {draftItems.map((item) => item.type === 'text' ? (
        <article
          className={item.block.kind === 'narrative'
            ? 'local-agent__narrative local-agent__narrative--draft'
            : 'local-agent__message local-agent__message--assistant local-agent__message--draft'}
          key={item.block.streamId}
        >
          <div className={item.block.kind === 'narrative'
            ? undefined
            : 'local-agent__message-content'}
          >
            <BufferedMarkdown
              text={item.block.content}
              streamIdentity={item.block.streamId}
              initialVisibleLength={providerStreamProgressRef.current.get(item.block.streamId) ?? 0}
              onVisibleLengthChange={recordProviderStreamProgress}
            />
          </div>
        </article>
      ) : (
        <ProviderHostedDraftGroup
          blocks={item.blocks}
          key={item.groupId}
          language={language}
          onExpand={() => setLatestFollowMode(false)}
        />
      ))}
      {projection?.run && projection.run.status !== 'completed' && (
        <ProviderStageStatus run={projection.run} language={language}
          key={`${projection.run.runId}:${assistantDraft?.turnId ?? 'idle'}`}
          activity={assistantDraft?.runId === projection.run.runId ? assistantDraft.activity : undefined}
          toolPending={projection.activities.some((activity) => activity.runId === projection.run?.runId
            && activity.kind === 'tool' && ['requested', 'active', 'waiting'].includes(activity.status))} />
      )}
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

async function copyTextToClipboard(text: string): Promise<void> {
  if (window.navigator.clipboard?.writeText) {
    await window.navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('clipboard_copy_failed');
}

function samePlanReference(
  reference: { planId: string; revision: number } | null | undefined,
  plan: { planId: string; revision: number },
): boolean {
  return reference?.planId === plan.planId && reference.revision === plan.revision;
}
