import React from 'react';
import LocalAgentPanel from '../../components/local-agent/LocalAgentPanel';

const DeepCodeConversationShell: React.FC<{ headerTarget: HTMLElement | null }> = ({ headerTarget }) => (
  <main className="deepcode-gui-session-main">
    <LocalAgentPanel mode="workbench" headerTarget={headerTarget} />
  </main>
);

export default DeepCodeConversationShell;
