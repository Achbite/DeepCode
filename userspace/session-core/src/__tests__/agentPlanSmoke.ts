import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelCommandEnvelope,
  KernelReply,
  LlmChatRequest,
  LlmChatResult,
} from '@deepcode/protocol';
import {
  buildPromptEnvelope,
  compileActionBundleToPlanContract,
  createPlanContractSubmitCommand,
  createResourcePacket,
  parseProposalEnvelope,
  SessionDriver,
  SessionDriverLoop,
  type ActionBundleDraft,
  type ResourceManifest,
  type TranscriptEntry,
} from '../index.js';

async function main(): Promise<void> {
  assertV3Parser();
  assertActionBundleCompiler();
  assertPromptEnvelope();
  assertSessionDriverSkeleton();
  await assertSessionDriverLoop();
  await assertSessionDriverLoopPathResourceRequest();
  await assertSessionDriverLoopRejectsOutsidePath();
  await assertSessionDriverLoopUsesRecentAttachmentRoot();
  await assertSessionDriverLoopRequestsRequirementConfirmationForSideEffectTask();
  await assertSessionDriverLoopRepairsSideEffectBundleEvidence();
  await assertSessionDriverLoopRepairsOversizedActionBundle();
  await assertSessionDriverLoopRepairsEmptyActionBundleResponse();
}

async function assertSessionDriverLoopRequestsRequirementConfirmationForSideEffectTask(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-requirement-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'requirementDraft',
        outputLanguage: 'en-US',
        requirementDraft: {
          version: '1',
          requirementId: 'req-generic-auto',
          summary: 'Confirm a generic side-effect task before planning.',
          goal: 'Prepare a scoped implementation requirement.',
          scope: ['Create one reviewable implementation batch after confirmation.'],
          outOfScope: ['Do not execute unsupported capabilities.'],
          constraints: ['Keep the batch small and reviewable.'],
          risks: ['Scope can expand if the target root is ambiguous.'],
          acceptanceCriteria: ['User confirms the requirement before plan generation.'],
          openQuestions: [],
        },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-requirement-auto',
    content: 'Create a generic workspace change.',
  });
  assertEqual(llmCalls, 1, 'auto requirement confirmation calls provider once for requirement draft');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'auto mode emits requirement confirmation');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'auto mode does not generate a plan before requirement confirmation');
}

function assertV3Parser(): void {
  const answer = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'answer',
      outputLanguage: 'en-US',
      answer: { format: 'markdown', content: 'Generic answer.' },
    }),
  });
  assertEqual(answer.kind, 'answer', 'v3 answer parses');
  assertEqual(answer.runId, 'run-generic', 'v3 parser binds run id');

  const resourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-path',
        reason: 'Need a generic file under the attached directory.',
        items: [{ id: 'path-item', rootId: 'root-generic', path: 'src/generic.txt', reason: 'Read generic source.' }],
      },
    }),
  });
  assertEqual(resourceRequest.kind, 'resourceRequest', 'v3 resourceRequest path item parses');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'unsupported.protocol.schema',
      kind: 'answer',
      answer: { format: 'markdown', content: 'legacy' },
    }),
  }), 'deepcode.agent.protocol.v3');

  assertThrows(() => parseProposalEnvelope({
    runId: 'run-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      resourceRequest: {
        version: '1',
        id: 'invalid-resource-request',
        items: [{ id: 'missing-target', reason: 'Missing manifestEntryId and path.' }],
      },
    }),
  }), 'manifestEntryId or path');
}

function assertActionBundleCompiler(): void {
  const bundle = genericActionBundle();
  const contract = compileActionBundleToPlanContract(bundle);
  assertEqual(contract.requiredCapabilities.join(','), 'workspace.read,workspace.write', 'capabilities are sorted');
  assertEqual(contract.requiresUserApproval, true, 'write proposal requires user approval');

  const command = createPlanContractSubmitCommand({
    requestId: 'req-plan',
    runId: 'run-generic',
    sessionId: 'session-generic',
    bundle,
  });
  assertEqual(command.kind, 'planContractSubmit', 'actionBundle bridges through Kernel PlanReview command');
}

