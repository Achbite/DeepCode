import {
  AgentPlanParseError,
  type ActionBundleDraft,
  type AgentPlanParts,
  type AgentPlanTag,
  type CodeBlockDraft,
  type PlannedActionDraft,
  type RepairPolicyDraft,
  type ReviewExpectationDraft,
  type ValidationExpectationDraft,
} from './types.js';

const SINGLETON_TAGS = new Set<AgentPlanTag>([
  'USER_PLAN',
  'ACTION_BUNDLE',
  'EXPECTED_VALIDATION',
  'REVIEW_GUIDE',
  'PERMISSION_HINTS',
]);

const KNOWN_TAGS = new Set<AgentPlanTag>([...SINGLETON_TAGS, 'CODE_BLOCK']);

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

interface ParsedBlock {
  tag: AgentPlanTag;
  attrs: Record<string, string>;
  content: string;
  start: number;
  end: number;
}

export function parseAgentPlan(input: string): AgentPlanParts {
  const blocks = extractBlocks(input);
  const singleton = new Map<AgentPlanTag, ParsedBlock>();
  const codeBlocks: CodeBlockDraft[] = [];
  const codeBlockIds = new Set<string>();

  for (const block of blocks) {
    rejectNestedTags(block);
    if (block.tag === 'CODE_BLOCK') {
      const codeBlock = codeBlockFromBlock(block);
      if (codeBlockIds.has(codeBlock.id)) {
        throw new AgentPlanParseError('duplicate_code_block', `duplicate CODE_BLOCK id ${codeBlock.id}`);
      }
      codeBlockIds.add(codeBlock.id);
      codeBlocks.push(codeBlock);
      continue;
    }
    if (singleton.has(block.tag)) {
      throw new AgentPlanParseError('duplicate_tag', `duplicate ${block.tag} block`);
    }
    singleton.set(block.tag, block);
  }

  const userPlan = requireBlock(singleton, 'USER_PLAN').content.trim();
  const actionBundleBlock = requireBlock(singleton, 'ACTION_BUNDLE');
  const actionBundle = parseActionBundle(actionBundleBlock, codeBlockIds);
  const expectedValidation = requireBlock(singleton, 'EXPECTED_VALIDATION').content.trim();
  const reviewGuide = requireBlock(singleton, 'REVIEW_GUIDE').content.trim();
  const permissionHints = singleton.get('PERMISSION_HINTS')?.content.trim();

  return {
    userPlan,
    actionBundle,
    codeBlocks,
    expectedValidation: {
      content: expectedValidation,
      expectations: actionBundle.validationExpectations,
    },
    reviewGuide: {
      content: reviewGuide,
      expectations: actionBundle.reviewExpectations,
    },
    permissionHints: permissionHints ? { content: permissionHints } : undefined,
  };
}

function extractBlocks(input: string): ParsedBlock[] {
  const blockPattern =
    /<(USER_PLAN|ACTION_BUNDLE|CODE_BLOCK|EXPECTED_VALIDATION|REVIEW_GUIDE|PERMISSION_HINTS)([^>]*)>([\s\S]*?)<\/\1>/g;
  const blocks: ParsedBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(input)) !== null) {
    const tag = asKnownTag(match[1]);
    blocks.push({
      tag,
      attrs: parseAttrs(match[2] ?? ''),
      content: match[3] ?? '',
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  rejectUnknownOrStrayTags(input, blocks);
  return blocks;
}

function rejectUnknownOrStrayTags(input: string, blocks: ParsedBlock[]): void {
  const tokenPattern = /<\/?([A-Z_]+)(?:\s[^>]*)?>/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(input)) !== null) {
    const tag = match[1];
    const owner = blocks.find((block) => match && match.index >= block.start && match.index < block.end);
    if (!owner) {
      asKnownTag(tag);
      throw new AgentPlanParseError('unmatched_tag', `unmatched ${tag} tag`);
    }
    if (owner.tag === 'CODE_BLOCK') {
      continue;
    }
    if (match.index !== owner.start && match.index + match[0].length !== owner.end) {
      asKnownTag(tag);
      throw new AgentPlanParseError('nested_tag', `${owner.tag} contains a nested tag`);
    }
  }
}

function rejectNestedTags(block: ParsedBlock): void {
  if (block.tag === 'CODE_BLOCK') return;
  const nestedPattern = /<\/?([A-Z_]+)(?:\s[^>]*)?>/;
  if (nestedPattern.test(block.content)) {
    throw new AgentPlanParseError('nested_tag', `${block.tag} contains a nested tag`);
  }
}

