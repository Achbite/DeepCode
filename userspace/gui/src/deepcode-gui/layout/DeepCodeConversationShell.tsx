import React from 'react';
import type {
  AgentTimelineResult,
} from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import type { AgentSessionSubmissionTarget } from '../../state/agentSessionStore';
import DeepCodeAgentPanel from '../panel/DeepCodeAgentPanel';

interface DeepCodeConversationShellProps {
  language: UiLanguage;
  timeline: AgentTimelineResult;
  agentReady: boolean;
  forceHome: boolean;
  projectTitle: string | null;
  submissionScopeId?: string | null;
  onBeforeSend: () => AgentSessionSubmissionTarget
    | false
    | Promise<AgentSessionSubmissionTarget | false>;
  onDraftSend?: (content: string, profileId?: string) => Promise<boolean>;
  onAfterSend: (
    submissionScopeId: string | null,
    submittedDraftCleared: boolean
  ) => void | Promise<void>;
}

const DeepCodeConversationShell: React.FC<DeepCodeConversationShellProps> = ({
  language,
  timeline,
  agentReady,
  forceHome,
  projectTitle,
  submissionScopeId,
  onBeforeSend,
  onDraftSend,
  onAfterSend,
}) => (
  <main className="deepcode-gui-session-main">
    <DeepCodeAgentPanel
      language={language}
      timeline={timeline}
      agentReady={agentReady}
      forceHome={forceHome}
      homeProjectTitle={projectTitle}
      submissionScopeId={submissionScopeId}
      suppressPendingDecision={forceHome}
      onBeforeSend={onBeforeSend}
      onDraftSend={onDraftSend}
      onAfterSend={onAfterSend}
    />
  </main>
);

export default DeepCodeConversationShell;
