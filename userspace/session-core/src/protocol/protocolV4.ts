import { AgentPlanParseError, type ProposalEnvelope, type ProposalEnvelopeSource } from './types.js';

export const AGENT_PROTOCOL_V4_SCHEMA_VERSION = 'deepcode.agent.protocol.v4';

const V4_KINDS = new Set([
  'answer',
  'resourceRequest',
  'decisionRequest',
  'taskPlan',
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
    ? parseJsonObject(input.raw, 'Agent Protocol v4')
    : input.raw;
  const schemaVersion = requireString(envelope, 'schemaVersion', 'Agent Protocol v4');
  if (schemaVersion !== AGENT_PROTOCOL_V4_SCHEMA_VERSION) {
    throw new AgentPlanParseError(
      'unsupported_protocol_schema',
      `Agent Protocol v4.schemaVersion must be ${AGENT_PROTOCOL_V4_SCHEMA_VERSION}`
    );
  }
  const kind = requireString(envelope, 'kind', 'Agent Protocol v4');
  if (!V4_KINDS.has(kind)) {
    throw new AgentPlanParseError('unsupported_protocol_kind', `Agent Protocol v4.kind is unsupported: ${kind}`);
  }
  const proposalId = optionalString(envelope, 'proposalId') ?? `proposal-${input.runId}-${kind}`;
  return {
    schemaVersion: AGENT_PROTOCOL_V4_SCHEMA_VERSION,
    proposalId,
    runId: optionalString(envelope, 'runId') ?? input.runId,
    sessionId: optionalString(envelope, 'sessionId') ?? input.sessionId,
    source: (optionalString(envelope, 'source') as ProposalEnvelopeSource | undefined) ?? input.source ?? 'llm',
    kind: kind as ProposalEnvelope['kind'],
    responseLanguage: conversationLanguage(envelope.responseLanguage),
    narration: optionalString(envelope, 'narration'),
    payload: proposalPayload(envelope, kind),
    referencedResourcePacketRefs: optionalStringArray(envelope, 'referencedResourcePacketRefs'),
    referencedEvidenceRefs: optionalStringArray(envelope, 'referencedEvidenceRefs'),
    parserDiagnostics: envelope.parserDiagnostics,
  };
}

function conversationLanguage(value: unknown): ProposalEnvelope['responseLanguage'] {
  return value === 'zh-CN' || value === 'en-US' ? value : undefined;
}

function proposalPayload(envelope: Record<string, unknown>, kind: string): unknown {
  if (kind === 'answer') return requireObject(envelope.answer, 'Agent Protocol v4.answer');
  if (kind === 'resourceRequest') return normalizeResourceRequest(requireObject(envelope.resourceRequest, 'Agent Protocol v4.resourceRequest'));
  if (kind === 'decisionRequest') return normalizeDecisionRequest(decisionRequestPayload(envelope));
  if (kind === 'taskPlan') return normalizeTaskPlan(requireObject(envelope.taskPlan, 'Agent Protocol v4.taskPlan'));
  if (kind === 'diagnostic') return normalizeDiagnostic(requireObject(envelope.diagnostic, 'Agent Protocol v4.diagnostic'));
  return normalizeActionBundlePayload(envelope);
}

function decisionRequestPayload(envelope: Record<string, unknown>): Record<string, unknown> {
  return requireObject(envelope.decisionRequest, 'Agent Protocol v4.decisionRequest');
}

function normalizeTaskPlan(value: Record<string, unknown>): Record<string, unknown> {
  for (const forbidden of ['actionBundle', 'contentBlocks', 'commandBlocks', 'fileOperations', 'accessScopes']) {
    if (value[forbidden] !== undefined) {
      throw new AgentPlanParseError(
        'invalid_task_plan',
        `Agent Protocol v4.taskPlan.${forbidden} is not allowed; taskPlan is a non-executable planning artifact.`
      );
    }
  }
  const tasks = value.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    throw new AgentPlanParseError('invalid_task_plan', 'Agent Protocol v4.taskPlan.tasks must be a non-empty array');
  }
  return {
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? 'task-plan',
    title: requireString(value, 'title', 'Agent Protocol v4.taskPlan'),
    summary: requireString(value, 'summary', 'Agent Protocol v4.taskPlan'),
    tasks: tasks.map((item, index) => normalizeTaskPlanTask(item, index)),
    risks: normalizeStringList(value.risks),
    reviewCheckpoints: normalizeStringList(value.reviewCheckpoints),
  };
}

