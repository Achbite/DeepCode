import type { RequirementRecord } from '../requirement/types.js';
import { canonicalizePrompt, stableHash } from '../cache/canonicalizer.js';
import { buildPromptEnvelope } from '../prompt/builder.js';
import type { PromptEnvelope, PromptEnvelopeBuilderInput, PromptSegment } from '../prompt/types.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourcePacket,
  ResourcePromptBlock,
  ResourcePromptContext,
} from './types.js';
import { buildResourcePromptContext } from './resourcePrompt.js';
import {
  buildSessionMemoryDocument,
  collectUserGuidanceEvents,
  renderProjectMemoryHints,
  renderSessionScopedMemoryHints,
  type UserGuidanceEvent,
  type SessionMemoryDocument,
} from './memory.js';
import type { AgentEvent } from '@deepcode/protocol';

export interface PromptCachePlan {
  contextAssemblyId: string;
  provider: string;
  model: string;
  templateVersion: string;
  stablePrefixHash: string;
  dynamicSuffixHash: string;
  cacheHash: string;
  auditHash: string;
  deepseekPrefixCache: {
    mode: 'automatic-prefix-cache';
    requestParameterRequired: false;
    strategy: 'maximize-identical-stable-prefix';
  };
  cacheAffectsCorrectness: false;
}

export interface ContextAssemblyResult {
  promptInput: PromptEnvelopeBuilderInput;
  prompt: PromptEnvelope;
  memoryDocument: SessionMemoryDocument;
  cachePlan: PromptCachePlan;
  contextAssembly: ContextAssemblyRecord;
}

export interface ContextAssemblySegmentRecord {
  id: string;
  name: PromptSegment['name'];
  priority: number;
  cacheClass: PromptSegment['cacheClass'];
  stablePrefix: boolean;
  auditOnly: boolean;
  contentHash: string;
  charLength: number;
  preview: string;
}

export interface ContextAssemblyResourceBlockRecord {
  blockKey: string;
  displayRef: string;
  manifestEntryId: string;
  retention: ResourcePromptBlock['retention'];
  status: ResourcePromptBlock['status'];
  readPolicy: ResourcePromptBlock['readPolicy'];
  contentKind?: ResourcePromptBlock['contentKind'];
  contentHash: string;
  charLength: number;
  summaryCharLength: number;
  fullTextCharLength: number;
  offsetBytes?: number;
  limitBytes?: number;
  returnedBytes?: number;
  originalBytes?: number;
  truncated?: boolean;
  rangeComplete?: boolean;
  volatileFieldStripped: boolean;
  preview: string;
}

export interface ContextAssemblyBudgetPlan {
  policy: 'softCapReserveOutput';
  contextWindowTokens: number;
  maxOutputTokens: number;
  protectedPrefixBudgetTokens: number;
  projectMemoryBudgetTokens: number;
  sessionMemoryBudgetTokens: number;
  intentMemoryBudgetTokens: number;
  evidenceTailBudgetTokens: number;
  auditOnlyBudgetTokens: number;
}

export interface ContextAssemblyPartitionCharCounts {
  protectedPrefix: number;
  projectMemory: number;
  sessionMemory: number;
  intentMemory: number;
  evidenceTail: number;
  auditOnly: number;
  providerVisibleTotal: number;
}

export interface ContextAssemblyPartitionTokenEstimates {
  protectedPrefix: number;
  projectMemory: number;
  sessionMemory: number;
  intentMemory: number;
  evidenceTail: number;
  auditOnly: number;
  providerVisibleTotal: number;
}

