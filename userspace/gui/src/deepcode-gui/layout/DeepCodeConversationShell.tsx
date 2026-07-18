import React from 'react';
import type { AgentTimelineResult } from '@deepcode/protocol';
import type { UiLanguage } from '../../i18n';
import DeepCodeAgentPanel from '../panel/DeepCodeAgentPanel';

interface DeepCodeConversationShellProps {
  language: UiLanguage;
  timeline: AgentTimelineResult;
  forceHome: boolean;
  projectTitle: string | null;
  onBeforeSend: () => boolean | Promise<boolean>;
  onAfterSend: () => void | Promise<void>;
}

const DeepCodeConversationShell: React.FC<DeepCodeConversationShellProps> = ({
  language,
  timeline,
  forceHome,
  projectTitle,
  onBeforeSend,
  onAfterSend,
}) => (
  <main className="deepcode-gui-session-main">
    <DeepCodeAgentPanel
      language={language}
      timeline={timeline}
      forceHome={forceHome}
      homeProjectTitle={projectTitle}
      suppressPendingDecision={forceHome}
      onBeforeSend={onBeforeSend}
      onAfterSend={onAfterSend}
    />
  </main>
);

export default DeepCodeConversationShell;
