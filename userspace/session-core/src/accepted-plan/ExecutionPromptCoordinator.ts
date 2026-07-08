import type {
  ProposalEnvelope,
  ReviewExpectationDraft,
  ValidationExpectationDraft,
} from '../protocol/types.js';
import type { AcceptedImplementationPlanContext } from './types.js';
import { AcceptedTaskRegistry } from './AcceptedTaskRegistry.js';

export interface DefaultActionBundleUserPlanMarkdownInput {
  goal?: string;
  actions: Record<string, unknown>[];
  existingUserPlan?: string;
  outputLanguage?: string;
}

export interface ExecutionPromptCoordinatorPorts<TPlan> {
  maxActionBundleTotalCodeBytes: number;
  sideEffectCapabilities: ReadonlySet<string>;
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  planId(plan: TPlan): string;
  actionEffectiveCapability(action: { capability?: unknown; toolId?: unknown }): string;
  isDetailedUserPlanMarkdown(userPlan: string | undefined): boolean;
  defaultActionBundleUserPlanMarkdown(input: DefaultActionBundleUserPlanMarkdownInput): string;
  expectationsHaveDescription(value: unknown): boolean;
  defaultValidationExpectation(actions: Record<string, unknown>[]): ValidationExpectationDraft;
  defaultReviewExpectation(actions: Record<string, unknown>[]): ReviewExpectationDraft;
}

export class ExecutionPromptCoordinator<TPlan> {
  constructor(private readonly ports: ExecutionPromptCoordinatorPorts<TPlan>) {}

  ensureReviewableExpectations(proposal: ProposalEnvelope): void {
    if (proposal.kind !== 'actionBundle') return;
    const payload = this.ports.objectRecord(proposal.payload);
    const bundle = this.ports.objectRecord(payload?.actionBundle);
    if (!payload || !bundle) return;
    const actions = Array.isArray(bundle.actions)
      ? bundle.actions.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
    const sideEffectful = actions.some((action) => this.ports.sideEffectCapabilities.has(this.ports.actionEffectiveCapability(action)));
    if (!sideEffectful) return;
    if (!Array.isArray(payload.codeBlocks)) {
      payload.codeBlocks = [];
    }
    const envelope = proposal as unknown as Record<string, unknown>;
    const existingUserPlan = this.ports.stringValue(payload.userPlan) ?? this.ports.stringValue(payload.userPlanMarkdown);
    const outputLanguage = this.ports.stringValue(payload.outputLanguage) ?? this.ports.stringValue(envelope.outputLanguage);
    if (!this.ports.isDetailedUserPlanMarkdown(existingUserPlan)) {
      const generatedUserPlan = this.ports.defaultActionBundleUserPlanMarkdown({
        goal: this.ports.stringValue(bundle.goal),
        actions,
        existingUserPlan,
        outputLanguage,
      });
      payload.userPlan = generatedUserPlan;
      payload.userPlanMarkdown = generatedUserPlan;
    }
    if (!this.ports.expectationsHaveDescription(bundle.validationExpectations)) {
      bundle.validationExpectations = [this.ports.defaultValidationExpectation(actions)];
    }
    if (!this.ports.expectationsHaveDescription(bundle.reviewExpectations)) {
      bundle.reviewExpectations = [this.ports.defaultReviewExpectation(actions)];
    }
  }

