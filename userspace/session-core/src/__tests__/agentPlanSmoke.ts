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
  agentConfigurableSettingsIndex,
  agentSettingsIndex,
  shellPreferenceSettingsIndex,
  workspaceOverridableSettingsIndex,
} from '@deepcode/protocol';
import {
  applyProviderCacheStrategy,
  assembleContext,
  buildNarrativeTimelineProjection,
  buildPromptEnvelope,
  buildResourcePromptContext,
  buildSessionMemoryDocument,
  buildSessionTaskGraph,
  collectUserGuidanceEvents,
  createResourcePacket,
  findLatestPendingPermission,
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
  assertContextAssemblerCachePlan();
  assertResourcePromptBlocksStabilize();
  assertSessionMemoryDocument();
  assertSessionTaskGraphProjection();
  assertDeepSeekCacheStrategyDoesNotInjectRequestParameter();
  await assertProviderCacheTelemetryNormalizesBigModelUsage();
  await assertProviderTraceArchiveCompactsStreamingChunks();
  await assertProviderPartFramesEnterKernelDraftLedger();
  assertSettingsCatalogBoundaries();
  assertNarrativeTimelineProjection();
  assertImplementationPlanTaskProjectionProgress();
  assertSessionDriverSkeleton();
  await assertSessionDriverLoop();
  await assertSessionDriverLoopTerminalAnswerGuidanceRevision();
  await assertSessionDriverLoopTerminalGuidanceRevisionFallback();
  await assertSessionDriverLoopPathResourceRequest();
  await assertSessionDriverLoopSearchResourceRequest();
  await assertSessionDriverLoopRejectsOutsidePath();
  await assertSessionDriverLoopUsesRecentAttachmentRoot();
  await assertSessionDriverLoopReadOnlyRequestsContinueWithoutBudgetDecision();
  await assertSessionDriverLoopOldResourceBudgetDecisionStillResumes();
  await assertSessionDriverLoopProjectsDecisionRequest();
  await assertSessionDriverLoopRepairsSideEffectBundleEvidence();
  await assertSessionDriverLoopRepairsInvalidSourceBlock();
  await assertSessionDriverLoopRepairsOversizedActionBundle();
  await assertSessionDriverLoopRepairsEmptyActionBundleResponse();
  await assertSessionDriverLoopAcceptsLocalizedStructuredPlan();
  await assertSessionDriverLoopPlanCardAcceptDoesNotNoopWithoutPlanReview();
  await assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesBatch();
  await assertSessionDriverLoopAcceptedImplementationPlanNormalizesWriteBatchForKernel();
  await assertSessionDriverLoopAcceptedImplementationPlanPreservesExecutionRoot();
  await assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesMultiTargetBatch();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsMergeIndependentTasks();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsDiscardFailedBranchAndFallback();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsTreatLegacyDependenciesAsSoftOrder();
  await assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSkipHardDependency();
  await assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesDeleteAction();
  await assertSessionDriverLoopAcceptedImplementationPlanRejectsDeleteRootTarget();
  await assertSessionDriverLoopAcceptedImplementationPlanContinuesUntilTasksComplete();
  await assertSessionDriverLoopAcceptedImplementationPlanAllowsPlannedProcessExecPermissionGate();
  await assertSessionDriverLoopAcceptedImplementationPlanAllowsAbsoluteAttachmentChildTarget();
  await assertSessionDriverLoopAcceptedImplementationPlanRejectsAttachmentRootTarget();
  await assertSessionDriverLoopAcceptedImplementationPlanProjectsWorkUnitFailureReason();
  await assertSessionDriverLoopAcceptedImplementationPlanRejectsOutOfScopeBatch();
  await assertSessionDriverLoopAcceptedPlanPatchRequestsSearchEvidence();
  await assertSessionDriverLoopPlanAcceptGroupsWorkspaceWriteGrants();
  assertWorkflowStagePermissionProjectsPendingDecision();
  await assertSessionDriverLoopReviewRevisionReturnsToPlanning();
  await assertSessionDriverLoopReviewRevisionContinuesWhenAuditRunInactive();
  await assertSessionDriverLoopReviewAcceptAutoGeneratesNextPlan();
  await assertSessionDriverLoopReviewAcceptWithoutContinuationCompletesRun();
  await assertSessionDriverLoopReviewAcceptOffStopsAtCurrentBatch();
  await assertSessionDriverLoopRequirementRejectCancelsRun();
  await assertSessionDriverLoopPlanRejectCancelsRun();
  await assertSessionDriverLoopReviewRejectCancelsRun();
  await assertSessionDriverLoopPermissionRejectCancelsRun();
  await assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept();
  await assertSessionDriverLoopNativeReadToolStreamsThroughResourceResolve();
  await assertSessionDriverLoopNativeReadToolLoopHasNoFourRoundLimit();
  await assertSessionDriverLoopNativeWriteToolTriggersImplementationPlanRepair();
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
  const confirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  const confirmationPayload = confirmation?.payload as Record<string, unknown> | undefined;
  assertEqual(
    String(confirmationPayload?.content ?? '').includes('## Options'),
    true,
    'decisionRequest renders as an option selection card'
  );
  assertEqual(
    JSON.stringify((confirmationPayload?.requirement as any)?.checklist?.explicitTasks ?? []).includes('Proceed'),
    false,
    'decisionRequest options are not copied into requirement checklist tasks'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'decisionRequest does not generate a plan before user decision');
}

function assertV3Parser(): void {
  const answer = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'answer',
      narration: 'This narration is ignored for final answer rendering.',
      outputLanguage: 'en-US',
      answer: { format: 'markdown', content: 'Generic answer.' },
    }),
  });
  assertEqual(answer.kind, 'answer', 'v3 answer parses');
  assertEqual(answer.runId, 'run-generic', 'v3 parser binds run id');
  assertEqual(answer.narration, 'This narration is ignored for final answer rendering.', 'v3 parser preserves optional narration');

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
  const resourcePayload = resourceRequest.payload as any;
  assertEqual(resourcePayload.items[0].path, 'src/generic.txt', 'v3 resourceRequest keeps root-relative path');

  const rangedResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-range',
        reason: 'Need a generic file segment.',
        items: [{ id: 'range-item', rootId: 'root-generic', path: 'src/generic.txt', offsetBytes: 12000, limitBytes: 6000, reason: 'Read a later generic segment.' }],
      },
    }),
  });
  const rangedPayload = rangedResourceRequest.payload as any;
  assertEqual(rangedPayload.items[0].offsetBytes, 12000, 'v3 resourceRequest preserves offsetBytes');
  assertEqual(rangedPayload.items[0].limitBytes, 6000, 'v3 resourceRequest preserves limitBytes');

  const searchResourceRequest = parseProposalEnvelope({
    runId: 'run-generic',
    sessionId: 'session-generic',
    raw: JSON.stringify({
      schemaVersion: 'deepcode.agent.protocol.v3',
      kind: 'resourceRequest',
      outputLanguage: 'en-US',
      resourceRequest: {
        version: '1',
        id: 'request-generic-search',
        reason: 'Need generic search evidence.',
        items: [{
          id: 'search-item',
          kind: 'search',
          rootId: 'root-generic',
          query: 'generic anchor',
          include: ['src/'],
          contextLines: 2,
          maxResults: 25,
          reason: 'Find generic edit anchor.',
        }],
      },
    }),
  });
  const searchPayload = searchResourceRequest.payload as any;
  assertEqual(searchPayload.items[0].kind, 'search', 'v3 resourceRequest search item parses');
  assertEqual(searchPayload.items[0].query, 'generic anchor', 'v3 resourceRequest preserves search query');
  assertEqual(searchPayload.items[0].include[0], 'src/', 'v3 resourceRequest preserves include filter');
  assertEqual(searchPayload.items[0].contextLines, 2, 'v3 resourceRequest preserves contextLines');
  assertEqual(searchPayload.items[0].maxResults, 25, 'v3 resourceRequest preserves maxResults');

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
  }), 'manifestEntryId, path, or kind="search"');
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
  packet.items[0].truncated = true;
  packet.items[0].originalBytes = 24000;
  const initialContext = {
    id: 'initial-generic',
    workspaceScopeKey: manifest.workspaceScopeKey,
    manifest,
  };
  const conversationRoots = [{
    rootId: 'attachment-0-generic-file',
    kind: 'directory' as const,
    label: 'Directory generic',
    displayPath: 'generic',
    absolutePath: '/tmp/generic',
    source: 'currentAttachment' as const,
    primary: true,
  }];
  const resourcePromptContext = buildResourcePromptContext({
    initialContext,
    conversationRoots,
    resourcePackets: [packet],
  });

  const prompt = buildPromptEnvelope({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
    capabilityCatalogSummary: 'workspace.read\nworkspace.write',
    memoryHints: ['Recent user turn: generic request attachments=file:generic/file.txt'],
    userRequest: 'Analyze the attached resource.',
    initialContext,
    conversationRoots,
    resourcePromptContext,
  });
  assert(prompt.stablePrefix.includes('deepcode.agent.protocol.v3'), 'prompt enforces v3');
  assert(prompt.dynamicSuffix.includes('manifestEntry id=attachment-0-generic-file'), 'prompt exposes manifest entry ids');
  assert(prompt.dynamicSuffix.includes('Conversation roots'), 'prompt exposes conversation roots');
  assert(prompt.dynamicSuffix.includes('primary=true'), 'prompt marks the primary conversation root');
  assert(prompt.dynamicSuffix.includes('Primary conversation workspace root'), 'prompt exposes the primary workspace root');
  assert(prompt.dynamicSuffix.includes('targetPath/codeBlocks targetPath must be relative to the primary root'), 'prompt tells the model to avoid root-prefixed write paths');
  assert(prompt.stablePrefix.includes('"path":"relative/path.ext"'), 'prompt documents path-based resourceRequest');
  assert(prompt.stablePrefix.includes('optional top-level narration'), 'prompt documents model-generated narration');
  assert(prompt.stablePrefix.includes('Implementation batch budget'), 'prompt documents incremental implementation budget');
  assert(prompt.stablePrefix.includes('<systemStructure'), 'prompt includes the system structure layer');
  assert(prompt.stablePrefix.includes('black-box validation'), 'prompt treats tests as black-box validation');
  assert(prompt.stablePrefix.includes('Do not optimize for known tests'), 'prompt rejects test-specific optimization');
  assert(prompt.stablePrefix.includes('fixed prompts'), 'prompt forbids fixed prompt special-casing');
  assert(prompt.stablePrefix.includes('keyword branches'), 'prompt forbids keyword branches');
  assert(prompt.stablePrefix.includes('tokenizer branches'), 'prompt forbids tokenizer-specific branches');
  assert(prompt.stablePrefix.includes('example-specific branches'), 'prompt forbids example-specific logic');
  assert(prompt.stablePrefix.includes('<protectedStablePrefix'), 'prompt starts with explicit protected stable prefix boundary');
  assert(prompt.stableLayerNames[0] === 'protectedStablePrefix', 'protected stable prefix is the first stable layer');
  assert(!prompt.stablePrefix.includes('Current workflow state'), 'stable prefix excludes current workflow state');
  assert(!prompt.stablePrefix.includes('Recent user turn'), 'stable prefix excludes session-local memory hints');
  assert(prompt.dynamicSuffix.includes('Current workflow state: needProposal'), 'dynamic suffix carries current workflow state');
  assert(prompt.dynamicSuffix.includes('Allowed proposals: answer, resourceRequest, actionBundle'), 'dynamic suffix carries allowed proposals');
  assert(prompt.dynamicSuffix.includes('workspace.read'), 'dynamic suffix carries capability projection');
  assert(prompt.dynamicLayerNames.includes('projectMemory'), 'project memory is an explicit dynamic context partition');
  assert(prompt.dynamicLayerNames.includes('sessionMemory'), 'session memory is an explicit dynamic context partition');
  assert(prompt.dynamicLayerNames.includes('reusableResourceContext'), 'reusable resource context is separated from current request');
  assert(prompt.dynamicSuffix.includes('blockKey='), 'prompt includes stable resource block keys');
  assert(prompt.dynamicSuffix.includes('generic content'), 'prompt includes ResourcePacket content');
  assert(!prompt.dynamicSuffix.includes('evidence-generic'), 'prompt excludes volatile evidence refs from provider-visible resource context');
  assert(!prompt.dynamicSuffix.includes('Read-only resource budget:'), 'prompt does not expose fixed read-only resource budget');
  assert(prompt.dynamicSuffix.includes('not governed by a fixed Session round budget'), 'prompt explains read-only requests are user-controlled');
  assert(prompt.dynamicSuffix.includes('offsetBytes/limitBytes'), 'prompt hints range reread for truncated resources');
  assert(!prompt.dynamicSuffix.includes('auditOnlyContext'), 'audit-only context is not in dynamic suffix');
}

function assertSettingsCatalogBoundaries(): void {
  const sharedAgentKeys = new Set(agentSettingsIndex().map((entry) => entry.key));
  const guiPreferenceKeys = new Set(shellPreferenceSettingsIndex('gui').map((entry) => entry.key));
  const editorPreferenceKeys = new Set(shellPreferenceSettingsIndex('editor').map((entry) => entry.key));
  const workspaceKeys = new Set(workspaceOverridableSettingsIndex().map((entry) => entry.key));
  const agentConfigurableKeys = new Set(agentConfigurableSettingsIndex().map((entry) => entry.key));

  assertEqual(sharedAgentKeys.has('agent.permissions.gitPush'), true, 'Git push policy is a shared Agent setting');
  assertEqual(agentConfigurableKeys.has('agent.permissions.gitPush'), true, 'Agent can request shared Agent setting changes through audited config flow');
  assertEqual(guiPreferenceKeys.has('gui.colorTheme'), true, 'GUI preferences use the gui namespace');
  assertEqual(guiPreferenceKeys.has('workbench.colorTheme'), false, 'GUI preference index does not include editor workbench theme');
  assertEqual(editorPreferenceKeys.has('gui.colorTheme'), false, 'Editor preference index does not include GUI theme');
  assertEqual(workspaceKeys.has('agent.permissions.gitPush'), false, 'workspace overrides cannot change Agent security gates');
  assertEqual(workspaceKeys.has('ruler.rules'), true, 'workspace overrides may provide project-level Ruler additions');
}

