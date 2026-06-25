import { AgentPlanParseError, type ProposalEnvelope, type ProposalEnvelopeSource } from './types.js';
import { isKernelCatalogToolId } from './protocolContract.js';

export const AGENT_PROTOCOL_V3_SCHEMA_VERSION = 'deepcode.agent.protocol.v3';

const V3_KINDS = new Set([
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
  if (kind === 'decisionRequest') return normalizeDecisionRequest(decisionRequestPayload(envelope));
  if (kind === 'taskPlan') return normalizeTaskPlan(requireObject(envelope.taskPlan, 'Agent Protocol v3.taskPlan'));
  if (kind === 'diagnostic') return normalizeDiagnostic(requireObject(envelope.diagnostic, 'Agent Protocol v3.diagnostic'));
  return normalizeActionBundlePayload(envelope, proposalId);
}

function decisionRequestPayload(envelope: Record<string, unknown>): Record<string, unknown> {
  const nested = optionalObjectRecord(envelope.decisionRequest);
  if (nested) return nested;
  const question = optionalString(envelope, 'question') ?? optionalString(envelope, 'reason') ?? optionalString(envelope, 'summary');
  const options = envelope.options;
  if (question || options !== undefined) {
    return {
      id: optionalString(envelope, 'id') ?? optionalString(envelope, 'decisionId'),
      question,
      reason: optionalString(envelope, 'reason') ?? question,
      summary: optionalString(envelope, 'summary') ?? question,
      options,
      allowsFreeform: envelope.allowsFreeform,
      decisionScope: envelope.decisionScope,
      context: envelope.context,
    };
  }
  return requireObject(envelope.decisionRequest, 'Agent Protocol v3.decisionRequest');
}

function normalizeTaskPlan(value: Record<string, unknown>): Record<string, unknown> {
  for (const forbidden of ['actionBundle', 'codeBlocks', 'commandBlocks', 'fileOperations', 'accessScopes']) {
    if (value[forbidden] !== undefined) {
      throw new AgentPlanParseError(
        'invalid_task_plan',
        `Agent Protocol v3.taskPlan.${forbidden} is not allowed; taskPlan is a non-executable planning artifact.`
      );
    }
  }
  const tasks = value.tasks;
  if (!Array.isArray(tasks) || !tasks.length) {
    throw new AgentPlanParseError('invalid_task_plan', 'Agent Protocol v3.taskPlan.tasks must be a non-empty array');
  }
  return {
    ...value,
    version: optionalString(value, 'version') ?? '1',
    id: optionalString(value, 'id') ?? 'task-plan',
    title: optionalString(value, 'title') ?? 'Task plan',
    summary: optionalString(value, 'summary') ?? optionalString(value, 'goal') ?? 'Task plan',
    tasks: tasks.map((item, index) => normalizeTaskPlanTask(item, index)),
    risks: normalizeStringList(value.risks),
    reviewCheckpoints: normalizeStringList(value.reviewCheckpoints),
  };
}

function normalizeTaskPlanTask(value: unknown, index: number): Record<string, unknown> {
  const record = requireObject(value, `Agent Protocol v3.taskPlan.tasks[${index}]`);
  for (const forbidden of ['actionBundle', 'codeBlocks', 'commandBlocks', 'fileOperations', 'accessScopes', 'sourceCode', 'patch']) {
    if (record[forbidden] !== undefined) {
      throw new AgentPlanParseError(
        'invalid_task_plan',
        `Agent Protocol v3.taskPlan.tasks[${index}].${forbidden} is not allowed; taskPlan tasks must not contain executable content.`
      );
    }
  }
  const taskId = optionalString(record, 'taskId') ?? optionalString(record, 'id') ?? `task-${index + 1}`;
  const target = normalizeStringList(record.target).concat(normalizeStringList(record.targets));
  return {
    ...record,
    taskId,
    id: optionalString(record, 'id') ?? taskId,
    title: optionalString(record, 'title') ?? taskId,
    target: [...new Set(target)],
    capability: optionalString(record, 'capability') ?? optionalString(record, 'toolId'),
    dependencies: normalizeStringList(record.dependencies).concat(normalizeStringList(record.dependsOn)),
    hardDependencies: normalizeStringList(record.hardDependencies).concat(normalizeStringList(record.hardDependsOn)),
    softOrderAfter: normalizeStringList(record.softOrderAfter).concat(normalizeStringList(record.softDependencies)),
    conflictKeys: normalizeStringList(record.conflictKeys),
    canDraftInParallel: record.canDraftInParallel !== false,
    acceptanceCriteria: normalizeStringList(record.acceptanceCriteria),
    failureCriteria: normalizeStringList(record.failureCriteria),
  };
}

function normalizeActionBundlePayload(envelope: Record<string, unknown>, proposalId: string): Record<string, unknown> {
  const payload = optionalObjectRecord(envelope.actionBundle) ? envelope : (optionalObjectRecord(envelope.payload) ?? envelope);
  if (payload !== envelope) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v3.actionBundle must be a top-level field; generic payload wrappers are not accepted.'
    );
  }
  if (payload.commandBlocks !== undefined) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v3.commandBlocks is no longer provider-facing; represent command plans as actionBundle.actions[] with toolId="process.exec" and typed args.'
    );
  }
  const actionBundle = requireObject(payload.actionBundle, 'Agent Protocol v3.actionBundle');
  const userPlan = optionalString(payload, 'userPlanMarkdown') ?? optionalString(payload, 'userPlan');
  return {
    userPlan,
    codeBlocks: normalizeCodeBlocks(payload.codeBlocks),
    actionBundle: normalizeActionBundle(actionBundle, proposalId, userPlan),
    expectedValidation: optionalString(payload, 'expectedValidation'),
    reviewGuide: optionalString(payload, 'reviewGuide'),
  };
}

