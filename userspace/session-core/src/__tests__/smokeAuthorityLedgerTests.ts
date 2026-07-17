import type {
  AgentEvent,
  KernelArtifactDraftLedgerFrame,
} from '@deepcode/protocol';
import type { AcceptedTaskPlanContext } from '../accepted-plan/types.js';
import type { ResourcePacket } from '../context/types.js';
import { recoverKernelContext } from '../driver/context/kernelEnvelopeReader.js';
import {
  buildUserAuthorityFrame,
  createSessionTurnAuthorityEvent,
} from '../driver/context/userAuthorityFrame.js';
import { buildResourceDelta } from '../resources/ResourceDeltaBuilder.js';
import {
  buildProjectBootstrapSnapshot,
  renderProjectBootstrapSnapshot,
} from '../prompt/projectBootstrap.js';
import { SessionFailureProjectionBuilder } from '../driver/projection/sessionFailureProjectionBuilder.js';
import { recoverArtifactBudgetReplanReason } from '../driver/pipelines/lifecyclePipeline.js';
import {
  ArtifactDraftLease,
} from '../driver/execution/artifactDraftLedger.js';
import { ArtifactDraftReplanCoordinator } from '../driver/execution/artifactDraftReplanCoordinator.js';
import { OperationIntentCompiler } from '../driver/execution/operationIntentCompiler.js';
import { IntentSlotRegistry } from '../driver/execution/intentSlot.js';
import {
  emptyPromptLedgerState,
  preparePromptLedger,
  promptLedgerWireRequest,
  restorePromptLedger,
  restoreProviderRequestCacheHistory,
  type PromptLedgerWireRecord,
} from '../prompt/promptLedger.js';
import {
  assert,
  assertEqual,
  assertThrows,
  randomSmokeToken,
} from './smokeHelpers.js';

export function assertKernelEnvelopeRecoveryUsesLatestMatchingRun(): void {
  const token = randomSmokeToken('kernel-envelope');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const values: AgentEvent[] = [
    kernelContextEvent(sessionId, runId, `catalog-old-${token}`),
    kernelContextEvent(sessionId, `unrelated-${token}`, `catalog-unrelated-${token}`),
    kernelContextEvent(sessionId, runId, `catalog-current-${token}`),
  ];

  const recovered = recoverKernelContext(values, runId, sessionId);
  assertEqual(recovered.runId, runId, 'Kernel context recovery keeps the requested run');
  assertEqual(
    recovered.toolCatalogSnapshot?.catalogHash,
    `catalog-current-${token}`,
    'Kernel context recovery uses the latest recognized envelope for the requested run'
  );

  const partialEnvelopeValues: AgentEvent[] = [
    kernelContextEvent(sessionId, runId, `catalog-partial-${token}`),
    {
      id: `driver-only-${token}`,
      sessionId,
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'workflow_stage',
      payload: {
        kernelEvent: {
          kind: 'driver.request_produced',
          runId,
          sessionId,
          driverRequest: {
            id: `request-${token}`,
            runId,
            sessionId,
            kind: 'needProposal',
            reason: 'partial-envelope-smoke',
          },
        },
      },
    },
  ];
  const recoveredPartial = recoverKernelContext(partialEnvelopeValues, runId, sessionId);
  assertEqual(
    recoveredPartial.driverRequest?.id,
    `request-${token}`,
    'Kernel context recovery keeps the latest driver request from a partial envelope'
  );
  assertEqual(
    recoveredPartial.toolCatalogSnapshot?.catalogHash,
    `catalog-partial-${token}`,
    'Kernel context recovery fills missing catalog state from the latest earlier envelope in the same run'
  );
}

export function assertUserAuthorityFramePreservesExplicitMessages(): void {
  const token = randomSmokeToken('user-authority');
  const events: AgentEvent[] = [
    userEvent(`root-${token}`, `session-${token}`, '请保留这条原始请求。'),
    {
      id: `decision-${token}`,
      sessionId: `session-${token}`,
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'requirement_decision',
      payload: { requirementId: `requirement-${token}`, status: 'accepted', guidance: '采用已确认路线。' },
    },
    userEvent(`followup-${token}`, `session-${token}`, '随后继续处理第二条明确请求。'),
  ];
  events.push(createSessionTurnAuthorityEvent({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    turnId: `turn-${token}`,
    taskId: `task-${token}`,
    messages: [{ messageId: `followup-${token}`, content: '随后继续处理第二条明确请求。' }],
    relation: 'newTask',
    boundAtHookRef: 'smoke.authority',
    outputLanguage: 'zh-CN',
    eventId: `authority-${token}`,
    timestamp: '2026-01-01T00:00:02.000Z',
  }));
  const frame = buildUserAuthorityFrame(
    events,
    { messageId: `fallback-${token}`, content: 'fallback must not replace explicit messages' },
    (content) => /[\u3400-\u9fff]/u.test(content) ? 'zh-CN' : 'en-US',
    'trustedWorkspace',
    { runId: `run-${token}` }
  );

  assertEqual(frame.rootMessage.content, '请保留这条原始请求。', 'User authority keeps the first explicit user message as root');
  assertEqual(frame.explicitMessages.length, 2, 'User authority records every explicit user message');
  assertEqual(frame.explicitMessages[1]?.content, '随后继续处理第二条明确请求。', 'User authority preserves later user text verbatim');
  assertEqual(frame.currentMessages.length, 1, 'User authority exposes only messages bound to the current turn');
  assertEqual(frame.currentMessages[0]?.messageId, `followup-${token}`, 'User authority does not infer the current task from history position');
  assertEqual(frame.turnAuthority.taskId, `task-${token}`, 'User authority restores the persisted task binding');
  assertEqual(frame.outputLanguage, 'zh-CN', 'User authority derives visible language from explicit user text');
  assertEqual(frame.autonomyMode, 'trustedWorkspace', 'User authority retains the selected autonomy mode');
  assertEqual(frame.decisionRefs[0]?.targetId, `requirement-${token}`, 'User authority records structured decision references separately');
}

