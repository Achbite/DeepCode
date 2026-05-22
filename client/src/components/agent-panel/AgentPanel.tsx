import React, { useEffect, useState } from 'react';
import type { LlmProviderProfile } from '@deepcode/protocol';
import { getLlmProfiles } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import AgentComposer from './AgentComposer';
import MessageList from './MessageList';
import PermissionRequestBubble from './PermissionRequestBubble';
import './agentPanel.css';

interface AgentTaskView {
  id: string;
  title: string;
  status: 'waiting' | 'planned' | 'running';
  commands: string[];
}

const INITIAL_TASKS: AgentTaskView[] = [
  {
    id: 'task-plan',
    title: '等待 Agent 生成任务规划',
    status: 'waiting',
    commands: [
      '任务开始后，这里会显示 plan / read / diff / write 等步骤。',
      '涉及 shell 的动作会先以 proposed command 形式展示。',
    ],
  },
  {
    id: 'task-context',
    title: '上下文与文件绑定检查',
    status: 'planned',
    commands: [
      '检查本轮消息绑定的文件和文件夹。',
      '按需读取强绑定文件，目录只展开摘要。',
    ],
  },
];

const AgentPanel: React.FC = () => {
  const events = useAgentSessionStore((s) => s.events);
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

  const [expandedTaskId, setExpandedTaskId] = useState<string | null>('task-plan');
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
      <div className="agent-task-list">
        <div className="agent-task-list__header">
          <span>Agent Task</span>
        </div>
        <div className="agent-task-list__body">
          {INITIAL_TASKS.map((task) => {
            const expanded = expandedTaskId === task.id;
            return (
              <div
                key={task.id}
                className={`agent-task-item agent-task-item--${task.status} ${
                  expanded ? 'agent-task-item--expanded' : ''
                }`}
              >
                <button
                  className="agent-task-item__summary"
                  onClick={() => setExpandedTaskId(expanded ? null : task.id)}
                  type="button"
                >
                  <span className="agent-task-item__dot" />
                  <span className="agent-task-item__title">{task.title}</span>
                  <span className="agent-task-item__chevron">{expanded ? 'Hide' : 'Show'}</span>
                </button>
                {expanded && (
                  <div className="agent-task-item__commands">
                    {task.commands.map((command, index) => (
                      <div key={`${task.id}:${index}`} className="agent-task-command">
                        {command}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