function normalizeTaskPlanTask(value: unknown, index: number): Record<string, unknown> {
  const record = requireObject(value, `Agent Protocol v4.taskPlan.tasks[${index}]`);
  for (const forbidden of ['actionBundle', 'contentBlocks', 'commandBlocks', 'fileOperations', 'accessScopes', 'sourceCode', 'patch', 'capability', 'dependsOn']) {
    if (record[forbidden] !== undefined) {
      throw new AgentPlanParseError(
        'invalid_task_plan',
        `Agent Protocol v4.taskPlan.tasks[${index}].${forbidden} is not allowed; taskPlan tasks must not contain executable content.`
      );
    }
  }
  const taskId = requireString(record, 'taskId', `Agent Protocol v4.taskPlan.tasks[${index}]`);
  const target = normalizeStringList(record.target);
  if (!Array.isArray(record.dependencies)) {
    throw new AgentPlanParseError(
      'invalid_task_plan',
      `Agent Protocol v4.taskPlan.tasks[${index}].dependencies must be an explicit string array.`
    );
  }
  const args = requireObject(record.args, `Agent Protocol v4.taskPlan.tasks[${index}].args`);
  return {
    taskId,
    title: requireString(record, 'title', `Agent Protocol v4.taskPlan.tasks[${index}]`),
    target: [...new Set(target)],
    toolId: requireString(record, 'toolId', `Agent Protocol v4.taskPlan.tasks[${index}]`),
    dependencies: normalizeStringList(record.dependencies),
    args,
    conflictKeys: normalizeStringList(record.conflictKeys),
    batchKind: optionalString(record, 'batchKind'),
    acceptanceCriteria: normalizeStringList(record.acceptanceCriteria),
    failureCriteria: normalizeStringList(record.failureCriteria),
  };
}

