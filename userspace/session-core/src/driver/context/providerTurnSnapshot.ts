import { stableHash } from '../../cache/canonicalizer.js';
import type {
  ContextAssemblyResourceBlockRecord,
  ContextAssemblySegmentRecord,
} from '../../context/index.js';
import type {
  DriverProviderTurnFrame,
  ProviderContextFrame,
  ProviderTurnSnapshot,
  ProviderTurnSnapshotFrame,
  ProviderTurnSnapshotResourceBlock,
  ProviderTurnSnapshotSegment,
} from '../runFrame.js';
import { buildProviderTurnContractPayload, renderProviderTurnUserPrompt } from './providerTurnPromptRenderer.js';

export function buildProviderTurnSnapshot(contract: DriverProviderTurnFrame): ProviderTurnSnapshot {
  const renderedContract = JSON.stringify(buildProviderTurnContractPayload(contract, contract.prompt.dynamicSuffix));
  const finalUserPrompt = renderProviderTurnUserPrompt(contract.prompt.dynamicSuffix, contract);
  const contextAssembly = contract.contextAssembly;
  const stablePrefixHash = stableHash(contract.prompt.stablePrefix);
  const dynamicSuffixHash = stableHash(contract.prompt.dynamicSuffix);
  const frames = contract.frames.map((frame, index) => snapshotFrame(frame, index, contract.prompt.dynamicSuffix));
  const dynamicDialogueSummary = contract.frames.find((frame) => frame.kind === 'DynamicDialogue')?.summary ?? '';
  const frameText = contract.frames.map((frame) => [frame.use, frame.summary ?? ''].join('\n')).join('\n');
  const frameTextCharLength = frames.reduce((total, frame) => total + frame.useCharLength + frame.summaryCharLength, 0);
  const dynamicFrameOverlapCharLength = frames.reduce(
    (total, frame) => total + frame.dynamicUseOverlapCharLength + frame.dynamicSummaryOverlapCharLength,
    0
  );
  return {
    schemaVersion: 'deepcode.session.provider-turn-snapshot.v1',
    contractId: contract.contractId,
    sessionId: contract.sessionId,
    runId: contract.runId,
    turnMode: contract.turnMode,
    allowedKinds: [...contract.allowedKinds],
    requiredKind: contract.requiredKind,
    repairPolicy: contract.repairPolicy,
    projectionVisibility: contract.projectionVisibility,
    stablePrefixHash,
    dynamicSuffixHash,
    stablePrefixCharLength: contract.prompt.stablePrefix.length,
    dynamicSuffixCharLength: contract.prompt.dynamicSuffix.length,
    finalUserPromptHash: stableHash(finalUserPrompt),
    finalUserPromptCharLength: finalUserPrompt.length,
    providerTurnContractHash: stableHash(renderedContract),
    providerTurnContractCharLength: renderedContract.length,
    dynamicDialogueSummaryHash: dynamicDialogueSummary ? stableHash(dynamicDialogueSummary) : undefined,
    dynamicDialogueSummaryCharLength: dynamicDialogueSummary.length,
    dynamicDialogueDynamicSuffixOccurrences: exactOccurrenceCount(contract.prompt.dynamicSuffix, dynamicDialogueSummary),
    dynamicDialogueFrameTextOccurrences: exactOccurrenceCount(frameText, dynamicDialogueSummary),
    dynamicFrameOverlapCharLength,
    dynamicFrameOverlapRatio: frameTextCharLength > 0 ? dynamicFrameOverlapCharLength / frameTextCharLength : 0,
    segmentOrder: contextAssembly?.segmentOrder ? [...contextAssembly.segmentOrder] : [],
    segments: contextAssembly?.segments.map(snapshotSegment) ?? [],
    frames,
    resourceBlocks: contextAssembly?.resourceBlocks.map(snapshotResourceBlock) ?? [],
    resourceRetentionCounts: { ...(contextAssembly?.resourceRetentionCounts ?? {}) },
    cacheClasses: cacheClasses(contextAssembly?.segments ?? []),
  };
}

function snapshotSegment(segment: ContextAssemblySegmentRecord): ProviderTurnSnapshotSegment {
  return {
    id: segment.id,
    name: segment.name,
    cacheClass: segment.cacheClass,
    stablePrefix: segment.stablePrefix,
    auditOnly: segment.auditOnly,
    contentHash: segment.contentHash,
    charLength: segment.charLength,
  };
}

function snapshotFrame(frame: ProviderContextFrame, index: number, dynamicSuffix: string): ProviderTurnSnapshotFrame {
  return {
    index,
    kind: frame.kind,
    source: frame.source,
    trust: frame.trust,
    scope: frame.scope,
    useCharLength: frame.use.length,
    useHash: stableHash(frame.use),
    dynamicUseOverlapCharLength: exactOverlapCharLength(dynamicSuffix, frame.use),
    summaryCharLength: frame.summary?.length ?? 0,
    summaryHash: frame.summary ? stableHash(frame.summary) : undefined,
    dynamicSummaryOverlapCharLength: exactOverlapCharLength(dynamicSuffix, frame.summary ?? ''),
    refsCount: frame.refs?.length ?? 0,
    dataHash: frame.data === undefined ? undefined : stableHash(JSON.stringify(frame.data)),
  };
}

function exactOverlapCharLength(haystack: string, needle: string): number {
  return needle && haystack.includes(needle) ? needle.length : 0;
}

function exactOccurrenceCount(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let fromIndex = 0;
  while (fromIndex <= haystack.length) {
    const found = haystack.indexOf(needle, fromIndex);
    if (found < 0) break;
    count += 1;
    fromIndex = found + Math.max(needle.length, 1);
  }
  return count;
}

function snapshotResourceBlock(block: ContextAssemblyResourceBlockRecord, index: number): ProviderTurnSnapshotResourceBlock {
  return {
    index,
    blockKey: block.blockKey,
    displayRef: block.displayRef,
    retention: block.retention,
    status: block.status,
    readPolicy: block.readPolicy,
    contentHash: block.contentHash,
    charLength: block.charLength,
    summaryCharLength: block.summaryCharLength,
    fullTextCharLength: block.fullTextCharLength,
  };
}

function cacheClasses(segments: readonly ContextAssemblySegmentRecord[]): Record<string, number> {
  return segments.reduce<Record<string, number>>((counts, segment) => {
    counts[segment.cacheClass] = (counts[segment.cacheClass] ?? 0) + 1;
    return counts;
  }, {});
}
