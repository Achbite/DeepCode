import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentContextAttachment } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import { pickUserAttachment } from '../../services/runtimeAdapter';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import ContextAttachmentPicker from './ContextAttachmentPicker';

interface AgentComposerProps {
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  language: UiLanguage;
  loading: boolean;
  onSend: (content: string) => void | Promise<void>;
  onStop: () => void;
  onAddAttachment: (attachment: AgentContextAttachment) => void;
  onRemoveAttachment: (path: string, scope: AgentContextAttachment['scope']) => void;
}

interface AgentModifiedFileView {
  path: string;
  savepoint: string;
}

const MODIFIED_FILES: AgentModifiedFileView[] = [];

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

const AgentComposer: React.FC<AgentComposerProps> = ({
  messageAttachments,
  sessionAttachments,
  language,
  loading,
  onSend,
  onStop,
  onAddAttachment,
  onRemoveAttachment,
}) => {
  const [value, setValue] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeFolder = useWorkspaceStore((s) => s.getActiveFolder());
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

  const pickAttachment = (attachment: AgentContextAttachment) => {
    onAddAttachment(attachment);
    if (mention) {
      setValue(`${value.slice(0, mention.start)}${value.slice(mention.start + mention.query.length + 1)}`);
    }
    setPickerOpen(false);
  };

  const chips = [...sessionAttachments, ...messageAttachments];
  const composerExpanded = Boolean(value.trim() || chips.length > 0 || pickerOpen || mention);

  const openModifiedFile = (file: AgentModifiedFileView) => {
    const absolutePath = activeFolder?.absolutePath
      ? joinWorkspacePath(activeFolder.absolutePath, file.path)
      : null;
    if (!absolutePath) return;
    if (previewEditor === 'vscode') {
      openVscodeFile(absolutePath);
    }
  };

  const pickUserSelectedAttachment = async () => {
    const result = await pickUserAttachment();
    if (!result.ok) {
      setPickerOpen((open) => !open);
      return;
    }
    if (!result.data) return;
    const absolutePath = selectedAttachmentPath(result.data.absolutePath);
    const workspacePath = activeFolder?.absolutePath
      ? relativeToWorkspacePath(activeFolder.absolutePath, absolutePath)
      : null;
    onAddAttachment({
      kind: result.data.kind,
      path: workspacePath ?? absolutePath,
      absolutePath,
      folderId: workspacePath && activeFolder ? activeFolder.id : undefined,
      source: 'userSelected',
      scope: 'message',
    });
    setPickerOpen(false);
  };

  return (
    <div className={`agent-composer ${composerExpanded ? 'agent-composer--expanded' : ''}`}>
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
              event.preventDefault();
              send();
            }
          }}
          placeholder={
            loading
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
              aria-expanded={pickerOpen}
              onClick={() => {
                void pickUserSelectedAttachment();
              }}
            >
              +
            </button>
            {pickerOpen && (
              <ContextAttachmentPicker
                query=""
                language={language}
                onPick={pickAttachment}
              />
            )}
          </div>
        </div>
        <button
          className={loading ? 'agent-composer__send-button--stop' : undefined}
          onClick={loading ? onStop : send}
          disabled={loading ? false : !value.trim()}
          type="button"
          title={loading
            ? t(language, 'agent.composer.stopTitle')
            : t(language, 'agent.composer.sendTitle')}
        >
          {loading ? t(language, 'agent.composer.stop') : t(language, 'agent.composer.send')}
        </button>
      </div>
    </div>
  );
};

export default AgentComposer;
