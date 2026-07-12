import { stableHash } from '../../cache/canonicalizer.js';
import { ProviderProfileRegistry } from '../../provider/ProviderProfileRegistry.js';
import type {
  ContextAssemblyDynamicAppendLogEntry,
  ContextAssemblyTaskLocalFoldPlan,
  ContextAssemblyResourceBlockRecord,
} from '../../context/index.js';
import type {
  DriverProviderTurnFrame,
  ProviderContextFrame,
  ProviderTurnSnapshot,
  ProviderTurnSnapshotDynamicAppendLogEntry,
  ProviderTurnSnapshotTaskLocalFoldPlan,
  ProviderTurnSnapshotFrame,
  ProviderTurnSnapshotResourceBlock,
  ProviderTurnSnapshotSegment,
} from '../runFrame.js';
import type { PromptSegment } from '../../prompt/types.js';
import { buildProviderTurnContractPayload, renderProviderTurnUserPrompt } from './providerTurnPromptRenderer.js';

export function buildProviderTurnSnapshot(contract: DriverProviderTurnFrame): ProviderTurnSnapshot {
  const profile = new ProviderProfileRegistry().profileForFrame(contract);
  const systemContent = contract.prompt.stablePrefix;
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
  const currentTaskEvidenceLineCount = frames.reduce((total, frame) => total + frame.currentTaskEvidenceLineCount, 0);
  const currentTaskEvidenceCoveredCount = frames.reduce((total, frame) => total + frame.currentTaskEvidenceCoveredCount, 0);
  const currentTaskEvidenceUncoveredCount = frames.reduce((total, frame) => total + frame.currentTaskEvidenceUncoveredCount, 0);
  const currentTaskEvidenceFullTextCount = frames.reduce((total, frame) => total + frame.currentTaskEvidenceFullTextCount, 0);
  const currentTaskEvidenceTargets = uniqueSorted(frames.flatMap((frame) => frame.currentTaskEvidenceTargets)).slice(0, 12);
  const currentTaskEvidenceMatchedRefs = uniqueSorted(frames.flatMap((frame) => frame.currentTaskEvidenceMatchedRefs)).slice(0, 12);
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
    semanticProfileId: profile.id,
    systemHash: stableHash(systemContent),
    toolSchemaHash: profile.toolSchemaHash,
    responseFormatHash: profile.responseFormatHash,
    messageShapeHash: stableHash('system,user'),
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
    currentTaskEvidenceLineCount,
    currentTaskEvidenceCoveredCount,
    currentTaskEvidenceUncoveredCount,
    currentTaskEvidenceFullTextCount,
    currentTaskEvidenceTargets,
    currentTaskEvidenceMatchedRefs,
    segmentOrder: contract.prompt.segments.map((segment) => segment.id),
    segments: contract.prompt.segments.map(snapshotPromptSegment),
    dynamicAppendLog: contextAssembly?.dynamicAppendLog.map(snapshotDynamicAppendLogEntry) ?? [],
    dynamicAppendLogHash: contextAssembly?.dynamicAppendLogHash,
    dynamicAppendLogCharLength: contextAssembly?.dynamicAppendLogCharLength ?? 0,
    taskLocalFoldPlan: contextAssembly?.taskLocalFoldPlan
      ? snapshotTaskLocalFoldPlan(contextAssembly.taskLocalFoldPlan)
      : undefined,
    taskLocalFoldPlanHash: contextAssembly?.taskLocalFoldPlanHash,
    taskLocalCompactRecords: contextAssembly?.taskLocalCompactRecords.map((record) => ({
      ...record,
      retainedPolicies: [...record.retainedPolicies],
      foldablePolicies: [...record.foldablePolicies],
    })) ?? [],
    taskLocalCompactRecordCount: contextAssembly?.taskLocalCompactRecordCount ?? 0,
    taskLocalCompactRecordsHash: contextAssembly?.taskLocalCompactRecordsHash,
    latestTaskLocalCompactHash: contextAssembly?.latestTaskLocalCompactHash,
    frames,
    resourceBlocks: contextAssembly?.resourceBlocks.map(snapshotResourceBlock) ?? [],
    resourceRetentionCounts: { ...(contextAssembly?.resourceRetentionCounts ?? {}) },
    cacheClasses: cacheClasses(contract.prompt.segments),
  };
}