function assertPromptEnvelope(): void {
  const manifest: ResourceManifest = {
    id: 'manifest-generic',
    workspaceScopeKey: 'workspace-generic',
    entries: [
      {
        id: 'attachment-0-generic-file',
        kind: 'file',
        label: 'File generic/file.txt',
        resourceRef: 'generic/file.txt',
        readPolicy: 'autoRead',
        reason: 'Explicit user attachment for the current user turn.',
      },
    ],
    budget: { maxEntries: 8, maxBytes: 8192 },
    defaultDenyPatterns: [],
  };
  const packet = createResourcePacket({
    packetId: 'packet-generic',
    manifest,
    request: {
      id: 'request-generic',
      items: [{ id: 'item-generic', manifestEntryId: 'attachment-0-generic-file', reason: 'Read attached resource.' }],
    },
    kernelEvidence: {
      'attachment-0-generic-file': {
        contentKind: 'fileText',
        promptContent: 'generic content',
        evidenceRefs: ['evidence-generic'],
      },
    },
  });

  const prompt = buildPromptEnvelope({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
    capabilityCatalogSummary: 'workspace.read\nworkspace.write',
    memoryHints: ['Recent user turn: generic request attachments=file:generic/file.txt'],
    userRequest: 'Analyze the attached resource.',
    initialContext: {
      id: 'initial-generic',
      workspaceScopeKey: manifest.workspaceScopeKey,
      manifest,
    },
    conversationRoots: [{
      rootId: 'attachment-0-generic-file',
      kind: 'directory',
      label: 'Directory generic',
      displayPath: 'generic',
      absolutePath: '/tmp/generic',
      source: 'currentAttachment',
    }],
    resourcePackets: [packet],
  });
  assert(prompt.stablePrefix.includes('deepcode.agent.protocol.v3'), 'prompt enforces v3');
  assert(prompt.dynamicSuffix.includes('manifestEntry id=attachment-0-generic-file'), 'prompt exposes manifest entry ids');
  assert(prompt.dynamicSuffix.includes('Conversation roots'), 'prompt exposes conversation roots');
  assert(prompt.stablePrefix.includes('"path":"relative/path.ext"'), 'prompt documents path-based resourceRequest');
  assert(prompt.stablePrefix.includes('Implementation batch budget'), 'prompt documents incremental implementation budget');
  assert(prompt.dynamicSuffix.includes('generic content'), 'prompt includes ResourcePacket content');
  assert(!prompt.dynamicSuffix.includes('auditOnlyContext'), 'audit-only context is not in dynamic suffix');
}

function assertSessionDriverSkeleton(): void {
  const driver = new SessionDriver();
  const frame = driver.handleUserTurn({
    sessionId: 'session-generic',
    content: 'Create a generic change.',
    explicitDevelopmentTask: true,
    stateContract: {
      runId: 'run-generic',
      stateId: 'needProposal',
      stateKind: 'driverRequest',
      allowedInputs: ['proposalSubmit'],
      allowedProposals: ['actionBundle'],
      proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
      capabilityProjection: ['workspace.write'],
    },
  });
  assertEqual(frame.entryIntent, 'developmentTask', 'SessionDriver routes development work');
  assertEqual(frame.status, 'awaitingKernel', 'SessionDriver skeleton does not execute tools');
}

async function assertSessionDriverLoop(): Promise<void> {
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: 'session-generic',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => fakeLlm(request),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-generic',
    content: 'Analyze the attached resource.',
    attachments: [
      {
        kind: 'file',
        path: 'generic/file.txt',
        absolutePath: '/tmp/generic/file.txt',
        source: 'userSelected',
        scope: 'message',
      },
    ],
  });
  assertEqual(result.events.some((event) => event.kind === 'user_msg'), true, 'DriverLoop appends user turn');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'DriverLoop appends final answer');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'DriverLoop records ResourcePacket context');
}

async function assertSessionDriverLoopPathResourceRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-path',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-path',
            packet: {
              id: `packet-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: entry.kind === 'directory' ? 'directoryTree' : 'fileText',
                absolutePath: entry.resourceRef,
                nodes: entry.kind === 'directory' ? [{ type: 'file', path: 'README.txt' }] : undefined,
                content: entry.kind === 'directory' ? undefined : 'generic resolved file content',
                evidenceRefs: ['evidence-path'],
              }],
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: 'deepcode.agent.protocol.v3',
                kind: 'resourceRequest',
                outputLanguage: 'en-US',
                resourceRequest: {
                  version: '1',
                  id: 'need-generic-file',
                  reason: 'Need a generic file from the attached directory.',
                  items: [{ id: 'generic-source', path: 'src/main.txt', reason: 'Read generic project source.' }],
                },
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Generic directory context was resolved by path.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-path',
    content: 'Analyze the attached directory.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'path resourceRequest reaches final answer');
  assert(resourceResolveManifests.length >= 2, 'path resourceRequest triggers a second Kernel ResourceResolve');
  const secondEntry = resourceResolveManifests[1].entries[0];
  assertEqual(secondEntry.kind, 'resource', 'path resourceRequest is synthesized as a Kernel-resolved resource');
  assertEqual(secondEntry.resourceRef, '/tmp/generic-project/src/main.txt', 'path resourceRequest stays under the attached directory');
}

async function assertSessionDriverLoopRejectsOutsidePath(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-outside',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-outside',
            packet: {
              id: `packet-outside-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: 'directoryTree',
                absolutePath: entry.resourceRef,
                nodes: [],
                evidenceRefs: ['evidence-outside'],
              }],
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: 'deepcode.agent.protocol.v3',
                kind: 'resourceRequest',
                outputLanguage: 'en-US',
                resourceRequest: {
                  version: '1',
                  id: 'outside-request',
                  reason: 'Attempt to read an outside path.',
                  items: [{ id: 'outside-item', path: '/tmp/outside.txt', reason: 'Outside path should not be granted.' }],
                },
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Outside path was not granted.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-outside',
    content: 'Analyze the attached directory.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'outside path repair reaches final answer');
  assertEqual(resourceResolveManifests.length, 1, 'outside absolute path does not become a Kernel ResourceResolve manifest entry');
}

