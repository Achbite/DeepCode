import type { NewSessionEvent, ProviderAttemptFact, ProviderRequest } from '@deepcode/protocol';
import { errorFact, ProviderCompletedFailure, ProviderReportedFailure } from './loopFailure.js';
import type { AgentLoopDeps } from './loop.js';

export const PROVIDER_MAX_ATTEMPTS = 5;

export function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One logical generation, fresh accumulators per send, one shared journal. */
export async function withProviderAttempts<T>(
  request: ProviderRequest,
  deps: AgentLoopDeps,
  signal: AbortSignal,
  consume: (attempt: ProviderRequest, onCompleted: () => void) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= PROVIDER_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) throw signal.reason;
    const providerAttemptId = deps.nextId('provider-attempt');
    const base = { providerRequestId: request.requestId, providerAttemptId, attempt, purpose: request.purpose };
    const record = (phase: ProviderAttemptFact['phase'], extra: Partial<ProviderAttemptFact> = {}) => deps.commit({
      type: 'provider.attempt.updated', sessionId: request.sessionId, runId: request.runId,
      payload: { ...base, phase, ...extra },
    } satisfies NewSessionEvent);
    await record('started');
    deps.updateAssistantDraft(null);
    deps.resetReasoning?.();
    let completed = false;
    const classifyFailure = (error: unknown) => completed && !(signal.aborted && error === signal.reason)
      ? new ProviderCompletedFailure(error) : error;
    let result: T;
    try {
      result = await consume({ ...request, providerAttemptId, attempt }, () => { completed = true; });
    } catch (error) {
      const failure = errorFact(error);
      try { await record('failed', { error: failure }); }
      catch (recordError) { throw classifyFailure(new AggregateError([error, recordError], failure.message)); }
      deps.updateAssistantDraft(null);
      deps.resetReasoning?.();
      if (completed || signal.aborted) throw classifyFailure(error);
      const diagnostic = failure.diagnostics;
      if (!(error instanceof ProviderReportedFailure) || diagnostic?.source !== 'providerTransport'
        || diagnostic.category !== 'network' || !diagnostic.retryable || attempt === PROVIDER_MAX_ATTEMPTS) throw error;
      const delay = 1000 * 2 ** (attempt - 1);
      await record('retryWaiting', { error: failure, retryAt: String(Date.now() + delay) });
      await waitForRetry(delay, signal);
      continue;
    }
    // Persistence failures after a successful generation must never resend it.
    try { await record('completed'); }
    catch (error) { throw classifyFailure(error); }
    return result;
  }
  throw new Error('provider_attempt_budget_invalid');
}
