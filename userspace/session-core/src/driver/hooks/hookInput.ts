import type { HookPoint } from './hookPoint.js';

export interface HookInput {
  readonly point: HookPoint;
  readonly sessionId: string;
  readonly runId?: string;
}
