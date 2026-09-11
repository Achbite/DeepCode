import React, { createContext, useContext, useEffect, useState } from 'react';
import { readConversation, readConversationResource, readConversationImage, readFileChange } from '../../services/localAgentApi';
import { openExternalUrl } from '../../services/runtimeAdapter';

/** Web conversation content receives host operations here; it owns no native shell API. */
export interface ConversationHost {
  copyText(text: string): Promise<void>;
  openExternalLink(url: string): Promise<void>;
  readResource: typeof readConversationResource;
  readChange: typeof readFileChange;
  readConversation: typeof readConversation;
  loadImage(sessionId: string | null, source: string, signal: AbortSignal): Promise<{ url: string; release?(): void }>;
  openFile?(sessionId: string, workspaceId: string, logicalPath: string): Promise<void>;
  openDiff?(sessionId: string, recordId: string, index: number): Promise<void>;
}

const defaultHost: ConversationHost = {
  copyText: async (text) => navigator.clipboard.writeText(text),
  openExternalLink: openExternalUrl,
  readResource: readConversationResource,
  readChange: readFileChange,
  readConversation,
  loadImage: async (sessionId, source, signal) => {
    if (/^https?:\/\//i.test(source)) return { url: source };
    const resource = /^workspace:\/\/([^/]+)\/(.+)$/.exec(source);
    if (!sessionId || !resource) throw new Error('图片需要 HTTP(S) 地址或 workspace://<workspaceId>/<logicalPath> 资源引用。');
    const blob = await readConversationImage(sessionId, decodeURIComponent(resource[1]), decodeURIComponent(resource[2]), signal);
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  },
};
const HostContext = createContext<ConversationHost>(defaultHost);
export const ConversationHostProvider = HostContext.Provider;
export const useConversationHost = () => useContext(HostContext);

export function useConversationTheme(): 'vs' | 'vs-dark' {
  const read = () => document.documentElement.dataset.theme === 'dark' ? 'vs-dark' as const : 'vs' as const;
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}