  executionRequest(
    plan: TPlan,
    acceptedPlan: AcceptedImplementationPlanContext,
    guidance?: string
  ): string {
    const currentTask = acceptedPlan.tasks.find((task) => !acceptedPlan.completedTaskIds.includes(task.taskId));
    const registry = new AcceptedTaskRegistry(acceptedPlan);
    const taskLedger = registry.ledger();
    const promptFrame = registry.promptFrame(taskLedger);
    const providerContext = {
      sessionPlanId: this.ports.planId(plan),
      ...this.sanitizedContext(acceptedPlan),
    };
    return [
      'The user accepted the Kernel execution contract. You are now in Edit stage and must generate the next executable candidate actionBundle.',
      'The accepted plan/contract is intent/checklist context, not execution fact. Do not claim files were created, tests passed, or permissions were granted.',
      'Before the final JSON proposal, stream visible edit drafts with <deepcode-part>{...}</deepcode-part> frames when generating long codeBlocks/actionBundles. Final workspace writes still come only from the complete actionBundle JSON.',
      'All user-visible natural language in narration, userPlanMarkdown, validation descriptions, and review guidance must follow the current user input language.',
      'Handle only the task referenced by the current task cursor. One actionBundle may contain multiple related files or actions required by that current task; file count, task count, and codeBlock count are not permission boundaries.',
      'The task list is a Session-advanced queue in the order confirmed by the user. Do not generate or reason about cross-task scheduling structures. Do not write continuationExpectations for later tasks; Session advances later tasks with its cursor.',
      'The nested actionBundle object must include version/id/goal/actions; goal is only this batch objective summary, not a permission grant, execution fact, or completion claim. Session can derive routine validationExpectations/reviewExpectations when they are omitted.',
      'actionBundle.actions must use actionId, toolId, args, and description; Kernel derives capability, permission, readSet/writeSet, and conflictKeys from toolId and args.',
      currentTask
        ? `Current task: taskId=${currentTask.taskId}; title=${currentTask.title ?? 'untitled'}; targets=${currentTask.targets.length ? currentTask.targets.join(', ') : 'none'}; capability=${currentTask.capability ?? 'none'}.`
        : 'The current task list is complete or unavailable; return diagnostic or a review-ready summary instead of expanding scope.',
      promptFrame
        ? `AcceptedPlanPromptFrame: stableFrameHash=${promptFrame.stableFrameHash.slice(0, 16)}; currentTask=${promptFrame.taskLedger.currentTaskId ?? 'none'}; completedTaskCount=${promptFrame.taskLedger.completedTaskIds.length}; remainingTaskCount=${promptFrame.taskLedger.pendingTaskIds.length + (promptFrame.taskLedger.currentTaskId ? 1 : 0)}; projectMemoryRefresh=${promptFrame.cachePolicy.projectMemoryRefresh}.`
        : '',
      acceptedPlan.completedTaskIds.length
        ? `Completed taskIds: ${acceptedPlan.completedTaskIds.join(', ')}. Do not regenerate completed tasks unless Kernel facts show failure or the user requests revision.`
        : 'The current accepted contract has no completed tasks yet.',
      acceptedPlan.executionRoot
        ? `Primary root: ${acceptedPlan.executionRoot.ref}. Workspace args.path and codeBlocks.targetPath must be relative to this root; do not include the root directory name or ../. Absolute file paths are allowed only for outside-workspace targets already confirmed in the accepted plan.`
        : 'Workspace args.path and codeBlocks.targetPath must be relative to the workspace root. Absolute file paths are allowed only for outside-workspace targets already confirmed in the accepted plan. Do not use ../.',
      'Use currentTaskActionTemplates from the sanitized context whenever present. They are preferred Session-derived action shapes for the current accepted task; fill ids, descriptions, sourceBlockId/replacementBlockId references, and codeBlocks as needed.',
      'If the current task needs a concrete adjacent target or operation to be correct, include that explicit operation intent in the actionBundle. Session and Kernel will validate scope, interrupt for user approval when required, and resume this same task after approval.',
      'Execution batches must not carry workspace root, ".", module root, wildcards, accessScopes, resourceScope, or capability; the confirmed Kernel contract is the authorization source.',
      'Directory targets are valid only for exact fs.delete directory operation templates. For writes and patches, output concrete file paths under the current task target; Kernel creates parent directories for new file writes.',
      'Do not re-ask already confirmed technical route, directory layout, Docker/script workflow, module split, or validation strategy.',
      'Return kind="decisionRequest" only for a missing product, architecture, or material implementation choice that cannot be expressed as a concrete operation intent. Do not use decisionRequest for routine permission or scope expansion; Session and Kernel own that gate.',
      'This actionBundle must include concrete codeBlocks when needed. You may include actionBundle.validationExpectations/reviewExpectations, but Session will add default reviewable notes for routine side effects when omitted.',
      'For fs.write complete writes to accepted task targets, output the concrete replacement content directly when the task intent is clear; do not request a read only to inspect a file that will be fully replaced.',
      'For fs.patch or edits that must preserve existing content, first use resourceRequest kind="search" or a file/range read for the current anchor. patch action must include patchSpec.match.kind="exactBlock" and non-empty patchSpec.match.text copied from current ResourcePacket fileText/searchResults.',
      'When deleting a file or confirmed directory, output an fs.delete action: toolId="fs.delete", args.path is a concrete path inside the confirmed task scope. Workspace targets use relative paths; confirmed external targets may use absolute paths. Delete actions do not need and must not reference codeBlocks/sourceBlockId.',
      'Directory deletion is allowed only when the accepted contract exposed an exact directory operation/grant; set args.targetKind="directory" and args.recursive=true. Unconfirmed directories, wildcards, root directories, and empty paths cannot be fs.delete actions.',
      `Keep total codeBlock content within the ${this.ports.maxActionBundleTotalCodeBytes} byte payload budget. Prefer complete writes for new files when they fit. For large existing-file rewrites, slice by module, function, class, file section, script segment, or config segment. continuationExpectations may only record current-task payload or evidence deferral; they do not narrow accepted plan authorization and must not schedule later tasks.`,
      'All source content must be in codeBlocks[].contentLines. Do not use large or multiline codeBlocks.content.',
      guidance?.trim() ? `Additional guidance supplied when the user confirmed the plan:\n${guidance.trim()}` : '',
      `Accepted execution sanitized context:\n${fenced(JSON.stringify(providerContext, null, 2))}`,
    ].filter(Boolean).join('\n\n');
  }

