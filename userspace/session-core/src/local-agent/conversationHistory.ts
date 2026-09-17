import type { SessionEvent } from '@deepcode/protocol';

/** Journal facts remain intact. A revision excludes only the replaced conversation
 * range; session settings and directory membership retain their current values. */
export function activeConversationEvents(events: readonly SessionEvent[]): SessionEvent[] {
  const revisions = events.filter((event) => event.type === 'conversation.revised');
  for (const event of revisions) {
    const { fromSequence, throughSequence } = event.payload;
    if (!Number.isSafeInteger(fromSequence) || fromSequence < 2
      || !Number.isSafeInteger(throughSequence) || throughSequence < fromSequence
      || throughSequence !== event.sequence - 1) throw new Error('conversation_revision_range_invalid');
  }
  return events.filter((event) => event.type !== 'conversation.revised' && (
    event.type.startsWith('session.') && event.type !== 'session.control.rejected'
    || !revisions.some(({ payload }) => event.sequence >= payload.fromSequence && event.sequence <= payload.throughSequence)
  ));
}
