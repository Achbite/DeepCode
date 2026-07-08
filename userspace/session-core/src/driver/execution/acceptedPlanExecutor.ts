import type { ActionBundleDraft, ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type { AcceptedPlanAdmission } from '../../accepted-plan/AcceptedPlanAdmission.js';
import type { ResourcePacket, ResourcePacketItem } from '../../context/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanExactOperationGrant,
  AcceptedPlanBatchValidationResult,
  CurrentTaskContext,
  TaskExecutionCursor,
} from '../../accepted-plan/types.js';
import type { PlanContext } from '../proposal/planContextIndex.js';

export interface AcceptedPlanReadOnlyResourceCompletion {
  taskId: string;
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
  coveredTargets: string[];
}

export interface AcceptedPlanRemovedAccessScope {
  index: number;
  reason: string;
  source: string;
  path?: string;
  scopeKind?: string;
  scope: unknown;
}

export interface AcceptedPlanAccessScopeCanonicalizationResult {
  proposal: ProposalEnvelope;
  changed: boolean;
  removedAccessScopes: AcceptedPlanRemovedAccessScope[];
  actionTargets: string[];
}

export type NormalizedAcceptedPlanKernelBatch =
  | {
      ok: true;
      batch: {
        planId: string;
        contractId?: string;
        actionBundle: Record<string, unknown>;
        codeBlocks: unknown[];
        commandBlocks: unknown[];
      };
      reasons: [];
    }
  | {
      ok: false;
      reasons: string[];
    };

export interface AcceptedPlanExecutorPorts {
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined;
  operationTargetResolver: {
    concreteFileTarget(value: string, accepted?: AcceptedImplementationPlanContext): string | undefined;
    concreteDeleteTarget(
      value: string,
      accepted?: AcceptedImplementationPlanContext,
      grant?: AcceptedPlanExactOperationGrant
    ): string | undefined;
    exactGrantForAction(
      action: Record<string, unknown>,
      accepted?: AcceptedImplementationPlanContext
    ): AcceptedPlanExactOperationGrant | undefined;
  };
  actionFileTargetPath(action: Record<string, unknown>): string | undefined;
  fileTargetRefFromPath(path: string): Record<string, unknown>;
  deleteActionTargetResourceKind(action: Record<string, unknown>): string | undefined;
  deleteActionRecursive(action: Record<string, unknown>): boolean;
  containsDirectoryPath(resourcePackets: ResourcePacket[], path: string): boolean;
  kernelExecutionContractId(report?: Record<string, unknown>): string | undefined;
  proposalTargetScopes(proposal: ProposalEnvelope, accepted: AcceptedImplementationPlanContext): string[];
  actionTargetScopes(
    action: ActionBundleDraft['actions'][number],
    proposal: ProposalEnvelope,
    accepted: AcceptedImplementationPlanContext
  ): string[];
  scopeCoveredForCapability(scope: string, capability: string | undefined, accepted: AcceptedImplementationPlanContext): boolean;
  resourceEvidenceIndex: {
    containsExactBlock(packets: ResourcePacket[], targets: string[], matchText: string): boolean;
    mentionsAnyTarget(packets: ResourcePacket[], targets: string[]): boolean;
  };
}

export type AcceptedPlanActionProposalAssessment =
  | { kind: 'missingActionBundle' }
  | { kind: 'deterministicScopeIntervention'; actionBundle: ActionBundleDraft; validation: AcceptedPlanBatchValidationResult }
  | { kind: 'scopeRepair'; actionBundle: ActionBundleDraft; validation: AcceptedPlanBatchValidationResult }
  | {
      kind: 'executable';
      actionBundle: ActionBundleDraft;
      scopeCanonicalization: AcceptedPlanAccessScopeCanonicalizationResult;
    };

export interface AcceptedPlanActionProposalAssessmentInput {
  accepted: AcceptedImplementationPlanContext;
  proposal: ProposalEnvelope;
  actionBundle: ActionBundleDraft | undefined;
  resourcePackets: ResourcePacket[];
  scopeRepairAttempted: boolean;
  admission: AcceptedPlanAdmission;
}

