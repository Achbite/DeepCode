import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';
import ToolCallBubble from './ToolCallBubble';

interface MessageListProps {
  events: AgentEvent[];
}

function payloadText(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'content' in payload) {
    return String((payload as any).content ?? '');
  }
  if (payload && typeof payload === 'object' && 'message' in payload) {
    return String((payload as any).message ?? '');
  }
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
}

const MessageList: React.FC<MessageListProps> = ({ events }) => (
  <div className="agent-message-list">
    {events.length === 0 && (
      <div className="agent-empty-state">
        <div className="agent-empty-state__title">Agent Ready</div>
        <div className="agent-empty-state__subtle">
          Add files with @ or Explorer right click, then ask for a focused edit.
        </div>
      </div>
    )}

    {events.map((event) => {
      if (event.kind === 'tool_call' || event.kind === 'tool_result') {
        return <ToolCallBubble key={event.id} event={event} />;
      }
      if (event.kind === 'permission_request' || event.kind === 'permission_result') {
        return <ToolCallBubble key={event.id} event={event} />;
      }
      return (
        <div
          key={event.id}
          className={`agent-message agent-message--${event.kind}`}
        >
          <div className="agent-message__meta">{event.kind}</div>
          <div className="agent-message__body">{payloadText(event.payload)}</div>
        </div>
      );
    })}
  </div>
);

export default MessageList;
