import React, { useEffect } from 'react';
import { getLlmProfiles } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { normalizeUiLanguage } from '../../i18n';
import AgentComposer from './AgentComposer';
import AgentSessionSelector from './AgentSessionSelector';
import AgentTaskList from './AgentTaskList';
import MessageList from './MessageList';
import PermissionRequestBubble from './PermissionRequestBubble';
import { findPendingComposerDecision } from './pendingDecision';
import './agentPanel.css';

const AgentPanel: React.FC = () => {
  const events = useAgentSessionStore((s) => s.events);
  const session = useAgentSessionStore((s) => s.session);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const traceEvents = useAgentSessionStore((s) => s.traceEvents);
  const profileId = useAgentSessionStore((s) => s.profileId);
  const loading = useAgentSessionStore((s) => s.loading);
  const runningSessionIds = useAgentSessionStore((s) => s.runningSessionIds);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const pendingPermission = useAgentSessionStore((s) => s.pendingPermission);
  const resolvingPermission = useAgentSessionStore((s) => s.resolvingPermission);
  const resolvingRequirement = useAgentSessionStore((s) => s.resolvingRequirement);
  const resolvingPlan = useAgentSessionStore((s) => s.resolvingPlan);
  const resolvingReview = useAgentSessionStore((s) => s.resolvingReview);
  const loadOrCreate = useAgentSessionStore((s) => s.loadOrCreate);
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
  const createNewSession = useAgentSessionStore((s) => s.createNewSession);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const renameSession = useAgentSessionStore((s) => s.renameSession);
  const archiveSession = useAgentSessionStore((s) => s.archiveSession);
  const setProfileId = useAgentSessionStore((s) => s.setProfileId);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const cancelCurrentRun = useAgentSessionStore((s) => s.cancelCurrentRun);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);
  const resolveRequirement = useAgentSessionStore((s) => s.resolveRequirement);
  const resolvePlan = useAgentSessionStore((s) => s.resolvePlan);
  const resolveReview = useAgentSessionStore((s) => s.resolveReview);
  const workspaceRevision = useWorkspaceStore((s) => s.treeRevision);
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const activeSessionRunning = Boolean(session?.id && runningSessionIds.includes(session.id));
  const agentBusy = loading || activeSessionRunning;
  const pendingDecision = findPendingComposerDecision({
    events,
    pendingPermission: pendingPermission?.request ?? null,
    resolvingRequirement,
    resolvingPlan,
    resolvingReview,
    resolvingPermission,
  });

  useEffect(() => {
    void loadOrCreate();
    void refreshSessions();
    const loadProfiles = () => getLlmProfiles().then((result) => {
      if (result.ok && result.data) {
        setProfileId(profileId ?? result.data.defaultProfileId);
      }
    });
    void loadProfiles();
    const onProfilesUpdated = () => {
      void loadProfiles();
    };
    window.addEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', onProfilesUpdated);
  }, [loadOrCreate, profileId, refreshSessions, setProfileId]);

  useEffect(() => {
    void loadOrCreate();
    void refreshSessions();
  }, [loadOrCreate, refreshSessions, workspaceRevision]);

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
        events={events}
        traceEvents={traceEvents}
        loading={agentBusy}
        language={language}
      />

      <MessageList
        events={events}
        loading={agentBusy}
        language={language}
        resolvingPlan={resolvingPlan}
        resolvingReview={resolvingReview}
        onPlanResolve={(runId, planId, decision, guidance) =>
          void resolvePlan(runId, planId, decision, guidance)
        }
        onReviewResolve={(runId, decision, guidance) =>
          void resolveReview(runId, decision, guidance)
        }
      />

      {pendingPermission && (
        <PermissionRequestBubble
          request={pendingPermission.request}
          language={language}
          disabled={Boolean(resolvingPermission)}
          resolvingDecision={
            resolvingPermission?.id === pendingPermission.request.id
              ? resolvingPermission.decision
              : null
          }
          onAccept={() => void acceptPermission()}
          onReject={() => void rejectPermission()}
        />
      )}

      {errorMessage && <div className="agent-panel-error">{errorMessage}</div>}

      <AgentComposer
        messageAttachments={messageAttachments}
        sessionAttachments={sessionAttachments}
        language={language}
        loading={agentBusy}
        onSend={(content) => void sendMessage(content)}
        onStop={() => void cancelCurrentRun()}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
        pendingDecision={pendingDecision}
        onDecisionSubmit={(guidance, action) => {
          if (!pendingDecision) return;
          const decision = action ?? (guidance ? 'revise' : 'accept');
          if (pendingDecision.kind === 'requirement') {
            void resolveRequirement(
              pendingDecision.runId,
              pendingDecision.requirementId,
              decision,
              guidance
            );
            return;
          }
          if (pendingDecision.kind === 'plan') {
            void resolvePlan(
              pendingDecision.runId,
              pendingDecision.planId,
              decision,
              guidance
            );
            return;
          }
          if (pendingDecision.kind === 'review') {
            void resolveReview(pendingDecision.runId, decision, guidance);
            return;
          }
          void acceptPermission();
        }}
        onDecisionReject={() => {
          if (!pendingDecision) return;
          if (pendingDecision.kind === 'requirement') {
            void resolveRequirement(pendingDecision.runId, pendingDecision.requirementId, 'reject');
            return;
          }
          if (pendingDecision.kind === 'plan') {
            void resolvePlan(pendingDecision.runId, pendingDecision.planId, 'reject');
            return;
          }
          if (pendingDecision.kind === 'review') {
            void resolveReview(pendingDecision.runId, 'revise');
            return;
          }
          void rejectPermission();
        }}
      />
    </div>
  );
};

export default AgentPanel;