function normalizeCodeBlocks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.codeBlocks[${index}]`);
    for (const forbidden of ['permissionLabels']) {
      if (record[forbidden] !== undefined) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `Agent Protocol v3.codeBlocks[${index}].${forbidden} is not provider-facing; Kernel derives permissions from tool actions.`
        );
      }
    }
    const id = optionalString(record, 'id') ?? optionalString(record, 'blockId') ?? `code-block-${index + 1}`;
    const path = optionalString(record, 'path') ?? optionalString(record, 'targetPath') ?? '';
    const contentLines = optionalStringArray(record, 'contentLines');
    const legacyContent = optionalString(record, 'content');
    if (!contentLines.length && typeof legacyContent === 'string' && (legacyContent.includes('\n') || legacyContent.length > 200)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v3.codeBlocks[${index}] must use contentLines for source content; do not return large or multiline codeBlocks.content strings.`
      );
    }
    const content = contentLines.length ? contentLines.join('\n') : legacyContent;
    return {
      ...record,
      id,
      blockId: optionalString(record, 'blockId') ?? id,
      path,
      targetPath: optionalString(record, 'targetPath') ?? path,
      content,
      contentLines: contentLines.length ? contentLines : undefined,
    };
  });
}

function normalizeActionBundle(value: Record<string, unknown>, proposalId: string, userPlan?: string): Record<string, unknown> {
  if (value.commandBlocks !== undefined) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v3.actionBundle.commandBlocks is no longer accepted; use actionBundle.actions[] with toolId="process.exec" and typed args.'
    );
  }
  if (value.accessScopes !== undefined) {
    throw new AgentPlanParseError(
      'invalid_action_bundle',
      'Agent Protocol v3.actionBundle.accessScopes is not provider-facing; Kernel derives permissions from toolId and typed args.'
    );
  }
  return {
    ...value,
    // S2：actionBundle.version 在 v3 协议中固定为 "1"，模型给出缺失/数字/其它值时强制归一，
    // 避免下游 version 强校验因模型笔误整轮失败（仍保留对结构性错误的拒绝）。
    version: '1',
    id: optionalString(value, 'id') ?? `${proposalId}-action-bundle`,
    goal: deriveActionBundleGoal(value, proposalId, userPlan),
    actions: normalizeToolActions(value.actions, 'actions'),
    continuationExpectations: normalizeContinuationExpectations(value.continuationExpectations),
    validationExpectations: normalizeExpectations(value.validationExpectations, 'validationExpectations'),
    reviewExpectations: normalizeExpectations(value.reviewExpectations, 'reviewExpectations'),
  };
}

function deriveActionBundleGoal(value: Record<string, unknown>, proposalId: string, userPlan?: string): string {
  return compactProtocolSummary(
    optionalString(value, 'goal') ??
      optionalString(value, 'summary') ??
      optionalString(value, 'description') ??
      userPlan ??
      firstActionDescription(value.actions) ??
      proposalId,
  );
}

function firstActionDescription(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const record = optionalObjectRecord(item);
    const description = record
      ? optionalString(record, 'description') ?? optionalString(record, 'title') ?? optionalString(record, 'purpose')
      : undefined;
    if (description) return description;
  }
  return undefined;
}

function compactProtocolSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 237)}...` : compact;
}

function normalizeToolActions(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.actionBundle.${label}[${index}]`);
    const id = optionalString(record, 'id') ?? optionalString(record, 'actionId') ?? `${label}-${index + 1}`;
    for (const forbidden of [
      'capability',
      'permissionLabels',
      'accessScopes',
      'resourceScope',
      'targetPath',
      'targetRef',
      'sourceBlockId',
      'replacementBlockId',
      'patchSpec',
      'targetKind',
      'targetResourceKind',
      'recursive',
      'kind',
    ]) {
      if (record[forbidden] !== undefined) {
        throw new AgentPlanParseError(
          'invalid_action_bundle',
          `Agent Protocol v3.actionBundle.${label}[${index}].${forbidden} is not provider-facing; use toolId plus typed args and let Kernel derive permissions and operation metadata.`
        );
      }
    }
    const toolId = optionalString(record, 'toolId');
    if (!toolId) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v3.actionBundle.${label}[${index}].toolId must be a non-empty Kernel catalog toolId.`
      );
    }
    if (!isKernelCatalogToolId(toolId)) {
      throw new AgentPlanParseError(
        'invalid_action_bundle',
        `Agent Protocol v3.actionBundle.${label}[${index}].toolId is not in the Kernel catalog: ${toolId}`
      );
    }
    const args = optionalObjectRecord(record.args) ?? {};
    const targetPath = optionalString(args, 'path') ?? optionalString(args, 'targetPath');
    const normalizedScope = targetPath ? [targetPath] : [];
    const conflictKeys = optionalStringArray(record, 'conflictKeys');
    const sourceBlockId = optionalString(args, 'sourceBlockId');
    const replacementBlockId = optionalString(args, 'replacementBlockId');
    const patchSpec = args.patchSpec;
    return {
      ...record,
      id,
      actionId: optionalString(record, 'actionId') ?? id,
      title: optionalString(record, 'title') ?? optionalString(record, 'description') ?? id,
      toolId,
      args,
      toolArgs: args,
      capability: kernelCapabilityForToolId(toolId),
      targetPath,
      resourceScope: normalizedScope,
      canParallelize: typeof record.canParallelize === 'boolean' ? record.canParallelize : false,
      conflictKeys: conflictKeys.length ? conflictKeys : normalizedScope,
      purpose: optionalString(record, 'purpose') ?? optionalString(record, 'description'),
      dependsOn: optionalStringArray(record, 'dependsOn'),
      sourceBlockId,
      replacementBlockId,
      patchSpec,
      targetKind: optionalString(record, 'targetKind') ?? optionalString(record, 'targetResourceKind') ?? optionalString(args, 'targetKind') ?? optionalString(args, 'targetResourceKind'),
      targetResourceKind: optionalString(record, 'targetResourceKind') ?? optionalString(record, 'targetKind') ?? optionalString(args, 'targetResourceKind') ?? optionalString(args, 'targetKind'),
      recursive: typeof record.recursive === 'boolean' ? record.recursive : optionalBoolean(args, 'recursive'),
    };
  });
}

function normalizeContinuationExpectations(value: unknown): Array<Record<string, unknown>> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const description = value.trim();
    if (!description) {
      throw new AgentPlanParseError(
        'invalid_action_bundle_continuation',
        'Agent Protocol v3.actionBundle.continuationExpectations string value must be non-empty; use [{ "id": "continuation-1", "description": "..." }].'
      );
    }
    return [{ id: 'continuation-1', description }];
  }
  if (!Array.isArray(value)) {
    throw new AgentPlanParseError(
      'invalid_action_bundle_continuation',
      'Agent Protocol v3.actionBundle.continuationExpectations must be an array of { id, description, target?, reason?, dependsOn? } objects; string and string[] are accepted only as compatibility input.'
    );
  }
  return value.map((item, index) => {
    if (typeof item === 'string') {
      const description = item.trim();
      if (!description) {
        throw new AgentPlanParseError(
          'invalid_action_bundle_continuation',
          `Agent Protocol v3.actionBundle.continuationExpectations[${index}] string value must be non-empty; use { "id": "continuation-${index + 1}", "description": "..." }.`
        );
      }
      return { id: `continuation-${index + 1}`, description };
    }
    const record = requireObject(item, `Agent Protocol v3.actionBundle.continuationExpectations[${index}]`);
    const description = optionalString(record, 'description') ?? optionalString(record, 'summary') ?? optionalString(record, 'title');
    if (!description) {
      throw new AgentPlanParseError(
        'invalid_action_bundle_continuation',
        `Agent Protocol v3.actionBundle.continuationExpectations[${index}].description must be a non-empty string; minimal shape is { "id": "continuation-${index + 1}", "description": "..." }.`
      );
    }
    const target = normalizeStringList(record.target).concat(normalizeStringList(record.targets));
    const args = optionalObjectRecord(record.args) ?? {};
    const argsPath = optionalString(args, 'path') ?? optionalString(args, 'targetPath');
    const resourceScope = normalizeStringList(record.resourceScope);
    const normalizedScope = target.length
      ? target
      : (resourceScope.length ? resourceScope : (argsPath ? [argsPath] : []));
    return {
      ...record,
      id: optionalString(record, 'id') ?? optionalString(record, 'continuationId') ?? `continuation-${index + 1}`,
      title: optionalString(record, 'title') ?? description,
      description,
      reason: optionalString(record, 'reason'),
      target: target.length ? target : undefined,
      resourceScope: normalizedScope,
      dependsOn: optionalStringArray(record, 'dependsOn'),
    };
  });
}

function kernelCapabilityForToolId(toolId: string): string {
  if (toolId.startsWith('git.')) {
    return toolId === 'git.status' || toolId === 'git.diff' ? 'git.read' : (toolId === 'git.push' ? 'git.push' : 'git.write');
  }
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
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
  const items = Array.isArray(value.items)
    ? value.items
    : Array.isArray(value.resources)
      ? value.resources
      : Array.isArray(value.resourceRequests)
        ? value.resourceRequests
        : undefined;
  if (!Array.isArray(items)) {
    throw new AgentPlanParseError('invalid_resource_request', 'Agent Protocol v3.resourceRequest.items must be an array; compatibility aliases resources[]/resourceRequests[] are accepted only during parser canonicalization');
  }
  const normalizedItems = items.map((item, index) => {
    const record = requireObject(item, `Agent Protocol v3.resourceRequest.items[${index}]`);
    const id = optionalString(record, 'id') ?? `item-${index}`;
    const resourceType = optionalString(record, 'resourceType');
    const kind = optionalString(record, 'kind') ?? (
      resourceType === 'file' || resourceType === 'directory' || resourceType === 'resource' || resourceType === 'search'
        ? resourceType
        : undefined
    );
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
  const question = optionalString(value, 'question') ?? optionalString(value, 'summary') ?? optionalString(value, 'reason');
  if (!question) {
    throw new AgentPlanParseError(
      'invalid_decision_request',
      'Agent Protocol v3.decisionRequest.question must be a non-empty string'
    );
  }
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
    question,
    reason: optionalString(value, 'reason') ?? question,
    summary: optionalString(value, 'summary') ?? question,
    allowsFreeform: typeof value.allowsFreeform === 'boolean' ? value.allowsFreeform : true,
    options: options.map((item, index) => {
      const record = requireObject(item, `Agent Protocol v3.decisionRequest.options[${index}]`);
      const normalized: Record<string, unknown> = {
        id: optionalString(record, 'id') ?? `option-${index + 1}`,
        label: optionalString(record, 'label') ?? `Option ${index + 1}`,
        description: optionalString(record, 'description') ?? '',
        recommended: typeof record.recommended === 'boolean' ? record.recommended : index === 0,
      };
      const effect = normalizeOptionEffect(record.effect);
      if (effect) normalized.effect = effect;
      return normalized;
    }),
  };
}

// 归一化用户介入卡 option.effect：未声明或非法时返回 undefined（按 continueWithAction 处理）。
// 不在此处把 undefined 写回字段，保持事件 payload 干净（无 effect 即向下兼容）。
function normalizeOptionEffect(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === 'string' ? record.kind : undefined;
  if (!kind) return undefined;
  switch (kind) {
    case 'continueWithAction':
    case 'skipCurrentTask':
    case 'finishRun':
      return { kind };
    case 'markTasksCompleted': {
      const ids = Array.isArray(record.taskIds)
        ? record.taskIds.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
      if (ids.length === 0) return undefined;
      return { kind, taskIds: ids };
    }
    case 'replan': {
      const reason = typeof record.reason === 'string' ? record.reason : undefined;
      return reason ? { kind, reason } : { kind };
    }
    default:
      return undefined;
  }
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
  const candidate = extractJsonCandidate(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new AgentPlanParseError('invalid_json_envelope', `${label} must be valid JSON: ${String(error)}`);
  }
  return requireObject(parsed, label);
}

// S1 宽松提取：模型常在合法 JSON 前后附带说明文字或 ```json 代码围栏，
// 严格 JSON.parse 会因尾随内容整体失败。此处先去围栏，若仍不可解析则按平衡花括号
// 截取首个完整的顶层 JSON 对象，丢弃其前后噪声。仅做"提取"，不改变 JSON 语义。
function extractJsonCandidate(raw: string): string {
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();
  try {
    JSON.parse(text);
    return text;
  } catch {
    // 继续尝试截取首个平衡对象
  }
  const start = text.indexOf('{');
  if (start < 0) return text;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
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
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function optionalBoolean(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const raw = value?.[key];
  return typeof raw === 'boolean' ? raw : undefined;
}