function assertContextAssemblerCachePlan(): void {
  const manifest: ResourceManifest = {
    id: 'manifest-cache-generic',
    workspaceScopeKey: 'workspace-cache-generic',
    entries: [],
    budget: { maxEntries: 8, maxBytes: 8192 },
    defaultDenyPatterns: [],
  };
  const memoryDocument = buildSessionMemoryDocument([
    {
      id: 'memory-user',
      sessionId: 'session-cache',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze reusable context.' },
    },
  ]);
  const base = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'workspace.read',
    userRequest: 'Summarize the reusable context.',
    memoryDocument,
    initialContext: {
      id: 'initial-cache-generic',
      workspaceScopeKey: manifest.workspaceScopeKey,
      manifest,
    },
    userGuidance: [{
      id: 'guidance-generic',
      content: 'Prefer a concise continuation and keep already observed facts unchanged.',
      source: 'user',
      checkpointKind: 'nextProviderCall',
    }],
    profile: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    templateVersion: 'cache-plan-test',
  });
  const followUp = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'workspace.read',
    userRequest: 'Answer a follow-up from the same reusable context.',
    memoryDocument,
    initialContext: {
      id: 'initial-cache-generic',
      workspaceScopeKey: manifest.workspaceScopeKey,
      manifest,
    },
    profile: {
      provider: 'deepseek',
      model: 'deepseek-chat',
    },
    templateVersion: 'cache-plan-test',
  });

  assertEqual(base.cachePlan.deepseekPrefixCache.requestParameterRequired, false, 'DeepSeek cache plan does not require request parameters');
  assertEqual(base.cachePlan.cacheAffectsCorrectness, false, 'cache plan is observability only');
  assertEqual(base.cachePlan.contextAssemblyId, base.contextAssembly.contextAssemblyId, 'cache plan references the context assembly');
  assertEqual(base.cachePlan.stablePrefixHash, followUp.cachePlan.stablePrefixHash, 'same stable layers keep stable prefix hash');
  assert(base.cachePlan.dynamicSuffixHash !== followUp.cachePlan.dynamicSuffixHash, 'current request changes dynamic suffix hash');
  assert(base.cachePlan.cacheHash !== followUp.cachePlan.cacheHash, 'overall cache hash changes with the dynamic suffix');
  assert(!base.prompt.stablePrefix.includes('Summarize the reusable context.'), 'stable prefix excludes current user request');
  assert(base.prompt.dynamicSuffix.includes('Summarize the reusable context.'), 'dynamic suffix carries current user request');
  assert(base.prompt.dynamicSuffix.includes('Prefer a concise continuation'), 'user guidance enters the dynamic suffix');
  assertEqual(base.contextAssembly.userGuidanceCount, 1, 'context assembly records provider-checkpoint user guidance count');
  assertEqual(base.contextAssembly.consumedUserGuidanceIds[0], 'guidance-generic', 'context assembly records consumed user guidance ids');
  assertEqual(base.contextAssembly.schemaVersion, 'deepcode.session.context-assembly.v3', 'context assembly records v3 partitioned cache debug schema');
  assertEqual(base.contextAssembly.cacheAffectsCorrectness, false, 'context assembly cache telemetry is observability only');
  assertEqual(base.contextAssembly.budgetPlan.contextWindowTokens, 1_000_000, 'context assembly records 1M soft context budget');
  assertEqual(base.contextAssembly.budgetPlan.maxOutputTokens, 384_000, 'context assembly records 384K output reserve');
  assertEqual(base.contextAssembly.budgetPlan.projectMemoryBudgetTokens, 128_000, 'context assembly records 128K project memory soft cap');
  assertEqual(base.contextAssembly.budgetPlan.sessionMemoryBudgetTokens, 256_000, 'context assembly records 256K session memory soft cap');
  assertEqual(base.contextAssembly.traceArchiveMode, 'compact-provider-trace', 'context assembly records compact trace archive mode');
  assertEqual(base.contextAssembly.resourceBlocks.length, 0, 'simple chat path has no resource blocks');
  assertEqual(base.contextAssembly.resourceFullTextCharCount, 0, 'simple chat path has no full resource text');
  assertEqual(base.contextAssembly.resourceEvidenceTailCount, 0, 'simple chat path has no resource evidence tail entries');
  assert(base.contextAssembly.partitionCharCounts.protectedPrefix > 0, 'context assembly records protected prefix partition');
  assert(base.contextAssembly.partitionCharCounts.projectMemory > 0, 'context assembly records project memory partition');
  assert(base.contextAssembly.partitionCharCounts.sessionMemory > 0, 'context assembly records session memory partition');
  assert(base.contextAssembly.partitionCharCounts.intentMemory > 0, 'context assembly records intent/memory partition');
  assert(base.contextAssembly.segments.find((segment) => segment.name === 'reusableResourceContext')?.charLength ?? 0 < 1200, 'empty resource context stays small');
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.cacheClass === 'globalStable' && segment.stablePrefix),
    true,
    'context assembly records stable protocol segments'
  );
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.cacheClass === 'reusableResource' && segment.name === 'reusableResourceContext'),
    true,
    'context assembly records reusable resource segment'
  );
  const reusableIndex = base.prompt.dynamicLayerNames.indexOf('reusableResourceContext');
  const requirementIndex = base.prompt.dynamicLayerNames.indexOf('currentRequirement');
  const currentResourceIndex = base.prompt.dynamicLayerNames.indexOf('currentResourceResults');
  assert(reusableIndex > requirementIndex, 'reusable resource evidence appears after current request in the dynamic suffix');
  assert(currentResourceIndex > reusableIndex, 'current resource policy and tool results remain at the evidence tail');
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.auditOnly && segment.cacheClass === 'auditOnly'),
    true,
    'audit-only segment is tracked separately from cache prefix'
  );
}

function assertResourcePromptBlocksStabilize(): void {
  const alphaMiddleMarker = 'ALPHA_MIDDLE_SHOULD_NOT_REPEAT_AFTER_SUMMARY';
  const alphaContent = `${'alpha-head '.repeat(90)}${alphaMiddleMarker}${' alpha-tail'.repeat(90)}`;
  const betaContent = 'beta current resource content';
  const manifest: ResourceManifest = {
    id: 'manifest-resource-blocks',
    workspaceScopeKey: 'workspace-resource-blocks',
    entries: [
      {
        id: 'alpha-file',
        kind: 'file',
        label: 'File src/alpha.txt',
        resourceRef: 'src/alpha.txt',
        readPolicy: 'autoRead',
        reason: 'Generic prior file.',
      },
      {
        id: 'beta-file',
        kind: 'file',
        label: 'File src/beta.txt',
        resourceRef: 'src/beta.txt',
        readPolicy: 'autoRead',
        reason: 'Generic current file.',
      },
    ],
    budget: { maxEntries: 8, maxBytes: 64000 },
    defaultDenyPatterns: [],
  };
  const initialContext = {
    id: 'initial-resource-blocks',
    workspaceScopeKey: manifest.workspaceScopeKey,
    manifest,
  };
  const alphaPacket = createResourcePacket({
    packetId: 'packet-alpha-volatile',
    manifest,
    request: {
      id: 'request-alpha-volatile',
      items: [{ id: 'item-alpha', manifestEntryId: 'alpha-file', reason: 'Read alpha.' }],
    },
    kernelEvidence: {
      'alpha-file': {
        contentKind: 'fileText',
        promptContent: alphaContent,
        evidenceRefs: ['volatile-evidence-alpha'],
      },
    },
  });
  const betaPacket = createResourcePacket({
    packetId: 'packet-beta-volatile',
    manifest,
    request: {
      id: 'request-beta-volatile',
      items: [{ id: 'item-beta', manifestEntryId: 'beta-file', reason: 'Read beta.' }],
    },
    kernelEvidence: {
      'beta-file': {
        contentKind: 'fileText',
        promptContent: betaContent,
        evidenceRefs: ['volatile-evidence-beta'],
      },
    },
  });

  const first = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'workspace.read',
    userRequest: 'Analyze alpha.',
    initialContext,
    resourcePackets: [alphaPacket],
    profile: { provider: 'deepseek', model: 'deepseek-chat' },
    templateVersion: 'resource-block-test',
  });
  const second = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    capabilityCatalogSummary: 'workspace.read',
    userRequest: 'Analyze beta with prior alpha context.',
    initialContext,
    resourcePackets: [alphaPacket, betaPacket],
    profile: { provider: 'deepseek', model: 'deepseek-chat' },
    templateVersion: 'resource-block-test',
  });

  const firstAlpha = first.contextAssembly.resourceBlocks.find((block) => block.displayRef === 'src/alpha.txt');
  const secondAlpha = second.contextAssembly.resourceBlocks.find((block) => block.displayRef === 'src/alpha.txt');
  const secondBeta = second.contextAssembly.resourceBlocks.find((block) => block.displayRef === 'src/beta.txt');
  assert(firstAlpha, 'first alpha block exists');
  assert(secondAlpha, 'second alpha block exists');
  assert(secondBeta, 'second beta block exists');
  if (!firstAlpha || !secondAlpha || !secondBeta) throw new Error('resource block test setup failed');
  assertEqual(firstAlpha.blockKey, secondAlpha.blockKey, 'old resource block keeps stable key across later packets');
  assertEqual(firstAlpha.contentHash, secondAlpha.contentHash, 'old resource block keeps stable content hash across later packets');
  assertEqual(firstAlpha.retention, 'full', 'latest small resource can be full text');
  assertEqual(secondAlpha.retention, 'summary', 'old resource is downgraded to summary after a newer packet');
  assertEqual(secondBeta.retention, 'full', 'new current small resource remains full text');
  assertEqual(secondAlpha.volatileFieldStripped, true, 'resource block records volatile field stripping');
  assert(second.prompt.dynamicSuffix.includes(betaContent), 'current resource full text remains available');
  assert(!second.prompt.dynamicSuffix.includes(alphaMiddleMarker), 'old resource middle content is not repeatedly carried after summary downgrade');
  assert(!second.prompt.dynamicSuffix.includes('volatile-evidence-alpha'), 'volatile evidence refs are not provider-visible');
  assert(!second.prompt.dynamicSuffix.includes('packet-alpha-volatile'), 'volatile packet ids are not provider-visible');
  assert(second.contextAssembly.resourceFullTextCharCount < first.contextAssembly.resourceFullTextCharCount + betaContent.length, 'full resource text budget does not grow by repeating old full text');
}

function assertSessionMemoryDocument(): void {
  const document = buildSessionMemoryDocument([
    {
      id: 'memory-user',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: {
        content: 'Analyze a generic attachment.',
        attachments: [{ kind: 'directory', path: 'generic-attachment', scope: 'message' }],
      },
    },
    {
      id: 'memory-plan',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'plan_card',
      payload: { summary: 'Read a generic overview before proposing changes.' },
    },
    {
      id: 'memory-tool',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_result',
      payload: {
        toolName: 'fs.read',
        summary: 'Read a generic source file.',
        output: {
          items: [{
            manifestEntryId: 'entry-generic',
            contentKind: 'fileText',
            absolutePath: '/tmp/generic/source.txt',
          }],
        },
      },
    },
    {
      id: 'memory-review',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'review_summary',
      payload: {
        status: 'accepted',
        content: 'The generic batch is accepted.',
        facts: ['Kernel recorded the generic write fact.'],
      },
    },
    {
      id: 'memory-answer',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'assistant_msg',
      payload: {
        channel: 'final',
        content: 'A long generic final answer that should be summarized as short-term continuity rather than stable execution fact.',
      },
    },
  ]);

  assertEqual(document.schemaVersion, '3', 'memory document is versioned');
  assert(document.intentContext.some((item) => item.includes('User request')), 'memory records user intent');
  assert(document.intentContext.some((item) => item.includes('Plan intent')), 'memory records plan intent as intent context');
  assert(document.factContext.some((item) => item.includes('Resource/tool fact fs.read')), 'memory records tool summaries as facts');
  assert(document.factContext.some((item) => item.includes('ResourcePacket fact')), 'memory records resource packet facts');
  assert(document.factContext.some((item) => item.includes('Review fact')), 'memory records review facts');
  assert(document.decisionContext.some((item) => item.includes('Review decision: accepted')), 'memory records review decisions');
  assert(document.resourceContext.some((item) => item.includes('Attached resource')), 'memory records reusable attachment facts');
  assert(document.longTermContext.some((item) => item.includes('Attached resource')), 'stable memory records reusable attachment facts');
  assert(document.shortTermContext.some((item) => item.includes('Plan intent')), 'short-term memory records active planning intent');
  assert(document.projectMemoryContext.some((item) => item.includes('Project resource index')), 'project memory records reusable project resource indexes');
  assert(document.sessionMemoryContext.some((item) => item.includes('Session intent')), 'session memory records active session intent');
  assert(document.shortTermContext.some((item) => item.includes('Assistant final summary')), 'assistant finals are summarized as short-term context');
  assertEqual(document.intentContext.some((item) => item.includes('Assistant final')), false, 'assistant final text is not promoted as stable intent');
  assertEqual(document.factContext.some((item) => item.includes('Plan intent')), false, 'plan intent does not enter factContext');

  const guidance = collectUserGuidanceEvents([
    {
      id: 'guidance-event',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:05.000Z',
      kind: 'user_guidance',
      payload: {
        content: 'Use the existing facts before asking for more resources.',
        runId: 'run-guidance',
      },
    },
  ], 'run-guidance');
  assertEqual(guidance.length, 1, 'user guidance events are collected for the next provider checkpoint');
  assertEqual(guidance[0]?.checkpointKind, 'nextProviderCall', 'guidance is scheduled for the next provider call');
}

function assertSessionTaskGraphProjection(): void {
  const events: AgentEvent[] = [
    {
      id: 'task-requirement',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: { status: 'pending', summary: 'Confirm a generic requirement.' },
    },
    {
      id: 'task-requirement-decision',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'requirement_decision',
      payload: { decision: 'accept', summary: 'Proceed with the generic requirement.' },
    },
    {
      id: 'task-tool-call',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:02.000Z',
      kind: 'tool_call',
      payload: { toolName: 'fs.list', callId: 'list-generic', summary: 'List generic resources.' },
    },
    {
      id: 'task-tool-result',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:03.000Z',
      kind: 'tool_result',
      payload: { toolName: 'fs.list', callId: 'list-generic', status: 'completed', summary: 'Listed generic resources.' },
    },
    {
      id: 'task-plan',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:04.000Z',
      kind: 'plan_card',
      payload: { summary: 'Plan a generic reviewable batch.' },
    },
    {
      id: 'task-permission',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:05.000Z',
      kind: 'permission_request',
      payload: { status: 'pending', summary: 'User decision is required.' },
    },
    {
      id: 'task-review',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:06.000Z',
      kind: 'review_summary',
      payload: {
        status: 'waitingUserReview',
        content: 'Review a generic batch.',
        continuations: [{ id: 'continue-generic', title: 'Continue generic work.' }],
      },
    },
    {
      id: 'task-guidance-queued',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:06.500Z',
      kind: 'user_guidance',
      payload: {
        content: 'Use the already collected facts before requesting more resources.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'queued',
      },
    },
    {
      id: 'task-guidance-consumed',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:06.750Z',
      kind: 'user_guidance',
      payload: {
        content: 'Prefer a concise final answer.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'consumed',
      },
    },
    {
      id: 'task-answer',
      sessionId: 'session-task',
      ts: '2026-01-01T00:00:07.000Z',
      kind: 'assistant_msg',
      payload: { channel: 'final', content: 'Generic final answer.' },
    },
  ];
  const graph = buildSessionTaskGraph({
    sessionId: 'session-task',
    runId: 'run-task',
    events,
    stateContract: {
      runId: 'run-task',
      stateId: 'needProposal',
      stateKind: 'driverRequest',
      allowedInputs: ['proposalSubmit'],
      allowedProposals: ['answer', 'resourceRequest', 'actionBundle'],
      proposalSchemaRefs: ['deepcode.agent.protocol.v3'],
      capabilityProjection: ['workspace.read'],
    },
    driverRequest: {
      id: 'driver-task',
      runId: 'run-task',
      sessionId: 'session-task',
      kind: 'needProposal',
      reason: 'Need a generic proposal.',
    },
  });

  assertEqual(graph.schemaVersion, '1', 'task graph is versioned');
  assertEqual(graph.stateContractRef?.stateId, 'needProposal', 'task graph carries state contract refs');
  assertEqual(graph.driverRequestRef?.id, 'driver-task', 'task graph carries driver request refs');
  assertEqual(taskStatus(graph, 'requirement'), 'completed', 'requirement task completes after user decision');
  assertEqual(taskStatus(graph, 'resource-list-generic'), 'completed', 'resource task completes after tool result');
  assertEqual(taskStatus(graph, 'waiting-user'), 'waiting', 'permission task waits for user input');
  assertEqual(taskStatus(graph, 'review'), 'running', 'waiting review remains visible as active work');
  assertEqual(taskStatus(graph, 'continuation'), 'queued', 'continuation intent is queued after review facts');
  assertEqual(taskStatus(graph, 'guidance-task-guidance-queued'), 'queued', 'pending guidance is queued before provider consumption');
  assertEqual(taskStatus(graph, 'guidance-task-guidance-consumed'), 'completed', 'consumed guidance is completed after provider checkpoint');
  assertEqual(taskStatus(graph, 'analysis'), 'completed', 'final answer completes analysis task');
}

function assertDeepSeekCacheStrategyDoesNotInjectRequestParameter(): void {
  const result = applyProviderCacheStrategy({
    provider: 'deepseek',
    model: 'deepseek-chat',
    prefixHash: 'fnv1a32:generic',
    requestBody: {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'generic' }],
    },
  });
  assertEqual(result.semanticMode, 'deepseek-openai', 'DeepSeek keeps OpenAI-compatible semantic mode');
  assertEqual(result.serverPromptCacheSupported, true, 'DeepSeek server prompt cache is marked as supported');
  assertEqual(Object.prototype.hasOwnProperty.call(result.requestBody, 'prompt_cache_key'), false, 'DeepSeek request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(result.requestBody, 'cache_control'), false, 'DeepSeek request body does not include cache_control');
}

