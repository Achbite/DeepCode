import React, { useEffect } from 'react';
import { createWorkspaceScopeKey } from '@deepcode/session-core';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { useSettingsStore } from '../../state/settingsStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { normalizeUiLanguage, t } from '../../i18n';
import AgentComposer from './AgentComposer';
import AgentSessionSelector from './AgentSessionSelector';
import AgentTaskList from './AgentTaskList';
import MessageList from './MessageList';
import PermissionRequestBubble from './PermissionRequestBubble';
import {
  findCanonicalPendingInteractionBlockId,
  findPendingComposerDecisionFromProjection,
} from './pendingDecision';
import { timelineOrEmpty } from '../../utils/uiTimelineProjection';
import './agentPanel.css';

const AgentPanel: React.FC = () => {
  const timeline = useAgentSessionStore((s) => s.timeline);
  const session = useAgentSessionStore((s) => s.session);
  const sessions = useAgentSessionStore((s) => s.sessions);
  const loading = useAgentSessionStore((s) => s.loading);
  const selectionReady = useAgentSessionStore((s) => s.selectionReady);
  const localWorkspaceScopeKey = useAgentSessionStore((s) => s.localWorkspaceScopeKey);
  const cancellingSessionIds = useAgentSessionStore((s) => s.cancellingSessionIds);
  const activeSubmissionSessionIds = useAgentSessionStore((s) => s.activeSubmissionSessionIds);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const resolvingPermission = useAgentSessionStore((s) => s.resolvingPermission);
  const resolvingPlan = useAgentSessionStore((s) => s.resolvingPlan);
  const resolvingIntervention = useAgentSessionStore((s) => s.resolvingIntervention);
  const loadCurrentSelection = useAgentSessionStore((s) => s.loadCurrentSelection);
  const observeSessionProjection = useAgentSessionStore((s) => s.observeSessionProjection);
  const createNewSession = useAgentSessionStore((s) => s.createNewSession);
  const activateSession = useAgentSessionStore((s) => s.activateSession);
  const renameSession = useAgentSessionStore((s) => s.renameSession);
  const archiveSession = useAgentSessionStore((s) => s.archiveSession);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const cancelCurrentRun = useAgentSessionStore((s) => s.cancelCurrentRun);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);
  const resolvePlan = useAgentSessionStore((s) => s.resolvePlan);
  const resolveUserIntervention = useAgentSessionStore((s) => s.resolveUserIntervention);
  const workspaceScopeKey = useWorkspaceStore((s) => createWorkspaceScopeKey(s.current));
  const language = normalizeUiLanguage(
    useSettingsStore((s) => s.effectiveSettings['workbench.language'])
  );
  const timelineProjection = timelineOrEmpty(timeline, session?.id);
  const projectedRunActive = Boolean(
    timelineProjection.runProjection
    && ['active', 'waitingUser', 'waitingExternal', 'paused'].includes(
      timelineProjection.runProjection.status
    )
  );
  const activeSessionMutation = Boolean(
    session?.id
    && (
      activeSubmissionSessionIds.includes(session.id)
      || cancellingSessionIds.includes(session.id)
    )
  );
  const pendingDecision = findPendingComposerDecisionFromProjection({
    timeline: timelineProjection,
    resolvingPlan,
    resolvingPermission,
    resolvingIntervention,
  });
  const pendingDecisionResolving = Boolean(pendingDecision?.resolving);
  const composerPendingDecision = pendingDecision?.kind === 'permission' ? null : pendingDecision;
  const pendingPermissionRequest = pendingDecision?.kind === 'permission' ? pendingDecision.request : null;
  const pendingInteractionBlockId = pendingDecision?.kind === 'userIntervention'
    ? findCanonicalPendingInteractionBlockId(timelineProjection)
    : null;
  const suppressedBlockIds = pendingInteractionBlockId
    ? new Set([pendingInteractionBlockId])
    : undefined;
  const agentBusy = loading
    || projectedRunActive
    || activeSessionMutation
    || pendingDecisionResolving;
  const waitingForUser = timelineProjection.runProjection?.status === 'waitingUser'
    || timelineProjection.runProjection?.wait?.kind === 'user';
  const cancellableRun = Boolean(
    timelineProjection.runProjection
    && ['active', 'waitingUser', 'waitingExternal', 'paused'].includes(
      timelineProjection.runProjection.status
    )
  );
  const agentReady = Boolean(
    !loading
    && selectionReady
    && session?.id
    && localWorkspaceScopeKey === workspaceScopeKey
    && timeline?.sessionId === session.id
  );
  useEffect(() => {
    if (!session?.id) return;
    const release = observeSessionProjection(session.id);
    return () => {
      void release();
    };
  }, [observeSessionProjection, session?.id]);

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
        loading={agentBusy && !waitingForUser}
        language={language}
      />

      <MessageList
        timeline={timelineProjection}
        loading={agentBusy && !waitingForUser}
        language={language}
        suppressedBlockIds={suppressedBlockIds}
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

      {errorMessage && (
        <div className="agent-panel-error">
          <span>{errorMessage}</span>
          {!agentReady && (
            <button type="button" onClick={() => void loadCurrentSelection()}>
              {t(language, 'deepcodeGui.statusAction.retry')}
            </button>
          )}
        </div>
      )}

      <AgentComposer
        messageAttachments={messageAttachments}
        sessionAttachments={sessionAttachments}
        language={language}
        loading={agentBusy}
        sendBlocked={!agentReady}
        sendBlockedTitle={!agentReady ? t(language, 'agent.readiness.pending') : undefined}
        onSend={sendMessage}
        submissionScopeId={session?.id ?? null}
        canCancelCurrentRun={Boolean(
          session?.id && cancellableRun
        )}
        cancellationPending={Boolean(
          session?.id && cancellingSessionIds.includes(session.id)
        )}
        onStop={() => void cancelCurrentRun(timeline?.runProjection?.runId)}
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
        onInterventionSelect={(optionId, guidance) => {
          if (composerPendingDecision?.kind !== 'userIntervention') return;
          void resolveUserIntervention({
            runId: composerPendingDecision.runId,
            targetId: composerPendingDecision.targetId,
            interactionId: composerPendingDecision.interactionId,
            interactionRevision: composerPendingDecision.interactionRevision,
            candidateSetDigest: composerPendingDecision.candidateSetDigest,
            expectedProjectionCursor: composerPendingDecision.projectionCursor,
            decision: 'select',
            optionId,
            guidance,
          });
        }}
        onInterventionRevise={(guidance) => {
          if (composerPendingDecision?.kind !== 'userIntervention') return;
          void resolveUserIntervention({
            runId: composerPendingDecision.runId,
            targetId: composerPendingDecision.targetId,
            interactionId: composerPendingDecision.interactionId,
            interactionRevision: composerPendingDecision.interactionRevision,
            candidateSetDigest: composerPendingDecision.candidateSetDigest,
            expectedProjectionCursor: composerPendingDecision.projectionCursor,
            decision: 'revise',
            guidance,
          });
        }}
        onDecisionReject={() => {
          if (!composerPendingDecision) return;
          if (composerPendingDecision.kind === 'plan') {
            void resolvePlan(composerPendingDecision.runId, composerPendingDecision.planId, 'reject');
          } else if (composerPendingDecision.kind === 'userIntervention') {
            void resolveUserIntervention({
              runId: composerPendingDecision.runId,
              targetId: composerPendingDecision.targetId,
              interactionId: composerPendingDecision.interactionId,
              interactionRevision: composerPendingDecision.interactionRevision,
              candidateSetDigest: composerPendingDecision.candidateSetDigest,
              expectedProjectionCursor: composerPendingDecision.projectionCursor,
              decision: 'reject',
            });
          }
        }}
      />
    </div>
  );
};

export default AgentPanel;
