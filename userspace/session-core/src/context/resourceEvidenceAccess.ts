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
  preview?: string;
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

export function resourceEvidenceCurrentTaskCoverageLines(
  blocks: readonly ResourceEvidenceAccessBlock[],
  targets: readonly string[]
): string[] {
  if (!blocks.length || !targets.length) return [];
  return targets.map((target) => {
    const matches = blocks.filter((block) => resourceBlockMatchesTarget(block, target));
    const covered = matches.some((block) => block.retention === 'full' || block.retention === 'summary');
    const fullTextAvailable = matches.some((block) => block.retention === 'full' && block.charLength > 0);
    const matched = uniqueSorted(matches.map((block) => block.displayRef)).slice(-4);
    const kinds = uniqueSorted(matches.map((block) => block.contentKind ?? 'unknown'));
    const use = covered
      ? 'current task target evidence is available; do not reread the same path/range unless a different range/search is required'
      : 'no current task evidence found; request a focused resource only if the missing fact changes the next action';
    return [
      `currentTaskEvidence target=${target}`,
      `covered=${covered}`,
      `fullText=${fullTextAvailable}`,
      `kinds=${kinds.length ? kinds.join(',') : 'none'}`,
      `matched=${matched.length ? matched.join(',') : 'none'}`,
      `use=${use}`,
    ].join('; ');
  });
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

function resourceBlockMatchesTarget(block: ResourceEvidenceAccessBlock, target: string): boolean {
  const ref = normalizeResourceRef(block.displayRef);
  const normalizedTarget = normalizeResourceRef(target);
  if (!ref || !normalizedTarget) return false;
  if (ref === normalizedTarget || ref.endsWith(`/${normalizedTarget}`) || normalizedTarget.endsWith(`/${ref}`)) {
    return true;
  }
  if (block.contentKind !== 'directoryTree') return false;
  return directoryInventoryMentionsTarget(block, ref, normalizedTarget);
}

function normalizeResourceRef(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  if (!normalized || normalized === '.' || normalized === '/') return '';
  return normalized;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function directoryInventoryMentionsTarget(
  block: ResourceEvidenceAccessBlock,
  normalizedRef: string,
  normalizedTarget: string
): boolean {
  const inventory = normalizeInventoryText(block.summary ?? block.preview ?? '');
  if (!inventory) return false;
  const candidates = [normalizedTarget];
  if (normalizedTarget.startsWith(`${normalizedRef}/`)) {
    candidates.push(normalizedTarget.slice(normalizedRef.length + 1));
  }
  return uniqueSorted(candidates).some((candidate) => inventoryContainsPath(inventory, candidate));
}

function normalizeInventoryText(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function inventoryContainsPath(inventory: string, normalizedPath: string): boolean {
  if (!normalizedPath) return false;
  const escaped = normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9._/-])${escaped}($|[^A-Za-z0-9._/-])`).test(inventory);
}
