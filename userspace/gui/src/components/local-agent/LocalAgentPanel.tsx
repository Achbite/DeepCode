import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityProjection,
  MessageFeedback,
  PlanResponse,
  RunProjection,
  SessionProjection,
  UserMessageAttachment,
} from '@deepcode/protocol';
import { normalizeUiLanguage, t, type UiLanguage } from '../../i18n';
import DeepCodeShellIcon from '../../deepcode-gui/layout/DeepCodeShellIcon';
import ProjectFolderDialog from '../../deepcode-gui/layout/ProjectFolderDialog';
import SessionModelSelector from '../../deepcode-gui/panel/SessionModelSelector';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useSettingsStore } from '../../state/settingsStore';
import { BufferedMarkdown, MarkdownContent } from './BufferedMarkdown';
import PlanCard from './PlanCard';
import { shouldOfferFocusCommand, shouldSubmitComposerKey } from './composerKeyboard';
import {
  readConversationResource,
  type ConversationResourceReadResult,
} from '../../services/localAgentApi';
import { readMessageAttachmentFile } from '../../services/runtimeAdapter';
import './localAgentPanel.css';

interface LocalAgentPanelProps {
  mode?: 'panel' | 'workbench';
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

const LocalAgentPanel: React.FC<LocalAgentPanelProps> = ({ mode = 'panel' }) => {
  const effectiveSettings = useSettingsStore((state) => state.effectiveSettings);
  const runtimeEffectiveSettings = useSettingsStore((state) => state.runtimeEffectiveSettings);
  const settingsRestartRequired = useSettingsStore((state) => state.restartRequired);
  const patchUserSetting = useSettingsStore((state) => state.patchUserSetting);
  const language = normalizeUiLanguage(effectiveSettings['workbench.language']);
  const sessionId = useLocalAgentStore((state) => state.sessionId);
  const draftProjectId = useLocalAgentStore((state) => state.draftProjectId);
  const catalog = useLocalAgentStore((state) => state.catalog);
  const profiles = useLocalAgentStore((state) => state.profiles);
  const selectedProfileId = useLocalAgentStore((state) => state.selectedProfileId);
  const projection = useLocalAgentStore((state) => state.projection);
  const loading = useLocalAgentStore((state) => state.loading);
  const submitting = useLocalAgentStore((state) => state.submitting);
  const catalogBusy = useLocalAgentStore((state) => state.catalogBusy);
  const error = useLocalAgentStore((state) => state.error);
  const refresh = useLocalAgentStore((state) => state.refresh);
  const sendMessage = useLocalAgentStore((state) => state.sendMessage);
  const setMessageFeedback = useLocalAgentStore((state) => state.setMessageFeedback);
  const respondInteraction = useLocalAgentStore((state) => state.respondInteraction);
  const respondApproval = useLocalAgentStore((state) => state.respondApproval);
  const respondPlan = useLocalAgentStore((state) => state.respondPlan);
  const cancelRun = useLocalAgentStore((state) => state.cancelRun);
  const selectProfile = useLocalAgentStore((state) => state.selectProfile);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<UserMessageAttachment[]>([]);
  const [pendingDirectoryPaths, setPendingDirectoryPaths] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [resourcePreview, setResourcePreview] = useState<ResourcePreviewState | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [uiActionError, setUiActionError] = useState<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const attachmentControlRef = useRef<HTMLDivElement | null>(null);
  const permissionControlRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const compositionActiveRef = useRef(false);
  const compositionCommitPendingRef = useRef(false);
  const compositionGuardFrameRef = useRef<number | null>(null);
  const activeViewRef = useRef<string | null>(sessionId);
  const followingLatestRef = useRef(true);
  const userDetachedFromLatestRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastTouchYRef = useRef<number | null>(null);
  const suppressScrollEventsUntilRef = useRef(0);
  const scrollFrameRef = useRef<number | null>(null);
  const scrollTimeoutRef = useRef<number | null>(null);
  const activeSummary = catalog.sessions.find((session) => session.id === sessionId);
  const activeProject = catalog.projects.find((project) => (
    project.id === (activeSummary?.projectId ?? draftProjectId)
  ));
  const title = activeSummary?.title.trim()
    || conversationTitle(projection?.messages, language);
  const conversationItems = useMemo(() => projectionItems(projection), [projection]);
  const hasConversationContent = conversationItems.length > 0
    || Boolean(projection?.assistantDraft)
    || Boolean(projection?.pendingInteraction)
    || Boolean(projection?.pendingApproval)
    || Boolean(projection?.pendingPlan)
    || Boolean(projection?.terminalError);
  const pendingInteraction = projection?.pendingInteraction ?? null;
  const pendingApproval = projection?.pendingApproval ?? null;
  const pendingPlan = projection?.pendingPlan ?? null;

  const setLatestFollowMode = useCallback((following: boolean) => {
    followingLatestRef.current = following;
    userDetachedFromLatestRef.current = !following;
    setFollowingLatest(following);
  }, []);

  const scrollToLatestNow = useCallback((behavior: ScrollBehavior = 'auto') => {
    const body = bodyRef.current;
    if (!body) return;
    suppressScrollEventsUntilRef.current = window.performance.now() + 220;
    body.scrollTo({ top: body.scrollHeight, behavior });
  }, []);

  const scheduleScrollToLatest = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (!followingLatestRef.current) return;
    scrollToLatestNow(behavior);
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      if (followingLatestRef.current) scrollToLatestNow(behavior);
    });
    if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
    scrollTimeoutRef.current = window.setTimeout(() => {
      scrollTimeoutRef.current = null;
      if (followingLatestRef.current) scrollToLatestNow('auto');
    }, 80);
  }, [scrollToLatestNow]);

  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    let timeout: number | null = null;

    const schedule = () => {
      if (cancelled) return;
      const current = useLocalAgentStore.getState().projection;
      const active = Boolean(
        current?.run && ['running', 'waiting'].includes(current.run.status),
      );
      const delay = document.visibilityState === 'hidden'
        ? 10_000
        : active
          ? 750
          : 4_000;
      timeout = window.setTimeout(() => {
        timeout = null;
        void refresh().finally(schedule);
      }, delay);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
      void refresh().finally(schedule);
    };

    schedule();
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      if (timeout !== null) window.clearTimeout(timeout);
    };
  }, [refresh, sessionId]);

  useEffect(() => {
    if (activeViewRef.current !== sessionId) {
      if (!submitting) {
        setPendingDirectoryPaths([]);
        setAttachments([]);
        setAttachmentMenuOpen(false);
        setAttachmentDialogOpen(false);
      }
      setLatestFollowMode(true);
      activeViewRef.current = sessionId;
    }
  }, [sessionId, setLatestFollowMode, submitting]);

  useEffect(() => {
    if (followingLatest) scheduleScrollToLatest();
  }, [followingLatest, projection?.assistantDraft?.content, projection?.revision, scheduleScrollToLatest]);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined' || !transcriptRef.current) return undefined;
    const observer = new ResizeObserver(() => {
      if (followingLatestRef.current) scheduleScrollToLatest();
    });
    observer.observe(transcriptRef.current);
    return () => observer.disconnect();
  }, [scheduleScrollToLatest]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) window.cancelAnimationFrame(scrollFrameRef.current);
    if (scrollTimeoutRef.current !== null) window.clearTimeout(scrollTimeoutRef.current);
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
    }
  }, []);

  useEffect(() => {
    if (!permissionMenuOpen && !attachmentMenuOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (permissionMenuOpen && !permissionControlRef.current?.contains(target)) {
        setPermissionMenuOpen(false);
      }
      if (attachmentMenuOpen && !attachmentControlRef.current?.contains(target)) {
        setAttachmentMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [attachmentMenuOpen, permissionMenuOpen]);

  useEffect(() => {
    if (pendingPlan || pendingInteraction || pendingApproval) {
      setAttachments([]);
      setPendingDirectoryPaths([]);
      setAttachmentMenuOpen(false);
      setAttachmentDialogOpen(false);
    }
  }, [pendingApproval, pendingInteraction, pendingPlan]);

  const submitDraft = async () => {
    const submittedText = draft;
    if (
      !submittedText.trim()
      || loading
      || submitting
      || catalogBusy
      || pendingApproval
      || (!selectedProfileId && !pendingInteraction && !pendingPlan)
      || compositionActiveRef.current
      || compositionCommitPendingRef.current
    ) return;
    const submittedAttachments = attachments;
    const submittedDirectoryPaths = pendingDirectoryPaths;
    setDraft('');
    setLatestFollowMode(true);
    try {
      await sendMessage(submittedText, submittedAttachments, submittedDirectoryPaths);
      setAttachments([]);
      setPendingDirectoryPaths([]);
      setAttachmentError(null);
    } catch {
      setDraft(submittedText);
    }
  };

  const beginComposition = () => {
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
      compositionGuardFrameRef.current = null;
    }
    compositionCommitPendingRef.current = false;
    compositionActiveRef.current = true;
  };

  const endComposition = () => {
    compositionActiveRef.current = false;
    compositionCommitPendingRef.current = true;
    if (compositionGuardFrameRef.current !== null) {
      window.cancelAnimationFrame(compositionGuardFrameRef.current);
    }
    compositionGuardFrameRef.current = window.requestAnimationFrame(() => {
      compositionGuardFrameRef.current = null;
      compositionCommitPendingRef.current = false;
    });
  };

  const insertFocusCommand = () => {
    const nextDraft = /^\/focus(?:\s|$)/u.test(draft)
      ? draft
      : `/focus ${draft}`;
    focusComposerDraft(nextDraft);
  };

  const selectFocusCommand = () => {
    focusComposerDraft('/focus ');
  };

  const focusComposerDraft = (nextDraft: string) => {
    setDraft(nextDraft);
    setAttachmentMenuOpen(false);
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(nextDraft.length, nextDraft.length);
    });
  };

  const focusCommandSuggestionVisible = shouldOfferFocusCommand(draft);

  const submitOnComposerEnter = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!shouldSubmitComposerKey({
      key: event.key,
      shiftKey: event.shiftKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
    }, {
      active: compositionActiveRef.current,
      commitPending: compositionCommitPendingRef.current,
    })) return;
    event.preventDefault();
    if (focusCommandSuggestionVisible) {
      selectFocusCommand();
      return;
    }
    void submitDraft();
  };

  const submitPlanDecision = useCallback(async (
    response: Extract<PlanResponse, { kind: 'confirm' | 'cancel' }>,
  ) => {
    if (!pendingPlan || submitting) return;
    try {
      await respondPlan(response);
      setDraft('');
    } catch {
      // The store preserves the authoritative command error for the shared error panel.
    }
  }, [pendingPlan, respondPlan, submitting]);

  useEffect(() => {
    if (!pendingPlan || submitting) return undefined;
    const ignorePlanOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape'
        || event.repeat
        || compositionActiveRef.current
        || event.isComposing
        || event.keyCode === 229
        || event.defaultPrevented
      ) return;
      event.preventDefault();
      void submitPlanDecision({ kind: 'cancel' });
    };
    window.addEventListener('keydown', ignorePlanOnEscape);
    return () => window.removeEventListener('keydown', ignorePlanOnEscape);
  }, [pendingPlan, submitPlanDecision, submitting]);

  const selectMessageAttachment = async (
    absolutePath: string,
    type: 'directory' | 'file',
  ) => {
    setAttachmentDialogOpen(false);
    if (pendingPlan || pendingInteraction || pendingApproval) return;
    if (type === 'directory') {
      setAttachmentError(null);
      setPendingDirectoryPaths((current) => (
        current.includes(absolutePath) ? current : [...current, absolutePath]
      ));
      return;
    }
    try {
      if (attachments.length >= 8) {
        throw new Error(t(language, 'agent.attachment.error.maxFiles'));
      }
      const result = await readMessageAttachmentFile(absolutePath);
      if (!result.ok || !result.data) {
        throw new Error(t(language, 'agent.attachment.error.readFile', {
          message: result.message ?? result.error ?? 'unknown',
        }));
      }
      if (result.data.content.includes('\0')) {
        throw new Error(t(language, 'agent.attachment.error.notText', {
          name: result.data.name,
        }));
      }
      const next = {
        attachmentId: nextAttachmentId(),
        name: result.data.name,
        mediaType: result.data.mediaType || 'text/plain',
        content: result.data.content,
      } satisfies UserMessageAttachment;
      const totalBytes = [...attachments, next].reduce(
        (total, attachment) => total + new TextEncoder().encode(attachment.content).byteLength,
        0,
      );
      if (totalBytes > 512 * 1024) {
        throw new Error(t(language, 'agent.attachment.error.totalSize'));
      }
      setAttachments((current) => [...current, next]);
      setAttachmentError(null);
    } catch (selectionError) {
      setAttachmentError(selectionError instanceof Error
        ? selectionError.message
        : String(selectionError));
    }
  };

  const scrollToLatest = () => {
    setLatestFollowMode(true);
    scheduleScrollToLatest('smooth');
  };

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

  const canCancel = Boolean(
    projection?.run && ['running', 'waiting'].includes(projection.run.status),
  );
  const canSend = Boolean(draft.trim())
    && !loading
    && !submitting
    && !catalogBusy
    && !pendingApproval
    && Boolean(selectedProfileId || pendingInteraction || pendingPlan);
  const showStopAction = canCancel && !pendingPlan && !draft.trim();

  const openWorkspaceResource = async (workspaceId: string, logicalPath: string) => {
    if (!sessionId) return;
    const requested = { workspaceId, logicalPath };
    setResourcePreview({ ...requested, status: 'loading' });
    try {
      const result = await readConversationResource(sessionId, workspaceId, logicalPath);
      setResourcePreview((current) => (
        current?.workspaceId === workspaceId && current.logicalPath === logicalPath
          ? { ...requested, status: 'ready', result }
          : current
      ));
    } catch (readError) {
      setResourcePreview((current) => (
        current?.workspaceId === workspaceId && current.logicalPath === logicalPath
          ? {
              ...requested,
              status: 'error',
              error: readError instanceof Error ? readError.message : String(readError),
            }
          : current
      ));
    }
  };

  return (
    <section className={`local-agent local-agent--${mode}${hasConversationContent ? '' : ' local-agent--empty'}`}>
      <header className="local-agent__header">
        <div className="local-agent__heading">
          <span className="local-agent__heading-mark"><DeepCodeShellIcon name="session" /></span>
          <div>
            <strong>{title}</strong>
            <span>{activeProject?.title ?? t(language, 'agent.chat.independent')}</span>
          </div>
        </div>
        <div className="local-agent__header-actions">
          <span className={`local-agent__run-label local-agent__run-label--${projection?.run?.status ?? 'idle'}`}>
            {projection
              ? runLabel(projection.run, language)
              : loading
                ? t(language, 'agent.chat.connecting')
                : t(language, 'agent.chat.new')}
          </span>
        </div>
      </header>

      <div
        ref={bodyRef}
        className="local-agent__body"
        aria-live="polite"
        onWheel={(event) => {
          if (event.deltaY < 0) setLatestFollowMode(false);
        }}
        onTouchStart={(event) => {
          lastTouchYRef.current = event.touches[0]?.clientY ?? null;
        }}
        onTouchMove={(event) => {
          const currentY = event.touches[0]?.clientY;
          const previousY = lastTouchYRef.current;
          if (currentY !== undefined) {
            if (previousY !== null && currentY > previousY + 2) setLatestFollowMode(false);
            lastTouchYRef.current = currentY;
          }
        }}
        onTouchEnd={() => {
          lastTouchYRef.current = null;
        }}
        onScroll={(event) => {
          const body = event.currentTarget;
          const scrolledUp = body.scrollTop < lastScrollTopRef.current - 2;
          lastScrollTopRef.current = body.scrollTop;
          const distanceFromLatest = body.scrollHeight - body.scrollTop - body.clientHeight;
          if (window.performance.now() < suppressScrollEventsUntilRef.current) return;
          if (scrolledUp) {
            setLatestFollowMode(false);
            return;
          }
          if (userDetachedFromLatestRef.current && distanceFromLatest <= 2) {
            setLatestFollowMode(true);
          }
        }}
      >
        <div ref={transcriptRef} className="local-agent__transcript">
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
                <MarkdownContent>{item.value.content}</MarkdownContent>
                {(item.value.attachments.length > 0
                  || item.value.directoryAttachments.length > 0) && (
                  <div className="local-agent__message-attachments">
                    {item.value.attachments.map((attachment) => (
                      <span key={attachment.attachmentId}>
                        <DeepCodeShellIcon name="artifact" />
                        {attachment.name}
                        <small>{formatBytes(attachment.byteLength, language)}</small>
                      </span>
                    ))}
                    {item.value.directoryAttachments.map((attachment) => (
                      <span className="local-agent__message-directory" key={attachment.workspaceId}>
                        <DeepCodeShellIcon name="folder" />
                        {attachment.displayName}
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
              <div><MarkdownContent>{item.value.content}</MarkdownContent></div>
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
              onOpenWorkspaceResource={openWorkspaceResource}
            />
          ))}
          {projection?.assistantDraft && (
            <article className="local-agent__message local-agent__message--assistant local-agent__message--draft">
              <div className="local-agent__message-content">
                <BufferedMarkdown
                  text={projection.assistantDraft.content}
                  streamIdentity={projection.assistantDraft.turnId}
                />
              </div>
            </article>
          )}
          {projection?.run?.status === 'running' && (
            <div className="local-agent__run-thinking" role="status" aria-live="polite">
              <span className="local-agent__run-spinner" aria-hidden="true" />
              <span>{t(language, 'agent.run.thinking')}</span>
            </div>
          )}
          {projection?.terminalError && (
            <article className="local-agent__terminal-error">
              <strong>{projection.terminalError.code}</strong>
              <span>{projection.terminalError.message}</span>
            </article>
          )}
          <div ref={messageEndRef} />
        </div>
        {!followingLatest && hasConversationContent && (
          <button
            type="button"
            className="local-agent__jump-latest"
            aria-label={t(language, 'agent.jumpLatest')}
            title={t(language, 'agent.jumpLatest')}
            onClick={scrollToLatest}
          >
            <DeepCodeShellIcon name="chevronDown" />
          </button>
        )}
      </div>

      <footer className={`local-agent__composer-shell${pendingPlan || pendingInteraction
        ? ' local-agent__composer-shell--decision'
        : ''}`}>
        {error && <div className="local-agent__error">{error}</div>}
        {attachmentError && <div className="local-agent__error">{attachmentError}</div>}
        {uiActionError && <div className="local-agent__error">{uiActionError}</div>}
        {(pendingPlan || pendingInteraction) && (
          <section className="local-agent__interaction-panel">
            <header className="local-agent__interaction-panel-heading">
              <strong>{pendingPlan
                ? t(language, 'agent.plan.confirmQuestion', { title: pendingPlan.title })
                : pendingInteraction?.prompt}</strong>
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
            <ol className="local-agent__interaction-options">
              {pendingPlan ? (
                <li>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => void submitPlanDecision({ kind: 'confirm' })}
                  >
                    <span className="local-agent__interaction-option-marker" aria-hidden="true">1</span>
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
                      <b>{option.label}</b>
                      {option.description && <small>{option.description}</small>}
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
        {!pendingPlan && !pendingInteraction && <div
          className="local-agent__composer"
          onMouseDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest('button, input, select, textarea, label, a, [role="button"]')) return;
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          {focusCommandSuggestionVisible && (
            <div
              className="local-agent__command-suggestions"
              role="listbox"
              aria-label={t(language, 'agent.context.focusCommand')}
            >
              <button
                type="button"
                role="option"
                aria-selected="true"
                onClick={selectFocusCommand}
              >
                <DeepCodeShellIcon name="activity" />
                <span>
                  <b>{t(language, 'agent.context.focusCommand')}</b>
                  <small>{t(language, 'agent.context.focusCommandDescription')}</small>
                </span>
                <kbd>/focus</kbd>
              </button>
            </div>
          )}
          {pendingApproval && (
            <div className="local-agent__decision">
              <div className="local-agent__decision-heading">
                <strong>{pendingApproval.preview.summary}</strong>
                <span>{t(language, 'agent.approval.required')}</span>
              </div>
              {pendingApproval.preview.logicalTargets.length > 0 && (
                <ul className="local-agent__decision-targets">
                  {pendingApproval.preview.logicalTargets.map((target) => (
                    <li key={target}>{target}</li>
                  ))}
                </ul>
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
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={Boolean(pendingApproval)}
            rows={pendingApproval ? 2 : 3}
            placeholder={pendingApproval
              ? t(language, 'agent.composer.placeholder.approval')
              : t(language, 'agent.composer.placeholder.task')}
            onChange={(event) => setDraft(event.target.value)}
            onCompositionStart={beginComposition}
            onCompositionEnd={endComposition}
            onKeyDown={submitOnComposerEnter}
          />
          {(attachments.length > 0 || pendingDirectoryPaths.length > 0) && (
            <div className="local-agent__draft-attachments">
              {attachments.map((attachment) => (
                <span key={attachment.attachmentId}>
                  <DeepCodeShellIcon name="artifact" />
                  {attachment.name}
                  <button
                    type="button"
                    aria-label={t(language, 'agent.attachment.remove', {
                      name: attachment.name,
                    })}
                    onClick={() => setAttachments((current) => current.filter((item) => (
                      item.attachmentId !== attachment.attachmentId
                    )))}
                  >×</button>
                </span>
              ))}
              {pendingDirectoryPaths.map((path) => (
                <span className="local-agent__draft-directory" key={path}>
                  <DeepCodeShellIcon name="folder" />
                  {t(language, 'agent.attachment.folder')} · {directoryDisplayName(path)}
                  <button
                    type="button"
                    aria-label={t(language, 'agent.attachment.removePendingDirectory')}
                    onClick={() => setPendingDirectoryPaths((current) => (
                      current.filter((candidate) => candidate !== path)
                    ))}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          <div className="local-agent__composer-footer">
            <div className="local-agent__composer-tools">
              <div ref={attachmentControlRef} className="local-agent__attachment-control">
                <button
                  type="button"
                  className="local-agent__attach"
                  aria-label={t(language, 'agent.attachment.menu')}
                  title={t(language, 'agent.attachment.menu')}
                  aria-expanded={attachmentMenuOpen}
                  aria-haspopup="menu"
                  disabled={Boolean(pendingApproval || catalogBusy)}
                  onClick={() => {
                    setAttachmentMenuOpen((open) => !open);
                    setPermissionMenuOpen(false);
                  }}
                >
                  <DeepCodeShellIcon name="plus" />
                </button>
                {attachmentMenuOpen && (
                  <div className="local-agent__attachment-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setAttachmentMenuOpen(false);
                        setAttachmentDialogOpen(true);
                      }}
                    >
                      <DeepCodeShellIcon name="paperclip" />
                      <span>
                        <b>{t(language, 'agent.attachment.filesAndFolders')}</b>
                        <small>{t(language, 'agent.attachment.pickerDescription')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={insertFocusCommand}
                    >
                      <DeepCodeShellIcon name="activity" />
                      <span>
                        <b>{t(language, 'agent.context.focusCommand')}</b>
                        <small>{t(language, 'agent.context.focusCommandDescription')}</small>
                      </span>
                    </button>
                  </div>
                )}
              </div>
              <div ref={permissionControlRef} className="local-agent__permission-control">
                <button
                  type="button"
                  className="local-agent__permission-summary"
                  aria-expanded={permissionMenuOpen}
                  onClick={() => {
                    setPermissionMenuOpen((open) => !open);
                    setAttachmentMenuOpen(false);
                  }}
                >
                  {t(
                    language,
                    runtimeEffectiveSettings['agent.permissions.workspaceMutation'] === 'allow'
                      ? 'agent.permission.summary.allow'
                      : 'agent.permission.summary.plan',
                  )}
                </button>
                {permissionMenuOpen && (
                  <div className="local-agent__permission-menu">
                    {settingsRestartRequired && (
                      <div className="local-agent__permission-restart-notice">
                        {t(language, 'agent.permission.restartRequired')}
                      </div>
                    )}
                    <div className="local-agent__permission-invariant">
                      <span>{t(language, 'agent.permission.workspaceRead')}</span>
                      <strong>{t(language, 'agent.permission.workspaceReadAllowed')}</strong>
                    </div>
                    {permissionSetting(
                      t(language, 'agent.permission.workspaceMutation'),
                      'agent.permissions.workspaceMutation',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        {
                          value: 'plan',
                          label: t(language, 'agent.permission.workspaceMutationPlan'),
                        },
                        {
                          value: 'allow',
                          label: t(language, 'agent.permission.workspaceMutationAllow'),
                        },
                      ],
                      'plan',
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.engineeringDecisions'),
                      'agent.permissions.engineeringDecisions',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        {
                          value: 'ask',
                          label: t(language, 'agent.permission.engineeringDecisionsAsk'),
                        },
                        {
                          value: 'delegate',
                          label: t(language, 'agent.permission.engineeringDecisionsDelegate'),
                        },
                      ],
                      'ask',
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.networkRead'),
                      'agent.permissions.networkRead',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        { value: 'allow', label: t(language, 'agent.permission.allow') },
                        { value: 'ask', label: t(language, 'agent.permission.ask') },
                        { value: 'deny', label: t(language, 'agent.permission.deny') },
                      ],
                      'ask',
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.externalEffects'),
                      'agent.permissions.external',
                      effectiveSettings,
                      patchUserSetting,
                      [
                        { value: 'allow', label: t(language, 'agent.permission.allow') },
                        { value: 'ask', label: t(language, 'agent.permission.ask') },
                        { value: 'deny', label: t(language, 'agent.permission.deny') },
                      ],
                      'ask',
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="local-agent__composer-actions">
              <SessionModelSelector
                language={language}
                profiles={profiles}
                selectedProfileId={selectedProfileId}
                contextUsage={projection?.contextUsage ?? null}
                contextCompositions={projection?.contextCompositions ?? []}
                busy={loading}
                onProfileChange={selectProfile}
              />
              <button
                type="button"
                className={`local-agent__send${showStopAction ? ' local-agent__send--stop' : ''}`}
                aria-label={showStopAction
                  ? t(language, 'agent.composer.stopCurrentRun')
                  : submitting
                    ? t(language, 'agent.composer.sending')
                    : t(language, 'agent.composer.send')}
                title={showStopAction
                  ? t(language, 'agent.composer.stop')
                  : t(language, 'agent.composer.sendEnter')}
                disabled={showStopAction ? submitting : !canSend}
                onClick={() => {
                  if (showStopAction) {
                    void cancelRun();
                    return;
                  }
                  void submitDraft();
                }}
              >
                <DeepCodeShellIcon name={showStopAction ? 'stop' : 'arrowUp'} />
              </button>
            </div>
          </div>
        </div>}
        {!pendingPlan && !pendingInteraction && (
          <div className="local-agent__composer-hint">
            {t(language, 'agent.composer.hint')}
          </div>
        )}
      </footer>
      {resourcePreview && (
        <div
          className="local-agent__resource-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setResourcePreview(null);
          }}
        >
          <section
            className="local-agent__resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t(language, 'agent.resource.preview')}
          >
            <header>
              <div>
                <strong>{resourcePreview.logicalPath}</strong>
                <span>{t(language, 'agent.resource.readOnly')}</span>
              </div>
              <button
                type="button"
                aria-label={t(language, 'window.close')}
                onClick={() => setResourcePreview(null)}
              >×</button>
            </header>
            <div className="local-agent__resource-body">
              {resourcePreview.status === 'loading' ? (
                <p>{t(language, 'agent.resource.reading')}</p>
              ) : resourcePreview.status === 'error' ? (
                <p className="local-agent__resource-error">{resourcePreview.error}</p>
              ) : (
                <>
                  <div className="local-agent__resource-meta">
                    <span>{formatBytes(resourcePreview.result.sizeBytes, language)}</span>
                    <span>
                      {t(language, 'agent.resource.lines', {
                        start: resourcePreview.result.startLine,
                        end: resourcePreview.result.endLine,
                      })}
                    </span>
                  </div>
                  <pre>{resourcePreview.result.content}</pre>
                </>
              )}
            </div>
          </section>
        </div>
      )}
      {attachmentDialogOpen && (
        <ProjectFolderDialog
          language={language}
          selectionMode="messageAttachment"
          onCancel={() => setAttachmentDialogOpen(false)}
          onSelect={(absolutePath, type) => {
            void selectMessageAttachment(absolutePath, type);
          }}
        />
      )}
    </section>
  );
};

interface ToolActivityGroupProps {
  activities: ActivityProjection[];
  language: UiLanguage;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

const ToolActivityGroup: React.FC<ToolActivityGroupProps> = ({
  activities,
  language,
  onOpenWorkspaceResource,
}) => {
  const terminal = activities.every((activity) => isTerminalActivity(activity.status));
  const userControlled = useRef(false);
  const [expanded, setExpanded] = useState(() => !terminal);
  const hasFailure = activities.some((activity) => (
    ['failed', 'denied', 'indeterminate'].includes(activity.status)
  ));
  const groupStatus = toolGroupStatus(activities);

  useEffect(() => {
    if (!userControlled.current) setExpanded(!terminal);
  }, [terminal]);

  return (
    <article className={`local-agent__tool-group${hasFailure ? ' local-agent__tool-group--failed' : ''}`}>
      <button
        type="button"
        className="local-agent__tool-group-summary"
        aria-expanded={expanded}
        onClick={() => {
          userControlled.current = true;
          setExpanded((current) => !current);
        }}
      >
        <span className="local-agent__tool-group-icon">
          <DeepCodeShellIcon name="tool" />
        </span>
        <strong>{toolGroupSummary(activities, language)}</strong>
        {groupStatus !== 'completed' && (
          <span>{toolActivityStatus(groupStatus, language)}</span>
        )}
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-group-items">
          {activities.map((activity) => (
            <ToolActivityEntry
              activity={activity}
              key={activity.activityId}
              language={language}
              onOpenWorkspaceResource={onOpenWorkspaceResource}
            />
          ))}
        </div>
      )}
    </article>
  );
};

interface ToolActivityEntryProps {
  activity: ActivityProjection;
  language: UiLanguage;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

const ToolActivityEntry: React.FC<ToolActivityEntryProps> = ({
  activity,
  language,
  onOpenWorkspaceResource,
}) => {
  const [expanded, setExpanded] = useState(false);
  const tool = activity.tool;
  const shell = tool?.shell;
  const result = shell?.result;
  return (
    <div className={`local-agent__tool-entry local-agent__tool-entry--${activity.status}`}>
      <button
        type="button"
        className="local-agent__tool-entry-heading"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
      >
        <strong>{toolActivitySummary(activity, language)}</strong>
        {activity.status !== 'completed' && (
          <span>{toolActivityStatus(activity.status, language)}</span>
        )}
        <span className="local-agent__tool-entry-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-entry-details">
          <dl>
            <div>
              <dt>{t(language, 'agent.tool.detail.operation')}</dt>
              <dd><code>{tool?.operation ?? activity.label}</code></dd>
            </div>
            {shell && (
              <>
                <div>
                  <dt>{t(language, 'agent.tool.shell.command')}</dt>
                  <dd><code>{shell.command}</code></dd>
                </div>
                <div>
                  <dt>{t(language, 'agent.tool.shell.cwd')}</dt>
                  <dd><code>{shell.cwd}</code></dd>
                </div>
                {result?.environment && (
                  <>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.environment')}</dt>
                      <dd>{t(language, 'agent.tool.shell.environmentValue', {
                        shell: result.environment.shell,
                      })}</dd>
                    </div>
                    <div>
                      <dt>{t(language, 'agent.tool.shell.writeScope')}</dt>
                      <dd>{t(language, 'agent.tool.shell.writeScopeValue')}</dd>
                    </div>
                  </>
                )}
              </>
            )}
          </dl>
          {tool?.resources.length ? (
            <div className="local-agent__tool-resources">
              {tool.resources.map((resource, index) => {
                const key = `${resource.kind}:${resource.workspaceId ?? ''}:${resource.logicalPath ?? resource.uri ?? resource.label}:${index}`;
                if (
                  resource.kind === 'workspacePath'
                  && resource.workspaceId
                  && resource.logicalPath
                ) {
                  return (
                    <button
                      type="button"
                      key={key}
                      onClick={() => onOpenWorkspaceResource(
                        resource.workspaceId!, resource.logicalPath!,
                      )}
                    >
                      {resource.label}
                    </button>
                  );
                }
                if (resource.kind === 'url' && resource.uri) {
                  return (
                    <a href={resource.uri} key={key} rel="noreferrer" target="_blank">
                      {resource.label}
                    </a>
                  );
                }
                return <span key={key}>{resource.label}</span>;
              })}
            </div>
          ) : null}
          {result && (
            <div className="local-agent__shell-result">
              <div className="local-agent__shell-result-meta">
                <span>{t(language, 'agent.tool.shell.exit', {
                  code: result.exitCode ?? t(language, 'agent.tool.shell.noExitCode'),
                })}</span>
                <span>{t(language, 'agent.tool.shell.duration', {
                  duration: result.durationMs,
                })}</span>
                {result.timedOut && <span>{t(language, 'agent.tool.shell.timedOut')}</span>}
                {result.truncated && <span>{t(language, 'agent.tool.shell.truncated')}</span>}
              </div>
              {result.stdout && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stdout')}</span>
                  <pre>{result.stdout}</pre>
                </section>
              )}
              {result.stderr && (
                <section>
                  <span>{t(language, 'agent.tool.shell.stderr')}</span>
                  <pre>{result.stderr}</pre>
                </section>
              )}
              {!result.stdout && !result.stderr && (
                <small>{t(language, 'agent.tool.shell.noOutput')}</small>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function permissionSetting(
  label: string,
  key: string,
  settings: Record<string, unknown>,
  patch: (key: string, value: string) => Promise<unknown>,
  options: readonly {value: string; label: string}[],
  defaultValue: string,
): React.ReactNode {
  return (
    <label>
      <span>{label}</span>
      <select
        value={String(settings[key] ?? defaultValue)}
        onChange={(event) => void patch(key, event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

function conversationTitle(
  messages: { role: string; content: string }[] | undefined,
  language: UiLanguage,
): string {
  const first = messages?.find((message) => message.role === 'user')?.content.trim();
  if (!first) return t(language, 'agent.session.newTitle');
  const line = first.split(/\r?\n/u, 1)[0].trim();
  return line.length > 34 ? `${line.slice(0, 34)}…` : line;
}

function runLabel(run: RunProjection | null, language: UiLanguage): string {
  if (!run) return t(language, 'agent.run.status.idle');
  if (run.status === 'waiting' && run.waitingReason === 'userInput') {
    return t(language, 'agent.run.status.waitingUserInput');
  }
  if (run.status === 'waiting' && run.waitingReason === 'plan') {
    return t(language, 'agent.run.status.waitingPlan');
  }
  return t(language, `agent.run.status.${run.status}`);
}

function samePlanReference(
  reference: { planId: string; revision: number } | null | undefined,
  plan: { planId: string; revision: number },
): boolean {
  return reference?.planId === plan.planId && reference.revision === plan.revision;
}

type RawProjectionItem =
  | { type: 'message'; sequence: number; value: SessionProjection['messages'][number] }
  | { type: 'narrative'; sequence: number; value: SessionProjection['narratives'][number] }
  | { type: 'plan'; sequence: number; value: SessionProjection['plans'][number] }
  | { type: 'tool'; sequence: number; value: ActivityProjection };

type ProjectionItem =
  | Exclude<RawProjectionItem, { type: 'tool' }>
  | {
      type: 'toolGroup';
      sequence: number;
      groupId: string;
      values: ActivityProjection[];
    };

function projectionItems(projection: SessionProjection | null): ProjectionItem[] {
  if (!projection) return [];
  const ordered: RawProjectionItem[] = [
    ...projection.messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((value): RawProjectionItem => ({ type: 'message', sequence: value.sequence, value })),
    ...projection.narratives.map((value): RawProjectionItem => ({
      type: 'narrative', sequence: value.sequence, value,
    })),
    ...projection.plans.map((value): RawProjectionItem => ({
      type: 'plan', sequence: value.sequence, value,
    })),
    ...projection.activities
      .filter((activity) => activity.kind === 'tool')
      .map((value): RawProjectionItem => ({ type: 'tool', sequence: value.sequence, value })),
  ].sort((left, right) => left.sequence - right.sequence);
  return ordered.reduce<ProjectionItem[]>((items, item) => {
    if (item.type !== 'tool') {
      items.push(item);
      return items;
    }
    const previous = items.at(-1);
    if (previous?.type === 'toolGroup') {
      previous.values.push(item.value);
      return items;
    }
    items.push({
      type: 'toolGroup',
      sequence: item.sequence,
      groupId: `tool-group:${item.value.activityId}`,
      values: [item.value],
    });
    return items;
  }, []);
}

function toolGroupSummary(
  activities: ActivityProjection[],
  language: UiLanguage,
): string {
  const status = toolGroupStatus(activities);
  const operation = activities.length === 1
    ? (activities[0].tool?.operation ?? activities[0].label)
    : null;
  if (status === 'active') {
    if (operation) return t(language, 'agent.tool.summary.activeOne', { operation });
    return t(language, 'agent.tool.summary.activeMany', { count: activities.length });
  }
  if (status === 'requested') {
    if (operation) return t(language, 'agent.tool.summary.requestedOne', { operation });
    return t(language, 'agent.tool.summary.requestedMany', { count: activities.length });
  }
  if (status === 'waiting') {
    if (operation) return t(language, 'agent.tool.summary.waitingOne', { operation });
    return t(language, 'agent.tool.summary.waitingMany', { count: activities.length });
  }
  if (activities.length === 1) {
    return toolActivitySummary(activities[0], language);
  }
  if (status === 'completed') {
    const hasShell = activities.some((activity) => (
      activity.tool?.operation === 'process.shell'
    ));
    const editCount = activities.filter((activity) => (
      isFileMutationOperation(activity.tool?.operation)
    )).length;
    if (hasShell && editCount > 0) {
      return t(language, 'agent.tool.summary.editedAndRan');
    }
    if (editCount === activities.length) {
      return t(language, 'agent.tool.summary.editedMany', { count: editCount });
    }
  }
  return t(language, 'agent.tool.summary.usedMany', { count: activities.length });
}

function toolActivitySummary(activity: ActivityProjection, language: UiLanguage): string {
  const operation = activity.tool?.operation ?? activity.label;
  const target = activity.tool?.resources[0]?.label;
  const command = activity.tool?.shell?.command;
  if (activity.status === 'completed') {
    if (operation === 'process.shell' && command) {
      return t(language, 'agent.tool.activity.ranCommand', { command });
    }
    if (operation === 'fs.ensure_directory' && target) {
      return t(language, 'agent.tool.activity.createdDirectory', { path: target });
    }
    if (operation === 'fs.delete' && target) {
      return t(language, 'agent.tool.activity.deletedPath', { path: target });
    }
    if (isFileMutationOperation(operation) && target) {
      return t(language, 'agent.tool.activity.editedPath', { path: target });
    }
    if (operation === 'fs.read' && target) {
      return t(language, 'agent.tool.activity.readPath', { path: target });
    }
    if (operation === 'fs.list' && target) {
      return t(language, 'agent.tool.activity.readDirectory', { path: target });
    }
    if (operation === 'fs.stat' && target) {
      return t(language, 'agent.tool.activity.inspectedPath', { path: target });
    }
    return t(language, 'agent.tool.summary.usedOne', { operation });
  }
  if (['failed', 'denied', 'indeterminate', 'cancelled'].includes(activity.status)) {
    if (operation === 'process.shell' && command) {
      return t(language, 'agent.tool.activity.commandDidNotComplete', { command });
    }
    return t(language, 'agent.tool.activity.didNotComplete', {
      operation,
      target: target ? ` · ${target}` : '',
    });
  }
  if (operation === 'process.shell' && command) {
    return t(language, 'agent.tool.activity.runningCommand', { command });
  }
  return t(language, 'agent.tool.activity.runningOperation', {
    operation,
    target: target ? ` · ${target}` : '',
  });
}

function isFileMutationOperation(operation: string | undefined): boolean {
  return operation !== undefined && [
    'fs.create',
    'fs.write',
    'fs.edit',
    'fs.ensure_directory',
    'fs.delete',
  ].includes(operation);
}

function isTerminalActivity(status: ActivityProjection['status']): boolean {
  return ['completed', 'denied', 'failed', 'cancelled', 'indeterminate'].includes(status);
}

function toolActivityStatus(
  status: ActivityProjection['status'],
  language: UiLanguage,
): string {
  return t(language, `agent.tool.status.${status}`);
}

function toolGroupStatus(
  activities: ActivityProjection[],
): ActivityProjection['status'] {
  const priority: ActivityProjection['status'][] = [
    'active',
    'waiting',
    'requested',
    'failed',
    'denied',
    'indeterminate',
    'cancelled',
    'completed',
  ];
  return priority.find((status) => activities.some((activity) => activity.status === status))
    ?? 'indeterminate';
}

function nextAttachmentId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `attachment:${random}`;
}

function directoryDisplayName(absolutePath: string): string {
  const normalized = absolutePath.replace(/[\\/]+$/u, '');
  return normalized.split(/[\\/]/u).at(-1) || absolutePath;
}

function formatBytes(value: number, language: UiLanguage): string {
  if (value < 1024) {
    return t(language, 'agent.attachment.size.bytes', {
      value: value.toLocaleString(language),
    });
  }
  return t(language, 'agent.attachment.size.kibibytes', {
    value: Math.ceil(value / 1024).toLocaleString(language),
  });
}

type ResourcePreviewState =
  | {
      workspaceId: string;
      logicalPath: string;
      status: 'loading';
    }
  | {
      workspaceId: string;
      logicalPath: string;
      status: 'ready';
      result: ConversationResourceReadResult;
    }
  | {
      workspaceId: string;
      logicalPath: string;
      status: 'error';
      error: string;
    };

export default LocalAgentPanel;