export function assertPromptLedgerReusesPrefixAndAppendsWithinEpoch(): void {
  const token = randomSmokeToken('prompt-ledger');
  const state = emptyPromptLedgerState();
  let sequence = 0;
  const createId = (prefix: string): string => `${prefix}-${token}-${++sequence}`;
  const authorityEvents = [
    userEvent(`root-${token}`, `session-${token}`, `Root request ${token}`),
    userEvent(`followup-${token}`, `session-${token}`, `Follow-up request ${token}`),
  ];
  authorityEvents.push(createSessionTurnAuthorityEvent({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    turnId: `turn-${token}`,
    taskId: `task-${token}`,
    messages: [
      { messageId: `root-${token}`, content: `Root request ${token}` },
      { messageId: `followup-${token}`, content: `Follow-up request ${token}` },
    ],
    relation: 'newTask',
    boundAtHookRef: 'smoke.prompt-ledger',
    outputLanguage: 'en-US',
    eventId: `authority-${token}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  }));
  const authority = buildUserAuthorityFrame(
    authorityEvents,
    { messageId: `fallback-${token}`, content: `Fallback ${token}` },
    () => 'en-US',
    'strict',
    { runId: `run-${token}` }
  );
  const first = preparePromptLedger({
    state,
    profileId: 'planning-v1',
    epochScopeKey: `planning-${token}`,
    workspaceScopeKey: `scope-${token}`,
    systemContent: `Stable system ${token}`,
    toolsHash: `tools-${token}`,
    authority,
    requestFrame: `Request frame one ${token}`,
    toolCatalogSnapshot: `Tool catalog ${token}`,
    workspaceBootstrap: `Bootstrap ${token}`,
    memorySnapshot: { version: 1, token },
    workflowDelta: `Dynamic context one ${token}`,
    now: '2026-01-01T00:00:00.000Z',
    createId,
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_000,
  });
  const firstKinds = first.epoch.entries.map((entry) => entry.kind);
  assert(
    firstKinds.indexOf('toolCatalogSnapshot') < firstKinds.indexOf('rootUser'),
    'PromptLedger places the planning tool index in the stable system prefix before the root user message'
  );
  assertEqual(
    first.epoch.entries.find((entry) => entry.kind === 'toolCatalogSnapshot')?.message.role,
    'system',
    'PromptLedger represents the planning tool index as a system contract entry'
  );
  assert(
    firstKinds.indexOf('workspaceBootstrap') < firstKinds.indexOf('turnAuthority'),
    'PromptLedger keeps workspace bootstrap in the stable prefix before the current turn'
  );
  assert(
    firstKinds.indexOf('turnAuthority') < firstKinds.indexOf('rootUser'),
    'PromptLedger binds the current turn before appending its exact user messages'
  );
  assert(
    firstKinds.indexOf('explicitUser') < firstKinds.indexOf('requestDelta'),
    'PromptLedger preserves later explicit user messages before the current request frame'
  );
  const second = preparePromptLedger({
    state,
    profileId: 'planning-v1',
    epochScopeKey: `planning-${token}`,
    workspaceScopeKey: `scope-${token}`,
    systemContent: `Stable system ${token}`,
    toolsHash: `tools-${token}`,
    authority,
    requestFrame: `Request frame two ${token}`,
    toolCatalogSnapshot: `Tool catalog ${token}`,
    workspaceBootstrap: `Bootstrap ${token}`,
    memorySnapshot: { version: 2, token },
    workflowDelta: `Dynamic context two ${token}`,
    now: '2026-01-01T00:00:01.000Z',
    createId,
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_000,
  });

  assertEqual(second.epoch.epochId, first.epoch.epochId, 'PromptLedger reuses the active epoch when stable prefix and tools are unchanged');
  assertEqual(second.cacheShapeReason, 'appendOnlyReuse', 'PromptLedger reports append-only cache reuse');
  assertEqual(
    JSON.stringify(second.messages.slice(0, first.messages.length)),
    JSON.stringify(first.messages),
    'PromptLedger preserves the complete previously sent prefix when the workflow contract changes'
  );
  assertEqual(
    second.messages.filter((message) => message.content === `Dynamic context one ${token}`).length,
    1,
    'Provider projection retains the previously sent workflow delta in append-only order'
  );
  assertEqual(
    second.messages.filter((message) => message.content === `Dynamic context two ${token}`).length,
    1,
    'Provider projection exposes exactly one current workflow contract'
  );
  assertEqual(
    second.epoch.entries.filter((entry) => entry.kind === 'workflowDelta').length,
    2,
    'PromptLedger keeps historical workflow contracts in the internal append-only ledger'
  );
  assertEqual(
    second.messages.filter((message) => message.content === `Root request ${token}`).length,
    1,
    'PromptLedger emits the authoritative root user message exactly once per epoch'
  );
  assert(second.messages.some((message) => message.content.includes('SessionMemoryDelta:')), 'PromptLedger appends memory changes as a delta');
  assertEqual(
    second.messages.filter((message) => message.content === `Tool catalog ${token}`).length,
    1,
    'PromptLedger emits the planning tool index once per epoch'
  );
  assertEqual(
    second.messages.filter((message) => message.content === `Bootstrap ${token}`).length,
    1,
    'PromptLedger emits the workspace bootstrap once per epoch'
  );

  const wireRecord = promptLedgerWireRequest({
    recordId: `wire-${token}`,
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    profileId: 'planning-v1',
    epoch: second.epoch,
    messages: second.messages,
    timestamp: '2026-01-01T00:00:01.500Z',
    turnAuthority: authority.turnAuthority,
  });
  assertEqual(
    wireRecord.ledgerEntries?.length,
    wireRecord.messages?.length,
    'WireLedger metadata stays aligned with the projected provider messages'
  );
  const restored = restorePromptLedger([wireRecord]);
  const resumed = preparePromptLedger({
    state: restored,
    profileId: 'planning-v1',
    epochScopeKey: `planning-${token}`,
    workspaceScopeKey: `scope-${token}`,
    systemContent: `Stable system ${token}`,
    toolsHash: `tools-${token}`,
    authority,
    requestFrame: `Request frame three ${token}`,
    toolCatalogSnapshot: `Tool catalog ${token}`,
    workspaceBootstrap: `Bootstrap ${token}`,
    memorySnapshot: { version: 2, token },
    workflowDelta: `Dynamic context three ${token}`,
    now: '2026-01-01T00:00:01.750Z',
    createId,
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_000,
  });
  assertEqual(
    resumed.messages.filter((message) => message.content.startsWith('Dynamic context ')).length,
    3,
    'Restoring from WireLedger keeps previously sent workflow deltas and appends the next delta'
  );
  assertEqual(
    resumed.messages.filter((message) => message.content === `Dynamic context three ${token}`).length,
    1,
    'Restored PromptLedger appends the latest workflow contract once'
  );

  const rebound = preparePromptLedger({
    state,
    profileId: 'planning-v1',
    epochScopeKey: `planning-${token}`,
    workspaceScopeKey: `rebound-scope-${token}`,
    systemContent: `Stable system ${token}`,
    toolsHash: `tools-${token}`,
    authority,
    requestFrame: `Request frame after rebind ${token}`,
    toolCatalogSnapshot: `Tool catalog ${token}`,
    workspaceBootstrap: `Bootstrap ${token}`,
    memorySnapshot: { version: 2, token },
    workflowDelta: `Dynamic context after rebind ${token}`,
    now: '2026-01-01T00:00:02.000Z',
    createId,
    contextWindowTokens: 64_000,
    maxOutputTokens: 8_000,
  });
  assert(rebound.epoch.epochId !== second.epoch.epochId, 'Project rebind rotates the PromptLedger epoch');
  assertEqual(rebound.cacheShapeReason, 'workspaceScopeChanged', 'PromptLedger reports workspace scope rotation');
}

export function assertPromptLedgerRotatesAcceptedTaskScope(): void {
  const token = randomSmokeToken('task-epoch');
  const state = emptyPromptLedgerState();
  let sequence = 0;
  const createId = (prefix: string): string => `${prefix}-${token}-${++sequence}`;
  const events = [userEvent(`root-${token}`, `session-${token}`, `Implement ${token}`)];
  events.push(createSessionTurnAuthorityEvent({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    turnId: `turn-${token}`,
    taskId: `user-task-${token}`,
    messages: [{ messageId: `root-${token}`, content: `Implement ${token}` }],
    relation: 'newTask',
    boundAtHookRef: 'smoke.task-epoch',
    outputLanguage: 'en-US',
    eventId: `authority-${token}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  }));
  const authority = buildUserAuthorityFrame(
    events,
    { messageId: `fallback-${token}`, content: `Fallback ${token}` },
    () => 'en-US',
    'strict',
    { runId: `run-${token}` }
  );
  const first = preparePromptLedger({
    state,
    profileId: 'execution-v1',
    epochScopeKey: `execution:run-${token}:plan-${token}:task-one:template-one`,
    taskTemplateHash: 'template-one',
    workspaceScopeKey: `scope-${token}`,
    systemContent: `Stable execution contract ${token}`,
    toolsHash: `tools-${token}`,
    authority,
    requestFrame: `Current task task-one ${token}`,
    workflowDelta: `Task-one-only instruction ${token}`,
    now: '2026-01-01T00:00:00.000Z',
    createId,
  });
  const second = preparePromptLedger({
    state,
    profileId: 'execution-v1',
    epochScopeKey: `execution:run-${token}:plan-${token}:task-two:template-two`,
    taskTemplateHash: 'template-two',
    workspaceScopeKey: `scope-${token}`,
    systemContent: `Stable execution contract ${token}`,
    toolsHash: `tools-${token}`,
    authority,
    requestFrame: `Current task task-two ${token}`,
    workflowDelta: `Task-two-only instruction ${token}`,
    now: '2026-01-01T00:00:01.000Z',
    createId,
  });

  assert(first.epoch.epochId !== second.epoch.epochId, 'Each accepted task uses an independent execution PromptLedger epoch');
  assertEqual(second.cacheShapeReason, 'acceptedTaskChanged', 'Task switch records the acceptedTaskChanged cache-shape reason');
  assertEqual(second.epoch.systemHash, first.epoch.systemHash, 'Task epochs preserve the byte-stable execution system prefix');
  assertEqual(second.epoch.toolsHash, first.epoch.toolsHash, 'Task epochs preserve the stable semantic tool schema hash');
  assertEqual(
    second.messages.some((message) => message.content.includes(`Task-one-only instruction ${token}`)),
    false,
    'The next task epoch does not inherit the prior task execution instruction'
  );
  assertEqual(
    second.messages.some((message) => message.content.includes(`Task-two-only instruction ${token}`)),
    true,
    'The next task epoch contains only its current task instruction'
  );
}

