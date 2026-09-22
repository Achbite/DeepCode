import React from 'react';
import LocalAgentPanel, { type ConversationReaderLayout } from '../../components/local-agent/LocalAgentPanel';

const DeepCodeConversationShell: React.FC<{
  headerTarget: HTMLElement | null;
  onReaderLayoutChange?: (layout: ConversationReaderLayout) => void;
}> = ({ headerTarget, onReaderLayoutChange }) => (
  <main className="deepcode-gui-session-main">
    <LocalAgentPanel mode="workbench" headerTarget={headerTarget} onReaderLayoutChange={onReaderLayoutChange} />
  </main>
);

export default DeepCodeConversationShell;