function asKnownTag(tag: string): AgentPlanTag {
  if (!KNOWN_TAGS.has(tag as AgentPlanTag)) {
    throw new AgentPlanParseError('unknown_tag', `unknown agent plan tag ${tag}`);
  }
  return tag as AgentPlanTag;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrPattern = /([a-zA-Z][a-zA-Z0-9_-]*)=("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(raw)) !== null) {
    attrs[match[1]] = match[3] ?? match[4] ?? match[5] ?? '';
  }
  return attrs;
}

function requireBlock(blocks: Map<AgentPlanTag, ParsedBlock>, tag: AgentPlanTag): ParsedBlock {
  const block = blocks.get(tag);
  if (!block) {
    throw new AgentPlanParseError('missing_tag', `missing ${tag} block`);
  }
  return block;
}

function codeBlockFromBlock(block: ParsedBlock): CodeBlockDraft {
  const id = requireAttr(block, 'id');
  const path = requireAttr(block, 'path');
  return {
    id,
    path,
    language: block.attrs.language,
    content: block.content,
  };
}

function requireAttr(block: ParsedBlock, attr: string): string {
  const value = block.attrs[attr]?.trim();
  if (!value) {
    throw new AgentPlanParseError('missing_attr', `${block.tag} is missing ${attr}`);
  }
  return value;
}

function parseActionBundle(block: ParsedBlock, codeBlockIds: Set<string>): ActionBundleDraft {
  if (block.attrs.format !== 'json' || block.attrs.version !== '1') {
    throw new AgentPlanParseError('invalid_action_bundle_header', 'ACTION_BUNDLE must declare format="json" version="1"');
  }

  const value = parseJsonObject(block.content);
  rejectUnknownKeys(value, BUNDLE_KEYS, 'ACTION_BUNDLE');

  const version = requireString(value, 'version', 'ACTION_BUNDLE');
  if (version !== '1') {
    throw new AgentPlanParseError('unsupported_action_bundle_version', `unsupported ACTION_BUNDLE version ${version}`);
  }

  const actions = requireArray(value, 'actions', 'ACTION_BUNDLE').map((item, index) =>
    plannedActionFromValue(item, `actions[${index}]`, codeBlockIds)
  );
  const validationExpectations = requireArray(value, 'validationExpectations', 'ACTION_BUNDLE').map((item, index) =>
    validationExpectationFromValue(item, `validationExpectations[${index}]`)
  );
  const reviewExpectations = requireArray(value, 'reviewExpectations', 'ACTION_BUNDLE').map((item, index) =>
    reviewExpectationFromValue(item, `reviewExpectations[${index}]`)
  );

  return {
    version: '1',
    id: requireString(value, 'id', 'ACTION_BUNDLE'),
    goal: requireString(value, 'goal', 'ACTION_BUNDLE'),
    requirementId: optionalString(value, 'requirementId', 'ACTION_BUNDLE'),
    actions,
    validationExpectations,
    reviewExpectations,
    repairPolicy: optionalRepairPolicy(value.repairPolicy),
  };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AgentPlanParseError('invalid_action_bundle_json', error instanceof Error ? error.message : 'invalid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new AgentPlanParseError('invalid_action_bundle_json', 'ACTION_BUNDLE must be a JSON object');
  }
  return parsed;
}

function plannedActionFromValue(value: unknown, label: string, codeBlockIds: Set<string>): PlannedActionDraft {
  const object = requireObject(value, label);
  rejectUnknownKeys(object, ACTION_KEYS, label);
  const sourceBlockId = optionalString(object, 'sourceBlockId', label);
  if (sourceBlockId && !codeBlockIds.has(sourceBlockId)) {
    throw new AgentPlanParseError('missing_code_block_ref', `${label} references missing CODE_BLOCK ${sourceBlockId}`);
  }
  return {
    id: requireString(object, 'id', label),
    title: requireString(object, 'title', label),
    capability: requireString(object, 'capability', label),
    kind: optionalActionKind(object.kind, label),
    resourceScope: stringArray(object.resourceScope, `${label}.resourceScope`, true),
    canParallelize: optionalBoolean(object.canParallelize, `${label}.canParallelize`) ?? false,
    conflictKeys: stringArray(object.conflictKeys, `${label}.conflictKeys`, false),
    purpose: optionalString(object, 'purpose', label),
    sourceBlockId,
  };
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
