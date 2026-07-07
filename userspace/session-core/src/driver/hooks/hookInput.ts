import type { HookPoint } from './hookPoint.js';
import type { ProviderTurnMode, ProviderTurnSnapshot } from '../runFrame.js';

export interface HookInput {
  readonly point: HookPoint;
  readonly sessionId: string;
  readonly runId?: string;
  readonly contractId?: string;
  readonly turnMode?: ProviderTurnMode;
  readonly allowedKinds?: readonly string[];
  readonly snapshot?: ProviderTurnSnapshot;
}
