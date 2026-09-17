import type { RunRuntimeSnapshot, SessionEvent } from '@deepcode/protocol';

const ENVIRONMENT_ID = 'deepcode.session-environment';

export function environmentInstruction(value: unknown): RunRuntimeSnapshot['instructions'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_environment_invalid');
  }
  const data = value as Record<string, unknown>;
  {
    const shell = data.shell as Record<string, unknown> | null;
    const target = data.executionTarget as Record<string, unknown> | null;
    if (!target || !['native', 'wsl'].includes(String(target.kind))
      || (target.kind === 'wsl' && ['distribution', 'worker'].some((key) => typeof target[key] !== 'string' || !target[key]))
      || !shell || !['bash', 'powershell'].includes(String(shell.tool))
      || typeof shell.executable !== 'string' || typeof shell.dialect !== 'string' || typeof data.executionPath !== 'string'
      || typeof data.shellAvailable !== 'boolean' || typeof data.workspaceShellSupported !== 'boolean'
      || !Array.isArray(data.developerCommands) || !data.developerCommands.every((item) => typeof item === 'string')) {
      throw new Error('session_environment_invalid');
    }
  }
  const fields = ['os', 'arch', 'locale', 'responseLanguage', 'userShell', 'configuration', 'executionTarget', 'shellAvailable', 'shell', 'developerCommands', 'commandPaths', 'executionPath', 'workspaceShellSupported', 'workspaceSandbox', 'hostBinding'];
  if (data.executionPath !== undefined && typeof data.executionPath !== 'string') throw new Error('session_environment_invalid');
  if (data.commandPaths !== undefined && (!data.commandPaths || typeof data.commandPaths !== 'object'
    || Array.isArray(data.commandPaths) || Object.values(data.commandPaths).some((path) => typeof path !== 'string'))) {
    throw new Error('session_environment_invalid');
  }
  if (data.hostBinding !== undefined) {
    const binding = data.hostBinding as Record<string, unknown> | null;
    if (!binding || typeof binding.hostInstanceId !== 'string' || !binding.hostInstanceId
      || typeof binding.windowLabel !== 'string' || !binding.windowLabel) throw new Error('session_host_binding_invalid');
  }
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
      ...(data.executionPath !== undefined ? { executionPath: data.executionPath } : {}),
      ...(data.hostBinding ? { hostBinding: data.hostBinding } : {}),
      ...(data.executionTarget ? { executionTarget: data.executionTarget, shell: data.shell, shellAvailable: data.shellAvailable, ...(data.commandPaths ? { commandPaths: data.commandPaths } : { developerCommands: data.developerCommands }), workspaceShellSupported: data.workspaceShellSupported, ...(data.workspaceSandbox ? { workspaceSandbox: data.workspaceSandbox } : {}) } : {}),
    })}\nThese basic facts describe the selected execution environment and remain fixed for this run. Service status has not been probed. Workspace-scoped shell runs under the reported sandbox; host-scoped shell requires Kernel authorization and executes outside that sandbox. A sandbox denial or unreachable socket does not establish that a host service is stopped. Check service status in the intended scope before proposing to start it. Use each tool result's environment and exit status as execution evidence.\nUse ${data.responseLanguage ?? "the user's language"} for all user-facing text, including progress updates, unless the user explicitly requests another language.`,
  };
}

export function savedSessionEnvironment(events: readonly SessionEvent[]): RunRuntimeSnapshot['environment'] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'run.started' && event.payload.runtimeSnapshot.environment) {
      return event.payload.runtimeSnapshot.environment;
    }
  }
  return undefined;
}
