import type {
  AcceptedImplementationPlanContext,
  AcceptedImplementationPlanExecutionRoot,
  AcceptedImplementationPlanTaskContext,
  AcceptedPlanAccessScope,
  AcceptedPlanExactOperationGrant,
  AcceptedPlanInterventionLevel,
  ExecutionSliceRole,
} from '../../accepted-plan/types.js';

export interface AcceptedImplementationPlanSource {
  planId: string;
  runId: string;
  planReviewReport?: Record<string, unknown>;
  implementationPlan?: Record<string, unknown>;
}

export interface AcceptedImplementationPlanContextBuilderPorts {
  objectRecord(value: unknown): Record<string, unknown> | undefined;
  stringValue(value: unknown): string | undefined;
  stringArrayValue(value: unknown): string[];
  normalizePlanScope(value: string): string;
  uniqueStrings(values: Array<string | undefined>): string[];
  acceptedPlanTaskTargets(record: Record<string, unknown>): string[];
  exactOperationGrantsFromImplementationPlan(
    plan: Record<string, unknown> | undefined,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant[];
  exactOperationGrantsFromPlanReviewReport(
    report: Record<string, unknown> | undefined,
    executionRoot?: AcceptedImplementationPlanExecutionRoot
  ): AcceptedPlanExactOperationGrant[];
  accessScopesFromImplementationPlan(plan: Record<string, unknown> | undefined): AcceptedPlanAccessScope[];
  requiredAccessScopesFromReport(report: Record<string, unknown> | undefined): AcceptedPlanAccessScope[];
}

export class AcceptedImplementationPlanContextBuilder {
  constructor(private readonly ports: AcceptedImplementationPlanContextBuilderPorts) {}

  build(input: {
    plan: AcceptedImplementationPlanSource;
    interventionLevel?: AcceptedPlanInterventionLevel;
    executionRoot?: AcceptedImplementationPlanExecutionRoot;
  }): AcceptedImplementationPlanContext {
    const { plan, interventionLevel, executionRoot } = input;
    const rawPlan = plan.implementationPlan ?? {};
    const tasks = Array.isArray(rawPlan.tasks) ? rawPlan.tasks : [];
    const taskContexts = tasks.flatMap((item, index): AcceptedImplementationPlanTaskContext[] => {
      const record = this.ports.objectRecord(item);
      if (!record) return [];
      const taskId = this.ports.stringValue(record.taskId) ?? this.ports.stringValue(record.id) ?? `task-${index + 1}`;
      const legacyDependencies = this.ports.stringArrayValue(record.dependencies)
        .concat(this.ports.stringArrayValue(record.dependsOn))
        .map((value) => this.ports.normalizePlanScope(value))
        .filter(Boolean);
      const conflictKeys = this.ports.stringArrayValue(record.conflictKeys)
        .map((value) => this.ports.normalizePlanScope(value))
        .filter(Boolean);
      return [{
        taskId,
        title: this.ports.stringValue(record.title),
        capability: this.ports.stringValue(record.capability),
        targets: this.ports.acceptedPlanTaskTargets(record),
        dependencies: legacyDependencies,
        conflictKeys,
        batchKind: executionSliceRoleValue(record.batchKind) ?? executionSliceRoleValue(record.role),
        role: executionSliceRoleValue(record.batchKind) ?? executionSliceRoleValue(record.role),
      }];
    });
    const capabilities = this.ports.uniqueStrings(taskContexts.map((task) => task.capability));
    const targetScopes = this.ports.uniqueStrings(taskContexts.flatMap((task) => task.targets));
    const exactOperationGrants = [
      ...this.ports.exactOperationGrantsFromImplementationPlan(rawPlan, executionRoot),
      ...this.ports.exactOperationGrantsFromPlanReviewReport(plan.planReviewReport, executionRoot),
    ];
    const accessScopes = [
      ...this.ports.accessScopesFromImplementationPlan(rawPlan),
      ...this.ports.requiredAccessScopesFromReport(plan.planReviewReport),
    ];
    const acceptedCapabilities = this.ports.uniqueStrings([
      ...capabilities,
      ...exactOperationGrants.map((grant) => grant.capability),
      ...accessScopes.flatMap((scope) => scope.capabilities),
    ]);
    return {
      planId: plan.planId,
      runId: plan.runId,
      title: this.ports.stringValue(rawPlan.title),
      summary: this.ports.stringValue(rawPlan.summary),
      tasks: taskContexts,
      capabilities: acceptedCapabilities,
      targetScopes,
      exactOperationGrants,
      accessScopes,
      executionRoot,
      interventionLevel,
      batchIndex: 1,
      completedTaskIds: [],
      rawPlan,
    };
  }
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
