import React, { createContext, useContext } from 'react';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { useConversationDisplay } from './useConversationDisplay';

const DisplayContext = createContext<ReturnType<typeof useConversationDisplay> | null>(null);

/** Transcript and output rail share the same acknowledgement of displayed text. */
export function ConversationDisplayProvider({ children }: { children: React.ReactNode }) {
  const projection = useLocalAgentStore((state) => state.projection);
  const display = useConversationDisplay(projection);
  return <DisplayContext.Provider value={display}>{children}</DisplayContext.Provider>;
}

export function useDisplayedConversation() {
  const display = useContext(DisplayContext);
  if (!display) throw new Error('conversation_display_provider_missing');
  return display;
}
