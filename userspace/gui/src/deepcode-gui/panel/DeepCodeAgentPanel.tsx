import React, { useEffect, useMemo, useState } from 'react';
import type {
  AgentComposerProjectionV1,
  AgentTimelineResult,
} from '@deepcode/protocol';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import type { AgentSessionSubmissionTarget } from '../../state/agentSessionStore';
import { t, type UiLanguage } from '../../i18n';
import AgentComposer from '../../components/agent-panel/AgentComposer';
import PermissionRequestBubble from '../../components/agent-panel/PermissionRequestBubble';
import {
  findCanonicalPendingInteractionBlockId,
  findPendingComposerDecisionFromProjection,
} from '../../components/agent-panel/pendingDecision';
import DeepCodeTimeline from './DeepCodeTimeline';
import PrivateAnalysisViewer from './PrivateAnalysisViewer';
import SessionModelSelector from './SessionModelSelector';

interface DeepCodeAgentPanelProps {
  language: UiLanguage;
  timeline: AgentTimelineResult;
  composer: AgentComposerProjectionV1 | null;
  composerLoading?: boolean;
  composerError?: string | null;
  selectedProfileId?: string;
  profileSelectionBusy?: boolean;
  forceHome?: boolean;
  homeProjectTitle?: string | null;
  submissionScopeId?: string | null;
  suppressPendingDecision?: boolean;
  onBeforeSend?: () => Promise<AgentSessionSubmissionTarget | boolean | void>
    | AgentSessionSubmissionTarget
    | boolean
    | void;
  onDraftSend?: (content: string, profileId?: string) => Promise<boolean>;
  onProfileChange: (profileId: string) => void | Promise<void>;
  onComposerRetry?: () => void | Promise<void>;
  onAfterSend?: (
    submissionScopeId: string | null,
    submittedDraftCleared: boolean
  ) => Promise<void> | void;
}

function displaySessionTitle(language: UiLanguage, title?: string): string {
  const value = title?.trim();
  if (!value || value === 'New Agent Session' || value === '新 Agent 会话') {
    return t(language, 'agent.session.newTitle');
  }
  return value;
}

