import type { ConversationCommand } from '@deepcode/protocol';
import {
  CONVERSATION_COMMAND_VERSION,
  LOCAL_AGENT_PROTOCOL_VERSION,
} from '@deepcode/protocol';
import {
  HttpCommandJournal,
  HttpKernelPort,
  HttpProviderPort,
} from './local-agent/httpPorts.js';
import {
  completeMemoryProvider,
  composeAgent,
  type AgentPlugin,
} from './local-agent/plugins.js';
import {
  decodeStartupPluginConfig,
  skillPlugin,
} from './local-agent/skillPlugins.js';
import { SessionService } from './local-agent/service.js';

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stdout: {
    write(value: string, callback?: (error?: Error | null) => void): boolean;
  };
  stderr: { write(value: string): boolean };
};

const MAX_REQUEST_BYTES = 1024 * 1024;

type BridgeRequest = {
  protocolVersion: typeof LOCAL_AGENT_PROTOCOL_VERSION;
  requestId: string;
  operation: 'health' | 'createSession' | 'deleteSession' | 'submit' | 'snapshot' | 'shutdown';
  data: Record<string, unknown>;
};

async function main(): Promise<void> {
  const apiBase = requiredEnvironment('DEEPCODE_LOCAL_AGENT_API_BASE');
  const serviceToken = requiredEnvironment('DEEPCODE_LOCAL_AGENT_TOKEN');
  const configuredProfileId = process.env.DEEPCODE_LOCAL_AGENT_PROFILE_ID?.trim();
  const startupPlugins = decodeStartupPluginConfig(
    process.env.DEEPCODE_LOCAL_AGENT_PLUGIN_CONFIG,
  );
  delete process.env.DEEPCODE_LOCAL_AGENT_PLUGIN_CONFIG;
  const journal = new HttpCommandJournal({ apiBase, serviceToken });
  const kernel = new HttpKernelPort({ apiBase, serviceToken });
  const provider = new HttpProviderPort({ apiBase, serviceToken });
  const serviceAbort = new AbortController();
  const workspaceAutonomyInstruction = startupPlugins.workspaceMutation === 'allow'
    ? '工作区内 fs.* 修改可直接执行，不要仅因权限发布 Plan；process.shell 可直接用于工作区调试。工作区外副作用等待用户决定。'
    : '工作区内 fs.* 修改前先调用 plan.publish 并等待确认；只读、process.shell 和普通回答不要求 Plan。';
  const engineeringDecisionInstruction = startupPlugins.engineeringDecisions === 'delegate'
    ? '有充分工作区事实时自行选择最小一致工程路线；缺少需求事实、涉及工作区外或不可逆外部动作时调用 interaction.request。'
    : '实质改变需求、公共合同、事实 owner 或工程路线时调用 interaction.request；不强制提供多个选项。';
  const plugins: readonly AgentPlugin[] = [
    {
      id: 'deepcode.core.instructions',
      setup: () => ({
        instructions: [{
          id: 'deepcode.coding-agent',
          text: '你是本地编码 Agent。依据用户指令和工具事实工作；需要未获授权的副作用时等待用户决定。除非用户明确要求或语义确有必要，避免使用表情符号。',
        }],
      }),
    },
    ...(startupPlugins.systemPrompt.trim()
      ? [{
          id: 'deepcode.user.instructions',
          setup: () => ({
            instructions: [{
              id: 'deepcode.user.system-prompt',
              text: startupPlugins.systemPrompt,
            }],
          }),
        } satisfies AgentPlugin]
      : []),
    {
      id: 'deepcode.core.workspace-autonomy',
      setup: () => ({
        instructions: [{
          id: 'deepcode.workspace-autonomy',
          text: `${workspaceAutonomyInstruction}\n${engineeringDecisionInstruction}`,
        }],
      }),
    },
    {
      id: 'deepcode.core.provider',
      setup: () => ({
        providerAdapters: [{ id: 'provider.configured', port: provider }],
      }),
    },
    {
      id: 'deepcode.core.memory',
      setup: () => ({ memoryProviders: [completeMemoryProvider] }),
    },
    {
      id: 'deepcode.kernel.tools',
      setup: async () => ({
        toolIds: (await kernel.listTools()).map((tool) => tool.name),
      }),
    },
    ...startupPlugins.skills.map(skillPlugin),
  ];
  const service = new SessionService(journal, {
    create: async ({ workspaceBindings }) => ({
      composition: await composeAgent({
        plugins,
        workspaceBindings,
        providerId: 'provider.configured',
        memoryId: completeMemoryProvider.id,
        kernel,
        signal: serviceAbort.signal,
      }),
      ...(configuredProfileId ? { profileId: configuredProfileId } : {}),
    }),
  });

  let shutdownRequested = false;
  try {
    for await (const line of readLines()) {
      const request = decodeRequest(line);
      try {
        const data = await dispatch(service, request);
        await writeFrame({
          protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: true,
          data,
        });
        if (request.operation === 'shutdown') {
          shutdownRequested = true;
          break;
        }
      } catch (error) {
        await writeFrame({
          protocolVersion: LOCAL_AGENT_PROTOCOL_VERSION,
          requestId: request.requestId,
          ok: false,
          error: bridgeError(error),
        });
      }
    }
  } finally {
    serviceAbort.abort('session_service_stopped');
    await service.dispose();
  }
  if (!shutdownRequested) throw new Error('session_service_input_closed');
}

