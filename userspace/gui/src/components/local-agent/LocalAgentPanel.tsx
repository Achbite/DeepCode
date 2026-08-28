import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActivityProjection,
  MessageFeedback,
  RunProjection,
  SessionProjection,
  UserMessageAttachment,
} from '@deepcode/protocol';
import { normalizeUiLanguage } from '../../i18n';
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
  const zh = language === 'zh-CN';
  const activeSummary = catalog.sessions.find((session) => session.id === sessionId);
  const activeProject = catalog.projects.find((project) => (
    project.id === (activeSummary?.projectId ?? draftProjectId)
  ));
  const title = activeSummary?.title.trim()
    || projection?.display.title.trim()
    || conversationTitle(projection?.messages, zh);
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
        throw new Error(zh ? '单次消息最多附加 8 个文件。' : 'Attach at most 8 files per message.');
      }
      const next = await Promise.all([...files].map(async (file) => {
        const content = await file.text();
        if (content.includes('\0')) {
          throw new Error(zh
            ? `“${file.name}”不是可直接附加的文本文件。`
            : `“${file.name}” is not a text attachment.`);
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
        throw new Error(zh
          ? '附件文本总计不能超过 512 KiB。'
          : 'Attachment text cannot exceed 512 KiB in total.');
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
            <span>{activeProject?.title ?? (zh ? '独立对话' : 'Independent chat')}</span>
          </div>
        </div>
        <div className="local-agent__header-actions">
          <span className={`local-agent__run-label local-agent__run-label--${projection?.run?.status ?? 'idle'}`}>
            {projection
              ? runLabel(projection.run, zh)
              : loading
                ? (zh ? '连接中' : 'Connecting')
                : (zh ? '新对话' : 'New chat')}
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
            <div className="local-agent__empty">{zh ? '正在打开会话…' : 'Opening session…'}</div>
          )}
          {!hasConversationContent && !loading && (
            <div className="local-agent__empty local-agent__empty--welcome">
              <strong>
                {activeProject
                  ? (zh
                    ? `我们要在 ${activeProject.title} 中做些什么？`
                    : `What shall we do in ${activeProject.title}?`)
                  : (zh ? '我们要在 DeepCode 中做些什么？' : 'What shall we do in DeepCode?')}
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
                        <small>{formatBytes(attachment.byteLength)}</small>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {item.value.role === 'assistant' && (
                <div className="local-agent__message-actions" aria-label={zh ? '消息操作' : 'Message actions'}>
                  <button
                    type="button"
                    title={zh ? '复制' : 'Copy'}
                    aria-label={copiedMessageId === item.value.messageId
                      ? (zh ? '已复制' : 'Copied')
                      : (zh ? '复制回答' : 'Copy response')}
                    onClick={() => void copyAssistantMessage(item.value.messageId, item.value.content)}
                  >
                    <DeepCodeShellIcon name="copy" />
                  </button>
                  <button
                        type="button"
                        className={item.value.feedback === 'up' ? 'is-selected' : ''}
                        aria-pressed={item.value.feedback === 'up'}
                        title={zh ? '赞' : 'Helpful'}
                        aria-label={zh ? '赞' : 'Helpful'}
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
                        title={zh ? '踩' : 'Not helpful'}
                        aria-label={zh ? '踩' : 'Not helpful'}
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
              zh={zh}
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
              <span>{zh ? '正在思考…' : 'Thinking…'}</span>
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
            aria-label={zh ? '前往最新消息' : 'Jump to latest message'}
            title={zh ? '前往最新消息' : 'Jump to latest message'}
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
                  {zh
                    ? '首次点击选择，再次点击或按 Enter 确认'
                    : 'Click once to select; click again or press Enter to confirm'}
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
                            {zh
                              ? `${option.operationsDisplay.length} 项精确操作`
                              : `${option.operationsDisplay.length} exact operation(s)`}
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
                          {zh ? '查看操作目标' : 'Review operation targets'}
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
                <span>{zh ? '需要你的决定' : 'Your input is needed'}</span>
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
                <span>{zh ? '需要你批准此操作' : 'This action needs your approval'}</span>
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
                >{zh ? '拒绝' : 'Deny'}</button>
                <button
                  type="button"
                  className="local-agent__button--primary"
                  disabled={submitting}
                  onClick={() => void respondApproval('allow')}
                >{zh ? '允许' : 'Allow'}</button>
              </div>
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={draft}
            disabled={loading || profiles.length === 0 || Boolean(pendingApproval)}
            rows={pendingPlan || pendingInteraction || pendingApproval ? 2 : 3}
            placeholder={pendingPlan
              ? (zh ? '输入选项编号，或直接说明如何调整计划…' : 'Enter an option number, or describe revisions…')
              : pendingInteraction
                ? (zh ? '输入你的回应…' : 'Enter your response…')
                : pendingApproval
                  ? (zh ? '请允许或拒绝上述操作。' : 'Allow or deny the action above.')
                : (zh ? '描述要完成的编码任务…' : 'Describe a coding task…')}
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
                    aria-label={zh ? `移除 ${attachment.name}` : `Remove ${attachment.name}`}
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
                  {zh ? '目录' : 'Folder'} · {binding.displayName}
                  {activeRun && !runWorkspaceIds.has(binding.workspaceId) && (
                    <small>{zh ? '下轮生效' : 'Next run'}</small>
                  )}
                  <button
                    type="button"
                    disabled={catalogBusy}
                    aria-label={zh
                      ? `移除目录索引 ${binding.displayName}`
                      : `Remove folder index ${binding.displayName}`}
                    onClick={() => void detachSessionDirectory(binding.workspaceId)}
                  >×</button>
                </span>
              ))}
              {pendingDirectoryPaths.map((path) => (
                <span key={path}>
                  {zh ? '目录' : 'Folder'} · {directoryDisplayName(path)}
                  <button
                    type="button"
                    aria-label={zh ? '移除待附加目录' : 'Remove pending folder'}
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
              {zh
                ? '目录索引变化从下一轮生效；当前运行继续使用启动时冻结的目录集合。'
                : 'Directory-index changes apply next run; the active run keeps its frozen start snapshot.'}
            </small>
          )}
          <div className="local-agent__composer-footer">
            <div className="local-agent__composer-tools">
              <div ref={attachmentControlRef} className="local-agent__attachment-control">
                <button
                  type="button"
                  className="local-agent__attach"
                  aria-label={zh ? '附加文件或目录' : 'Attach files or folders'}
                  title={zh ? '附加文件或目录' : 'Attach files or folders'}
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
                        <strong>{zh ? '添加文件' : 'Add files'}</strong>
                        <small>{zh ? '作为本条消息的内容快照' : 'Immutable content snapshots for this message'}</small>
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
                        <strong>{zh ? '添加文件夹' : 'Add folder'}</strong>
                        <small>{zh ? '作为此对话的目录索引' : 'Attach as a directory index for this conversation'}</small>
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
                  {zh ? '读取：工作区内允许 · 写入：Plan 门禁' : 'Read: bound workspaces · Write: Plan-gated'}
                </button>
                {permissionMenuOpen && (
                  <div className="local-agent__permission-menu">
                    <div className="local-agent__permission-invariant">
                      <span>{zh ? '工作区读取' : 'Workspace read'}</span>
                      <strong>{zh ? '绑定目录内允许' : 'Allowed when bound'}</strong>
                    </div>
                    <div className="local-agent__permission-invariant">
                      <span>{zh ? '工作区修改' : 'Workspace mutation'}</span>
                      <strong>{zh ? '结构化 Plan 门禁' : 'Structured Plan gate'}</strong>
                    </div>
                    {permissionSetting(
                      zh ? '网络读取' : 'Network read',
                      'agent.permissions.networkRead',
                      effectiveSettings,
                      patchUserSetting,
                      zh,
                    )}
                    {permissionSetting(
                      zh ? '外部操作' : 'External effects',
                      'agent.permissions.external',
                      effectiveSettings,
                      patchUserSetting,
                      zh,
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
                  {zh ? '忽略' : 'Ignore'}
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
                  ? (zh ? '停止当前运行' : 'Stop current run')
                  : submitting
                    ? (zh ? '提交中' : 'Sending')
                    : (zh ? '发送' : 'Send')}
                title={showStopAction
                  ? (zh ? '停止' : 'Stop')
                  : (zh ? '发送（Enter）' : 'Send (Enter)')}
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
          {zh ? 'Enter 发送 · Shift+Enter 换行' : 'Enter to send · Shift+Enter for a new line'}
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
            aria-label={zh ? '只读资源预览' : 'Read-only resource preview'}
          >
            <header>
              <div>
                <strong>{resourcePreview.logicalPath}</strong>
                <span>{zh ? '工作区资源 · 只读' : 'Workspace resource · Read only'}</span>
              </div>
              <button
                type="button"
                aria-label={zh ? '关闭' : 'Close'}
                onClick={() => setResourcePreview(null)}
              >×</button>
            </header>
            <div className="local-agent__resource-body">
              {resourcePreview.status === 'loading' ? (
                <p>{zh ? '正在读取资源…' : 'Reading resource…'}</p>
              ) : resourcePreview.status === 'error' ? (
                <p className="local-agent__resource-error">{resourcePreview.error}</p>
              ) : (
                <>
                  <div className="local-agent__resource-meta">
                    <span>{formatBytes(resourcePreview.result.sizeBytes)}</span>
                    <span>
                      {zh
                        ? `${resourcePreview.result.startLine}–${resourcePreview.result.endLine} 行`
                        : `Lines ${resourcePreview.result.startLine}–${resourcePreview.result.endLine}`}
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
  zh: boolean;
  onOpenWorkspaceResource(workspaceId: string, logicalPath: string): void;
}

const ToolActivityGroup: React.FC<ToolActivityGroupProps> = ({
  activities,
  zh,
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
        <strong>{toolGroupSummary(activities, zh)}</strong>
        <span>{toolActivityStatus(groupStatus, zh)}</span>
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
                <span>{toolActivityStatus(activity.status, zh)}</span>
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
  zh: boolean,
): React.ReactNode {
  return (
    <label>
      <span>{label}</span>
      <select value={String(settings[key] ?? 'ask')} onChange={(event) => void patch(key, event.target.value)}>
        <option value="allow">{zh ? '允许' : 'Allow'}</option>
        <option value="ask">{zh ? '询问' : 'Ask'}</option>
        <option value="deny">{zh ? '拒绝' : 'Deny'}</option>
      </select>
    </label>
  );
}

function conversationTitle(
  messages: { role: string; content: string }[] | undefined,
  zh: boolean,
): string {
  const first = messages?.find((message) => message.role === 'user')?.content.trim();
  if (!first) return zh ? '新对话' : 'New conversation';
  const line = first.split(/\r?\n/u, 1)[0].trim();
  return line.length > 34 ? `${line.slice(0, 34)}…` : line;
}

function runLabel(run: RunProjection | null, zh: boolean): string {
  if (!run) return zh ? '空闲' : 'Idle';
  if (run.status === 'waiting' && run.waitingReason === 'userInput') {
    return zh ? '等待输入' : 'Waiting for input';
  }
  if (run.status === 'waiting' && run.waitingReason === 'plan') {
    return zh ? '等待计划选择' : 'Waiting for plan response';
  }
  const labels: Record<RunProjection['status'], readonly [string, string]> = {
    running: ['运行中', 'Running'],
    waiting: ['等待决定', 'Waiting'],
    completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    indeterminate: ['结果待确认', 'Indeterminate'],
  };
  return labels[run.status][zh ? 0 : 1];
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

function toolGroupSummary(activities: ActivityProjection[], zh: boolean): string {
  const status = toolGroupStatus(activities);
  const operation = activities.length === 1
    ? (activities[0].tool?.operation ?? activities[0].label)
    : null;
  if (status === 'active') {
    if (operation) return zh ? `正在调用工具 ${operation}` : `Calling tool ${operation}`;
    return zh ? `正在调用 ${activities.length} 个工具` : `Calling ${activities.length} tools`;
  }
  if (status === 'requested') {
    if (operation) return zh ? `已请求工具 ${operation}` : `Requested tool ${operation}`;
    return zh ? `已请求 ${activities.length} 个工具` : `Requested ${activities.length} tools`;
  }
  if (status === 'waiting') {
    if (operation) return zh ? `工具 ${operation} 等待中` : `Tool ${operation} is waiting`;
    return zh ? `${activities.length} 个工具等待中` : `${activities.length} tools are waiting`;
  }
  if (activities.length === 1) {
    return zh ? `使用了工具 ${operation}` : `Used tool ${operation}`;
  }
  return zh ? `使用了 ${activities.length} 次工具` : `Used ${activities.length} tools`;
}

function isTerminalActivity(status: ActivityProjection['status']): boolean {
  return ['completed', 'denied', 'failed', 'cancelled', 'indeterminate'].includes(status);
}

function toolActivityStatus(status: ActivityProjection['status'], zh: boolean): string {
  const labels: Record<ActivityProjection['status'], readonly [string, string]> = {
    active: ['调用中', 'Running'],
    requested: ['已请求', 'Requested'],
    waiting: ['等待中', 'Waiting'],
    completed: ['完成', 'Done'],
    denied: ['已拒绝', 'Denied'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    indeterminate: ['待确认', 'Unknown'],
  };
  return labels[status][zh ? 0 : 1];
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

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  return `${Math.ceil(value / 1024)} KiB`;
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
