import React, { useEffect, useState } from 'react';
import type { AgentMode, LlmProviderProfile } from '@deepcode/protocol';
import { getLlmProfiles } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import AgentComposer from './AgentComposer';
import MessageList from './MessageList';
import PermissionRequestBubble from './PermissionRequestBubble';
import './agentPanel.css';

const MODES: Array<{ value: AgentMode; label: string }> = [
  { value: 'readOnly', label: 'Read Only' },
  { value: 'plan', label: 'Plan' },
  { value: 'askBeforeWrite', label: 'Act' },
];

const AgentPanel: React.FC = () => {
  const session = useAgentSessionStore((s) => s.session);
  const events = useAgentSessionStore((s) => s.events);
  const mode = useAgentSessionStore((s) => s.mode);
  const profileId = useAgentSessionStore((s) => s.profileId);
  const loading = useAgentSessionStore((s) => s.loading);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const pendingPermission = useAgentSessionStore((s) => s.pendingPermission);
  const loadOrCreate = useAgentSessionStore((s) => s.loadOrCreate);
  const setMode = useAgentSessionStore((s) => s.setMode);
  const setProfileId = useAgentSessionStore((s) => s.setProfileId);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);

  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([]);

  useEffect(() => {
    void loadOrCreate();
    getLlmProfiles().then((result) => {
      if (result.ok && result.data) {
        setProfiles(result.data.profiles);
        setProfileId(profileId ?? result.data.defaultProfileId);
      }
    });
  }, [loadOrCreate, profileId, setProfileId]);

  return (
    <div className="agent-panel-shell">
      <div className="agent-panel-toolbar">
        <select
          value={profileId ?? ''}
          onChange={(event) => setProfileId(event.target.value || undefined)}
        >
          <option value="">No profile</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
        <select
          value={mode}
          onChange={(event) => setMode(event.target.value as AgentMode)}
        >
          {MODES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <div className="agent-session-caption">
        {session?.title ?? 'Agent Session'}
      </div>

      <MessageList events={events} />

      {pendingPermission && (
        <PermissionRequestBubble
          request={pendingPermission.request}
          disabled={loading}
          onAccept={() => void acceptPermission()}
          onReject={() => void rejectPermission()}
        />
      )}

      {errorMessage && <div className="agent-panel-error">{errorMessage}</div>}

      <AgentComposer
        messageAttachments={messageAttachments}
        sessionAttachments={sessionAttachments}
        loading={loading}
        onSend={(content) => void sendMessage(content)}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
      />
    </div>
  );
};

export default AgentPanel;