export class AcceptedPlanExecutor {
  constructor(private readonly ports?: AcceptedPlanExecutorPorts) {}

  assessActionProposal(
    input: AcceptedPlanActionProposalAssessmentInput
  ): AcceptedPlanActionProposalAssessment {
    const {
      accepted,
      proposal,
      actionBundle,
      resourcePackets,
      scopeRepairAttempted,
      admission,
    } = input;
    if (!actionBundle) return { kind: 'missingActionBundle' };
    const validation = admission.validate(accepted, proposal, resourcePackets);
    if (!validation.ok) {
      if (admission.needsDeterministicScopeIntervention(validation)) {
        return { kind: 'deterministicScopeIntervention', actionBundle, validation };
      }
      if (!scopeRepairAttempted) {
        return { kind: 'scopeRepair', actionBundle, validation };
      }
      return { kind: 'deterministicScopeIntervention', actionBundle, validation };
    }
    return {
      kind: 'executable',
      actionBundle,
      scopeCanonicalization: this.canonicalizeAccessScopes(accepted, proposal),
    };
  }

  canonicalizeAccessScopes(
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope
  ): AcceptedPlanAccessScopeCanonicalizationResult {
    const ports = this.requirePorts();
    const payload = objectRecord(proposal.payload);
    const actionBundle = objectRecord(payload?.actionBundle);
    const base = {
      proposal,
      changed: false,
      removedAccessScopes: [] as AcceptedPlanRemovedAccessScope[],
      actionTargets: ports.proposalTargetScopes(proposal, accepted),
    };
    if (!payload || !actionBundle) return base;

    const topLevel = this.canonicalizeAccessScopeArray(actionBundle.accessScopes, 'actionBundle.accessScopes');
    let nextActionBundle: Record<string, unknown> | undefined;
    if (topLevel.changed) {
      nextActionBundle = { ...actionBundle };
      if (topLevel.kept.length) {
        nextActionBundle.accessScopes = topLevel.kept;
      } else {
        delete nextActionBundle.accessScopes;
      }
    }

    const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : [];
    const nextActions = actions.map((action, actionIndex) => {
      const record = objectRecord(action);
      if (!record) return action;
      const actionScopes = this.canonicalizeAccessScopeArray(
        record.accessScopes,
        `actionBundle.actions[${actionIndex}].accessScopes`
      );
      if (!actionScopes.changed) return action;
      if (!nextActionBundle) nextActionBundle = { ...actionBundle };
      const nextAction = { ...record };
      if (actionScopes.kept.length) {
        nextAction.accessScopes = actionScopes.kept;
      } else {
        delete nextAction.accessScopes;
      }
      topLevel.removed.push(...actionScopes.removed);
      return nextAction;
    });

    if (!topLevel.changed && topLevel.removed.length === 0) return base;
    if (!nextActionBundle) nextActionBundle = { ...actionBundle };
    nextActionBundle.actions = nextActions;
    return {
      proposal: {
        ...proposal,
        payload: {
          ...payload,
          actionBundle: nextActionBundle,
        },
      },
      changed: true,
      removedAccessScopes: topLevel.removed,
      actionTargets: base.actionTargets,
    };
  }

