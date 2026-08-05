import React, { useEffect } from 'react';
import { createWorkspaceScopeKey } from '@deepcode/session-core';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { normalizeUiLanguage } from '../../i18n';
import AgentComposer from './AgentComposer';
import AgentSessionSelector from './AgentSessionSelector';
import AgentTaskList from './AgentTaskList';
import MessageList from './MessageList';
import PermissionRequestBubble from './PermissionRequestBubble';
import { findPendingComposerDecisionFromProjection } from './pendingDecision';
import { timelineOrEmpty } from '../../utils/uiTimelineProjection';
import './agentPanel.css';

const AgentPanel: React.FC = () => {
  const timeline = useAgentSessionStore((s) => s.timeline);
  const session = useAgentSessionStore((s) => s.session);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const loading = useAgentSessionStore((s) => s.loading);
  const runningSessionIds = useAgentSessionStore((s) => s.runningSessionIds);
  const activeRunSessionIds = useAgentSessionStore((s) => s.activeRunSessionIds);
  const cancellingSessionIds = useAgentSessionStore((s) => s.cancellingSessionIds);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const resolvingPermission = useAgentSessionStore((s) => s.resolvingPermission);
  const resolvingPlan = useAgentSessionStore((s) => s.resolvingPlan);
  const loadOrCreate = useAgentSessionStore((s) => s.loadOrCreate);
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
  const createNewSession = useAgentSessionStore((s) => s.createNewSession);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const renameSession = useAgentSessionStore((s) => s.renameSession);
  const archiveSession = useAgentSessionStore((s) => s.archiveSession);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const synchronizeAttachmentRoot = useAgentSessionStore((s) => s.synchronizeAttachmentRoot);
  const cancelCurrentRun = useAgentSessionStore((s) => s.cancelCurrentRun);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);
  const resolvePlan = useAgentSessionStore((s) => s.resolvePlan);
  const workspaceScopeKey = useWorkspaceStore((s) => createWorkspaceScopeKey(s.current));
  const activeFolderId = useWorkspaceStore((s) => (
    s.activeFolderId ?? s.getActiveFolder()?.id ?? null
  ));
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const activeSessionRunning = Boolean(
    session?.id
    && (
      runningSessionIds.includes(session.id)
      || activeRunSessionIds.includes(session.id)
      || cancellingSessionIds.includes(session.id)
    )
  );
  const timelineProjection = timelineOrEmpty(timeline, session?.id);
  const pendingDecision = findPendingComposerDecisionFromProjection({
    timeline: timelineProjection,
    resolvingPlan,
    resolvingPermission,
  });
  const pendingDecisionResolving = Boolean(pendingDecision?.resolving);
  const composerPendingDecision = pendingDecisionResolving || pendingDecision?.kind === 'permission' ? null : pendingDecision;
  const pendingPermissionRequest = pendingDecision?.kind === 'permission' ? pendingDecision.request : null;
  const agentBusy = loading || activeSessionRunning || pendingDecisionResolving;
  const attachmentWorkspaceBinding = session?.workspaceBinding;
  const allowGlobalAttachmentWorkspaceFallback = !session?.projectId;

  useEffect(() => {
    if (session?.projectId) return;
    void loadOrCreate();
    void refreshSessions();
  }, [loadOrCreate, refreshSessions, session?.projectId, workspaceScopeKey]);

  useEffect(() => {
    if (
      attachmentWorkspaceBinding
      && !attachmentWorkspaceBinding.activeFolderId
    ) {
      return;
    }
    synchronizeAttachmentRoot(
      attachmentWorkspaceBinding?.activeFolderId
        ?? (allowGlobalAttachmentWorkspaceFallback ? activeFolderId : null)
    );
  }, [
    activeFolderId,
    allowGlobalAttachmentWorkspaceFallback,
    attachmentWorkspaceBinding,
    synchronizeAttachmentRoot,
  ]);

  return (
    <div className="agent-panel-shell">
      <AgentSessionSelector
        session={session}
        sessions={sessions}
        language={language}
        loading={loading}
        onNew={() => void createNewSession()}
        onActivate={(sessionId) => void activateSession(sessionId)}
        onRename={(sessionId, title) => void renameSession(sessionId, title)}
        onArchive={(sessionId) => void archiveSession(sessionId)}
      />

      <AgentTaskList
        projection={timelineProjection}
        loading={agentBusy}
        language={language}
      />

      <MessageList
        timeline={timelineProjection}
        loading={agentBusy}
        language={language}
      />

      {pendingPermissionRequest && (
        <PermissionRequestBubble
          request={pendingPermissionRequest}
          language={language}
          disabled={Boolean(resolvingPermission)}
          resolvingDecision={
            resolvingPermission?.id === pendingPermissionRequest.id
              ? resolvingPermission.decision
              : null
          }
          onAccept={() => void acceptPermission(pendingPermissionRequest)}
          onReject={() => void rejectPermission(pendingPermissionRequest)}
        />
      )}

      {errorMessage && <div className="agent-panel-error">{errorMessage}</div>}

      <AgentComposer
        messageAttachments={messageAttachments}
        sessionAttachments={sessionAttachments}
        attachmentWorkspaceBinding={attachmentWorkspaceBinding}
        allowGlobalAttachmentWorkspaceFallback={allowGlobalAttachmentWorkspaceFallback}
        language={language}
        loading={agentBusy}
        onSend={(content) => void sendMessage(content)}
        onStop={() => void cancelCurrentRun()}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
        pendingDecision={composerPendingDecision}
        onDecisionSubmit={(guidance, action) => {
          if (!composerPendingDecision) return;
          const decision = action ?? (guidance ? 'revise' : 'accept');
          if (composerPendingDecision.kind === 'plan') {
            void resolvePlan(
              composerPendingDecision.runId,
              composerPendingDecision.planId,
              decision,
              guidance
            );
          }
        }}
        onDecisionReject={() => {
          if (!composerPendingDecision) return;
          if (composerPendingDecision.kind === 'plan') {
            void resolvePlan(composerPendingDecision.runId, composerPendingDecision.planId, 'reject');
          }
        }}
      />
    </div>
  );
};

export default AgentPanel;
