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
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const chips = [...sessionAttachments, ...messageAttachments];
  const showAttachmentPicker = pickerOpen || Boolean(mention);

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
      <div className="agent-composer__mention-row">
        <button
          className="agent-composer__mention-button"
          type="button"
          title="Attach file or folder"
          aria-label="Attach file or folder"
          disabled={loading}
          onClick={toggleAttachmentPicker}
        >
          @
        </button>
        {showAttachmentPicker && (
          <ContextAttachmentPicker
            query={mention?.query ?? ''}
            onPick={pickAttachment}
          />
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
      </div>
      <div className="agent-composer__footer">
        <div className="agent-composer__footer-left">
          <span className="agent-mode-pill">Plan</span>
        </div>
        <button onClick={send} disabled={loading || !value.trim()}>
          Send
        </button>
      </div>
    </div>
  );
};

export default AgentComposer;
