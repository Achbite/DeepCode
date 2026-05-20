import React from 'react';
import type { PermissionRequest } from '@deepcode/protocol';

interface PermissionRequestBubbleProps {
  request: PermissionRequest;
  onAccept: () => void;
  onReject: () => void;
  disabled?: boolean;
}

const PermissionRequestBubble: React.FC<PermissionRequestBubbleProps> = ({
  request,
  onAccept,
  onReject,
  disabled,
}) => (
  <div className="agent-permission">
    <div className="agent-permission__title">{request.summary}</div>
    <div className="agent-permission__meta">
      {request.toolName} · {request.riskLevel}
    </div>
    {request.diff && <pre className="agent-permission__diff">{request.diff}</pre>}
    <div className="agent-permission__actions">
      <button onClick={onAccept} disabled={disabled}>Accept</button>
      <button onClick={onReject} disabled={disabled}>Reject</button>
    </div>
  </div>
);

export default PermissionRequestBubble;
