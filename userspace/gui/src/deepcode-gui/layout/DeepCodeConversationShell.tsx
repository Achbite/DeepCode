import React from 'react';
import type {
  AgentComposerProjectionV1,
  AgentTimelineResult,
} from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import type { AgentSessionSubmissionTarget } from '../../state/agentSessionStore';
import DeepCodeAgentPanel from '../panel/DeepCodeAgentPanel';

interface DeepCodeConversationShellProps {
  language: UiLanguage;
  timeline: AgentTimelineResult;
  composer: AgentComposerProjectionV1 | null;
  composerLoading?: boolean;
  composerError?: string | null;
  selectedProfileId?: string;
  profileSelectionBusy?: boolean;
  forceHome: boolean;
  projectTitle: string | null;
  submissionScopeId?: string | null;
  onBeforeSend: () => AgentSessionSubmissionTarget
    | false
    | Promise<AgentSessionSubmissionTarget | false>;
  onDraftSend?: (content: string, profileId?: string) => Promise<boolean>;
  onProfileChange: (profileId: string) => void | Promise<void>;
  onComposerRetry?: () => void | Promise<void>;
  onAfterSend: (
    submissionScopeId: string | null,
    submittedDraftCleared: boolean
  ) => void | Promise<void>;
}

const DeepCodeConversationShell: React.FC<DeepCodeConversationShellProps> = ({
  language,
  timeline,
  composer,
  composerLoading,
  composerError,
  selectedProfileId,
  profileSelectionBusy,
  forceHome,
  projectTitle,
  submissionScopeId,
  onBeforeSend,
  onDraftSend,
  onProfileChange,
  onComposerRetry,
  onAfterSend,
}) => (
  <main className="deepcode-gui-session-main">
    <DeepCodeAgentPanel
      language={language}
      timeline={timeline}
      composer={composer}
      composerLoading={composerLoading}
      composerError={composerError}
      selectedProfileId={selectedProfileId}
      profileSelectionBusy={profileSelectionBusy}
      forceHome={forceHome}
      homeProjectTitle={projectTitle}
      submissionScopeId={submissionScopeId}
      suppressPendingDecision={forceHome}
      onBeforeSend={onBeforeSend}
      onDraftSend={onDraftSend}
      onProfileChange={onProfileChange}
      onComposerRetry={onComposerRetry}
      onAfterSend={onAfterSend}
    />
  </main>
);

export default DeepCodeConversationShell;
