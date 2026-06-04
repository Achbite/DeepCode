import type { InitialContextPacket, ResourcePacket } from '../context/types.js';
import type { RequirementRecord } from '../requirement/types.js';

export interface PromptSystemLayer {
  name:
    | 'baseSystem'
    | 'workflowState'
    | 'outputContract'
    | 'capabilityProjection'
    | 'memoryContext'
    | 'userOverlay'
    | 'currentRequirement'
    | 'resourceContext';
  priority: number;
  stable: boolean;
  content: string;
}

export interface PromptEnvelopeBuilderInput {
  workflowState: string;
  allowedProposals: string[];
  capabilityCatalogSummary: string;
  memoryContext?: string;
  userOverlay?: string;
  requirement?: RequirementRecord;
  initialContext?: InitialContextPacket;
  resourcePackets?: ResourcePacket[];
  userRequest: string;
}

export interface PromptEnvelope {
  stablePrefix: string;
  dynamicSuffix: string;
  layers: PromptSystemLayer[];
  stableLayerNames: string[];
  dynamicLayerNames: string[];
}
