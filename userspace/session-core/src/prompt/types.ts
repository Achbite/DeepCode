import type { ConversationResourceRoot, InitialContextPacket, ResourcePacket, ResourcePromptContext } from '../context/types.js';
import type { RequirementRecord } from '../requirement/types.js';
import type { AuthoritativeDocExcerpt } from './docProbe.js';
import type { CompiledRuler } from './ruler.js';

export interface PromptSystemLayer {
  name:
    | 'protectedStablePrefix'
    | 'protocolContract'
    | 'builtinSystemPrompt'
    | 'systemStructure'
    | 'capabilityProjection'
    | 'rulerContext'
    | 'authoritativeDocExcerpts'
    | 'projectMemory'
    | 'reusableResourceContext'
    | 'requirementTranscript'
    | 'sessionMemory'
    | 'agentInterventionPolicy'
    | 'currentUserOverlay'
    | 'userGuidance'
    | 'currentWorkflowState'
    | 'currentRequirement'
    | 'currentResourceResults'
    | 'auditOnlyContext';
  priority: number;
  stable: boolean;
  cacheClass: PromptSegmentCacheClass;
  content: string;
}

export type PromptSegmentCacheClass =
  | 'globalStable'
  | 'workspaceStable'
  | 'projectMemory'
  | 'sessionMemory'
  | 'requirementAppendOnly'
  | 'reusableResource'
  | 'turnDynamic'
  | 'auditOnly';

export interface PromptSegment {
  id: string;
  name: PromptSystemLayer['name'];
  priority: number;
  stable: boolean;
  auditOnly: boolean;
  cacheClass: PromptSegmentCacheClass;
  content: string;
}

export interface PromptEnvelopeBuilderInput {
  workflowState: string;
  allowedProposals: string[];
  capabilityCatalogSummary: string;
  builtinSystemPromptVersion?: string;
  compiledRuler?: CompiledRuler;
  memoryHints?: string[];
  stableMemoryHints?: string[];
  dynamicMemoryHints?: string[];
  projectMemoryHints?: string[];
  sessionMemoryHints?: string[];
  interventionLevel?: 'low' | 'medium' | 'high';
  userOverlay?: string;
  userGuidance?: Array<{
    id: string;
    ts?: string;
    content: string;
    source: 'user' | 'decision' | 'review' | 'system';
    checkpointKind: 'llmProposal' | 'resourcePacket' | 'permission' | 'review' | 'nextProviderCall';
  }>;
  authoritativeDocExcerpts?: AuthoritativeDocExcerpt[];
  requirement?: RequirementRecord;
  initialContext?: InitialContextPacket;
  conversationRoots?: ConversationResourceRoot[];
  resourcePackets?: ResourcePacket[];
  resourcePromptContext?: ResourcePromptContext;
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
  segments: PromptSegment[];
  stableLayerNames: string[];
  dynamicLayerNames: string[];
  auditOnlyLayerNames: string[];
}