async function dispatch(
  service: SessionService,
  request: BridgeRequest,
): Promise<unknown> {
  switch (request.operation) {
    case 'health':
      return { state: 'ready' };
    case 'createSession':
      return await service.createSession({
        sessionId: requiredString(request.data, 'sessionId'),
        displayTitle: requiredString(request.data, 'displayTitle'),
        workspaceBindings: decodeWorkspaceBindings(request.data.workspaceBindings),
        ...(optionalString(request.data, 'profileId')
          ? { profileId: optionalString(request.data, 'profileId') }
          : {}),
      });
    case 'deleteSession':
      await service.deleteSession(requiredString(request.data, 'sessionId'));
      return { deleted: true };
    case 'submit': {
      return await service.submit(decodeCommand(request.data.command));
    }
    case 'snapshot':
      return await service.snapshot(requiredString(request.data, 'sessionId'));
    case 'shutdown':
      return { stopped: true };
  }
}

function decodeCommand(value: unknown): ConversationCommand {
  if (
    !isRecord(value)
    || value.schemaVersion !== CONVERSATION_COMMAND_VERSION
    || !validId(value.commandId)
    || !validId(value.sessionId)
  ) throw new Error('conversation_command_invalid');
  switch (value.type) {
    case 'session.directory-index.attach':
      if (!isWorkspaceBinding(value.workspaceBinding)) {
        throw new Error('conversation_command_invalid');
      }
      return value as unknown as ConversationCommand;
    case 'session.directory-index.detach':
      if (!validId(value.workspaceId)) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.submit':
      if (
        typeof value.text !== 'string'
        || (value.directoryAttachments !== undefined
          && !isWorkspaceBindingArray(value.directoryAttachments))
        || (value.profileId !== undefined && !validId(value.profileId))
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.feedback.set':
      if (
        !validId(value.messageId)
        || value.feedback !== null && value.feedback !== 'up' && value.feedback !== 'down'
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'run.profile.select':
      if (!validId(value.runId) || !validId(value.profileId)) {
        throw new Error('conversation_command_invalid');
      }
      return value as unknown as ConversationCommand;
    case 'run.cancel':
      if (!validId(value.runId)) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'interaction.respond':
      if (
        !validId(value.runId)
        || !validId(value.interactionId)
        || typeof value.response !== 'string'
        || !value.response.trim()
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'approval.respond':
      if (
        !validId(value.runId)
        || !validId(value.callId)
        || !validId(value.approvalId)
        || value.decision !== 'allow' && value.decision !== 'deny'
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'plan.respond':
      if (
        !validId(value.runId)
        || !validId(value.planId)
        || !positiveInteger(value.revision)
        || !decodePlanResponse(value.response)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    default:
      throw new Error('conversation_command_invalid');
  }
}

function isWorkspaceBinding(value: unknown): value is {
  workspaceId: string;
  displayName: string;
} {
  return isRecord(value)
    && Object.keys(value).every((key) => ['workspaceId', 'displayName'].includes(key))
    && validId(value.workspaceId)
    && typeof value.displayName === 'string'
    && Boolean(value.displayName.trim())
    && value.displayName.length <= 160
    && !/[\u0000-\u001f\u007f]/u.test(value.displayName);
}

function isWorkspaceBindingArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 8) return false;
  const ids = new Set<string>();
  return value.every((binding) => (
    isWorkspaceBinding(binding)
    && ids.size !== ids.add(binding.workspaceId).size
  ));
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 128
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function decodeRequest(encoded: string): BridgeRequest {
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    throw new Error('session_service_request_json_invalid');
  }
  if (
    !isRecord(value)
    || value.protocolVersion !== LOCAL_AGENT_PROTOCOL_VERSION
    || typeof value.requestId !== 'string'
    || !value.requestId
    || !['health', 'createSession', 'deleteSession', 'submit', 'snapshot', 'shutdown'].includes(String(value.operation))
    || !isRecord(value.data)
  ) {
    throw new Error('session_service_request_invalid');
  }
  return value as BridgeRequest;
}

async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffered = '';
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value = chunkBytes(chunk);
    bytes += value.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('session_service_request_too_large');
    buffered += decoder.decode(value, { stream: true });
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline < 0) break;
      const line = buffered.slice(0, newline).replace(/\r$/u, '');
      buffered = buffered.slice(newline + 1);
      bytes = new TextEncoder().encode(buffered).byteLength;
      if (!line) throw new Error('session_service_request_empty');
      yield line;
    }
  }
  buffered += decoder.decode();
  if (buffered) throw new Error('session_service_request_unterminated');
}

