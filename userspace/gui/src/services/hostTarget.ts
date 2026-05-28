/**
 * Kernel Host target resolver.
 *
 * Browser/dev host keeps relative URLs. Tauri desktop shell passes host/port in
 * the hash so the locally bundled GUI can talk to the background Kernel Host.
 */

interface KernelHostTarget {
  host: string;
  port: string;
}

function targetFromHash(): KernelHostTarget | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const host = params.get('host')?.trim();
  const port = params.get('port')?.trim();
  if (!host || !port) return null;
  return { host, port };
}

export function getKernelHttpOrigin(): string {
  const target = targetFromHash();
  return target ? `http://${target.host}:${target.port}` : '';
}

export function getKernelApiBase(): string {
  return `${getKernelHttpOrigin()}/api`;
}

export function getKernelWsBase(): string {
  const target = targetFromHash();
  if (target) return `ws://${target.host}:${target.port}/ws`;
  return `ws://${window.location.host}/ws`;
}