export function assertWorkspaceBootstrapAndResourceDeltaStayIncremental(): void {
  const token = randomSmokeToken('workspace-bootstrap');
  const rootId = `root-${token}`;
  const rootPath = `/tmp/${token}`;
  const manifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `scope-${token}`,
    workspaceBindingHash: `binding-${token}`,
    projectRootStatus: 'ready' as const,
    entries: [{
      id: rootId,
      rootId,
      kind: 'directory' as const,
      label: token,
      resourceRef: rootPath,
      readPolicy: 'autoRead' as const,
      reason: 'bootstrap smoke',
      contextUse: 'workspaceBootstrap' as const,
    }],
    budget: { maxEntries: 8, maxBytes: 4096 },
    defaultDenyPatterns: [],
  };
  const root = {
    rootId,
    kind: 'directory' as const,
    label: token,
    displayPath: rootPath,
    absolutePath: rootPath,
    source: 'workspaceBinding' as const,
    primary: true,
  };
  const packet = {
    id: `packet-${token}`,
    requestId: `request-${token}`,
    workspaceScopeKey: manifest.workspaceScopeKey,
    items: [{
      requestItemId: `item-${token}`,
      manifestEntryId: rootId,
      rootId,
      readPolicy: 'autoRead' as const,
      status: 'resolved' as const,
      absolutePath: rootPath,
      contentKind: 'directoryTree' as const,
      returnedCount: 1,
      truncated: false,
      nodes: [{
        path: `source-${token}.txt`,
        type: 'file',
        fileClassification: { kind: 'text', readableText: true, sizeBytes: 12 },
      }],
      promptContent: `private-content-${token}`,
    }],
  };
  const snapshot = buildProjectBootstrapSnapshot({ manifest, roots: [root], packets: [packet] });
  const rendered = renderProjectBootstrapSnapshot(snapshot);
  assert(snapshot, 'Workspace bootstrap is built from the bounded root inventory');
  assert(!rendered.includes(`private-content-${token}`), 'Workspace bootstrap never includes file content');
  assert(rendered.includes(`source-${token}.txt`), 'Workspace bootstrap contains first-level navigation metadata');

  const focusedPacket = {
    ...packet,
    id: `focused-${token}`,
    items: [{
      requestItemId: `focused-item-${token}`,
      manifestEntryId: `focused-entry-${token}`,
      rootId,
      readPolicy: 'autoRead' as const,
      status: 'resolved' as const,
      absolutePath: `${rootPath}/source-${token}.txt`,
      contentKind: 'fileText' as const,
      promptContent: `focused-content-${token}`,
      originalBytes: 20,
    }],
  };
  const delta = buildResourceDelta({
    requestId: `focused-request-${token}`,
    workspaceScopeKey: manifest.workspaceScopeKey,
    packets: [focusedPacket],
    roots: [root],
  });
  assertEqual(delta.items.length, 1, 'ResourceDelta contains only facts from the current resource call');
  assertEqual(delta.rootId, rootId, 'A single-root ResourceDelta exposes the resolved root identity');
  assertEqual(delta.items[0]?.path, `source-${token}.txt`, 'ResourceDelta paths are root-relative');
  assertEqual(delta.items[0]?.content, `focused-content-${token}`, 'ResourceDelta includes explicitly requested file text');
}