function normalizeActionBundlePayload(envelope: Record<string, unknown>): Record<string, unknown> {
  const payload = optionalObjectRecord(envelope.actionBundle) ? envelope : (optionalObjectRecord(envelope.payload) ?? envelope);
  if (payload !== envelope) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v4.actionBundle must be a top-level field; generic payload wrappers are not accepted.'
    );
  }
  for (const forbidden of ['userPlan', 'codeBlocks', 'commandBlocks', 'expectedValidation', 'reviewGuide']) {
    if (payload[forbidden] !== undefined) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v4.${forbidden} is not provider-facing; use userPlanMarkdown, contentBlocks, and canonical actionBundle fields.`
      );
    }
  }
  const actionBundle = requireObject(payload.actionBundle, 'Agent Protocol v4.actionBundle');
  const userPlan = optionalString(payload, 'userPlanMarkdown');
  return {
    userPlan,
    contentBlocks: normalizeContentBlocks(payload.contentBlocks),
    actionBundle: normalizeActionBundle(actionBundle),
  };
}

function normalizeContentBlocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v4.contentBlocks[${index}]`);
    for (const forbidden of ['id', 'path', 'content', 'permissionLabels']) {
      if (record[forbidden] !== undefined) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `Agent Protocol v4.contentBlocks[${index}].${forbidden} is not provider-facing; Kernel derives permissions from tool actions.`
        );
      }
    }
    const blockId = optionalString(record, 'blockId');
    const targetPath = optionalString(record, 'targetPath');
    const operation = optionalString(record, 'operation');
    if (!blockId || !targetPath || !operation) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v4.contentBlocks[${index}] requires blockId, targetPath, and operation.`
      );
    }
    if (!['create', 'createEmpty', 'overwrite', 'patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(operation)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v4.contentBlocks[${index}].operation is unsupported: ${operation}`
      );
    }
    const contentLines = optionalStringArray(record, 'contentLines');
    const allowEmptyContent = optionalBoolean(record, 'allowEmptyContent');
    if (!contentLines.length && !(operation === 'createEmpty' && allowEmptyContent)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v4.contentBlocks[${index}].contentLines must be non-empty unless operation=createEmpty and allowEmptyContent=true.`
      );
    }
    return {
      blockId,
      targetPath,
      language: optionalString(record, 'language'),
      operation,
      contentLines,
      allowEmptyContent,
    };
  });
}

function normalizeActionBundle(value: Record<string, unknown>): Record<string, unknown> {
  if (value.commandBlocks !== undefined) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v4.actionBundle.commandBlocks is no longer accepted; use actionBundle.actions[] with toolId="process.exec" and typed args.'
    );
  }
  if (value.accessScopes !== undefined) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v4.actionBundle.accessScopes is not provider-facing; Kernel derives permissions from toolId and typed args.'
    );
  }
  return {
    version: '1',
    id: requireString(value, 'id', 'Agent Protocol v4.actionBundle'),
    goal: compactProtocolSummary(requireString(value, 'goal', 'Agent Protocol v4.actionBundle')),
    actions: normalizeToolActions(value.actions, 'actions'),
    continuationExpectations: normalizeContinuationExpectations(value.continuationExpectations),
    validationExpectations: normalizeExpectations(value.validationExpectations, 'validationExpectations'),
    reviewExpectations: normalizeExpectations(value.reviewExpectations, 'reviewExpectations'),
  };
}

function compactProtocolSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function normalizeToolActions(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      `Agent Protocol v4.actionBundle.${label} must be a non-empty array.`
    );
  }
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v4.actionBundle.${label}[${index}]`);
    const actionId = optionalString(record, 'actionId');
    for (const forbidden of [
      'capability',
      'permissionLabels',
      'accessScopes',
      'resourceScope',
      'targetPath',
      'targetRef',
      'contentBlockId',
      'replacementBlockId',
      'patchSpec',
      'targetKind',
      'targetResourceKind',
      'recursive',
      'kind',
      'id',
      'title',
      'purpose',
      'toolArgs',
      'canParallelize',
      'conflictKeys',
    ]) {
      if (record[forbidden] !== undefined) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `Agent Protocol v4.actionBundle.${label}[${index}].${forbidden} is not provider-facing; use toolId plus typed args and let Kernel derive permissions and operation metadata.`
        );
      }
    }
    const toolId = optionalString(record, 'toolId');
    if (!actionId || !toolId) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v4.actionBundle.${label}[${index}] requires non-empty actionId and toolId.`
      );
    }
    const args = optionalObjectRecord(record.args);
    if (!args) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v4.actionBundle.${label}[${index}].args must be an object.`
      );
    }
    return {
      actionId,
      toolId,
      args,
      description: requireString(record, 'description', `Agent Protocol v4.actionBundle.${label}[${index}]`),
      dependsOn: optionalStringArray(record, 'dependsOn'),
    };
  });
}

