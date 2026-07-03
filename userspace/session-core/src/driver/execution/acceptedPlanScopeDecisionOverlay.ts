import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanExecutionRoot,
  AcceptedPlanExactOperationGrant,
} from '../../accepted-plan/types.js';

export interface AcceptedPlanScopeDecisionEffect {
  kind: string;
  taskId?: string;
  targetPath?: string;
  targetResourceKind?: 'file' | 'directory';
  recursive?: boolean;
  reason?: string;
}

export interface AcceptedPlanScopeDecisionOverlayPorts {
  planAcceptedAutoGrantCapability(capability: string): boolean;
  concreteDirectoryOperationTarget(value: string): string | undefined;
  concreteFileOperationTarget(value: string): string | undefined;
  normalizeAcceptedPlanExactOperationGrants(
    grants: AcceptedPlanExactOperationGrant[],
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant[];
  normalizeTargetForExecutionRoot(value: string, executionRoot?: AcceptedImplementationPlanExecutionRoot): string;
}

export class AcceptedPlanScopeDecisionOverlay {
  constructor(private readonly ports: AcceptedPlanScopeDecisionOverlayPorts) {}

  apply(
    accepted: AcceptedImplementationPlanContext,
    effect: AcceptedPlanScopeDecisionEffect | undefined
  ): AcceptedImplementationPlanContext {
    if (!effect || effect.kind !== 'expandCurrentTaskScope') return accepted;
    const currentTask = accepted.tasks.find((task) => task.taskId === effect.taskId)
      ?? accepted.tasks[Math.max(0, accepted.batchIndex - 1)];
    const capability = currentTask?.capability
      ?? accepted.capabilities.find((item) => this.ports.planAcceptedAutoGrantCapability(item));
    if (!capability) return accepted;
    const rawTarget = effect.targetPath?.trim();
    if (!rawTarget) return accepted;
    const targetResourceKind = effect.targetResourceKind ?? (rawTarget.endsWith('/') ? 'directory' : 'file');
    const normalized = this.ports.normalizeTargetForExecutionRoot(rawTarget, accepted.executionRoot);
    const targetPath = targetResourceKind === 'directory'
      ? this.ports.concreteDirectoryOperationTarget(normalized)
      : this.ports.concreteFileOperationTarget(normalized);
    if (!targetPath) return accepted;
    const operation = operationForCapability(capability);
    const sourceTaskId = effect.taskId ?? currentTask?.taskId;
    const grant: AcceptedPlanExactOperationGrant = {
      operation,
      targetPath,
      targetResourceKind,
      recursive: effect.recursive === true || targetResourceKind === 'directory',
      capability,
      sourceTaskId,
      source: 'implementationPlan',
    };
    const tasks = accepted.tasks.map((task) => {
      if (sourceTaskId && task.taskId !== sourceTaskId) return task;
      if (!sourceTaskId && task !== currentTask) return task;
      return {
        ...task,
        capability: task.capability ?? capability,
        targets: uniqueStrings([...task.targets, targetPath]),
      };
    });
    return {
      ...accepted,
      tasks,
      capabilities: uniqueStrings([...accepted.capabilities, capability]),
      targetScopes: uniqueStrings([...accepted.targetScopes, targetPath]),
      exactOperationGrants: this.ports.normalizeAcceptedPlanExactOperationGrants([
        ...accepted.exactOperationGrants,
        grant,
      ], accepted.executionRoot),
    };
  }

  resumeGuidance(effect: AcceptedPlanScopeDecisionEffect | undefined): string {
    if (effect?.kind === 'expandCurrentTaskScope') {
      const target = effect.targetPath ? ` target=${effect.targetPath}` : '';
      const kind = effect.targetResourceKind ? ` targetKind=${effect.targetResourceKind}` : '';
      const recursive = effect.recursive === true ? ' recursive=true' : '';
      return `The user confirmed an execution-scope expansion for the current accepted task. Continue the same task and output the next actionBundle or a necessary resourceRequest from the expanded overlay. Do not generate a new implementationPlan.${target}${kind}${recursive}`;
    }
    if (effect?.kind === 'confirmOperationGrant') {
      return 'The user confirmed an operation grant for the current accepted task. Continue the same task and output an actionBundle when evidence is sufficient. Do not generate a new implementationPlan.';
    }
    if (effect?.kind === 'continueCurrentTask') {
      return 'The user chose to continue the current accepted task. Keep the original accepted taskPlan and output the next actionBundle or necessary resourceRequest within the current task scope. Do not generate a new implementationPlan.';
    }
    return 'The user chose to regenerate a compliant batch. Keep the same current task, do not add targets or capabilities, and only remove or narrow content that is outside the current task scope.';
  }
}

function operationForCapability(capability: string): string {
  if (capability === 'fs.delete') return 'delete';
  if (capability === 'fs.rename') return 'rename';
  if (capability === 'fs.patch') return 'patch';
  if (capability === 'fs.write') return 'write';
  return capability;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
