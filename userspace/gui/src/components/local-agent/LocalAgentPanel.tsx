import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityProjection,
  MessageFeedback,
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
import {
  readConversationResource,
  type ConversationResourceReadResult,
} from '../../services/localAgentApi';
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
  const attachSessionDirectory = useLocalAgentStore((state) => state.attachSessionDirectory);
  const detachSessionDirectory = useLocalAgentStore((state) => state.detachSessionDirectory);
  const respondApproval = useLocalAgentStore((state) => state.respondApproval);
  const respondPlan = useLocalAgentStore((state) => state.respondPlan);
  const ignorePlan = useLocalAgentStore((state) => state.ignorePlan);
  const cancelRun = useLocalAgentStore((state) => state.cancelRun);
  const selectProfile = useLocalAgentStore((state) => state.selectProfile);
  const [draft, setDraft] = useState('');
  const [attachments, setAttachments] = useState<UserMessageAttachment[]>([]);
  const [pendingDirectoryPaths, setPendingDirectoryPaths] = useState<string[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [permissionMenuOpen, setPermissionMenuOpen] = useState(false);
  const [followingLatest, setFollowingLatest] = useState(true);
  const [selectedPlanOptionId, setSelectedPlanOptionId] = useState<string | null>(null);
  const [resourcePreview, setResourcePreview] = useState<ResourcePreviewState | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [uiActionError, setUiActionError] = useState<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentControlRef = useRef<HTMLDivElement | null>(null);
  const permissionControlRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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
  const activeRun = projection?.run && ['running', 'waiting'].includes(projection.run.status)
    ? projection.run
    : null;
  const runWorkspaceIds = new Set(
    activeRun?.workspaceBindings.map((binding) => binding.workspaceId) ?? [],
  );
  const effectiveWorkspaceIds = new Set(
    projection?.workspaceBindings.map((binding) => binding.workspaceId) ?? [],
  );
  const directoryIndexChangeDeferred = Boolean(activeRun) && (
    [...runWorkspaceIds].some((workspaceId) => !effectiveWorkspaceIds.has(workspaceId))
    || [...effectiveWorkspaceIds].some((workspaceId) => !runWorkspaceIds.has(workspaceId))
  );

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
    const id = window.setInterval(() => void refresh(), 500);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    if (activeViewRef.current !== sessionId) {
      if (!submitting) {
        setPendingDirectoryPaths([]);
        setAttachments([]);
        setAttachmentMenuOpen(false);
        setFolderDialogOpen(false);
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
  }, []);

  useEffect(() => {
    if (!attachmentMenuOpen && !permissionMenuOpen) return undefined;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (attachmentMenuOpen && !attachmentControlRef.current?.contains(target)) {
        setAttachmentMenuOpen(false);
      }
      if (permissionMenuOpen && !permissionControlRef.current?.contains(target)) {
        setPermissionMenuOpen(false);
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
    }
  }, [pendingApproval, pendingInteraction, pendingPlan]);

  useEffect(() => {
    setSelectedPlanOptionId(null);
  }, [pendingPlan?.planId]);

  const submitDraft = async () => {
    const text = draft.trim();
    const numericPlanOption = pendingPlan && /^\d+$/u.test(text)
      ? pendingPlan.options[Number.parseInt(text, 10) - 1]
      : undefined;
    const selectedPlanOption = numericPlanOption ?? pendingPlan?.options.find((option) => (
      option.optionId === selectedPlanOptionId
    ));
    if ((!text && !selectedPlanOption) || submitting) return;
    const submittedAttachments = attachments;
    const submittedDirectoryPaths = pendingDirectoryPaths;
    setDraft('');
    setLatestFollowMode(true);
    try {
      if (pendingPlan) {
        await respondPlan(numericPlanOption
          ? { kind: 'select', optionId: numericPlanOption.optionId }
          : text
          ? {
              kind: 'feedback',
              text,
              ...(selectedPlanOption ? { optionId: selectedPlanOption.optionId } : {}),
            }
          : { kind: 'select', optionId: selectedPlanOption!.optionId });
      } else {
        await sendMessage(text, submittedAttachments, submittedDirectoryPaths);
      }
      setSelectedPlanOptionId(null);
      setAttachments([]);
      setPendingDirectoryPaths([]);
      setAttachmentError(null);
    } catch {
      setDraft(text);
    }
  };

  const selectOrConfirmPlanOption = async (optionId: string) => {
    if (!pendingPlan || submitting) return;
    if (selectedPlanOptionId !== optionId) {
      setSelectedPlanOptionId(optionId);
      textareaRef.current?.focus();
      return;
    }
    const adjustment = draft.trim();
    setLatestFollowMode(true);
    try {
      await respondPlan(adjustment
        ? { kind: 'feedback', text: adjustment, optionId }
        : { kind: 'select', optionId });
      setSelectedPlanOptionId(null);
      setDraft('');
    } catch {
      // Store exposes the canonical command rejection in the shared error region.
    }
  };

  const submitIgnorePlan = async () => {
    if (!pendingPlan || submitting) return;
    setDraft('');
    try {
      await ignorePlan();
      setSelectedPlanOptionId(null);
    } catch {
      // Store exposes the canonical command rejection in the shared error region.
    }
  };

  const selectAttachments = async (files: FileList | null) => {
    if (!files?.length || pendingPlan || pendingInteraction || pendingApproval) return;
    try {
      const remaining = 8 - attachments.length;
      if (remaining <= 0 || files.length > remaining) {
        throw new Error(t(language, 'agent.attachment.error.maxFiles'));
      }
      const next = await Promise.all([...files].map(async (file) => {
        const content = await file.text();
        if (content.includes('\0')) {
          throw new Error(t(language, 'agent.attachment.error.notText', {
            name: file.name,
          }));
        }
        return {
          attachmentId: nextAttachmentId(),
          name: file.name,
          mediaType: file.type || 'text/plain',
          content,
        } satisfies UserMessageAttachment;
      }));
      const totalBytes = [...attachments, ...next].reduce(
        (total, attachment) => total + new TextEncoder().encode(attachment.content).byteLength,
        0,
      );
      if (totalBytes > 512 * 1024) {
        throw new Error(t(language, 'agent.attachment.error.totalSize'));
      }
      setAttachments((current) => [...current, ...next]);
      setAttachmentError(null);
    } catch (selectionError) {
      setAttachmentError(selectionError instanceof Error
        ? selectionError.message
        : String(selectionError));
    }
  };

  const selectDirectoryIndex = async (absolutePath: string) => {
    setFolderDialogOpen(false);
    setAttachmentMenuOpen(false);
    setAttachmentError(null);
    try {
      if (sessionId) {
        await attachSessionDirectory(absolutePath);
      } else {
        setPendingDirectoryPaths((current) => (
          current.includes(absolutePath) ? current : [...current, absolutePath]
        ));
      }
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
  const hasSelectedPlanOption = Boolean(pendingPlan?.options.some((option) => (
    option.optionId === selectedPlanOptionId
  )));
  const canSend = Boolean(draft.trim() || hasSelectedPlanOption)
    && !submitting
    && !catalogBusy
    && !pendingApproval
    && Boolean(selectedProfileId || pendingPlan || pendingInteraction);
  const showStopAction = canCancel && !draft.trim() && !hasSelectedPlanOption;

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
                {item.value.attachments.length > 0 && (
                  <div className="local-agent__message-attachments">
                    {item.value.attachments.map((attachment) => (
                      <span key={attachment.attachmentId}>
                        {attachment.name}
                        <small>{formatBytes(attachment.byteLength, language)}</small>
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

      <footer className="local-agent__composer-shell">
        {error && <div className="local-agent__error">{error}</div>}
        {attachmentError && <div className="local-agent__error">{attachmentError}</div>}
        {uiActionError && <div className="local-agent__error">{uiActionError}</div>}
        <div
          className="local-agent__composer"
          onMouseDown={(event) => {
            const target = event.target as HTMLElement;
            if (target.closest('button, input, select, textarea, label, a, [role="button"]')) return;
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          {pendingPlan && (
            <div className="local-agent__decision">
              <div className="local-agent__decision-heading">
                <strong>{pendingPlan.prompt}</strong>
                <span>
                  {t(language, 'agent.plan.confirmHint')}
                </span>
              </div>
              <ol>
                {pendingPlan.options.map((option, index) => (
                  <li key={option.optionId}>
                    <button
                      type="button"
                      className={selectedPlanOptionId === option.optionId ? 'is-selected' : ''}
                      aria-pressed={selectedPlanOptionId === option.optionId}
                      disabled={submitting}
                      onClick={() => void selectOrConfirmPlanOption(option.optionId)}
                    >
                      <span className="local-agent__plan-option-marker" aria-hidden="true">{index + 1}</span>
                      <span>
                        <b>{option.label}</b>
                        {option.description && <small>{option.description}</small>}
                        {option.operationsDisplay.length > 0 && (
                          <small>
                            {t(language, 'agent.plan.operationCount', {
                              count: option.operationsDisplay.length,
                            })}
                          </small>
                        )}
                      </span>
                      <span className="local-agent__plan-option-confirm" aria-hidden="true">
                        <DeepCodeShellIcon name="chevronRight" />
                      </span>
                    </button>
                    {option.operationsDisplay.length > 0 && (
                      <details className="local-agent__plan-operations">
                        <summary>
                          {t(language, 'agent.plan.reviewTargets')}
                        </summary>
                        <ul>
                          {option.operationsDisplay.map((operation) => (
                            <li key={operation}><code>{operation}</code></li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {pendingInteraction && (
            <div className="local-agent__decision">
              <div className="local-agent__decision-heading">
                <strong>{pendingInteraction.prompt}</strong>
                <span>{t(language, 'agent.interaction.inputNeeded')}</span>
              </div>
              {pendingInteraction.options && pendingInteraction.options.length > 0 && (
                <ol>
                  {pendingInteraction.options.map((option, index) => (
                    <li key={option.id}>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => {
                          setDraft(option.label);
                          textareaRef.current?.focus();
                        }}
                      >
                        <span className="local-agent__plan-option-marker" aria-hidden="true">{index + 1}</span>
                        <span>
                          <b>{option.label}</b>
                          {option.description && <small>{option.description}</small>}
                        </span>
                        <span className="local-agent__plan-option-confirm" aria-hidden="true">
                          <DeepCodeShellIcon name="chevronRight" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
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
            disabled={loading || profiles.length === 0 || Boolean(pendingApproval)}
            rows={pendingPlan || pendingInteraction || pendingApproval ? 2 : 3}
            placeholder={pendingPlan
              ? t(language, 'agent.composer.placeholder.plan')
              : pendingInteraction
                ? t(language, 'agent.composer.placeholder.interaction')
                : pendingApproval
                  ? t(language, 'agent.composer.placeholder.approval')
                  : t(language, 'agent.composer.placeholder.task')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && pendingPlan && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitIgnorePlan();
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submitDraft();
              }
            }}
          />
          {attachments.length > 0 && (
            <div className="local-agent__draft-attachments">
              {attachments.map((attachment) => (
                <span key={attachment.attachmentId}>
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
            </div>
          )}
          {(projection?.sessionDirectoryIndexes.length || pendingDirectoryPaths.length) ? (
            <div className="local-agent__draft-attachments local-agent__directory-indexes">
              {projection?.sessionDirectoryIndexes.map((binding) => (
                <span key={binding.workspaceId}>
                  {t(language, 'agent.attachment.folder')} · {binding.displayName}
                  {activeRun && !runWorkspaceIds.has(binding.workspaceId) && (
                    <small>{t(language, 'agent.attachment.nextRun')}</small>
                  )}
                  <button
                    type="button"
                    disabled={catalogBusy}
                    aria-label={t(language, 'agent.attachment.removeDirectoryIndex', {
                      name: binding.displayName,
                    })}
                    onClick={() => void detachSessionDirectory(binding.workspaceId)}
                  >×</button>
                </span>
              ))}
              {pendingDirectoryPaths.map((path) => (
                <span key={path}>
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
          ) : null}
          {directoryIndexChangeDeferred && (
            <small className="local-agent__directory-index-note">
              {t(language, 'agent.attachment.deferred')}
            </small>
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
                  disabled={Boolean(pendingPlan || pendingInteraction || pendingApproval || catalogBusy)}
                  onClick={() => {
                    setAttachmentMenuOpen((open) => !open);
                    setPermissionMenuOpen(false);
                  }}
                >
                  <DeepCodeShellIcon name="plus" />
                </button>
                <input
                  ref={attachmentInputRef}
                  className="local-agent__attachment-input"
                  type="file"
                  multiple
                  onChange={(event) => {
                    void selectAttachments(event.target.files);
                    event.target.value = '';
                  }}
                />
                {attachmentMenuOpen && (
                  <div className="local-agent__attachment-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setAttachmentMenuOpen(false);
                        attachmentInputRef.current?.click();
                      }}
                    >
                      <DeepCodeShellIcon name="artifact" />
                      <span>
                        <strong>{t(language, 'agent.attachment.addFiles')}</strong>
                        <small>{t(language, 'agent.attachment.fileHint')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setAttachmentMenuOpen(false);
                        setFolderDialogOpen(true);
                      }}
                    >
                      <DeepCodeShellIcon name="folder" />
                      <span>
                        <strong>{t(language, 'agent.attachment.addFolder')}</strong>
                        <small>{t(language, 'agent.attachment.folderHint')}</small>
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
                  {t(language, 'agent.permission.summary')}
                </button>
                {permissionMenuOpen && (
                  <div className="local-agent__permission-menu">
                    <div className="local-agent__permission-invariant">
                      <span>{t(language, 'agent.permission.workspaceRead')}</span>
                      <strong>{t(language, 'agent.permission.workspaceReadAllowed')}</strong>
                    </div>
                    <div className="local-agent__permission-invariant">
                      <span>{t(language, 'agent.permission.workspaceMutation')}</span>
                      <strong>{t(language, 'agent.permission.workspaceMutationPlanGate')}</strong>
                    </div>
                    {permissionSetting(
                      t(language, 'agent.permission.networkRead'),
                      'agent.permissions.networkRead',
                      effectiveSettings,
                      patchUserSetting,
                      language,
                    )}
                    {permissionSetting(
                      t(language, 'agent.permission.externalEffects'),
                      'agent.permissions.external',
                      effectiveSettings,
                      patchUserSetting,
                      language,
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="local-agent__composer-actions">
              {pendingPlan && (
                <button
                  type="button"
                  className="local-agent__plan-ignore"
                  disabled={submitting}
                  onClick={() => void submitIgnorePlan()}
                >
                  {t(language, 'agent.plan.ignore')}
                </button>
              )}
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
        </div>
        <div className="local-agent__composer-hint">
          {t(language, 'agent.composer.hint')}
        </div>
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
      {folderDialogOpen && (
        <ProjectFolderDialog
          language={language}
          onCancel={() => setFolderDialogOpen(false)}
          onSelect={(absolutePath) => void selectDirectoryIndex(absolutePath)}
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
        <span>{toolActivityStatus(groupStatus, language)}</span>
        <span className="local-agent__tool-group-chevron" aria-hidden="true">
          <DeepCodeShellIcon name="chevronRight" />
        </span>
      </button>
      {expanded && (
        <div className="local-agent__tool-group-items">
          {activities.map((activity) => (
            <div
              className={`local-agent__tool-entry local-agent__tool-entry--${activity.status}`}
              key={activity.activityId}
            >
              <div className="local-agent__tool-entry-heading">
                <strong>{activity.tool?.operation ?? activity.label}</strong>
                <span>{toolActivityStatus(activity.status, language)}</span>
              </div>
              {activity.tool?.resources.length ? (
                <div className="local-agent__tool-resources">
                  {activity.tool.resources.map((resource, index) => {
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
            </div>
          ))}
        </div>
      )}
    </article>
  );
};

function permissionSetting(
  label: string,
  key: 'agent.permissions.networkRead' | 'agent.permissions.external',
  settings: Record<string, unknown>,
  patch: (key: string, value: string) => Promise<unknown>,
  language: UiLanguage,
): React.ReactNode {
  return (
    <label>
      <span>{label}</span>
      <select value={String(settings[key] ?? 'ask')} onChange={(event) => void patch(key, event.target.value)}>
        <option value="allow">{t(language, 'agent.permission.allow')}</option>
        <option value="ask">{t(language, 'agent.permission.ask')}</option>
        <option value="deny">{t(language, 'agent.permission.deny')}</option>
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

type RawProjectionItem =
  | { type: 'message'; sequence: number; value: SessionProjection['messages'][number] }
  | { type: 'narrative'; sequence: number; value: SessionProjection['narratives'][number] }
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
    return t(language, 'agent.tool.summary.usedOne', { operation });
  }
  return t(language, 'agent.tool.summary.usedMany', { count: activities.length });
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
