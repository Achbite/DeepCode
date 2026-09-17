/** An editor draft is presentation state; only the settings owner supplies saved values. */
export interface SettingDraft { saved: string; text: string }

export function reconcileSettingDraft(draft: SettingDraft, saved: string): SettingDraft {
  if (draft.saved === saved) return draft;
  return { saved, text: draft.text === draft.saved ? saved : draft.text };
}

export function parseSettingDraft(text: string, numeric: boolean): string | number | null {
  if (!numeric) return text;
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
