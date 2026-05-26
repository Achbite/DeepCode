import React from 'react';
import type { PermissionRequest } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface PermissionRequestBubbleProps {
  request: PermissionRequest;
  language: UiLanguage;
  onAccept: () => void;
  onReject: () => void;
  disabled?: boolean;
}

const PermissionRequestBubble: React.FC<PermissionRequestBubbleProps> = ({
  request,
  language,
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
      <button onClick={onAccept} disabled={disabled}>{t(language, 'agent.permission.accept')}</button>
      <button onClick={onReject} disabled={disabled}>{t(language, 'agent.permission.reject')}</button>
    </div>
  </div>
);

export default PermissionRequestBubble;