export function assertInternalFailureProjectsFailedTerminalState(): void {
  const token = randomSmokeToken('internal-failure');
  const builder = new SessionFailureProjectionBuilder({
    actionBatchFailureDetails: () => [],
    actionBatchFailureSummary: () => '',
    sessionRunStateEvent: (input) => ({
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'session_run_state',
      payload: { status: input.status, reason: input.reason, runId: input.runId },
    }),
  });
  const events = builder.internalFailureEvents({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    stage: 'provider',
    code: 'provider_failure',
    message: `failure-${token}`,
    reason: 'provider_failure',
    ts: '2026-01-01T00:00:00.000Z',
    id: `failure-${token}`,
  });
  assertEqual(events[0]?.kind, 'error', 'Internal failure emits a structured error event');
  assertEqual(events[1]?.kind, 'session_run_state', 'Internal failure emits a terminal run-state event');
  assertEqual((events[1]?.payload as Record<string, unknown>).status, 'failed', 'Internal failure run-state is failed');
}

export function assertProviderCacheHistoryRestoresBySemanticProfile(): void {
  const token = randomSmokeToken('provider-cache-history');
  const semanticProfileId = `planning-${token}`;
  const segmentId = `segment:${token}:toolCatalogSummary`;
  const record: PromptLedgerWireRecord = {
    schemaVersion: 'deepcode.session.wire-ledger.v1',
    recordId: `wire-${token}`,
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    profileId: `provider-profile-${token}`,
    workspaceScopeKey: `scope-${token}`,
    semanticProfileId,
    epochId: `epoch-${token}`,
    kind: 'providerRequest',
    timestamp: '2026-01-01T00:00:00.000Z',
    messages: [{ role: 'user', content: `request-${token}` }],
    schemaHash: `schema-${token}`,
    responseFormatHash: `format-${token}`,
    promptSegmentDigests: [{ id: segmentId, contentHash: `fnv1a32:${token}` }],
  };

  const history = restoreProviderRequestCacheHistory([record]);
  assert(history[semanticProfileId], 'Provider cache history is keyed by the semantic profile used by cache topology');
  assertEqual(
    history[semanticProfileId]?.segments[0]?.id,
    segmentId,
    'Provider cache history preserves segment ids independently from content hashes'
  );
  assertEqual(
    history[`provider-profile-${token}`],
    undefined,
    'Provider transport profile does not replace the semantic cache profile key'
  );
}

