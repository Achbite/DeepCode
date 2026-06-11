import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type AnswerDraft,
  type AgentPlanOutput,
  type AgentPlanParts,
  type CodeBlockDraft,
  type PlannedActionDraft,
  type RepairPolicyDraft,
  type ResourceRequestDraft,
  type ResourceRequestDraftItem,
  type ReviewExpectationDraft,
  type ValidationExpectationDraft,
} from './types.js';

const BUNDLE_KEYS = new Set([
  'version',
  'id',
  'goal',
  'requirementId',
  'actions',
  'validationExpectations',
  'reviewExpectations',
  'repairPolicy',
]);
const RESOURCE_REQUEST_KEYS = new Set(['version', 'id', 'reason', 'items']);
const RESOURCE_REQUEST_ITEM_KEYS = new Set(['id', 'manifestEntryId', 'reason']);
const ACTION_KEYS = new Set([
  'id',
  'title',
  'capability',
  'kind',
  'resourceScope',
  'canParallelize',
  'conflictKeys',
  'purpose',
  'sourceBlockId',
]);
const VALIDATION_KEYS = new Set(['id', 'description', 'command']);
const REVIEW_KEYS = new Set(['id', 'description']);
const REPAIR_KEYS = new Set([
  'maxRounds',
  'allowedFiles',
  'forbidNewFilesAfterApproval',
  'forbidNewPermissionsAfterApproval',
]);
const AGENT_PROTOCOL_SCHEMA_VERSION = 'deepcode.agent.protocol.v2';
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'kind',
  'outputLanguage',
  'answer',
  'resourceRequest',
  'userPlan',
  'actionBundle',
  'codeBlocks',
  'expectedValidation',
  'reviewGuide',
]);
const ANSWER_KEYS = new Set(['format', 'content']);
const CODE_BLOCK_KEYS = new Set(['id', 'path', 'language', 'content']);
const PLAN_CAPABILITIES = new Set([
  'workspace.read',
  'workspace.search',
  'workspace.preview_diff',
  'workspace.write',
  'workspace.delete',
  'process.propose',
  'process.exec',
  'network.egress',
  'git.read',
  'git.write',
  'browser.control',
]);

export function parseAgentPlan(input: string): AgentPlanParts {
  const output = parseAgentPlanOutput(input);
  if (output.kind !== 'actionPlan') {
    throw new AgentPlanParseError(
      'missing_action_bundle',
      `${output.kind === 'answer' ? 'ANSWER' : 'RESOURCE_REQUEST'} cannot be treated as an executable plan`
    );
  }
  return output.parts;
}

export function parseAgentPlanOutput(input: string): AgentPlanOutput {
  if (!input.trim().startsWith('{')) {
    throw new AgentPlanParseError('invalid_json_envelope', 'agent plan output must be one JSON Envelope v2 object');
  }
  return parseJsonEnvelopeOutput(input);
}

