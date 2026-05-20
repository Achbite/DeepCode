import React, { useMemo, useState } from 'react';
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
      <div className="agent-composer__input-wrap">
        <textarea
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
        <span>@ to attach files or folders</span>
        <button onClick={send} disabled={loading || !value.trim()}>
          Send
        </button>
      </div>
    </div>
  );
};

export default AgentComposer;
