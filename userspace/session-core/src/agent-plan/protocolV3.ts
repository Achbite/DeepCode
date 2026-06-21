import { AgentPlanParseError, type ProposalEnvelope, type ProposalEnvelopeSource } from './types.js';

export const AGENT_PROTOCOL_V3_SCHEMA_VERSION = 'deepcode.agent.protocol.v3';

const V3_KINDS = new Set([
  'answer',
  'resourceRequest',
  'decisionRequest',
  'implementationPlan',
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
  if (kind === 'implementationPlan') return normalizeImplementationPlan(requireObject(envelope.implementationPlan, 'Agent Protocol v3.implementationPlan'), proposalId);
  if (kind === 'diagnostic') return normalizeDiagnostic(requireObject(envelope.diagnostic, 'Agent Protocol v3.diagnostic'));
  return normalizeActionBundlePayload(envelope, proposalId);
}

function normalizeImplementationPlan(value: Record<string, unknown>, proposalId: string): Record<string, unknown> {
  const tasks = value.tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new AgentPlanParseError('invalid_implementation_plan', 'Agent Protocol v3.implementationPlan.tasks must be a non-empty array');
  }
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? `${proposalId}-implementation-plan`,
    title: optionalString(value, 'title') ?? optionalString(value, 'summary') ?? 'Implementation plan',
    summary: optionalString(value, 'summary') ?? optionalString(value, 'title') ?? 'Implementation plan',
    risks: optionalStringArray(value, 'risks'),
    reviewCheckpoints: optionalStringArray(value, 'reviewCheckpoints'),
    tasks: tasks.map((item, index) => {
      const record = requireObject(item, `Agent Protocol v3.implementationPlan.tasks[${index}]`);
      const taskId = optionalString(record, 'taskId') ?? optionalString(record, 'id') ?? `task-${index + 1}`;
      const target = optionalStringArray(record, 'target').length
        ? optionalStringArray(record, 'target')
        : optionalStringArray(record, 'targets');
      return {
        ...record,
        taskId,
        id: optionalString(record, 'id') ?? taskId,
        title: optionalString(record, 'title') ?? taskId,
        target,
        scope: optionalString(record, 'scope') ?? optionalString(record, 'intent') ?? '',
        dependencies: optionalStringArray(record, 'dependencies').length
          ? optionalStringArray(record, 'dependencies')
          : optionalStringArray(record, 'dependsOn'),
        hardDependencies: optionalStringArray(record, 'hardDependencies').length
          ? optionalStringArray(record, 'hardDependencies')
          : optionalStringArray(record, 'hardDependsOn'),
        softOrderAfter: optionalStringArray(record, 'softOrderAfter').length
          ? optionalStringArray(record, 'softOrderAfter')
          : optionalStringArray(record, 'softDependencies'),
        conflictKeys: optionalStringArray(record, 'conflictKeys'),
        canDraftInParallel: typeof record.canDraftInParallel === 'boolean' ? record.canDraftInParallel : undefined,
        role: optionalString(record, 'role'),
        capability: optionalString(record, 'capability') ?? '',
        fileOperations: normalizeFileOperations(record.fileOperations, `Agent Protocol v3.implementationPlan.tasks[${index}].fileOperations`),
        accessScopes: normalizeAccessScopes(record.accessScopes, `Agent Protocol v3.implementationPlan.tasks[${index}].accessScopes`),
        acceptanceCriteria: optionalStringArray(record, 'acceptanceCriteria'),
        failureCriteria: optionalStringArray(record, 'failureCriteria'),
      };
    }),
  };
}

function normalizeActionBundlePayload(envelope: Record<string, unknown>, proposalId: string): Record<string, unknown> {
  const payload = optionalObjectRecord(envelope.actionBundle) ? envelope : (optionalObjectRecord(envelope.payload) ?? envelope);
  const actionBundle = requireObject(payload.actionBundle, 'Agent Protocol v3.actionBundle');
  return {
    userPlan: optionalString(payload, 'userPlanMarkdown') ?? optionalString(payload, 'userPlan'),
    codeBlocks: normalizeCodeBlocks(payload.codeBlocks),
    commandBlocks: normalizeCommandBlocks(payload.commandBlocks),
    actionBundle: normalizeActionBundle(actionBundle, proposalId),
    expectedValidation: optionalString(payload, 'expectedValidation'),
    reviewGuide: optionalString(payload, 'reviewGuide'),
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
    accessScopes: normalizeAccessScopes(value.accessScopes, 'Agent Protocol v3.actionBundle.accessScopes'),
  };
}