  fileOperationFreshnessValidationReasons(
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    resourcePackets: ResourcePacket[]
  ): string[] {
    const ports = this.requirePorts();
    const actionBundle = ports.readActionBundle(proposal);
    const reasons: string[] = [];
    for (const [index, action] of (actionBundle?.actions ?? []).entries()) {
      const capability = actionEffectiveCapability(action as unknown as Record<string, unknown>);
      const actionKind = stringValue(action.kind) ?? (capability === 'fs.patch' ? 'patch' : undefined);
      const actionArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
      const targets = ports.actionTargetScopes(action, proposal, accepted).filter(Boolean);
      if (capability === 'fs.patch' || ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(actionKind ?? '')) {
        const patchSpec = objectRecord(action.patchSpec) ?? objectRecord(actionArgs?.patchSpec);
        const match = objectRecord(patchSpec?.match);
        const matchText = stringValue(match?.text);
        if (!matchText) continue;
        if (!ports.resourceEvidenceIndex.containsExactBlock(resourcePackets, targets, matchText)) {
          const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
          reasons.push(`patch action ${action.actionId || action.id || action.title || index} is missing current file/search evidence: patchSpec.match.text must come from recent ResourcePacket fileText/searchResults (target=${targetLabel}). Return resourceRequest kind="search" or read the target file/range first.`);
        }
        continue;
      }
      if (capability === 'fs.write') {
        if (writeActionIsExplicitCreate(action, proposal)) continue;
        const targetIsAccepted = targets.some((target) => ports.scopeCoveredForCapability(target, capability, accepted));
        if (!targetIsAccepted && !ports.resourceEvidenceIndex.mentionsAnyTarget(resourcePackets, targets) && !actionDeclaresOverwritePlan(action)) {
          const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
          reasons.push(`write action ${action.actionId || action.id || action.title || index} is missing current read/search evidence or an explicit overwrite plan before overwriting an existing file (target=${targetLabel}). Return resourceRequest to read/search the target file or range first.`);
        }
        continue;
      }
      if (capability === 'fs.delete') {
        if (!targets.some((target) => ports.scopeCoveredForCapability(target, capability, accepted)) && !ports.resourceEvidenceIndex.mentionsAnyTarget(resourcePackets, targets)) {
          const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
          reasons.push(`delete action ${action.actionId || action.id || action.title || index} is missing current directory/read/search evidence or confirmed file-level scope (target=${targetLabel}). Return resourceRequest to read the directory tree or target-file evidence first.`);
        }
        continue;
      }
      if (capability === 'fs.rename' || actionKind === 'rename') {
        if (!ports.resourceEvidenceIndex.mentionsAnyTarget(resourcePackets, targets)) {
          const targetLabel = targets.length ? targets.join(', ') : `action index ${index}`;
          reasons.push(`rename action ${action.actionId || action.id || action.title || index} is missing current source evidence (target=${targetLabel}). Return resourceRequest to read the source file or directory evidence first.`);
        }
      }
    }
    return reasons;
  }

  executionContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan?: AcceptedImplementationPlanContext;
    proposal: ProposalEnvelope;
    planReviewReport: Record<string, unknown>;
  }): PlanContext {
    const ports = this.requirePorts();
    const payload = objectRecord(input.proposal.payload) ?? {};
    const actionBundle = ports.readActionBundle(input.proposal) ?? {
      id: input.acceptedPlan?.planId ?? input.proposal.proposalId,
      version: '1',
      goal: stringValue(input.acceptedPlan?.summary) ?? 'Accepted implementation plan batch',
      actions: [],
      validationExpectations: [],
      reviewExpectations: [],
    };
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      planId: input.acceptedPlan?.planId ?? stringValue(actionBundle.id) ?? input.proposal.proposalId,
      proposalId: input.proposal.proposalId,
      userPlan: stringValue(payload.userPlan) ?? stringValue(input.acceptedPlan?.summary) ?? 'Accepted implementation plan batch',
      actionBundle: actionBundle as unknown as Record<string, unknown>,
      codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
      commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
      expectedValidation: stringValue(payload.expectedValidation) ?? '',
      reviewGuide: stringValue(payload.reviewGuide) ?? '',
      planReviewReport: input.planReviewReport,
      implementationPlan: input.acceptedPlan?.rawPlan,
    };
  }

  readOnlyReviewContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan: AcceptedImplementationPlanContext;
    packet: ResourcePacket;
    completion: AcceptedPlanReadOnlyResourceCompletion;
  }): PlanContext {
    const targets = input.completion.coveredTargets.join(', ');
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      planId: input.acceptedPlan.planId,
      proposalId: `${input.acceptedPlan.planId}:read-only-validation`,
      userPlan: targets
        ? `Read-only validation evidence resolved for accepted targets: ${targets}.`
        : 'Read-only validation evidence resolved for the accepted plan.',
      actionBundle: {
        version: '1',
        id: `${input.acceptedPlan.planId}:read-only-validation`,
        goal: 'Read-only validation evidence satisfied the accepted task.',
        actions: [],
        validationExpectations: [{
          id: 'read-only-resource-validation',
          description: `ResourcePacket ${input.packet.id} resolved the read-only evidence required by the accepted task.`,
        }],
        reviewExpectations: [{
          id: 'review-read-only-validation',
          description: 'Review the resolved resource evidence and accepted-plan checkpoint.',
        }],
      },
      codeBlocks: [],
      commandBlocks: [],
      expectedValidation: `ResourcePacket ${input.packet.id} resolved the read-only evidence for the accepted task.`,
      reviewGuide: 'Review the resolved ResourcePacket evidence and accepted-plan checkpoint.',
      implementationPlan: input.acceptedPlan.rawPlan,
    };
  }

  normalizeKernelBatch(input: {
    planId: string;
    plan: PlanContext;
    acceptedPlan?: AcceptedImplementationPlanContext;
    resourcePackets?: ResourcePacket[];
  }): NormalizedAcceptedPlanKernelBatch {
    const ports = this.requirePorts();
    const actionBundle = objectRecord(input.plan.actionBundle);
    const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
    const codeBlocks = input.plan.codeBlocks.map((block) => objectRecord(block) ? { ...(objectRecord(block) ?? {}) } : block);
    const commandBlocks = [...input.plan.commandBlocks];
    const codeBlockById = new Map<string, Record<string, unknown>>();
    const reasons: string[] = [];

    for (const [index, block] of codeBlocks.entries()) {
      const record = objectRecord(block);
      if (!record) continue;
      const id = stringValue(record.id) ?? stringValue(record.blockId);
      if (!id) continue;
      record.id = id;
      record.blockId = stringValue(record.blockId) ?? id;
      const path = ports.operationTargetResolver.concreteFileTarget(
        stringValue(record.targetPath) ?? stringValue(record.path) ?? '',
        input.acceptedPlan
      );
      if (path) {
        record.targetPath = path;
        record.path = stringValue(record.path) ?? path;
      }
      codeBlocks[index] = record;
      codeBlockById.set(id, record);
    }

    const normalizedActions = actions.map((action, index) => {
      const record = objectRecord(action);
      if (!record) {
        reasons.push(`actionBundle.actions[${index}] is not an object and cannot be submitted to Kernel.`);
        return action;
      }
      const next = { ...record };
      // Keep batch normalization aligned with preflight and admission when providers emit toolId-only actions.
      const capability = actionEffectiveCapability(next);
      const kind = stringValue(next.kind);
      if (capability === 'fs.delete') {
        next.kind = kind ?? 'delete';
        const deleteGrant = ports.operationTargetResolver.exactGrantForAction(next, input.acceptedPlan);
        const target = ports.operationTargetResolver.concreteDeleteTarget(
          ports.actionFileTargetPath(next) ?? '',
          input.acceptedPlan,
          deleteGrant
        );
        if (!target) {
          reasons.push(`actionBundle.actions[${index}] fs.delete is missing an executable concrete targetPath/resourceScope.`);
        } else {
          next.targetPath = target;
          next.resourceScope = [target];
          next.targetRef = objectRecord(next.targetRef) ?? ports.fileTargetRefFromPath(target);
          const recursiveDeleteIntent = ports.deleteActionRecursive(next) || deleteGrant?.recursive === true;
          const resourceEvidenceSaysDirectory = ports.containsDirectoryPath(input.resourcePackets ?? [], target);
          const explicitTargetResourceKind = ports.deleteActionTargetResourceKind(next) ?? deleteGrant?.targetResourceKind;
          const targetResourceKind = resourceEvidenceSaysDirectory
            ? 'directory'
            : explicitTargetResourceKind ?? (recursiveDeleteIntent ? 'directory' : undefined);
          if (targetResourceKind === 'directory') {
            // Clear recursive delete intent is normalized into the Kernel directory-delete schema before preflight.
            next.targetKind = 'directory';
            next.targetResourceKind = 'directory';
            next.recursive = true;
            next.args = {
              ...(objectRecord(next.args) ?? {}),
              targetKind: 'directory',
              targetResourceKind: 'directory',
              recursive: true,
            };
            next.toolArgs = {
              ...(objectRecord(next.toolArgs) ?? objectRecord(next.args) ?? {}),
              targetKind: 'directory',
              targetResourceKind: 'directory',
              recursive: true,
            };
          }
        }
        return next;
      }

      if (capability !== 'fs.write' && capability !== 'fs.patch') {
        return next;
      }

      next.kind = kind ?? (capability === 'fs.patch' ? 'patch' : 'write');
      const patchLike = ['patch', 'replaceBlock', 'insertBefore', 'insertAfter'].includes(String(next.kind));
      const blockRef = stringValue(next.replacementBlockId) ?? stringValue(next.sourceBlockId);
      if (!blockRef) {
        reasons.push(`actionBundle.actions[${index}] ${capability} is missing sourceBlockId/replacementBlockId.`);
        return next;
      }
      const block = codeBlockById.get(blockRef);
      if (!block) {
        reasons.push(`actionBundle.actions[${index}] references missing codeBlock "${blockRef}".`);
        return next;
      }
      const target = ports.operationTargetResolver.concreteFileTarget(
        ports.actionFileTargetPath(next) ??
        stringValue(block.targetPath) ??
        stringValue(block.path) ??
        '',
        input.acceptedPlan
      );
      if (!target) {
        reasons.push(`actionBundle.actions[${index}] ${capability} is missing an executable file targetPath/resourceScope.`);
        return next;
      }
      next.targetPath = target;
      next.targetRef = objectRecord(next.targetRef) ?? ports.fileTargetRefFromPath(target);
      const existingScope = stringArrayValue(next.resourceScope)
        .map((scope) => ports.operationTargetResolver.concreteFileTarget(scope, input.acceptedPlan))
        .filter((scope): scope is string => Boolean(scope));
      next.resourceScope = existingScope.length ? existingScope : [target];
      block.targetPath = stringValue(block.targetPath) ?? target;
      block.path = stringValue(block.path) ?? target;
      if (patchLike && !stringValue(next.replacementBlockId)) {
        next.replacementBlockId = blockRef;
      } else if (!stringValue(next.sourceBlockId)) {
        next.sourceBlockId = blockRef;
      }
      return next;
    });

    if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
    return {
      ok: true,
      reasons: [],
      batch: {
        planId: input.planId,
        contractId: ports.kernelExecutionContractId(input.plan.planReviewReport),
        actionBundle: {
          ...(actionBundle ?? {}),
          actions: normalizedActions,
        },
        codeBlocks,
        commandBlocks,
      },
    };
  }

  currentTaskIsReadOnlyResourceValidation(
    accepted: AcceptedImplementationPlanContext,
    cursor: TaskExecutionCursor | undefined,
    current: CurrentTaskContext | undefined
  ): boolean {
    if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return false;
    const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
    if (!task || accepted.completedTaskIds.includes(task.taskId)) return false;
    const capabilities = current.capabilities.length
      ? current.capabilities
      : task.capability
        ? [task.capability]
        : [];
    return capabilities.length > 0 && capabilities.every(acceptedPlanCapabilityIsReadOnlyValidation);
  }

  readOnlyResourceCompletion(
    accepted: AcceptedImplementationPlanContext,
    cursor: TaskExecutionCursor | undefined,
    current: CurrentTaskContext | undefined,
    packet: ResourcePacket
  ): ({ ok: true } & AcceptedPlanReadOnlyResourceCompletion) | { ok: false } {
    if (!cursor?.currentTaskId || !current?.taskId || cursor.currentTaskId !== current.taskId) return { ok: false };
    const task = accepted.tasks.find((candidate) => candidate.taskId === current.taskId);
    if (!task || accepted.completedTaskIds.includes(task.taskId)) return { ok: false };
    const capabilities = current.capabilities.length
      ? current.capabilities
      : task.capability
        ? [task.capability]
        : [];
    if (!capabilities.length || !capabilities.every(acceptedPlanCapabilityIsReadOnlyValidation)) return { ok: false };
    const targets = current.targets.length ? current.targets : task.targets;
    const normalizedTargets = uniqueStrings(targets.map(normalizeReadOnlyResourceScope).filter(Boolean));
    const coveredTargets = acceptedPlanResourceCoveredTargets(packet, normalizedTargets);
    if (!normalizedTargets.length || coveredTargets.length < normalizedTargets.length) {
      return { ok: false };
    }
    const completedTaskIds = [...new Set([...accepted.completedTaskIds, task.taskId])];
    const completed = new Set(completedTaskIds);
    return {
      ok: true,
      taskId: task.taskId,
      newlyCompletedTaskIds: [task.taskId],
      completedTaskIds,
      remainingTaskIds: accepted.tasks.map((item) => item.taskId).filter((taskId) => !completed.has(taskId)),
      coveredTargets,
    };
  }

  resourceRequestFromReadOnlyActionBundle(
    actionBundle: ActionBundleDraft,
    current: CurrentTaskContext | undefined,
    requestId: string
  ): ResourceRequestDraft | undefined {
    const items: ResourceRequestDraft['items'] = [];
    const actions = (actionBundle.actions ?? [])
      .map((action) => objectRecord(action))
      .filter((action): action is Record<string, unknown> => Boolean(action));
    if (!actions.length) return undefined;

    for (const action of actions) {
      const capability = actionEffectiveCapability(action);
      if (!acceptedPlanCapabilityIsReadOnlyValidation(capability)) return undefined;
      const kind = readOnlyResourceRequestKind(action, capability);
      if (!kind) return undefined;
      const args = objectRecord(action.args) ?? {};
      if (kind === 'search') {
        const query = stringValue(args.query) ?? stringValue(args.pattern) ?? stringValue(args.text);
        if (!query) return undefined;
        items.push({
          id: `${requestId}-item-${items.length + 1}`,
          kind: 'search',
          path: readOnlyResourceRequestPaths(action, current, kind)[0] ?? '.',
          query,
          reason: 'Resolve read-only search evidence for the current accepted task.',
        });
        continue;
      }
      const paths = readOnlyResourceRequestPaths(action, current, kind);
      if (!paths.length) return undefined;
      for (const path of paths) {
        items.push({
          id: `${requestId}-item-${items.length + 1}`,
          kind,
          path,
          reason: 'Resolve read-only evidence for the current accepted task.',
        });
      }
    }

    if (!items.length) return undefined;
    return {
      version: '1',
      id: requestId,
      reason: 'Accepted-plan read-only actionBundle normalized to ResourceResolve by Session.',
      items,
    };
  }

  private requirePorts(): AcceptedPlanExecutorPorts {
    if (!this.ports) {
      throw new Error('AcceptedPlanExecutor requires ports for execution context and kernel batch normalization.');
    }
    return this.ports;
  }

  private canonicalizeAccessScopeArray(
    value: unknown,
    source: string
  ): { kept: unknown[]; removed: AcceptedPlanRemovedAccessScope[]; changed: boolean } {
    if (!Array.isArray(value)) return { kept: [], removed: [], changed: false };
    const kept: unknown[] = [];
    const removed: AcceptedPlanRemovedAccessScope[] = [];
    for (const [index, scope] of value.entries()) {
      const reason = invalidAcceptedPlanExecutionAccessScopeReason(scope);
      if (reason) {
        const record = objectRecord(scope);
        removed.push({
          index,
          source,
          reason,
          path: stringValue(record?.path) ?? stringValue(record?.targetPath) ?? stringValue(record?.resourcePath),
          scopeKind: stringValue(record?.scopeKind),
          scope,
        });
        continue;
      }
      kept.push(scope);
    }
    return { kept, removed, changed: removed.length > 0 };
  }
}