async function assertProviderCacheTelemetryNormalizesBigModelUsage(): Promise<void> {
  const events: AgentEvent[] = [];
  const session: AgentSession = {
    id: 'session-cache-bigmodel',
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
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => ({
      ok: true,
      data: {
        chunks: [{ type: 'done' }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_tokens: 1100,
          prompt_tokens_details: {
            cached_tokens: 77,
          },
        },
        assistantMessage: {
          role: 'assistant',
          content: JSON.stringify({
            schemaVersion: 'deepcode.agent.protocol.v3',
            kind: 'answer',
            outputLanguage: 'en-US',
            answer: { format: 'markdown', content: 'Generic answer.' },
          }),
        },
      },
    }),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-cache-bigmodel',
    content: 'Answer a generic question.',
    requirementConfirmationMode: 'off',
  });
  const telemetry = result.events.find((event) => event.kind === 'cache_telemetry');
  if (!telemetry) throw new Error('cache telemetry should be emitted for provider usage');
  const payload = telemetry.payload as any;
  assertEqual(payload.promptCacheHitTokens, 77, 'BigModel prompt_tokens_details.cached_tokens maps to cache hit tokens');
  assertEqual(payload.promptCacheMissTokens, 923, 'BigModel cache miss tokens are inferred from prompt tokens minus cached tokens');
  assertEqual(payload.cachedTokens, 77, 'BigModel cached token detail is preserved');
  assert(Array.isArray(payload.promptSegmentDigests) && payload.promptSegmentDigests.length > 0, 'cache telemetry includes prompt segment digests');
}

async function assertProviderTraceArchiveCompactsStreamingChunks(): Promise<void> {
  const events: AgentEvent[] = [];
  const transcript: TranscriptEntry[] = [];
  const session: AgentSession = {
    id: 'session-trace-archive',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const chunks: LlmChatResult['chunks'] = [];
  for (let index = 0; index < 5000; index += 1) {
    chunks.push({
      type: index % 5 === 0 ? 'reasoning_delta' : 'delta',
      content: `generic stream fragment ${index} ${'x'.repeat(80)}`,
      rawProvider: {
        id: `raw-provider-${index}`,
        payload: `raw-provider-payload-${index}-${'y'.repeat(200)}`,
      },
    });
  }
  chunks.push({
    type: 'done',
    finishReason: 'stop',
    usage: { promptTokens: 1000, completionTokens: 384000, totalTokens: 385000 },
    rawProvider: { id: 'raw-provider-done', payload: 'raw-provider-payload-done' },
  });

  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    appendTranscript: async (_sessionId, entry) => {
      transcript.push(entry);
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => ({
      ok: true,
      data: {
        chunks,
        usage: { promptTokens: 1000, completionTokens: 384000, totalTokens: 385000 },
        assistantMessage: {
          role: 'assistant',
          reasoningContent: 'generic reasoning '.repeat(1000),
          content: JSON.stringify({
            schemaVersion: 'deepcode.agent.protocol.v3',
            kind: 'answer',
            outputLanguage: 'en-US',
            answer: { format: 'markdown', content: 'Generic compact trace answer.' },
          }),
        },
      },
    }),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + transcript.length + 1}`,
  });

  await loop.runUserTurn({
    sessionId: 'session-trace-archive',
    content: 'Answer a generic high-volume streaming question.',
    requirementConfirmationMode: 'off',
  });

  const responseTrace = transcript.find((entry): entry is TranscriptEntry & { type: 'metadata'; payload: any } =>
    entry.type === 'metadata' &&
    entry.kind === 'provider_trace' &&
    (entry.payload as any)?.stage === 'provider_call.response'
  );
  if (!responseTrace) throw new Error('provider response trace should be archived');
  const payload = (responseTrace.payload as any).payload;
  const archivedJson = JSON.stringify(payload);
  assertEqual(payload.traceArchiveMode, 'compact', 'provider response trace uses compact archive mode');
  assertEqual(payload.response.chunkSummary.chunkCount, chunks.length, 'compact trace records chunk count');
  assertEqual(payload.response.chunkSummary.rawProviderCount, chunks.length, 'compact trace records raw provider count without raw payloads');
  assertEqual(Boolean(payload.response.chunks), false, 'compact trace does not retain raw chunks array');
  assert(archivedJson.length < 120_000, 'compact provider trace stays below transcript body risk threshold');
  assert(!archivedJson.includes('raw-provider-payload-4999'), 'compact trace strips raw provider payload values');
  assert(!archivedJson.includes('generic stream fragment 4999'), 'compact trace strips per-token content values');
}

async function assertProviderPartFramesEnterKernelDraftLedger(): Promise<void> {
  const events: AgentEvent[] = [];
  const deltas: unknown[] = [];
  const draftFrames: Array<Record<string, unknown>> = [];
  const session: AgentSession = {
    id: 'session-draft-frame',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const frame = {
    schemaVersion: 'deepcode.agent.stream.part.v1',
    partKind: 'codeBlockChunk',
    draftId: 'draft-generic',
    frameId: 'frame-generic-1',
    branchId: 'branch-generic',
    subAgentId: 'subagent-generic',
    mergeGroupId: 'merge-generic',
    targetPath: 'src/generated.txt',
    capability: 'workspace.write',
    sequence: 1,
    chunk: 'generic draft content\n',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'draftLedgerSubmit') {
        draftFrames.push(command.frame);
        return {
          ok: true,
          events: [
            {
              kind: 'draft.open',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.open' },
            },
            {
              kind: 'draft.chunk',
              runId: command.runId,
              sessionId: command.sessionId,
              draft: { draftId: command.frame.draftId, status: 'draft.chunk', frame: command.frame },
            },
          ],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('provider part frame smoke should use streaming provider path');
    },
    llmChatStream: async (_request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'delta',
        content: `<deepcode-part>${JSON.stringify(frame)}</deepcode-part>`,
      };
      await onEvent({ type: 'provider_delta', chunk });
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Generic final answer after draft frame.' },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + deltas.length + draftFrames.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-draft-frame',
    content: 'Generate a generic draft through protocol-level streaming frames.',
    requirementConfirmationMode: 'off',
  });

  assertEqual(draftFrames.length, 1, 'closed provider part frame is submitted to Kernel draft ledger once');
  assertEqual(draftFrames[0].targetPath, 'src/generated.txt', 'draft frame target path is preserved for Kernel audit');
  assertEqual(draftFrames[0].branchId, 'branch-generic', 'draft frame branch metadata is preserved for Kernel audit');
  assertEqual(draftFrames[0].subAgentId, 'subagent-generic', 'draft frame sub-agent metadata is preserved for Kernel audit');
  assertEqual(deltas.some((delta) => (delta as any).type === 'part_delta'), true, 'Session emits volatile part delta');
  assertEqual(deltas.some((delta) => (delta as any).type === 'part_delta' && (delta as any).branchId === 'branch-generic'), true, 'part delta carries branch metadata');
  assertEqual(deltas.some((delta) => (delta as any).type === 'draft_delta'), true, 'Session emits Kernel draft ledger delta');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'), true, 'final answer still commits through the ordinary parser path');
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
      payload: { channel: 'reasoning', status: 'running', content: 'Need generic context.' },
    },
    {
      id: 'event-progress',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.500Z',
      kind: 'assistant_msg',
      payload: { channel: 'progress', source: 'llm', content: 'I will resolve the selected resource before continuing.' },
    },
    {
      id: 'event-progress-session',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.600Z',
      kind: 'assistant_msg',
      payload: { channel: 'progress', source: 'session', content: 'Session-local progress does not become narration.' },
    },
    {
      id: 'event-cache',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.750Z',
      kind: 'cache_telemetry',
      payload: {
        provider: 'deepseek-v4-pro-openai',
        stage: 'plan',
        promptCacheHitTokens: 80,
        promptCacheMissTokens: 20,
        promptTokens: 100,
        completionTokens: 12,
        totalTokens: 112,
      },
    },
    {
      id: 'event-cache-repair',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:01.850Z',
      kind: 'cache_telemetry',
      payload: {
        provider: 'deepseek-v4-pro-openai',
        stage: 'repair',
        promptCacheHitTokens: 20,
        promptCacheMissTokens: 80,
        promptTokens: 100,
        completionTokens: 8,
        totalTokens: 108,
      },
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
      id: 'event-guidance',
      sessionId: 'session-narrative',
      ts: '2026-01-01T00:00:02.500Z',
      kind: 'user_guidance',
      payload: {
        content: 'Apply this generic guidance at the next provider checkpoint.',
        effectiveCheckpoint: 'nextProviderCall',
        status: 'queued',
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
  assertEqual(kinds.includes('assistantNarration'), true, 'llm progress assistant messages become narration');
  assertEqual(kinds.includes('operationEvidence'), true, 'tool facts become operation evidence');
  assertEqual(kinds.includes('requirement'), true, 'user guidance is projected as a user-intervention timeline block');
  assertEqual(kinds.includes('plan'), true, 'plan facts become a plan block');
  assertEqual(kinds.includes('assistantText'), true, 'final answer becomes assistant text');
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'operationEvidence'),
    false,
    'operation evidence stays in the timeline and does not enter task projection'
  );
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'assistantNarration'),
    false,
    'assistant narration does not enter task projection'
  );
  assertEqual(
    projection.taskProjection?.items.length ?? 0,
    0,
    'task projection is empty when no implementation plan tasks exist'
  );
  const processOnlyProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-process-only',
    events: [
      {
        id: 'event-process-user',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:00.000Z',
        kind: 'user_msg',
        payload: { content: 'Inspect generic process events.' },
      },
      {
        id: 'event-process-resource',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'workflow_stage',
        payload: { stage: 'resource_resolve', status: 'completed', summary: 'Resolved generic resources.' },
      },
      {
        id: 'event-process-tool',
        sessionId: 'session-process-only',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'tool_result',
        payload: { toolName: 'workspace.read', ok: true },
      },
    ],
  });
  assertEqual(
    processOnlyProjection.taskProjection?.items.length ?? 0,
    0,
    'resource, tool, and workflow process events do not create task projection items without plan tasks'
  );
  const narrationBlock = projection.turns[0].blocks.find((block) => block.narrativeKind === 'assistantNarration');
  assertEqual(narrationBlock?.displayHints?.renderMode, 'typewriter', 'assistant narration uses typewriter projection hints');
  assertEqual(narrationBlock?.displayHints?.checkpointKind, 'llmProposal', 'assistant narration is tied to an LLM proposal checkpoint');
  const thinkingBlock = projection.turns[0].blocks.find((block) => block.narrativeKind === 'thinking');
  assertEqual(Boolean(thinkingBlock?.displayHints?.replaceOnComplete), true, 'thinking exposes replacement/collapse projection hints');
  assertEqual(thinkingBlock?.displayHints?.typewriterSpeed, 'slow', 'running thinking uses a slower typewriter speed');
  const guidanceBlock = projection.turns[0].blocks.find((block) => block.events.some((event) => event.kind === 'user_guidance'));
  assertEqual(guidanceBlock?.title, 'User guidance', 'user guidance has its own visible timeline title');
  assertEqual(guidanceBlock?.status, 'queued', 'user guidance remains queued before provider consumption');
  assertEqual(guidanceBlock?.displayHints?.checkpointKind, 'userGuidance', 'user guidance marks the next provider checkpoint');
  assertEqual(
    projection.turns[0].blocks.some((block) => block.events.some((event) => event.kind === 'cache_telemetry')),
    false,
    'cache telemetry is hidden from narrative blocks'
  );
  assertEqual(projection.tokenUsageProjection?.requests.length, 1, 'cache telemetry is grouped by user request');
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.providerCallCount,
    2,
    'multiple provider calls in one user turn are counted together'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.promptCacheHitTokens,
    100,
    'request cache hit tokens are summed'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.promptCacheMissTokens,
    100,
    'request cache miss tokens are summed'
  );
  assertEqual(
    projection.tokenUsageProjection?.requests[0]?.cacheHitRate,
    0.5,
    'request cache hit rate uses hit divided by hit plus miss'
  );
  assertEqual(
    projection.tokenUsageProjection?.totals.totalTokens,
    220,
    'token projection totals are summed across provider calls'
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

function assertImplementationPlanTaskProjectionProgress(): void {
  const planEvent: AgentEvent = {
    id: 'event-plan-progress',
    sessionId: 'session-task-projection',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId: 'run-task-projection',
      planId: 'plan-task-projection',
      title: 'Generic implementation plan',
      summary: 'Review generic implementation tasks.',
      implementationPlan: {
        id: 'plan-task-projection',
        tasks: [
          {
            taskId: 'task-alpha',
            title: 'Update generic module',
            target: ['src/generic-module.ts'],
            scope: 'Update a generic module.',
            acceptanceCriteria: ['Kernel facts show the module update.'],
            failureCriteria: ['Stop if Kernel rejects the update.'],
          },
          {
            taskId: 'task-beta',
            title: 'Update generic validation',
            target: ['src/generic-validation.ts'],
            scope: 'Update generic validation.',
            acceptanceCriteria: ['Kernel facts show validation update.'],
            failureCriteria: ['Stop if validation cannot be updated.'],
          },
        ],
      },
    },
  };
  const waitingProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [planEvent],
  });
  const waitingItems = waitingProjection.taskProjection?.items ?? [];
  assertEqual(
    waitingItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'waiting'),
    true,
    'implementation plan tasks wait for user confirmation'
  );

  const acceptedNoFactsProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-plan-accepted-no-facts',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
          summary: 'User accepted the generic implementation plan.',
        },
      },
    ],
  });
  const acceptedNoFactsItems = acceptedNoFactsProjection.taskProjection?.items ?? [];
  assertEqual(
    acceptedNoFactsItems.filter((item) => item.id.includes('implementation-plan')).every((item) => item.status === 'queued'),
    true,
    'accepted implementation tasks stay queued until Kernel WorkUnit or tool facts match them'
  );

  const acceptedProjection = buildNarrativeTimelineProjection({
    sessionId: 'session-task-projection',
    events: [
      planEvent,
      {
        id: 'event-plan-accepted',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:01.000Z',
        kind: 'plan_review',
        payload: {
          runId: 'run-task-projection',
          planId: 'plan-task-projection',
          status: 'accepted',
          summary: 'User accepted the generic implementation plan.',
        },
      },
      {
        id: 'event-work-alpha',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:02.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.completed',
          kernelEvent: {
            kind: 'work_unit.completed',
            output: { path: 'src/generic-module.ts' },
          },
        },
      },
      {
        id: 'event-work-beta',
        sessionId: 'session-task-projection',
        ts: '2026-01-01T00:00:03.000Z',
        kind: 'workflow_stage',
        payload: {
          stage: 'work_unit.started',
          kernelEvent: {
            kind: 'work_unit.started',
            output: { path: 'src/generic-validation.ts' },
          },
        },
      },
    ],
  });
  const acceptedItems = acceptedProjection.taskProjection?.items ?? [];
  const alpha = acceptedItems.find((item) => item.title === 'Update generic module');
  const beta = acceptedItems.find((item) => item.title === 'Update generic validation');
  assertEqual(alpha?.status, 'completed', 'implementation task status follows matching Kernel completion facts');
  assertEqual(beta?.status, 'running', 'implementation task status follows matching Kernel running facts');
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

async function assertSessionDriverLoopTerminalAnswerGuidanceRevision(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-terminal-guidance',
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
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        events.push({
          id: 'guidance-terminal-generic',
          sessionId: 'session-terminal-guidance',
          ts: '2026-01-01T00:00:00.500Z',
          kind: 'user_guidance',
          payload: {
            content: 'Include a generic evaluation dashboard and visible metrics.',
            guidance: 'Include a generic evaluation dashboard and visible metrics.',
            targetRunId: 'run-generic',
            status: 'queued',
            source: 'user',
            effectiveCheckpoint: 'nextProviderCall',
          },
        });
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'Initial generic plan without metrics.' },
        });
      }
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(promptText.includes('Unshown draft answer'), 'guidance revision prompt carries unshown draft answer');
      assert(promptText.includes('Include a generic evaluation dashboard'), 'guidance revision prompt carries queued user guidance');
      events.push({
        id: 'guidance-during-revision-generic',
        sessionId: 'session-terminal-guidance',
        ts: '2026-01-01T00:00:00.750Z',
        kind: 'user_guidance',
        payload: {
          content: 'Keep the final project plan concise.',
          guidance: 'Keep the final project plan concise.',
          targetRunId: 'run-generic',
          status: 'queued',
          source: 'user',
          effectiveCheckpoint: 'nextProviderCall',
        },
      });
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        narration: 'I will merge the new evaluation-dashboard guidance into the current answer.',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Revised generic plan with an evaluation dashboard and visible metrics.' },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-terminal-guidance',
    content: 'Plan a generic learning project.',
  });

  const finalMessages = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
  assertEqual(llmCalls, 2, 'terminal queued guidance triggers one guidance revision provider call');
  assertEqual(finalMessages.length, 1, 'draft answer is replaced by a single final answer');
  assert(String((finalMessages[0]?.payload as any)?.content ?? '').includes('evaluation dashboard'), 'final answer applies queued guidance');
  assertEqual(Boolean((finalMessages[0]?.payload as any)?.guidanceRevision), true, 'final answer records guidance revision metadata');
  assertEqual(
    Array.isArray((finalMessages[0]?.payload as any)?.appliedGuidanceIds) &&
      (finalMessages[0]?.payload as any).appliedGuidanceIds.includes('guidance-terminal-generic'),
    true,
    'final answer records applied guidance ids'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'session' &&
      String((event.payload as any)?.content ?? '').includes('received your update')
    ),
    true,
    'session transition message follows the user language before guidance revision'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'llm' &&
      String((event.payload as any)?.content ?? '').includes('evaluation-dashboard')
    ),
    true,
    'LLM narration transition is visible when returned'
  );
  assertEqual(
    result.events.some((event) =>
      event.kind === 'user_guidance' &&
      (event.payload as any)?.status === 'consumed' &&
      (event.payload as any)?.guidanceId === 'guidance-terminal-generic' &&
      (event.payload as any)?.appliedAtProviderStage === 'guidance_revision'
    ),
    true,
    'consumed guidance records guidance revision provider checkpoint'
  );
  const remainingGuidance = collectUserGuidanceEvents(result.events, 'run-generic');
  assertEqual(
    remainingGuidance.some((item) => item.id === 'guidance-during-revision-generic'),
    true,
    'guidance arriving during guidance revision remains queued for a later checkpoint'
  );
}

async function assertSessionDriverLoopTerminalGuidanceRevisionFallback(): Promise<void> {
  const events: AgentEvent[] = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-terminal-guidance-fallback',
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
      if (llmCalls === 1) {
        events.push({
          id: 'guidance-terminal-fallback-generic',
          sessionId: 'session-terminal-guidance-fallback',
          ts: '2026-01-01T00:00:00.500Z',
          kind: 'user_guidance',
          payload: {
            content: 'Add a generic evaluation view.',
            guidance: 'Add a generic evaluation view.',
            targetRunId: 'run-generic',
            status: 'queued',
            source: 'user',
            effectiveCheckpoint: 'nextProviderCall',
          },
        });
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'Initial fallback answer.' },
        });
      }
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-terminal-guidance-fallback',
    content: 'Plan another generic learning project.',
  });

  const finalMessages = result.events.filter((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'
  );
  assertEqual(llmCalls, 2, 'terminal guidance fallback attempts one revision call');
  assertEqual(finalMessages.length, 1, 'fallback path still produces one final answer');
  assertEqual(String((finalMessages[0]?.payload as any)?.content ?? ''), 'Initial fallback answer.', 'fallback final answer uses initial draft');
  assertEqual(Boolean((finalMessages[0]?.payload as any)?.guidanceRevisionFailed), true, 'fallback final answer records guidance revision failure');
  assertEqual(result.events.some((event) => event.kind === 'error'), true, 'guidance revision failure records a diagnostic event');
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

async function assertSessionDriverLoopSearchResourceRequest(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-search-resource',
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
      if (command.kind === 'resourceResolve') {
        const manifest = command.request?.manifest as any;
        resourceResolveManifests.push(manifest);
        const entry = manifest?.entries?.[0] ?? {};
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            packet: {
              id: `packet-${resourceResolveManifests.length}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'search-item',
                manifestEntryId: entry.id ?? 'search-entry',
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                resolvedKind: entry.kind,
                contentKind: entry.kind === 'search' ? 'searchResults' : 'directoryTree',
                path: entry.path ?? entry.resourceRef,
                absolutePath: entry.resourceRef,
                query: entry.query,
                include: entry.include,
                matches: entry.kind === 'search'
                  ? [{ path: 'src/generic.txt', line: 2, preview: 'generic anchor line' }]
                  : undefined,
                returnedMatches: entry.kind === 'search' ? 1 : undefined,
                truncated: false,
                promptContent: entry.kind === 'search'
                  ? JSON.stringify({ matches: [{ path: 'src/generic.txt', line: 2, preview: 'generic anchor line' }] })
                  : undefined,
                nodes: entry.kind === 'search' ? undefined : [{ type: 'file', path: 'src/generic.txt' }],
                evidenceRefs: ['evidence-search'],
              }],
            },
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'resourceRequest',
          outputLanguage: 'en-US',
          resourceRequest: {
            version: '1',
            id: 'need-generic-search',
            reason: 'Need generic search evidence.',
            items: [{
              id: 'search-anchor',
              kind: 'search',
              query: 'generic anchor',
              include: ['src/'],
              contextLines: 2,
              maxResults: 10,
              reason: 'Find a generic anchor.',
            }],
          },
        });
      }
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: { format: 'markdown', content: 'Generic search evidence was resolved.' },
      });
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-search-resource',
    content: 'Find a generic anchor before editing.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg'), true, 'search resourceRequest reaches final answer');
  assert(resourceResolveManifests.length >= 2, 'search resourceRequest triggers Kernel ResourceResolve');
  const secondEntry = resourceResolveManifests[1].entries[0];
  assertEqual(secondEntry.kind, 'search', 'search resourceRequest is synthesized as a Kernel search entry');
  assertEqual(secondEntry.query, 'generic anchor', 'search manifest carries query');
  assertEqual(secondEntry.include[0], 'src/', 'search manifest carries include filter');
  assertEqual(secondEntry.contextLines, 2, 'search manifest carries contextLines');
  assertEqual(secondEntry.maxResults, 10, 'search manifest carries maxResults');
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