function snapshotTaskLocalFoldPlan(
  plan: ContextAssemblyTaskLocalFoldPlan
): ProviderTurnSnapshotTaskLocalFoldPlan {
  return {
    schemaVersion: plan.schemaVersion,
    taskCursorId: plan.taskCursorId,
    lastTaskSavepointId: plan.lastTaskSavepointId,
    currentTaskGoalHash: plan.currentTaskGoalHash,
    currentTaskContextHash: plan.currentTaskContextHash,
    dynamicAppendLogHash: plan.dynamicAppendLogHash,
    foldableSegmentCount: plan.foldableSegmentCount,
    foldableRenderedCharLength: plan.foldableRenderedCharLength,
    retainedSegmentCount: plan.retainedSegmentCount,
    retainedRenderedCharLength: plan.retainedRenderedCharLength,
    policySummaries: plan.policySummaries.map((summary) => ({
      policy: summary.policy,
      segmentCount: summary.segmentCount,
      renderedCharLength: summary.renderedCharLength,
      contentHash: summary.contentHash,
      renderedHash: summary.renderedHash,
      segmentIds: [...summary.segmentIds],
    })),
    boundary: plan.boundary,
  };
}

function snapshotPromptSegment(segment: PromptSegment): ProviderTurnSnapshotSegment {
  return {
    id: segment.id,
    name: segment.name,
    cacheClass: segment.cacheClass,
    stablePrefix: segment.stable,
    auditOnly: segment.auditOnly,
    contentHash: stableHash(segment.content),
    charLength: segment.content.length,
  };
}

function snapshotDynamicAppendLogEntry(
  entry: ContextAssemblyDynamicAppendLogEntry
): ProviderTurnSnapshotDynamicAppendLogEntry {
  return {
    index: entry.index,
    segmentId: entry.segmentId,
    name: entry.name,
    cacheClass: entry.cacheClass,
    partitionName: entry.partitionName,
    foldPolicy: entry.foldPolicy,
    contentHash: entry.contentHash,
    renderedHash: entry.renderedHash,
    charLength: entry.charLength,
    renderedCharLength: entry.renderedCharLength,
  };
}

function snapshotFrame(frame: ProviderContextFrame, index: number, dynamicSuffix: string): ProviderTurnSnapshotFrame {
  const currentTaskEvidence = currentTaskEvidenceStats(frame.summary ?? '');
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
    currentTaskEvidenceLineCount: currentTaskEvidence.lineCount,
    currentTaskEvidenceCoveredCount: currentTaskEvidence.coveredCount,
    currentTaskEvidenceUncoveredCount: currentTaskEvidence.uncoveredCount,
    currentTaskEvidenceFullTextCount: currentTaskEvidence.fullTextCount,
    currentTaskEvidenceTargets: currentTaskEvidence.targets,
    currentTaskEvidenceMatchedRefs: currentTaskEvidence.matchedRefs,
  };
}

function currentTaskEvidenceStats(summary: string): {
  lineCount: number;
  coveredCount: number;
  uncoveredCount: number;
  fullTextCount: number;
  targets: string[];
  matchedRefs: string[];
} {
  const evidenceLines = summary.split('\n').filter((line) => line.includes('currentTaskEvidence target='));
  return {
    lineCount: evidenceLines.length,
    coveredCount: evidenceLines.filter((line) => line.includes('covered=true')).length,
    uncoveredCount: evidenceLines.filter((line) => line.includes('covered=false')).length,
    fullTextCount: evidenceLines.filter((line) => line.includes('fullText=true')).length,
    targets: uniqueSorted(evidenceLines.map((line) => currentTaskEvidenceField(line, 'target')).filter(Boolean)).slice(0, 12),
    matchedRefs: uniqueSorted(evidenceLines.flatMap((line) =>
      currentTaskEvidenceField(line, 'matched').split(',').filter((value) => value && value !== 'none')
    )).slice(0, 12),
  };
}

function currentTaskEvidenceField(line: string, key: string): string {
  const prefix = `${key}=`;
  for (const segment of line.split('; ')) {
    const index = segment.indexOf(prefix);
    if (index === 0 || (index > 0 && segment[index - 1] === ' ')) {
      return segment.slice(index + prefix.length).trim();
    }
  }
  return '';
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
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

function cacheClasses(segments: readonly PromptSegment[]): Record<string, number> {
  return segments.reduce<Record<string, number>>((counts, segment) => {
    counts[segment.cacheClass] = (counts[segment.cacheClass] ?? 0) + 1;
    return counts;
  }, {});
}