function invalidAcceptedPlanExecutionAccessScopeReason(scope: unknown): string | undefined {
  const record = objectRecord(scope);
  if (!record) return 'non_object_scope';
  const rawPath = stringValue(record.path) ?? stringValue(record.targetPath) ?? stringValue(record.resourcePath);
  const normalized = rawPath ? normalizePlanScope(rawPath).replace(/\/+$/, '') : '';
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return 'invalid_root_scope';
  if (normalized.startsWith('../') || normalized.includes('/../')) return 'path_traversal_scope';
  if (normalized.includes('*')) return 'wildcard_scope';
  if (isAbsolutePath(normalized)) return 'absolute_scope_not_allowed_in_execution_batch';
  return undefined;
}

function writeActionIsExplicitCreate(action: ActionBundleDraft['actions'][number], proposal: ProposalEnvelope): boolean {
  const actionKind = stringValue(action.kind);
  if (actionKind === 'create') return true;
  const actionArgs = objectRecord(action.args) ?? objectRecord(action.toolArgs);
  const payload = objectRecord(proposal.payload) ?? {};
  const codeBlocks = Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [];
  const blockIds = new Set([
    stringValue(action.sourceBlockId),
    stringValue(action.replacementBlockId),
    stringValue(actionArgs?.sourceBlockId),
    stringValue(actionArgs?.replacementBlockId),
  ].filter((item): item is string => Boolean(item)));
  return codeBlocks.some((block) => {
    const record = objectRecord(block);
    const blockId = stringValue(record?.id) ?? stringValue(record?.blockId);
    if (!blockId || !blockIds.has(blockId)) return false;
    const operation = stringValue(record?.operation);
    return operation === 'create' || operation === 'createEmpty';
  });
}

