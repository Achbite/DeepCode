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
  assertSettingsCatalogBoundaries();
  assertNarrativeTimelineProjection();
  assertSessionDriverSkeleton();
  await assertSessionDriverLoop();
  await assertSessionDriverLoopTerminalAnswerGuidanceRevision();
  await assertSessionDriverLoopTerminalGuidanceRevisionFallback();
  await assertSessionDriverLoopPathResourceRequest();
  await assertSessionDriverLoopRejectsOutsidePath();
  await assertSessionDriverLoopUsesRecentAttachmentRoot();
  await assertSessionDriverLoopResourceBudgetRequestsUserDecision();
  await assertSessionDriverLoopContinuesAfterResourceBudgetDecision();
  await assertSessionDriverLoopProjectsDecisionRequest();
  await assertSessionDriverLoopRepairsSideEffectBundleEvidence();
  await assertSessionDriverLoopRepairsInvalidSourceBlock();
  await assertSessionDriverLoopRepairsOversizedActionBundle();
  await assertSessionDriverLoopRepairsEmptyActionBundleResponse();
  await assertSessionDriverLoopReviewRevisionReturnsToPlanning();
  await assertSessionDriverLoopReviewAcceptStopsAtCurrentBatch();
  await assertSessionDriverLoopStaleRequirementDecisionNoopsAfterReviewAccept();
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
    readOnlyResourceBudget: {
      usedRounds: 2,
      maxRounds: 8,
      remainingRounds: 6,
    },
  });
  assert(prompt.stablePrefix.includes('deepcode.agent.protocol.v3'), 'prompt enforces v3');
  assert(prompt.dynamicSuffix.includes('manifestEntry id=attachment-0-generic-file'), 'prompt exposes manifest entry ids');
  assert(prompt.dynamicSuffix.includes('Conversation roots'), 'prompt exposes conversation roots');
  assert(prompt.stablePrefix.includes('"path":"relative/path.ext"'), 'prompt documents path-based resourceRequest');
  assert(prompt.stablePrefix.includes('optional top-level narration'), 'prompt documents model-generated narration');
  assert(prompt.stablePrefix.includes('Implementation batch budget'), 'prompt documents incremental implementation budget');
  assert(prompt.stablePrefix.includes('<systemStructure'), 'prompt includes the system structure layer');
  assert(prompt.stablePrefix.includes('black-box validation'), 'prompt treats tests as black-box validation');
  assert(prompt.stablePrefix.includes('Do not optimize for known tests'), 'prompt rejects test-specific optimization');
  assert(!prompt.stablePrefix.includes('Current workflow state'), 'stable prefix excludes current workflow state');
  assert(!prompt.stablePrefix.includes('Recent user turn'), 'stable prefix excludes session-local memory hints');
  assert(prompt.dynamicSuffix.includes('Current workflow state: needProposal'), 'dynamic suffix carries current workflow state');
  assert(prompt.dynamicSuffix.includes('Allowed proposals: answer, resourceRequest, actionBundle'), 'dynamic suffix carries allowed proposals');
  assert(prompt.dynamicSuffix.includes('workspace.read'), 'dynamic suffix carries capability projection');
  assert(prompt.dynamicLayerNames.includes('shortTermMemoryHints'), 'short-term memory hints are dynamic context');
  assert(prompt.dynamicLayerNames.includes('reusableResourceContext'), 'reusable resource context is separated from current request');
  assert(prompt.dynamicSuffix.includes('blockKey='), 'prompt includes stable resource block keys');
  assert(prompt.dynamicSuffix.includes('generic content'), 'prompt includes ResourcePacket content');
  assert(!prompt.dynamicSuffix.includes('evidence-generic'), 'prompt excludes volatile evidence refs from provider-visible resource context');
  assert(prompt.dynamicSuffix.includes('Read-only resource budget: usedRounds=2 maxRounds=8 remainingRounds=6'), 'prompt exposes read-only resource budget');
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
  assertEqual(base.contextAssembly.schemaVersion, 'deepcode.session.context-assembly.v2', 'context assembly records v2 cache debug schema');
  assertEqual(base.contextAssembly.cacheAffectsCorrectness, false, 'context assembly cache telemetry is observability only');
  assertEqual(base.contextAssembly.resourceBlocks.length, 0, 'simple chat path has no resource blocks');
  assertEqual(base.contextAssembly.resourceFullTextCharCount, 0, 'simple chat path has no full resource text');
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
  assert(reusableIndex >= 0 && requirementIndex > reusableIndex, 'reusable resources appear before current request in dynamic suffix');
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

  assertEqual(document.schemaVersion, '2', 'memory document is versioned');
  assert(document.intentContext.some((item) => item.includes('User request')), 'memory records user intent');
  assert(document.intentContext.some((item) => item.includes('Plan intent')), 'memory records plan intent as intent context');
  assert(document.factContext.some((item) => item.includes('Resource/tool fact fs.read')), 'memory records tool summaries as facts');
  assert(document.factContext.some((item) => item.includes('ResourcePacket fact')), 'memory records resource packet facts');
  assert(document.factContext.some((item) => item.includes('Review fact')), 'memory records review facts');
  assert(document.decisionContext.some((item) => item.includes('Review decision: accepted')), 'memory records review decisions');
  assert(document.resourceContext.some((item) => item.includes('Attached resource')), 'memory records reusable attachment facts');
  assert(document.longTermContext.some((item) => item.includes('Attached resource')), 'stable memory records reusable attachment facts');
  assert(document.shortTermContext.some((item) => item.includes('Plan intent')), 'short-term memory records active planning intent');
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
    true,
    'task projection is derived from narrative blocks'
  );
  assertEqual(
    projection.taskProjection?.items.some((item) => item.narrativeKind === 'assistantNarration'),
    false,
    'assistant narration does not enter task projection'
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
      String((event.payload as any)?.content ?? '').includes('收到你的补充')
    ),
    true,
    'session transition message is visible before guidance revision'
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