const DeepCodeAgentPanel: React.FC<DeepCodeAgentPanelProps> = ({
  language,
  timeline,
  composer: composerProjection,
  composerLoading = false,
  composerError,
  selectedProfileId,
  profileSelectionBusy = false,
  forceHome = false,
  homeProjectTitle,
  submissionScopeId,
  suppressPendingDecision = false,
  onBeforeSend,
  onDraftSend,
  onProfileChange,
  onComposerRetry,
  onAfterSend,
}) => {
  const session = useAgentSessionStore((s) => s.session);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const cancellingSessionIds = useAgentSessionStore((s) => s.cancellingSessionIds);
  const resolvingPermission = useAgentSessionStore((s) => s.resolvingPermission);
  const resolvingPlan = useAgentSessionStore((s) => s.resolvingPlan);
  const resolvingIntervention = useAgentSessionStore((s) => s.resolvingIntervention);
  const observeSessionProjection = useAgentSessionStore((s) => s.observeSessionProjection);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const captureSubmissionTarget = useAgentSessionStore((s) => s.captureSubmissionTarget);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const cancelCurrentRun = useAgentSessionStore((s) => s.cancelCurrentRun);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);
  const resolvePlan = useAgentSessionStore((s) => s.resolvePlan);
  const resolveUserIntervention = useAgentSessionStore((s) => s.resolveUserIntervention);
  const [followLatestSignal, setFollowLatestSignal] = useState(0);
  const [bottomChromeElement, setBottomChromeElement] = useState<HTMLDivElement | null>(null);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const activeComposerRun = composerProjection?.activeRun;
  const sessionRunning = Boolean(activeComposerRun);
  const waitingForUser = timeline.runProjection?.status === 'waitingUser'
    || timeline.runProjection?.wait?.kind === 'user';
  const cancellableRun = Boolean(
    !forceHome && activeComposerRun?.status === 'active'
  );
  const cancellationPending = Boolean(
    session?.id && cancellingSessionIds.includes(session.id)
  );

  useEffect(() => {
    if (forceHome || !session?.id) return;
    const release = observeSessionProjection(session.id);
    return () => {
      void release();
    };
  }, [forceHome, observeSessionProjection, session?.id]);

  useEffect(() => {
    setAnalysisOpen(false);
  }, [forceHome, session?.id]);

  const activeSessionTitle = displaySessionTitle(language, session?.title);
  const hasTimelineTurns = timeline.turns.length > 0;
  const pendingDecision = suppressPendingDecision
    ? null
    : findPendingComposerDecisionFromProjection({
      timeline,
      resolvingPlan,
      resolvingPermission,
      resolvingIntervention,
    });
  const pendingInteractionBlockId = pendingDecision?.kind === 'userIntervention'
    ? findCanonicalPendingInteractionBlockId(timeline)
    : null;
  const suppressedBlockIds = useMemo(
    () => pendingInteractionBlockId
      ? new Set([pendingInteractionBlockId])
      : undefined,
    [pendingInteractionBlockId]
  );
  const pendingDecisionResolving = Boolean(pendingDecision?.resolving);
  const composerPendingDecision = pendingDecision?.kind !== 'permission'
    ? pendingDecision
    : null;
  const pendingPermissionRequest = pendingDecision?.kind === 'permission'
    ? pendingDecision.request
    : null;
  const showHome = forceHome || (
    !sessionRunning && !composerPendingDecision && !errorMessage
    && !hasTimelineTurns
  );
  const composerRunning = forceHome ? false : (sessionRunning || pendingDecisionResolving);
  const selectedProfileAvailable = Boolean(
    selectedProfileId
    && composerProjection?.enabledProfiles.some((profile) => profile.profileId === selectedProfileId)
  );
  const homePrompt = homeProjectTitle
    ? t(language, 'deepcodeGui.home.projectPrompt', { project: homeProjectTitle })
    : t(language, 'deepcodeGui.home.prompt');
  const requestFollowLatest = () => setFollowLatestSignal((value) => value + 1);

  const composer = (
    <AgentComposer
      messageAttachments={messageAttachments}
      sessionAttachments={sessionAttachments}
      language={language}
      loading={composerRunning}
      submissionScopeId={submissionScopeId ?? session?.id ?? null}
      canCancelCurrentRun={Boolean(
        session?.id && cancellableRun
      )}
      cancellationPending={cancellationPending}
      onSend={async (content) => {
        requestFollowLatest();
        if (onDraftSend) return onDraftSend(content, selectedProfileId);
        const prepared = await onBeforeSend?.();
        if (prepared === false) return false;
        const expectedTarget = typeof prepared === 'object' && prepared !== null
          ? prepared
          : captureSubmissionTarget();
        if (!expectedTarget) return false;
        return sendMessage(content, { expectedTarget });
      }}
      onSubmissionSettled={(
        admitted,
        settledSubmissionScopeId,
        submittedDraftCleared
      ) => {
        if (admitted && onAfterSend) {
          void Promise.resolve()
            .then(() => onAfterSend(
              settledSubmissionScopeId,
              submittedDraftCleared
            ))
            .catch(() => undefined);
        }
      }}
      onStop={() => void cancelCurrentRun(activeComposerRun?.runId)}
      onAddAttachment={addAttachment}
      onRemoveAttachment={removeAttachment}
      footerControls={(
        <SessionModelSelector
          language={language}
          composer={composerProjection}
          selectedProfileId={selectedProfileId}
          busy={profileSelectionBusy}
          onProfileChange={onProfileChange}
        />
      )}
      sendBlocked={composerLoading || !composerProjection?.canSubmit || !selectedProfileAvailable}
      sendBlockedTitle={composerLoading || !composerProjection
        ? t(language, 'agent.readiness.pending')
        : !selectedProfileAvailable
        ? t(
          language,
          session && !session.profileId
            ? 'agent.profile.selectionRequired'
            : 'agent.profile.unavailable'
        )
        : !composerProjection.canSubmit
        ? composerProjection.blockReason ?? t(language, 'agent.readiness.pending')
        : undefined}
      pendingDecision={composerPendingDecision}
      onDecisionSubmit={(guidance, action) => {
        if (!composerPendingDecision) return;
        requestFollowLatest();
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
        requestFollowLatest();
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
        requestFollowLatest();
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
        requestFollowLatest();
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
  );

  return (
    <div className={`deepcode-gui-agent-panel${showHome ? ' deepcode-gui-agent-panel--home' : ''}`}>
      {!showHome && (
        <header className="deepcode-gui-agent-panel__header">
          <div>
            <div className="deepcode-gui-agent-panel__title">{activeSessionTitle}</div>
            <div className="deepcode-gui-agent-panel__subtitle">{t(language, 'deepcodeGui.agent.subtitle')}</div>
          </div>
          <button
            type="button"
            className="deepcode-private-analysis__open"
            onClick={() => setAnalysisOpen(true)}
            aria-label={t(language, 'deepcodeGui.analysis.open')}
            title={t(language, 'deepcodeGui.analysis.open')}
          >
            {t(language, 'deepcodeGui.analysis.shortLabel')}
          </button>
        </header>
      )}

      {!showHome && (
        <DeepCodeTimeline
          timeline={timeline}
          loading={sessionRunning && !waitingForUser}
          language={language}
          followLatestSignal={followLatestSignal}
          scrollWatchElement={bottomChromeElement}
          suppressedBlockIds={suppressedBlockIds}
          onPlanResolve={(runId, planId, decision, guidance) => {
            requestFollowLatest();
            void resolvePlan(runId, planId, decision, guidance);
          }}
        />
      )}

      <div
        key="composer-region"
        ref={setBottomChromeElement}
        className={showHome ? 'deepcode-gui-home-panel' : undefined}
      >
        {showHome && <h1>{homePrompt}</h1>}

        {!showHome && pendingPermissionRequest && (
          <PermissionRequestBubble
            request={pendingPermissionRequest}
            language={language}
            disabled={Boolean(resolvingPermission)}
            resolvingDecision={
              resolvingPermission?.id === pendingPermissionRequest.id
                ? resolvingPermission.decision
                : null
            }
            onAccept={() => {
              requestFollowLatest();
              void acceptPermission(pendingPermissionRequest);
            }}
            onReject={() => {
              requestFollowLatest();
              void rejectPermission(pendingPermissionRequest);
            }}
          />
        )}

        {(errorMessage || composerError) && (
          <div className="deepcode-gui-agent-panel__error">
            <span>{errorMessage ?? composerError}</span>
            {onComposerRetry && (
              <button type="button" onClick={() => void onComposerRetry()}>
                {t(language, 'deepcodeGui.statusAction.retry')}
              </button>
            )}
          </div>
        )}

        {composer}
      </div>
      {analysisOpen && session?.id && (
        <PrivateAnalysisViewer
          key={session.id}
          sessionId={session.id}
          language={language}
          onClose={() => setAnalysisOpen(false)}
        />
      )}
    </div>
  );
};

export default DeepCodeAgentPanel;
