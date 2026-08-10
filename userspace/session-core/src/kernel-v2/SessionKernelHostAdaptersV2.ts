import type { ToolContextBundleV2 } from '@deepcode/protocol';
import type { SessionKernelPortV2 } from './SessionKernelPortV2.js';
import type {
  SessionKernelClockPortV2,
  SessionKernelIdFactoryPortV2,
  SessionKernelLoopPortsV2,
  SessionKernelPersistencePortV2,
  SessionKernelProjectionPortV2,
  SessionKernelProviderPortV2,
} from './ports.js';

export interface SessionKernelHostRunOpenRequestV2 {
  workspaceBindingRef: string;
  inputId: string;
  opaqueInputRef: string;
  signal?: AbortSignal;
}

/**
 * Safe RunOpen material returned to Session. Authentication remains captured
 * inside kernel's transport adapter and is not represented in this value.
 */
export interface SessionKernelHostRunBindingV2 {
  kernel: SessionKernelPortV2;
  controlEpoch: number;
  toolContext: ToolContextBundleV2;
}

export interface SessionKernelHostRunAdapterV2 {
  openRun(
    request: SessionKernelHostRunOpenRequestV2
  ): Promise<SessionKernelHostRunBindingV2>;
}

/**
 * Host owns workspace resolution and RunOpen. Session receives only the
 * semantic Kernel port plus its Session-owned persistence/provider/projection
 * adapters; raw Kernel envelopes and capabilities are deliberately absent.
 */
export interface SessionKernelHostAdaptersV2 {
  runs: SessionKernelHostRunAdapterV2;
  persistence: SessionKernelPersistencePortV2;
  provider: SessionKernelProviderPortV2;
  projection: SessionKernelProjectionPortV2;
  clock: SessionKernelClockPortV2;
  ids: SessionKernelIdFactoryPortV2;
}

export function sessionKernelLoopPortsFromHostV2(
  adapters: SessionKernelHostAdaptersV2,
  binding: SessionKernelHostRunBindingV2
): SessionKernelLoopPortsV2 {
  return {
    kernel: binding.kernel,
    persistence: adapters.persistence,
    provider: adapters.provider,
    projection: adapters.projection,
    clock: adapters.clock,
    ids: adapters.ids,
  };
}