export interface ContextAssemblyRecord {
  schemaVersion: 'deepcode.session.context-assembly.v3';
  contextAssemblyId: string;
  provider: string;
  model: string;
  templateVersion: string;
  stablePrefixHash: string;
  dynamicSuffixHash: string;
  cacheHash: string;
  auditHash: string;
  cacheAffectsCorrectness: false;
  segmentOrder: string[];
  segments: ContextAssemblySegmentRecord[];
  resourceBlocks: ContextAssemblyResourceBlockRecord[];
  resourceFullTextCharCount: number;
  resourceSummaryCharCount: number;
  strippedVolatileResourceFieldCount: number;
  resourceRetentionCounts: Record<ResourcePromptBlock['retention'], number>;
  stableLayerNames: string[];
  dynamicLayerNames: string[];
  auditOnlyLayerNames: string[];
  memorySourceEventCount: number;
  resourcePacketCount: number;
  userGuidanceCount: number;
  consumedUserGuidanceIds: string[];
  budgetPlan: ContextAssemblyBudgetPlan;
  partitionCharCounts: ContextAssemblyPartitionCharCounts;
  partitionTokenEstimates: ContextAssemblyPartitionTokenEstimates;
  resourceEvidenceTailCount: number;
  traceArchiveMode: 'compact-provider-trace';
  subAgentMode?: 'auto' | 'off';
  sliceCount?: number;
  mergeGroupId?: string;
  branchContextCharCounts?: Record<string, number>;
  redactionNote: string;
}

export interface ContextAssemblyInput {
  workflowState: string;
  allowedProposals: string[];
  capabilityCatalogSummary: string;
  userRequest: string;
  existingEvents?: AgentEvent[];
  initialContext?: InitialContextPacket;
  resourcePackets?: ResourcePacket[];
  conversationRoots?: ConversationResourceRoot[];
  requirement?: RequirementRecord;
  memoryDocument?: SessionMemoryDocument;
  extraMemoryHints?: string[];
  interventionLevel?: PromptEnvelopeBuilderInput['interventionLevel'];
  userOverlay?: string;
  profile?: {
    provider?: string;
    model?: string;
  };
  templateVersion?: string;
  contextAssemblyId?: string;
  userGuidance?: UserGuidanceEvent[];
  subAgentTelemetry?: {
    mode: 'auto' | 'off';
    sliceCount?: number;
    mergeGroupId?: string;
    branchContextCharCounts?: Record<string, number>;
  };
  auditOnly?: PromptEnvelopeBuilderInput['auditOnly'];
}

