export interface StablePrefixRef {
  hash: string;
  templateVersion: string;
  schemaVersion: string;
}

export interface DynamicSuffixRef {
  hash: string;
  requirementId?: string;
  reviewRoundId?: string;
  contextSnapshotId?: string;
}

export type ResourceReadPolicy = 'autoRead' | 'askRead' | 'denyRead';

export type ResourceManifestEntryKind = 'file' | 'symbol' | 'search' | 'checkpoint' | 'index' | 'ruler';

export interface ResourceManifestEntry {
  id: string;
  kind: ResourceManifestEntryKind;
  label: string;
  resourceRef: string;
  readPolicy: ResourceReadPolicy;
  reason: string;
}

export interface ResourceManifestBudget {
  maxEntries: number;
  maxBytes: number;
}

export interface ResourceManifest {
  id: string;
  workspaceId?: string;
  entries: ResourceManifestEntry[];
  budget: ResourceManifestBudget;
  defaultDenyPatterns: string[];
}

export interface InitialContextPacket {
  id: string;
  fileTreeSummary?: string;
  projectIndexSummary?: string;
  readmeSummary?: string;
  entrypointSummary?: string;
  checkpointSummary?: string;
  rulerSummary?: string;
  workflowCapabilitySummary?: string;
  manifest: ResourceManifest;
}

export interface ResourceRequestItem {
  id: string;
  manifestEntryId: string;
  reason: string;
}

export interface ResourceRequest {
  id: string;
  items: ResourceRequestItem[];
}

export interface ResourcePacketItem {
  requestItemId: string;
  manifestEntryId: string;
  readPolicy: ResourceReadPolicy;
  status: 'provided' | 'needsUserApproval' | 'denied';
  contentSummary?: string;
  denialReason?: string;
}

export interface ResourcePacket {
  id: string;
  requestId: string;
  items: ResourcePacketItem[];
}

export interface PromptEnvelopeParts {
  stablePrefix: {
    systemBoundary: string;
    outputFormat: string;
    jsonSchemaSummary: string;
    parserRules: string;
    capabilityCatalogSummary: string;
    workflowProjectionSchema: string;
  };
  dynamicSuffix: {
    userRequest: string;
    requirement?: unknown;
    contextCandidates: unknown[];
    fileSnippets: unknown[];
    toolEvidence: unknown[];
    reviewRound?: unknown;
  };
}
