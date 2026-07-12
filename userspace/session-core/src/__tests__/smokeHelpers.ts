import type { AgentEvent } from '@deepcode/protocol';
import type { PromptEnvelope } from '../prompt/types.js';

export function randomSmokeToken(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function smokePromptEnvelope(stablePrefix: string, dynamicSuffix = ''): PromptEnvelope {
  return {
    stablePrefix,
    dynamicSuffix,
    auditOnlyContext: '',
    layers: [],
    segments: [],
    stableLayerNames: [],
    dynamicLayerNames: [],
    auditOnlyLayerNames: [],
  };
}

export function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function assertCancelledRunState(
  events: AgentEvent[],
  reason: string,
  runId: string,
  targetId?: string
): void {
  const event = events.find((candidate) =>
    candidate.kind === 'session_run_state' &&
    (candidate.payload as any)?.status === 'cancelled' &&
    (candidate.payload as any)?.phase === 'cancelled' &&
    (candidate.payload as any)?.reason === reason &&
    (candidate.payload as any)?.runId === runId &&
    (targetId ? (candidate.payload as any)?.targetId === targetId : true)
  );
  assert(Boolean(event), `expected cancelled session run state for ${reason}`);
}

export function assertThrows(fn: () => unknown, expectedMessage: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) return;
    throw error;
  }
  throw new Error(`expected function to throw: ${expectedMessage}`);
}
