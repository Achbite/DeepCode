import type {
  AgentEvent,
  AgentSession,
  AgentSessionResult,
  ApiResponse,
  KernelReply,
  LlmChatResult,
} from '@deepcode/protocol';
import {
  applyProviderCacheStrategy,
  assembleContext,
  buildPromptEnvelope,
  buildPromptPacketFrames,
  buildResourcePromptContext,
  buildSessionMemoryDocument,
  buildSessionMemorySnapshot,
  collectUserGuidanceEvents,
  createResourcePacket,
  SessionDriverLoop,
  type ResourceManifest,
  type TranscriptEntry,
} from '../index.js';
import { ContextFrameBuilder } from '../driver/context/contextFrameBuilder.js';
import { providerTelemetryFromUsage } from '../cache/telemetry.js';
import {
  providerRequestCacheTopology,
  type ProviderTurnRunnerState,
} from '../driver/pipelines/providerTurnRunner.js';
import { VISIBLE_REASONING_MAX_CHARS } from '../driver/projection/index.js';
import { AcceptedPlanResourceResumePromptBuilder } from '../prompt/AcceptedPlanResourceResumePromptBuilder.js';
import { ProviderRepairMessageBuilder } from '../prompt/ProviderRepairMessageBuilder.js';
import { providerVisibleSchemaDigest, renderProviderTurnContractLayer } from '../prompt/providerTurnContract.js';
import {
  assert,
  assertEqual,
  randomSmokeToken,
} from './smokeHelpers.js';
import {
  fakeKernel,
  jsonLlmResponse,
} from './smokeFixtures.js';

