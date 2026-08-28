import React from 'react';
import LocalAgentPanel from '../../components/local-agent/LocalAgentPanel';

const DeepCodeConversationShell: React.FC = () => (
  <main className="deepcode-gui-session-main">
    <LocalAgentPanel mode="workbench" />
  </main>
);

export default DeepCodeConversationShell;
