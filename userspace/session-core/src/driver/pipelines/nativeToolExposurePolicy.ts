import type { ToolDefinition } from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';

export interface NativeToolExposurePolicyState {
  acceptedTaskPlan?: unknown;
  providerTurnFrame?: DriverProviderTurnFrame;
  resourcePackets?: ResourcePacket[];
}

export class NativeToolExposurePolicy {
  providerTools<TTool extends ToolDefinition>(
    _state: NativeToolExposurePolicyState,
    tools: TTool[]
  ): TTool[] {
    return tools;
  }

  shouldSuppressPlanningReadTools(_state: NativeToolExposurePolicyState): boolean {
    return false;
  }
}
