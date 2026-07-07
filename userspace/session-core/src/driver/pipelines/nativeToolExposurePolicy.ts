import type { ToolDefinition } from '@deepcode/protocol';
import type { ResourcePacket } from '../../context/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';

export interface NativeToolExposurePolicyState {
  acceptedImplementationPlan?: unknown;
  providerTurnFrame?: DriverProviderTurnFrame;
  resourcePackets?: ResourcePacket[];
}

export class NativeToolExposurePolicy {
  providerTools<TTool extends ToolDefinition>(
    state: NativeToolExposurePolicyState,
    tools: TTool[]
  ): TTool[] {
    if (this.shouldSuppressPlanningReadTools(state)) return [];
    return tools;
  }

  shouldSuppressPlanningReadTools(state: NativeToolExposurePolicyState): boolean {
    if (state.acceptedImplementationPlan) return false;
    const frame = state.providerTurnFrame;
    if (frame?.turnMode !== 'planning') return false;
    if (!frame.allowedKinds.includes('resourceRequest')) return false;
    return (state.resourcePackets?.length ?? 0) > 0;
  }
}
