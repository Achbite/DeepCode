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
import { renderProviderTurnUserPrompt } from './providerTurnPromptRenderer.js';

export function buildProviderTurnSnapshot(contract: DriverProviderTurnFrame): ProviderTurnSnapshot {
  const renderedContract = renderContractForSnapshot(contract);
  const finalUserPrompt = renderProviderTurnUserPrompt(contract.prompt.dynamicSuffix, contract);
  const contextAssembly = contract.contextAssembly;
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
    stablePrefixHash: contextAssembly?.stablePrefixHash ?? stableHash(contract.prompt.stablePrefix),
    dynamicSuffixHash: contextAssembly?.dynamicSuffixHash ?? stableHash(contract.prompt.dynamicSuffix),
    stablePrefixCharLength: contract.prompt.stablePrefix.length,
    dynamicSuffixCharLength: contract.prompt.dynamicSuffix.length,
    finalUserPromptHash: stableHash(finalUserPrompt),
    finalUserPromptCharLength: finalUserPrompt.length,
    providerTurnContractHash: stableHash(renderedContract),
    providerTurnContractCharLength: renderedContract.length,
    segmentOrder: contextAssembly?.segmentOrder ? [...contextAssembly.segmentOrder] : [],
    segments: contextAssembly?.segments.map(snapshotSegment) ?? [],
    frames: contract.frames.map(snapshotFrame),
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

function snapshotFrame(frame: ProviderContextFrame, index: number): ProviderTurnSnapshotFrame {
  return {
    index,
    kind: frame.kind,
    source: frame.source,
    trust: frame.trust,
    scope: frame.scope,
    useHash: stableHash(frame.use),
    summaryHash: frame.summary ? stableHash(frame.summary) : undefined,
    refsCount: frame.refs?.length ?? 0,
    dataHash: frame.data === undefined ? undefined : stableHash(JSON.stringify(frame.data)),
  };
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

function renderContractForSnapshot(contract: DriverProviderTurnFrame): string {
  return JSON.stringify({
    schemaVersion: contract.schemaVersion,
    contractId: contract.contractId,
    turnMode: contract.turnMode,
    allowedKinds: contract.allowedKinds,
    requiredKind: contract.requiredKind,
    repairPolicy: contract.repairPolicy,
    projectionVisibility: contract.projectionVisibility,
    frames: contract.frames.map((frame) => ({
      kind: frame.kind,
      source: frame.source,
      trust: frame.trust,
      scope: frame.scope,
      use: frame.use,
      summary: frame.summary,
      refsCount: frame.refs?.length ?? 0,
      dataHash: frame.data === undefined ? undefined : stableHash(JSON.stringify(frame.data)),
    })),
    toolIntentTemplates: contract.toolIntentTemplates,
    nextActionInstruction: contract.nextActionInstruction.summary ?? '',
  });
}
