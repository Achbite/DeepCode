export interface ResourceEvidenceAccessBlock {
  displayRef: string;
  contentKind?: string;
  status: string;
  retention: string;
  offsetBytes?: number;
  limitBytes?: number;
  returnedBytes?: number;
  rangeComplete?: boolean;
  contentHash: string;
  charLength: number;
  summary?: string;
}

export interface ResourceEvidenceAccessLineOptions {
  includeSummary?: boolean;
  summaryLimit?: number;
}

export function resourceEvidenceAccessIndexLine(
  block: ResourceEvidenceAccessBlock,
  options: ResourceEvidenceAccessLineOptions = {}
): string {
  const parts = [
    `ref=${block.displayRef}`,
    `kind=${block.contentKind ?? 'unknown'}`,
    `status=${block.status}`,
    `retention=${block.retention}`,
    `range=${resourceEvidenceRangeLabel(block)}`,
    `hash=${block.contentHash.slice(0, 12)}`,
    `chars=${block.charLength}`,
    `use=${resourceEvidenceReuseInstruction(block)}`,
  ];
  if (options.includeSummary) {
    parts.push(`summary=${compactOneLine(block.summary ?? '', options.summaryLimit ?? 300)}`);
  }
  return parts.join('; ');
}

export function resourceEvidenceContentKindCounts(blocks: readonly ResourceEvidenceAccessBlock[]): string {
  const counts = blocks.reduce<Record<string, number>>((result, block) => {
    const kind = block.contentKind ?? 'unknown';
    result[kind] = (result[kind] ?? 0) + 1;
    return result;
  }, {});
  return Object.keys(counts).sort().map((kind) => `${kind}=${counts[kind]}`).join(',');
}

export function resourceEvidenceRangeLabel(block: ResourceEvidenceAccessBlock): string {
  const range = [
    typeof block.offsetBytes === 'number' ? `offsetBytes=${block.offsetBytes}` : '',
    typeof block.limitBytes === 'number' ? `limitBytes=${block.limitBytes}` : '',
    typeof block.returnedBytes === 'number' ? `returnedBytes=${block.returnedBytes}` : '',
    typeof block.rangeComplete === 'boolean' ? `rangeComplete=${block.rangeComplete}` : '',
  ].filter(Boolean).join(',');
  return range || 'full-or-directory';
}

export function resourceEvidenceReuseInstruction(block: ResourceEvidenceAccessBlock): string {
  if (block.status === 'needsUserApproval' || block.status === 'denied') {
    return 'unavailable without user approval; do not repeat the same request blindly';
  }
  if (block.status === 'error') {
    return 'previous read failed; request a different focused segment only if it adds evidence';
  }
  if (block.contentKind === 'directoryTree' && (block.retention === 'full' || block.retention === 'summary')) {
    return 'directory inventory is available for existence checks and taskPlan targets; request file text only when exact content is required';
  }
  if (block.contentKind === 'searchResults' && (block.retention === 'full' || block.retention === 'summary')) {
    return 'search evidence is available; use returned matches before repeating the same query';
  }
  if (block.contentKind === 'fileText' && block.retention === 'full') {
    return 'file text is available; use it directly and do not reread the same path/range';
  }
  if (block.retention === 'full') {
    return 'full evidence is available; use it directly and do not reread the same path/range';
  }
  if (block.retention === 'summary') {
    return 'summary evidence is available; request a focused range only when exact content is required';
  }
  if (block.retention === 'handleOnly') {
    return 'handle is available; request a focused range before exact edits';
  }
  return 'resource is not usable as exact patch evidence';
}

function compactOneLine(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, Math.max(0, max - 1))}...` : normalized;
}
