import React from 'react';
import type {
  AgentTimelineResult,
  AgentWorkspaceBinding,
} from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import DeepCodeAgentPanel from '../panel/DeepCodeAgentPanel';

interface DeepCodeConversationShellProps {
  language: UiLanguage;
  timeline: AgentTimelineResult;
  forceHome: boolean;
  projectTitle: string | null;
  projectWorkspaceBinding?: AgentWorkspaceBinding;
  projectContext: boolean;
  submissionScopeId?: string | null;
  onBeforeSend: () => boolean | Promise<boolean>;
  onAfterSend: (
    submissionScopeId: string | null,
    submittedDraftCleared: boolean
  ) => void | Promise<void>;
}

const DeepCodeConversationShell: React.FC<DeepCodeConversationShellProps> = ({
  language,
  timeline,
  forceHome,
  projectTitle,
  projectWorkspaceBinding,
  projectContext,
  submissionScopeId,
  onBeforeSend,
  onAfterSend,
}) => (
  <main className="deepcode-gui-session-main">
    <DeepCodeAgentPanel
      language={language}
      timeline={timeline}
      forceHome={forceHome}
      homeProjectTitle={projectTitle}
      projectWorkspaceBinding={projectWorkspaceBinding}
      projectContext={projectContext}
      submissionScopeId={submissionScopeId}
      suppressPendingDecision={forceHome}
      onBeforeSend={onBeforeSend}
      onAfterSend={onAfterSend}
    />
  </main>
);

export default DeepCodeConversationShell;
