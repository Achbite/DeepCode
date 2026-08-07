import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentInputAttachmentV2,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import ContextAttachmentPicker from './ContextAttachmentPicker';
import UserAttachmentDialog from './UserAttachmentDialog';
import type { AgentComposerPendingDecision } from './pendingDecision';

const COMPOSER_TEXTAREA_MIN_HEIGHT = 34;
const COMPOSER_TEXTAREA_MAX_HEIGHT = 150;

function cssPixelValue(value: string, fallback: number): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  const computedStyle = window.getComputedStyle(textarea);
  const minHeight = cssPixelValue(computedStyle.minHeight, COMPOSER_TEXTAREA_MIN_HEIGHT);
  const maxHeight = Math.max(
    minHeight,
    cssPixelValue(computedStyle.maxHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)
  );
  textarea.style.height = `${minHeight}px`;
  const contentHeight = textarea.scrollHeight;
  textarea.style.height = `${Math.min(
    Math.max(contentHeight, minHeight),
    maxHeight
  )}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
}

interface AgentComposerProps {
  messageAttachments: AgentInputAttachmentV2[];
  sessionAttachments: AgentInputAttachmentV2[];
  attachmentWorkspaceBinding?: AgentWorkspaceBinding;
  allowGlobalAttachmentWorkspaceFallback: boolean;
  language: UiLanguage;
  loading: boolean;
  onSend: (content: string) => Promise<boolean>;
  pendingSubmissionRetry?: AgentComposerPendingSubmissionRetry | null;
  onRetryPendingSubmission?: (
    clearOriginalMessageAttachments: boolean
  ) => Promise<boolean>;
  onSubmissionSettled?: (
    admitted: boolean,
    submissionScopeId: string | null,
    submittedDraftCleared: boolean
  ) => void | Promise<void>;
  submissionScopeId?: string | null;
  canCancelCurrentRun?: boolean;
  onStop: () => void;
  onAddAttachment: (attachment: AgentInputAttachmentV2) => void;
  onRemoveAttachment: (
    path: string,
    scope: AgentInputAttachmentV2['scope'],
    folderId?: string
  ) => void;
  footerControls?: React.ReactNode;
  sendBlocked?: boolean;
  sendBlockedTitle?: string;
  pendingDecision?: AgentComposerPendingDecision | null;
  onDecisionSubmit?: (guidance?: string, action?: 'accept' | 'revise') => void | Promise<void>;
  onDecisionReject?: () => void | Promise<void>;
}

export interface AgentComposerPendingSubmissionRetry {
  content: string;
  messageAttachments: AgentInputAttachmentV2[];
  callerRequestId: string;
  disposition: 'pending' | 'indeterminate';
  message?: string;
}

interface AgentModifiedFileView {
  path: string;
  savepoint: string;
}

const MODIFIED_FILES: AgentModifiedFileView[] = [];
const PRIMARY_DECISION_OPTION_ID = '__primary__';

function attachmentLabel(attachment: AgentInputAttachmentV2, language: UiLanguage): string {
  const kind = attachment.kind === 'directory'
    ? t(language, 'agent.composer.dir')
    : t(language, 'agent.composer.file');
  const scope = attachment.scope === 'session'
    ? t(language, 'agent.attachmentDialog.sessionScope')
    : t(language, 'agent.attachmentDialog.messageScope');
  return `${kind} · ${scope} · ${attachment.path}`;
}

function sameMessageAttachments(
  current: AgentInputAttachmentV2[],
  pending: AgentInputAttachmentV2[]
): boolean {
  if (current.length !== pending.length) return false;
  const pendingInstances = new Set(pending);
  return current.every((attachment) => pendingInstances.has(attachment));
}

function AttachmentIcon({ kind }: Pick<AgentInputAttachmentV2, 'kind'>): React.ReactElement {
  if (kind === 'directory') {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M2.75 5.5h5l1.5 1.75h8v7.25a1.75 1.75 0 0 1-1.75 1.75h-11a1.75 1.75 0 0 1-1.75-1.75v-9Z" />
        <path d="M2.75 7.25h14.5" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 2.75h6l4 4v10.5H5V2.75Z" />
      <path d="M11 2.75v4h4M7.75 10h4.5M7.75 13h4.5" />
    </svg>
  );
}

function joinWorkspacePath(root: string, filePath: string): string | null {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = filePath.replace(/\\/g, '/');
  if (!normalizedPath.trim()) return null;
  if (normalizedPath.startsWith('/')) {
    return normalizedPath.startsWith(`${normalizedRoot}/`) || normalizedPath === normalizedRoot
      ? normalizedPath
      : null;
  }
  const parts: string[] = [];
  for (const part of normalizedPath.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return `${normalizedRoot}/${parts.join('/')}`;
}

function openVscodeFile(absolutePath: string): void {
  const normalized = absolutePath.replace(/\\/g, '/');
  const urlPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  window.location.href = `vscode://file${encodeURI(urlPath)}`;
}