export function assembleContext(input: ContextAssemblyInput): ContextAssemblyResult {
  const memoryDocument = input.memoryDocument ?? buildSessionMemoryDocument(input.existingEvents ?? []);
  const userGuidance = input.userGuidance ?? collectUserGuidanceEvents(input.existingEvents ?? []);
  const resourcePromptContext = buildResourcePromptContext({
    initialContext: input.initialContext,
    conversationRoots: input.conversationRoots,
    resourcePackets: input.resourcePackets,
  });
  const promptInput: PromptEnvelopeBuilderInput = {
    workflowState: input.workflowState,
    allowedProposals: input.allowedProposals,
    capabilityCatalogSummary: input.capabilityCatalogSummary,
    projectMemoryHints: renderProjectMemoryHints(memoryDocument),
    sessionMemoryHints: [
      ...renderSessionScopedMemoryHints(memoryDocument),
      ...(input.extraMemoryHints ?? []),
    ],
    interventionLevel: input.interventionLevel,
    userOverlay: input.userOverlay,
    userGuidance,
    userRequest: input.userRequest,
    initialContext: input.initialContext,
    resourcePackets: input.resourcePackets,
    resourcePromptContext,
    conversationRoots: input.conversationRoots,
    requirement: input.requirement,
    auditOnly: input.auditOnly,
  };
  const prompt = buildPromptEnvelope(promptInput);
  const provider = input.profile?.provider ?? 'unknown';
  const model = input.profile?.model ?? 'unknown';
  const templateVersion = input.templateVersion ?? 'deepcode-session-context-v1';
  const contextAssemblyId = input.contextAssemblyId ?? stableHash([
    provider,
    model,
    templateVersion,
    prompt.stablePrefix,
    prompt.dynamicSuffix,
    prompt.auditOnlyContext,
  ].join('\n---context-assembly---\n'));
  const canonical = canonicalizePrompt({
    stablePrefix: prompt.stablePrefix,
    dynamicSuffix: prompt.dynamicSuffix,
    auditOnly: prompt.auditOnlyContext,
    provider,
    model,
    templateVersion,
  });
  const partitionCharCounts = contextAssemblyPartitionCharCounts(prompt.segments);
  const contextAssembly: ContextAssemblyRecord = {
    schemaVersion: 'deepcode.session.context-assembly.v3',
    contextAssemblyId,
    provider,
    model,
    templateVersion,
    stablePrefixHash: canonical.stablePrefixHash,
    dynamicSuffixHash: canonical.dynamicSuffixHash,
    cacheHash: canonical.cacheHash,
    auditHash: canonical.auditHash,
    cacheAffectsCorrectness: false,
    segmentOrder: prompt.segments.map((segment) => segment.id),
    segments: prompt.segments.map(contextAssemblySegment),
    resourceBlocks: resourcePromptContext.resourceBlocks.map(contextAssemblyResourceBlock),
    resourceFullTextCharCount: resourcePromptContext.resourceFullTextCharCount,
    resourceSummaryCharCount: resourcePromptContext.resourceSummaryCharCount,
    strippedVolatileResourceFieldCount: resourcePromptContext.strippedVolatileFieldCount,
    resourceRetentionCounts: resourceRetentionCounts(resourcePromptContext),
    stableLayerNames: prompt.stableLayerNames,
    dynamicLayerNames: prompt.dynamicLayerNames,
    auditOnlyLayerNames: prompt.auditOnlyLayerNames,
    memorySourceEventCount: memoryDocument.sourceEventCount,
    resourcePacketCount: input.resourcePackets?.length ?? 0,
    userGuidanceCount: userGuidance.length,
    consumedUserGuidanceIds: userGuidance.map((item) => item.id),
    budgetPlan: {
      policy: 'softCapReserveOutput',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 384_000,
      protectedPrefixBudgetTokens: 64_000,
      projectMemoryBudgetTokens: 128_000,
      sessionMemoryBudgetTokens: 256_000,
      intentMemoryBudgetTokens: 256_000,
      evidenceTailBudgetTokens: 256_000,
      auditOnlyBudgetTokens: 8_000,
    },
    partitionCharCounts,
    partitionTokenEstimates: contextAssemblyPartitionTokenEstimates(partitionCharCounts),
    resourceEvidenceTailCount: resourcePromptContext.resourceBlocks.length,
    traceArchiveMode: 'compact-provider-trace',
    subAgentMode: input.subAgentTelemetry?.mode,
    sliceCount: input.subAgentTelemetry?.sliceCount,
    mergeGroupId: input.subAgentTelemetry?.mergeGroupId,
    branchContextCharCounts: input.subAgentTelemetry?.branchContextCharCounts,
    redactionNote: 'Segment previews and provider traces are compacted for inspection; raw provider token deltas and full prompt messages are not stored in transcript.',
  };
  return {
    promptInput,
    prompt,
    memoryDocument,
    contextAssembly,
    cachePlan: {
      contextAssemblyId,
      provider,
      model,
      templateVersion,
      stablePrefixHash: canonical.stablePrefixHash,
      dynamicSuffixHash: canonical.dynamicSuffixHash,
      cacheHash: canonical.cacheHash,
      auditHash: canonical.auditHash,
      deepseekPrefixCache: {
        mode: 'automatic-prefix-cache',
        requestParameterRequired: false,
        strategy: 'maximize-identical-stable-prefix',
      },
      cacheAffectsCorrectness: false,
    },
  };
}

