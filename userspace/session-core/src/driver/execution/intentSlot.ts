import type { AcceptedImplementationPlanContext } from '../../accepted-plan/types.js';
import { PathIdentity } from '../context/pathIdentity.js';

export type IntentSlotOperation =
  | 'createFile'
  | 'replaceFile'
  | 'patchFile'
  | 'deletePath'
  | 'renamePath'
  | 'runProcess';

export interface IntentSlot {
  readonly slotId: string;
  readonly taskId: string;
  readonly operation: IntentSlotOperation;
  readonly targetRef: string;
  readonly targetResourceKind?: 'file' | 'directory';
  readonly recursive?: boolean;
  readonly contentMode: 'none' | 'full' | 'exactPatch' | 'argv';
  readonly evidenceRequirement: 'none' | 'targetObserved' | 'exactTextObserved';
}

export class IntentSlotRegistry {
  private readonly paths = new PathIdentity();

  currentTaskId(acceptedPlan: AcceptedImplementationPlanContext | undefined): string | undefined {
    return this.currentTask(acceptedPlan)?.taskId;
  }

  currentTaskSlots(acceptedPlan: AcceptedImplementationPlanContext | undefined): IntentSlot[] {
    if (!acceptedPlan) return [];
    const task = this.currentTask(acceptedPlan);
    if (!task) return [];
    const completed = new Set(acceptedPlan.completedTaskIds ?? []);
    const incompleteTasks = (acceptedPlan.tasks ?? []).filter((candidate) => !completed.has(candidate.taskId));
    const taskTargets = new Set((task.targets ?? []).map((target) => this.paths.normalizePlanScopeIdentity(target)).filter(Boolean));
    const grants = (acceptedPlan.exactOperationGrants ?? []).filter((grant) => {
      if (grant.sourceTaskId) return grant.sourceTaskId === task.taskId;
      const grantTarget = this.paths.normalizePlanScopeIdentity(grant.targetRefPath ?? grant.targetPath);
      if (taskTargets.has(grantTarget)) return true;
      return taskTargets.size === 0 && incompleteTasks.length === 1;
    });
    const source = grants.length
      ? grants.map((grant) => ({
        operation: semanticOperation(task.semanticOperation, task.capability)
          ?? semanticOperation(grant.operation, grant.capability),
        targetRef: grant.targetRefPath ?? grant.targetPath,
        targetResourceKind: grant.targetResourceKind,
        recursive: grant.recursive,
      }))
      : (task.targets ?? []).map((targetRef) => ({
        operation: semanticOperation(task.semanticOperation, task.capability),
        targetRef,
        targetResourceKind: undefined,
        recursive: undefined,
      }));
    return source.flatMap((candidate, index): IntentSlot[] => {
      const targetRef = this.paths.normalizePlanScopeIdentity(candidate.targetRef);
      if (!candidate.operation || !targetRef || targetRef === '.' || targetRef === '/') return [];
      const contract = slotContract(candidate.operation);
      return [{
        slotId: `slot-${task.taskId}-${index + 1}`,
        taskId: task.taskId,
        operation: candidate.operation,
        targetRef,
        targetResourceKind: candidate.targetResourceKind,
        recursive: candidate.recursive === true,
        ...contract,
      }];
    });
  }

  private currentTask(acceptedPlan: AcceptedImplementationPlanContext | undefined) {
    if (!acceptedPlan) return undefined;
    const completed = new Set(acceptedPlan.completedTaskIds ?? []);
    return (acceptedPlan.tasks ?? []).find((candidate) => !completed.has(candidate.taskId));
  }

  deterministicDeleteSlots(acceptedPlan: AcceptedImplementationPlanContext | undefined): IntentSlot[] {
    if (!acceptedPlan) return [];
    const slots = this.currentTaskSlots(acceptedPlan);
    if (!slots.length || slots.some((slot) => slot.operation !== 'deletePath' || slot.contentMode !== 'none')) return [];
    const currentTaskId = slots[0]?.taskId;
    const grants = (acceptedPlan.exactOperationGrants ?? []).filter((grant) =>
      (!grant.sourceTaskId || grant.sourceTaskId === currentTaskId) &&
      semanticOperation(grant.operation, grant.capability) === 'deletePath'
    );
    if (grants.length !== slots.length) return [];
    return slots;
  }
}

function semanticOperation(
  operation: string | undefined,
  capability: string | undefined
): IntentSlotOperation | undefined {
  const value = operation ?? capability;
  if (value === 'create' || value === 'createFile') return 'createFile';
  if (value === 'write' || value === 'replace' || value === 'replaceFile' || value === 'fs.write') return 'replaceFile';
  if (value === 'patch' || value === 'patchFile' || value === 'fs.patch') return 'patchFile';
  if (value === 'delete' || value === 'deletePath' || value === 'fs.delete') return 'deletePath';
  if (value === 'rename' || value === 'renamePath' || value === 'fs.rename') return 'renamePath';
  if (value === 'command' || value === 'runProcess' || value === 'process.exec') return 'runProcess';
  return undefined;
}

function slotContract(operation: IntentSlotOperation): Pick<IntentSlot, 'contentMode' | 'evidenceRequirement'> {
  if (operation === 'createFile') return { contentMode: 'full', evidenceRequirement: 'none' };
  if (operation === 'replaceFile') return { contentMode: 'full', evidenceRequirement: 'targetObserved' };
  if (operation === 'patchFile') return { contentMode: 'exactPatch', evidenceRequirement: 'exactTextObserved' };
  if (operation === 'runProcess') return { contentMode: 'argv', evidenceRequirement: 'none' };
  return { contentMode: 'none', evidenceRequirement: 'targetObserved' };
}