function parseJsonEnvelopeOutput(input: string): AgentPlanOutput {
  const envelope = parseJsonObject(input, 'JSON Envelope v2');
  rejectUnknownKeys(envelope, ENVELOPE_KEYS, 'JSON Envelope v2');
  const schemaVersion = requireString(envelope, 'schemaVersion', 'JSON Envelope v2');
  if (schemaVersion !== AGENT_PROTOCOL_SCHEMA_VERSION) {
    throw new AgentPlanParseError(
      'unsupported_protocol_schema',
      `JSON Envelope v2.schemaVersion must be ${AGENT_PROTOCOL_SCHEMA_VERSION}`
    );
  }
  requireString(envelope, 'outputLanguage', 'JSON Envelope v2');
  const kind = requireString(envelope, 'kind', 'JSON Envelope v2');
  if (kind === 'answer') {
    rejectBranchPayloads(envelope, 'answer', [
      'resourceRequest',
      'userPlan',
      'actionBundle',
      'codeBlocks',
      'expectedValidation',
      'reviewGuide',
    ]);
    return {
      kind: 'answer',
      answer: answerFromEnvelope(envelope.answer),
    };
  }
  if (kind === 'resourceRequest') {
    rejectBranchPayloads(envelope, 'resourceRequest', ['answer', 'actionBundle', 'codeBlocks', 'expectedValidation', 'reviewGuide']);
    return {
      kind: 'resourceRequest',
      userPlan: optionalString(envelope, 'userPlan', 'JSON Envelope v2'),
      resourceRequest: resourceRequestFromObject(requireObject(envelope.resourceRequest, 'JSON Envelope v2.resourceRequest'), 'JSON Envelope v2.resourceRequest'),
    };
  }
  if (kind === 'actionBundle') {
    rejectBranchPayloads(envelope, 'actionBundle', ['answer', 'resourceRequest']);
    const codeBlocks = codeBlocksFromEnvelope(envelope.codeBlocks);
    const codeBlockIds = new Set(codeBlocks.map((block) => block.id));
    const actionBundle = actionBundleFromObject(
      requireObject(envelope.actionBundle, 'JSON Envelope v2.actionBundle'),
      codeBlockIds,
      'JSON Envelope v2.actionBundle'
    );
    rejectOrphanCodeBlocks(codeBlockIds, actionBundle);
    return {
      kind: 'actionPlan',
      parts: {
        userPlan: requireString(envelope, 'userPlan', 'JSON Envelope v2'),
        actionBundle,
        codeBlocks,
        expectedValidation: {
          content: requireString(envelope, 'expectedValidation', 'JSON Envelope v2'),
          expectations: actionBundle.validationExpectations,
        },
        reviewGuide: {
          content: requireString(envelope, 'reviewGuide', 'JSON Envelope v2'),
          expectations: actionBundle.reviewExpectations,
        },
      },
    };
  }
  throw new AgentPlanParseError('unsupported_protocol_kind', `JSON Envelope v2.kind is unsupported: ${kind}`);
}

function rejectBranchPayloads(envelope: Record<string, unknown>, branch: string, forbidden: string[]): void {
  for (const key of forbidden) {
    if (envelope[key] !== undefined) {
      throw new AgentPlanParseError('branch_payload_conflict', `JSON Envelope v2 kind ${branch} cannot include branch payload ${key}`);
    }
  }
}

function answerFromEnvelope(value: unknown): AnswerDraft {
  const object = requireObject(value, 'JSON Envelope v2.answer');
  rejectUnknownKeys(object, ANSWER_KEYS, 'JSON Envelope v2.answer');
  const format = requireString(object, 'format', 'JSON Envelope v2.answer');
  if (format !== 'markdown') {
    throw new AgentPlanParseError('invalid_answer_format', 'JSON Envelope v2.answer.format must be markdown');
  }
  return {
    format: 'markdown',
    version: '1',
    content: requireString(object, 'content', 'JSON Envelope v2.answer'),
  };
}

function codeBlocksFromEnvelope(value: unknown): CodeBlockDraft[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError('invalid_code_blocks', 'JSON Envelope v2.codeBlocks must be an array');
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const label = `JSON Envelope v2.codeBlocks[${index}]`;
    const object = requireObject(item, label);
    rejectUnknownKeys(object, CODE_BLOCK_KEYS, label);
    const id = requireString(object, 'id', label);
    if (seen.has(id)) {
      throw new AgentPlanParseError('duplicate_code_block', `duplicate codeBlocks id ${id}`);
    }
    seen.add(id);
    const path = requireString(object, 'path', label);
    rejectUnsafeWorkspacePath(path, `${label}.path`);
    return {
      id,
      path,
      language: optionalString(object, 'language', label),
      content: requireString(object, 'content', label),
    };
  });
}

function actionBundleFromObject(value: Record<string, unknown>, codeBlockIds: Set<string>, label: string): ActionBundleDraft {
  rejectUnknownKeys(value, BUNDLE_KEYS, label);
  const version = requireString(value, 'version', 'ACTION_BUNDLE');
  if (version !== '1') {
    throw new AgentPlanParseError('unsupported_action_bundle_version', `unsupported ACTION_BUNDLE version ${version}`);
  }

  const actions = requireArray(value, 'actions', label).map((item, index) =>
    plannedActionFromValue(item, `actions[${index}]`, codeBlockIds)
  );
  const validationExpectations = requireArray(value, 'validationExpectations', label).map((item, index) =>
    validationExpectationFromValue(item, `validationExpectations[${index}]`)
  );
  const reviewExpectations = requireArray(value, 'reviewExpectations', label).map((item, index) =>
    reviewExpectationFromValue(item, `reviewExpectations[${index}]`)
  );

  return {
    version: '1',
    id: requireString(value, 'id', label),
    goal: requireString(value, 'goal', label),
    requirementId: optionalString(value, 'requirementId', label),
    actions,
    validationExpectations,
    reviewExpectations,
    repairPolicy: optionalRepairPolicy(value.repairPolicy),
  };
}