async function assertSessionDriverLoopReadOnlyRequestsContinueWithoutBudgetDecision(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-readonly-unbounded',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-readonly-unbounded'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(!promptText.includes('Read-only resource budget:'), 'provider prompt does not expose fixed read-only resource budget');
      if (llmCalls > 12) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'answer',
          outputLanguage: 'en-US',
          answer: { format: 'markdown', content: 'Read-only exploration continued and then converged.' },
        });
      }
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
                id: `budget-request-${llmCalls}`,
                reason: 'Need another generic resource.',
                items: [{ id: `budget-item-${llmCalls}`, path: `src/file-${llmCalls}.txt`, reason: 'Read the next generic source.' }],
              },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-readonly-unbounded',
    content: 'Analyze the attached generic project.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  assertEqual(llmCalls, 13, 'read-only resource requests continue beyond the former eight-round budget and then converge');
  assertEqual(resourceResolveManifests.length, 13, 'initial attachment plus twelve requested resource packets were resolved');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'read-only resource loop no longer emits a budget decision card');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.diagnostic === true), false, 'read-only continuation is not a terminal diagnostic');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.channel === 'final' &&
      String((event.payload as any)?.content ?? '').includes('continued')
    ),
    true,
    'read-only continuation produces a final answer when the provider converges'
  );
}

async function assertSessionDriverLoopOldResourceBudgetDecisionStillResumes(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-budget-legacy',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const oldBudgetConfirmation: AgentEvent = {
    id: 'legacy-resource-budget-confirmation',
    sessionId: 'session-budget-legacy',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: '用户介入请求',
      summary: '只读资源预算已用完，需要用户决定是否继续读取上下文。',
      status: 'waitingUserConfirmation',
      confirmable: true,
      runId: 'run-budget-legacy',
      requirementId: 'resource-budget-run-budget-legacy',
      originalUserRequest: 'Analyze the attached generic project.',
      attachments: [],
      requirement: {
        requirementId: 'resource-budget-run-budget-legacy',
        sessionId: 'session-budget-legacy',
        initialUserRequest: 'Analyze the attached generic project.',
        checklist: { goal: 'Legacy budget confirmation.' },
        status: 'probing',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      channel: 'action',
      visibility: 'conversation',
      presentation: 'body',
    },
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-budget-legacy'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(!promptText.includes('Read-only resource budget:'), 'legacy budget continuation resumes without exposing a new fixed budget');
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
              answer: { format: 'markdown', content: 'Continued after legacy budget approval.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const next = await loop.resolveDecision({
    sessionId: 'session-budget-legacy',
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-budget-legacy',
    targetId: 'resource-budget-run-budget-legacy',
    existingEvents: [oldBudgetConfirmation],
  });
  assertEqual(llmCalls, 1, 'legacy budget approval resumes by calling the provider once');
  assertEqual(next.events.some((event) => event.kind === 'trace/requirement_decision_noop'), false, 'legacy budget confirmation is still recognized as active');
  assertEqual(next.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'final'), true, 'legacy budget approval continues to final answer');
}

function resourceBudgetKernel(
  request: KernelCommandEnvelope,
  resourceResolveManifests: Array<Record<string, any>>,
  sessionId: string
): KernelReply {
  const command = request.command as Record<string, any>;
  if (command.kind === 'runCreate') {
    const reply = fakeKernel(request);
    for (const event of reply.events ?? []) {
      (event as any).sessionId = sessionId;
    }
    return reply;
  }
  if (command.kind === 'resourceResolve') {
    resourceResolveManifests.push(command.request.manifest);
    const entry = command.request.manifest.entries[0];
    return {
      ok: true,
      events: [{
        kind: 'resource.packet_produced',
        runId: 'run-generic',
        sessionId,
        packet: {
          id: `packet-budget-${resourceResolveManifests.length}`,
          requestId: command.requestId,
          items: [{
            requestItemId: 'item-generic',
            manifestEntryId: entry.id,
            status: 'resolved',
            readPolicy: 'explicit-manifest-readonly',
            sourceKind: entry.kind,
            contentKind: entry.kind === 'directory' ? 'directoryTree' : 'fileText',
            absolutePath: entry.resourceRef,
            path: entry.resourceRef,
            nodes: entry.kind === 'directory' ? [{ type: 'file', path: 'src/file-1.txt' }] : undefined,
            content: entry.kind === 'directory' ? undefined : `content for ${String(entry.resourceRef).replace('/tmp/generic-project/', '')}`,
            truncated: entry.kind !== 'directory' && String(entry.resourceRef).endsWith('file-8.txt'),
            originalBytes: entry.kind !== 'directory' ? 24000 : undefined,
            evidenceRefs: ['evidence-budget'],
          }],
        },
      }],
    };
  }
  return { ok: true, events: [] };
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
  const planCards = result.events.filter((event) => event.kind === 'plan_card');
  const planReviews = result.events.filter((event) => event.kind === 'plan_review');
  assertEqual(planCards.length, 1, 'repaired plan renders one interactive plan card');
  assertEqual((planCards[0]?.payload as any)?.decisionOwner?.kind, 'plan', 'plan card owns the plan decision');
  assertEqual((planCards[0]?.payload as any)?.status, 'awaitingUserApproval', 'plan card carries Kernel review status');
  assertEqual(planReviews.length, 1, 'Kernel plan review remains recorded for audit');
  assertEqual((planReviews[0]?.payload as any)?.confirmable, false, 'Kernel plan review is not a second decision owner');
  assertEqual((planReviews[0]?.payload as any)?.visibility, 'debug', 'Kernel plan review is debug/audit only');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'plan_review'
    ),
    true,
    'waiting plan review is exposed as an explicit session run state'
  );
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

async function assertSessionDriverLoopAcceptsLocalizedStructuredPlan(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const session: AgentSession = {
    id: 'session-localized-plan',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-localized-plan', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(localizedGenericWriteProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-localized-plan',
    content: 'Create a generic workspace change.',
    requirementConfirmationMode: 'off',
  });
  assertEqual(submittedPlans.length, 1, 'localized structured plan reaches Kernel without heading repair');
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'localized structured plan renders a plan card');
}

function assertWorkflowStagePermissionProjectsPendingDecision(): void {
  const pending = findLatestPendingPermission([
    {
      id: 'event-permission',
      sessionId: 'session-permission',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'workflow_stage',
      payload: {
        kernelEvent: {
          kind: 'permission.requested',
          runId: 'run-permission',
          planId: 'plan-permission',
          request: {
            id: 'permission-generic',
            capability: 'workspace.write',
            riskLevel: 'medium',
            summary: 'Allow a generic write operation?',
            argsPreview: { path: 'generic-output.txt' },
          },
        },
      },
    },
  ]);
  assertEqual(pending?.request.id, 'permission-generic', 'workflow_stage permission.requested is recognized as pending permission');
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
  assert(promptText.includes('ProjectMemory document'), 'structured project memory is included');
  assert(promptText.includes('SessionMemory document'), 'structured session memory is included');
  assert(promptText.includes('Project fact index'), 'kernel facts are separated into project fact indexes');
  assert(promptText.includes('Session intent'), 'plans and continuations are separated into session intent context');
}

async function assertSessionDriverLoopReviewRevisionContinuesWhenAuditRunInactive(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-inactive-audit',
    sessionId: 'session-review-revision-inactive-audit',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-inactive-audit',
      reviewId: 'review-inactive-audit',
      sourcePlanId: 'plan-inactive-audit',
      content: '## Review\n\nA generic completed batch needs a revision.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-revision-inactive-audit',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const submittedPlans: Array<Record<string, any>> = [];
  const llmRequests: LlmChatRequest[] = [];
  let userDecisionSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return {
          ok: false,
          events: [],
          error: {
            code: 'run_not_active',
            message: 'invalid command: run is not active',
          },
        };
      }
      return planKernel(request, session.id, submittedPlans);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + userDecisionSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'review',
    decision: 'revise',
    guidance: 'Revise the generic batch with an additional safe detail.',
    runId: 'run-review-inactive-audit',
    existingEvents: events,
  });

  assertEqual(userDecisionSubmits, 1, 'review revise still attempts one Kernel audit decision');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'trace/review_accept_noop' &&
      (event.payload as any)?.errorCode === 'run_not_active'
    ),
    true,
    'inactive review audit is recorded as a Session trace'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'review revise continues to a new planning turn after audit failure');
  assertEqual(submittedPlans.length, 1, 'review revise still submits the repaired plan to Kernel PlanReview');
  assertEqual(llmRequests.length, 1, 'review revise calls provider once after best-effort audit failure');
}

async function assertSessionDriverLoopPlanAcceptGroupsWorkspaceWriteGrants(): Promise<void> {
  const actionBundle = multiWriteActionBundle();
  const events: AgentEvent[] = [
    {
      id: 'plan-card-multi-write',
      sessionId: 'session-plan-grant-group',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-grant-group',
        planId: 'bundle-multi-write',
        proposalId: 'proposal-multi-write',
        content: '# Plan\n\n## Summary\nWrite multiple generic files.',
        actionBundle,
        codeBlocks: [
          { id: 'code-one', targetPath: 'generic-one.txt', content: 'one' },
          { id: 'code-two', targetPath: 'generic-two.txt', content: 'two' },
        ],
        commandBlocks: [],
        planReviewReport: proposalReviewReport(actionBundle),
      },
    },
    {
      id: 'plan-review-multi-write',
      sessionId: 'session-plan-grant-group',
      ts: '2026-01-01T00:00:00.001Z',
      kind: 'plan_review',
      payload: {
        status: 'awaitingTemporaryGrant',
        runId: 'run-plan-grant-group',
        planId: 'bundle-multi-write',
        confirmable: true,
        report: proposalReviewReport(actionBundle),
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-grant-group',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const temporaryGrants: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') return { ok: true, events: [] };
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants.push(command.grant);
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + temporaryGrants.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: 'session-plan-grant-group',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-grant-group',
    targetId: 'bundle-multi-write',
    existingEvents: events,
  });

  assertEqual(temporaryGrants.length, 2, 'multiple workspace.write actions receive file-scoped temporary grants');
  assertEqual(
    temporaryGrants.map((grant) => grant.resourcePath).sort().join(','),
    'generic-one.txt,generic-two.txt',
    'temporary grants are scoped to Kernel-reviewed file operations'
  );
  assertEqual(temporaryGrants.every((grant) => grant.capability === 'workspace.write'), true, 'all grants keep the reviewed capability');
  assertEqual(
    temporaryGrants.every((grant) => (grant.permissionBundle as any)?.groupedBy === 'fileOperation'),
    true,
    'temporary grants record file operation grouping metadata'
  );
}

