import React, { useEffect, useState } from 'react';
import type { LlmProviderProfile } from '@deepcode/protocol';
import { getLlmProfiles } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import AgentComposer from './AgentComposer';
import AgentTaskList from './AgentTaskList';
import MessageList from './MessageList';
import PermissionRequestBubble from './PermissionRequestBubble';
import './agentPanel.css';

const AgentPanel: React.FC = () => {
  const events = useAgentSessionStore((s) => s.events);
  const traceEvents = useAgentSessionStore((s) => s.traceEvents);
  const profileId = useAgentSessionStore((s) => s.profileId);
  const workflowConfig = useAgentSessionStore((s) => s.workflowConfig);
  const loading = useAgentSessionStore((s) => s.loading);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const pendingPermission = useAgentSessionStore((s) => s.pendingPermission);
  const loadOrCreate = useAgentSessionStore((s) => s.loadOrCreate);
  const loadWorkflowConfig = useAgentSessionStore((s) => s.loadWorkflowConfig);
  const patchWorkflowConfig = useAgentSessionStore((s) => s.patchWorkflowConfig);
  const setProfileId = useAgentSessionStore((s) => s.setProfileId);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);

  const [profiles, setProfiles] = useState<LlmProviderProfile[]>([]);

  useEffect(() => {
    void loadOrCreate();
    void loadWorkflowConfig();
    const loadProfiles = () => getLlmProfiles().then((result) => {
      if (result.ok && result.data) {
        setProfiles(result.data.profiles);
        setProfileId(profileId ?? result.data.defaultProfileId);
      }
    });
    void loadProfiles();
    const onProfilesUpdated = () => {
      void loadProfiles();
      void loadWorkflowConfig();
    };
    window.addEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
  }, [loadOrCreate, loadWorkflowConfig, profileId, setProfileId]);

  return (
    <div className="agent-panel-shell">
      <AgentTaskList events={events} traceEvents={traceEvents} loading={loading} />

      <MessageList events={events} loading={loading} />

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
        workflowConfig={workflowConfig}
        profiles={profiles}
        loading={loading}
        onSend={(content) => void sendMessage(content)}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
        onWorkflowConfigChange={(config) => void patchWorkflowConfig(config)}
      />
    </div>
  );
};

export default AgentPanel;