function resourceRequestFromObject(value: Record<string, unknown>, label: string): ResourceRequestDraft {
  rejectUnknownKeys(value, RESOURCE_REQUEST_KEYS, label);
  const version = requireString(value, 'version', label);
  if (version !== '1') {
    throw new AgentPlanParseError('unsupported_resource_request_version', `unsupported RESOURCE_REQUEST version ${version}`);
  }
  return {
    version: '1',
    id: requireString(value, 'id', label),
    reason: requireString(value, 'reason', label),
    items: requireArray(value, 'items', label).map((item, index) =>
      resourceRequestItemFromValue(item, `items[${index}]`)
    ),
  };
}

function parseJsonObject(raw: string, label = 'ACTION_BUNDLE'): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentPlanParseError(
      label === 'JSON Envelope v2' ? 'invalid_json_envelope' : 'invalid_json_object',
      error instanceof Error ? error.message : 'invalid JSON'
    );
  }
  if (!isPlainObject(parsed)) {
    throw new AgentPlanParseError(
      label === 'JSON Envelope v2' ? 'invalid_json_envelope' : 'invalid_json_object',
      `${label} must be a JSON object`
    );
  }
  return parsed;
}

function resourceRequestItemFromValue(value: unknown, label: string): ResourceRequestDraftItem {
  const object = requireObject(value, label);
  rejectUnknownKeys(object, RESOURCE_REQUEST_ITEM_KEYS, label);
  return {
    id: requireString(object, 'id', label),
    manifestEntryId: requireString(object, 'manifestEntryId', label),
    reason: requireString(object, 'reason', label),
  };
}

function plannedActionFromValue(value: unknown, label: string, codeBlockIds: Set<string>): PlannedActionDraft {
  const object = requireObject(value, label);
  rejectUnknownKeys(object, ACTION_KEYS, label);
  const sourceBlockId = optionalString(object, 'sourceBlockId', label);
  if (sourceBlockId && !codeBlockIds.has(sourceBlockId)) {
    throw new AgentPlanParseError('missing_code_block_ref', `${label} references missing CODE_BLOCK ${sourceBlockId}`);
  }
  const capability = requireString(object, 'capability', label);
  validatePlanCapability(capability, `${label}.capability`);
  const kind = optionalActionKind(object.kind, label);
  if (!sourceBlockId && capability === 'workspace.write' && kind === 'write') {
    throw new AgentPlanParseError('missing_code_block_ref', `${label} workspace.write must reference codeBlocks via sourceBlockId`);
  }
  const resourceScope = stringArray(object.resourceScope, `${label}.resourceScope`, true);
  for (const resource of resourceScope) {
    rejectUnsafeResourceScope(resource, `${label}.resourceScope`);
  }
  return {
    id: requireString(object, 'id', label),
    title: requireString(object, 'title', label),
    capability,
    kind,
    resourceScope,
    canParallelize: optionalBoolean(object.canParallelize, `${label}.canParallelize`) ?? false,
    conflictKeys: stringArray(object.conflictKeys, `${label}.conflictKeys`, false),
    purpose: optionalString(object, 'purpose', label),
    sourceBlockId,
  };
}

function validatePlanCapability(value: string, label: string): void {
  if (PLAN_CAPABILITIES.has(value)) return;
  if (value.includes('.')) {
    throw new AgentPlanParseError('invalid_capability_namespace', `${label} must use capability namespace, not executor tool name ${value}`);
  }
  throw new AgentPlanParseError('unknown_capability', `${label} is not a known capability`);
}

