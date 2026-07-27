import type {
  AcceptedTaskPlanContext,
  AcceptedPlanAuthorizationOperation,
  AcceptedTaskPlanExecutionRoot,
  AcceptedTaskPlanTaskContext,
  AcceptedPlanInterventionLevel,
  ExecutionSliceRole,
} from '../../accepted-plan/types.js';

export interface AcceptedTaskPlanSource {
  planId: string;
  runId: string;
  planReviewReport?: Record<string, unknown>;
  planAuthorizationReview?: Record<string, unknown>;
  planHash?: string;
  authorizationContractId?: string;
  authorizationContractHash?: string;
  taskPlan?: Record<string, unknown>;
}

export interface AcceptedTaskPlanContextBuilderPorts {
  normalizePlanScope(value: string): string;
  uniqueStrings(values: Array<string | undefined>): string[];
  acceptedPlanTaskTargets(record: Record<string, unknown>): string[];
}

export class AcceptedTaskPlanContextBuilder {
  constructor(private readonly ports: AcceptedTaskPlanContextBuilderPorts) {}

  build(input: {
    plan: AcceptedTaskPlanSource;
    interventionLevel?: AcceptedPlanInterventionLevel;
    executionRoot?: AcceptedTaskPlanExecutionRoot;
  }): AcceptedTaskPlanContext {
    const { plan, interventionLevel, executionRoot } = input;
    const rawPlan = plan.taskPlan ?? {};
    const tasks = Array.isArray(rawPlan.tasks) ? rawPlan.tasks : [];
    const taskContexts = tasks.flatMap((item, index): AcceptedTaskPlanTaskContext[] => {
      const record = objectRecord(item);
      if (!record) return [];
      const taskId = stringValue(record.taskId) ?? stringValue(record.id) ?? `task-${index + 1}`;
      const planningArgs = objectRecord(record.args);
      if (!planningArgs) {
        throw new Error(`session_task_intent_schema_incompatible: task ${taskId} has no canonical args object.`);
      }
      const dependencies = this.ports.uniqueStrings(stringArrayValue(record.dependencies));
      const conflictKeys = stringArrayValue(record.conflictKeys)
        .map((value) => this.ports.normalizePlanScope(value))
        .filter(Boolean);
      return [{
        taskId,
        title: stringValue(record.title),
        toolId: stringValue(record.toolId),
        targets: this.ports.acceptedPlanTaskTargets(record),
        acceptanceCriteria: stringArrayValue(record.acceptanceCriteria),
        failureCriteria: stringArrayValue(record.failureCriteria),
        dependencies,
        planningArgs,
        conflictKeys,
        batchKind: executionSliceRoleValue(record.batchKind),
      }];
    });
    const toolIds = this.ports.uniqueStrings(taskContexts.map((task) => task.toolId));
    const targetScopes = this.ports.uniqueStrings(taskContexts.flatMap((task) => task.targets));
    const authorizationOperations = planAuthorizationOperations(plan.planAuthorizationReview);
    return {
      planId: plan.planId,
      planHash: plan.planHash,
      authorizationContractId: plan.authorizationContractId,
      authorizationContractHash: plan.authorizationContractHash,
      runId: plan.runId,
      title: stringValue(rawPlan.title),
      summary: stringValue(rawPlan.summary),
      tasks: taskContexts,
      authorizationOperations,
      toolIds,
      targetScopes,
      executionRoot,
      interventionLevel,
      batchIndex: 1,
      completedTaskIds: [],
      modelJudgedSufficientTaskIds: [],
      skippedTaskIds: [],
      acceptedIncompleteTaskIds: [],
      dependencyFacts: [],
      rawPlan,
    };
  }
}

function planAuthorizationOperations(
  review: Record<string, unknown> | undefined
): AcceptedPlanAuthorizationOperation[] {
  const contract = objectRecord(review?.authorizationContract);
  const operations = Array.isArray(contract?.operations) ? contract.operations : [];
  return operations.flatMap((item): AcceptedPlanAuthorizationOperation[] => {
    const record = objectRecord(item);
    const operationId = stringValue(record?.id);
    const sourceTaskId = stringValue(record?.sourceTaskId);
    const toolId = stringValue(record?.toolId);
    const operationKind = stringValue(record?.operationKind);
    const contentMode = stringValue(record?.contentMode);
    const fixedArgs = objectRecord(record?.fixedArgs);
    const argsTemplate = objectRecord(record?.argsTemplate);
    if (!operationId || !sourceTaskId || !toolId || !operationKind || !contentMode || !fixedArgs || !argsTemplate) {
      return [];
    }
    const targetKind = stringValue(record?.targetKind);
    return [{
      operationId,
      sourceTaskId,
      toolId,
      operationKind,
      contentMode,
      targets: stringArrayValue(record?.targets),
      dependsOn: stringArrayValue(record?.dependsOn),
      fixedArgs,
      argsTemplate,
      targetResourceKind: targetKind === 'file' || targetKind === 'directory' ? targetKind : undefined,
      recursive: typeof record?.recursive === 'boolean' ? record.recursive : undefined,
      internal: record?.internal === true,
    }];
  });
}

function executionSliceRoleValue(value: unknown): ExecutionSliceRole | undefined {
  const role = typeof value === 'string' && value.trim() ? value.trim() : undefined;
  if (
    role === 'sourceCode' ||
    role === 'infra' ||
    role === 'script' ||
    role === 'test' ||
    role === 'docs' ||
    role === 'config' ||
    role === 'review'
  ) {
    return role;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
