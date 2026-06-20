import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentContextAttachment } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import ContextAttachmentPicker from './ContextAttachmentPicker';
import UserAttachmentDialog, { type PickedUserAttachment } from './UserAttachmentDialog';
import type { AgentComposerDecisionOption, AgentComposerPendingDecision } from './pendingDecision';

interface AgentComposerProps {
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  language: UiLanguage;
  loading: boolean;
  onSend: (content: string) => void | Promise<void>;
  onStop: () => void;
  onAddAttachment: (attachment: AgentContextAttachment) => void;
  onRemoveAttachment: (path: string, scope: AgentContextAttachment['scope']) => void;
  pendingDecision?: AgentComposerPendingDecision | null;
  onDecisionSubmit?: (guidance?: string, action?: 'accept' | 'revise') => void | Promise<void>;
  onDecisionReject?: () => void | Promise<void>;
}

interface AgentModifiedFileView {
  path: string;
  savepoint: string;
}

const MODIFIED_FILES: AgentModifiedFileView[] = [];
const LAST_ATTACHMENT_DIRECTORY_KEY_PREFIX = 'deepcode.agent.lastAttachmentDirectory';
const PRIMARY_DECISION_OPTION_ID = '__primary__';

function attachmentLabel(attachment: AgentContextAttachment, language: UiLanguage): string {
  if (attachment.kind === 'directory') {
    return `${t(language, 'agent.composer.dir')} ${attachment.path || '.'}`;
  }
  if (attachment.kind === 'panelSnapshot') {
    return `${t(language, 'agent.composer.panel')} ${attachment.path || 'snapshot'}`;
  }
  return `${t(language, 'agent.composer.file')} ${attachment.path || '.'}`;
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

function relativeToWorkspacePath(root: string, absolutePath: string): string | null {
  const normalizedRoot = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalizedPath === normalizedRoot) return '.';
  const prefix = `${normalizedRoot}/`;
  if (!normalizedPath.startsWith(prefix)) return null;
  return normalizedPath.slice(prefix.length) || '.';
}

function selectedAttachmentPath(absolutePath: string): string {
  return absolutePath.replace(/\\/g, '/');
}