function isImeComposing(event: React.KeyboardEvent<HTMLElement>): boolean {
  const syntheticEvent = event as React.KeyboardEvent<HTMLElement> & { isComposing?: boolean };
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return Boolean(
    syntheticEvent.isComposing ||
    nativeEvent.isComposing ||
    nativeEvent.keyCode === 229 ||
    event.keyCode === 229
  );
}

function composerDecisionText(decision: AgentComposerPendingDecision, language: UiLanguage): { title: string; summary?: string } {
  if (decision.kind === 'plan') {
    return {
      title: t(language, 'agent.composer.decision.planQuestion'),
    };
  }
  return {
    title: decision.title || t(language, 'agent.composer.decision.permission'),
    summary: decision.summary,
  };
}

function decisionPlaceholder(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  if (decision.kind === 'plan') return t(language, 'agent.composer.decision.planPlaceholder');
  return t(language, 'agent.composer.decision.permissionPlaceholder');
}

function decisionSubmitLabel(decision: AgentComposerPendingDecision, value: string, language: UiLanguage): string {
  if (decision.kind === 'permission') return t(language, 'agent.permission.accept');
  return value.trim()
    ? t(language, 'agent.plan.submitReview')
    : t(language, 'agent.plan.accept');
}

function decisionSubmitTitle(decision: AgentComposerPendingDecision, value: string, language: UiLanguage): string {
  if (decision.kind === 'permission') return t(language, 'agent.permission.accept');
  return value.trim()
    ? t(language, 'agent.composer.decision.submitGuidanceTitle')
    : t(language, 'agent.composer.decision.acceptTitle');
}

function decisionPrimaryOptionLabel(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  if (decision.kind === 'plan') return t(language, 'agent.composer.decision.planOption');
  return decisionSubmitLabel(decision, '', language);
}

function normalizeDecisionInput(
  decision: AgentComposerPendingDecision,
  value: string
): { action: 'accept' | 'revise' | 'reject'; guidance?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { action: 'accept' };
  const lower = trimmed.toLowerCase();
  if (lower === '1' || lower === 'accept' || trimmed === '确认' || trimmed === '同意') {
    return { action: 'accept' };
  }
  if (
    lower === '3' ||
    lower === 'end' ||
    lower === 'stop' ||
    lower === 'reject' ||
    trimmed === '结束' ||
    trimmed === '拒绝'
  ) {
    return { action: 'reject' };
  }
  if (decision.kind === 'permission' && (lower === '2' || lower === 'deny')) {
    return { action: 'reject' };
  }
  if (lower === '2') return { action: 'revise' };
  if (lower.startsWith('2 ')) return { action: 'revise', guidance: trimmed.slice(2).trim() || undefined };
  return { action: 'revise', guidance: trimmed };
}

function decisionCopyText(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  const text = composerDecisionText(decision, language);
  const lines = [text.title];
  if (decision.summary) lines.push('', decision.summary);
  return lines.filter((line) => line !== undefined).join('\n').trim();
}

