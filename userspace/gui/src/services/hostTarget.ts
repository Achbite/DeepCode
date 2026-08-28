/**
 * Kernel Host target resolver.
 *
 * The trusted Tauri parent injects a one-shot proxy bootstrap before any app
 * script. Ordinary browser contexts intentionally have no privileged fallback.
 */

interface KernelHostTarget {
  host: string;
  port: string;
  uiToken: string;
}

interface KernelHostBootstrap {
  schemaVersion: 'deepcode.host-ui-bootstrap';
  host: string;
  port: string;
  uiToken: string;
}

declare global {
  interface Window {
    __DEEPCODE_HOST_BOOT__?: KernelHostBootstrap;
  }
}

function consumeTrustedBootstrap(): KernelHostTarget | null {
  if (typeof window === 'undefined') return null;
  const boot = window.__DEEPCODE_HOST_BOOT__;
  Reflect.deleteProperty(window, '__DEEPCODE_HOST_BOOT__');
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
    boot.schemaVersion !== 'deepcode.host-ui-bootstrap' ||
    !trustedDesktopOrigin
  ) {
    return null;
  }
  const host = boot.host.trim();
  const port = boot.port.trim();
  const uiToken = boot.uiToken.trim();
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(host) ||
    !/^[0-9]{1,5}$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65_535 ||
    !/^dcui_[0-9a-f]{64}$/.test(uiToken)
  ) {
    return null;
  }
  return { host, port, uiToken };
}

const trustedTarget = consumeTrustedBootstrap();
const UNAVAILABLE_LOOPBACK_ORIGIN = 'http://127.0.0.1:0';

function developmentBrowserOrigin(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  if (window.location.protocol !== 'http:') return null;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(window.location.hostname)) {
    return null;
  }
  return window.location.origin;
}

const browserDevelopmentOrigin = developmentBrowserOrigin();

export function getKernelHttpOrigin(): string {
  return trustedTarget
    ? `http://${trustedTarget.host}:${trustedTarget.port}`
    : browserDevelopmentOrigin ?? UNAVAILABLE_LOOPBACK_ORIGIN;
}

export function getKernelApiBase(): string {
  return `${getKernelHttpOrigin()}/api`;
}

export function getKernelWsBase(): string {
  if (trustedTarget) return `ws://${trustedTarget.host}:${trustedTarget.port}/ws`;
  if (browserDevelopmentOrigin) {
    const origin = new URL(browserDevelopmentOrigin);
    const protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${origin.host}/ws`;
  }
  return 'ws://127.0.0.1:0/ws';
}

export function getHostConnectionHeaders(): Record<string, string> {
  return trustedTarget
    ? { 'x-deepcode-host-ui-token': trustedTarget.uiToken }
    : {};
}