async function assertSessionDriverLoopPlanCardAcceptDoesNotNoopWithoutPlanReview(): Promise<void> {
  const actionBundle = genericActionBundle();
  const events: AgentEvent[] = [
    {
      id: 'plan-card-only-generic',
      sessionId: 'session-plan-card-only',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'plan_card',
      payload: {
        runId: 'run-plan-card-only',
        planId: 'bundle-generic',
        proposalId: 'proposal-plan-card-only',
        title: 'Generic reviewed plan',
        summary: 'Review a generic workspace plan.',
        content: '# Plan\n\n## Summary\nReview a generic workspace plan.',
        actionBundle,
        codeBlocks: [{ id: 'code-generic', targetPath: 'generic/output.txt', content: 'generic output' }],
        commandBlocks: [],
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-plan-card-only',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let userDecisionSubmits = 0;
  let actionBatchSubmits = 0;
  let temporaryGrants = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-plan-card-only',
    kind: 'plan',
    decision: 'accept',
    runId: 'run-plan-card-only',
    targetId: 'bundle-generic',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'trace/plan_accept_noop'), false, 'plan_card-only accept does not become a stale noop');
  assertEqual(result.events.some((event) => event.kind === 'plan_review' && (event.payload as any).status === 'accepted'), true, 'plan_card-only accept records one accepted plan review');
  assertEqual(userDecisionSubmits, 1, 'plan_card-only accept submits one user decision to Kernel');
  assertEqual(temporaryGrants, 0, 'plan_card-only accept without Kernel file operation review does not receive broad workspace grant');
  assertEqual(actionBatchSubmits, 1, 'plan_card-only accept submits the accepted action batch');
}

async function assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesBatch(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-auto', 'run-accepted-plan-auto')];
  const session: AgentSession = {
    id: 'session-accepted-plan-auto',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let temporaryGrants = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') {
        temporaryGrants += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            {
              kind: 'action_batch.accepted',
              runId: 'run-generic',
              sessionId: session.id,
              batch: { planId: command.batch?.planId },
            },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              output: { path: 'generic-output.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + temporaryGrants + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-auto',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 1, 'accepted implementationPlan still submits actionBundle to Kernel PlanReview for audit');
  assertEqual(actionBatchSubmits, 1, 'accepted implementationPlan auto-submits in-scope actionBundle to Kernel execution');
  assertEqual(temporaryGrants, 1, 'accepted implementationPlan grants scoped workspace write permission for in-scope batch');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'accepted implementationPlan execution does not create a second confirmable plan card');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'running' &&
      (event.payload as any)?.reason === 'accepted_plan_execution'
    ),
    true,
    'accepted implementationPlan execution records running session state'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanNormalizesWriteBatchForKernel(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-normalize', 'run-accepted-plan-normalize')];
  const session: AgentSession = {
    id: 'session-accepted-plan-normalize',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let submittedBatch: any;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        submittedBatch = command.batch;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              output: { path: 'generic-output.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-normalize',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assert(Boolean(submittedBatch), 'accepted implementationPlan submits a normalized action batch');
  const action = submittedBatch.actionBundle.actions[0];
  const block = submittedBatch.codeBlocks[0];
  assertEqual(action.kind, 'write', 'workspace.write action keeps explicit write kind before Kernel submit');
  assertEqual(action.targetPath, 'generic-output.txt', 'workspace.write action has explicit targetPath before Kernel submit');
  assertEqual(action.resourceScope[0], 'generic-output.txt', 'workspace.write action keeps concrete resourceScope before Kernel submit');
  assertEqual(block.id, 'generic-block', 'codeBlock keeps canonical id before Kernel submit');
  assertEqual(block.blockId, 'generic-block', 'codeBlock also carries blockId compatibility field before Kernel submit');
  assertEqual(block.path, 'generic-output.txt', 'codeBlock keeps path before Kernel submit');
  assertEqual(block.targetPath, 'generic-output.txt', 'codeBlock carries targetPath before Kernel submit');
}

async function assertSessionDriverLoopAcceptedImplementationPlanPreservesExecutionRoot(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-root', root),
    acceptedImplementationPlanCardEvent('session-accepted-plan-root', 'run-accepted-plan-root'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-root',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let runCreateAttachments: any[] = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'runCreate') {
        runCreateAttachments = command.input?.attachments ?? [];
        return fakeKernel(request);
      }
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-root',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(runCreateAttachments.length, 1, 'accepted implementationPlan continuation sends one execution root attachment');
  assertEqual(runCreateAttachments[0]?.absolutePath, root, 'accepted implementationPlan continuation preserves the primary root');
}

async function assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesMultiTargetBatch(): Promise<void> {
  const events = [multiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-multi', 'run-accepted-plan-multi')];
  const session: AgentSession = {
    id: 'session-accepted-plan-multi',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') {
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-one', actionId: 'write-generic-one', status: 'queued', writeSet: ['generic-one.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-one',
              output: { path: 'generic-one.txt' },
            },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-two', actionId: 'write-generic-two', status: 'queued', writeSet: ['generic-two.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-two',
              output: { path: 'generic-two.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(multiWriteProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-multi',
    targetId: 'impl-generic-multi',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'multi-target accepted implementationPlan batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'multi-target accepted implementationPlan batch is auto-executed');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'multi-target in-scope batch does not become a user intervention');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.length === 0
    ),
    true,
    'multi-target batch records an accepted-plan checkpoint with no remaining tasks'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsMergeIndependentTasks(): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents', 'run-accepted-plan-subagents')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedPlans.push(command.proposal);
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-one',
              output: { path: 'generic-one.txt' },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-two',
              output: { path: 'generic-two.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (targetPath === 'generic-one.txt') return jsonLlmResponse(singleTargetWriteProposal('generic-one.txt', 'one'));
      if (targetPath === 'generic-two.txt') return jsonLlmResponse(singleTargetWriteProposal('generic-two.txt', 'two'));
      throw new Error('sub-agent merge smoke expected only sliced provider calls');
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + llmCalls + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents',
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(llmCalls, 2, 'sub-agent auto mode calls provider once per independent task slice');
  assertEqual(
    proposalSubmits,
    1,
    `sub-agent fragments are merged into one Kernel PlanReview submission (llmCalls=${llmCalls}, actionBatchSubmits=${actionBatchSubmits}, deltas=${deltas.length})`
  );
  assertEqual(actionBatchSubmits, 1, 'merged sub-agent fragments are submitted to Kernel once');
  assertEqual(
    deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_plan.created') &&
      deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_merge.started') &&
      deltas.some((delta) => (delta as any).type === 'stage_delta' && (delta as any).stage === 'subagent_merge.completed'),
    true,
    'sub-agent merge emits stable parent progress deltas'
  );
  assertEqual(
    deltas.filter((delta) => (delta as any).branchId && (delta as any).subAgentId).length >= 2,
    true,
    'branch deltas carry branch and sub-agent metadata'
  );
  const actionBundle = submittedPlans[0]?.payload?.actionBundle;
  assertEqual(Array.isArray(actionBundle?.actions) && actionBundle.actions.length, 2, 'merged actionBundle contains both independent task actions');
  assertEqual(typeof submittedPlans[0]?.payload?.narration, 'undefined', 'merged sub-agent batch does not create a formal assistant narration');
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsDiscardFailedBranchAndFallback(): Promise<void> {
  await runSubAgentFailureFallbackSmoke(
    'diagnostic',
    () => jsonLlmResponse(genericDiagnosticProposal('generic branch diagnostic'))
  );
  await runSubAgentFailureFallbackSmoke(
    'parse-failure',
    () => ({
      ok: true,
      data: {
        chunks: [{ type: 'reasoning_delta', content: 'generic invalid reasoning' }, { type: 'done' }],
        assistantMessage: {
          role: 'assistant',
          reasoningContent: 'generic invalid reasoning',
          content: '{invalid-json',
        },
      },
    })
  );
}

async function runSubAgentFailureFallbackSmoke(
  caseName: string,
  failedBranchResponse: () => ApiResponse<LlmChatResult>
): Promise<void> {
  const events = [independentMultiTargetAcceptedImplementationPlanCardEvent(`session-accepted-plan-subagents-fallback-${caseName}`, `run-accepted-plan-subagents-fallback-${caseName}`)];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: `session-accepted-plan-subagents-fallback-${caseName}`,
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const submittedPlans: Array<Record<string, any>> = [];
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        submittedPlans.push(command.proposal);
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-fallback-one',
              output: { path: 'generic-one.txt' },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-fallback-two',
              output: { path: 'generic-two.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
        if (targetPath === 'generic-one.txt') return jsonLlmResponse(singleTargetWriteProposal('generic-one.txt', `fallback-${caseName}-one`));
        if (targetPath === 'generic-two.txt') return failedBranchResponse();
        throw new Error(`unexpected sub-agent target in fallback smoke: ${targetPath}`);
      }
      parentLlmCalls += 1;
      const promptText = request.messages.map((message) => message.content).join('\n');
      assert(promptText.includes('子代理并行草稿已全部丢弃'), 'parent fallback prompt explains discarded sub-agent drafts');
      assert(promptText.includes('不得把未提交草稿当成已执行事实'), 'parent fallback prompt prevents treating failed drafts as facts');
      return jsonLlmResponse(multiWriteProposal());
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + proposalSubmits + actionBatchSubmits + deltas.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: `run-accepted-plan-subagents-fallback-${caseName}`,
    targetId: 'impl-generic-independent',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 2, `${caseName}: sub-agent path attempts both independent slices once`);
  assertEqual(parentLlmCalls, 1, `${caseName}: failed branch falls back to one parent provider checkpoint`);
  assertEqual(proposalSubmits, 1, `${caseName}: only parent fallback actionBundle reaches Kernel PlanReview`);
  assertEqual(actionBatchSubmits, 1, `${caseName}: only parent fallback actionBundle reaches Kernel execution`);
  assertEqual(result.events.some((event) => event.kind === 'error'), false, `${caseName}: branch failure does not become a terminal Session error event`);
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_branch.failed' &&
      (delta as any).status === 'failed'
    ),
    true,
    `${caseName}: failed branch is projected as a branch-scoped stage`
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_merge.discarded' &&
      (delta as any).payload?.reason === 'branch_failed' &&
      Array.isArray((delta as any).payload?.failedBranchIds) &&
      (delta as any).payload.failedBranchIds.length === 1
    ),
    true,
    `${caseName}: failed branch discards the merge group with diagnostics`
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_parent_fallback'
    ),
    true,
    `${caseName}: parent fallback checkpoint is visible`
  );
  const actionBundle = submittedPlans[0]?.payload?.actionBundle;
  assertEqual(Array.isArray(actionBundle?.actions) && actionBundle.actions.length, 2, `${caseName}: parent fallback submits the full merged batch`);
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsTreatLegacyDependenciesAsSoftOrder(): Promise<void> {
  const events = [multiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-soft', 'run-accepted-plan-subagents-soft')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-soft',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      const deepcode = request.providerOptions?.deepcode as any;
      const targetPath = deepcode?.subAgent?.targetPath;
      if (targetPath === 'generic-one.txt') return jsonLlmResponse(singleTargetWriteProposal('generic-one.txt', 'soft-one'));
      if (targetPath === 'generic-two.txt') return jsonLlmResponse(singleTargetWriteProposal('generic-two.txt', 'soft-two'));
      throw new Error('legacy soft-order smoke expected sliced provider calls');
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + llmCalls + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-soft',
    targetId: 'impl-generic-multi',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(llmCalls, 2, 'legacy implementationPlan dependencies are treated as soft order for sub-agent draft generation');
  assertEqual(proposalSubmits, 1, 'soft-order sub-agent fragments merge into one Kernel PlanReview submission');
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_plan.created'
    ),
    true,
    'soft-order sub-agent path emits subagent_plan.created'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_branch.draft_ready' &&
      (delta as any).status === 'draftReady'
    ),
    true,
    'soft-order sub-agent path emits branch draft-ready facts'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanSubAgentsSkipHardDependency(): Promise<void> {
  const events = [hardDependencyAcceptedImplementationPlanCardEvent('session-accepted-plan-subagents-hard', 'run-accepted-plan-subagents-hard')];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-accepted-plan-subagents-hard',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let parentLlmCalls = 0;
  let subAgentLlmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      const deepcode = request.providerOptions?.deepcode as any;
      if (deepcode?.subAgent) {
        subAgentLlmCalls += 1;
      } else {
        parentLlmCalls += 1;
      }
      return jsonLlmResponse(singleTargetWriteProposal('generic-one.txt', 'hard-parent'));
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + parentLlmCalls + subAgentLlmCalls + deltas.length + 1}`,
  });

  await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-subagents-hard',
    targetId: 'impl-generic-hard',
    existingEvents: events,
    subAgentMode: 'auto',
    subAgentMaxParallel: 2,
  });

  assertEqual(subAgentLlmCalls, 0, 'hard dependency blocks sub-agent parallel draft calls');
  assert(parentLlmCalls >= 1, 'hard dependency fallback continues through the parent provider');
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).stage === 'subagent_skipped' &&
      (delta as any).payload?.reason === 'hard_dependency_blocked'
    ),
    true,
    'hard dependency skip emits explicit subagent_skipped reason'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAutoExecutesDeleteAction(): Promise<void> {
  const events = [deleteAcceptedImplementationPlanCardEvent('session-accepted-plan-delete', 'run-accepted-plan-delete')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-delete', actionId: 'delete-generic-obsolete', status: 'queued', writeSet: ['generic-obsolete.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-delete',
              output: { path: 'generic-obsolete.txt' },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(deleteActionBundleProposal('generic-obsolete.txt')),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'delete-only accepted implementationPlan batch still reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'delete-only accepted implementationPlan batch is auto-executed without codeBlocks');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'in-scope delete action does not become a user intervention');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'delete action does not create a second confirmable plan card');
}

async function assertSessionDriverLoopAcceptedImplementationPlanRejectsDeleteRootTarget(): Promise<void> {
  const events = [deleteAcceptedImplementationPlanCardEvent('session-accepted-plan-delete-root', 'run-accepted-plan-delete-root')];
  const session: AgentSession = {
    id: 'session-accepted-plan-delete-root',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'proposalSubmit') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(deleteActionBundleProposal('.')),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-delete-root',
    targetId: 'impl-generic-delete',
    existingEvents: events,
  });

  assertEqual(actionBatchSubmits, 0, 'delete root target is rejected before Kernel actionBatchSubmit');
  assert(
    result.events.some((event) =>
      String((event.payload as any)?.content ?? (event.payload as any)?.summary ?? '').includes('workspace.delete target cannot be empty or the workspace root')
    ),
    'delete root rejection explains that the target cannot be the workspace root'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAllowsPlannedProcessExecPermissionGate(): Promise<void> {
  const events = [processExecAcceptedImplementationPlanCardEvent('session-accepted-plan-exec', 'run-accepted-plan-exec')];
  const session: AgentSession = {
    id: 'session-accepted-plan-exec',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [{
            kind: 'permission.requested',
            runId: 'run-generic',
            sessionId: session.id,
            permissionId: 'permission-exec-generic',
            request: {
              id: 'permission-exec-generic',
              capability: 'process.exec',
              summary: 'Run a generic validation command.',
            },
          }],
        };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(processExecProposal()),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-exec',
    targetId: 'impl-generic-exec',
    existingEvents: events,
  });

  assertEqual(proposalSubmits, 1, 'planned process.exec batch reaches Kernel PlanReview');
  assertEqual(actionBatchSubmits, 1, 'planned process.exec batch reaches Kernel execution path');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'planned process.exec is not converted into a Session requirement');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'permission'
    ),
    true,
    'planned process.exec waits at Kernel PermissionGate'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanContinuesUntilTasksComplete(): Promise<void> {
  const events = [multiTargetAcceptedImplementationPlanCardEvent('session-accepted-plan-continue', 'run-accepted-plan-continue')];
  const session: AgentSession = {
    id: 'session-accepted-plan-continue',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const proposals = [
    relativeTargetWriteProposal('generic-one.txt', 'code-one', 'write-generic-one'),
    relativeTargetWriteProposal('generic-two.txt', 'code-two', 'write-generic-two'),
  ];
  let llmCalls = 0;
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        const action = command.batch?.actionBundle?.actions?.[0] ?? {};
        const actionId = action.id ?? action.actionId ?? `write-generic-${actionBatchSubmits}`;
        const path = action.targetPath ?? action.resourceScope?.[0] ?? `generic-${actionBatchSubmits}.txt`;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: `work-unit-${actionBatchSubmits}`, actionId, status: 'queued', writeSet: [path] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: `work-unit-${actionBatchSubmits}`,
              output: { path },
            },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      const proposal = proposals[Math.min(llmCalls, proposals.length - 1)];
      llmCalls += 1;
      return jsonLlmResponse(proposal);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-continue',
    targetId: 'impl-generic-multi',
    existingEvents: events,
    subAgentMode: 'off',
  });

  assertEqual(llmCalls, 2, 'accepted implementationPlan automatically requests the second provider batch');
  assertEqual(actionBatchSubmits, 2, 'accepted implementationPlan executes both in-scope batches');
  assertEqual(result.events.filter((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'waitingUserReview').length, 1, 'accepted implementationPlan produces only one terminal review');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'workflow_stage' &&
      (event.payload as any)?.stage === 'accepted_plan.batch_checkpoint' &&
      Array.isArray((event.payload as any)?.remainingTaskIds) &&
      (event.payload as any).remainingTaskIds.includes('task-generic-two')
    ),
    true,
    'first accepted-plan checkpoint keeps the remaining task queued'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanAllowsAbsoluteAttachmentChildTarget(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-absolute-child', root),
    acceptedImplementationPlanCardEvent('session-accepted-plan-absolute-child', 'run-accepted-plan-absolute-child'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-absolute-child',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}, root),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(absoluteTargetWriteProposal(`${root}/generic-output.txt`)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-absolute-child',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(actionBatchSubmits, 1, 'absolute child target under accepted attachment root is auto-executed');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), false, 'absolute child target does not trigger scope intervention');
}

async function assertSessionDriverLoopAcceptedImplementationPlanRejectsAttachmentRootTarget(): Promise<void> {
  const root = '/workspace/generic-project';
  const events: AgentEvent[] = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-root-target', root),
    acceptedImplementationPlanCardEvent('session-accepted-plan-root-target', 'run-accepted-plan-root-target'),
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-root-target',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(absoluteTargetWriteProposal(root)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-root-target',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
  });

  assertEqual(actionBatchSubmits, 0, 'attachment root target is rejected before Kernel actionBatchSubmit');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'attachment root target becomes one scope intervention');
  assert(
    result.events.some((event) => String((event.payload as any)?.summary ?? '').includes('不是可写入文件')),
    'attachment root target intervention explains that the target is a directory root'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanProjectsWorkUnitFailureReason(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-failure', 'run-accepted-plan-failure')];
  const session: AgentSession = {
    id: 'session-accepted-plan-failure',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        return {
          ok: true,
          events: [
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'queued', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.started',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic', actionId: 'write-generic-output', status: 'running', writeSet: ['generic-output.txt'] },
            },
            {
              kind: 'work_unit.failed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic',
              actionId: 'write-generic-output',
              writeSet: ['generic-output.txt'],
              error: { code: 'invalid_path', message: 'workspace.write target is outside workspace binding' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') {
        reviewFactsRequests += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-failure',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  const errorMessage = result.events
    .filter((event) => event.kind === 'error')
    .map((event) => String((event.payload as any)?.message ?? ''))
    .join('\n');
  assert(errorMessage.includes('work-unit-generic'), 'work_unit.failed projection includes the work unit id');
  assert(errorMessage.includes('workspace.write target is outside workspace binding'), 'work_unit.failed projection includes the Kernel error message');
  assert(!errorMessage.includes('Kernel rejected the proposal'), 'work_unit.failed projection is not mislabeled as proposal rejection');
  assertEqual(reviewFactsRequests, 0, 'work_unit.failed stops accepted-plan flow before reviewFactsGet');
  assertEqual(result.events.some((event) => event.kind === 'review_summary'), false, 'work_unit.failed does not create terminal review');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'failed' &&
      (event.payload as any)?.reason === 'work_unit_failed'
    ),
    true,
    'work_unit.failed appends explicit failed session lifecycle'
  );
  const failureCheckpoint = result.events.find((event) =>
    event.kind === 'workflow_stage' &&
    (event.payload as any)?.stage === 'accepted_plan.batch_failed'
  );
  assert(Boolean(failureCheckpoint), 'work_unit.failed records an accepted-plan failure checkpoint');
  assert(
    JSON.stringify((failureCheckpoint?.payload as any)?.failures ?? []).includes('generic-output.txt'),
    'failure checkpoint retains writeSet details'
  );
}

async function assertSessionDriverLoopAcceptedImplementationPlanRejectsOutOfScopeBatch(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-accepted-plan-oos', 'run-accepted-plan-oos')];
  const session: AgentSession = {
    id: 'session-accepted-plan-oos',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  const outOfScopeProposal = genericWriteProposal(false);
  (outOfScopeProposal.codeBlocks as any[])[0].path = 'outside-output.txt';
  (outOfScopeProposal.actionBundle as any).actions[0].resourceScope = ['outside-output.txt'];
  (outOfScopeProposal.actionBundle as any).actions[0].targetPath = 'outside-output.txt';
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return { ok: true, events: [] };
      }
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(outOfScopeProposal),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + proposalSubmits + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-oos',
    targetId: 'impl-generic-auto',
    existingEvents: events,
    interventionLevel: 'medium',
  });

  assertEqual(proposalSubmits, 0, 'out-of-scope accepted implementationPlan batch does not reach Kernel PlanReview');
  assertEqual(actionBatchSubmits, 0, 'out-of-scope accepted implementationPlan batch is not executed');
  assertEqual(result.events.filter((event) => event.kind === 'plan_card').length, 1, 'out-of-scope batch does not create another plan card');
  assertEqual(result.events.some((event) => event.kind === 'requirement_confirmation'), true, 'out-of-scope batch becomes one user intervention request');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'waiting' &&
      (event.payload as any)?.reason === 'requirement'
    ),
    true,
    'out-of-scope batch records waiting requirement session state'
  );
}

async function assertSessionDriverLoopAcceptedPlanPatchRequestsSearchEvidence(): Promise<void> {
  const planEvent = acceptedImplementationPlanCardEvent('session-accepted-plan-patch-evidence', 'run-accepted-plan-patch-evidence');
  const planPayload = planEvent.payload as any;
  planPayload.planId = 'impl-generic-patch';
  planPayload.implementationPlan.id = 'impl-generic-patch';
  planPayload.implementationPlan.tasks = [{
    taskId: 'task-generic-patch',
    title: 'Patch generic file',
    target: ['generic-patch.txt'],
    scope: 'Patch one generic file with exact ResourcePacket evidence.',
    dependencies: [],
    capability: 'workspace.write',
    acceptanceCriteria: ['Kernel records the generic patch work unit fact.'],
    failureCriteria: ['Stop if the patch lacks current exact-block evidence.'],
  }];
  const root = '/workspace/generic-project';
  const events = [
    userMessageWithDirectoryAttachmentEvent('session-accepted-plan-patch-evidence', root),
    planEvent,
  ];
  const session: AgentSession = {
    id: 'session-accepted-plan-patch-evidence',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  let proposalSubmits = 0;
  let actionBatchSubmits = 0;
  let resourceSearchRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'resourceResolve') {
        const entry = command.request?.manifest?.entries?.[0] ?? {};
        if (entry.kind === 'search') resourceSearchRequests += 1;
        return {
          ok: true,
          events: [{
            kind: 'resource.packet_produced',
            packet: {
              id: `packet-generic-${resourceSearchRequests}`,
              requestId: command.requestId,
              items: [{
                requestItemId: 'search-item',
                manifestEntryId: entry.id ?? 'search-entry',
                status: 'resolved',
                readPolicy: 'explicit-manifest-readonly',
                sourceKind: entry.kind,
                resolvedKind: entry.kind,
                contentKind: entry.kind === 'search' ? 'searchResults' : 'directoryTree',
                path: entry.kind === 'search' ? 'generic-patch.txt' : entry.resourceRef,
                absolutePath: entry.resourceRef,
                query: entry.query,
                matches: entry.kind === 'search'
                  ? [{ path: 'generic-patch.txt', line: 1, preview: 'old generic line' }]
                  : undefined,
                returnedMatches: entry.kind === 'search' ? 1 : undefined,
                promptContent: entry.kind === 'search'
                  ? JSON.stringify({ matches: [{ path: 'generic-patch.txt', line: 1, preview: 'old generic line' }] })
                  : undefined,
                nodes: entry.kind === 'search' ? undefined : [{ type: 'file', path: 'generic-patch.txt' }],
                evidenceRefs: ['evidence-generic-patch'],
              }],
            },
          }],
        };
      }
      if (command.kind === 'proposalSubmit') {
        proposalSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'proposal.accepted', runId: 'run-generic', sessionId: session.id, proposal: command.proposal },
            {
              kind: 'proposal.reviewed',
              runId: 'run-generic',
              sessionId: session.id,
              proposalId: command.proposal?.proposalId,
              report: proposalReviewReport(command.proposal?.payload?.actionBundle ?? {}),
            },
          ],
        };
      }
      if (command.kind === 'permissionGrantTemporary') return { ok: true, events: [] };
      if (command.kind === 'actionBatchSubmit') {
        actionBatchSubmits += 1;
        return {
          ok: true,
          events: [
            { kind: 'action_batch.accepted', runId: 'run-generic', sessionId: session.id, batch: { planId: command.batch?.planId } },
            {
              kind: 'work_unit.queued',
              runId: 'run-generic',
              sessionId: session.id,
              workUnit: { id: 'work-unit-generic-patch', actionId: 'patch-generic-output', status: 'queued', writeSet: ['generic-patch.txt'] },
            },
            {
              kind: 'work_unit.completed',
              runId: 'run-generic',
              sessionId: session.id,
              workUnitId: 'work-unit-generic-patch',
              output: { path: 'generic-patch.txt' },
            },
            { kind: 'stage.changed', runId: 'run-generic', sessionId: session.id, phase: 'review' },
          ],
        };
      }
      if (command.kind === 'reviewFactsGet') return { ok: true, events: [] };
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls === 1) return jsonLlmResponse(genericPatchProposal());
      if (llmCalls === 2) {
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'resourceRequest',
          outputLanguage: 'en-US',
          resourceRequest: {
            version: '1',
            id: 'need-generic-patch-anchor',
            reason: 'Need current exact-block evidence before patching.',
            items: [{
              id: 'search-generic-patch-anchor',
              kind: 'search',
              query: 'old generic line',
              include: ['generic-patch.txt'],
              contextLines: 1,
              maxResults: 5,
              reason: 'Find the generic exact patch anchor.',
            }],
          },
        });
      }
      return jsonLlmResponse(genericPatchProposal());
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + proposalSubmits + actionBatchSubmits + resourceSearchRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'accept',
    runId: 'run-accepted-plan-patch-evidence',
    targetId: 'impl-generic-patch',
    existingEvents: events,
    projectWorkingDirectory: {
      rootId: 'project-root-generic',
      kind: 'directory',
      label: 'Generic project',
      displayPath: root,
      absolutePath: root,
      source: 'projectWorkingDirectory',
    } as any,
    interventionLevel: 'medium',
  });

  assertEqual(resourceSearchRequests, 1, 'patch without evidence is repaired through one search ResourceResolve');
  assertEqual(proposalSubmits, 1, 'patch action reaches Kernel PlanReview only after ResourcePacket evidence exists');
  assertEqual(actionBatchSubmits, 1, 'patch action executes after exact-block evidence is available');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'search ResourcePacket is committed before patch execution');
}

async function assertSessionDriverLoopReviewAcceptAutoGeneratesNextPlan(): Promise<void> {
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
  assertEqual(acceptedPayload.continuationRequested, false, 'review accept closes the current review before continuation planning');
  assert(String(acceptedPayload.content ?? '').includes('确认后的合规 actionBundle 会自动提交 Kernel 执行'), 'accepted review explains confirmed continuation batches auto-submit to Kernel');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'completed' &&
      (event.payload as any)?.reason === 'review'
    ),
    false,
    'auto continuation review accept does not mark the current run completed before continuation planning'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), true, 'default review continuation mode generates the next plan');
  assertEqual(submittedPlans.length, 1, 'default review continuation mode submits the next actionBundle for Kernel PlanReview');
  assertEqual(llmRequests.length, 1, 'default review continuation mode calls the provider once for a new plan');
}

async function assertSessionDriverLoopReviewAcceptWithoutContinuationCompletesRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-terminal-generic',
    sessionId: 'session-review-terminal',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-terminal',
      reviewId: 'review-terminal-generic',
      sourcePlanId: 'plan-terminal-generic',
      content: '## Review\n\nThe generic batch completed.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-terminal',
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
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-terminal', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-terminal',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-terminal',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'terminal review accept records an accepted review event');
  const completedState = result.events.find((event) =>
    event.kind === 'session_run_state' &&
    (event.payload as any)?.status === 'completed' &&
    (event.payload as any)?.reason === 'review'
  );
  assert(Boolean(completedState), 'terminal review accept records an explicit completed session state');
  const completedPayload = completedState?.payload as any;
  assertEqual(completedPayload.phase, 'completed', 'terminal review completed state carries completed phase');
  assertEqual(completedPayload.decisionKind, 'review', 'terminal review completed state keeps review owner kind');
  assertEqual(completedPayload.targetId, 'review-terminal-generic', 'terminal review completed state keeps review owner target');
  assertEqual(submittedPlans.length, 0, 'terminal review accept does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'terminal review accept does not call the provider');
}

async function assertSessionDriverLoopReviewAcceptOffStopsAtCurrentBatch(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-accept-off-generic',
    sessionId: 'session-review-accept-off',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-accept-off',
      reviewId: 'review-accept-off-generic',
      sourcePlanId: 'plan-accept-off-generic',
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
    id: 'session-review-accept-off',
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
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-review-accept-off', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: 'session-review-accept-off',
    kind: 'review',
    decision: 'accept',
    runId: 'run-review-accept-off',
    existingEvents: events,
    reviewContinuationMode: 'off',
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'review accept records an accepted review event');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'session_run_state' &&
      (event.payload as any)?.status === 'completed' &&
      (event.payload as any)?.reason === 'review'
    ),
    true,
    'off review continuation mode records an explicit completed session state'
  );
  assertEqual(result.events.some((event) => event.kind === 'plan_card'), false, 'off review continuation mode does not generate a continuation plan');
  assertEqual(submittedPlans.length, 0, 'off review continuation mode does not submit a new plan');
  assertEqual(llmRequests.length, 0, 'off review continuation mode does not call the provider');
}

async function assertSessionDriverLoopRequirementRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'requirement-waiting-generic',
    sessionId: 'session-requirement-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'requirement_confirmation',
    payload: {
      title: 'Requirement confirmation',
      summary: 'Confirm a generic requirement.',
      content: 'Confirm how to proceed with a generic request.',
      originalRequest: 'Create a generic workspace change.',
      runId: 'run-requirement-reject',
      requirementId: 'requirement-generic-reject',
      status: 'waitingUserConfirmation',
      confirmable: true,
    },
  }];
  const session: AgentSession = {
    id: 'session-requirement-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => fakeKernel(request),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'requirement',
    decision: 'reject',
    runId: 'run-requirement-reject',
    targetId: 'requirement-generic-reject',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'requirement_decision' && (event.payload as any)?.status === 'rejected'), true, 'requirement reject records a rejected decision');
  assertCancelledRunState(result.events, 'requirement', 'run-requirement-reject', 'requirement-generic-reject');
  assertEqual(llmCalls, 0, 'requirement reject does not call the provider');
}

async function assertSessionDriverLoopPlanRejectCancelsRun(): Promise<void> {
  const events = [acceptedImplementationPlanCardEvent('session-plan-reject', 'run-plan-reject')];
  const session: AgentSession = {
    id: 'session-plan-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let actionBatchSubmits = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'actionBatchSubmit') actionBatchSubmits += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + actionBatchSubmits + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'plan',
    decision: 'reject',
    runId: 'run-plan-reject',
    targetId: 'impl-generic-auto',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'plan_review' && (event.payload as any)?.status === 'rejected'), true, 'plan reject records a rejected plan decision');
  assertCancelledRunState(result.events, 'plan_review', 'run-plan-reject', 'impl-generic-auto');
  assertEqual(actionBatchSubmits, 0, 'plan reject does not submit an action batch');
}

async function assertSessionDriverLoopReviewRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'review-waiting-reject-generic',
    sessionId: 'session-review-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'review_summary',
    payload: {
      status: 'waitingUserReview',
      runId: 'run-review-reject',
      reviewId: 'review-generic-reject',
      sourcePlanId: 'plan-generic-reject',
      content: '## Review\n\nA generic batch is ready.',
      userPlan: '# Plan\n\n## Summary\nCreate a generic batch.',
      facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
      continuations: [{ id: 'next-generic', title: 'A generic follow-up task.' }],
      confirmable: true,
      channel: 'review',
      visibility: 'conversation',
    },
  }];
  const session: AgentSession = {
    id: 'session-review-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let userDecisionSubmits = 0;
  let llmCalls = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'userDecisionSubmit') {
        userDecisionSubmits += 1;
        assertEqual(command.decision?.payload?.decision, 'reject', 'review ignore sends a reject user decision to Kernel audit');
        assertEqual(command.decision?.payload?.continuationRequested, false, 'review reject does not request continuation');
        assertEqual(command.decision?.payload?.revisionRequested, false, 'review reject does not request revision');
        return { ok: true, events: [] };
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + userDecisionSubmits + llmCalls + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'review',
    decision: 'reject',
    runId: 'run-review-reject',
    existingEvents: events,
  });

  assertEqual(result.events.some((event) => event.kind === 'review_summary' && (event.payload as any)?.status === 'rejected'), true, 'review reject records a rejected review decision');
  assertCancelledRunState(result.events, 'review', 'run-review-reject', 'review-generic-reject');
  assertEqual(userDecisionSubmits, 1, 'review reject records exactly one Kernel user decision');
  assertEqual(llmCalls, 0, 'review reject does not call the provider for revision or continuation');
}

async function assertSessionDriverLoopPermissionRejectCancelsRun(): Promise<void> {
  const events: AgentEvent[] = [{
    id: 'permission-request-generic',
    sessionId: 'session-permission-reject',
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'permission_request',
    payload: {
      id: 'permission-generic-reject',
      runId: 'run-permission-reject',
      planId: 'plan-permission-reject',
      status: 'pending',
      summary: 'A generic permission request is pending.',
    },
  }];
  const session: AgentSession = {
    id: 'session-permission-reject',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  let permissionResolves = 0;
  let reviewFactsRequests = 0;
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => {
      const command = request.command as Record<string, any>;
      if (command.kind === 'permissionResolve') {
        permissionResolves += 1;
        assertEqual(command.decision, 'reject', 'permission ignore sends a reject decision to Kernel');
        return {
          ok: true,
          events: [{
            kind: 'permission.resolved',
            permissionId: 'permission-generic-reject',
            runId: 'run-permission-reject',
            sessionId: session.id,
            decision: 'reject',
          }],
        };
      }
      if (command.kind === 'reviewFactsGet') reviewFactsRequests += 1;
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => jsonLlmResponse(genericWriteProposal(false)),
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + permissionResolves + reviewFactsRequests + 1}`,
  });

  const result = await loop.resolveDecision({
    sessionId: session.id,
    kind: 'permission',
    decision: 'reject',
    runId: 'run-permission-reject',
    targetId: 'permission-generic-reject',
    existingEvents: events,
  });

  assertCancelledRunState(result.events, 'permission', 'run-permission-reject', 'permission-generic-reject');
  assertEqual(permissionResolves, 1, 'permission reject resolves exactly one Kernel permission request');
  assertEqual(reviewFactsRequests, 0, 'permission reject does not continue into review facts');
}

