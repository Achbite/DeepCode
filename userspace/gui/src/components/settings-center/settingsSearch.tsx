import React, { createContext, useCallback, useContext, useEffect } from 'react';

export interface SettingsSearchEntry { id: string; title: string; keywords?: string; category: string }
export const SettingsSearchContext = createContext<(owner: string, entries: SettingsSearchEntry[]) => void>(() => {});
export const SettingsSearchTargets = createContext<Map<string, HTMLElement> | null>(null);
export function useSettingsSearchTarget(key: string) {
  const targets = useContext(SettingsSearchTargets);
  return useCallback((element: HTMLElement | null) => { if (element) targets?.set(key, element); else targets?.delete(key); }, [key, targets]);
}

export function matchesSettingsQuery(query: string, ...text: string[]): boolean {
  const haystack = text.join(' ').normalize('NFKC').toLocaleLowerCase();
  return query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/u).every((word) => haystack.includes(word));
}

/** Index only labels and non-secret metadata from the currently mounted settings editor. */
export function useSettingsSearchEntries(owner: string, entries: SettingsSearchEntry[]) {
  const register = useContext(SettingsSearchContext);
  const serialized = JSON.stringify(entries);
  useEffect(() => { register(owner, JSON.parse(serialized)); return () => register(owner, []); }, [owner, serialized, register]);
}
