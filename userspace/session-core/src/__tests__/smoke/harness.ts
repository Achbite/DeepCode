import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
  LlmChatStreamEvent,
} from '@deepcode/protocol';
import { SessionDriverLoop } from '../../index.js';

export type SmokeCase = {
  id: string;
  run: () => Promise<void>;
};

export type ResolvedResource = {
  path: string;
  rootId?: string;
};

export type ResourceScenarioResult = {
  result: AgentSessionResult;
  providerRequests: LlmChatRequest[];
  resolvedResources: ResolvedResource[];
};

export const NOW = '2026-01-01T00:00:00.000Z';
export const RESOURCE_CONTENT_PREFIX = 'resolved smoke content for ';

export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function testSession(id: string): AgentSession {
  return {
    id,
    mode: 'plan',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

export function eventAppender(
  session: AgentSession,
  events: AgentEvent[]
): (sessionId: string, nextEvents: AgentEvent[]) => Promise<AgentSessionResult> {
  return async (_sessionId, nextEvents) => {
    events.push(...nextEvents);
    return {
      session: { ...session, eventCount: events.length },
      events: [...events],
    };
  };
}

export function smokeKernel(request: KernelCommandEnvelope): KernelReply {
  const command = request.command;
  if (command.kind === 'runCreate') {
    const runId = 'run-smoke';
    const sessionId = command.sessionId ?? 'session-smoke';
    const stateContract = {
      runId,
      stateId: 'needProposal',
      stateKind: 'driverRequest',
      allowedInputs: ['proposalSubmit', 'resourceResolve'],
      allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
      proposalSchemaRefs: ['deepcode.agent.protocol.v4'],
      capabilityProjection: ['fs.read', 'fs.create'],
      toolCatalogSnapshot: smokeToolCatalog(),
      draftAdmissionPolicy: { maxTotalUtf8Bytes: 384 * 1024 },
    };
    return {
      ok: true,
      events: [
        {
          kind: 'state.entered',
          runId,
          sessionId,
          stateContract,
        },
        {
          kind: 'driver.request_produced',
          runId,
          sessionId,
          driverRequest: {
            id: 'driver-smoke',
            runId,
            sessionId,
            kind: 'needProposal',
            reason: 'Need a semantic Session proposal.',
            stateContract,
          },
        },
      ],
    } as KernelReply;
  }

  if (command.kind === 'resourceResolve') {
    const manifest = recordValue(command.request.manifest) ?? {};
    const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
    const items = entries.flatMap((value, index) => {
      const entry = recordValue(value);
      if (!entry) return [];
      const path = resourcePath(entry);
      return [{
        requestItemId: `item-${index + 1}`,
        manifestEntryId: entry.id,
        rootId: entry.rootId,
        path,
        status: 'resolved',
        readPolicy: 'explicit-manifest-readonly',
        sourceKind: 'file',
        contentKind: 'fileText',
        content: `${RESOURCE_CONTENT_PREFIX}${path}`,
        evidenceRefs: [`evidence-${index + 1}`],
      }];
    });
    return {
      ok: true,
      events: [{
        kind: 'resource.packet_produced',
        runId: command.runId,
        sessionId: command.sessionId ?? 'session-smoke',
        packet: {
          id: `packet-${command.requestId ?? 'smoke'}`,
          requestId: command.requestId,
          workspaceScopeKey: 'workspace-smoke',
          manifestId: String(manifest.id ?? 'manifest-smoke'),
          evidenceRefs: items.flatMap((item) => item.evidenceRefs),
          summary: `Resolved ${items.length} registered smoke resource(s).`,
          items,
        },
      }],
    } as KernelReply;
  }

  if (command.kind === 'planAuthorizationSubmit') {
    const intent = command.intent as Record<string, any>;
    return {
      ok: true,
      events: [{
        kind: 'plan_authorization.reviewed',
        runId: command.runId,
        sessionId: command.sessionId,
        planId: intent.planId,
        review: {
          planId: intent.planId,
          status: 'confirmable',
          diagnostics: [],
          authorizationContract: {
            id: `authorization-${intent.planId}`,
            planId: intent.planId,
            planHash: intent.planHash,
            status: 'confirmable',
            workspaceBindingHash: intent.workspaceBindingHash,
            catalogVersion: intent.catalogVersion,
            catalogHash: intent.catalogHash,
            operationSetHash: `operations-${intent.planId}`,
            contractHash: `contract-${intent.planId}`,
            operations: [],
            permissionBundles: [],
            interventions: [],
            cleanupPolicy: 'planGrantLease',
            expiresAfter: 'reviewGateReplanCancelOrRunTerminal',
          },
        },
      }],
    } as KernelReply;
  }

  return { ok: true, events: [] };
}

export async function runResourceScenario(input: {
  id: string;
  paths: string[];
  instruction?: string;
}): Promise<ResourceScenarioResult> {
  const instruction = input.instruction
    ?? 'Read the selected project resources needed for this answer, then finish.';
  const session = testSession(`session-smoke-${input.id}`);
  const events: AgentEvent[] = [];
  const providerRequests: LlmChatRequest[] = [];
  const resolvedResources: ResolvedResource[] = [];
  const requestedPaths: string[] = [];
  let providerTurn = 0;
  const loop = new SessionDriverLoop({
    appendEvents: eventAppender(session, events),
    kernelCommand: async (request): Promise<KernelReply> => {
      resolvedResources.push(...resourcesFromResolveCommand(request));
      return smokeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('registered smoke uses the streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      providerTurn += 1;
      providerRequests.push(request);
      assertProviderReceivedInstruction(request, instruction);
      assertProviderReceivedResourceFacts(request, requestedPaths);
      const nextPath = input.paths[providerTurn - 1];
      if (nextPath) {
        assert(
          hasProviderTool(request, 'session.request_resources'),
          'the provider profile must expose session.request_resources'
        );
        requestedPaths.push(nextPath);
        return semanticToolResponse(
          'session.request_resources',
          {
            reason: `Read ${nextPath} for the current answer.`,
            requests: [{
              kind: 'fileText',
              path: nextPath,
              reason: `Use the selected project file ${nextPath}.`,
            }],
          },
          `resource-${input.id}-${providerTurn}`,
          onEvent
        );
      }
      assert(
        hasProviderTool(request, 'session.submit_answer'),
        'the resumed provider profile must expose session.submit_answer'
      );
      return semanticToolResponse(
        'session.submit_answer',
        { content: 'The requested runtime facts were incorporated.' },
        `answer-${input.id}-${providerTurn}`,
        onEvent
      );
    },
    now: () => NOW,
    createId: (prefix) => `${prefix}-${events.length + providerTurn + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: session.id,
    content: instruction,
    attachments: [{
      kind: 'directory',
      path: 'selected-project',
      absolutePath: '/tmp/deepcode-smoke-selected-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  return { result, providerRequests, resolvedResources };
}

export function resourcesFromResolveCommand(
  request: KernelCommandEnvelope
): ResolvedResource[] {
  if (request.command.kind !== 'resourceResolve') return [];
  const manifest = recordValue(request.command.request.manifest);
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  return entries.flatMap((value) => {
    const entry = recordValue(value);
    if (!entry) return [];
    return [{
      path: resourcePath(entry),
      rootId: typeof entry.rootId === 'string' ? entry.rootId : undefined,
    }];
  });
}

export function hasProviderTool(request: LlmChatRequest, name: string): boolean {
  return Boolean(request.tools?.some((tool) => tool.name === name));
}

export function assertProviderReceivedInstruction(
  request: LlmChatRequest,
  instruction: string
): void {
  assert(
    request.messages.some((message) =>
      message.role === 'user' && message.content.includes(instruction)
    ),
    'the current user instruction must reach every provider turn'
  );
}

export function assertProviderReceivedResourceFacts(
  request: LlmChatRequest,
  expectedPaths: string[]
): void {
  if (expectedPaths.length === 0) return;
  const toolFacts = request.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');
  for (const path of expectedPaths) {
    assert(toolFacts.includes(path), `the resumed provider turn must contain the path ${path}`);
    assert(
      toolFacts.includes(`${RESOURCE_CONTENT_PREFIX}${path}`),
      `the resumed provider turn must contain the content fact for ${path}`
    );
  }
}

export async function semanticToolResponse(
  name: string,
  argumentsValue: Record<string, unknown>,
  callId: string,
  onEvent: (event: LlmChatStreamEvent) => void | Promise<void>
): Promise<ApiResponse<LlmChatResult>> {
  const chunk: LlmChatResult['chunks'][number] = {
    type: 'tool_call',
    index: 0,
    callId,
    toolCallDelta: {
      id: callId,
      index: 0,
      name,
      argumentsDelta: JSON.stringify(argumentsValue),
    },
  };
  await onEvent({ type: 'provider_tool_call_delta', chunk });
  return {
    ok: true,
    data: {
      chunks: [chunk, { type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: callId, name, arguments: argumentsValue }],
      },
    },
  };
}

export function hasEvent(events: AgentEvent[], kind: AgentEvent['kind']): boolean {
  return events.some((event) => event.kind === kind);
}

export function hasFinalAssistantContent(events: AgentEvent[], content: string): boolean {
  return events.some((event) =>
    event.kind === 'assistant_msg'
    && (event.payload as any)?.channel === 'final'
    && (event.payload as any)?.content === content
  );
}

function smokeToolCatalog(): Record<string, unknown> {
  const base = {
    family: 'workspace',
    risk: 'low',
    pathScopePolicy: 'workspace',
    executionMode: 'execute',
    planTargetMode: 'perTarget',
    needsWorkspace: true,
  };
  return {
    catalogVersion: 'smoke-v1',
    catalogHash: 'smoke-tool-catalog',
    tools: [
      {
        ...base,
        toolId: 'fs.read',
        capability: 'fs.read',
        operationKind: 'fsRead',
        permissionMode: 'allow',
        readOnly: true,
        usageConstraints: {
          targetExistence: 'mustExist',
          targetKinds: ['file'],
          contentMode: 'none',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
      {
        ...base,
        toolId: 'fs.create',
        capability: 'fs.write',
        operationKind: 'fsCreate',
        permissionMode: 'ask',
        readOnly: false,
        usageConstraints: {
          targetExistence: 'mustNotExist',
          targetKinds: ['file'],
          contentMode: 'contentBlock',
          directoryRecursiveRequired: false,
        },
        providerSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            contentBlockId: { type: 'string' },
          },
          required: ['path', 'contentBlockId'],
        },
      },
    ],
  };
}

function resourcePath(entry: Record<string, any>): string {
  const value = entry.path ?? entry.resourceRef;
  return typeof value === 'string' ? value : '';
}

function recordValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}
