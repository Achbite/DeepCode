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
  buildNarrativeTimelineProjection,
  buildPromptEnvelope,
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
  assertActionBundleProtocolFields();
  assertPromptEnvelope();
  assertNarrativeTimelineProjection();
  assertSessionDriverSkeleton();
  await assertSessionDriverLoop();
  await assertSessionDriverLoopPathResourceRequest();
  await assertSessionDriverLoopRejectsOutsidePath();
  await assertSessionDriverLoopUsesRecentAttachmentRoot();
  await assertSessionDriverLoopProjectsDecisionRequest();
  await assertSessionDriverLoopRepairsSideEffectBundleEvidence();
  await assertSessionDriverLoopRepairsInvalidSourceBlock();
  await assertSessionDriverLoopRepairsOversizedActionBundle();
  await assertSessionDriverLoopRepairsEmptyActionBundleResponse();
  await assertSessionDriverLoopReviewRevisionReturnsToPlanning();
  await assertSessionDriverLoopReviewAcceptStopsAtCurrentBatch();
}

async function assertSessionDriverLoopProjectsDecisionRequest(): Promise<void> {
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
        kind: 'decisionRequest',
        outputLanguage: 'en-US',
        decisionRequest: {
          version: '1',
          id: 'decision-generic-auto',
          reason: 'A generic user decision is required before planning.',
          summary: 'Choose how to proceed with the generic side-effect task.',
          options: [
            { id: 'recommended', label: 'Proceed', description: 'Generate the next reviewable plan.', recommended: true },
            { id: 'stop', label: 'Stop', description: 'Do not generate an implementation plan.' },
          ],
          allowsFreeform: true,
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
  assertEqual(llmCalls, 1, 'decisionRequest is produced by provider once');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'decisionRequest projects to a user intervention card');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'decisionRequest does not generate a plan before user decision');
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

function assertActionBundleProtocolFields(): void {
  const bundle = genericActionBundle();
  assertEqual(bundle.actions.some((action) => action.capability === 'workspace.write'), true, 'actionBundle carries workspace.write capability');
  assertEqual(bundle.validationExpectations.length > 0, true, 'actionBundle carries validation expectations');
  assertEqual(bundle.reviewExpectations.length > 0, true, 'actionBundle carries review expectations');

  const proposal = parseProposalEnvelope({
    runId: 'run-normalize',
    sessionId: 'session-normalize',
    raw: JSON.stringify(providerFacingWriteProposalWithoutMachineIds()),
  });
  const payload = proposal.payload as any;
  assertEqual(payload.actionBundle.id, 'proposal-run-normalize-actionBundle-action-bundle', 'Session parser fills actionBundle id deterministically');
  assertEqual(payload.codeBlocks[0].id, 'generic-block', 'Session parser maps blockId to codeBlock id');
  assertEqual(payload.codeBlocks[0].path, 'generic-output.txt', 'Session parser maps targetPath to codeBlock path');
  assertEqual(payload.actionBundle.actions[0].id, 'write-generic-output', 'Session parser maps actionId to action id');
  assertEqual(payload.actionBundle.actions[0].title, 'Write generic output', 'Session parser maps description to action title');
  assertEqual(payload.actionBundle.actions[0].canParallelize, false, 'Session parser fills canParallelize default');
  assertEqual(payload.actionBundle.actions[0].conflictKeys[0], 'generic-output.txt', 'Session parser derives conflict key from resource scope');
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
  assert(prompt.stablePrefix.includes('<systemStructure'), 'prompt includes the system structure layer');
  assert(prompt.stablePrefix.includes('black-box validation'), 'prompt treats tests as black-box validation');
  assert(prompt.stablePrefix.includes('Do not optimize for known tests'), 'prompt rejects test-specific optimization');
  assert(prompt.dynamicSuffix.includes('generic content'), 'prompt includes ResourcePacket content');
  assert(!prompt.dynamicSuffix.includes('auditOnlyContext'), 'audit-only context is not in dynamic suffix');
}

