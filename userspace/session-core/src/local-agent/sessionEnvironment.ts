import type { RunRuntimeSnapshot, SessionEvent } from '@deepcode/protocol';

const ENVIRONMENT_ID = 'deepcode.session-environment';

export function environmentInstruction(value: unknown): RunRuntimeSnapshot['instructions'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_environment_invalid');
  }
  const data = value as Record<string, unknown>;
  if (data.executionTarget !== undefined) {
    const shell = data.shell as Record<string, unknown> | null;
    const target = data.executionTarget as Record<string, unknown> | null;
    if (!target || !['native', 'wsl'].includes(String(target.kind))
      || (target.kind === 'wsl' && ['distribution', 'worker'].some((key) => typeof target[key] !== 'string' || !target[key]))
      || !shell || !['bash', 'powershell'].includes(String(shell.tool))
      || typeof shell.executable !== 'string' || typeof shell.dialect !== 'string'
      || typeof data.shellAvailable !== 'boolean' || typeof data.workspaceShellSupported !== 'boolean'
      || !Array.isArray(data.developerCommands) || !data.developerCommands.every((item) => typeof item === 'string')) {
      throw new Error('session_environment_invalid');
    }
  }
  const fields = ['os', 'arch', 'locale', 'responseLanguage', 'userShell', 'configuration', 'executionTarget', 'shellAvailable', 'shell', 'developerCommands', 'workspaceShellSupported', 'workspaceSandbox'];
  if (Object.keys(data).some((key) => !fields.includes(key))
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
      ...(data.executionTarget ? { executionTarget: data.executionTarget, shell: data.shell, shellAvailable: data.shellAvailable, developerCommands: data.developerCommands, workspaceShellSupported: data.workspaceShellSupported, ...(data.workspaceSandbox ? { workspaceSandbox: data.workspaceSandbox } : {}) } : {}),
    })}\nDefault language for user-facing responses: ${data.responseLanguage ?? 'not specified'}. Installed commands do not imply service readiness or permission.`,
  };
}

/** The first journaled environment is the Session's stable context, also after restart. */
export function retainSessionEnvironment(
  runtime: RunRuntimeSnapshot,
  events: readonly SessionEvent[],
): RunRuntimeSnapshot {
  if (runtime.environment) return runtime;
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

export function savedSessionEnvironment(events: readonly SessionEvent[]): RunRuntimeSnapshot['environment'] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'run.started' && event.payload.runtimeSnapshot.environment) {
      return event.payload.runtimeSnapshot.environment;
    }
  }
  return undefined;
}