async function assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept(): Promise<void> {
  const events: AgentEvent[] = [
    {
      id: 'old-requirement-generic',
      sessionId: 'session-stale-interaction',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'requirement_confirmation',
      payload: {
        title: 'Requirement confirmation',
        summary: 'Confirm an earlier generic requirement.',
        content: 'Create a generic workspace change.',
        originalRequest: 'Create a generic workspace change.',
        runId: 'run-stale-requirement',
        requirementId: 'requirement-stale-generic',
        status: 'waitingUserConfirmation',
        confirmable: true,
      },
    },
    {
      id: 'new-review-generic',
      sessionId: 'session-stale-interaction',
      ts: '2026-01-01T00:00:01.000Z',
      kind: 'review_summary',
      payload: {
        status: 'waitingUserReview',
        runId: 'run-current-review',
        reviewId: 'review-current-generic',
        sourcePlanId: 'plan-current-generic',
        content: '## Review\n\nThe current generic batch is ready for review.',
        userPlan: '# Plan\n\n## Summary\nReview the current generic batch.',
        facts: ['- `work-unit-generic` completed: {"path":"generic-output.txt"}'],
        continuations: [{
          id: 'next-generic-batch',
          title: 'Record a later generic continuation.',
          capability: 'workspace.write',
          kind: 'write',
          resourceScope: ['generic-follow-up.txt'],
        }],
        confirmable: true,
      },
    },
  ];
  const session: AgentSession = {
    id: 'session-stale-interaction',
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
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-stale-interaction', submittedPlans),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmRequests.push(request);
      return jsonLlmResponse(genericWriteProposal(false));
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + llmRequests.length + 1}`,
  });

  const accepted = await loop.resolveDecision({
    sessionId: 'session-stale-interaction',
    kind: 'review',
    decision: 'accept',
    runId: 'run-current-review',
    existingEvents: events,
    reviewContinuationMode: 'off',
  });
  assertEqual(accepted.events.some((event) => event.kind === 'review_summary' && (event.payload as any).status === 'accepted'), true, 'current review is accepted');

  const stale = await loop.resolveDecision({
    sessionId: 'session-stale-interaction',
    kind: 'requirement',
    decision: 'accept',
    runId: 'run-stale-requirement',
    targetId: 'requirement-stale-generic',
    existingEvents: accepted.events,
  });

  assertEqual(stale.events.some((event) => event.kind === 'trace/requirement_decision_noop'), true, 'stale requirement decision is recorded as noop');
  assertEqual(llmRequests.length, 0, 'stale requirement decision does not call the provider');
  assertEqual(submittedPlans.length, 0, 'stale requirement decision does not submit a plan');
}

async function assertSessionDriverLoopNativeReadToolStreamsThroughResourceResolve(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-native-read',
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
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native read smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (streamRequests.length === 1) {
        const chunks: LlmChatResult['chunks'] = [
          {
            type: 'tool_call',
            index: 0,
            callId: 'call-generic-read',
            toolCallDelta: { id: 'call-generic-read', index: 0, name: 'fs.read', argumentsDelta: '{"path":"' },
          },
          {
            type: 'tool_call',
            index: 0,
            callId: 'call-generic-read',
            toolCallDelta: { index: 0, argumentsDelta: 'generic-input.txt"}' },
          },
          { type: 'done' },
        ];
        for (const chunk of chunks.slice(0, 2)) {
          await onEvent({ type: 'provider_tool_call_delta', chunk });
        }
        return {
          ok: true,
          data: {
            chunks,
            assistantMessage: {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call-generic-read',
                name: 'fs.read',
                arguments: { path: 'generic-input.txt' },
              }],
            },
          },
        };
      }
      const toolMessage = request.messages.find((message) => message.role === 'tool');
      assert(Boolean(toolMessage?.content.includes('resolved generic content')), 'provider resume receives Kernel resource tool result');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'en-US',
        answer: {
          format: 'markdown',
          content: 'The generic read result was incorporated after Kernel ResourceResolve.',
        },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read',
    content: 'Use a native read tool only if resource context is needed.',
    attachments: [{ kind: 'directory', path: '.', absolutePath: '/tmp/generic-workspace', source: 'userSelected', scope: 'session' }],
  });

  assertEqual(streamRequests.length, 2, 'native read tool triggers provider resume after Kernel result');
  assertEqual(resourceResolveManifests.length >= 1, true, 'native read tool is routed through Kernel ResourceResolve');
  assertEqual(
    resourceResolveManifests.some((manifest) =>
      (manifest.entries ?? []).some((entry: Record<string, unknown>) => String(entry.resourceRef ?? '').endsWith('generic-input.txt'))
    ),
    true,
    'native read manifest carries the requested resource'
  );
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), true, 'Kernel ResourcePacket is committed as tool_result');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any).channel === 'final'), true, 'provider resume produces one final answer');
  assertEqual(deltas.some((delta) => (delta as any).type === 'tool_call_delta'), true, 'streaming native tool deltas are exposed as active projection deltas');
}

async function assertSessionDriverLoopNativeReadToolLoopHasNoFourRoundLimit(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  const deltas: unknown[] = [];
  const session: AgentSession = {
    id: 'session-native-read-unbounded',
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
      if (command.kind === 'resourceResolve') {
        resourceResolveManifests.push(command.request.manifest);
      }
      return fakeKernel(request);
    },
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native read unbounded smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      const round = streamRequests.length;
      if (round <= 6) {
        const path = `generic-input-${round}.txt`;
        const chunk: LlmChatResult['chunks'][number] = {
          type: 'tool_call',
          index: 0,
          callId: `call-generic-read-${round}`,
          toolCallDelta: {
            id: `call-generic-read-${round}`,
            index: 0,
            name: 'fs.read',
            argumentsDelta: JSON.stringify({ path }),
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
              toolCalls: [{
                id: `call-generic-read-${round}`,
                name: 'fs.read',
                arguments: { path },
              }],
            },
          },
        };
      }
      const toolMessages = request.messages.filter((message) => message.role === 'tool');
      assertEqual(toolMessages.length >= 6, true, 'provider resume receives all prior Kernel resource tool results');
      return jsonLlmResponse({
        schemaVersion: 'deepcode.agent.protocol.v3',
        kind: 'answer',
        outputLanguage: 'zh-CN',
        answer: {
          format: 'markdown',
          content: '已在多轮只读资源读取后收口。',
        },
      });
    },
    onProjectionDelta: async (delta) => {
      deltas.push(delta);
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + streamRequests.length + resourceResolveManifests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-read-unbounded',
    content: '分析这个项目，需要连续读取多个只读文件后再回答。',
    attachments: [{ kind: 'directory', path: '.', absolutePath: '/tmp/generic-workspace', source: 'userSelected', scope: 'session' }],
  });

  assertEqual(streamRequests.length, 7, 'native read tool loop continues past the former four-resume limit and then converges');
  assertEqual(resourceResolveManifests.length >= 6, true, 'each native read tool request is routed through Kernel ResourceResolve');
  assertEqual(result.events.some((event) => event.id.includes('native_tool_loop_exhausted')), false, 'native read tool loop does not emit the former exhaustion diagnostic');
  assertEqual(
    result.events.some((event) =>
      event.kind === 'assistant_msg' &&
      (event.payload as any)?.source === 'session' &&
      String((event.payload as any)?.content ?? '').includes('原生工具')
    ),
    false,
    'native tool progress metadata does not become Session-authored conversation narration'
  );
  assertEqual(
    deltas.some((delta) =>
      (delta as any).type === 'stage_delta' &&
      (delta as any).summary === 'native_tool_checkpoint' &&
      Number((delta as any).payload?.nativeToolRound ?? -1) >= 4
    ),
    true,
    'high-round native tool checkpoints are exposed as task/debug projection metadata'
  );
  assertEqual(deltas.some((delta) => (delta as any).type === 'tool_call_delta'), true, 'high-round native tool deltas remain visible');
}

async function assertSessionDriverLoopNativeWriteToolTriggersImplementationPlanRepair(): Promise<void> {
  const events: AgentEvent[] = [];
  const submittedPlans: Array<Record<string, any>> = [];
  const streamRequests: LlmChatRequest[] = [];
  let repairCalls = 0;
  const session: AgentSession = {
    id: 'session-native-write',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => planKernel(request, 'session-native-write', submittedPlans),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      throw new Error('native write smoke should use streaming provider path');
    },
    llmChatStream: async (request, onEvent): Promise<ApiResponse<LlmChatResult>> => {
      streamRequests.push(request);
      if (!request.tools?.length) {
        repairCalls += 1;
        return jsonLlmResponse({
          schemaVersion: 'deepcode.agent.protocol.v3',
          kind: 'implementationPlan',
          outputLanguage: 'zh-CN',
          narration: '我先把写入任务拆成可审查的计划，确认后再进入编辑。',
          implementationPlan: {
            version: '1',
            id: 'impl-generic-native-write',
            title: 'Generic write plan',
            summary: 'Plan a write task without executing native side-effect tools.',
            tasks: [{
              taskId: 'task-generic-write',
              title: 'Prepare generic output',
              target: ['generic-output.txt'],
              scope: 'Prepare a reviewed file write through the Plan/Edit path.',
              dependencies: [],
              capability: 'workspace.write',
              acceptanceCriteria: ['A later accepted edit batch carries codeBlocks and Kernel write facts.'],
              failureCriteria: ['Stop if the target cannot be resolved under the workspace.'],
            }],
            risks: ['Workspace write requires user review.'],
            reviewCheckpoints: ['Review before edit batch generation.'],
          },
        });
      }
      const chunk: LlmChatResult['chunks'][number] = {
        type: 'tool_call',
        index: 0,
        callId: 'call-generic-write',
        toolCallDelta: {
          id: 'call-generic-write',
          index: 0,
          name: 'fs.write',
          argumentsDelta: '{"path":"generic-output.txt","content":"generic content"}',
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
            toolCalls: [{
              id: 'call-generic-write',
              name: 'fs.write',
              arguments: { path: 'generic-output.txt', content: 'generic content' },
            }],
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + submittedPlans.length + streamRequests.length + 1}`,
  });

  const result = await loop.runUserTurn({
    sessionId: 'session-native-write',
    content: '请把 native write 只作为需要审查的计划。',
  });

  assertEqual(streamRequests.length, 2, 'native write is followed by one streaming protocol repair');
  assertEqual(repairCalls, 1, 'native write side effect triggers one protocol repair');
  assertEqual(submittedPlans.length, 0, 'native write is not submitted to Kernel PlanReview as an actionBundle');
  const planCard = result.events.find((event) => event.kind === 'plan_card');
  const payload = planCard?.payload as any;
  assertEqual(Boolean(payload?.implementationPlan), true, 'native write repair produces an implementationPlan card');
  assertEqual(Array.isArray(payload?.codeBlocks) && payload.codeBlocks.length === 0, true, 'implementationPlan repair does not carry codeBlocks');
  assert(String(payload?.content ?? '').includes('## 边界'), 'Chinese plan card localizes boundary heading');
  assert(!String(payload?.content ?? '').includes('This plan is not execution'), 'Chinese plan card does not keep English boundary text');
  assertEqual(result.events.some((event) => event.kind === 'tool_result'), false, 'native write is not executed as an immediate tool result');
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

