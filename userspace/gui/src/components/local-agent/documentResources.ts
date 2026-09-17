export type DocumentFormat = 'html' | 'pdf' | 'markdown';

export function documentFormat(path: string): DocumentFormat | null {
  const suffix = path.split('.').at(-1)?.toLowerCase();
  if (suffix === 'html' || suffix === 'htm') return 'html';
  if (suffix === 'md' || suffix === 'markdown') return 'markdown';
  return suffix === 'pdf' ? 'pdf' : null;
}

export function workspaceResourceLink(href: string): { workspaceId: string; logicalPath: string } | null {
  const match = /^workspace:\/\/([^/]+)\/(.+)$/.exec(href);
  if (!match) return null;
  try {
    const workspaceId = decodeURIComponent(match[1]);
    const logicalPath = decodeURIComponent(match[2]);
    return workspaceId && logicalPath ? { workspaceId, logicalPath } : null;
  } catch { return null; }
}