function normalizeContinuationExpectations(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError(
      'invalid_action_bundle_continuation',
      'Agent Protocol v4.actionBundle.continuationExpectations must be an array of { id, description, target?, reason? } objects.'
    );
  }
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v4.actionBundle.continuationExpectations[${index}]`);
    const id = optionalString(record, 'id');
    const description = optionalString(record, 'description');
    if (!id || !description) {
      throw new AgentPlanParseError(
        'invalid_action_bundle_continuation',
        `Agent Protocol v4.actionBundle.continuationExpectations[${index}] requires non-empty id and description.`
      );
    }
    return {
      id,
      description,
      reason: optionalString(record, 'reason'),
      target: normalizeStringList(record.target),
      dependsOn: optionalStringArray(record, 'dependsOn'),
    };
  });
}

function normalizeExpectations(value: unknown, label: string): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError(
      'invalid_action_bundle_expectation',
      `Agent Protocol v4.actionBundle.${label} must be an array of { id, description } objects.`
    );
  }
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v4.actionBundle.${label}[${index}]`);
    const id = optionalString(record, 'id');
    const description = optionalString(record, 'description');
    if (!id || !description) {
      throw new AgentPlanParseError(
        'invalid_action_bundle_expectation',
        `Agent Protocol v4.actionBundle.${label}[${index}] requires non-empty id and description.`
      );
    }
    return {
      id,
      description,
    };
  });
}

function normalizeResourceRequest(value: Record<string, unknown>): Record<string, unknown> {
  const items = value.items;
  if (!Array.isArray(items)) {
    throw new AgentPlanParseError('invalid_resource_request', 'Agent Protocol v4.resourceRequest.items must be an array.');
  }
  const normalizedItems = items.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v4.resourceRequest.items[${index}]`);
    if (record.resourceType !== undefined) {
      throw new AgentPlanParseError(
        'invalid_resource_request_item',
        `Agent Protocol v4.resourceRequest.items[${index}].resourceType is not accepted; use kind.`
      );
    }
    const id = optionalString(record, 'id') ?? `item-${index}`;
    const kind = optionalString(record, 'kind');
    const rootId = optionalString(record, 'rootId');
    const path = optionalString(record, 'path');
    const rootPathRequest = rootId && typeof record.path === 'string' && record.path.trim() === '';
    const manifestEntryId = optionalString(record, 'manifestEntryId') ?? (rootPathRequest ? rootId : undefined);
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
        `Agent Protocol v4.resourceRequest.items[${index}] search item must include query`
      );
    }
    if (!isSearch && !manifestEntryId && !path) {
      throw new AgentPlanParseError(
        'invalid_resource_request_item',
        `Agent Protocol v4.resourceRequest.items[${index}] must include manifestEntryId, path, or kind="search" with query`
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
  const question = requireString(value, 'question', 'Agent Protocol v4.decisionRequest');
  const options = value.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 3) {
    throw new AgentPlanParseError(
      'invalid_decision_request',
      'Agent Protocol v4.decisionRequest.options must include 2-3 options'
    );
  }
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? 'decision-request',
    question,
    reason: optionalString(value, 'reason') ?? question,
    summary: optionalString(value, 'summary') ?? question,
    allowsFreeform: typeof value.allowsFreeform === 'boolean' ? value.allowsFreeform : true,
    options: options.map((item, index) => {
      const record = requireObject(item, `Agent Protocol v4.decisionRequest.options[${index}]`);
      for (const forbidden of ['labelKey', 'descriptionKey', 'messageArgs', 'effect']) {
        if (record[forbidden] !== undefined) {
          throw new AgentPlanParseError(
            'invalid_decision_request',
            `Agent Protocol v4.decisionRequest.options[${index}].${forbidden} is Session-internal and is not provider-facing.`
          );
        }
      }
      return {
        id: requireString(record, 'id', `Agent Protocol v4.decisionRequest.options[${index}]`),
        label: requireString(record, 'label', `Agent Protocol v4.decisionRequest.options[${index}]`),
        description: requireString(record, 'description', `Agent Protocol v4.decisionRequest.options[${index}]`),
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
    summary: requireString(value, 'summary', 'Agent Protocol v4.diagnostic'),
  };
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
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

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function optionalBoolean(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const raw = value?.[key];
  return typeof raw === 'boolean' ? raw : undefined;
}