function contextAssemblyPartitionCharCounts(segments: PromptSegment[]): ContextAssemblyPartitionCharCounts {
  const protectedNames = new Set<PromptSegment['name']>([
    'protectedStablePrefix',
    'protocolContract',
    'builtinSystemPrompt',
    'systemStructure',
    'capabilityProjection',
    'rulerContext',
    'authoritativeDocExcerpts',
  ]);
  const projectMemoryNames = new Set<PromptSegment['name']>(['projectMemory']);
  const sessionMemoryNames = new Set<PromptSegment['name']>([
    'sessionMemory',
    'agentInterventionPolicy',
    'requirementTranscript',
    'currentUserOverlay',
    'userGuidance',
    'currentWorkflowState',
    'currentRequirement',
  ]);
  const evidenceNames = new Set<PromptSegment['name']>([
    'reusableResourceContext',
    'currentResourceResults',
  ]);
  const auditNames = new Set<PromptSegment['name']>(['auditOnlyContext']);
  const counts: ContextAssemblyPartitionCharCounts = {
    protectedPrefix: 0,
    projectMemory: 0,
    sessionMemory: 0,
    intentMemory: 0,
    evidenceTail: 0,
    auditOnly: 0,
    providerVisibleTotal: 0,
  };
  for (const segment of segments) {
    if (protectedNames.has(segment.name)) counts.protectedPrefix += segment.content.length;
    else if (projectMemoryNames.has(segment.name)) counts.projectMemory += segment.content.length;
    else if (sessionMemoryNames.has(segment.name)) counts.sessionMemory += segment.content.length;
    else if (evidenceNames.has(segment.name)) counts.evidenceTail += segment.content.length;
    else if (auditNames.has(segment.name)) counts.auditOnly += segment.content.length;
    else counts.intentMemory += segment.content.length;
  }
  counts.intentMemory = counts.projectMemory + counts.sessionMemory + counts.intentMemory;
  counts.providerVisibleTotal = counts.protectedPrefix + counts.intentMemory + counts.evidenceTail;
  return counts;
}

function contextAssemblyPartitionTokenEstimates(
  counts: ContextAssemblyPartitionCharCounts
): ContextAssemblyPartitionTokenEstimates {
  return {
    protectedPrefix: estimateTokens(counts.protectedPrefix),
    projectMemory: estimateTokens(counts.projectMemory),
    sessionMemory: estimateTokens(counts.sessionMemory),
    intentMemory: estimateTokens(counts.intentMemory),
    evidenceTail: estimateTokens(counts.evidenceTail),
    auditOnly: estimateTokens(counts.auditOnly),
    providerVisibleTotal: estimateTokens(counts.providerVisibleTotal),
  };
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function contextAssemblyResourceBlock(block: ResourcePromptBlock): ContextAssemblyResourceBlockRecord {
  return {
    blockKey: block.blockKey,
    displayRef: block.displayRef,
    manifestEntryId: block.manifestEntryId,
    retention: block.retention,
    status: block.status,
    readPolicy: block.readPolicy,
    contentKind: block.contentKind,
    contentHash: block.contentHash,
    charLength: block.charLength,
    summaryCharLength: block.summaryCharLength,
    fullTextCharLength: block.fullTextCharLength,
    offsetBytes: block.offsetBytes,
    limitBytes: block.limitBytes,
    returnedBytes: block.returnedBytes,
    originalBytes: block.originalBytes,
    truncated: block.truncated,
    rangeComplete: block.rangeComplete,
    volatileFieldStripped: block.volatileFieldStripped,
    preview: clipSegmentPreview(block.summary),
  };
}

function resourceRetentionCounts(context: ResourcePromptContext): Record<ResourcePromptBlock['retention'], number> {
  return {
    full: context.fullBlockCount,
    summary: context.summaryBlockCount,
    handleOnly: context.handleOnlyBlockCount,
    denied: context.deniedBlockCount,
    error: context.errorBlockCount,
  };
}

function contextAssemblySegment(segment: PromptSegment): ContextAssemblySegmentRecord {
  return {
    id: segment.id,
    name: segment.name,
    priority: segment.priority,
    cacheClass: segment.cacheClass,
    stablePrefix: segment.stable,
    auditOnly: segment.auditOnly,
    contentHash: stableHash(segment.content),
    charLength: segment.content.length,
    preview: clipSegmentPreview(segment.content),
  };
}

function clipSegmentPreview(content: string): string {
  const normalized = content.replace(/\s+\n/g, '\n').trim();
  if (normalized.length <= 1200) return normalized;
  return `${normalized.slice(0, 900)}\n\n[... clipped segment preview ...]\n\n${normalized.slice(-200)}`;
}
