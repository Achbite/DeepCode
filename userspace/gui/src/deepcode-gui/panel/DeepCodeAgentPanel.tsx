import React, { useEffect, useState } from 'react';
import type { AgentTimelineResult } from '@deepcode/protocol';
import { getLlmProfiles, getAgentTimeline } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { t, type UiLanguage } from '../../i18n';
import AgentComposer from '../../components/agent-panel/AgentComposer';
import PermissionRequestBubble from '../../components/agent-panel/PermissionRequestBubble';
import { findPendingComposerDecision } from '../../components/agent-panel/pendingDecision';
import DeepCodeTimeline from './DeepCodeTimeline';

interface DeepCodeAgentPanelProps {
  language: UiLanguage;
  forceHome?: boolean;
  homeProjectTitle?: string | null;
  suppressPendingDecision?: boolean;
  onBeforeSend?: () => Promise<boolean | void> | boolean | void;
  onAfterSend?: () => Promise<void> | void;
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
  forceHome = false,
  homeProjectTitle,
  suppressPendingDecision = false,
  onBeforeSend,
  onAfterSend,
}) => {
  const events = useAgentSessionStore((s) => s.events);
  const session = useAgentSessionStore((s) => s.session);
  const profileId = useAgentSessionStore((s) => s.profileId);
  const runningSessionIds = useAgentSessionStore((s) => s.runningSessionIds);
  const errorMessage = useAgentSessionStore((s) => s.errorMessage);
  const messageAttachments = useAgentSessionStore((s) => s.messageAttachments);
  const sessionAttachments = useAgentSessionStore((s) => s.sessionAttachments);
  const pendingPermission = useAgentSessionStore((s) => s.pendingPermission);
  const resolvingPermission = useAgentSessionStore((s) => s.resolvingPermission);
  const resolvingRequirement = useAgentSessionStore((s) => s.resolvingRequirement);
  const resolvingPlan = useAgentSessionStore((s) => s.resolvingPlan);
  const resolvingReview = useAgentSessionStore((s) => s.resolvingReview);
  const activeDeltas = useAgentSessionStore((s) => s.activeDeltas);
  const loadOrCreate = useAgentSessionStore((s) => s.loadOrCreate);
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
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
  const [timeline, setTimeline] = useState<AgentTimelineResult | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [timelineTypewriterActive, setTimelineTypewriterActive] = useState(false);
  const [revealedPendingDecisionKey, setRevealedPendingDecisionKey] = useState<string | null>(null);
  const [followLatestSignal, setFollowLatestSignal] = useState(0);
  const [bottomChromeElement, setBottomChromeElement] = useState<HTMLDivElement | null>(null);
  const sessionRunning = Boolean(session?.id && runningSessionIds.includes(session.id));

  useEffect(() => {
    void loadOrCreate();
    void refreshSessions();
    const loadProfiles = () => getLlmProfiles().then((result) => {
      if (result.ok && result.data) {
        setProfileId(profileId ?? result.data.defaultProfileId);
      }
    });
    void loadProfiles();
    window.addEventListener('deepcode:llm-profiles-updated', loadProfiles);
    return () => window.removeEventListener('deepcode:llm-profiles-updated', loadProfiles);
  }, [loadOrCreate, profileId, refreshSessions, setProfileId]);

  useEffect(() => {
    void loadOrCreate();
    void refreshSessions();
  }, [loadOrCreate, refreshSessions, workspaceRevision]);

  useEffect(() => {
    let cancelled = false;
    const loadTimeline = async () => {
      if (!session?.id) {
        setTimeline(null);
        return;
      }
      const result = await getAgentTimeline(session.id);
      if (cancelled) return;
      if (result.ok && result.data) {
        setTimeline(result.data);
        setTimelineError(null);
      } else {
        setTimelineError(result.message ?? result.error ?? 'Timeline unavailable');
      }
    };
    void loadTimeline();
    const interval = sessionRunning ? window.setInterval(() => void loadTimeline(), 1000) : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [events.length, session?.id, sessionRunning]);

  const activeSessionTitle = displaySessionTitle(language, session?.title);
  const hasTimelineTurns = (timeline?.turns.length ?? 0) > 0;
  const pendingDecision = suppressPendingDecision
    ? null
    : findPendingComposerDecision({
      events,
      pendingPermission: pendingPermission?.request ?? null,
      resolvingRequirement,
      resolvingPlan,
      resolvingReview,
      resolvingPermission,
    });
  const pendingDecisionKey = pendingDecisionIdentity(pendingDecision);
  useEffect(() => {
    if (!pendingDecisionKey) {
      setRevealedPendingDecisionKey(null);
      return;
    }
    if (!timelineTypewriterActive) {
      setRevealedPendingDecisionKey(pendingDecisionKey);
    }
  }, [pendingDecisionKey, timelineTypewriterActive]);
  const decisionReadyForComposer = Boolean(
    pendingDecisionKey &&
    revealedPendingDecisionKey === pendingDecisionKey &&
    !timelineTypewriterActive
  );
  const composerPendingDecision = decisionReadyForComposer ? pendingDecision : null;
  const showHome = forceHome || (
    !sessionRunning && !composerPendingDecision && !errorMessage && !timelineError
    && events.length === 0 && !hasTimelineTurns
  );
  const composerRunning = forceHome ? false : sessionRunning;
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
      onSend={async (content) => {
        requestFollowLatest();
        const shouldContinue = await onBeforeSend?.();
        if (shouldContinue === false) return;
        await sendMessage(content);
        await onAfterSend?.();
      }}
      onStop={() => void cancelCurrentRun()}
      onAddAttachment={addAttachment}
      onRemoveAttachment={removeAttachment}
      pendingDecision={composerPendingDecision}
      onDecisionSubmit={(guidance, action) => {
        if (!composerPendingDecision) return;
        requestFollowLatest();
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
        requestFollowLatest();
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
  );

  if (showHome) {
    return (
      <div className="deepcode-gui-agent-panel deepcode-gui-agent-panel--home">
        <div className="deepcode-gui-home-panel">
          <h1>{homePrompt}</h1>
          {composer}
        </div>
      </div>
    );
  }

  return (
    <div className="deepcode-gui-agent-panel">
      <header className="deepcode-gui-agent-panel__header">
        <div>
          <div className="deepcode-gui-agent-panel__title">{activeSessionTitle}</div>
          <div className="deepcode-gui-agent-panel__subtitle">{t(language, 'deepcodeGui.agent.subtitle')}</div>
        </div>
        <button type="button" aria-label={t(language, 'deepcodeGui.session.actions')}>...</button>
      </header>

      <DeepCodeTimeline
        timeline={timeline}
        fallbackEvents={events}
        loading={sessionRunning}
        language={language}
        activeDeltas={activeDeltas}
        followLatestSignal={followLatestSignal}
        scrollWatchElement={bottomChromeElement}
        onTypewriterActiveChange={setTimelineTypewriterActive}
        onPlanResolve={(runId, planId, decision, guidance) => {
          requestFollowLatest();
          void resolvePlan(runId, planId, decision, guidance);
        }}
      />

      <div ref={setBottomChromeElement}>
        {!timelineTypewriterActive && pendingPermission && (
          <PermissionRequestBubble
            request={pendingPermission.request}
            language={language}
            disabled={Boolean(resolvingPermission)}
            resolvingDecision={
              resolvingPermission?.id === pendingPermission.request.id
                ? resolvingPermission.decision
                : null
            }
            onAccept={() => {
              requestFollowLatest();
              void acceptPermission();
            }}
            onReject={() => {
              requestFollowLatest();
              void rejectPermission();
            }}
          />
        )}

        {(errorMessage || timelineError) && (
          <div className="deepcode-gui-agent-panel__error">{errorMessage ?? timelineError}</div>
        )}

        {composer}
      </div>
    </div>
  );
};

function pendingDecisionIdentity(
  decision: ReturnType<typeof findPendingComposerDecision>
): string | null {
  if (!decision) return null;
  if (decision.kind === 'requirement') {
    return `${decision.kind}:${decision.runId}:${decision.requirementId}`;
  }
  if (decision.kind === 'plan') {
    return `${decision.kind}:${decision.runId}:${decision.planId}`;
  }
  if (decision.kind === 'review') {
    return `${decision.kind}:${decision.runId}`;
  }
  return `${decision.kind}:${decision.requestId}`;
}

export default DeepCodeAgentPanel;