export function assertArtifactDraftLeaseEnforcesBoundsAndRestores(): void {
  const token = randomSmokeToken('artifact-draft');
  const sessionId = `session-${token}`;
  const runId = `run-${token}`;
  const thirtyFourLinePlan = acceptedCreatePlan(`${runId}-34-lines`, `${token}-34-lines`);
  const thirtyFourLineLease = ArtifactDraftLease.create({
    runId: `${runId}-34-lines`,
    sessionId,
    acceptedPlan: thirtyFourLinePlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-34-lines`,
  });
  const thirtyFourLineFrame = thirtyFourLineLease.prepareAppendFrame({
    slotId: firstIntentSlotId(thirtyFourLinePlan),
    contentLines: Array.from({ length: 34 }, (_item, index) => `line-${index}`),
    finalChunk: true,
    resourcePackets: [],
    createId: (prefix) => `${prefix}-${token}-34-lines-frame`,
  });
  thirtyFourLineLease.commitAcceptedFrame(thirtyFourLineFrame);
  assertEqual(
    thirtyFourLineLease.snapshot().slots[0]?.chunks[0]?.length,
    34,
    'A 34-line logical block is accepted without transport-frame repair'
  );
  const acceptedPlan = acceptedCreatePlan(runId, token);
  let sequence = 0;
  const lease = ArtifactDraftLease.create({
    runId,
    sessionId,
    acceptedPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  const slotId = firstIntentSlotId(acceptedPlan);
  const firstLines = Array.from(
    { length: 47 },
    (_, index) => index === 23 ? `line-${index}-${'x'.repeat(4096)}` : `line-${index}`
  );
  const frame = lease.prepareAppendFrame({
    slotId,
    contentLines: firstLines,
    finalChunk: false,
    resourcePackets: [],
    createId: (prefix) => `${prefix}-${token}-one`,
  });
  lease.commitAcceptedFrame(frame);
  const acceptedSnapshot = lease.snapshot();
  assertThrows(
    () => lease.prepareAppendFrame({
      slotId,
      contentLines: [],
      finalChunk: true,
      resourcePackets: [],
      createId: (prefix) => `${prefix}-${token}-invalid`,
    }),
    'must not be empty'
  );
  assertEqual(
    JSON.stringify(lease.snapshot()),
    JSON.stringify(acceptedSnapshot),
    'A local logical-chunk repair does not discard previously accepted chunks or advance sequence state'
  );
  const restored = ArtifactDraftLease.restore({
    events: [draftEvent(sessionId, runId, frame)],
    runId,
    sessionId,
    acceptedPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-restore`,
  });
  assert(restored, 'Artifact DraftLease restores a non-terminal accepted Kernel draft');
  assertEqual(restored?.snapshot().nextSequence, 2, 'Artifact DraftLease resumes at the next Kernel sequence');
  assertThrows(
    () => restored?.prepareFinalizeFrame('incomplete', (prefix) => `${prefix}-${token}-incomplete`),
    'incomplete IntentSlot'
  );
  const finalChunk = restored!.prepareAppendFrame({
    slotId,
    contentLines: ['', '第二个逻辑块'],
    finalChunk: true,
    resourcePackets: [],
    createId: (prefix) => `${prefix}-${token}-two`,
  });
  restored!.commitAcceptedFrame(finalChunk);
  const directive = restored!.directive('complete', undefined);
  assertEqual(
    JSON.stringify(directive.artifacts[0]?.contentLines),
    JSON.stringify([...firstLines, '', '第二个逻辑块']),
    'Artifact DraftLease preserves logical chunk order, empty lines, and Unicode'
  );
  const terminal = restored!.prepareFinalizeFrame('complete', (prefix) => `${prefix}-${token}-done`);
  restored!.commitAcceptedFrame(terminal);
  assertEqual(restored!.snapshot().terminal, true, 'Artifact DraftLease becomes terminal only after all slots finalize');

  const budgetPlan = acceptedCreatePlan(`${runId}-budget`, `${token}-budget`);
  const budgetLease = ArtifactDraftLease.create({
    runId: `${runId}-budget`,
    sessionId,
    acceptedPlan: budgetPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-budget`,
  });
  assertThrows(
    () => budgetLease.prepareAppendFrame({
      slotId: firstIntentSlotId(budgetPlan),
      contentLines: ['x'.repeat((384 * 1024) + 1)],
      finalChunk: true,
      resourcePackets: [],
      createId: (prefix) => `${prefix}-${token}-over-budget`,
    }),
    'maximum is 393216'
  );
}

export async function assertArtifactDraftBudgetReplanClearsAcceptedExecution(): Promise<void> {
  const token = randomSmokeToken('artifact-budget-transition');
  const runId = `run-${token}`;
  const acceptedPlan = acceptedCreatePlan(runId, token);
  const state: any = {
    acceptedTaskPlan: acceptedPlan,
    currentTaskContext: { taskId: acceptedPlan.tasks[0]?.taskId },
    taskExecutionCursor: { cursorId: `cursor-${token}` },
    taskLedger: { planId: acceptedPlan.planId },
    acceptedPlanPromptFrame: { planId: acceptedPlan.planId },
    taskLocalCompactRecords: [{ taskId: acceptedPlan.tasks[0]?.taskId }],
    artifactDraftLease: { draftId: `draft-${token}` },
    artifactChunkRepairAttempts: { prior: 1 },
    semanticDirectiveRepairAttempts: { prior: 1 },
    semanticDirectiveRepairAttempted: true,
    semanticDirectiveErrorSummary: `old-error-${token}`,
    pendingSemanticToolCalls: { prior: { callId: `call-${token}` } },
    interactionOverlay: { acceptedPlanId: acceptedPlan.planId },
  };
  let discardCalls = 0;
  const coordinator = new ArtifactDraftReplanCoordinator<any>({
    discard: async (candidate) => {
      discardCalls += 1;
      candidate.artifactDraftLease = undefined;
    },
  });
  const reason = await coordinator.replan(state, `budget-${token}`);
  assertEqual(discardCalls, 1, 'task-level replan discards the active DraftLedger lease exactly once');
  assertEqual(reason.previousPlanId, acceptedPlan.planId, 'task-level replan records the superseded accepted plan');
  assertEqual(reason.previousTaskId, acceptedPlan.tasks[0]?.taskId, 'task-level replan records the oversized task');
  assertEqual(state.acceptedTaskPlan, undefined, 'task-level replan leaves accepted execution mode');
  assertEqual(state.currentTaskContext, undefined, 'task-level replan clears the frozen current task');
  assertEqual(state.taskExecutionCursor, undefined, 'task-level replan clears the prior task cursor');
  assertEqual(state.semanticDirectiveErrorSummary, undefined, 'task-level replan does not masquerade as a same-profile chunk repair');
  assertEqual(state.taskPlanReplanReason.code, 'artifact_draft_budget_exceeded', 'task-level replan preserves a structured planning reason');

  const recovered = recoverArtifactBudgetReplanReason([{
    id: `replan-${token}`,
    sessionId: `session-${token}`,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'workflow_stage',
    payload: {
      stage: 'accepted_plan.replan_required',
      status: 'needsReplan',
      code: 'artifact_draft_budget_exceeded',
      runId,
      previousPlanId: acceptedPlan.planId,
      previousTaskId: acceptedPlan.tasks[0]?.taskId,
      message: `budget-${token}`,
    },
  }], runId, acceptedPlan.planId);
  assertEqual(recovered?.previousPlanId, acceptedPlan.planId, 'resume suppresses only the superseded accepted plan recorded by the replan fact');
  assertEqual(
    recoverArtifactBudgetReplanReason([], runId, acceptedPlan.planId),
    undefined,
    'resume keeps an accepted plan when no matching replan fact exists'
  );
}

export function assertArtifactDraftPreciseEditMatches(): void {
  const token = randomSmokeToken('artifact-edit-match');
  const targetPath = `existing-${token}.txt`;
  const content = 'alpha\nbeta\ngamma\n';
  const contentHash = `sha256:${token}`;
  const packet = textResourcePacket(token, targetPath, content, contentHash);
  let sequence = 0;

  const exactPlan = acceptedPatchPlan(`run-${token}-exact`, `${token}-exact`, targetPath);
  const exactLease = ArtifactDraftLease.create({
    runId: `run-${token}-exact`,
    sessionId: `session-${token}`,
    acceptedPlan: exactPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  const exactSlotId = firstIntentSlotId(exactPlan);
  const exactFrame = exactLease.prepareAppendFrame({
    slotId: exactSlotId,
    contentLines: ['replacement'],
    finalChunk: true,
    editMatch: { kind: 'exactBlock', targetLines: ['beta'] },
    resourcePackets: [packet],
    createId: (prefix) => `${prefix}-${token}-exact`,
  });
  assertEqual(
    exactFrame.contentHash,
    'fnv1a64:6cc00e4f2c73ebd1',
    'Exact editMatch uses the cross-language DraftLedger hash vector'
  );
  exactLease.commitAcceptedFrame(exactFrame);
  const exactProposal = new OperationIntentCompiler().compileArtifacts({
    sessionId: `session-${token}`,
    runId: `run-${token}-exact`,
    callId: `call-${token}-exact`,
    acceptedPlan: exactPlan,
    directive: exactLease.directive('Apply the accepted precise edit.', undefined),
  });
  assertEqual(
    JSON.stringify((((exactProposal.payload as any).actionBundle.actions[0].args.patchSpec.match))),
    JSON.stringify({ kind: 'exactBlock', text: 'beta' }),
    'Exact editMatch compiles to the accepted fs.edit operation without whole-file matching'
  );

  const contextPlan = acceptedPatchPlan(`run-${token}-context`, `${token}-context`, targetPath);
  const contextLease = ArtifactDraftLease.create({
    runId: `run-${token}-context`,
    sessionId: `session-${token}`,
    acceptedPlan: contextPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  const contextFrame = contextLease.prepareAppendFrame({
    slotId: firstIntentSlotId(contextPlan),
    contentLines: ['replacement'],
    finalChunk: true,
    editMatch: {
      kind: 'contextBlock',
      beforeLines: ['alpha'],
      targetLines: ['beta'],
      afterLines: ['gamma'],
    },
    resourcePackets: [packet],
    createId: (prefix) => `${prefix}-${token}-context`,
  });
  contextLease.commitAcceptedFrame(contextFrame);
  const contextProposal = new OperationIntentCompiler().compileArtifacts({
    sessionId: `session-${token}`,
    runId: `run-${token}-context`,
    callId: `call-${token}-context`,
    acceptedPlan: contextPlan,
    directive: contextLease.directive('Apply the accepted contextual edit.', undefined),
  });
  assertEqual(
    JSON.stringify((((contextProposal.payload as any).actionBundle.actions[0].args.patchSpec.match))),
    JSON.stringify({ kind: 'contextBlock', before: 'alpha\n', target: 'beta', after: '\ngamma' }),
    'Context editMatch compiles its before, target, and after boundaries without widening to a full-file rewrite'
  );

  const linePlan = acceptedPatchPlan(`run-${token}-line`, `${token}-line`, targetPath);
  const lineLease = ArtifactDraftLease.create({
    runId: `run-${token}-line`,
    sessionId: `session-${token}`,
    acceptedPlan: linePlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  const lineFrame = lineLease.prepareAppendFrame({
    slotId: firstIntentSlotId(linePlan),
    contentLines: ['replacement'],
    finalChunk: true,
    editMatch: {
      kind: 'lineRange',
      startLine: 2,
      endLine: 2,
      expectedBeforeLines: ['beta'],
    },
    resourcePackets: [packet],
    createId: (prefix) => `${prefix}-${token}-line`,
  });
  assertEqual(
    (lineFrame as any).editMatch?.expectedBeforeText,
    'beta\n',
    'Line-range editMatch binds the exact newline-preserving ResourcePacket text'
  );
  assertEqual(
    lineFrame.contentHash,
    'fnv1a64:d21b3d8f9280a0fa',
    'Line-range editMatch uses the cross-language DraftLedger hash vector'
  );
  lineLease.commitAcceptedFrame(lineFrame);
  const lineProposal = new OperationIntentCompiler().compileArtifacts({
    sessionId: `session-${token}`,
    runId: `run-${token}-line`,
    callId: `call-${token}-line`,
    acceptedPlan: linePlan,
    directive: lineLease.directive('Apply the accepted line-range edit.', undefined),
  });
  assertEqual(
    JSON.stringify((((lineProposal.payload as any).actionBundle.actions[0].args.patchSpec.match))),
    JSON.stringify({ kind: 'lineRange', startLine: 2, endLine: 2, expectedBeforeBlock: 'beta\n' }),
    'Line-range editMatch compiles the newline-preserving expected block from fresh evidence'
  );

  const duplicatePacket = textResourcePacket(token, targetPath, 'beta\nbeta\n', contentHash);
  const duplicatePlan = acceptedPatchPlan(`run-${token}-duplicate`, `${token}-duplicate`, targetPath);
  const duplicateLease = ArtifactDraftLease.create({
    runId: `run-${token}-duplicate`,
    sessionId: `session-${token}`,
    acceptedPlan: duplicatePlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  assertThrows(
    () => duplicateLease.prepareAppendFrame({
      slotId: firstIntentSlotId(duplicatePlan),
      contentLines: ['replacement'],
      finalChunk: true,
      editMatch: { kind: 'exactBlock', targetLines: ['beta'] },
      resourcePackets: [duplicatePacket],
      createId: (prefix) => `${prefix}-${token}-duplicate`,
    }),
    'must occur exactly once'
  );

  const missingPlan = acceptedPatchPlan(`run-${token}-missing`, `${token}-missing`, targetPath);
  const missingLease = ArtifactDraftLease.create({
    runId: `run-${token}-missing`,
    sessionId: `session-${token}`,
    acceptedPlan: missingPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  assertThrows(
    () => missingLease.prepareAppendFrame({
      slotId: firstIntentSlotId(missingPlan),
      contentLines: ['replacement'],
      finalChunk: true,
      editMatch: { kind: 'exactBlock', targetLines: ['not-present'] },
      resourcePackets: [packet],
      createId: (prefix) => `${prefix}-${token}-missing`,
    }),
    'must occur exactly once'
  );

  const staleHashPlan = acceptedPatchPlan(`run-${token}-stale-hash`, `${token}-stale-hash`, targetPath);
  const staleHashLease = ArtifactDraftLease.create({
    runId: `run-${token}-stale-hash`,
    sessionId: `session-${token}`,
    acceptedPlan: staleHashPlan,
    maxTotalUtf8Bytes: 384 * 1024,
    createId: (prefix) => `${prefix}-${token}-${++sequence}`,
  });
  assertThrows(
    () => staleHashLease.prepareAppendFrame({
      slotId: firstIntentSlotId(staleHashPlan),
      contentLines: ['replacement'],
      finalChunk: true,
      editMatch: {
        kind: 'lineRange',
        startLine: 2,
        endLine: 2,
        expectedFileHash: `stale-${token}`,
      },
      resourcePackets: [packet],
      createId: (prefix) => `${prefix}-${token}-stale-hash`,
    }),
    'expectedFileHash does not match'
  );
}

function kernelContextEvent(sessionId: string, runId: string, catalogHash: string): AgentEvent {
  return {
    id: `${runId}-${catalogHash}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'workflow_stage',
    payload: {
      kernelEvent: {
        kind: 'state.entered',
        runId,
        sessionId,
        stateContract: {
          runId,
          sessionId,
          stateId: 'needProposal',
          toolCatalogSnapshot: {
            catalogVersion: 'deepcode.kernel.tools.v3',
            catalogHash,
            tools: [],
          },
        },
      },
    },
  };
}

function userEvent(id: string, sessionId: string, content: string): AgentEvent {
  return {
    id,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: { content },
  };
}

function firstIntentSlotId(plan: AcceptedTaskPlanContext): string {
  const slot = new IntentSlotRegistry().currentTaskSlots(plan)[0];
  if (!slot) throw new Error(`Expected one Kernel-authorized IntentSlot for plan ${plan.planId}.`);
  return slot.slotId;
}

function acceptedCreatePlan(runId: string, token: string): AcceptedTaskPlanContext {
  const taskId = `task-${token}`;
  const targetPath = `generated-${token}.txt`;
  return {
    planId: `plan-${token}`,
    runId,
    tasks: [{
      taskId,
      title: `Create ${token}`,
      toolId: 'fs.create',
      targets: [targetPath],
      dependencies: [],
      planningArgs: {},
      conflictKeys: [targetPath],
    }],
    authorizationOperations: [{
      operationId: `plan-op-${taskId}-1`,
      sourceTaskId: taskId,
      toolId: 'fs.create',
      operationKind: 'fsCreate',
      contentMode: 'contentBlock',
      targets: [targetPath],
      dependsOn: [],
      fixedArgs: { executable: false },
      argsTemplate: { path: targetPath, contentBlockId: 'executionTime' },
      targetResourceKind: 'file',
      recursive: false,
      internal: false,
    }],
    toolIds: ['fs.create'],
    targetScopes: [targetPath],
    batchIndex: 1,
    completedTaskIds: [],
    dependencyFacts: [],
    rawPlan: {},
  };
}

function acceptedPatchPlan(runId: string, token: string, targetPath: string): AcceptedTaskPlanContext {
  const taskId = `task-${token}`;
  return {
    planId: `plan-${token}`,
    runId,
    tasks: [{
      taskId,
      title: `Edit ${token}`,
      toolId: 'fs.edit',
      targets: [targetPath],
      dependencies: [],
      planningArgs: {},
      conflictKeys: [targetPath],
    }],
    authorizationOperations: [{
      operationId: `plan-op-${taskId}-1`,
      sourceTaskId: taskId,
      toolId: 'fs.edit',
      operationKind: 'fsEdit',
      contentMode: 'replacementBlock',
      targets: [targetPath],
      dependsOn: [],
      fixedArgs: {},
      argsTemplate: { path: targetPath, replacementBlockId: 'executionTime' },
      targetResourceKind: 'file',
      recursive: false,
      internal: false,
    }],
    toolIds: ['fs.edit'],
    targetScopes: [targetPath],
    batchIndex: 1,
    completedTaskIds: [],
    dependencyFacts: [],
    rawPlan: {},
  };
}

function textResourcePacket(
  token: string,
  path: string,
  content: string,
  contentHash: string
): ResourcePacket {
  return {
    id: `packet-${token}-${path}`,
    requestId: `request-${token}-${path}`,
    workspaceScopeKey: `scope-${token}`,
    items: [{
      requestItemId: `item-${token}-${path}`,
      manifestEntryId: `root-${token}`,
      readPolicy: 'autoRead',
      status: 'resolved',
      path,
      absolutePath: `/workspace/${path}`,
      contentKind: 'fileText',
      resolvedKind: 'file',
      contentHash,
      truncated: false,
      rangeComplete: true,
      promptContent: content,
    }],
  };
}

function draftEvent(
  sessionId: string,
  runId: string,
  frame: KernelArtifactDraftLedgerFrame
): AgentEvent {
  return {
    id: `draft-event-${frame.frameId}`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'workflow_stage',
    payload: {
      kernelEvent: {
        kind: 'draft.chunk',
        runId,
        sessionId,
        draft: { frame },
      },
    },
  };
}
