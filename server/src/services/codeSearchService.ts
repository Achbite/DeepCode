import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { CodeSearchInput, CodeSearchMatch, CodeSearchResult } from '@deepcode/protocol';
import { resolveFolder } from './workspaceService.js';

const MAX_FILES = 1200;
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_MATCHES = 200;
const EXCLUDED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  '.cache',
  '.vite',
]);

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function buildMatcher(query: string, isRegex?: boolean): RegExp {
  if (isRegex) return new RegExp(query, 'gi');
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'gi');
}

async function collectFiles(
  root: string,
  dir: string,
  include: string[] | undefined,
  acc: string[]
): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return;
    if (entry.name.startsWith('.') || EXCLUDED.has(entry.name)) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, absolute, include, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = toPosix(relative(root, absolute));
    if (include && include.length > 0 && !include.some((part) => rel.includes(part))) {
      continue;
    }
    acc.push(absolute);
  }
}

export async function searchCode(input: CodeSearchInput): Promise<CodeSearchResult> {
  if (!input.query || input.query.trim() === '') {
    return { matches: [] };
  }
  const folder = resolveFolder(input.folderId);
  const root = folder.absolutePath;
  const files: string[] = [];
  await collectFiles(root, root, input.include, files);
  const matcher = buildMatcher(input.query, input.isRegex);
  const matches: CodeSearchMatch[] = [];

  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    const metadata = await stat(file);
    if (metadata.size > MAX_FILE_SIZE) continue;
    const raw = await readFile(file);
    if (raw.includes(0)) continue;
    const lines = raw.toString('utf-8').split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (matches.length >= MAX_MATCHES) break;
      matcher.lastIndex = 0;
      const line = lines[lineIndex];
      const match = matcher.exec(line);
      if (!match) continue;
      matches.push({
        folderId: folder.id,
        path: toPosix(relative(root, file)),
        line: lineIndex + 1,
        column: match.index + 1,
        preview: line.trim().slice(0, 240),
      });
    }
  }

  return { matches };
}