export function assertPromptEnvelope(): void {
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
    allowedProposals: ['answer', 'resourceRequest', 'taskPlan', 'actionBundle'],
    toolCatalogSummary: 'fs.read\nfs.write',
    memoryHints: ['Recent user turn: generic request attachments=file:generic/file.txt'],
    userRequest: 'Analyze the attached resource.',
    initialContext,
    conversationRoots,
    resourcePromptContext,
  });
  assert(prompt.stablePrefix.includes('Use exactly one registered Session semantic tool'), 'stable prompt requires one Session semantic directive');
  assert(!prompt.dynamicSuffix.includes('provider-native Session semantic tools'), 'dynamic prompt does not repeat the registered semantic tool profile');
  assert(!prompt.stablePrefix.includes('deepcode.agent.protocol.v4'), 'stable prompt no longer teaches the legacy JSON proposal envelope');
  assert(prompt.stablePrefix.includes('every task toolId must exactly match'), 'stable prompt forbids guessed planning tool ids');
  assert(prompt.stablePrefix.includes('latest authoritative user input'), 'stable prompt binds user-visible prose to the current user input language');
  assert(!prompt.stablePrefix.includes('fs.write'), 'stable prompt does not expose Kernel file write ids');
  assert(!prompt.stablePrefix.includes('fs.edit'), 'stable prompt does not expose Kernel patch ids');
  assert(!prompt.stablePrefix.includes('fs.delete'), 'stable prompt does not expose Kernel delete ids');
  assert(prompt.dynamicSuffix.includes('fs.read\nfs.write'), 'dynamic prompt includes the current Kernel tool catalog summary');
  assert(prompt.dynamicSuffix.includes('manifestEntry id=attachment-0-generic-file'), 'prompt exposes manifest entry ids');
  assert(prompt.dynamicSuffix.includes('Conversation roots'), 'prompt exposes conversation roots');
  assert(prompt.dynamicSuffix.includes('generic content'), 'prompt includes ResourcePacket content');

  const contract = new ContextFrameBuilder().buildSessionProviderTurnContract({
    contractId: 'contract-generic',
    sessionId: 'session-generic',
    runId: 'run-generic',
    turnMode: 'planning',
    allowedKinds: ['answer', 'resourceRequest', 'decisionRequest', 'taskPlan', 'diagnostic'],
    prompt,
    userRequest: 'Analyze the attached resource.',
    resourcePackets: [packet],
    nextActionInstruction: 'Use exactly one registered planning semantic tool.',
  });
  const semanticNextActionIndex = contract.frames.findIndex((frame) => frame.kind === 'NextActionInstruction');
  assertEqual(semanticNextActionIndex, contract.frames.length - 1, 'NextActionInstruction remains the final frame');
  assert(contract.frames.some((frame) => frame.kind === 'ResourceEvidence' && frame.trust === 'kernelObservedFact'), 'ResourceEvidence remains a Kernel-observed fact frame');

}
export function assertContextAssemblerCachePlan(): void {
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
    toolCatalogSummary: 'fs.read',
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
    toolCatalogSummary: 'fs.read',
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
  const proposalModeChange = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
    toolCatalogSummary: 'fs.read',
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
  assertEqual(base.cachePlan.providerCacheAttribution.cacheEligiblePrefixCharLength, base.prompt.stablePrefix.length, 'cache attribution records prefix char length');
  assertEqual(base.cachePlan.providerCacheAttribution.stableMessageHash, base.cachePlan.stablePrefixHash, 'cache attribution uses stable prefix hash');
  assertEqual(base.cachePlan.providerCacheAttribution.dynamicMessageHash, base.cachePlan.dynamicSuffixHash, 'cache attribution uses dynamic suffix hash');
  assert(!base.cachePlan.providerCacheAttribution.partitionSnapshots.some((partition) => partition.name === 'ProjectMemory'), 'cache attribution omits an empty project memory partition from provider-visible context');
  assertEqual(base.cachePlan.providerCacheAttribution.changedPartitions.length, 0, 'cache attribution does not report changes without a previous baseline');
  assertEqual(base.cachePlan.stablePrefixHash, followUp.cachePlan.stablePrefixHash, 'same stable layers keep stable prefix hash');
  assertEqual(base.cachePlan.stablePrefixHash, proposalModeChange.cachePlan.stablePrefixHash, 'allowed proposal changes do not change stable prefix hash');
  assert(base.cachePlan.dynamicSuffixHash !== followUp.cachePlan.dynamicSuffixHash, 'current request changes dynamic suffix hash');
  assert(base.cachePlan.dynamicSuffixHash !== proposalModeChange.cachePlan.dynamicSuffixHash, 'allowed proposal changes stay in dynamic suffix');
  assert(base.cachePlan.cacheHash !== followUp.cachePlan.cacheHash, 'overall cache hash changes with the dynamic suffix');
  assert(!base.prompt.stablePrefix.includes('Summarize the reusable context.'), 'stable prefix excludes current user request');
  assert(!base.prompt.dynamicSuffix.includes('Summarize the reusable context.'), 'system context does not duplicate the exact user request carried by PromptLedger');
  assert(base.prompt.dynamicSuffix.includes('exact authoritative text is supplied in PromptLedger user messages'), 'dynamic context identifies PromptLedger as the user-text authority');
  assert(base.prompt.dynamicSuffix.includes('Prefer a concise continuation'), 'user guidance enters the dynamic suffix');
  assertEqual(base.contextAssembly.userGuidanceCount, 1, 'context assembly records provider-checkpoint user guidance count');
  assertEqual(base.contextAssembly.consumedUserGuidanceIds[0], 'guidance-generic', 'context assembly records consumed user guidance ids');
  assertEqual(base.contextAssembly.schemaVersion, 'deepcode.session.context-assembly.v3', 'context assembly records v3 partitioned cache debug schema');
  assertEqual(base.contextAssembly.promptPolicyVersion, 'deepcode.prompt-policy.v1', 'context assembly records the prompt policy version without bumping schema');
  assertEqual(base.contextAssembly.cacheAffectsCorrectness, false, 'context assembly cache telemetry is observability only');
  assertEqual(base.contextAssembly.catalogHash, followUp.contextAssembly.catalogHash, 'same capability catalog keeps catalog hash stable');
  assert(base.contextAssembly.stateContractHash === followUp.contextAssembly.stateContractHash, 'same workflow state and allowed proposals keep state contract hash stable');
  assertEqual(base.contextAssembly.budgetPlan.contextWindowTokens, 1_000_000, 'context assembly records 1M soft context budget');
  assertEqual(base.contextAssembly.budgetPlan.maxOutputTokens, 384_000, 'context assembly records 384K output reserve');
  assertEqual(base.contextAssembly.reservedOutputTokens, 384_000, 'context assembly records reserved output tokens');
  assertEqual(base.contextAssembly.budgetPlan.projectMemoryBudgetTokens, 128_000, 'context assembly records 128K project memory soft cap');
  assertEqual(base.contextAssembly.budgetPlan.sessionMemoryBudgetTokens, 256_000, 'context assembly records 256K session memory soft cap');
  assertEqual(base.contextAssembly.memoryCompressionMode, 'memory-v3-soft-cap-lines', 'context assembly records current memory compression mode');
  assertEqual(base.contextAssembly.evidenceFreshnessMode, 'resource-evidence-tail-v1', 'context assembly records current evidence freshness mode');
  assert(base.contextAssembly.projectMemoryArchiveHash, 'context assembly records project memory archive hash');
  assert(base.contextAssembly.sessionMemoryArchiveHash, 'context assembly records session memory archive hash');
  assert(base.contextAssembly.expandedMemoryItemIds?.length, 'context assembly records expanded memory item ids');
  assert(base.contextAssembly.memoryDroppedReasonCounts?.retained !== undefined, 'context assembly records memory dropped reason counts');
  assertEqual(base.contextAssembly.traceArchiveMode, 'compact-provider-trace', 'context assembly records compact trace archive mode');
  assertEqual(base.contextAssembly.resourceBlocks.length, 0, 'simple chat path has no resource blocks');
  assertEqual(base.contextAssembly.resourceFullTextCharCount, 0, 'simple chat path has no full resource text');
  assertEqual(base.contextAssembly.resourceEvidenceTailCount, 0, 'simple chat path has no resource evidence tail entries');
  assertEqual(
    base.contextAssembly.dynamicAppendLog.map((entry) => entry.name).join(','),
    base.prompt.dynamicLayerNames.join(','),
    'context assembly dynamic append log follows prompt dynamic layer order'
  );
  assertEqual(
    base.contextAssembly.dynamicAppendLog.every((entry, index) => entry.index === index),
    true,
    'context assembly dynamic append log has monotonic append indexes'
  );
  assertEqual(
    base.contextAssembly.dynamicAppendLog.some((entry) => entry.name === 'protectedStablePrefix' || entry.name === 'auditOnlyContext'),
    false,
    'context assembly dynamic append log excludes stable and audit-only segments'
  );
  assertEqual(
    base.contextAssembly.dynamicAppendLog.some((entry) => entry.foldPolicy === 'retainEvidenceHandle'),
    true,
    'context assembly dynamic append log marks evidence-tail segments for handle retention'
  );
  assertEqual(
    base.contextAssembly.dynamicAppendLog.some((entry) => entry.foldPolicy === 'retainProjectMemory'),
    false,
    'context assembly dynamic append log omits empty project memory segments'
  );
  assertEqual(base.contextAssembly.dynamicAppendLogHash.length > 0, true, 'context assembly dynamic append log records a stable hash');
  assertEqual(base.contextAssembly.dynamicAppendLogCharLength > 0, true, 'context assembly dynamic append log records rendered dynamic length');
  assertEqual(base.contextAssembly.taskLocalFoldPlan.schemaVersion, 'deepcode.session.context-task-fold.v1', 'context assembly records task-local fold plan schema');
  assertEqual(base.contextAssembly.taskLocalFoldPlan.boundary, 'metadataOnlyNoPromptMutation', 'task-local fold plan is metadata only');
  assertEqual(base.contextAssembly.taskLocalFoldPlan.dynamicAppendLogHash, base.contextAssembly.dynamicAppendLogHash, 'task-local fold plan references the dynamic append log');
  assertEqual(
    base.contextAssembly.taskLocalFoldPlan.foldableSegmentCount + base.contextAssembly.taskLocalFoldPlan.retainedSegmentCount,
    base.contextAssembly.dynamicAppendLog.length,
    'task-local fold plan accounts for every dynamic append segment'
  );
  assertEqual(
    base.contextAssembly.taskLocalFoldPlan.foldableRenderedCharLength + base.contextAssembly.taskLocalFoldPlan.retainedRenderedCharLength,
    base.contextAssembly.dynamicAppendLogCharLength,
    'task-local fold plan accounts for rendered dynamic length'
  );
  assertEqual(
    base.contextAssembly.taskLocalFoldPlan.policySummaries.some((summary) => summary.policy === 'dropAfterTask'),
    true,
    'task-local fold plan marks task-local prompt state as foldable'
  );
  assertEqual(base.contextAssembly.taskLocalFoldPlanHash.length > 0, true, 'context assembly records task-local fold plan hash');
  assertEqual(base.contextAssembly.providerVisibleTokenEstimate, base.contextAssembly.partitionTokenEstimates.providerVisibleTotal, 'provider visible token estimate mirrors partition total');
  assert(base.contextAssembly.partitionCharCounts.protectedPrefix > 0, 'context assembly records protected prefix partition');
  assertEqual(base.contextAssembly.partitionCharCounts.projectMemory, 0, 'context assembly records an empty project memory partition without rendering a placeholder');
  assert(base.contextAssembly.partitionCharCounts.sessionMemory > 0, 'context assembly records session memory partition');
  assert(base.contextAssembly.partitionCharCounts.intentMemory > 0, 'context assembly records intent/memory partition');
  const partitionNames = base.contextAssembly.partitionRecords.map((partition) => partition.name);
  assertEqual(partitionNames.join(','), [
    'PlatformProtocolContract',
    'AgentOperatingContract',
    'StaticToolCatalogDigest',
    'UserRulerAndProjectInstructions',
    'ProjectMemory',
    'SessionMemory',
    'CurrentRunStateAndRequest',
    'EvidenceTail',
    'AuditOnly',
  ].join(','), 'context assembly records the formal prompt partitions in stable order');
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'PlatformProtocolContract')?.segmentNames.includes('protocolContract') === true,
    'platform protocol partition contains the protocol contract segment'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'AgentOperatingContract')?.segmentNames.includes('agentInterventionContract') === true,
    'agent operating contract contains the stable intervention contract'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'AgentOperatingContract')?.segmentNames.includes('resourceEvidencePolicyContract') === true,
    'agent operating contract contains the stable resource evidence policy'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'AgentOperatingContract')?.segmentNames.includes('memoryAndTaskContextContract') === true,
    'agent operating contract contains the stable memory/task context contract'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'AgentOperatingContract')?.segmentNames.includes('agentInterventionPolicy') !== true,
    'agent operating contract excludes dynamic intervention policy'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'CurrentRunStateAndRequest')?.segmentNames.includes('agentInterventionPolicy') === true,
    'current run state partition contains dynamic intervention policy'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'ProjectMemory')?.segmentNames.includes('projectMemoryRecall') === true,
    'project memory partition includes dynamic recall segment'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'EvidenceTail')?.segmentNames.includes('reusableResourceContext') === true,
    'evidence tail partition contains reusable resource context'
  );
  assert(
    base.contextAssembly.partitionRecords.find((partition) => partition.name === 'AuditOnly')?.providerVisible === false,
    'audit-only partition is not provider visible'
  );
  assert(base.contextAssembly.segments.find((segment) => segment.name === 'reusableResourceContext')?.charLength ?? 0 < 1200, 'empty resource context stays small');
  assertEqual(
    base.contextAssembly.segments.some((segment) => segment.cacheClass === 'globalStable' && segment.stablePrefix),
    true,
    'context assembly records stable protocol segments'
  );
  const toolCatalogSegment = base.contextAssembly.segments.find((segment) => segment.name === 'toolCatalogSummary');
  assertEqual(toolCatalogSegment?.cacheClass, 'turnDynamic', 'tool catalog digest follows current allowed proposal state');
  assertEqual(toolCatalogSegment?.stablePrefix, false, 'tool catalog digest stays outside the stable prefix');
  assert(base.prompt.dynamicLayerNames.includes('toolCatalogSummary'), 'current Kernel catalog digest is provider-visible dynamic context');
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

