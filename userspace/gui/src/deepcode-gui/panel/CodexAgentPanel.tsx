import React, { useEffect, useState } from 'react';
import type { AgentTimelineResult } from '@deepcode/protocol';
import { getLlmProfiles, getAgentTimeline } from '../../services/runtimeAdapter';
import { useAgentSessionStore } from '../../state/agentSessionStore';
import { useWorkspaceStore } from '../../state/workspaceStore';
import { t, type UiLanguage } from '../../i18n';
import AgentComposer from '../../components/agent-panel/AgentComposer';
import PermissionRequestBubble from '../../components/agent-panel/PermissionRequestBubble';
import CodexTimeline from './CodexTimeline';

interface CodexAgentPanelProps {
  language: UiLanguage;
  forceHome?: boolean;
  homeProjectTitle?: string | null;
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

const CodexAgentPanel: React.FC<CodexAgentPanelProps> = ({
  language,
  forceHome = false,
  homeProjectTitle,
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
  const loadOrCreate = useAgentSessionStore((s) => s.loadOrCreate);
  const refreshSessions = useAgentSessionStore((s) => s.refreshSessions);
  const setProfileId = useAgentSessionStore((s) => s.setProfileId);
  const addAttachment = useAgentSessionStore((s) => s.addAttachment);
  const removeAttachment = useAgentSessionStore((s) => s.removeAttachment);
  const sendMessage = useAgentSessionStore((s) => s.sendMessage);
  const cancelCurrentRun = useAgentSessionStore((s) => s.cancelCurrentRun);
  const acceptPermission = useAgentSessionStore((s) => s.acceptPermission);
  const rejectPermission = useAgentSessionStore((s) => s.rejectPermission);
  const resolvePlan = useAgentSessionStore((s) => s.resolvePlan);
  const workspaceRevision = useWorkspaceStore((s) => s.treeRevision);
  const [timeline, setTimeline] = useState<AgentTimelineResult | null>(null);
  const [timelineError, setTimelineError] = useState<string | null>(null);
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
  const showHome = forceHome || (
    !sessionRunning && !pendingPermission && !errorMessage && !timelineError
    && events.length === 0 && !hasTimelineTurns
  );
  const composerRunning = forceHome ? false : sessionRunning;
  const homePrompt = homeProjectTitle
    ? t(language, 'deepcodeGui.home.projectPrompt', { project: homeProjectTitle })
    : t(language, 'deepcodeGui.home.prompt');

  const composer = (
    <AgentComposer
      messageAttachments={messageAttachments}
      sessionAttachments={sessionAttachments}
      language={language}
      loading={composerRunning}
      onSend={async (content) => {
        const shouldContinue = await onBeforeSend?.();
        if (shouldContinue === false) return;
        await sendMessage(content);
        await onAfterSend?.();
      }}
      onStop={() => void cancelCurrentRun()}
      onAddAttachment={addAttachment}
      onRemoveAttachment={removeAttachment}
    />
  );

  if (showHome) {
    return (
      <div className="codex-agent-panel codex-agent-panel--home">
        <div className="codex-home-panel">
          <h1>{homePrompt}</h1>
          {composer}
        </div>
      </div>
    );
  }

  return (
    <div className="codex-agent-panel">
      <header className="codex-agent-panel__header">
        <div>
          <div className="codex-agent-panel__title">{activeSessionTitle}</div>
          <div className="codex-agent-panel__subtitle">{t(language, 'deepcodeGui.agent.subtitle')}</div>
        </div>
        <button type="button" aria-label={t(language, 'deepcodeGui.session.actions')}>...</button>
      </header>

      <CodexTimeline
        timeline={timeline}
        fallbackEvents={events}
        loading={sessionRunning}
        language={language}
        onPlanResolve={(runId, planId, decision, guidance) =>
          void resolvePlan(runId, planId, decision, guidance)
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

      {(errorMessage || timelineError) && (
        <div className="codex-agent-panel__error">{errorMessage ?? timelineError}</div>
      )}

      {composer}
    </div>
  );
};

export default CodexAgentPanel;