function actionDeclaresOverwritePlan(action: ActionBundleDraft['actions'][number]): boolean {
  const toolArgs = objectRecord(action.toolArgs) ?? objectRecord(action.args);
  return toolArgs?.overwrite === true || toolArgs?.overwritePlan === true || toolArgs?.confirmedOverwrite === true;
}

function acceptedPlanCapabilityIsReadOnlyValidation(capability: string): boolean {
  return [
    'fs.read',
    'fs.list',
    'code.search',
    'git.read',
  ].includes(capability);
}

function readOnlyResourceRequestKind(
  action: Record<string, unknown>,
  capability: string
): ResourceRequestDraft['items'][number]['kind'] | undefined {
  const toolId = stringValue(action.toolId);
  if (toolId === 'fs.list' || capability === 'fs.list') return 'directory';
  if (toolId === 'fs.read' || capability === 'fs.read') return 'file';
  if (toolId === 'code.search' || capability === 'code.search') return 'search';
  return undefined;
}

function readOnlyResourceRequestPaths(
  action: Record<string, unknown>,
  current: CurrentTaskContext | undefined,
  kind: ResourceRequestDraft['items'][number]['kind']
): string[] {
  const args = objectRecord(action.args) ?? {};
  const explicit = [
    rawStringValue(args.path),
    rawStringValue(args.targetPath),
    rawStringValue(args.resourceRef),
    rawStringValue(action.targetPath),
    fileTargetRefPath(action.targetRef),
    ...stringArrayValue(action.resourceScope),
  ].filter((path): path is string => path !== undefined);
  const source = explicit.length
    ? explicit
    : kind === 'directory'
      ? ['.']
      : current?.targets ?? [];
  const seen = new Set<string>();
  const output: string[] = [];
  for (const path of source) {
    const normalized = normalizeResourceRequestPath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function acceptedPlanResourceCoveredTargets(packet: ResourcePacket, targets: string[]): string[] {
  const normalizedTargets = uniqueStrings(targets.map(normalizeReadOnlyResourceScope).filter(Boolean));
  if (!normalizedTargets.length) return [];
  const resolvedItems = (packet.items ?? [])
    .filter((item) => item.status === 'resolved' || item.status === 'provided');
  return normalizedTargets.filter((target) =>
    resolvedItems.some((item) => resourcePacketItemMatchesTargetScope(item, target))
  );
}

function resourcePacketItemMatchesTargetScope(item: ResourcePacketItem, target: string): boolean {
  const normalizedTarget = normalizeReadOnlyResourceScope(target);
  if (!normalizedTarget) return false;
  const itemRecord = objectRecord(item);
  if (normalizedTarget === '.' && item.contentKind === 'directoryTree') return true;
  if (itemRecord && resourceNodeListContainsPath(itemRecord.nodes, normalizedTarget)) return true;
  const candidates = [
    item.path,
    item.absolutePath,
    item.manifestEntryId,
  ]
    .map((value) => typeof value === 'string' ? normalizePlanScope(value) : '')
    .filter(Boolean);
  return candidates.some((candidate) =>
    candidate === normalizedTarget ||
    candidate.endsWith(`/${normalizedTarget}`) ||
    normalizedTarget.endsWith(`/${candidate}`) ||
    planScopeCovers(normalizedTarget, candidate) ||
    planScopeCovers(candidate, normalizedTarget)
  );
}

function resourceNodeListContainsPath(value: unknown, targetPath: string): boolean {
  if (!Array.isArray(value)) return false;
  const target = normalizeReadOnlyResourceScope(targetPath);
  for (const item of value) {
    const node = objectRecord(item);
    if (!node) continue;
    const path = stringValue(node.path) ?? stringValue(node.name);
    const normalizedPath = path ? normalizeReadOnlyResourceScope(path) : '';
    if (
      normalizedPath &&
      (normalizedPath === target ||
        planScopeCovers(normalizedPath, target) ||
        planScopeCovers(target, normalizedPath))
    ) {
      return true;
    }
    if (resourceNodeListContainsPath(node.children, target)) return true;
  }
  return false;
}

function actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string {
  const capability = stringValue(action.capability);
  if (capability) return capability;
  const toolId = stringValue(action.toolId);
  if (!toolId) return '';
  if (toolId === 'git.status' || toolId === 'git.diff') return 'git.read';
  if (toolId === 'git.push') return 'git.push';
  if (toolId.startsWith('git.')) return 'git.write';
  if (toolId === 'web.search' || toolId === 'web.fetch') return 'network.egress';
  if (toolId.startsWith('browser.')) return 'browser.control';
  if (toolId === 'provider.call') return 'provider.egress';
  return toolId;
}

function planScopeCovers(accepted: string, candidate: string): boolean {
  if (!accepted || !candidate) return false;
  const acceptedNormalized = normalizeReadOnlyResourceScope(accepted);
  const candidateNormalized = normalizeReadOnlyResourceScope(candidate);
  if (acceptedNormalized === candidateNormalized) return true;
  if (acceptedNormalized === '.' || candidateNormalized === '.') return false;
  if (isAbsolutePath(acceptedNormalized) || isAbsolutePath(candidateNormalized)) return false;
  const acceptedDir = acceptedNormalized.endsWith('/') ? acceptedNormalized : `${acceptedNormalized}/`;
  return candidateNormalized.startsWith(acceptedDir);
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizeReadOnlyResourceScope(value: string): string {
  const normalized = normalizePlanScope(value);
  const identity = normalized.replace(/\/+$/, '');
  if (!identity || normalized === '/' || identity === '.') return '.';
  return identity;
}

function normalizeResourceRequestPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/');
  if (!normalized || normalized === '/' || normalized === './' || normalized === '.') return '.';
  return normalized;
}

function fileTargetRefPath(value: unknown): string | undefined {
  const direct = stringValue(value);
  if (direct) return direct;
  const record = objectRecord(value);
  return stringValue(record?.path) ?? stringValue(record?.targetPath);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawStringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = stringValue(value);
    return single ? [single] : [];
  }
  return value
    .map((item) => stringValue(item))
    .filter((item): item is string => Boolean(item));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}
