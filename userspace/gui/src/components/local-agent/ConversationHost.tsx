import React, { createContext, useContext, useEffect, useState } from 'react';
import { readConversation, readConversationResource, readConversationImage, readConversationDocument, readFileChange, resolveConversationResource, readConversationArtifact } from '../../services/localAgentApi';
import { openExternalUrl } from '../../services/runtimeAdapter';
import type { SourcePosition } from './resourceLinks';

/** Web conversation content receives host operations here; it owns no native shell API. */
export interface ConversationHost {
  copyText(text: string): Promise<void>;
  openExternalLink(url: string): Promise<void>;
  readResource: typeof readConversationResource;
  readDocument: typeof readConversationDocument;
  readLocalFile?(path: string): Promise<Blob>;
  readArtifact: typeof readConversationArtifact;
  readChange: typeof readFileChange;
  readConversation: typeof readConversation;
  loadImage(sessionId: string | null, source: string, signal: AbortSignal): Promise<{ url: string; release?(): void }>;
  resolveResource: typeof resolveConversationResource;
  openFile?(path: string, position?: SourcePosition): Promise<void>;
  locatePath?(path: string): Promise<void>;
  openDiff?(sessionId: string, recordId: string, index: number): Promise<void>;
}

const defaultHost: ConversationHost = {
  copyText: async (text) => navigator.clipboard.writeText(text),
  openExternalLink: openExternalUrl,
  readResource: readConversationResource,
  readLocalFile: async (path) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error('Local file reading requires the desktop Host.');
    const bytes = await invoke<ArrayBuffer>('deepcode_read_local_file', { path });
    return new Blob([bytes]);
  },
  readDocument: readConversationDocument,
  readArtifact: readConversationArtifact,
  resolveResource: resolveConversationResource,
  openFile: async (path, position) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error('Open in VS Code requires the desktop Host.');
    await invoke('deepcode_open_file', { path, line: position?.line, column: position?.column });
  },
  locatePath: async (path) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (!invoke) throw new Error('Manual file location requires the desktop Host.');
    await invoke('deepcode_locate_path', { path });
  },
  readChange: readFileChange,
  readConversation,
  loadImage: async (sessionId, source, signal) => {
    if (sessionId && source.startsWith('artifact://')) {
      const blob = await readConversationArtifact(sessionId, source.slice('artifact://'.length), signal);
      const url = URL.createObjectURL(blob);
      return {url, release: () => URL.revokeObjectURL(url)};
    }
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
