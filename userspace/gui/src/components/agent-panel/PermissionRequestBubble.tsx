import React from 'react';
import type { PermissionRequest } from '@deepcode/protocol';
import { t, type UiLanguage } from '../../i18n';

interface PermissionRequestBubbleProps {
  request: PermissionRequest;
  language: UiLanguage;
  onAccept: () => void;
  onReject: () => void;
  disabled?: boolean;
  resolvingDecision?: 'accept' | 'reject' | null;
}

const PermissionRequestBubble: React.FC<PermissionRequestBubbleProps> = ({
  request,
  language,
  onAccept,
  onReject,
  disabled,
  resolvingDecision = null,
}) => {
  const [localDecision, setLocalDecision] = React.useState<'accept' | 'reject' | null>(null);
  const activeDecision = resolvingDecision ?? localDecision;
  const actionDisabled = disabled || Boolean(activeDecision);

  React.useEffect(() => {
    setLocalDecision(null);
  }, [request.id]);

  React.useEffect(() => {
    if (!resolvingDecision) setLocalDecision(null);
  }, [resolvingDecision]);

  const scheduleDecision = (decision: 'accept' | 'reject', callback: () => void) => {
    if (actionDisabled) return;
    setLocalDecision(decision);
    window.requestAnimationFrame(() => {
      callback();
    });
  };

  return (
    <div className={`agent-permission ${activeDecision ? 'agent-permission--resolving' : ''}`}>
      <div className="agent-permission__title">{request.summary}</div>
      <div className="agent-permission__meta">
        {request.toolName} · {request.riskLevel}
      </div>
      {activeDecision && (
        <div className="agent-permission__status">
          <span className="agent-spinner" />
          {activeDecision === 'accept'
            ? t(language, 'agent.permission.accepting')
            : t(language, 'agent.permission.rejecting')}
        </div>
      )}
      {request.diff && <pre className="agent-permission__diff">{request.diff}</pre>}
      <div className="agent-permission__actions">
        <button
          onClick={() => scheduleDecision('accept', onAccept)}
          disabled={actionDisabled}
        >
          {activeDecision === 'accept'
            ? t(language, 'agent.permission.accepting')
            : t(language, 'agent.permission.accept')}
        </button>
        <button
          onClick={() => scheduleDecision('reject', onReject)}
          disabled={actionDisabled}
        >
          {activeDecision === 'reject'
            ? t(language, 'agent.permission.rejecting')
            : t(language, 'agent.permission.reject')}
        </button>
      </div>
    </div>
  );
};

export default PermissionRequestBubble;
