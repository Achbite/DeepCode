import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentContextAttachment } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import ContextAttachmentPicker from './ContextAttachmentPicker';
import UserAttachmentDialog, { type PickedUserAttachment } from './UserAttachmentDialog';
import type { AgentComposerPendingDecision } from './pendingDecision';

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
  onDecisionSubmit?: (guidance?: string) => void | Promise<void>;
  onDecisionReject?: () => void | Promise<void>;
}

interface AgentModifiedFileView {
  path: string;
  savepoint: string;
}

const MODIFIED_FILES: AgentModifiedFileView[] = [];
const LAST_ATTACHMENT_DIRECTORY_KEY_PREFIX = 'deepcode.agent.lastAttachmentDirectory';

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

function isImeComposing(event: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  const syntheticEvent = event as React.KeyboardEvent<HTMLTextAreaElement> & { isComposing?: boolean };
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
  return Boolean(
    syntheticEvent.isComposing ||
    nativeEvent.isComposing ||
    nativeEvent.keyCode === 229 ||
    event.keyCode === 229
  );
}

function composerDecisionText(decision: AgentComposerPendingDecision, language: UiLanguage): { title: string; summary?: string } {
  const fallbackTitle = decision.kind === 'requirement'
    ? t(language, 'agent.composer.decision.requirement')
    : decision.kind === 'plan'
    ? t(language, 'agent.composer.decision.plan')
    : decision.kind === 'review'
      ? t(language, 'agent.composer.decision.review')
      : t(language, 'agent.composer.decision.permission');
  return {
    title: decision.title || fallbackTitle,
    summary: decision.summary,
  };
}

function decisionPlaceholder(decision: AgentComposerPendingDecision, language: UiLanguage): string {
  if (decision.kind === 'requirement') return t(language, 'agent.composer.decision.requirementPlaceholder');
  if (decision.kind === 'plan') return t(language, 'agent.composer.decision.planPlaceholder');
  if (decision.kind === 'review') return t(language, 'agent.composer.decision.reviewPlaceholder');
  return t(language, 'agent.composer.decision.permissionPlaceholder');
}

function decisionSubmitLabel(decision: AgentComposerPendingDecision, value: string, language: UiLanguage): string {
  if (decision.kind === 'permission') return t(language, 'agent.permission.accept');
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
  return value.trim()
    ? t(language, 'agent.composer.decision.submitGuidanceTitle')
    : t(language, 'agent.composer.decision.acceptTitle');
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
  const [attachmentDialogOpen, setAttachmentDialogOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const [lastAttachmentDirectory, setLastAttachmentDirectory] = useState<string | null>(() =>
    readLastAttachmentDirectory()
  );
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
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

  const send = () => {
    const nextValue = value;
    if (pendingDecision) {
      if (pendingDecision.resolving) return;
      setValue('');
      void onDecisionSubmit?.(nextValue.trim() || undefined);
      return;
    }
    if (!nextValue.trim()) return;
    setValue('');
    void onSend(nextValue);
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

  const chips = [...sessionAttachments, ...messageAttachments];
  const composerExpanded = Boolean(value.trim() || chips.length > 0 || attachmentDialogOpen || mention || pendingDecision);
  const decisionText = pendingDecision ? composerDecisionText(pendingDecision, language) : null;
  const sendDisabled = loading
    ? false
    : pendingDecision
      ? Boolean(pendingDecision.resolving)
      : !value.trim();
  const sendLabel = loading
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

  return (
    <div className={`agent-composer ${composerExpanded ? 'agent-composer--expanded' : ''}`}>
      {decisionText && (
        <div className="agent-composer-decision">
          <div className="agent-composer-decision__title">{decisionText.title}</div>
          {decisionText.summary && <div className="agent-composer-decision__summary">{decisionText.summary}</div>}
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
      <div className="agent-composer__input-wrap">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              if (isImeComposing(event)) return;
              event.preventDefault();
              send();
            }
          }}
          placeholder={
            pendingDecision
              ? decisionPlaceholder(pendingDecision, language)
              : loading
              ? t(language, 'agent.composer.placeholder.running')
              : t(language, 'agent.composer.placeholder.idle')
          }
        />
        {mention && (
          <ContextAttachmentPicker
            query={mention.query}
            language={language}
            onPick={pickAttachment}
          />
        )}
      </div>
      <div className="agent-composer__footer">
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
            : pendingDecision
              ? decisionSubmitTitle(pendingDecision, value, language)
              : t(language, 'agent.composer.sendTitle')}
        >
          {sendLabel}
        </button>
        {pendingDecision && !loading && (
          <button
            className="agent-composer__reject-button"
            onClick={() => void onDecisionReject?.()}
            disabled={Boolean(pendingDecision.resolving)}
            type="button"
            title={t(language, 'agent.composer.decision.rejectTitle')}
          >
            {t(language, 'agent.composer.decision.reject')}
          </button>
        )}
      </div>
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