  sanitizedContext(acceptedPlan: AcceptedImplementationPlanContext | undefined): Record<string, unknown> {
    if (!acceptedPlan) return {};
    const completed = new Set(acceptedPlan.completedTaskIds);
    const currentTask = acceptedPlan.tasks.find((task) => !completed.has(task.taskId));
    const taskTargets = (currentTask?.targets ?? [])
      .flatMap((target) => expandAcceptedPlanTargetValue(target))
      .map((target) => normalizePlanScopeIdentity(target))
      .filter((target) => target && acceptedPlanTargetListSegmentSafe(target));
    const currentTaskOperations = acceptedPlan.exactOperationGrants.reduce<Record<string, unknown>[]>((items, grant) => {
      if (currentTask?.taskId && grant.sourceTaskId && grant.sourceTaskId !== currentTask.taskId) return items;
      const targetPath = normalizePlanScopeIdentity(grant.targetRefPath ?? grant.targetPath);
      if (!acceptedPlanTargetListSegmentSafe(targetPath)) return items;
      items.push({
        operation: grant.operation,
        capability: grant.capability,
        targetPath,
        targetResourceKind: grant.targetResourceKind,
        recursive: grant.recursive === true,
      });
      return items;
    }, []);
    const operationTargets = currentTaskOperations
      .map((operation) => stringValue(operation.targetPath))
      .filter((target): target is string => Boolean(target && acceptedPlanTargetListSegmentSafe(target)));
    const currentTargets = uniqueStrings([...taskTargets, ...operationTargets]);
    const currentTaskActionTemplates = currentTaskOperations
      .map((operation) => acceptedPlanOperationActionTemplate(operation))
      .filter((item): item is Record<string, unknown> => Boolean(item));
    return {
      planId: acceptedPlan.planId,
      title: acceptedPlan.title ?? acceptedPlan.summary ?? acceptedPlan.planId,
      currentTask: currentTask
        ? {
          taskId: currentTask.taskId,
          title: currentTask.title,
          targets: currentTargets,
          capability: currentTask.capability,
        }
        : undefined,
      completedTaskCount: acceptedPlan.completedTaskIds.length,
      remainingTaskCount: acceptedPlan.tasks.filter((task) => !completed.has(task.taskId)).length,
      currentTaskOperations,
      currentTaskActionTemplates,
      primaryRoot: acceptedPlan.executionRoot?.ref,
    };
  }
}