function storageAvailable(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function lastAttachmentDirectoryKey(workspaceRoot?: string): string {
  const scope = workspaceRoot?.replace(/\\/g, '/').replace(/\/+$/, '') || 'no-workspace';
  return `${LAST_ATTACHMENT_DIRECTORY_KEY_PREFIX}:${scope}`;
}

function readLastAttachmentDirectory(workspaceRoot?: string): string | null {
  if (!storageAvailable()) return null;
  try {
    return window.localStorage.getItem(lastAttachmentDirectoryKey(workspaceRoot));
  } catch {
    return null;
  }
}

function writeLastAttachmentDirectory(workspaceRoot: string | undefined, absolutePath: string): void {
  if (!storageAvailable()) return;
  const normalized = selectedAttachmentPath(absolutePath).replace(/\/+$/, '');
  if (!normalized) return;
  try {
    window.localStorage.setItem(lastAttachmentDirectoryKey(workspaceRoot), normalized);
  } catch {
    // localStorage can be unavailable in restricted WebView modes.
  }
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
  if (isTechnicalChoiceDecision(decision)) {
    return {
      title: decision.title || t(language, 'agent.composer.decision.choice'),
    };
  }
  if (decision.kind === 'plan') {
    return {
      title: t(language, 'agent.composer.decision.planQuestion'),
    };
  }
  const fallbackTitle = decision.kind === 'requirement'
    ? t(language, 'agent.composer.decision.requirement')
    : decision.kind === 'review'
      ? t(language, 'agent.composer.decision.review')
      : t(language, 'agent.composer.decision.permission');
  return {
    title: decision.title || fallbackTitle,
    summary: decision.kind === 'permission' ? decision.summary : undefined,
  };
}

function decisionPlaceholder(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  if (isTechnicalChoiceDecision(decision)) return t(language, 'agent.composer.decision.choicePlaceholder');
  if (decision.kind === 'requirement') return t(language, 'agent.composer.decision.requirementPlaceholder');
  if (decision.kind === 'plan') return t(language, 'agent.composer.decision.planPlaceholder');
  if (decision.kind === 'review') return t(language, 'agent.composer.decision.reviewPlaceholder');
  return t(language, 'agent.composer.decision.permissionPlaceholder');
}

function decisionSubmitLabel(decision: AgentComposerPendingDecision, value: string, language: UiLanguage): string {
  if (decision.kind === 'permission') return t(language, 'agent.permission.accept');
  if (isTechnicalChoiceDecision(decision)) return t(language, 'agent.composer.decision.submitChoice');
  if (decision.kind === 'requirement') {
    return value.trim()
      ? t(language, 'agent.requirement.submitRevision')
      : t(language, 'agent.requirement.accept');
  }
  if (value.trim()) {
    return decision.kind === 'review'
      ? t(language, 'agent.review.submitRevision')
      : t(language, 'agent.plan.submitReview');
  }
  return decision.kind === 'review'
    ? t(language, 'agent.review.acceptContinue')
    : t(language, 'agent.plan.accept');
}

function decisionSubmitTitle(decision: AgentComposerPendingDecision, value: string, language: UiLanguage): string {
  if (decision.kind === 'permission') return t(language, 'agent.permission.accept');
  if (isTechnicalChoiceDecision(decision)) return t(language, 'agent.composer.decision.submitChoiceTitle');
  return value.trim()
    ? t(language, 'agent.composer.decision.submitGuidanceTitle')
    : t(language, 'agent.composer.decision.acceptTitle');
}

function decisionPrimaryOptionLabel(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  if (decision.kind === 'plan') return t(language, 'agent.composer.decision.planOption');
  return decisionSubmitLabel(decision, '', language);
}

function isTechnicalChoiceDecision(
  decision: AgentComposerPendingDecision
): decision is Extract<AgentComposerPendingDecision, { kind: 'requirement' }> & {
  decisionRequest: NonNullable<Extract<AgentComposerPendingDecision, { kind: 'requirement' }>['decisionRequest']>;
} {
  return decision.kind === 'requirement' && Boolean(decision.decisionRequest?.options.length);
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

function recommendedChoice(options: AgentComposerDecisionOption[]): AgentComposerDecisionOption | null {
  return options.find((option) => option.recommended) ?? options[0] ?? null;
}

function parseTechnicalChoiceInput(
  value: string,
  fallback: AgentComposerDecisionOption
): { action: 'accept' | 'reject'; option: AgentComposerDecisionOption; supplement?: string } {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (
    lower === 'end' ||
    lower === 'stop' ||
    lower === 'reject' ||
    trimmed === '结束' ||
    trimmed === '拒绝'
  ) {
    return { action: 'reject', option: fallback };
  }
  return {
    action: 'accept',
    option: fallback,
    supplement: trimmed || undefined,
  };
}

function decisionChoiceCount(options: AgentComposerDecisionOption[], language: UiLanguage): string {
  return t(language, 'agent.composer.decision.choiceCount', { count: options.length });
}

function decisionCopyText(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  const text = composerDecisionText(decision, language);
  const lines = [text.title];
  if (decision.summary) lines.push('', decision.summary);
  if (isTechnicalChoiceDecision(decision)) {
    const request = decision.decisionRequest;
    if (request.summary || request.reason) {
      lines.push('', request.summary ?? request.reason ?? '');
    }
    for (const option of request.options) {
      lines.push('', `- ${option.label}${option.recommended ? ` (${t(language, 'agent.composer.decision.recommended')})` : ''}`);
      if (option.description) lines.push(`  ${option.description}`);
    }
  }
  return lines.filter((line) => line !== undefined).join('\n').trim();
}

function decisionChoiceGuidance(
  option: AgentComposerDecisionOption,
  supplement: string | undefined,
  language: UiLanguage
): string {
  const lines = language === 'zh-CN'
    ? [
      '用户已选择技术方案：',
      `- id: ${normalizeGuidanceLine(option.id)}`,
      `- label: ${normalizeGuidanceLine(option.label)}`,
      option.description ? `- description: ${normalizeGuidanceLine(option.description)}` : '',
      supplement ? '用户补充信息：' : '',
      supplement ? supplement.trim() : '',
    ]
    : [
      'User selected technical option:',
      `- id: ${normalizeGuidanceLine(option.id)}`,
      `- label: ${normalizeGuidanceLine(option.label)}`,
      option.description ? `- description: ${normalizeGuidanceLine(option.description)}` : '',
      supplement ? 'User supplemental guidance:' : '',
      supplement ? supplement.trim() : '',
    ];
  return lines.filter(Boolean).join('\n');
}

function normalizeGuidanceLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function decisionInstanceKey(decision: AgentComposerPendingDecision | null | undefined): string {
  if (!decision) return 'none';
  if (decision.kind === 'requirement') {
    return `${decision.kind}:${decision.runId}:${decision.requirementId}:${decision.decisionRequest?.id ?? ''}`;
  }
  if (decision.kind === 'plan') return `${decision.kind}:${decision.runId}:${decision.planId}`;
  if (decision.kind === 'review') return `${decision.kind}:${decision.runId}`;
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
  language,
  loading,
  onSend,
  onStop,
  onAddAttachment,
  onRemoveAttachment,
  pendingDecision,
  onDecisionSubmit,
  onDecisionReject,
}) => {
  const [value, setValue] = useState('');
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const [decisionCopyStatus, setDecisionCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const [lastAttachmentDirectory, setLastAttachmentDirectory] = useState<string | null>(() =>
    readLastAttachmentDirectory()
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const defaultDecisionOptionRef = useRef<HTMLButtonElement | null>(null);
  const focusedOptionClickConfirmRef = useRef<string | null>(null);
  const activeFolder = useWorkspaceStore((s) => s.getActiveFolder());
  const activeWorkspaceRoot = activeFolder?.absolutePath;
  const previewEditor = String(
    useSettingsStore((s) => s.effectiveSettings['workbench.previewEditor'] ?? 'vscode')
  );

  const mention = useMemo(() => {
    const match = value.match(/@([^@\s]*)$/);
    if (!match) return null;
    return { query: match[1], start: match.index ?? value.length - match[0].length };
  }, [value]);

  const decisionKey = decisionInstanceKey(pendingDecision);
  const technicalChoiceOptions = pendingDecision && isTechnicalChoiceDecision(pendingDecision)
    ? pendingDecision.decisionRequest.options
    : [];
  const defaultChoice = recommendedChoice(technicalChoiceOptions);
  const selectedChoice = technicalChoiceOptions.find((option) => option.id === selectedChoiceId)
    ?? defaultChoice;

  useEffect(() => {
    setSelectedChoiceId(defaultChoice?.id ?? null);
    setDecisionCopyStatus('idle');
    focusedOptionClickConfirmRef.current = null;
  }, [decisionKey, defaultChoice?.id]);

  const send = () => {
    const nextValue = value;
    if (pendingDecision) {
      if (pendingDecision.resolving) return;
      if (isTechnicalChoiceDecision(pendingDecision) && selectedChoice) {
        const parsed = parseTechnicalChoiceInput(nextValue, selectedChoice);
        setValue('');
        setSelectedChoiceId(parsed.option.id);
        if (parsed.action === 'reject') {
          void onDecisionReject?.();
          return;
        }
        void onDecisionSubmit?.(decisionChoiceGuidance(parsed.option, parsed.supplement, language), 'accept');
        return;
      }
      const normalized = normalizeDecisionInput(pendingDecision, nextValue);
      setValue('');
      if (normalized.action === 'reject') {
        void onDecisionReject?.();
        return;
      }
      void onDecisionSubmit?.(normalized.guidance, normalized.action);
      return;
    }
    if (!nextValue.trim()) return;
    setValue('');
    void onSend(nextValue);
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
    textarea.style.height = '34px';
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 34), 150)}px`;
  }, [value]);

  useEffect(() => {
    setLastAttachmentDirectory(readLastAttachmentDirectory(activeWorkspaceRoot));
  }, [activeWorkspaceRoot]);

  const pickAttachment = (attachment: AgentContextAttachment) => {
    onAddAttachment(attachment);
    if (mention) {
      setValue(`${value.slice(0, mention.start)}${value.slice(mention.start + mention.query.length + 1)}`);
    }
  };

  const updateValue = (nextValue: string) => {
    setValue(nextValue);
  };

  const chips = [...sessionAttachments, ...messageAttachments];
  const composerExpanded = Boolean(value.trim() || chips.length > 0 || attachmentDialogOpen || mention || pendingDecision);
  const decisionText = pendingDecision ? composerDecisionText(pendingDecision, language) : null;
  const decisionResolving = Boolean(pendingDecision?.resolving);
  const sendDisabled = loading
    ? false
    : pendingDecision
      ? decisionResolving
      : !value.trim();
  const sendLabel = decisionResolving
    ? t(language, 'agent.composer.decision.resolving')
    : loading
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

  const pickUserSelectedAttachment = (picked: PickedUserAttachment) => {
    const absolutePath = selectedAttachmentPath(picked.absolutePath);
    const workspacePath = activeFolder?.absolutePath
      ? relativeToWorkspacePath(activeFolder.absolutePath, absolutePath)
      : null;
    onAddAttachment({
      kind: picked.kind,
      path: workspacePath ?? absolutePath,
      absolutePath,
      folderId: workspacePath && activeFolder ? activeFolder.id : undefined,
      source: 'userSelected',
      scope: 'message',
    });
  };

  const updateLastAttachmentDirectory = (absolutePath: string) => {
    const normalized = selectedAttachmentPath(absolutePath);
    setLastAttachmentDirectory(normalized);
    writeLastAttachmentDirectory(activeWorkspaceRoot, normalized);
  };

  const dialogInitialDirectory = lastAttachmentDirectory ?? activeFolder?.absolutePath ?? null;
  const armFocusedOptionClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    optionId: string
  ) => {
    focusedOptionClickConfirmRef.current = document.activeElement === event.currentTarget
      ? optionId
      : null;
  };

  const selectTechnicalChoice = (option: AgentComposerDecisionOption) => {
    if (!pendingDecision || pendingDecision.resolving) return;
    if (focusedOptionClickConfirmRef.current === option.id) {
      send();
      return;
    }
    setSelectedChoiceId(option.id);
    focusedOptionClickConfirmRef.current = null;
  };

  const focusTechnicalChoice = (option: AgentComposerDecisionOption) => {
    if (!pendingDecision || pendingDecision.resolving) return;
    setSelectedChoiceId(option.id);
  };

  const activatePrimaryDecisionOption = () => {
    if (!pendingDecision || pendingDecision.resolving) return;
    if (focusedOptionClickConfirmRef.current === PRIMARY_DECISION_OPTION_ID) {
      send();
    }
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
          disabled={decisionResolving}
          onKeyDown={handleDecisionShortcut}
          placeholder={pendingDecision ? decisionPlaceholder(pendingDecision, language) : undefined}
        />
        {mention && (
          <ContextAttachmentPicker
            query={mention.query}
            language={language}
            onPick={pickAttachment}
          />
        )}
      </div>
    </div>
  );

  return (
    <div className={`agent-composer${composerExpanded ? ' agent-composer--expanded' : ''}${pendingDecision ? ' agent-composer--decision' : ''}`}>
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
            {technicalChoiceOptions.length > 0 && (
              <div className="agent-composer-decision__count">
                {decisionChoiceCount(technicalChoiceOptions, language)}
              </div>
            )}
          </div>
          {decisionText.summary && <div className="agent-composer-decision__summary">{decisionText.summary}</div>}
          {decisionResolving ? (
            <div className="agent-composer-decision__resolving">
              {t(language, 'agent.composer.decision.resolvingDetail')}
            </div>
          ) : (
            <>
              <div
                className={`agent-composer-decision__options${
                  technicalChoiceOptions.length > 0 ? ' agent-composer-decision__options--choices' : ''
                }`}
              >
                {technicalChoiceOptions.length > 0 ? technicalChoiceOptions.map((option, index) => (
                  <button
                    key={option.id}
                    className={`agent-composer-decision__option${option.id === selectedChoice?.id ? ' agent-composer-decision__option--selected' : ''}`}
                    type="button"
                    disabled={decisionResolving}
                    title={option.description}
                    ref={option.id === defaultChoice?.id ? defaultDecisionOptionRef : undefined}
                    onMouseDown={(event) => armFocusedOptionClick(event, option.id)}
                    onFocus={() => focusTechnicalChoice(option)}
                    onClick={() => selectTechnicalChoice(option)}
                  >
                    <span className="agent-composer-decision__number">{index + 1}</span>
                    <span className="agent-composer-decision__option-body">
                      <span className="agent-composer-decision__label">
                        {option.label}
                        {option.recommended && (
                          <span className="agent-composer-decision__recommended">
                            {t(language, 'agent.composer.decision.recommended')}
                          </span>
                        )}
                      </span>
                      {option.description && (
                        <span className="agent-composer-decision__description">{option.description}</span>
                      )}
                    </span>
                  </button>
                )) : (
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
                )}
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
              key={`${attachment.scope}:${attachment.folderId ?? ''}:${attachment.path}`}
              className={`agent-chip agent-chip--${attachment.scope}`}
              title={attachment.path || t(language, 'agent.composer.workspaceRoot')}
              onClick={() => onRemoveAttachment(attachment.path, attachment.scope)}
              type="button"
            >
              {attachmentLabel(attachment, language)}
              <span>x</span>
            </button>
          ))}
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
            />
          )}
        </div>
      )}
      {!pendingDecision && <div className="agent-composer__footer">
        <div className="agent-composer__footer-left">
          <div className="agent-composer__attach-wrap">
            <button
              className="agent-add-file-button"
              type="button"
              title={t(language, 'agent.composer.addFile')}
              aria-label={t(language, 'agent.composer.addFile')}
              onClick={() => setAttachmentDialogOpen(true)}
            >
              +
            </button>
          </div>
        </div>
        <button
          className={loading ? 'agent-composer__send-button--stop' : undefined}
          onClick={loading ? onStop : send}
          disabled={sendDisabled}
          type="button"
          title={loading
            ? t(language, 'agent.composer.stopTitle')
            : t(language, 'agent.composer.sendTitle')}
        >
          {sendLabel}
        </button>
      </div>}
      <UserAttachmentDialog
        visible={attachmentDialogOpen}
        initialDirectory={dialogInitialDirectory}
        language={language}
        onClose={() => setAttachmentDialogOpen(false)}
        onPick={pickUserSelectedAttachment}
        onDirectoryChange={updateLastAttachmentDirectory}
      />
    </div>
  );
};

export default AgentComposer;