function assertNarrativeTimelineProjection(): void {
  const events: AgentEvent[] = [
    {
      id: 'event-user',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze a generic attachment.' },
    },
    {
      id: 'event-thinking',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'reasoning', content: 'Need generic context.' },
    },
    {
      id: 'event-tool',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result',
      payload: {
        toolName: 'fs.read',
        summary: 'Read generic resource.',
        evidenceRefs: ['evidence-generic'],
        status: 'completed',
      },
    },
    {
      id: 'event-plan',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'plan_card',
      payload: { title: 'Generic plan', summary: 'Review generic next step.' },
    },
    {
      id: 'event-answer',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'final', content: 'Generic final answer.' },
    },
  ];

  const projection = buildNarrativeTimelineProjection({
    sessionId: 'session-narrative',
    events,
    generatedAt: '2026-01-01T00:00:05.000Z',
  });
  assertEqual(projection.schemaVersion, 'deepcode.session.timeline.v1', 'narrative timeline is versioned');
  assertEqual(projection.turns.length, 1, 'events are grouped into one turn');
  const kinds = projection.turns[0].blocks.map((block) => block.narrativeKind);
  assertEqual(kinds.includes('user'), true, 'user block is projected');
  assertEqual(kinds.includes('thinking'), true, 'thinking block is projected');
  assertEqual(kinds.includes('operationEvidence'), true, 'tool facts become operation evidence');
  assertEqual(kinds.includes('plan'), true, 'plan facts become a plan block');
  assertEqual(kinds.includes('assistantText'), true, 'final answer becomes assistant text');
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'operationEvidence'),
    true,
    'task projection is derived from narrative blocks'
  );
  assertEqual(
    projection.turns[0].blocks.some((block) => block.evidenceRefs?.includes('evidence-generic')),
    true,
    'evidence refs are preserved for frontend drilldown'
  );
  assertEqual(
    projection.rawEventRefs?.includes('event:event-tool'),
    true,
    'raw event refs are preserved for debug views'
  );
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
        submittedPlans.push(command.proposal);
        const actionBundle = command.proposal?.payload?.actionBundle ?? {};
        return {
          ok: true,
          events: [
            {
              kind: 'proposal.accepted',
              runId: 'run-generic',
              sessionId: 'session-plan-repair',
              proposal: command.proposal,
            },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: 'session-plan-repair',
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(actionBundle),
            },
          ],
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
  assertEqual(submittedPlans.length, 1, 'repaired actionBundle reaches Kernel ProposalSubmit once');
  assertEqual(submittedPlans[0].kind, 'actionBundle', 'repaired proposal remains an actionBundle');
  const repairedBundle = submittedPlans[0].payload?.actionBundle ?? {};
  assertEqual((repairedBundle.validationExpectations ?? []).length, 1, 'repaired actionBundle contains validation expectations');
  assertEqual((repairedBundle.reviewExpectations ?? []).length, 1, 'repaired actionBundle contains review expectations');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired plan renders a plan card');
  assertEqual(result.events.some((event) => event.kind === 'plan_review'), true, 'repaired plan renders a plan review card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'reasoning'), true, 'provider reasoning is visible');
  assertEqual(transcript.some((entry) => entry.type === 'metadata' && entry.kind === 'provider_trace'), true, 'provider trace is archived');
}

async function assertSessionDriverLoopRepairsInvalidSourceBlock(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-source-block-repair',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-source-block-repair', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const proposal = genericWriteProposal(false);
      if (llmCalls === 1) {
        (proposal.actionBundle as any).actions[0].sourceBlockId = 'missing-code-block';
      }
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-source-block-repair',
    content: 'Create a generic scaffold.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(llmCalls, 2, 'invalid sourceBlockId triggers one protocol repair');
  assertEqual(submittedPlans.length, 1, 'only repaired actionBundle reaches Kernel');
  assertEqual(
    submittedPlans[0].payload?.actionBundle?.actions?.[0]?.sourceBlockId,
    'generic-block',
    'repaired actionBundle sourceBlockId matches a code block'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'repaired sourceBlockId plan renders a plan card');
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

async function assertSessionDriverLoopReviewRevisionReturnsToPlanning(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-generic',
    sessionId: 'session-review-revision',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-source',
      reviewId: 'review-generic',
      sourcePlanId: 'plan-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: [
        '- `fs.write` ok: {"path":"generic-output.txt","validation":{"kind":"readBack","passed":true}}',
        '- `work-unit-generic` completed: {"path":"generic-output.txt"}',
      ],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'workspace.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-revision',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-revision', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-revision',
    kind: 'review',
    decision: 'revise',
    guidance: 'Add a generic script and document how to run it.',
    runId: 'run-review-source',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'needsRevision'), true, 'review guidance is recorded as needsRevision');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'review revision starts a new planning turn');
  assertEqual(submittedPlans.length, 1, 'review revision submits the new actionBundle to Kernel PlanReview');
  assertEqual(llmRequests.length, 1, 'review revision calls the provider for a new plan once');
  const promptText = llmRequests.flatMap((request) => request.messages.map((message) => message.content)).join('\n');
  assert(promptText.includes('Add a generic script and document how to run it.'), 'review guidance enters the next PromptEnvelope');
  assert(promptText.includes('Session short-term memory document'), 'structured session memory is included');
  assert(promptText.includes('factContext'), 'kernel facts are separated into factContext');
  assert(promptText.includes('intentContext'), 'plans and continuations are separated into intentContext');
}

