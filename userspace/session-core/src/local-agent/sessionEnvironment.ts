import type { RunRuntimeSnapshot, SessionEvent } from '@deepcode/protocol';

const ENVIRONMENT_ID = 'deepcode.session-environment';

export function environmentInstruction(value: unknown): RunRuntimeSnapshot['instructions'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_environment_invalid');
  }
  const data = value as Record<string, unknown>;
  const fields = ['os', 'arch', 'locale', 'responseLanguage', 'userShell'];
  if (Object.keys(data).length !== fields.length
    || Object.keys(data).some((key) => !fields.includes(key))
    || ['os', 'arch'].some((key) => typeof data[key] !== 'string' || !data[key])
    || ['locale', 'responseLanguage', 'userShell'].some((key) => data[key] !== null && typeof data[key] !== 'string')) {
    throw new Error('session_environment_invalid');
  }
  return {
    id: ENVIRONMENT_ID,
    text: `Session environment:\n${JSON.stringify({
      os: data.os,
      arch: data.arch,
      locale: data.locale,
      userShell: data.userShell,
    })}\nDefault language for user-facing responses: ${data.responseLanguage ?? 'not specified'}.`,
  };
}

/** The first journaled environment is the Session's stable context, also after restart. */
export function retainSessionEnvironment(
  runtime: RunRuntimeSnapshot,
  events: readonly SessionEvent[],
): RunRuntimeSnapshot {
  for (const event of events) {
    if (event.type !== 'run.started') continue;
    const saved = event.payload.runtimeSnapshot.instructions.find((item) => item.id === ENVIRONMENT_ID);
    if (saved) {
      return {
        ...runtime,
        instructions: [
          ...runtime.instructions.filter((item) => item.id !== ENVIRONMENT_ID),
          { ...saved },
        ].sort((a, b) => a.id.localeCompare(b.id, 'en')),
      };
    }
  }
  return runtime;
}
