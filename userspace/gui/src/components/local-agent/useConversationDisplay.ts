import { useCallback, useRef, useState } from 'react';
import type { SessionProjection } from '@deepcode/protocol';

/** Presentation acknowledgement only; Session still owns every run and message fact. */
export function useConversationDisplay(projection: SessionProjection | null) {
  const [, revise] = useState(0);
  const state = useRef({ sessionId: projection?.sessionId, liveRuns: new Set<string>(), displayed: new Map<string, string>() });
  if (state.current.sessionId !== projection?.sessionId) state.current = { sessionId: projection?.sessionId, liveRuns: new Set(), displayed: new Map() };
  if (projection?.run && ['running', 'waiting', 'releasing'].includes(projection.run.status)) state.current.liveRuns.add(projection.run.runId);
  const sessionId = projection?.sessionId;
  const onDisplayed = useCallback((identity: string, text: string) => {
    if (state.current.sessionId !== sessionId || state.current.displayed.get(identity) === text) return;
    state.current.displayed.set(identity, text);
    revise((value) => value + 1);
  }, [sessionId]);
  const readiness = new Map<string, boolean>();
  for (const message of projection?.messages ?? []) {
    if (message.role !== 'assistant') continue;
    const stream = projection!.timeline.find((item) => item.kind === 'message' && item.messageId === message.messageId);
    const ready = !state.current.liveRuns.has(message.runId) || Boolean(stream?.kind === 'message' && stream.streamId && state.current.displayed.get(stream.streamId) === message.content);
    readiness.set(message.runId, ready && readiness.get(message.runId) !== false);
  }
  return { completedRuns: new Set([...readiness].filter(([, ready]) => ready).map(([runId]) => runId)), onDisplayed };
}
