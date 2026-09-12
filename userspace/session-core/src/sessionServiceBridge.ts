import type { ConversationCommand } from '@deepcode/protocol';
import { responseFrames } from './responseFrames.js';
import {
  CONVERSATION_COMMAND_VERSION,
  LOCAL_AGENT_PROTOCOL_VERSION,
} from '@deepcode/protocol';
import {
  HttpCommandJournal,
  HttpKernelPort,
  HttpProviderPort,
  HttpRunPreparationPort,
} from './local-agent/httpPorts.js';
import {
  completeMemoryProvider,
  composeAgent,
  type AgentPlugin,
} from './local-agent/plugins.js';
import { SessionService } from './local-agent/service.js';
import { decodeConversationReadQuery } from './local-agent/conversationRead.js';

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
  operation: 'health' | 'createSession' | 'deleteSession' | 'submit' | 'snapshot' | 'statuses' | 'contextComposition' | 'read' | 'shutdown';
  data: Record<string, unknown>;
};

async function main(): Promise<void> {
  const apiBase = requiredEnvironment('DEEPCODE_LOCAL_AGENT_API_BASE');
  const serviceToken = requiredEnvironment('DEEPCODE_LOCAL_AGENT_TOKEN');
  const journal = new HttpCommandJournal({ apiBase, serviceToken });
  const kernel = new HttpKernelPort({ apiBase, serviceToken });
  const provider = new HttpProviderPort({ apiBase, serviceToken });
  const stableCoreInstructions = Object.freeze([{
    id: 'deepcode.coding-agent',
    text: `You are DeepCode, a coding agent. Follow the user's current request and applicable project instructions; stay within the authorized scope and available capabilities.

For substantial work, prefer a brief statement of the immediate next step before extended analysis. Inspect relevant evidence and act incrementally within the authorized scope. Share meaningful findings or changes of direction; related tool calls may continue without repeated narration. Re-read to resolve a concrete uncertainty or failure. Prefer targeted edits to repeated full-file reconstruction.

Preserve failures and input rejections. Rejected input was not executed: correct the reported fields without repeating successful peer calls. Only successful tool results support completed Todo. Express expected nonzero shell outcomes explicitly; a failed overall command remains failed. When blocked, report completed work and blockers in the final answer, leaving unfinished Todo open. Never claim unperformed work as complete.

Use the project's declared build and test entrypoints, including its required container workflow. Determine service availability with a permitted service check, not executable presence. If the required environment or authority is unavailable, request it or report the blocker; do not substitute another toolchain. Keep verbose logs in files and inspect the relevant result without repeating successful work.

Be concise and use standard Markdown with clear file paths. Preserve technical terms, code and quotations in their original form. Use $...$ for inline LaTeX and $$...$$ for display math; show literal formula source only when requested. Avoid emojis unless requested or needed for meaning.`,
  }]);
  const runPreparation = new HttpRunPreparationPort({
    apiBase,
    serviceToken,
    stableCoreInstructions,
  });
  const serviceAbort = new AbortController();
  const plugins: readonly AgentPlugin[] = [
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
  ];
  const service = new SessionService(journal, {
    create: async ({ workspaceBindings }) => ({
      composition: await composeAgent({
        plugins,
        workspaceBindings,
        providerId: 'provider.configured',
        memoryId: completeMemoryProvider.id,
        kernel,
        runPreparation,
        signal: serviceAbort.signal,
      }),
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
    case 'statuses': {
      const { sessionIds } = request.data;
      if (!Array.isArray(sessionIds) || !sessionIds.every(validId)) {
        throw new Error('conversation_status_query_invalid');
      }
      return await service.statuses(sessionIds);
    }
    case 'read':
      return await service.read(decodeConversationReadQuery(request.data));
    case 'contextComposition':
      return await service.contextComposition(
        requiredString(request.data, 'sessionId'), requiredString(request.data, 'providerRequestId'),
      );
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
    case 'session.model-settings.set':
      if (!hasExactKeys(value, ['schemaVersion', 'type', 'commandId', 'sessionId', 'settings'])
        || !isRecord(value.settings)
        || !hasExactKeys(value.settings, ['profileId', 'reasoningEffortOverride'])
        || !validId(value.settings.profileId)
        || !validReasoningOverride(value.settings.reasoningEffortOverride)) {
        throw new Error('conversation_command_invalid');
      }
      return value as unknown as ConversationCommand;
    case 'session.directory-index.attach':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'workspaceBinding',
        ])
        || !isWorkspaceBinding(value.workspaceBinding)
      ) {
        throw new Error('conversation_command_invalid');
      }
      return value as unknown as ConversationCommand;
    case 'session.directory-index.detach':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'workspaceId',
        ])
        || !validId(value.workspaceId)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.submit':
      if (
        !hasExactKeys(
          value,
          ['schemaVersion', 'type', 'commandId', 'sessionId', 'text'],
          [
            'filesystemReferences', 'profileId', 'reasoningEffortOverride', 'pluginCatalogRevision', 'pluginSelections',
          ],
        )
        || typeof value.text !== 'string'
        || (value.filesystemReferences !== undefined
          && !isFilesystemReferenceArray(value.filesystemReferences))
        || (value.profileId !== undefined && !validId(value.profileId))
        || (value.reasoningEffortOverride !== undefined && !validReasoningOverride(value.reasoningEffortOverride))
        || !validPluginSelections(value.pluginCatalogRevision, value.pluginSelections)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'context.focus':
      if (
        !hasExactKeys(
          value,
          ['schemaVersion', 'type', 'commandId', 'sessionId', 'task'],
          [
            'filesystemReferences', 'profileId', 'reasoningEffortOverride', 'pluginCatalogRevision', 'pluginSelections',
          ],
        )
        || typeof value.task !== 'string'
        || !value.task.trim()
        || (value.filesystemReferences !== undefined
          && !isFilesystemReferenceArray(value.filesystemReferences))
        || (value.profileId !== undefined && !validId(value.profileId))
        || (value.reasoningEffortOverride !== undefined && !validReasoningOverride(value.reasoningEffortOverride))
        || !validPluginSelections(value.pluginCatalogRevision, value.pluginSelections)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'message.feedback.set':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'messageId', 'feedback',
        ])
        || !validId(value.messageId)
        || value.feedback !== null && value.feedback !== 'up' && value.feedback !== 'down'
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'run.cancel':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId',
        ])
        || !validId(value.runId)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'interaction.respond':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'interactionId', 'response',
        ])
        || !validId(value.runId)
        || !validId(value.interactionId)
        || typeof value.response !== 'string'
        || !value.response.trim()
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'approval.respond':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'callId', 'approvalId',
          'decision',
        ])
        || !validId(value.runId)
        || !validId(value.callId)
        || !validId(value.approvalId)
        || value.decision !== 'allow' && value.decision !== 'deny'
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    case 'plan.respond':
      if (
        !hasExactKeys(value, [
          'schemaVersion', 'type', 'commandId', 'sessionId', 'runId', 'planId', 'revision',
          'response',
        ])
        || !validId(value.runId)
        || !validId(value.planId)
        || !positiveInteger(value.revision)
        || !decodePlanResponse(value.response)
      ) throw new Error('conversation_command_invalid');
      return value as unknown as ConversationCommand;
    default:
      throw new Error('conversation_command_invalid');
  }
}

