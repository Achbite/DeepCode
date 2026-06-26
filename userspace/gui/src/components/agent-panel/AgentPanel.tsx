import React, { useEffect, useMemo } from 'react';
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
import { findPendingComposerDecisionFromProjection } from './pendingDecision';
import { buildUiTimelineProjection } from '../../utils/uiTimelineProjection';
import './agentPanel.css';

const AgentPanel: React.FC = () => {
  const events = useAgentSessionStore((s) => s.events);
  const activeDeltas = useAgentSessionStore((s) => s.activeDeltas);
  const session = useAgentSessionStore((s) => s.session);
  const sessions = useAgentSessionStore((s) => s.sessions);
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
  const timelineProjection = useMemo(
    () => buildUiTimelineProjection({
      sessionId: session?.id,
      events,
      activeDeltas,
    }),
    [activeDeltas, events, session?.id]
  );
  const pendingDecision = findPendingComposerDecisionFromProjection({
    timeline: timelineProjection,
    pendingPermission: pendingPermission?.request ?? null,
    resolvingRequirement,
    resolvingPlan,
    resolvingReview,
    resolvingPermission,
  });
  const pendingDecisionResolving = Boolean(pendingDecision?.resolving);
  const composerPendingDecision = pendingDecisionResolving ? null : pendingDecision;
  const agentBusy = loading || activeSessionRunning || pendingDecisionResolving;

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
        projection={timelineProjection}
        loading={agentBusy}
        language={language}
      />

      <MessageList
        timeline={timelineProjection}
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
        pendingDecision={composerPendingDecision}
        onDecisionSubmit={(guidance, action) => {
          if (!composerPendingDecision) return;
          const decision = action ?? (guidance ? 'revise' : 'accept');
          if (composerPendingDecision.kind === 'requirement') {
            void resolveRequirement(
              composerPendingDecision.runId,
              composerPendingDecision.requirementId,
              decision,
              guidance
            );
            return;
          }
          if (composerPendingDecision.kind === 'plan') {
            void resolvePlan(
              composerPendingDecision.runId,
              composerPendingDecision.planId,
              decision,
              guidance
            );
            return;
          }
          if (composerPendingDecision.kind === 'review') {
            void resolveReview(composerPendingDecision.runId, decision, guidance);
            return;
          }
          void acceptPermission();
        }}
        onDecisionReject={() => {
          if (!composerPendingDecision) return;
          if (composerPendingDecision.kind === 'requirement') {
            void resolveRequirement(composerPendingDecision.runId, composerPendingDecision.requirementId, 'reject');
            return;
          }
          if (composerPendingDecision.kind === 'plan') {
            void resolvePlan(composerPendingDecision.runId, composerPendingDecision.planId, 'reject');
            return;
          }
          if (composerPendingDecision.kind === 'review') {
            void resolveReview(composerPendingDecision.runId, 'reject');
            return;
          }
          void rejectPermission();
        }}
      />
    </div>
  );
};

export default AgentPanel;
