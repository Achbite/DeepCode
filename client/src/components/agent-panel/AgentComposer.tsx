import React, { useMemo, useRef, useState } from 'react';
import type {
  AgentContextAttachment,
  AgentWorkflowConfig,
  LlmProviderProfile,
} from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';
import ContextAttachmentPicker from './ContextAttachmentPicker';
import AgentWorkflowSelector from './AgentWorkflowSelector';

interface AgentComposerProps {
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  workflowConfig: AgentWorkflowConfig | null;
  profiles: LlmProviderProfile[];
  language: UiLanguage;
  loading: boolean;
  onSend: (content: string) => void;
  onStop: () => void;
  onAddAttachment: (attachment: AgentContextAttachment) => void;
  onRemoveAttachment: (path: string, scope: AgentContextAttachment['scope']) => void;
  onWorkflowConfigChange: (config: AgentWorkflowConfig) => void;
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

const AgentComposer: React.FC<AgentComposerProps> = ({
  messageAttachments,
  sessionAttachments,
  workflowConfig,
  profiles,
  language,
  loading,
  onSend,
  onStop,
  onAddAttachment,
  onRemoveAttachment,
  onWorkflowConfigChange,
}) => {
  const [value, setValue] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const mention = useMemo(() => {
    const match = value.match(/@([^@\s]*)$/);
    if (!match) return null;
    return { query: match[1], start: match.index ?? value.length - match[0].length };
  }, [value]);

  const send = () => {
    if (!value.trim()) return;
    onSend(value);
    setValue('');
  };

  const pickAttachment = (attachment: AgentContextAttachment) => {
    onAddAttachment(attachment);
    if (mention) {
      setValue(`${value.slice(0, mention.start)}${value.slice(mention.start + mention.query.length + 1)}`);
    }
    setPickerOpen(false);
  };

  const chips = [...sessionAttachments, ...messageAttachments];

  return (
    <div className="agent-composer">
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
      <div className={`agent-change-set ${changesOpen ? 'agent-change-set--open' : ''}`}>
        <button
          className="agent-change-set__header"
          type="button"
          onClick={() => setChangesOpen((open) => !open)}
        >
          <span>{t(language, 'agent.composer.modifiedFiles')}</span>
          <span>{MODIFIED_FILES.length}</span>
        </button>
        {changesOpen && MODIFIED_FILES.length > 0 && (
          <div className="agent-change-set__body">
            {MODIFIED_FILES.map((file) => (
              <div key={file.path} className="agent-change-file">
                <span className="agent-change-file__path" title={file.path}>
                  {file.path}
                </span>
                <span className="agent-change-file__savepoint">{file.savepoint}</span>
                <div className="agent-change-file__actions">
                  <button type="button" title={t(language, 'agent.composer.openDiff')}>diff</button>
                  <button type="button" title={t(language, 'agent.composer.rejectChanges')}>X</button>
                  <button type="button" title={t(language, 'agent.composer.acceptChanges')}>OK</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
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
              onClick={() => setPickerOpen((open) => !open)}
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
          <AgentWorkflowSelector
            profiles={profiles}
            config={workflowConfig}
            language={language}
            disabled={false}
            onChange={onWorkflowConfigChange}
          />
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