function chunkBytes(value: unknown): Uint8Array {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return value;
  throw new Error('session_service_input_invalid');
}

let outputTail = Promise.resolve();

function writeFrame(value: unknown): Promise<void> {
  const encoded = `${JSON.stringify(value)}\n`;
  const next = outputTail.then(() => new Promise<void>((resolve, reject) => {
    process.stdout.write(encoded, (error) => error ? reject(error) : resolve());
  }));
  outputTail = next;
  return next;
}

function bridgeError(error: unknown): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  const [candidate] = message.split(':', 1);
  const code = candidate && /^[a-z][a-z0-9_.-]{0,127}$/u.test(candidate)
    ? candidate
    : 'session_service_failed';
  return { code, message };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`session_service_environment_missing:${name}`);
  delete process.env[name];
  return value;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate) {
    throw new Error(`session_service_field_invalid:${field}`);
  }
  return candidate;
}

function optionalString(value: Record<string, unknown>, field: string): string | undefined {
  const candidate = value[field];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error(`session_service_field_invalid:${field}`);
  }
  return candidate;
}

function decodeWorkspaceBindings(value: unknown): Array<{
  workspaceId: string;
  displayName: string;
}> {
  if (!Array.isArray(value)) throw new Error('session_service_field_invalid:workspaceBindings');
  const seen = new Set<string>();
  return value.map((candidate) => {
    if (
      !isRecord(candidate)
      || Object.keys(candidate).some((key) => !['workspaceId', 'displayName'].includes(key))
      || !validId(candidate.workspaceId)
      || typeof candidate.displayName !== 'string'
      || !candidate.displayName.trim()
      || seen.has(candidate.workspaceId)
    ) throw new Error('session_service_field_invalid:workspaceBindings');
    seen.add(candidate.workspaceId);
    return { workspaceId: candidate.workspaceId, displayName: candidate.displayName };
  });
}

function decodePlanResponse(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'confirm' || value.kind === 'cancel') {
    return Object.keys(value).length === 1;
  }
  if (value.kind === 'requestRevision') {
    return Object.keys(value).length === 2
      && typeof value.text === 'string'
      && Boolean(value.text.trim());
  }
  return false;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

void main().catch((error) => {
  process.exitCode = 1;
  process.stderr.write(`[session-service] ${bridgeError(error).code}\n`);
});