function decisionInstanceKey(decision: AgentComposerPendingDecision | null | undefined): string {
  if (!decision) return 'none';
  if (decision.kind === 'plan') return `${decision.kind}:${decision.runId}:${decision.planId}`;
  return `${decision.kind}:${decision.requestId}`;
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

const AgentComposer: React.FC<AgentComposerProps> = ({
  messageAttachments,
  sessionAttachments,
  attachmentWorkspaceBinding,
  allowGlobalAttachmentWorkspaceFallback,
  language,
  loading,
  onSend,
  pendingSubmissionRetry,
  onRetryPendingSubmission,
  onSubmissionSettled,
  submissionScopeId = null,
  canCancelCurrentRun = false,
  onStop,
  onAddAttachment,
  onRemoveAttachment,
  footerControls,
  sendBlocked = false,
  sendBlockedTitle,
  pendingDecision,
  onDecisionSubmit,
  onDecisionReject,
}) => {
  const [value, setValue] = useState('');
  const [inputFocused, setInputFocused] = useState(false);
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [changesOpen, setChangesOpen] = useState(true);
  const [decisionCopyStatus, setDecisionCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [submissionPending, setSubmissionPending] = useState(false);
  const [pendingSubmissionCancellable, setPendingSubmissionCancellable] = useState(false);
  const draftRevisionRef = useRef(0);
  const pendingSubmissionRef = useRef<string | null>(null);
  const submissionScopeRef = useRef(submissionScopeId);
  const previousSubmissionScopeRef = useRef(submissionScopeId);
  submissionScopeRef.current = submissionScopeId;
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const defaultDecisionOptionRef = useRef<HTMLButtonElement | null>(null);
  const focusedOptionClickConfirmRef = useRef<string | null>(null);
  const activeFolder = useWorkspaceStore((s) => s.getActiveFolder());
  const previewEditor = String(
    useSettingsStore((s) => s.effectiveSettings['workbench.previewEditor'] ?? 'vscode')
  );
  const mention = useMemo(() => {
    const match = value.match(/@([^@\s]*)$/);
    if (!match) return null;
    return {
      query: match[1],
      start: match.index ?? value.length - match[0].length,
      length: match[0].length,
    };
  }, [value]);

  const decisionKey = decisionInstanceKey(pendingDecision);

  useEffect(() => {
    setDecisionCopyStatus('idle');
    focusedOptionClickConfirmRef.current = null;
  }, [decisionKey]);

  useEffect(() => {
    if (previousSubmissionScopeRef.current === submissionScopeId) return;
    const previousScopeId = previousSubmissionScopeRef.current;
    previousSubmissionScopeRef.current = submissionScopeId;
    if (previousScopeId === null && submissionScopeId !== null) {
      return;
    }
    draftRevisionRef.current += 1;
    pendingSubmissionRef.current = null;
    setSubmissionPending(false);
    setPendingSubmissionCancellable(false);
    setValue('');
  }, [submissionScopeId]);

  const send = () => {
    const nextValue = value;
    if (submissionPending || pendingSubmissionRef.current) return;
    if (pendingDecision) {
      if (pendingDecision.resolving) return;
      const normalized = normalizeDecisionInput(pendingDecision, nextValue);
      setValue('');
      if (normalized.action === 'reject') {
        void onDecisionReject?.();
        return;
      }
      void onDecisionSubmit?.(normalized.guidance, normalized.action);
      return;
    }
    if (sendBlocked) return;
    if (!nextValue.trim()) return;
    const submittedRevision = draftRevisionRef.current;
    const submittedScopeId = submissionScopeId;
    const submissionToken = globalThis.crypto.randomUUID();
    pendingSubmissionRef.current = submissionToken;
    setPendingSubmissionCancellable(canCancelCurrentRun);
    setSubmissionPending(true);
    void (async () => {
      let admitted = false;
      let submittedDraftCleared = false;
      try {
        admitted = await onSend(nextValue);
        if (
          admitted
          && submissionScopeRef.current === submittedScopeId
          && draftRevisionRef.current === submittedRevision
        ) {
          draftRevisionRef.current += 1;
          setValue('');
          submittedDraftCleared = true;
        }
      } catch {
        // The store owns user-visible error projection; an unacknowledged
        // submission deliberately retains the exact draft.
      } finally {
        if (pendingSubmissionRef.current === submissionToken) {
          pendingSubmissionRef.current = null;
          setSubmissionPending(false);
          setPendingSubmissionCancellable(false);
        }
        if (onSubmissionSettled) {
          void Promise.resolve(
            onSubmissionSettled(
              admitted,
              submittedScopeId,
              submittedDraftCleared
            )
          ).catch(() => undefined);
        }
      }
    })();
  };

  const retryPendingSubmission = () => {
    if (
      !pendingSubmissionRetry
      || !onRetryPendingSubmission
      || submissionPending
      || pendingSubmissionRef.current
    ) {
      return;
    }
    const submittedRevision = draftRevisionRef.current;
    const submittedScopeId = submissionScopeId;
    const submittedDraftMatches =
      value.trim() === pendingSubmissionRetry.content
      && sameMessageAttachments(
        messageAttachments,
        pendingSubmissionRetry.messageAttachments
      );
    const submissionToken = `retry:${pendingSubmissionRetry.callerRequestId}`;
    pendingSubmissionRef.current = submissionToken;
    setPendingSubmissionCancellable(canCancelCurrentRun);
    setSubmissionPending(true);
    void (async () => {
      let admitted = false;
      let submittedDraftCleared = false;
      try {
        admitted = await onRetryPendingSubmission(submittedDraftMatches);
        if (
          admitted
          && submittedDraftMatches
          && submissionScopeRef.current === submittedScopeId
          && draftRevisionRef.current === submittedRevision
        ) {
          draftRevisionRef.current += 1;
          setValue('');
          submittedDraftCleared = true;
        }
      } catch {
        // The store owns the durable retry identity and user-visible error.
      } finally {
        if (pendingSubmissionRef.current === submissionToken) {
          pendingSubmissionRef.current = null;
          setSubmissionPending(false);
          setPendingSubmissionCancellable(false);
        }
        if (onSubmissionSettled) {
          void Promise.resolve(
            onSubmissionSettled(
              admitted,
              submittedScopeId,
              submittedDraftCleared
            )
          ).catch(() => undefined);
        }
      }
    })();
  };

  useEffect(() => {
    if (!pendingDecision || pendingDecision.resolving) return;
    setValue('');
    const frame = window.requestAnimationFrame(() => {
      defaultDecisionOptionRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [decisionKey]);

  const handleDecisionShortcut = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!pendingDecision || pendingDecision.resolving) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setValue('');
      void onDecisionReject?.();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      if (isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      send();
    }
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    resizeComposerTextarea(textarea);
  }, [value]);

  const updateValue = (nextValue: string) => {
    draftRevisionRef.current += 1;
    setValue(nextValue);
    setAttachmentError(null);
  };

  const pickAttachment = (attachment: AgentInputAttachmentV2) => {
    setAttachmentError(null);
    draftRevisionRef.current += 1;
    onAddAttachment(attachment);
    if (mention) {
      setValue(`${value.slice(0, mention.start)}${value.slice(mention.start + mention.length)}`);
    }
  };

  const chips = [...sessionAttachments, ...messageAttachments];
  const composerExpanded = Boolean(
    value.trim()
    || chips.length > 0
    || attachmentDialogOpen
    || mention
    || pendingDecision
  );
  const decisionText = pendingDecision ? composerDecisionText(pendingDecision, language) : null;
  const decisionResolving = Boolean(pendingDecision?.resolving);
  const cancellable = loading && (
    submissionPending ? pendingSubmissionCancellable : canCancelCurrentRun
  );
  const sendDisabled = cancellable
    ? false
    : submissionPending
      ? true
      : loading
        ? true
        : pendingDecision
          ? decisionResolving
          : submissionPending || sendBlocked || !value.trim();
  const sendLabel = decisionResolving
    ? t(language, 'agent.composer.decision.resolving')
    : cancellable
    ? t(language, 'agent.composer.stop')
    : pendingDecision
      ? decisionSubmitLabel(pendingDecision, value, language)
      : t(language, 'agent.composer.send');

  const openModifiedFile = (file: AgentModifiedFileView) => {
    const absolutePath = activeFolder?.absolutePath
      ? joinWorkspacePath(activeFolder.absolutePath, file.path)
      : null;
    if (!absolutePath) return;
    if (previewEditor === 'vscode') {
      openVscodeFile(absolutePath);
    }
  };

  const armFocusedOptionClick = (
    _event: React.MouseEvent<HTMLButtonElement>,
    optionId: string
  ) => {
    focusedOptionClickConfirmRef.current = document.activeElement === defaultDecisionOptionRef.current
      ? optionId
      : null;
  };

  const activatePrimaryDecisionOption = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!pendingDecision || pendingDecision.resolving) return;
    if (focusedOptionClickConfirmRef.current === PRIMARY_DECISION_OPTION_ID) {
      send();
      return;
    }
    event.currentTarget.focus();
    focusedOptionClickConfirmRef.current = null;
  };

  const copyDecision = async () => {
    if (!pendingDecision) return;
    try {
      await copyText(decisionCopyText(pendingDecision, language));
      setDecisionCopyStatus('copied');
    } catch {
      setDecisionCopyStatus('error');
    }
  };
  const renderDecisionInput = () => (
    <div className="agent-composer-decision__input-row">
      <span className="agent-composer-decision__input-icon" aria-hidden="true">
        ✎
      </span>
      <div className="agent-composer-decision__input-wrap">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => updateValue(event.target.value)}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          disabled={decisionResolving}
          onKeyDown={handleDecisionShortcut}
          placeholder={pendingDecision ? decisionPlaceholder(pendingDecision, language) : undefined}
        />
      </div>
    </div>
  );

  return (
    <div className={`agent-composer${inputFocused ? ' agent-composer--input-focused' : ''}${composerExpanded ? ' agent-composer--expanded' : ''}${chips.length > 0 ? ' agent-composer--has-attachments' : ''}${pendingDecision ? ' agent-composer--decision' : ''}`}>
      {pendingSubmissionRetry && (
        <div
          className={`agent-composer__pending-submission agent-composer__pending-submission--${pendingSubmissionRetry.disposition}`}
          role={pendingSubmissionRetry.disposition === 'indeterminate' ? 'alert' : 'status'}
        >
          <span>
            {pendingSubmissionRetry.disposition === 'pending'
              ? language === 'zh-CN'
                ? '请求仍在确认中。可用原请求身份安全查询，不会重复执行。'
                : 'The request is still being confirmed. Query safely with the original request identity without duplicate execution.'
              : language === 'zh-CN'
                ? '上次发送的结果不确定，需要关注。请仅使用原请求身份重放。'
                : 'The previous send has an indeterminate outcome and needs attention. Replay only with its original request identity.'}
          </span>
          <button
            type="button"
            disabled={submissionPending}
            onClick={retryPendingSubmission}
          >
            {pendingSubmissionRetry.disposition === 'pending'
              ? language === 'zh-CN' ? '确认发送结果' : 'Check send outcome'
              : language === 'zh-CN' ? '安全重放' : 'Replay safely'}
          </button>
        </div>
      )}
      {decisionText && (
        <div className="agent-composer-decision" onKeyDown={handleDecisionShortcut}>
          <div className="agent-composer-decision__header">
            <div className="agent-composer-decision__title">{decisionText.title}</div>
            <button
              type="button"
              className={`agent-composer-decision__copy agent-composer-decision__copy--${decisionCopyStatus}`}
              onClick={() => void copyDecision()}
              disabled={decisionResolving}
              title={t(language, 'agent.composer.decision.copy')}
              aria-label={t(language, 'agent.composer.decision.copy')}
            >
              ⧉
            </button>
          </div>
          {decisionText.summary && <div className="agent-composer-decision__summary">{decisionText.summary}</div>}
          {decisionResolving ? (
            <div className="agent-composer-decision__resolving">
              {t(language, 'agent.composer.decision.resolvingDetail')}
            </div>
          ) : (
            <>
              <div
                className="agent-composer-decision__options"
              >
                <button
                  className="agent-composer-decision__option agent-composer-decision__option--selected"
                  type="button"
                  disabled={decisionResolving}
                  title={decisionSubmitTitle(pendingDecision!, '', language)}
                  ref={defaultDecisionOptionRef}
                  onMouseDown={(event) => armFocusedOptionClick(event, PRIMARY_DECISION_OPTION_ID)}
                  onClick={activatePrimaryDecisionOption}
                >
                  <span className="agent-composer-decision__number">1</span>
                  <span className="agent-composer-decision__option-body">
                    <span className="agent-composer-decision__label">
                      {decisionPrimaryOptionLabel(pendingDecision!, language)}
                    </span>
                  </span>
                </button>
              </div>
              <div className="agent-composer-decision__control-row">
                {renderDecisionInput()}
                <div className="agent-composer-decision__actions">
                  <button
                    type="button"
                    className="agent-composer-decision__reject"
                    onClick={() => void onDecisionReject?.()}
                    disabled={Boolean(pendingDecision?.resolving)}
                    title={t(language, 'agent.composer.decision.rejectTitle')}
                  >
                    {t(language, 'agent.composer.decision.ignore')}
                    <span className="agent-composer-decision__shortcut">
                      {t(language, 'agent.composer.decision.escape')}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="agent-composer-decision__confirm"
                    onClick={send}
                    disabled={decisionResolving}
                    title={decisionSubmitTitle(pendingDecision!, value, language)}
                  >
                    {t(language, 'agent.composer.decision.submit')}
                    <span className="agent-composer-decision__enter" aria-hidden="true">
                      ↵
                    </span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {chips.length > 0 && (
        <div className="agent-attachment-chips">
          {chips.map((attachment) => (
            <button
              key={`${attachment.scope}:${attachment.folderId ?? ''}:${attachment.path}:${attachment.kind}`}
              className={`agent-chip agent-chip--${attachment.scope} agent-chip--${attachment.kind}`}
              title={attachmentLabel(attachment, language)}
              onClick={() => {
                draftRevisionRef.current += 1;
                onRemoveAttachment(
                  attachment.path,
                  attachment.scope,
                  attachment.folderId
                );
              }}
              type="button"
            >
              <span className="agent-chip__icon">
                <AttachmentIcon kind={attachment.kind} />
              </span>
              <span className="agent-chip__body">
                <span className="agent-chip__path">{attachment.path}</span>
                <span className="agent-chip__kind">
                  {attachment.scope === 'session'
                    ? t(language, 'agent.attachmentDialog.sessionScope')
                    : t(language, 'agent.attachmentDialog.messageScope')}
                </span>
              </span>
              <span className="agent-chip__remove" aria-hidden="true">×</span>
            </button>
          ))}
        </div>
      )}
      {attachmentError && (
        <div className="agent-composer__attachment-error" role="alert">
          {attachmentError}
        </div>
      )}
      {MODIFIED_FILES.length > 0 && (
        <div className={`agent-change-set ${changesOpen ? 'agent-change-set--open' : ''}`}>
          <button
            className="agent-change-set__header"
            type="button"
            onClick={() => setChangesOpen((open) => !open)}
          >
            <span>{t(language, 'agent.composer.modifiedFiles')}</span>
            <span>{MODIFIED_FILES.length}</span>
          </button>
          {changesOpen && (
            <div className="agent-change-set__body">
              {MODIFIED_FILES.map((file) => (
                <div
                  key={file.path}
                  className="agent-change-file"
                  role="button"
                  tabIndex={0}
                  onClick={() => openModifiedFile(file)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      openModifiedFile(file);
                    }
                  }}
                >
                  <span className="agent-change-file__path" title={file.path}>
                    {file.path}
                  </span>
                  <span className="agent-change-file__savepoint">{file.savepoint}</span>
                  <div className="agent-change-file__actions">
                    <button
                      type="button"
                      title={t(language, 'agent.composer.openDiff')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      diff
                    </button>
                    <button
                      type="button"
                      title={t(language, 'agent.composer.rejectChanges')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      X
                    </button>
                    <button
                      type="button"
                      title={t(language, 'agent.composer.acceptChanges')}
                      onClick={(event) => event.stopPropagation()}
                    >
                      OK
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!pendingDecision && (
        <div className="agent-composer__input-wrap">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => updateValue(event.target.value)}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                if (isImeComposing(event)) return;
                event.preventDefault();
                send();
              }
            }}
            placeholder={loading
              ? t(language, 'agent.composer.placeholder.running')
              : t(language, 'agent.composer.placeholder.idle')}
          />
          {mention && (
            <ContextAttachmentPicker
              query={mention.query}
              language={language}
              onPick={pickAttachment}
              onError={setAttachmentError}
            />
          )}
        </div>
      )}
      {!pendingDecision && <div className="agent-composer__footer">
        <div className="agent-composer__footer-left">
          <button
            className="agent-add-file-button"
            type="button"
            title={t(language, 'agent.composer.addAttachment')}
            aria-label={t(language, 'agent.composer.addAttachment')}
            onClick={() => {
              setAttachmentError(null);
              setAttachmentDialogOpen(true);
            }}
          >
            +
          </button>
        </div>
        <div className="agent-composer__footer-right">
          {footerControls}
          <button
            className={cancellable ? 'agent-composer__send-button--stop' : undefined}
            onClick={cancellable ? onStop : send}
            disabled={sendDisabled}
            type="button"
            title={cancellable
              ? t(language, 'agent.composer.stopTitle')
              : sendBlockedTitle ?? t(language, 'agent.composer.sendTitle')}
          >
            {sendLabel}
          </button>
        </div>
      </div>}
      <UserAttachmentDialog
        visible={attachmentDialogOpen}
        language={language}
        workspaceBinding={attachmentWorkspaceBinding}
        allowGlobalWorkspaceFallback={allowGlobalAttachmentWorkspaceFallback}
        onClose={() => setAttachmentDialogOpen(false)}
        onPick={pickAttachment}
      />
    </div>
  );
};

export default AgentComposer;