async function assertSessionDriverLoopReviewAcceptStopsAtCurrentBatch(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-accept-generic',
    sessionId: 'session-review-accept',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-accept',
      reviewId: 'review-accept-generic',
      sourcePlanId: 'plan-accept-generic',
      content: '## Review\n\nThe first batch wrote a generic source file.',
      userPlan: '# Plan\n\n## Summary\nCreate the first generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{
        id: 'next-generic-batch',
        title: 'Add a generic follow-up script',
        capability: 'workspace.write',
        kind: 'write',
        resourceScope: ['scripts/generic.sh'],
      }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-accept',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-accept', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-accept',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-accept',
    existingEvents: events,
  });

  const acceptedReview = result.events.find((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted');
  if (!acceptedReview) throw new Error('review accept records an accepted review event');
  const acceptedPayload = acceptedReview.payload as any;
  assertEqual(acceptedPayload.continuationRequested, false, 'review accept records continuations without auto-continuing');
  assert(String(acceptedPayload.content ?? '').includes('不会自动生成或执行下一批'), 'accepted review explains that continuations are intent only');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'review accept does not generate a continuation plan');
  assertEqual(submittedPlans.length, 0, 'review accept does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'review accept does not call the provider');
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

function providerFacingWriteProposalWithoutMachineIds(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  delete (proposal.actionBundle as any).id;
  proposal.codeBlocks = [{
    blockId: 'generic-block',
    targetPath: 'generic-output.txt',
    language: 'text',
    operation: 'create',
    content: 'generic content',
    permissionLabels: ['workspace.write'],
  }];
  (proposal.actionBundle as any).actions = [{
    actionId: 'write-generic-output',
    description: 'Write generic output',
    capability: 'workspace.write',
    resourceScope: ['generic-output.txt'],
    targetPath: 'generic-output.txt',
    sourceBlockId: 'generic-block',
    dependsOn: [],
    permissionLabels: ['workspace.write'],
  }];
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
    submittedPlans.push(command.proposal);
    const actionBundle = command.proposal?.payload?.actionBundle ?? {};
    return {
      ok: true,
      events: [
        {
          kind: 'proposal.accepted',
          runId: 'run-generic',
          sessionId,
          proposal: command.proposal,
        },
        {
          kind: 'proposal.reviewed',
          runId: 'run-generic',
          sessionId,
          proposalId: command.proposal?.proposalId,
          report: proposalReviewReport(actionBundle),
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

function proposalReviewReport(actionBundle: Record<string, any>): Record<string, any> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const capabilities = [...new Set(actions.map((action) => action.capability).filter(Boolean))].sort();
  return {
    planId: actionBundle.id ?? 'bundle-generic',
    status: 'awaitingUserApproval',
    requiredCapabilities: capabilities,
    requiredPermissions: capabilities.includes('workspace.write') ? ['temporaryGrant:workspace.write'] : [],
    permissionGaps: capabilities.includes('workspace.write') ? ['workspace.write'] : [],
    hardFloorHits: [],
    deniedReasons: [],
    blockedReasons: [],
    findings: [],
    kernelGeneratedPermissionSummary: `Kernel preflight: status=awaitingUserApproval; capabilities=${capabilities.join(',')}; permissionGaps=${capabilities.includes('workspace.write') ? 'workspace.write' : 'none'}; hardFloor=none.`,
  };
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
