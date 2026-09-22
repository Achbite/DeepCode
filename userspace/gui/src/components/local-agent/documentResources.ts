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

export async function readDocumentText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  const content = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (content.includes('\0')) throw new Error('file_encoding_unsupported: 当前文件不是支持的文本文件。');
  return content;
}