function absoluteTargetWriteProposal(targetPath: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    id: 'generic-block',
    path: targetPath,
    targetPath,
    content: 'generic content',
  }];
  (proposal.actionBundle as any).actions[0].resourceScope = [targetPath];
  (proposal.actionBundle as any).actions[0].targetPath = targetPath;
  return proposal;
}

function genericPatchProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Patch one previously reviewed generic file using an exact block copied from current ResourcePacket evidence.',
      '',
      '## Key Changes',
      '- Replace a single generic text block instead of rewriting the whole file.',
      '- Keep the edit anchored by patchSpec.match so Kernel can apply the change fail-closed.',
      '',
      '## Interfaces',
      '- Use workspace.write with kind=replaceBlock and replacementBlockId.',
      '- Use patchSpec.match.kind=exactBlock with text from current file or search evidence.',
      '',
      '## Test Plan',
      '- Kernel should record a patch work unit for the target file.',
      '- User review should inspect the patch target and generated replacement.',
      '',
      '## Assumptions',
      '- The target file is within the already accepted implementation plan scope.',
      '- The exact match block is present in the latest ResourcePacket evidence.',
    ].join('\n'),
    codeBlocks: [{
      id: 'generic-patch-replacement',
      path: 'generic-patch.txt',
      operation: 'replaceBlock',
      content: 'new generic line',
    }],
    actionBundle: {
      version: '1',
      id: 'generic-patch-bundle',
      goal: 'Patch a generic file with exact evidence.',
      actions: [{
        id: 'patch-generic-output',
        title: 'Patch generic output',
        capability: 'workspace.write',
        kind: 'replaceBlock',
        resourceScope: ['generic-patch.txt'],
        targetPath: 'generic-patch.txt',
        replacementBlockId: 'generic-patch-replacement',
        patchSpec: {
          match: {
            kind: 'exactBlock',
            text: 'old generic line',
          },
        },
      }],
      continuationExpectations: [],
      validationExpectations: [{ id: 'generic-patch-evidence', description: 'Kernel records the patch fact for the generic file.' }],
      reviewExpectations: [{ id: 'generic-patch-review', description: 'User reviews the generic patch scope.' }],
    },
    expectedValidation: 'Kernel records patch facts for the generic file.',
    reviewGuide: 'Review the generic patch target and replacement before approval.',
  };
}

function relativeTargetWriteProposal(targetPath: string, blockId: string, actionId: string): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [{
    id: blockId,
    targetPath,
    content: `content for ${targetPath}`,
  }];
  (proposal.actionBundle as any).id = `bundle-${actionId}`;
  (proposal.actionBundle as any).actions[0].id = actionId;
  (proposal.actionBundle as any).actions[0].title = `Write ${targetPath}`;
  (proposal.actionBundle as any).actions[0].resourceScope = [targetPath];
  (proposal.actionBundle as any).actions[0].targetPath = targetPath;
  (proposal.actionBundle as any).actions[0].sourceBlockId = blockId;
  return proposal;
}