function validReasoningOverride(value: unknown): boolean {
  return value === null || typeof value === 'string' && ['low', 'medium', 'high', 'max'].includes(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
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

function isFilesystemReferenceArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 8) return false;
  const referenceIds = new Set<string>();
  const targets = new Set<string>();
  return value.every((reference) => {
    if (!isRecord(reference)) return false;
    const commonKeys = ['referenceId', 'workspaceId', 'logicalPath', 'displayName', 'kind'];
    const allowedKeys = reference.kind === 'file'
      ? [...commonKeys, 'mediaType', 'byteLength']
      : commonKeys;
    if (
      !hasExactKeys(reference, allowedKeys, reference.kind === 'file' ? ['source'] : [])
      || (reference.source !== undefined && reference.source !== 'pastedText')
      || !validId(reference.referenceId)
      || referenceIds.has(reference.referenceId)
      || !isWorkspaceBinding({
        workspaceId: reference.workspaceId,
        displayName: reference.displayName,
      })
      || typeof reference.logicalPath !== 'string'
      || !validLogicalPath(reference.logicalPath)
    ) return false;
    const target = `${reference.workspaceId}\0${reference.logicalPath}`;
    if (targets.has(target)) return false;
    if (reference.kind === 'file') {
      if (
        reference.logicalPath === '.'
        || typeof reference.mediaType !== 'string'
        || !reference.mediaType.trim()
        || reference.mediaType.length > 128
        || typeof reference.byteLength !== 'number'
        || !Number.isSafeInteger(reference.byteLength)
        || reference.byteLength < 0
      ) return false;
    } else if (reference.kind !== 'directory' || reference.logicalPath !== '.') {
      return false;
    }
    referenceIds.add(reference.referenceId);
    targets.add(target);
    return true;
  });
}

function validLogicalPath(value: string): boolean {
  if (!value || value.length > 4_096 || value.includes('\0') || value.includes('\\')) return false;
  if (value === '.') return true;
  if (value.startsWith('/') || value.endsWith('/')) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function validPluginSelections(revision: unknown, value: unknown): boolean {
  if (value === undefined) return revision === undefined || validId(revision);
  if (!Array.isArray(value) || value.length > 16) return false;
  if (value.length === 0) return revision === undefined || validId(revision);
  if (!validId(revision)) return false;
  const selectionIds = new Set<string>();
  const uris = new Set<string>();
  return value.every((selection) => {
    if (
      !isRecord(selection)
      || Object.keys(selection).some((key) => !['selectionId', 'uri', 'label'].includes(key))
      || !validId(selection.selectionId)
      || typeof selection.uri !== 'string'
      || !/^plugin:\/\/[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(selection.uri)
      || typeof selection.label !== 'string'
      || !selection.label.trim()
      || selection.label.length > 160
      || selectionIds.has(selection.selectionId)
      || uris.has(selection.uri)
    ) return false;
    selectionIds.add(selection.selectionId);
    uris.add(selection.uri);
    return true;
  });
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
    || !['health', 'createSession', 'deleteSession', 'submit', 'snapshot', 'statuses', 'contextComposition', 'read', 'shutdown'].includes(String(value.operation))
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
  // Serialize the entire logical response in the output queue, including all chunks.
  const next = outputTail.then(async () => {
    for (const frame of responseFrames(value)) await writeLine(frame);
  });
  outputTail = next;
  return next;
}

function writeLine(encoded: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${encoded}\n`, (error) => error ? reject(error) : resolve());
  });
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