async function assertSessionDriverLoopUsesRecentAttachmentRoot(): Promise<void> {
  const events: AgentEvent[] = [];
  const existingEvents: AgentEvent[] = [{
    id: 'previous-user',
    sessionId: 'session-recent',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: {
      content: 'Analyze the attached directory.',
      attachments: [{
        kind: 'directory',
        path: 'previous-generic-project',
        absolutePath: '/tmp/previous-generic-project',
        source: 'userSelected',
        scope: 'message',
      }],
    },
  }];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-recent',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
        const entry = command.request.manifest.entries[0];
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            runId: 'run-generic',
            sessionId: 'session-recent',
            packet: {
              id: `packet-recent-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'item-generic',
                manifestEntryId: entry.id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                contentKind: 'fileText',
                absolutePath: entry.resourceRef,
                content: 'recent generic content',
                evidenceRefs: ['evidence-recent'],
              }],
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              content: JSON.stringify({
                schemaVersion: 'deepcode.agent.protocol.v3',
                kind: 'resourceRequest',
                outputLanguage: 'en-US',
                resourceRequest: {
                  version: '1',
                  id: 'recent-path-request',
                  reason: 'Need a file from the recent attached directory.',
                  items: [{ id: 'recent-file', path: 'README.txt', reason: 'Read generic overview.' }],
                },
              }),
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          chunks: [{ type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            content: JSON.stringify({
              schemaVersion: 'deepcode.agent.protocol.v3',
              kind: 'answer',
              outputLanguage: 'en-US',
              answer: { format: 'markdown', content: 'Recent attachment root was reused.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-recent',
    content: 'Read the overview from that project.',
    attachments: [],
    existingEvents,
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'recent root path request reaches final answer');
  assertEqual(resourceResolveManifests.length, 1, 'recent attachment root is not auto-read before the model requests a path');
  assertEqual(resourceResolveManifests[0].entries[0].resourceRef, '/tmp/previous-generic-project/README.txt', 'recent root resolves path under the previous attachment');
}

async function assertSessionDriverLoopRepairsSideEffectBundleEvidence(): Promise<void> {
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-plan-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    appendTranscript: async (_sessionId, entry) => {
      transcript.push(entry);
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') return fakeKernel(request);
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [{
            kind: 'proposal.accepted',
            runId: 'run-generic',
            sessionId: 'session-plan-repair',
            proposal: command.proposal,
          }],
        };
      }
      if (command.kind === 'planContractSubmit') {
        submittedPlans.push(command.contract);
        return {
          ok: true,
          events: [{
            kind: 'plan.review_report_produced',
            runId: 'run-generic',
            sessionId: 'session-plan-repair',
            report: {
              planId: command.contract.id,
              status: 'awaitingUserApproval',
              requiredCapabilities: command.contract.requiredCapabilities,
              requiredPermissions: ['temporaryGrant:workspace.write'],
              permissionGaps: ['workspace.write'],
              hardFloorHits: [],
              deniedReasons: [],
              blockedReasons: [],
              findings: [],
              kernelGeneratedPermissionSummary: 'Kernel preflight: status=awaitingUserApproval; capabilities=workspace.write; permissionGaps=workspace.write; hardFloor=none.',
            },
          }],
        };
      }
      return { ok: true, events: [] };
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const bundle = genericWriteProposal(llmCalls === 1);
      return {
        ok: true,
        data: {
          chunks: [{ type: 'reasoning_delta', content: `generic reasoning ${llmCalls}` }, { type: 'done' }],
          assistantMessage: {
            role: 'assistant',
            reasoningContent: `generic reasoning ${llmCalls}`,
            content: JSON.stringify(bundle),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + transcript.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-plan-repair',
    content: 'Create a generic scaffold.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'side-effect actionBundle missing evidence triggers one protocol repair');
  assertEqual(submittedPlans.length, 1, 'repaired actionBundle reaches Kernel plan contract submit once');
  assertEqual((submittedPlans[0].completionCriteria ?? []).length, 1, 'repaired plan contains completion criteria');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired plan renders a plan card');
  assertEqual(result.events.some((event) => event.kind === 'plan_review'), true, 'repaired plan renders a plan review card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'reasoning'), true, 'provider reasoning is visible');
  assertEqual(transcript.some((entry) => entry.type === 'metadata' && entry.kind === 'provider_trace'), true, 'provider trace is archived');
}

async function assertSessionDriverLoopRepairsOversizedActionBundle(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const repairRequests: LlmChatRequest[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-budget-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-budget-repair', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls > 1) repairRequests.push(request);
      const bundle = llmCalls === 1 ? oversizedGenericWriteProposal() : genericWriteProposal(false);
      return jsonLlmResponse(bundle);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + repairRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-budget-repair',
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'oversized actionBundle triggers one implementation batch repair');
  assert(repairRequests.some((request) => request.messages.some((message) => message.content.includes('next small reviewable implementation batch'))), 'repair prompt requests a smaller implementation batch');
  assertEqual(submittedPlans.length, 1, 'repaired oversized actionBundle reaches Kernel plan review once');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired oversized plan renders a plan card');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  assertEqual(Boolean((planCard?.payload as any)?.implementationBatch), true, 'plan card carries implementation batch context');
}

async function assertSessionDriverLoopRepairsEmptyActionBundleResponse(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-empty-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-empty-repair', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return {
          ok: true,
          data: {
            chunks: [{ type: 'reasoning_delta', content: 'generic large draft reasoning' }, { type: 'done' }],
            assistantMessage: {
              role: 'assistant',
              reasoningContent: 'generic large draft reasoning',
              content: '',
            },
          },
        };
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-empty-repair',
    content: 'Create a generic workspace change in reviewable batches.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'empty actionBundle response triggers one compact repair');
  assertEqual(submittedPlans.length, 1, 'repaired empty response reaches Kernel plan review once');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired empty response renders a plan card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && String((event.payload as any).content ?? '').includes('没有返回有效 JSON')), true, 'empty response repair is visible as Thinking');
}

function genericWriteProposal(missingEvidence: boolean): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Create the first small, reviewable scaffold batch for a generic workspace change after user approval.',
      '',
      '## Key Changes',
      '- Write one scoped output file from a top-level code block.',
      '- Keep this batch intentionally small so Kernel facts and user review can inspect the exact file scope.',
      '',
      '## Interfaces',
      '- Use workspace.write with sourceBlockId to connect the planned action to the generated code block.',
      '- Do not invoke shell, git, browser, network, or any unsupported capability in this batch.',
      '',
      '## Test Plan',
      '- Kernel should record a write fact for the planned file path.',
      '- User review should inspect the generated path and content before accepting completion.',
      '',
      '## Assumptions',
      '- The target path is inside the authorized workspace or conversation root.',
      '- Follow-up batches, if any, require review before continuation.',
    ].join('\n'),
    codeBlocks: [{
      id: 'generic-block',
      path: 'generic-output.txt',
      content: 'generic content',
    }],
    actionBundle: {
      version: '1',
      id: 'generic-write-bundle',
      goal: 'Create a generic scaffold.',
      actions: [{
        id: 'write-generic-output',
        title: 'Write generic output',
        capability: 'workspace.write',
        kind: 'write',
        resourceScope: ['generic-output.txt'],
        sourceBlockId: 'generic-block',
      }],
      continuationExpectations: [],
      validationExpectations: missingEvidence
        ? []
        : [{ id: 'generic-evidence', description: 'Kernel records the write fact for the generic output.' }],
      reviewExpectations: missingEvidence
        ? []
        : [{ id: 'generic-review', description: 'User reviews the generic output and write scope.' }],
    },
    expectedValidation: 'Kernel records write facts for the generic output.',
    reviewGuide: 'Review the generic output path and content before approval.',
  };
}

function oversizedGenericWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = Array.from({ length: 5 }, (_item, index) => ({
    id: `generic-block-${index}`,
    path: `generic-output-${index}.txt`,
    content: `generic content ${index}`,
  }));
  return proposal;
}

function jsonLlmResponse(payload: Record<string, unknown>): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'reasoning_delta', content: 'generic reasoning' }, { type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        reasoningContent: 'generic reasoning',
        content: JSON.stringify(payload),
      },
    },
  };
}

function planKernel(
  request: KernelCommandEnvelope,
  sessionId: string,
  submittedPlans: Array<Record<string, any>>
): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') return fakeKernel(request);
  if (command.kind === 'proposalSubmit') {
    return {
      ok: true,
      events: [{
        kind: 'proposal.accepted',
        runId: 'run-generic',
        sessionId,
        proposal: command.proposal,
      }],
    };
  }
  if (command.kind === 'planContractSubmit') {
    submittedPlans.push(command.contract);
    return {
      ok: true,
      events: [{
        kind: 'plan.review_report_produced',
        runId: 'run-generic',
        sessionId,
        report: {
          planId: command.contract.id,
          status: 'awaitingUserApproval',
          requiredCapabilities: command.contract.requiredCapabilities,
          requiredPermissions: ['temporaryGrant:workspace.write'],
          permissionGaps: ['workspace.write'],
          hardFloorHits: [],
          deniedReasons: [],
          blockedReasons: [],
          findings: [],
          kernelGeneratedPermissionSummary: 'Kernel preflight: status=awaitingUserApproval; capabilities=workspace.write; permissionGaps=workspace.write; hardFloor=none.',
        },
      }],
    };
  }
  return { ok: true, events: [] };
}

function genericActionBundle(): ActionBundleDraft {
  return {
    version: '1',
    id: 'bundle-generic',
    goal: 'Perform a generic workspace update after review.',
    actions: [
      {
        id: 'read-generic',
        title: 'Read generic resource',
        kind: 'read',
        capability: 'workspace.read',
        resourceScope: ['generic/input.txt'],
        canParallelize: true,
        conflictKeys: [],
      },
      {
        id: 'write-generic',
        title: 'Write generic resource',
        kind: 'write',
        capability: 'workspace.write',
        resourceScope: ['generic/output.txt'],
        canParallelize: false,
        conflictKeys: ['generic/output.txt'],
        sourceBlockId: 'code-generic',
      },
    ],
    validationExpectations: [{ id: 'validation-generic', description: 'Kernel records the proposed validation.' }],
    reviewExpectations: [{ id: 'review-generic', description: 'User reviews the scoped change.' }],
  };
}

function fakeKernel(request: KernelCommandEnvelope): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') {
    return {
      ok: true,
      events: [
        {
          kind: 'state.entered',
          runId: 'run-generic',
          sessionId: 'session-generic',
          stateContract: {
            runId: 'run-generic',
            stateId: 'needProposal',
            stateKind: 'driverRequest',
            allowedInputs: ['proposalSubmit', 'resourceResolve'],
            allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
            proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
            capabilityProjection: ['workspace.read', 'workspace.write'],
          },
        },
        {
          kind: 'driver.request_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          driverRequest: {
            id: 'driver-generic',
            runId: 'run-generic',
            sessionId: 'session-generic',
            kind: 'needProposal',
            reason: 'Need a v3 proposal.',
            stateContract: {
              runId: 'run-generic',
              stateId: 'needProposal',
              stateKind: 'driverRequest',
              allowedInputs: ['proposalSubmit', 'resourceResolve'],
              allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
              proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
              capabilityProjection: ['workspace.read', 'workspace.write'],
            },
          },
        },
      ],
    };
  }
  if (command.kind === 'resourceResolve') {
    return {
      ok: true,
      events: [
        {
          kind: 'resource.packet_produced',
          runId: 'run-generic',
          sessionId: 'session-generic',
          packet: {
            id: 'packet-generic',
            requestId: command.requestId,
            items: [
              {
                requestItemId: 'item-generic',
                manifestEntryId: command.request.manifest.entries[0].id,
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: 'file',
                contentKind: 'fileText',
                content: 'resolved generic content',
                evidenceRefs: ['evidence-generic'],
              },
            ],
          },
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

function fakeLlm(_request: LlmChatRequest): ApiResponse<LlmChatResult> {
  return {
    ok: true,
    data: {
      chunks: [{ type: 'done' }],
      assistantMessage: {
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'The attached generic resource was resolved through Kernel ResourceResolve.' },
        }),
      },
    },
  };
}

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertThrows(fn: () => unknown, expectedMessage: string): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.includes(expectedMessage)) return;
    throw error;
  }
  throw new Error(`expected function to throw: ${expectedMessage}`);
}

main().catch((error) => {
  console.error(error);
  throw error;
});