function rejectOrphanCodeBlocks(codeBlockIds: Set<string>, actionBundle: ActionBundleDraft): void {
  const referenced = new Set(actionBundle.actions.map((action) => action.sourceBlockId).filter((id): id is string => !!id));
  for (const id of codeBlockIds) {
    if (!referenced.has(id)) {
      throw new AgentPlanParseError('orphan_code_block', `CODE_BLOCK ${id} is not referenced by ACTION_BUNDLE`);
    }
  }
}

function rejectUnsafeResourceScope(value: string, label: string): void {
  if (value.includes('*') || value.startsWith('symbol:') || value.startsWith('search:') || value.startsWith('checkpoint:')) {
    return;
  }
  rejectUnsafeWorkspacePath(value, label);
}

function rejectUnsafeWorkspacePath(value: string, label: string): void {
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    throw new AgentPlanParseError('unsafe_workspace_path', `${label} must be workspace-relative and must not contain ..`);
  }
}

function validationExpectationFromValue(value: unknown, label: string): ValidationExpectationDraft {
  const object = requireObject(value, label);
  rejectUnknownKeys(object, VALIDATION_KEYS, label);
  return {
    id: requireString(object, 'id', label),
    description: requireString(object, 'description', label),
    command: optionalString(object, 'command', label),
  };
}

function reviewExpectationFromValue(value: unknown, label: string): ReviewExpectationDraft {
  const object = requireObject(value, label);
  rejectUnknownKeys(object, REVIEW_KEYS, label);
  return {
    id: requireString(object, 'id', label),
    description: requireString(object, 'description', label),
  };
}

function optionalRepairPolicy(value: unknown): RepairPolicyDraft | undefined {
  if (value === undefined) return undefined;
  const object = requireObject(value, 'repairPolicy');
  rejectUnknownKeys(object, REPAIR_KEYS, 'repairPolicy');
  return {
    maxRounds: requireNumber(object, 'maxRounds', 'repairPolicy'),
    allowedFiles: stringArray(object.allowedFiles, 'repairPolicy.allowedFiles', false),
    forbidNewFilesAfterApproval: requireBoolean(object, 'forbidNewFilesAfterApproval', 'repairPolicy'),
    forbidNewPermissionsAfterApproval: requireBoolean(object, 'forbidNewPermissionsAfterApproval', 'repairPolicy'),
  };
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AgentPlanParseError('unknown_field', `${label} contains unknown field ${key}`);
    }
  }
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new AgentPlanParseError('invalid_object', `${label} must be an object`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: Record<string, unknown>, key: string, label: string): string {
  const raw = value[key];
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AgentPlanParseError('missing_string', `${label}.${key} must be a non-empty string`);
  }
  return raw;
}

function optionalString(value: Record<string, unknown>, key: string, label: string): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new AgentPlanParseError('invalid_string', `${label}.${key} must be a non-empty string when provided`);
  }
  return raw;
}

function requireArray(value: Record<string, unknown>, key: string, label: string): unknown[] {
  const raw = value[key];
  if (!Array.isArray(raw)) {
    throw new AgentPlanParseError('missing_array', `${label}.${key} must be an array`);
  }
  return raw;
}

function stringArray(value: unknown, label: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError('invalid_string_array', `${label} must be an array of strings`);
  }
  if (!value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new AgentPlanParseError('invalid_string_array', `${label} must contain only non-empty strings`);
  }
  return value;
}

function optionalActionKind(value: unknown, label: string): PlannedActionDraft['kind'] {
  if (value === undefined) return undefined;
  if (
    value === 'read' ||
    value === 'write' ||
    value === 'delete' ||
    value === 'command' ||
    value === 'validation' ||
    value === 'review' ||
    value === 'repair'
  ) {
    return value;
  }
  throw new AgentPlanParseError('invalid_action_kind', `${label}.kind is not supported`);
}

function requireNumber(value: Record<string, unknown>, key: string, label: string): number {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new AgentPlanParseError('invalid_number', `${label}.${key} must be a finite number`);
  }
  return raw;
}

function requireBoolean(value: Record<string, unknown>, key: string, label: string): boolean {
  const raw = value[key];
  if (typeof raw !== 'boolean') {
    throw new AgentPlanParseError('invalid_boolean', `${label}.${key} must be a boolean`);
  }
  return raw;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new AgentPlanParseError('invalid_boolean', `${label} must be a boolean`);
  }
  return value;
}