async function assertSessionDriverLoopResourceBudgetRequestsUserDecision(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  const session: AgentSession = {
    id: 'session-budget',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-budget'),
    llmChat: async (): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
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
    sessionId: 'session-budget',
    content: 'Analyze the attached generic project.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  const budgetConfirmation = result.events.find((event) => event.kind === 'requirement_confirmation');
  assert(Boolean(budgetConfirmation), 'read-only resource budget emits user decision card');
  assertEqual(llmCalls, 9, 'ninth resourceRequest triggers budget decision after eight resolved rounds');
  assertEqual(resourceResolveManifests.length, 9, 'initial attachment plus eight requested resource packets were resolved');
  const summary = String((budgetConfirmation?.payload as any)?.summary ?? '');
  assert(summary.includes('只读资源预算'), 'budget decision explains read-only budget');
  assertEqual(result.events.some((event) => event.kind === 'assistant_msg' && (event.payload as any)?.diagnostic === true), false, 'budget exhaustion is not a terminal diagnostic');
}

async function assertSessionDriverLoopContinuesAfterResourceBudgetDecision(): Promise<void> {
  const events: AgentEvent[] = [];
  const resourceResolveManifests: Array<Record<string, any>> = [];
  let llmCalls = 0;
  let continuationSawPriorResource = false;
  const session: AgentSession = {
    id: 'session-budget-continue',
    mode: 'plan',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const loop = new SessionDriverLoop({
    appendEvents: async (_sessionId, nextEvents): Promise<AgentSessionResult> => {
      events.push(...nextEvents);
      return { session: { ...session, eventCount: events.length }, events: [...events] };
    },
    kernelCommand: async (request): Promise<KernelReply> => resourceBudgetKernel(request, resourceResolveManifests, 'session-budget-continue'),
    llmChat: async (request): Promise<ApiResponse<LlmChatResult>> => {
      llmCalls += 1;
      if (llmCalls <= 9) {
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
      }
      const promptText = request.messages.map((message) => message.content).join('\n');
      continuationSawPriorResource = promptText.includes('content for src/file-8.txt');
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
              answer: { format: 'markdown', content: 'Continued after budget approval with prior resources.' },
            }),
          },
        },
      };
    },
    now: () => '2026-01-01T00:00:00.000Z',
    createId: (prefix) => `${prefix}-${events.length + 1}`,
  });

  const first = await loop.runUserTurn({
    sessionId: 'session-budget-continue',
    content: 'Analyze the attached generic project.',
    attachments: [{
      kind: 'directory',
      path: 'generic-project',
      absolutePath: '/tmp/generic-project',
      source: 'userSelected',
      scope: 'message',
    }],
  });
  const confirmation = first.events.find((event) => event.kind === 'requirement_confirmation');
  assert(confirmation, 'budget confirmation exists before continuation');
  if (!confirmation) throw new Error('budget confirmation missing');
  const next = await loop.resolveDecision({
    sessionId: 'session-budget-continue',
    kind: 'requirement',
    decision: 'accept',
    runId: String((confirmation.payload as any).runId),
    targetId: String((confirmation.payload as any).requirementId),
    existingEvents: first.events,
  });
  assertEqual(next.events.some((event) => event.kind === 'assistant_msg'), true, 'budget approval continues to final answer');
  assertEqual(continuationSawPriorResource, true, 'budget continuation prompt includes prior ResourcePacket content');
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
  assert(promptText.includes('Session memory stable document'), 'structured stable session memory is included');
  assert(promptText.includes('Session memory dynamic document'), 'structured dynamic session memory is included');
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

function taskStatus(graph: ReturnType<typeof buildSessionTaskGraph>, id: string): string | undefined {
  return graph.tasks.find((task) => task.id === id)?.status;
}

main().catch((error) => {
  console.error(error);
  throw error;
});