function deleteActionBundleProposal(targetPath: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Delete one generic obsolete file already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one workspace.delete action with a concrete relative target.',
      '',
      '## Interfaces',
      '- Use workspace.delete directly; do not attach codeBlocks or sourceBlockId.',
      '',
      '## Test Plan',
      '- Kernel should record a delete work unit fact for the target.',
      '',
      '## Assumptions',
      '- The delete target is inside the accepted workspace scope.',
    ].join('\n'),
    codeBlocks: [],
    actionBundle: {
      version: '1',
      id: 'bundle-generic-delete',
      goal: 'Delete a generic obsolete file.',
      actions: [{
        id: 'delete-generic-obsolete',
        title: 'Delete generic obsolete file',
        kind: 'delete',
        capability: 'workspace.delete',
        resourceScope: [targetPath],
        targetPath,
        permissionLabels: ['workspace.delete'],
      }],
      continuationExpectations: [],
      validationExpectations: [{ id: 'generic-delete-evidence', description: 'Kernel records the delete fact for the generic obsolete file.' }],
      reviewExpectations: [{ id: 'generic-delete-review', description: 'User reviews the deleted target and Kernel facts.' }],
    },
    expectedValidation: 'Kernel records delete facts for the generic obsolete file.',
    reviewGuide: 'Review the generic delete target before approval.',
  };
}

function localizedGenericWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.outputLanguage = 'zh-CN';
  proposal.userPlan = [
    '# 通用计划',
    '',
    '## 概要',
    '为一个通用工作区变更创建一个小批次，保持范围可审查，并等待 Kernel 记录真实执行事实后再进入审查。',
    '',
    '## 关键变更',
    '- 从顶层代码块写入一个受控输出文件。',
    '- 保持本批次足够小，方便用户检查路径、内容和权限范围。',
    '',
    '## 接口与影响面',
    '- 使用 workspace.write 与 sourceBlockId 连接计划动作和代码块。',
    '- 不调用命令、Git、网络、浏览器或其他外部能力。',
    '',
    '## 验证计划',
    '- Kernel 应记录目标路径的写入事实。',
    '- 用户审查时应能看到生成文件路径和内容摘要。',
    '',
    '## 假设与约束',
    '- 目标路径位于已授权的工作区或会话资源根内。',
    '- 后续批次仍需要新的计划确认和审查。',
  ].join('\n');
  return proposal;
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
  if (command.kind === 'reviewGateEvaluate') {
    return {
      ok: true,
      events: [
        {
          kind: 'review_gate.evaluated',
          runId: command.runId ?? 'run-generic',
          sessionId: command.sessionId ?? sessionId,
          result: {
            status: 'accepted',
            summary: 'ReviewGate accepted Kernel facts and user review decision.',
          },
        },
      ],
    };
  }
  return { ok: true, events: [] };
}

function proposalReviewReport(actionBundle: Record<string, any>, attachmentRoot?: string): Record<string, any> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const capabilities = [...new Set(actions.map((action) => action.capability).filter(Boolean))].sort();
  const permissionGaps = capabilities.filter((capability) => capability !== 'workspace.read' && capability !== 'git.read');
  const requiredFileOperations = requiredFileOperationsFromActionBundle(actionBundle, attachmentRoot);
  return {
    planId: actionBundle.id ?? 'bundle-generic',
    status: 'awaitingUserApproval',
    requiredCapabilities: capabilities,
    requiredPermissions: permissionGaps.map((capability) => `temporaryGrant:${capability}`),
    permissionGaps,
    requiredFileOperations,
    hardFloorHits: [],
    deniedReasons: [],
    blockedReasons: [],
    findings: [],
    kernelGeneratedPermissionSummary: `Kernel preflight: status=awaitingUserApproval; capabilities=${capabilities.join(',')}; permissionGaps=${permissionGaps.length ? permissionGaps.join(',') : 'none'}; hardFloor=none.`,
  };
}

function requiredFileOperationsFromActionBundle(actionBundle: Record<string, any>, attachmentRoot?: string): Array<Record<string, string>> {
  const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
  const operations: Array<Record<string, string>> = [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const capability = typeof action.capability === 'string' ? action.capability : '';
    const operation = fileOperationForAction(action, capability);
    if (!operation) continue;
    const target = concreteTestTarget(
      typeof action.targetPath === 'string'
        ? action.targetPath
        : Array.isArray(action.resourceScope) && typeof action.resourceScope[0] === 'string'
          ? action.resourceScope[0]
          : '',
      attachmentRoot
    );
    if (!target) continue;
    operations.push({
      operation,
      targetPath: target,
      capability,
      actionId: typeof action.id === 'string' ? action.id : typeof action.actionId === 'string' ? action.actionId : '',
    });
  }
  return operations;
}

function fileOperationForAction(action: Record<string, any>, capability: string): string | undefined {
  const kind = typeof action.kind === 'string' ? action.kind : '';
  if (kind === 'delete') return 'delete';
  if (kind === 'create') return 'create';
  if (kind === 'rename') return 'rename';
  if (['write', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(kind)) return 'write';
  if (capability === 'workspace.write') return 'write';
  if (capability === 'workspace.create') return 'create';
  if (capability === 'workspace.delete') return 'delete';
  if (capability === 'workspace.rename') return 'rename';
  return undefined;
}

function concreteTestTarget(value: string, attachmentRoot?: string): string | undefined {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  if (!normalized || normalized === '.' || normalized === './') return undefined;
  if (normalized.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(normalized)) {
    const root = attachmentRoot?.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!root) return undefined;
    if (normalized === root) return undefined;
    if (normalized.startsWith(`${root}/`)) return concreteTestTarget(normalized.slice(root.length + 1));
    return undefined;
  }
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return undefined;
  if (normalized.includes('*') || normalized.endsWith('/')) return undefined;
  return normalized;
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

function acceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  return {
    id: `event-${runId}-implementation-plan`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'plan_card',
    payload: {
      runId,
      planId: 'impl-generic-auto',
      title: 'Generic implementation plan',
      summary: 'Implement a generic workspace file update.',
      status: 'pending',
      confirmable: true,
      implementationPlan: {
        version: '1',
        id: 'impl-generic-auto',
        title: 'Generic implementation plan',
        summary: 'Implement a generic workspace file update.',
        tasks: [
          {
            taskId: 'task-generic-write',
            title: 'Write generic output',
            target: ['generic-output.txt'],
            scope: 'Write a generic output file.',
            dependencies: [],
            capability: 'workspace.write',
            acceptanceCriteria: ['Kernel records the generic output write fact.'],
            failureCriteria: ['Stop if the write leaves the accepted target scope.'],
          },
        ],
        risks: ['Workspace writes remain under Kernel permission policy.'],
        reviewCheckpoints: ['Review Kernel facts after execution.'],
      },
      actionBundle: {
        version: '1',
        id: 'impl-generic-auto',
        goal: 'Implementation plan placeholder; concrete batches are generated after acceptance.',
        actions: [],
        validationExpectations: [],
        reviewExpectations: [],
      },
      codeBlocks: [],
      commandBlocks: [],
    },
  };
}

function userMessageWithDirectoryAttachmentEvent(sessionId: string, root: string): AgentEvent {
  return {
    id: `event-${sessionId}-user-attachment`,
    sessionId,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'user_msg',
    payload: {
      content: 'Please update the generic workspace.',
      attachments: [{
        kind: 'directory',
        path: root,
        absolutePath: root,
        source: 'userSelected',
        scope: 'message',
      }],
    },
  };
}

function multiTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-multi';
  payload.implementationPlan.id = 'impl-generic-multi';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-one',
      title: 'Write generic file one',
      target: ['generic-one.txt'],
      scope: 'Write the first generic file.',
      dependencies: [],
      capability: 'workspace.write',
      acceptanceCriteria: ['Kernel records the first generic write fact.'],
      failureCriteria: ['Stop if the first write leaves the accepted target scope.'],
    },
    {
      taskId: 'task-generic-two',
      title: 'Write generic file two',
      target: ['generic-two.txt'],
      scope: 'Write the second generic file.',
      dependencies: ['task-generic-one'],
      capability: 'workspace.write',
      acceptanceCriteria: ['Kernel records the second generic write fact.'],
      failureCriteria: ['Stop if the second write leaves the accepted target scope.'],
    },
  ];
  return event;
}

function independentMultiTargetAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-independent';
  payload.implementationPlan.id = 'impl-generic-independent';
  for (const task of payload.implementationPlan.tasks ?? []) {
    task.dependencies = [];
  }
  return event;
}

function hardDependencyAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = multiTargetAcceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-hard';
  payload.implementationPlan.id = 'impl-generic-hard';
  payload.implementationPlan.tasks[0].role = 'sourceCode';
  payload.implementationPlan.tasks[0].conflictKeys = ['generic-one.txt'];
  payload.implementationPlan.tasks[0].canDraftInParallel = true;
  payload.implementationPlan.tasks[1].role = 'sourceCode';
  payload.implementationPlan.tasks[1].dependencies = [];
  payload.implementationPlan.tasks[1].hardDependencies = ['task-generic-one'];
  payload.implementationPlan.tasks[1].softOrderAfter = [];
  payload.implementationPlan.tasks[1].conflictKeys = ['generic-two.txt'];
  payload.implementationPlan.tasks[1].canDraftInParallel = true;
  return event;
}

function deleteAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-delete';
  payload.implementationPlan.id = 'impl-generic-delete';
  payload.implementationPlan.title = 'Generic delete implementation plan';
  payload.implementationPlan.summary = 'Remove one generic obsolete workspace file.';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-delete',
      title: 'Delete generic obsolete file',
      target: ['generic-obsolete.txt'],
      scope: 'Delete a generic obsolete file inside the accepted workspace scope.',
      dependencies: [],
      capability: 'workspace.delete',
      acceptanceCriteria: ['Kernel records the delete work unit fact for the generic obsolete file.'],
      failureCriteria: ['Stop if the delete target is empty, root, absolute, or outside the accepted target scope.'],
    },
  ];
  return event;
}

function singleTargetWriteProposal(targetPath: string, contentSuffix: string): Record<string, unknown> {
  const blockId = `code-${contentSuffix}`;
  const actionId = `write-${contentSuffix}`;
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Generic task slice',
      '',
      '## Summary',
      `Write the accepted target ${targetPath} as one independent task slice.`,
      '',
      '## Key Changes',
      '- Produce one code block for the accepted target.',
      '- Produce one workspace.write action scoped to that same target.',
      '- Do not introduce shell, git, network, browser, or provider egress actions.',
      '',
      '## Validation',
      '- Kernel should record a work unit for the accepted target.',
      '- Parent Session should merge this fragment with sibling independent fragments before submitting.',
      '',
      '## Assumptions',
      '- The target belongs to the accepted implementationPlan file scope.',
    ].join('\n'),
    codeBlocks: [
      { id: blockId, blockId, targetPath, content: `generic ${contentSuffix}` },
    ],
    actionBundle: {
      version: '1',
      id: `bundle-${contentSuffix}`,
      goal: `Write ${targetPath}.`,
      actions: [{
        id: actionId,
        actionId,
        title: `Write ${targetPath}`,
        kind: 'write',
        capability: 'workspace.write',
        resourceScope: [targetPath],
        targetPath,
        sourceBlockId: blockId,
        permissionLabels: ['workspace.write'],
      }],
      validationExpectations: [{ id: `validation-${contentSuffix}`, description: `Kernel records ${targetPath}.` }],
      reviewExpectations: [{ id: `review-${contentSuffix}`, description: `Review ${targetPath}.` }],
    },
    expectedValidation: `Kernel records ${targetPath}.`,
    reviewGuide: `Review ${targetPath}.`,
  };
}

function genericDiagnosticProposal(summary: string): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'diagnostic',
    outputLanguage: 'en-US',
    diagnostic: {
      version: '1',
      id: 'diagnostic-generic',
      severity: 'warning',
      summary,
    },
  };
}

function processExecAcceptedImplementationPlanCardEvent(sessionId: string, runId: string): AgentEvent {
  const event = acceptedImplementationPlanCardEvent(sessionId, runId);
  const payload = event.payload as any;
  payload.planId = 'impl-generic-exec';
  payload.implementationPlan.id = 'impl-generic-exec';
  payload.implementationPlan.tasks = [
    {
      taskId: 'task-generic-exec',
      title: 'Run generic validation',
      target: ['scripts/validate.sh'],
      scope: 'Run a generic validation command described by the accepted plan.',
      dependencies: [],
      capability: 'process.exec',
      acceptanceCriteria: ['Kernel permission gate owns the process execution decision.'],
      failureCriteria: ['Stop if Session asks for a new technical plan instead of using Kernel PermissionGate.'],
    },
  ];
  return event;
}

function multiWriteProposal(): Record<string, unknown> {
  const proposal = genericWriteProposal(false);
  proposal.codeBlocks = [
    { id: 'code-one', targetPath: 'generic-one.txt', content: 'one' },
    { id: 'code-two', targetPath: 'generic-two.txt', content: 'two' },
  ];
  proposal.actionBundle = multiWriteActionBundle();
  return proposal;
}

function multiWriteActionBundle(): Record<string, any> {
  return {
    version: '1',
    id: 'bundle-multi-write',
    goal: 'Write multiple generic files in one reviewed batch.',
    actions: [
      {
        id: 'write-generic-one',
        title: 'Write generic file one',
        kind: 'write',
        capability: 'workspace.write',
        resourceScope: ['generic-one.txt'],
        canParallelize: false,
        conflictKeys: ['generic-one.txt'],
        sourceBlockId: 'code-one',
      },
      {
        id: 'write-generic-two',
        title: 'Write generic file two',
        kind: 'write',
        capability: 'workspace.write',
        resourceScope: ['generic-two.txt'],
        canParallelize: false,
        conflictKeys: ['generic-two.txt'],
        sourceBlockId: 'code-two',
      },
    ],
    validationExpectations: [{ id: 'validation-multi', description: 'Kernel records file write facts.' }],
    reviewExpectations: [{ id: 'review-multi', description: 'User reviews all written files.' }],
  };
}

function processExecProposal(): Record<string, unknown> {
  return {
    schemaVersion: 'deepcode.agent.protocol.v3',
    kind: 'actionBundle',
    outputLanguage: 'en-US',
    userPlan: [
      '# Plan',
      '',
      '## Summary',
      'Run the generic validation command already listed in the accepted implementation plan.',
      '',
      '## Key Changes',
      '- Submit one planned process execution action connected to a command block.',
      '- Keep the command inside the accepted target and capability scope.',
      '',
      '## Interfaces',
      '- Use process.exec with a commandBlockId so Kernel owns permission and execution.',
      '',
      '## Test Plan',
      '- Kernel should either request permission or record command execution facts.',
      '',
      '## Assumptions',
      '- The command target was already included in the accepted implementation plan.',
    ].join('\n'),
    commandBlocks: [{
      commandId: 'cmd-generic-validate',
      capability: 'process.exec',
      cwd: '.',
      argv: ['bash', 'scripts/validate.sh'],
      timeoutMs: 30000,
      envPolicy: 'inheritSafe',
      expectedOutput: 'generic validation output',
      permissionLabels: ['process.exec'],
    }],
    actionBundle: {
      version: '1',
      id: 'bundle-generic-exec',
      goal: 'Run generic validation.',
      actions: [{
        id: 'run-generic-validation',
        title: 'Run generic validation',
        kind: 'command',
        capability: 'process.exec',
        resourceScope: ['scripts/validate.sh'],
        commandBlockId: 'cmd-generic-validate',
        permissionLabels: ['process.exec'],
      }],
      validationExpectations: [{ id: 'validation-exec', description: 'Kernel records permission or command facts for the generic validation.' }],
      reviewExpectations: [{ id: 'review-exec', description: 'User can inspect Kernel permission and command facts.' }],
    },
    expectedValidation: 'Kernel records permission or command facts for the generic validation.',
    reviewGuide: 'Review Kernel permission and command facts.',
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

function assertCancelledRunState(
  events: AgentEvent[],
  reason: string,
  runId: string,
  targetId?: string
): void {
  const event = events.find((candidate) =>
    candidate.kind === 'session_run_state' &&
    (candidate.payload as any)?.status === 'cancelled' &&
    (candidate.payload as any)?.phase === 'cancelled' &&
    (candidate.payload as any)?.reason === reason &&
    (candidate.payload as any)?.runId === runId &&
    (targetId ? (candidate.payload as any)?.targetId === targetId : true)
  );
  assert(Boolean(event), `expected cancelled session run state for ${reason}`);
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

function taskStatus(graph: ReturnType<typeof buildSessionTaskGraph>, id: string): string | undefined {
  return graph.tasks.find((task) => task.id === id)?.status;
}

main().catch((error) => {
  console.error(error);
  throw error;
});