export function assertResourcePromptBlocksStabilize(): void {
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
    toolCatalogSummary: 'fs.read',
    userRequest: 'Analyze alpha.',
    initialContext,
    resourcePackets: [alphaPacket],
    profile: { provider: 'deepseek', model: 'deepseek-chat' },
    templateVersion: 'resource-block-test',
  });
  const second = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    toolCatalogSummary: 'fs.read',
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
  assertEqual(secondAlpha.retention, 'full', 'old resource remains full text while dynamic read budget is available');
  assertEqual(secondBeta.retention, 'full', 'new current small resource remains full text');
  assertEqual(secondAlpha.volatileFieldStripped, true, 'resource block records volatile field stripping');
  assert(second.prompt.dynamicSuffix.includes(betaContent), 'current resource full text remains available');
  assert(second.prompt.dynamicSuffix.includes(alphaMiddleMarker), 'old resource middle content is retained until the dynamic read budget is exceeded');
  assert(!second.prompt.dynamicSuffix.includes('volatile-evidence-alpha'), 'volatile evidence refs are not provider-visible');
  assert(!second.prompt.dynamicSuffix.includes('packet-alpha-volatile'), 'volatile packet ids are not provider-visible');
  assert(second.contextAssembly.resourceFullTextCharCount >= first.contextAssembly.resourceFullTextCharCount + betaContent.length, 'dynamic read full text budget accumulates current-run reads before compression');

  const largeEntries = Array.from({ length: 6 }, (_, index) => ({
    id: `large-file-${index}`,
    kind: 'file' as const,
    label: `File generated/resource-${index}.txt`,
    resourceRef: `generated/resource-${index}.txt`,
    readPolicy: 'autoRead' as const,
    reason: 'Generic budget resource.',
  }));
  const largeManifest: ResourceManifest = {
    id: 'manifest-resource-budget',
    workspaceScopeKey: 'workspace-resource-budget',
    entries: largeEntries,
    budget: { maxEntries: 12, maxBytes: 128000 },
    defaultDenyPatterns: [],
  };
  const largeInitialContext = {
    id: 'initial-resource-budget',
    workspaceScopeKey: largeManifest.workspaceScopeKey,
    manifest: largeManifest,
  };
  const largeMarkers = largeEntries.map((entry, index) => `RESOURCE_BUDGET_MARKER_${index}`);
  const largePackets = largeEntries.map((entry, index) => createResourcePacket({
    packetId: `packet-large-${index}`,
    manifest: largeManifest,
    request: {
      id: `request-large-${index}`,
      items: [{ id: `item-large-${index}`, manifestEntryId: entry.id, reason: 'Read budget resource.' }],
    },
    kernelEvidence: {
      [entry.id]: {
        contentKind: 'fileText',
        promptContent: `${'head '.repeat(520)}${largeMarkers[index]!}${' tail'.repeat(520)}`,
        evidenceRefs: [`volatile-large-${index}`],
      },
    },
  }));
  const overBudget = assembleContext({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest'],
    toolCatalogSummary: 'fs.read',
    userRequest: 'Analyze budgeted resource context.',
    initialContext: largeInitialContext,
    resourcePackets: largePackets,
    profile: { provider: 'deepseek', model: 'deepseek-chat' },
    templateVersion: 'resource-budget-test',
  });
  const oldestLargeEntry = largeEntries[0]!;
  const oldestLarge = overBudget.contextAssembly.resourceBlocks.find((block) => block.displayRef === oldestLargeEntry.resourceRef);
  const newestLargeEntry = largeEntries[largeEntries.length - 1]!;
  const newestLargeMarker = largeMarkers[largeMarkers.length - 1]!;
  const newestLarge = overBudget.contextAssembly.resourceBlocks.find((block) => block.displayRef === newestLargeEntry.resourceRef);
  assert(oldestLarge, 'over-budget old resource block still exists');
  assert(newestLarge, 'over-budget newest resource block still exists');
  if (!oldestLarge || !newestLarge) throw new Error('resource budget test setup failed');
  assertEqual(oldestLarge.retention, 'summary', 'over-budget oldest resource is downgraded to summary instead of being discarded');
  assertEqual(newestLarge.retention, 'full', 'over-budget newest resource keeps full text');
  assert(overBudget.prompt.dynamicSuffix.includes('handle=generated/resource-0.txt'), 'over-budget summary keeps a stable resource handle');
  assert(overBudget.prompt.dynamicSuffix.includes('summary:'), 'over-budget summary keeps a compact text summary');
  assert(!overBudget.prompt.dynamicSuffix.includes(largeMarkers[0]), 'over-budget old middle marker is removed from provider-visible full text');
  assert(overBudget.prompt.dynamicSuffix.includes(newestLargeMarker), 'over-budget newest full text remains provider-visible');

  const directoryInventoryMarker = 'DIRECTORY_TREE_INVENTORY_MARKER_RETAINED';
  const directoryLines = Array.from({ length: 80 }, (_, index) => {
    if (index === 40) return `- generic/catalog/${directoryInventoryMarker}/leaf-${index}.txt`;
    return `- generic/catalog/branch-${String(index).padStart(2, '0')}/leaf-${index}.txt`;
  });
  const directoryInventory = directoryLines.join('\n');
  assert(directoryInventory.length > 1000, 'directory inventory test exceeds generic summary window');
  const directoryManifest: ResourceManifest = {
    id: 'manifest-directory-inventory',
    workspaceScopeKey: 'workspace-directory-inventory',
    entries: [{
      id: 'directory-root',
      kind: 'directory',
      label: 'Directory generic/catalog',
      resourceRef: 'generic/catalog',
      readPolicy: 'autoRead',
      reason: 'Generic directory inventory.',
    }],
    budget: { maxEntries: 4, maxBytes: 64000 },
    defaultDenyPatterns: [],
  };
  const directoryPacket = createResourcePacket({
    packetId: 'packet-directory-inventory',
    manifest: directoryManifest,
    request: {
      id: 'request-directory-inventory',
      items: [{ id: 'item-directory-inventory', manifestEntryId: 'directory-root', reason: 'Read directory inventory.' }],
    },
    kernelEvidence: {
      'directory-root': {
        contentKind: 'directoryTree',
        promptContent: directoryInventory,
        contentSummary: 'Generic directory resolver summary without inventory entries.',
      },
    },
  });
  const directoryContext = buildResourcePromptContext({
    initialContext: {
      id: 'initial-directory-inventory',
      workspaceScopeKey: directoryManifest.workspaceScopeKey,
      manifest: directoryManifest,
    },
    resourcePackets: [directoryPacket],
  });
  const directoryBlock = directoryContext.resourceBlocks.find((block) => block.displayRef === 'generic/catalog');
  assert(directoryBlock, 'directory inventory resource block exists');
  if (!directoryBlock) throw new Error('directory inventory resource block test setup failed');
  assertEqual(directoryBlock.retention, 'summary', 'directory inventory remains a summary block');
  assertEqual(directoryBlock.fullTextCharLength, 0, 'directory inventory does not count as full text');
  assertEqual(directoryContext.resourceFullTextCharCount, 0, 'directory inventory keeps dynamic full text budget unchanged');
  assert(directoryBlock.summary.includes(directoryInventoryMarker), 'directory inventory summary preserves visible path entries within compact inventories');
  const directoryPrompt = buildPromptEnvelope({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest', 'taskPlan'],
    toolCatalogSummary: 'fs.read',
    userRequest: 'Plan with a generic directory inventory.',
    initialContext: {
      id: 'initial-directory-inventory',
      workspaceScopeKey: directoryManifest.workspaceScopeKey,
      manifest: directoryManifest,
    },
    resourcePromptContext: directoryContext,
  });
  const directoryContract = renderProviderTurnContractLayer({
    workflowState: 'needProposal',
    allowedProposals: ['answer', 'resourceRequest', 'taskPlan'],
    toolCatalogSummary: 'fs.read',
    userRequest: 'Plan with a generic directory inventory.',
    initialContext: {
      id: 'initial-directory-inventory',
      workspaceScopeKey: directoryManifest.workspaceScopeKey,
      manifest: directoryManifest,
    },
    resourcePromptContext: directoryContext,
  });
  assert(directoryPrompt.dynamicSuffix.includes('kinds=directoryTree=1'), 'current resource result status records directory inventory content kind');
  assert(directoryPrompt.stablePrefix.includes('Directory inventory ResourceEvidence is sufficient for file/directory existence checks and plan target selection'), 'stable evidence policy treats directory inventory as planning evidence');
  assert(directoryPrompt.stablePrefix.includes('Delete or cleanup plan targets must be present in ResourceEvidence/AccessIndex or explicitly named'), 'stable evidence policy prevents invented cleanup targets');
  assert(directoryContract.includes('directory inventory is available for existence checks and plan targets'), 'prompt packet access index treats directory inventory as sufficient for task planning');

  const jsonDirectoryToken = randomSmokeToken('json-directory');
  const jsonFilePath = `${jsonDirectoryToken}/src/${randomSmokeToken('unit')}.cpp`;
  const jsonTree = JSON.stringify([
    {
      path: jsonDirectoryToken,
      name: jsonDirectoryToken,
      type: 'directory',
      children: [
        {
          path: `${jsonDirectoryToken}/src`,
          name: 'src',
          type: 'directory',
          children: [
            {
              path: jsonFilePath,
              name: jsonFilePath.split('/').pop(),
              type: 'file',
              fileClassification: {
                kind: 'file',
                extension: 'cpp',
                sizeBytes: 321,
                readableText: true,
                executable: false,
                binary: false,
              },
            },
          ],
        },
      ],
    },
  ], null, 2);
  const jsonDirectoryManifest: ResourceManifest = {
    id: `manifest-${jsonDirectoryToken}`,
    workspaceScopeKey: `workspace-${jsonDirectoryToken}`,
    entries: [{
      id: `directory-${jsonDirectoryToken}`,
      kind: 'directory',
      label: `Directory ${jsonDirectoryToken}`,
      resourceRef: jsonDirectoryToken,
      readPolicy: 'autoRead',
      reason: 'Generic structured directory inventory.',
    }],
    budget: { maxEntries: 4, maxBytes: 64000 },
    defaultDenyPatterns: [],
  };
  const jsonDirectoryPacket = createResourcePacket({
    packetId: `packet-${jsonDirectoryToken}`,
    manifest: jsonDirectoryManifest,
    request: {
      id: `request-${jsonDirectoryToken}`,
      items: [{ id: `item-${jsonDirectoryToken}`, manifestEntryId: `directory-${jsonDirectoryToken}`, reason: 'Read structured directory inventory.' }],
    },
    kernelEvidence: {
      [`directory-${jsonDirectoryToken}`]: {
        contentKind: 'directoryTree',
        promptContent: jsonTree,
        contentSummary: 'Generic directory tree summary.',
      },
    },
  });
  const jsonDirectoryContext = buildResourcePromptContext({
    initialContext: {
      id: `initial-${jsonDirectoryToken}`,
      workspaceScopeKey: jsonDirectoryManifest.workspaceScopeKey,
      manifest: jsonDirectoryManifest,
    },
    resourcePackets: [jsonDirectoryPacket],
  });
  const jsonDirectoryBlock = jsonDirectoryContext.resourceBlocks.find((block) => block.displayRef === jsonDirectoryToken);
  assert(jsonDirectoryBlock, 'structured directory tree resource block exists');
  if (!jsonDirectoryBlock) throw new Error('structured directory tree resource block test setup failed');
  assert(jsonDirectoryBlock.summary.includes('Directory inventory summary'), 'structured directory tree uses compact inventory summary');
  assert(jsonDirectoryBlock.summary.includes(`- file ${jsonFilePath}`), 'structured directory tree keeps observed file path');
  assert(jsonDirectoryBlock.summary.includes('ext=cpp') && jsonDirectoryBlock.summary.includes('bytes=321'), 'structured directory tree keeps file classification facts');
  assert(!jsonDirectoryBlock.summary.includes('"children"'), 'structured directory tree summary does not expose verbose JSON shape');
  assert(jsonDirectoryBlock.summary.length < jsonTree.length, 'structured directory tree summary is more compact than raw JSON');
}

