import { AgentPlanParseError, type ProposalEnvelope, type ProposalEnvelopeSource } from './types.js';

export const AGENT_PROTOCOL_V3_SCHEMA_VERSION = 'deepcode.agent.protocol.v3';

const V3_KINDS = new Set([
  'answer',
  'resourceRequest',
  'requirementDraft',
  'actionBundle',
  'repairProposal',
  'reviewPacketDraft',
]);

export interface ParseProposalEnvelopeInput {
  raw: string | Record<string, unknown>;
  runId: string;
  sessionId?: string;
  source?: ProposalEnvelopeSource;
}

export function parseProposalEnvelope(input: ParseProposalEnvelopeInput): ProposalEnvelope {
  const envelope = typeof input.raw === 'string'
    ? parseJsonObject(input.raw, 'Agent Protocol v3')
    : input.raw;
  const schemaVersion = requireString(envelope, 'schemaVersion', 'Agent Protocol v3');
  if (schemaVersion !== AGENT_PROTOCOL_V3_SCHEMA_VERSION) {
    throw new AgentPlanParseError(
      'unsupported_protocol_schema',
      `Agent Protocol v3.schemaVersion must be ${AGENT_PROTOCOL_V3_SCHEMA_VERSION}`
    );
  }
  const kind = requireString(envelope, 'kind', 'Agent Protocol v3');
  if (!V3_KINDS.has(kind)) {
    throw new AgentPlanParseError('unsupported_protocol_kind', `Agent Protocol v3.kind is unsupported: ${kind}`);
  }
  const proposalId = optionalString(envelope, 'proposalId') ?? `proposal-${input.runId}-${kind}`;
  return {
    schemaVersion: AGENT_PROTOCOL_V3_SCHEMA_VERSION,
    proposalId,
    runId: optionalString(envelope, 'runId') ?? input.runId,
    sessionId: optionalString(envelope, 'sessionId') ?? input.sessionId,
    source: (optionalString(envelope, 'source') as ProposalEnvelopeSource | undefined) ?? input.source ?? 'llm',
    kind: kind as ProposalEnvelope['kind'],
    payload: proposalPayload(envelope, kind),
    referencedResourcePacketRefs: optionalStringArray(envelope, 'referencedResourcePacketRefs'),
    referencedEvidenceRefs: optionalStringArray(envelope, 'referencedEvidenceRefs'),
    parserDiagnostics: envelope.parserDiagnostics,
  };
}

function proposalPayload(envelope: Record<string, unknown>, kind: string): unknown {
  if (kind === 'answer') return requireObject(envelope.answer, 'Agent Protocol v3.answer');
  if (kind === 'resourceRequest') return normalizeResourceRequest(requireObject(envelope.resourceRequest, 'Agent Protocol v3.resourceRequest'));
  if (kind === 'requirementDraft') return requireObject(envelope.requirementDraft, 'Agent Protocol v3.requirementDraft');
  if (kind === 'repairProposal') return requireObject(envelope.repairProposal, 'Agent Protocol v3.repairProposal');
  if (kind === 'reviewPacketDraft') return requireObject(envelope.reviewPacketDraft, 'Agent Protocol v3.reviewPacketDraft');
  return {
    userPlan: optionalString(envelope, 'userPlan'),
    codeBlocks: Array.isArray(envelope.codeBlocks) ? envelope.codeBlocks : [],
    actionBundle: requireObject(envelope.actionBundle, 'Agent Protocol v3.actionBundle'),
    expectedValidation: optionalString(envelope, 'expectedValidation'),
    reviewGuide: optionalString(envelope, 'reviewGuide'),
  };
}

function normalizeResourceRequest(value: Record<string, unknown>): Record<string, unknown> {
  const items = value.items;
  if (!Array.isArray(items)) {
    throw new AgentPlanParseError('invalid_resource_request', 'Agent Protocol v3.resourceRequest.items must be an array');
  }
  const normalizedItems = items.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.resourceRequest.items[${index}]`);
    const id = optionalString(record, 'id') ?? `item-${index}`;
    const manifestEntryId = optionalString(record, 'manifestEntryId');
    const path = optionalString(record, 'path');
    const rootId = optionalString(record, 'rootId');
    const reason = optionalString(record, 'reason') ?? 'Resolve additional context.';
    if (!manifestEntryId && !path) {
      throw new AgentPlanParseError(
        'invalid_resource_request_item',
        `Agent Protocol v3.resourceRequest.items[${index}] must include manifestEntryId or path`
      );
    }
    return {
      id,
      ...(manifestEntryId ? { manifestEntryId } : {}),
      ...(path ? { path } : {}),
      ...(rootId ? { rootId } : {}),
      reason,
    };
  });
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? 'resource-request',
    reason: optionalString(value, 'reason') ?? 'Resolve additional context.',
    items: normalizedItems,
  };
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentPlanParseError('invalid_json_envelope', `${label} must be valid JSON: ${String(error)}`);
  }
  return requireObject(parsed, label);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentPlanParseError('invalid_object', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: Record<string, unknown>, key: string, label: string): string {
  const result = optionalString(value, key);
  if (!result) {
    throw new AgentPlanParseError('missing_string', `${label}.${key} must be a non-empty string`);
  }
  return result;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === 'string' && raw.trim() ? raw : undefined;
}

function optionalStringArray(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}