function acceptedPlanOperationActionTemplate(operation: Record<string, unknown>): Record<string, unknown> | undefined {
  const capability = stringValue(operation.capability);
  const targetPath = stringValue(operation.targetPath);
  if (!capability || !targetPath) return undefined;
  if (capability === 'fs.delete') {
    const targetResourceKind = stringValue(operation.targetResourceKind) === 'directory' ? 'directory' : 'file';
    return {
      toolId: 'fs.delete',
      args: {
        path: targetPath,
        targetKind: targetResourceKind,
        recursive: targetResourceKind === 'directory' || Boolean(operation.recursive),
      },
    };
  }
  if (capability === 'fs.write') {
    return {
      toolId: 'fs.write',
      args: {
        path: targetPath,
        sourceBlockId: '<codeBlock.blockId>',
      },
    };
  }
  if (capability === 'fs.patch') {
    return {
      toolId: 'fs.patch',
      args: {
        path: targetPath,
        replacementBlockId: '<matching-codeBlocks.blockId>',
        patchSpec: {
          match: {
            kind: 'exactBlock',
            text: '<copy-current-block-from-ResourceEvidence>',
          },
        },
      },
    };
  }
  if (capability === 'fs.rename') {
    return {
      toolId: 'fs.rename',
      args: {
        path: targetPath,
        renameTo: '<new-relative-path-inside-current-task-scope>',
      },
    };
  }
  return undefined;
}

function expandAcceptedPlanTargetValue(value: string): string[] {
  const normalized = normalizePlanScope(value);
  if (!normalized) return [];
  if (normalized.includes(',')) {
    const parts = normalized
      .split(',')
      .map((part) => normalizePlanScope(part))
      .filter(Boolean);
    if (parts.length > 1 && parts.every(acceptedPlanTargetListSegmentSafe)) return parts;
    const extracted = extractAcceptedPlanTargetTokens(normalized);
    return extracted.length ? extracted : [normalized];
  }
  const extracted = extractAcceptedPlanTargetTokens(normalized);
  return extracted.length ? extracted : [normalized];
}

function acceptedPlanTargetListSegmentSafe(value: string): boolean {
  const normalized = normalizePlanScope(value).replace(/\/+$/, '');
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return false;
  if (normalized.includes(',') || normalized.includes('*')) return false;
  if (normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (/[\s()[\]{}<>（）【】]/.test(normalized)) return false;
  if (isAbsolutePath(normalized)) return normalized.replace(/\/+$/, '').length > 1;
  return true;
}

interface AcceptedPlanTargetToken {
  value: string;
  index: number;
}

function extractAcceptedPlanTargetTokens(target: string): string[] {
  const tokens = acceptedPlanPathTokens(target);
  if (!tokens.length) return [];
  const hasFreeformBoundary = /[,;:()[\]{}<>（）【】]/.test(target) ||
    Boolean(tokens[0]?.value.endsWith('/') && target.trim() !== tokens[0].value) ||
    (tokens.length > 1 && tokens[0]?.value.endsWith('/'));
  if (!hasFreeformBoundary) return [];
  const first = tokens[0];
  if (!first || first.index !== 0) return [];
  const normalizedFirst = normalizePlanScope(first.value);
  if (
    normalizedFirst.endsWith('/') &&
    tokens.slice(1).every((token) => !token.value.includes('/'))
  ) {
    return [normalizedFirst];
  }
  return uniqueStrings(tokens
    .map((token) => normalizePlanScope(token.value))
    .filter((token) => token && acceptedPlanTargetListSegmentSafe(token)));
}

function acceptedPlanPathTokens(value: string): AcceptedPlanTargetToken[] {
  const tokens: AcceptedPlanTargetToken[] = [];
  for (const match of value.matchAll(/[A-Za-z0-9_.\-/]+/g)) {
    const token = match[0];
    const index = match.index ?? -1;
    if (!token || index < 0) continue;
    if (token === '.' || token === '..') continue;
    if (!token.includes('/') && !/\.[A-Za-z0-9]+$/.test(token)) continue;
    tokens.push({ value: token, index });
  }
  return tokens;
}

function normalizePlanScope(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .trim();
}

function normalizePlanScopeIdentity(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function fenced(value: string): string {
  return `\`\`\`text\n${value}\n\`\`\``;
}
