import { stableHash } from '../cache/canonicalizer.js';

export type AuthoritativeDocKind = 'humanProjectPlan' | 'humanStageWorkbench';

export interface AuthoritativeDocSource {
  kind: AuthoritativeDocKind;
  path: string;
  content: string;
}

export interface AuthoritativeDocProbeQuery {
  id: string;
  pattern: string;
  caseSensitive?: boolean;
  maxMatches?: number;
  contextLines?: number;
}

export interface AuthoritativeDocExcerpt {
  id: string;
  docKind: AuthoritativeDocKind;
  path: string;
  queryId: string;
  heading?: string;
  lineStart: number;
  lineEnd: number;
  excerpt: string;
  excerptHash: string;
}

export interface AuthoritativeDocProbeResult {
  excerpts: AuthoritativeDocExcerpt[];
  docExcerptHash: string;
}

export function probeAuthoritativeDocs(input: {
  docs: AuthoritativeDocSource[];
  queries: AuthoritativeDocProbeQuery[];
}): AuthoritativeDocProbeResult {
  const excerpts: AuthoritativeDocExcerpt[] = [];
  for (const doc of input.docs) {
    const lines = doc.content.split(/\r?\n/);
    for (const query of input.queries) {
      const pattern = query.caseSensitive ? query.pattern : query.pattern.toLowerCase();
      const maxMatches = Math.max(1, query.maxMatches ?? 8);
      const contextLines = Math.max(0, query.contextLines ?? 2);
      let matched = 0;
      for (let index = 0; index < lines.length && matched < maxMatches; index += 1) {
        const haystack = query.caseSensitive ? lines[index] : lines[index].toLowerCase();
        if (!haystack.includes(pattern)) continue;
        const lineStart = Math.max(1, index + 1 - contextLines);
        const lineEnd = Math.min(lines.length, index + 1 + contextLines);
        const excerptLines = lines.slice(lineStart - 1, lineEnd);
        const excerpt = excerptLines.join('\n');
        excerpts.push({
          id: `${doc.kind}:${query.id}:${lineStart}-${lineEnd}`,
          docKind: doc.kind,
          path: doc.path,
          queryId: query.id,
          heading: nearestHeading(lines, index),
          lineStart,
          lineEnd,
          excerpt,
          excerptHash: stableHash(`${doc.path}:${lineStart}:${lineEnd}:${excerpt}`),
        });
        matched += 1;
      }
    }
  }
  const sorted = excerpts.sort((left, right) =>
    left.path.localeCompare(right.path) ||
    left.lineStart - right.lineStart ||
    left.queryId.localeCompare(right.queryId)
  );
  return {
    excerpts: sorted,
    docExcerptHash: stableHash(JSON.stringify(sorted.map((excerpt) => ({
      docKind: excerpt.docKind,
      path: excerpt.path,
      lineStart: excerpt.lineStart,
      lineEnd: excerpt.lineEnd,
      excerptHash: excerpt.excerptHash,
    })))),
  };
}

function nearestHeading(lines: string[], matchIndex: number): string | undefined {
  for (let index = matchIndex; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (/^#{1,6}\s+/.test(line)) {
      return line.replace(/^#{1,6}\s+/, '').trim();
    }
  }
  return undefined;
}
