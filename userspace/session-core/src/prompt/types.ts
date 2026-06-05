import type { InitialContextPacket, ResourcePacket } from '../context/types.js';
import type { RequirementRecord } from '../requirement/types.js';
import type { AuthoritativeDocExcerpt } from './docProbe.js';
import type { CompiledRuler } from './ruler.js';

export interface PromptSystemLayer {
  name:
    | 'protocolContract'
    | 'builtinSystemPrompt'
    | 'capabilityProjection'
    | 'rulerContext'
    | 'currentUserOverlay'
    | 'authoritativeDocExcerpts'
    | 'memoryHints'
    | 'currentRequirement'
    | 'resourceContext'
    | 'auditOnlyContext';
  priority: number;
  stable: boolean;
  content: string;
}

export interface PromptEnvelopeBuilderInput {
  workflowState: string;
  allowedProposals: string[];
  capabilityCatalogSummary: string;
  builtinSystemPromptVersion?: string;
  compiledRuler?: CompiledRuler;
  memoryHints?: string[];
  userOverlay?: string;
  authoritativeDocExcerpts?: AuthoritativeDocExcerpt[];
  requirement?: RequirementRecord;
  initialContext?: InitialContextPacket;
  resourcePackets?: ResourcePacket[];
  userRequest: string;
  auditOnly?: {
    runId?: string;
    sessionId?: string;
    traceId?: string;
    projectionCardIds?: string[];
    ledgerRefs?: string[];
    auditRefs?: string[];
  };
}

export interface PromptEnvelope {
  stablePrefix: string;
  dynamicSuffix: string;
  auditOnlyContext: string;
  layers: PromptSystemLayer[];
  stableLayerNames: string[];
  dynamicLayerNames: string[];
  auditOnlyLayerNames: string[];
}
