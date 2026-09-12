import type { ConversationRound } from './conversationItems';

export const CONVERSATION_WINDOW_ROWS = 60;
export interface ConversationRange { start: number; end: number }
export interface ConversationNavigationEntry { key: string; rowIndex: number; label: string }

export function conversationNavigation(rounds: ConversationRound[]): ConversationNavigationEntry[] {
  const entries: ConversationNavigationEntry[] = [];
  let rowIndex = 0;
  for (const round of rounds) for (const row of round.rows) {
    if (row.item?.type === 'message' && row.item.value.role === 'user') {
      entries.push({
        key: row.key,
        rowIndex,
        label: row.item.value.content.trim().slice(0, 180)
          || row.item.value.filesystemReferences.map((reference) => reference.displayName).join(', ').slice(0, 180),
      });
    }
    rowIndex += 1;
  }
  return entries;
}

export function conversationRange(total: number, start = total - CONVERSATION_WINDOW_ROWS): ConversationRange {
  const first = Math.max(0, Math.min(start, Math.max(0, total - CONVERSATION_WINDOW_ROWS)));
  return { start: first, end: Math.min(total, first + CONVERSATION_WINDOW_ROWS) };
}

/** Window existing display rows; never trim or rewrite the shared Session projection. */
export function windowConversationRounds(rounds: ConversationRound[], range: ConversationRange): ConversationRound[] {
  let offset = 0;
  return rounds.flatMap((round) => {
    const first = offset;
    offset += round.rows.length;
    if (offset <= range.start && round.rows.length) return [];
    if (first >= range.end && round.rows.length) return [];
    if (!round.rows.length && first !== range.end) return [];
    return [{ ...round, rows: round.rows.slice(Math.max(0, range.start - first), Math.max(0, range.end - first)) }];
  });
}