export function assertSessionMemoryDocument(): void {
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
      id: 'memory-turn-authority',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:00.100Z',
      kind: 'session_turn_authority',
      payload: {
        schemaVersion: 'deepcode.session.turn-authority.v1',
        sessionId: 'session-memory',
        runId: 'run-memory',
        turnId: 'turn-memory',
        taskId: 'task-memory',
        sourceMessageIds: ['memory-user'],
        sourceMessageHashes: ['hash-memory-user'],
        relation: 'newTask',
        boundAtHookRef: 'smoke.memory',
        outputLanguage: 'en-US',
        authorityHash: 'hash-memory-authority',
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
      id: 'memory-provider-reasoning',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:03.200Z',
      kind: 'assistant_msg',
      payload: {
        channel: 'reasoning',
        source: 'provider',
        content: 'Provider protocol self-audit should stay visible only and must not enter memory context.',
      },
    },
    {
      id: 'memory-llm-progress',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:03.300Z',
      kind: 'assistant_msg',
      payload: {
        channel: 'progress',
        source: 'llm',
        content: 'LLM progress narration should not become reusable memory context.',
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
  assert(document.intentContext.some((item) => item.includes('Current user request')), 'memory records user intent');
  assert(document.intentContext.some((item) => item.includes('Plan checkpoint')), 'memory records plan intent as intent context');
  assert(document.factContext.some((item) => item.includes('Tool result summary: fs.read')), 'memory records tool summaries as evidence tail facts');
  assert(document.factContext.some((item) => item.includes('ResourcePacket handle')), 'memory records resource packet handles');
  assertEqual(document.factContext.some((item) => item.includes('Kernel recorded the generic write fact')), false, 'raw review facts do not enter memory fact context');
  assert(document.archiveMetadata?.auditOnlyContext.some((item) => item.includes('Review raw facts retained in audit only')), 'raw review facts are retained as audit-only handles');
  assert(document.decisionContext.some((item) => item.includes('Review accepted')), 'memory records compact review decisions');
  assert(document.resourceContext.some((item) => item.includes('Project resource handle')), 'memory records reusable attachment facts');
  assert(document.pendingProjectMemoryCandidates.some((item) => item.content.includes('Project resource handle')), 'confirm mode keeps reusable attachment facts as pending project candidates');
  assert(document.shortTermContext.some((item) => item.includes('Plan checkpoint')), 'short-term memory records active planning intent');
  assertEqual(document.projectMemoryItems.length, 0, 'confirm mode does not auto-promote project memory candidates');
  assert(document.pendingProjectMemoryCandidates.length > 0, 'project memory candidates are backed by MemoryItemV4 items');
  assert(document.sessionMemoryItems.length > 0, 'session memory is backed by MemoryItemV4 items');
  assert(document.pendingProjectMemoryCandidates.every((item) => item.scope === 'project'), 'project memory candidate items keep project scope');
  assert(document.sessionMemoryItems.every((item) => item.scope === 'session'), 'session memory items keep session scope');
  assert(document.pendingProjectMemoryCandidates.some((item) => item.authority === 'resourcePacket'), 'project memory candidates record resourcePacket authority');
  assert(document.pendingProjectMemoryCandidates.every((item) => item.governance?.status === 'pending'), 'confirm mode marks project candidates pending');
  assert(document.sessionMemoryItems.some((item) => item.kind === 'intent'), 'session memory records active session intent items');
  assert(document.pendingProjectMemoryCandidates.every((item) => item.sourceRefs.eventIds.length > 0), 'project memory candidates carry event source refs');
  assert(document.sessionMemoryContext.some((item) => item.includes('sourceRefs=') && item.includes('compression=')), 'session memory renders source refs and compression');
  assert(document.shortTermContext.some((item) => item.includes('Assistant final summary')), 'assistant finals are summarized as short-term context');
  assertEqual(document.intentContext.some((item) => item.includes('Assistant final')), false, 'assistant final text is not promoted as stable intent');
  assertEqual(document.factContext.some((item) => item.includes('Plan intent')), false, 'plan intent does not enter factContext');
  const providerVisibleContext = [
    ...document.intentContext,
    ...document.factContext,
    ...document.decisionContext,
    ...document.resourceContext,
    ...document.shortTermContext,
    ...document.sessionMemoryContext,
  ].join('\n');
  assertEqual(providerVisibleContext.includes('Provider protocol self-audit'), false, 'provider reasoning does not enter session memory');
  assertEqual(providerVisibleContext.includes('LLM progress narration'), false, 'llm progress narration does not enter session memory');

  const autoDocument = buildSessionMemoryDocument([
    {
      id: 'memory-user-auto',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: {
        content: 'Analyze a generic attachment.',
        attachments: [{ kind: 'directory', path: 'generic-auto-attachment', scope: 'message' }],
      },
    },
  ], { projectMemoryMode: 'auto' });
  assert(autoDocument.projectMemoryItems.some((item) => item.governance?.status === 'auto-promoted'), 'auto mode promotes low-risk project memory candidates');
  assertEqual(autoDocument.pendingProjectMemoryCandidates.length, 0, 'auto mode does not leave low-risk candidates pending');

  const snapshot = buildSessionMemorySnapshot([
    {
      id: 'memory-user',
      sessionId: 'session-memory',
      ts: '2026-01-01T00:00:00.000Z',
      kind: 'user_msg',
      payload: { content: 'Analyze a generic attachment.' },
    },
  ], { sessionId: 'session-memory', generatedAt: '2026-01-01T00:00:10.000Z' });
  assertEqual(snapshot.schemaVersion, 'deepcode.session.memory-snapshot.v1', 'memory snapshot has a read-model schema');
  assertEqual(snapshot.sessionId, 'session-memory', 'memory snapshot records the source session id');
  assertEqual(snapshot.softCaps.projectMemoryTokens, 128000, 'project memory snapshot exposes project soft cap');
  assertEqual(snapshot.softCaps.sessionMemoryTokens, 256000, 'session memory snapshot exposes session soft cap');
  assertEqual(snapshot.metadata.freshnessMode, 'compiledFromSessionEvents', 'memory snapshot is compiled from session events');
  assertEqual(snapshot.metadata.archiveDescriptor.logicalSessionPath.includes('session-memory'), true, 'memory snapshot exposes user-visible session archive path');
  assertEqual(snapshot.metadata.archiveSidecar.schemaVersion, 'deepcode.session.memory-archive-sidecar.v1', 'memory snapshot exposes archive sidecar read model');
  assertEqual(snapshot.metadata.projectMemoryMode, 'confirm', 'memory snapshot exposes default project memory confirm mode');
  assert(snapshot.metadata.archiveSidecar.pendingProjectMemoryCandidates !== undefined, 'memory archive sidecar carries pending project candidates');
  assert(snapshot.metadata.sessionMarkdownPreview.includes('Session Memory'), 'memory snapshot exposes markdown preview');

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
export function assertDeepSeekCacheStrategyDoesNotInjectRequestParameter(): void {
  const result = cacheStrategyResult('deepseek', 'deepseek-chat');
  assertEqual(result.semanticMode, 'deepseek-openai', 'DeepSeek keeps OpenAI-compatible semantic mode');
  assertEqual(result.serverPromptCacheSupported, true, 'DeepSeek server prompt cache is marked as supported');
  assertEqual(Object.prototype.hasOwnProperty.call(result.requestBody, 'prompt_cache_key'), false, 'DeepSeek request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(result.requestBody, 'cache_control'), false, 'DeepSeek request body does not include cache_control');
  const openai = cacheStrategyResult('openai', 'gpt-generic');
  assertEqual(openai.semanticMode, 'openai', 'OpenAI keeps OpenAI semantic mode');
  assertEqual(Object.prototype.hasOwnProperty.call(openai.requestBody, 'prompt_cache_key'), false, 'OpenAI request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(openai.requestBody, 'cache_control'), false, 'OpenAI request body does not include cache_control');
  const anthropic = cacheStrategyResult('anthropic-native', 'claude-generic');
  assertEqual(anthropic.semanticMode, 'anthropic-native', 'Anthropic native keeps Anthropic semantic mode');
  assertEqual(Object.prototype.hasOwnProperty.call(anthropic.requestBody, 'prompt_cache_key'), false, 'Anthropic request body does not include prompt_cache_key');
  assertEqual(Object.prototype.hasOwnProperty.call(anthropic.requestBody, 'cache_control'), false, 'Anthropic request body does not include cache_control');
}

export function assertProviderCacheTelemetryNormalizesDeepSeekUsage(): void {
  const telemetry = providerTelemetryFromUsage({
    provider: 'deepseek',
    usage: {
      prompt_tokens: 1200,
      completion_tokens: 80,
      total_tokens: 1280,
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 300,
    },
  });
  assertEqual(telemetry.promptCacheHitTokens, 900, 'DeepSeek prompt_cache_hit_tokens maps to cache hit tokens');
  assertEqual(telemetry.promptCacheMissTokens, 300, 'DeepSeek prompt_cache_miss_tokens maps to cache miss tokens');
  assertEqual(telemetry.promptTokens, 1200, 'DeepSeek prompt token usage remains available for diagnostics');
  assertEqual(telemetry.totalTokens, 1280, 'DeepSeek total token usage remains available for diagnostics');

  const token = randomSmokeToken('cache-segment-id');
  const segmentId = `segment:${token}:toolCatalogSummary`;
  const topology = providerRequestCacheTopology({
    sessionId: `session-${token}`,
    runId: `run-${token}`,
    userRequest: `request-${token}`,
    contextAssembly: {
      segments: [{ id: segmentId, contentHash: `fnv1a32:${token}` }],
    },
    providerTurnFrame: {
      snapshot: { semanticProfileId: `profile-${token}` },
    },
  } as unknown as ProviderTurnRunnerState, [{ role: 'user', content: `request-${token}` }], {});
  assertEqual(
    (topology.changedSegmentIds as string[])[0],
    segmentId,
    'cache topology preserves the complete segment id before its content hash'
  );
}

function cacheStrategyResult(provider: string, model: string): ReturnType<typeof applyProviderCacheStrategy> {
  return applyProviderCacheStrategy({
    provider,
    model,
    prefixHash: 'fnv1a32:generic',
    requestBody: {
      model,
      messages: [{ role: 'user', content: 'generic' }],
    },
  });
}

export async function assertProviderCacheTelemetryNormalizesBigModelUsage(): Promise<void> {
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
            schemaVersion: 'deepcode.agent.protocol.v4',
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

export async function assertProviderTraceArchiveCompactsStreamingChunks(): Promise<void> {
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
            schemaVersion: 'deepcode.agent.protocol.v4',
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

  const visibleReasoning = events.find((event) =>
    event.kind === 'assistant_msg' && (event.payload as any)?.channel === 'reasoning'
  );
  if (!visibleReasoning) throw new Error('provider reasoning should still be projected as a conversation event');
  assert(
    String((visibleReasoning.payload as any).content ?? '').length <= VISIBLE_REASONING_MAX_CHARS,
    'provider reasoning conversation event is bounded even when trace archives full response'
  );
  assertEqual((visibleReasoning.payload as any).reasoningProjectionTruncated, true, 'provider reasoning conversation event records truncation');

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

export function assertAcceptedPlanResourceResumePromptUsesPromptContent(): void {
  const token = randomSmokeToken('resource-resume-prompt-content');
  const resourceRef = `src/generic-${token}.txt`;
  const manifest: ResourceManifest = {
    id: `manifest-${token}`,
    workspaceScopeKey: `workspace-${token}`,
    entries: [{
      id: `entry-${token}`,
      kind: 'file',
      label: `Generic ${token}`,
      resourceRef,
      readPolicy: 'autoRead',
      reason: 'Read a generic accepted-task resource.',
    }],
    budget: { maxEntries: 8, maxBytes: 8192 },
    defaultDenyPatterns: [],
  };
  const evidenceText = `resolved evidence ${token}\nfunction generic_${token}() { return true; }`;
  const packet = createResourcePacket({
    packetId: `packet-${token}`,
    manifest,
    request: {
      id: `request-${token}`,
      items: [{
        id: `item-${token}`,
        manifestEntryId: `entry-${token}`,
        reason: 'Read the current accepted task resource.',
      }],
    },
    kernelEvidence: {
      [`entry-${token}`]: {
        contentKind: 'fileText',
        promptContent: evidenceText,
        contentSummary: `summary-only-${token}`,
      },
    },
  });
  const prompt = new AcceptedPlanResourceResumePromptBuilder(new ProviderRepairMessageBuilder()).render({
    repairState: {
      runId: `run-${token}`,
      userRequest: `Handle generic resource ${token}.`,
      conversationRoots: [],
      resourcePackets: [packet],
      acceptedContext: { planId: `plan-${token}` },
      currentTaskContext: {
        taskId: `task-${token}`,
        goal: `Use ${resourceRef}.`,
        targets: [resourceRef],
        toolIds: ['fs.write'],
      },
      completedTaskCount: 0,
    },
    acceptedPlan: {
      planId: `plan-${token}`,
      completedTaskIds: [],
      tasks: [{ taskId: `task-${token}` }],
    },
    cursor: {
      currentTaskId: `task-${token}`,
      completedTaskIds: [],
      lastResourcePacketIds: [packet.id],
    },
    currentTask: {
      goal: `Use ${resourceRef}.`,
      targets: [resourceRef],
      toolIds: ['fs.write'],
      evidenceNeeds: ['current file text'],
    },
    requestProposal: {
      proposalId: `proposal-${token}`,
      kind: 'resourceRequest',
    } as any,
    packet,
  });

  assert(prompt.includes(`resolved evidence ${token}`), 'accepted-plan resource resume prompt includes resolved promptContent text');
  assert(prompt.includes(`function generic_${token}()`), 'accepted-plan resource resume prompt includes resolved promptContent code preview');
  assert(prompt.includes(`summary-only-${token}`), 'accepted-plan resource resume prompt retains content summary metadata');
}
