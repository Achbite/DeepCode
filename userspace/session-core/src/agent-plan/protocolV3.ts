import { AgentPlanParseError, type ProposalEnvelope, type ProposalEnvelopeSource } from './types.js';

export const AGENT_PROTOCOL_V3_SCHEMA_VERSION = 'deepcode.agent.protocol.v3';

const V3_KINDS = new Set([
  'answer',
  'resourceRequest',
  'decisionRequest',
  'actionBundle',
  'diagnostic',
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
    narration: optionalString(envelope, 'narration'),
    payload: proposalPayload(envelope, kind, proposalId),
    referencedResourcePacketRefs: optionalStringArray(envelope, 'referencedResourcePacketRefs'),
    referencedEvidenceRefs: optionalStringArray(envelope, 'referencedEvidenceRefs'),
    parserDiagnostics: envelope.parserDiagnostics,
  };
}

function proposalPayload(envelope: Record<string, unknown>, kind: string, proposalId: string): unknown {
  if (kind === 'answer') return requireObject(envelope.answer, 'Agent Protocol v3.answer');
  if (kind === 'resourceRequest') return normalizeResourceRequest(requireObject(envelope.resourceRequest, 'Agent Protocol v3.resourceRequest'));
  if (kind === 'decisionRequest') return normalizeDecisionRequest(requireObject(envelope.decisionRequest, 'Agent Protocol v3.decisionRequest'));
  if (kind === 'diagnostic') return normalizeDiagnostic(requireObject(envelope.diagnostic, 'Agent Protocol v3.diagnostic'));
  return normalizeActionBundlePayload(envelope, proposalId);
}

function normalizeActionBundlePayload(envelope: Record<string, unknown>, proposalId: string): Record<string, unknown> {
  const actionBundle = requireObject(envelope.actionBundle, 'Agent Protocol v3.actionBundle');
  return {
    userPlan: optionalString(envelope, 'userPlanMarkdown') ?? optionalString(envelope, 'userPlan'),
    codeBlocks: normalizeCodeBlocks(envelope.codeBlocks),
    commandBlocks: normalizeCommandBlocks(envelope.commandBlocks),
    actionBundle: normalizeActionBundle(actionBundle, proposalId),
    expectedValidation: optionalString(envelope, 'expectedValidation'),
    reviewGuide: optionalString(envelope, 'reviewGuide'),
  };
}

function normalizeCodeBlocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.codeBlocks[${index}]`);
    const id = optionalString(record, 'id') ?? optionalString(record, 'blockId') ?? `code-block-${index + 1}`;
    const path = optionalString(record, 'path') ?? optionalString(record, 'targetPath') ?? '';
    return {
      ...record,
      id,
      blockId: optionalString(record, 'blockId') ?? id,
      path,
      targetPath: optionalString(record, 'targetPath') ?? path,
      permissionLabels: optionalStringArray(record, 'permissionLabels'),
    };
  });
}

function normalizeCommandBlocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.commandBlocks[${index}]`);
    return {
      ...record,
      commandId: optionalString(record, 'commandId') ?? optionalString(record, 'id') ?? `command-${index + 1}`,
      capability: optionalString(record, 'capability') ?? 'process.exec',
      permissionLabels: optionalStringArray(record, 'permissionLabels'),
    };
  });
}

function normalizeActionBundle(value: Record<string, unknown>, proposalId: string): Record<string, unknown> {
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? `${proposalId}-action-bundle`,
    actions: normalizePlannedActions(value.actions, 'actions'),
    commandBlocks: normalizeCommandBlocks(value.commandBlocks),
    continuationExpectations: normalizePlannedActions(value.continuationExpectations, 'continuationExpectations'),
    validationExpectations: normalizeExpectations(value.validationExpectations, 'validationExpectations'),
    reviewExpectations: normalizeExpectations(value.reviewExpectations, 'reviewExpectations'),
  };
}

function normalizePlannedActions(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.actionBundle.${label}[${index}]`);
    const id = optionalString(record, 'id') ?? optionalString(record, 'actionId') ?? `${label}-${index + 1}`;
    const capability = optionalString(record, 'capability') ?? '';
    const targetPath = optionalString(record, 'targetPath');
    const resourceScope = optionalStringArray(record, 'resourceScope');
    const normalizedScope = resourceScope.length ? resourceScope : (targetPath ? [targetPath] : []);
    const conflictKeys = optionalStringArray(record, 'conflictKeys');
    return {
      ...record,
      id,
      actionId: optionalString(record, 'actionId') ?? id,
      title: optionalString(record, 'title') ?? optionalString(record, 'description') ?? id,
      capability,
      resourceScope: normalizedScope,
      canParallelize: typeof record.canParallelize === 'boolean' ? record.canParallelize : false,
      conflictKeys: conflictKeys.length ? conflictKeys : normalizedScope,
      purpose: optionalString(record, 'purpose') ?? optionalString(record, 'description'),
      permissionLabels: optionalStringArray(record, 'permissionLabels').length
        ? optionalStringArray(record, 'permissionLabels')
        : (capability ? [capability] : []),
      dependsOn: optionalStringArray(record, 'dependsOn'),
    };
  });
}

function normalizeExpectations(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.actionBundle.${label}[${index}]`);
    return {
      ...record,
      id: optionalString(record, 'id') ?? `${label}-${index + 1}`,
      description: optionalString(record, 'description') ?? '',
    };
  });
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

function normalizeDecisionRequest(value: Record<string, unknown>): Record<string, unknown> {
  const options = value.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 3) {
    throw new AgentPlanParseError(
      'invalid_decision_request',
      'Agent Protocol v3.decisionRequest.options must include 2-3 options'
    );
  }
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? 'decision-request',
    reason: optionalString(value, 'reason') ?? 'User intervention is required.',
    summary: optionalString(value, 'summary') ?? optionalString(value, 'reason') ?? '需要用户介入确认。',
    allowsFreeform: typeof value.allowsFreeform === 'boolean' ? value.allowsFreeform : true,
    options: options.map((item, index) => {
      const record = requireObject(item, `Agent Protocol v3.decisionRequest.options[${index}]`);
      return {
        id: optionalString(record, 'id') ?? `option-${index + 1}`,
        label: optionalString(record, 'label') ?? `Option ${index + 1}`,
        description: optionalString(record, 'description') ?? '',
        recommended: typeof record.recommended === 'boolean' ? record.recommended : index === 0,
      };
    }),
  };
}

function normalizeDiagnostic(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? 'diagnostic',
    severity: optionalString(value, 'severity') ?? 'error',
    summary: optionalString(value, 'summary') ?? optionalString(value, 'details') ?? 'Agent diagnostic.',
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
