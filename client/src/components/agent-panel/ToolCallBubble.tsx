import React from 'react';
import type { AgentEvent } from '@deepcode/protocol';

interface ToolCallBubbleProps {
  event: AgentEvent;
}

const ToolCallBubble: React.FC<ToolCallBubbleProps> = ({ event }) => (
  <div className={`agent-tool-bubble agent-tool-bubble--${event.kind}`}>
    <div className="agent-tool-bubble__header">{event.kind}</div>
    <pre>{JSON.stringify(event.payload, null, 2)}</pre>
  </div>
);

export default ToolCallBubble;
