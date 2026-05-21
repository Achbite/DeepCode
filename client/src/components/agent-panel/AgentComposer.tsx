import React, { useMemo, useRef, useState } from 'react';
import type { AgentContextAttachment } from '@deepcode/protocol';
import ContextAttachmentPicker from './ContextAttachmentPicker';

interface AgentComposerProps {
  messageAttachments: AgentContextAttachment[];
  sessionAttachments: AgentContextAttachment[];
  loading: boolean;
  onSend: (content: string) => void;
  onAddAttachment: (attachment: AgentContextAttachment) => void;
  onRemoveAttachment: (path: string, scope: AgentContextAttachment['scope']) => void;
}

interface AgentModifiedFileView {
  path: string;
  savepoint: string;
}

const MODIFIED_FILES: AgentModifiedFileView[] = [];

const AgentComposer: React.FC<AgentComposerProps> = ({
  messageAttachments,
  sessionAttachments,
  loading,
  onSend,
  onAddAttachment,
  onRemoveAttachment,
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
    if (!value.trim() || loading) return;
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

  const toggleAttachmentPicker = () => {
    if (loading) return;
    setPickerOpen((open) => !open);
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
              title={attachment.path || 'workspace root'}
              onClick={() => onRemoveAttachment(attachment.path, attachment.scope)}
            >
              {attachment.kind === 'directory' ? 'Dir' : 'File'} {attachment.path || '.'}
              <span>×</span>
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
          <span>Modified Files</span>
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
                  <button type="button" title="Open diff">
                    diff
                  </button>
                  <button type="button" title="Reject changes">
                    X
                  </button>
                  <button type="button" title="Accept changes">
                    √
                  </button>
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
          placeholder="Ask DeepCode Agent..."
          disabled={loading}
        />
        {mention && (
          <ContextAttachmentPicker
            query={mention.query}
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
              title="Add file or folder"
              aria-label="Add file or folder"
              disabled={loading}
              onClick={toggleAttachmentPicker}
            >
              +
            </button>
            {pickerOpen && (
              <ContextAttachmentPicker
                query=""
                onPick={pickAttachment}
              />
            )}
          </div>
        </div>
        <button onClick={send} disabled={loading || !value.trim()}>
          Send
        </button>
      </div>
    </div>
  );
};

export default AgentComposer;