function normalizePlannedActions(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.actionBundle.${label}[${index}]`);
    const id = optionalString(record, 'id') ?? optionalString(record, 'actionId') ?? `${label}-${index + 1}`;
    const capability = optionalString(record, 'capability') ?? '';
    const targetPath = optionalString(record, 'targetPath');
    const targetRefPath = optionalTargetRefPath(record.targetRef);
    const resourceScope = optionalStringArray(record, 'resourceScope');
    const normalizedScope = resourceScope.length ? resourceScope : (targetPath ? [targetPath] : (targetRefPath ? [targetRefPath] : []));
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
      accessScopes: normalizeAccessScopes(record.accessScopes, `Agent Protocol v3.actionBundle.${label}[${index}].accessScopes`),
    };
  });
}

function normalizeFileOperations(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return [normalizeFileOperationShorthand(value, `${label}[0]`)];
  }
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError(
      'invalid_implementation_plan_file_operations',
      `${label} must be an array of { operation, capability, targetRef|targetPath, reason? } objects.`
    );
  }
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return normalizeFileOperationShorthand(item, `${label}[${index}]`);
    }
    const record = requireObject(item, `${label}[${index}]`);
    const operation = optionalString(record, 'operation') ?? optionalString(record, 'kind') ?? '';
    const capability = optionalString(record, 'capability') ?? '';
    const targetPath = optionalString(record, 'targetPath') ?? optionalTargetRefPath(record.targetRef);
    if (!operation) {
      throw new AgentPlanParseError(
        'invalid_implementation_plan_file_operations',
        `${label}[${index}] must include operation. Minimal shape: { "operation": "create", "capability": "fs.write", "targetPath": "relative/file.ext", "reason": "..." }.`
      );
    }
    if (!targetPath) {
      throw new AgentPlanParseError(
        'invalid_implementation_plan_file_operations',
        `${label}[${index}] must include targetPath or targetRef.path. Minimal shape: { "operation": "create", "capability": "fs.write", "targetPath": "relative/file.ext", "reason": "..." }.`
      );
    }
    if (operation && !fileOperationAllowed(operation)) {
      throw new AgentPlanParseError(
        'invalid_implementation_plan_file_operations',
        `${label}[${index}].operation must be one of create, write, patch, delete, rename.`
      );
    }
    return {
      ...record,
      operation,
      capability: capability || capabilityForFileOperation(operation),
      targetPath,
      reason: optionalString(record, 'reason') ?? optionalString(record, 'purpose'),
    };
  });
}

function normalizeAccessScopes(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return [normalizeAccessScopeShorthand(value, `${label}[0]`)];
  }
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError(
      'invalid_access_scopes',
      `${label} must be an array of { scopeKind, path, capability?|capabilities?, operations?, reason?, dependencyDepth? } objects.`
    );
  }
  return value.map((item, index) => {
    if (typeof item === 'string') {
      return normalizeAccessScopeShorthand(item, `${label}[${index}]`);
    }
    const record = requireObject(item, `${label}[${index}]`);
    const scopeKind = optionalString(record, 'scopeKind') ?? optionalString(record, 'kind') ?? 'workspaceModule';
    const path = optionalString(record, 'path') ?? optionalString(record, 'targetPath') ?? '';
    if (!path) {
      throw new AgentPlanParseError(
        'invalid_access_scopes',
        `${label}[${index}] must include path. Minimal shape: { "scopeKind": "workspaceModule", "path": "relative/module", "capabilities": ["fs.write","fs.patch"], "reason": "..." }.`
      );
    }
    if (!['workspaceModule', 'oneHopDependency'].includes(scopeKind)) {
      throw new AgentPlanParseError(
        'invalid_access_scopes',
        `${label}[${index}].scopeKind must be "workspaceModule" or "oneHopDependency".`
      );
    }
    return {
      ...record,
      scopeKind,
      path,
      capability: optionalString(record, 'capability'),
      capabilities: optionalStringArray(record, 'capabilities'),
      operations: optionalStringArray(record, 'operations'),
      reason: optionalString(record, 'reason') ?? optionalString(record, 'purpose'),
      dependencyDepth: typeof record.dependencyDepth === 'number' ? record.dependencyDepth : undefined,
      sourceTaskId: optionalString(record, 'sourceTaskId') ?? optionalString(record, 'taskId'),
    };
  });
}

function normalizeFileOperationShorthand(value: string, label: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) {
    throw new AgentPlanParseError(
      'invalid_implementation_plan_file_operations',
      `${label} string shorthand must be non-empty; use "create relative/file.ext" or { "operation": "create", "capability": "fs.write", "targetPath": "relative/file.ext" }.`
    );
  }
  const match = /^(create|write|patch|delete|rename)\s+(.+)$/i.exec(text);
  if (!match) {
    throw new AgentPlanParseError(
      'invalid_implementation_plan_file_operations',
      `${label} string shorthand must start with create, write, patch, delete, or rename followed by a concrete path.`
    );
  }
  const operation = match[1].toLowerCase();
  const targetPath = match[2].trim();
  if (!targetPath) {
    throw new AgentPlanParseError(
      'invalid_implementation_plan_file_operations',
      `${label} string shorthand must include a concrete target path.`
    );
  }
  return {
    operation,
    capability: capabilityForFileOperation(operation),
    targetPath,
    reason: text,
  };
}

function normalizeAccessScopeShorthand(value: string, label: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) {
    throw new AgentPlanParseError(
      'invalid_access_scopes',
      `${label} string shorthand must be non-empty; use "relative/module" or { "scopeKind": "workspaceModule", "path": "relative/module", "capabilities": ["fs.write","fs.patch"] }.`
    );
  }
  return {
    scopeKind: 'workspaceModule',
    path: text,
    capabilities: ['fs.write', 'fs.patch'],
    operations: ['create', 'write', 'patch'],
    reason: text,
    dependencyDepth: 0,
  };
}

function fileOperationAllowed(operation: string): boolean {
  return ['create', 'write', 'patch', 'delete', 'rename'].includes(operation);
}

function capabilityForFileOperation(operation: string): string {
  if (operation === 'delete') return 'fs.delete';
  if (operation === 'rename') return 'fs.rename';
  if (operation === 'patch') return 'fs.patch';
  if (operation === 'create' || operation === 'write') return 'fs.write';
  return '';
}

function optionalTargetRefPath(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return optionalString(value as Record<string, unknown>, 'path') ?? optionalString(value as Record<string, unknown>, 'targetPath');
}

function normalizeExpectations(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const description = value.trim();
    if (!description) {
      throw new AgentPlanParseError(
        'invalid_action_bundle_expectation',
        `Agent Protocol v3.actionBundle.${label} string value must be non-empty; use [{ "id": "${label}-1", "description": "..." }].`
      );
    }
    return [{ id: `${label}-1`, description }];
  }
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError(
      'invalid_action_bundle_expectation',
      `Agent Protocol v3.actionBundle.${label} must be an array of { id, description } objects; string and string[] are accepted only as compatibility input.`
    );
  }
  return value.map((item, index) => {
    if (typeof item === 'string') {
      const description = item.trim();
      if (!description) {
        throw new AgentPlanParseError(
          'invalid_action_bundle_expectation',
          `Agent Protocol v3.actionBundle.${label}[${index}] string value must be non-empty; use { "id": "${label}-${index + 1}", "description": "..." }.`
        );
      }
      return { id: `${label}-${index + 1}`, description };
    }
    const record = requireObject(item, `Agent Protocol v3.actionBundle.${label}[${index}]`);
    const description = optionalString(record, 'description');
    if (!description) {
      throw new AgentPlanParseError(
        'invalid_action_bundle_expectation',
        `Agent Protocol v3.actionBundle.${label}[${index}].description must be a non-empty string; minimal shape is { "id": "${label}-${index + 1}", "description": "..." }.`
      );
    }
    return {
      ...record,
      id: optionalString(record, 'id') ?? `${label}-${index + 1}`,
      description,
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
    const kind = optionalString(record, 'kind');
    const manifestEntryId = optionalString(record, 'manifestEntryId');
    const path = optionalString(record, 'path');
    const rootId = optionalString(record, 'rootId');
    const query = optionalString(record, 'query');
    const include = optionalStringArray(record, 'include');
    const contextLines = optionalNonNegativeInteger(record, 'contextLines');
    const maxResults = optionalPositiveInteger(record, 'maxResults');
    const offsetBytes = optionalNonNegativeInteger(record, 'offsetBytes');
    const limitBytes = optionalPositiveInteger(record, 'limitBytes');
    const reason = optionalString(record, 'reason') ?? 'Resolve additional context.';
    const isSearch = kind === 'search' || Boolean(query);
    if (isSearch && !query) {
      throw new AgentPlanParseError(
        'invalid_resource_request_item',
        `Agent Protocol v3.resourceRequest.items[${index}] search item must include query`
      );
    }
    if (!isSearch && !manifestEntryId && !path) {
      throw new AgentPlanParseError(
        'invalid_resource_request_item',
        `Agent Protocol v3.resourceRequest.items[${index}] must include manifestEntryId, path, or kind="search" with query`
      );
    }
    return {
      id,
      ...(isSearch ? { kind: 'search' } : (kind ? { kind } : {})),
      ...(manifestEntryId ? { manifestEntryId } : {}),
      ...(path ? { path } : {}),
      ...(rootId ? { rootId } : {}),
      ...(query ? { query } : {}),
      ...(include.length ? { include } : {}),
      ...(typeof contextLines === 'number' ? { contextLines } : {}),
      ...(typeof maxResults === 'number' ? { maxResults } : {}),
      ...(typeof offsetBytes === 'number' ? { offsetBytes } : {}),
      ...(typeof limitBytes === 'number' ? { limitBytes } : {}),
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

function optionalNonNegativeInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = optionalNonNegativeInteger(record, key);
  return typeof value === 'number' && value > 0 ? value : undefined;
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

function optionalObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
