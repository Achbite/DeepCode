import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';

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
  readonly toolId: string;
  readonly operation: IntentSlotOperation;
  readonly targetRef: string;
  readonly targetResourceKind?: 'file' | 'directory';
  readonly recursive?: boolean;
  readonly fixedArgs: Readonly<Record<string, unknown>>;
  readonly contentMode: 'none' | 'full' | 'exactPatch' | 'argv';
  readonly evidenceRequirement: 'none' | 'targetObserved' | 'exactTextObserved';
}

export class IntentSlotRegistry {
  currentTaskId(acceptedPlan: AcceptedTaskPlanContext | undefined): string | undefined {
    return this.currentTask(acceptedPlan)?.taskId;
  }

  currentTaskSlots(acceptedPlan: AcceptedTaskPlanContext | undefined): IntentSlot[] {
    if (!acceptedPlan) return [];
    const task = this.currentTask(acceptedPlan);
    if (!task) return [];
    const authorizationOperations = Array.isArray(acceptedPlan.authorizationOperations)
      ? acceptedPlan.authorizationOperations
      : [];
    const source = authorizationOperations
      .filter((operation) => operation.sourceTaskId === task.taskId && !operation.internal)
      .map((operation) => ({
        operationId: operation.operationId,
        toolId: operation.toolId,
        operation: semanticOperation(operation.operationKind),
        targetRef: stringValue(operation.argsTemplate.path),
        targetResourceKind: operation.targetResourceKind,
        recursive: operation.recursive,
        fixedArgs: operation.fixedArgs,
        contentMode: operation.contentMode,
        targetCount: operation.targets.length,
      }));
    return source.flatMap((candidate): IntentSlot[] => {
      const targetRef = candidate.targetRef;
      if (
        !candidate.operation ||
        !targetRef ||
        targetRef === '.' ||
        targetRef === '/' ||
        (candidate.operation !== 'renamePath' && candidate.targetCount !== 1)
      ) return [];
      const contract = slotContract(candidate.operation, candidate.contentMode);
      return [{
        slotId: `slot-${task.taskId}-${candidate.operationId}`,
        taskId: task.taskId,
        toolId: candidate.toolId,
        operation: candidate.operation,
        targetRef,
        targetResourceKind: candidate.targetResourceKind,
        recursive: candidate.recursive === true,
        fixedArgs: candidate.fixedArgs,
        ...contract,
      }];
    });
  }

  private currentTask(acceptedPlan: AcceptedTaskPlanContext | undefined) {
    if (!acceptedPlan) return undefined;
    const settled = new Set([
      ...(acceptedPlan.completedTaskIds ?? []),
      ...(acceptedPlan.modelJudgedSufficientTaskIds ?? []),
    ]);
    return (acceptedPlan.tasks ?? []).find((candidate) => !settled.has(candidate.taskId));
  }

  deterministicDeleteSlots(acceptedPlan: AcceptedTaskPlanContext | undefined): IntentSlot[] {
    if (!acceptedPlan) return [];
    const slots = this.currentTaskSlots(acceptedPlan);
    if (!slots.length || slots.some((slot) => slot.operation !== 'deletePath' || slot.contentMode !== 'none')) return [];
    return slots;
  }
}

function semanticOperation(operation: string | undefined): IntentSlotOperation | undefined {
  if (operation === 'fsCreate') return 'createFile';
  if (operation === 'fsWrite') return 'replaceFile';
  if (operation === 'fsEdit') return 'patchFile';
  if (operation === 'fsDelete') return 'deletePath';
  if (operation === 'fsRename') return 'renamePath';
  if (operation === 'processExec') return 'runProcess';
  return undefined;
}

function slotContract(
  operation: IntentSlotOperation,
  contentMode: string
): Pick<IntentSlot, 'contentMode' | 'evidenceRequirement'> {
  if (contentMode === 'contentBlock' && operation === 'createFile') {
    return { contentMode: 'full', evidenceRequirement: 'none' };
  }
  if (contentMode === 'contentBlock' && operation === 'replaceFile') {
    return { contentMode: 'full', evidenceRequirement: 'targetObserved' };
  }
  if (contentMode === 'replacementBlock' && operation === 'patchFile') {
    return { contentMode: 'exactPatch', evidenceRequirement: 'exactTextObserved' };
  }
  if (operation === 'runProcess') return { contentMode: 'argv', evidenceRequirement: 'none' };
  return { contentMode: 'none', evidenceRequirement: 'targetObserved' };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
