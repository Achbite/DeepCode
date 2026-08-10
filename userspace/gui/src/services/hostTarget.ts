/**
 * Kernel Host target resolver.
 *
 * The trusted Tauri parent injects a one-shot proxy bootstrap before any app
 * script. Ordinary browser contexts intentionally have no privileged fallback.
 */

interface KernelHostTarget {
  host: string;
  port: string;
  proxyCapability: string;
}

interface KernelHostBootstrapV2 {
  schemaVersion: 'deepcode.host-ui-bootstrap.v2';
  host: string;
  port: string;
  proxyCapability: string;
}

declare global {
  interface Window {
    __DEEPCODE_HOST_BOOT_V2__?: KernelHostBootstrapV2;
  }
}

function consumeTrustedBootstrap(): KernelHostTarget | null {
  if (typeof window === 'undefined') return null;
  const boot = window.__DEEPCODE_HOST_BOOT_V2__;
  Reflect.deleteProperty(window, '__DEEPCODE_HOST_BOOT_V2__');
  const trustedDesktopOrigin = (
    (
      ['deepcode-gui:', 'deepcode-editor:'].includes(window.location.protocol)
      && window.location.hostname === 'localhost'
    )
    || (
      window.location.protocol === 'http:'
      && [
        'deepcode-gui.localhost',
        'deepcode-editor.localhost',
      ].includes(window.location.hostname)
    )
  );
  if (
    !boot ||
    boot.schemaVersion !== 'deepcode.host-ui-bootstrap.v2' ||
    !trustedDesktopOrigin
  ) {
    return null;
  }
  const host = boot.host.trim();
  const port = boot.port.trim();
  const proxyCapability = boot.proxyCapability.trim();
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    !/^[0-9]{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535 ||
    !/^dchostuiv2_[0-9a-f]{64}$/.test(proxyCapability)
  ) {
    return null;
  }
  return { host, port, proxyCapability };
}

const trustedTarget = consumeTrustedBootstrap();
const UNAVAILABLE_LOOPBACK_ORIGIN = 'http://127.0.0.1:0';

export function getKernelHttpOrigin(): string {
  return trustedTarget
    ? `http://${trustedTarget.host}:${trustedTarget.port}`
    : UNAVAILABLE_LOOPBACK_ORIGIN;
}

export function getKernelApiBase(): string {
  return `${getKernelHttpOrigin()}/api`;
}

export function getKernelWsBase(): string {
  return trustedTarget
    ? `ws://${trustedTarget.host}:${trustedTarget.port}/ws`
    : 'ws://127.0.0.1:0/ws';
}

export function getHostAdmissionHeaders(): Record<string, string> {
  return trustedTarget
    ? { 'x-deepcode-host-ui-capability': trustedTarget.proxyCapability }
    : {};
}
