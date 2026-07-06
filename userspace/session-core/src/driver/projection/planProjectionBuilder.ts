import type { AgentEvent } from '@deepcode/protocol';
import type { ActionBundleDraft, ProposalEnvelope } from '../../protocol/types.js';
import type { ConversationResourceRoot } from '../../context/types.js';
import {
  AcceptedPlanExecutionRootResolver,
  type ImplementationBatchContext,
} from '../execution/index.js';
import type {
  ReadablePlanProjection,
  ReadablePlanTask,
  ReadableProjectionItem,
  ReadableProjectionSection,
} from './structuredProjectionReadModels.js';

export type PlanProjectionLanguage = 'zh-CN' | 'en-US';

export interface PlanProjectionState {
  sessionId: string;
  userRequest: string;
  conversationRoots: ConversationResourceRoot[];
  implementationBatch: ImplementationBatchContext;
  interactionOverlay?: unknown;
}

export interface PlanProjectionBuilderPorts {
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined;
  requiredFileOperationsFromReport(report: Record<string, unknown> | undefined): unknown[];
  requiredAccessScopesFromReport(report: Record<string, unknown> | undefined): unknown[];
  permissionBundlesFromReport(report: Record<string, unknown> | undefined): PlanProjectionPermissionBundle[];
  gateInterventionsFromReport(report: Record<string, unknown> | undefined): PlanProjectionGateIntervention[];
  planReviewFacts(report: Record<string, unknown> | undefined): string[];
  interactionOverlayProjection(overlay: unknown): Record<string, unknown>;
  visibleLanguageForRequest(userRequest: string): PlanProjectionLanguage;
}

export interface PlanProjectionPermissionBundle {
  id: string;
  capability: string;
  resourceKind: string;
  resourcePath?: string;
  targets: string[];
  operationIds: string[];
  riskLevel: string;
  summary: string;
  expiresAfter?: string;
}

export interface PlanProjectionGateIntervention {
  id: string;
  interventionKind: string;
  status: string;
  summary: string;
  capability?: string;
  permissionBundleId?: string;
  options: string[];
}

interface KernelExecutionOperationProjection {
  operation: string;
  targetPath: string;
  capability: string;
}

export class PlanProjectionBuilder {
  constructor(private readonly ports: PlanProjectionBuilderPorts) {}

  planReviewDecisionEvent(input: {
    sessionId: string;
    plan: {
      runId: string;
      planId: string;
      userPlan?: string;
      planReviewReport?: Record<string, unknown>;
      interactionOverlay?: unknown;
    };
    status: 'accepted' | 'rejected' | 'needsRevision';
    summary?: string;
    ts: string;
    id: string;
  }): AgentEvent {
    const overlayPayload = this.ports.interactionOverlayProjection(input.plan.interactionOverlay);
    const messageKey = input.status === 'accepted'
      ? 'session.driver.planReviewAccepted'
      : input.status === 'rejected'
        ? 'session.driver.planReviewRejected'
        : 'session.driver.planReviewNeedsRevision';
    const language = this.ports.visibleLanguageForRequest(input.summary ?? input.plan.userPlan ?? '');
    const summary = input.summary ?? defaultPlanReviewDecisionSummary(input.status, language);
    return {
      id: input.id,
      sessionId: input.sessionId,
      ts: input.ts,
      kind: 'plan_review',
      payload: {
        title: 'Plan review',
        titleKey: 'session.driver.planReviewDecision.title',
        summary,
        summaryKey: messageKey,
        messageKey,
        messageArgs: { status: input.status },
        status: input.status,
        runId: input.plan.runId,
        planId: input.plan.planId,
        confirmable: false,
        facts: this.ports.planReviewFacts(input.plan.planReviewReport),
        requiredFileOperations: this.ports.requiredFileOperationsFromReport(input.plan.planReviewReport),
        permissionBundles: this.ports.permissionBundlesFromReport(input.plan.planReviewReport),
        interventions: this.ports.gateInterventionsFromReport(input.plan.planReviewReport),
        executionContract: objectRecord(input.plan.planReviewReport?.executionContract) ?? undefined,
        ...overlayPayload,
        channel: input.status === 'accepted' ? 'progress' : 'final',
        visibility: 'conversation',
        presentation: 'body',
        report: input.plan.planReviewReport,
      },
    };
  }

  actionBundlePlanCardEvent(input: {
    state: PlanProjectionState;
    proposal: ProposalEnvelope;
    report: Record<string, unknown> | undefined;
    ts: string;
    id: string;
  }): AgentEvent {
    const { state, proposal, report, ts, id } = input;
    const payload = objectRecord(proposal.payload) ?? {};
    const actionBundle = this.ports.readActionBundle(proposal);
    const userPlan = typeof payload.userPlan === 'string' && payload.userPlan.trim()
      ? payload.userPlan
      : actionBundle?.goal ?? 'Agent plan';
    const status = stringValue(report?.status) ?? 'pending';
    const planId = actionBundle?.id ?? proposal.proposalId;
    const confirmable = planReviewStatusAwaitingUser(status);
    const readablePlan = this.readableKernelExecutionContractPlan(userPlan, report, {
      runId: proposal.runId,
      planId,
      proposalId: proposal.proposalId,
    });
    const overlayPayload = this.ports.interactionOverlayProjection(state.interactionOverlay);
    const executionRoot = AcceptedPlanExecutionRootResolver.fromState(state);
    return {
      id,
      sessionId: state.sessionId,
      ts,
      kind: 'plan_card',
      payload: {
        titleKey: 'session.projection.plan.title',
        summary: readablePlan.summary,
        readablePlan,
        runId: proposal.runId,
        planId,
        proposalId: proposal.proposalId,
        status,
        confirmable,
        decisionOwner: {
          kind: 'plan',
          runId: proposal.runId,
          targetId: planId,
          planId,
          source: 'plan_card',
        },
        implementationBatch: state.implementationBatch,
        ...overlayPayload,
        executionRoot: AcceptedPlanExecutionRootResolver.toPayload(executionRoot),
        actionBundle,
        codeBlocks: Array.isArray(payload.codeBlocks) ? payload.codeBlocks : [],
        commandBlocks: Array.isArray(payload.commandBlocks) ? payload.commandBlocks : [],
        planReviewReport: report,
        requiredFileOperations: this.ports.requiredFileOperationsFromReport(report),
        requiredAccessScopes: this.ports.requiredAccessScopesFromReport(report),
        executionContract: objectRecord(report?.executionContract) ?? undefined,
        permissionBundles: this.ports.permissionBundlesFromReport(report),
        interventions: this.ports.gateInterventionsFromReport(report),
        channel: 'action',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  implementationPlanCardEvent(input: {
    state: PlanProjectionState;
    proposal: ProposalEnvelope;
    ts: string;
    id: string;
  }): AgentEvent {
    const { state, proposal, ts, id } = input;
    const implementationPlan = objectRecord(proposal.payload) ?? {};
    const planId = stringValue(implementationPlan.id) ?? proposal.proposalId;
    const summary = stringValue(implementationPlan.summary)
      ?? stringValue(implementationPlan.title)
      ?? 'Implementation plan';
    const readablePlan = readableImplementationPlan(implementationPlan, summary, {
      runId: proposal.runId,
      planId,
      proposalId: proposal.proposalId,
    });
    const overlayPayload = this.ports.interactionOverlayProjection(state.interactionOverlay);
    const executionRoot = AcceptedPlanExecutionRootResolver.fromState(state);
    return {
      id,
      sessionId: state.sessionId,
      ts,
      kind: 'plan_card',
      payload: {
        titleKey: 'session.projection.plan.title',
        summary,
        readablePlan,
        runId: proposal.runId,
        planId,
        proposalId: proposal.proposalId,
        status: 'pending',
        confirmable: true,
        decisionOwner: {
          kind: 'plan',
          runId: proposal.runId,
          targetId: planId,
          planId,
          source: 'plan_card',
        },
        implementationBatch: state.implementationBatch,
        ...overlayPayload,
        executionRoot: AcceptedPlanExecutionRootResolver.toPayload(executionRoot),
        taskPlan: implementationPlan,
        implementationPlan,
        requiredAccessScopes: accessScopesFromImplementationPlan(implementationPlan),
        actionBundle: {
          version: '1',
          id: planId,
          goal: summary,
          actions: [],
          continuationExpectations: [],
          validationExpectations: [],
          reviewExpectations: [],
        },
        codeBlocks: [],
        commandBlocks: [],
        channel: 'action',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  private readableKernelExecutionContractPlan(
    userPlan: string,
    report: Record<string, unknown> | undefined,
    sourceRefs: Record<string, string>
  ): ReadablePlanProjection {
    const status = stringValue(report?.status) ?? 'pending';
    const kernelSummary = stringValue(report?.kernelGeneratedPermissionSummary)
      ?? `Kernel gate status=${status}.`;
    const contract = objectRecord(report?.executionContract);
    const operations = this.kernelExecutionOperationsFromReport(report);
    const bundles = this.ports.permissionBundlesFromReport(report);
    const interventions = this.ports.gateInterventionsFromReport(report);
    const diagnostics = [
      ...stringArrayValue(contract?.diagnostics),
      ...stringArrayValue(report?.blockedReasons),
      ...stringArrayValue(report?.deniedReasons),
    ];
    return {
      schemaVersion: 'deepcode.session.readable-plan.v1',
      titleKey: 'session.projection.plan.title',
      summary: kernelSummary,
      sourceRefs,
      tasks: [],
      sections: [
        {
          sectionId: 'kernelGate',
          titleKey: 'session.projection.plan.section.kernelGate',
          items: [
            projectionItem('gate-status', 'fact', {
              messageKey: 'session.projection.plan.kernelGate.status',
              messageArgs: { status },
              status,
            }),
            projectionItem('gate-summary', 'fact', { text: kernelSummary }),
            ...(contract?.id ? [projectionItem('gate-contract', 'fact', {
              messageKey: 'session.projection.plan.kernelGate.contract',
              messageArgs: { id: String(contract.id) },
            })] : []),
          ],
        },
        {
          sectionId: 'operations',
          titleKey: 'session.projection.plan.section.operations',
          emptyMessageKey: 'session.projection.plan.empty.operations',
          items: operations.map((operation, index) => projectionItem(`operation-${index + 1}`, 'operation', {
            messageKey: 'session.projection.plan.operation',
            messageArgs: {
              operation: operation.operation,
              targetPath: operation.targetPath,
              capability: operation.capability,
            },
            targetRefs: [operation.targetPath],
            metadata: operation as unknown as Record<string, unknown>,
          })),
        },
        {
          sectionId: 'permissionBundles',
          titleKey: 'session.projection.plan.section.permissionBundles',
          emptyMessageKey: 'session.projection.plan.empty.permissionBundles',
          items: bundles.map((bundle) => projectionItem(bundle.id, 'permission', {
            messageKey: 'session.projection.plan.permissionBundle',
            messageArgs: {
              capability: bundle.capability,
              resourceKind: bundle.resourceKind,
              riskLevel: bundle.riskLevel,
              targets: bundle.targets.join(', '),
            },
            targetRefs: bundle.targets,
            metadata: bundle as unknown as Record<string, unknown>,
          })),
        },
        {
          sectionId: 'interventions',
          titleKey: 'session.projection.plan.section.interventions',
          emptyMessageKey: 'session.projection.plan.empty.interventions',
          items: interventions.map((item) => projectionItem(item.id, 'decision', {
            text: item.summary,
            status: item.status,
            metadata: item as unknown as Record<string, unknown>,
          })),
        },
        {
          sectionId: 'diagnostics',
          titleKey: 'session.projection.plan.section.diagnostics',
          emptyMessageKey: 'session.projection.plan.empty.diagnostics',
          items: [...new Set(diagnostics)].map((item, index) => projectionItem(`diagnostic-${index + 1}`, 'diagnostic', { text: item })),
        },
        {
          sectionId: 'agentPlan',
          titleKey: 'session.projection.plan.section.agentPlan',
          items: [projectionItem('agent-plan', 'text', { text: userPlan })],
        },
      ],
    };
  }

  private kernelExecutionOperationsFromReport(
    report: Record<string, unknown> | undefined
  ): KernelExecutionOperationProjection[] {
    const contract = objectRecord(report?.executionContract);
    const operations = Array.isArray(contract?.operations) ? contract.operations : [];
    const fromContract = operations.flatMap((item): KernelExecutionOperationProjection[] => {
      const record = objectRecord(item);
      if (!record) return [];
      const operation = stringValue(record.operation);
      const targetPath = stringValue(record.targetPath);
      const capability = stringValue(record.capability);
      return operation && targetPath && capability ? [{ operation, targetPath, capability }] : [];
    });
    return fromContract.length
      ? fromContract
      : this.ports.requiredFileOperationsFromReport(report).flatMap((item): KernelExecutionOperationProjection[] => {
        const record = objectRecord(item);
        if (!record) return [];
        const operation = stringValue(record.operation);
        const targetPath = stringValue(record.targetPath);
        const capability = stringValue(record.capability);
        return operation && targetPath && capability ? [{ operation, targetPath, capability }] : [];
      });
  }
}

function readableImplementationPlan(
  plan: Record<string, unknown>,
  fallbackSummary: string,
  sourceRefs: Record<string, string>
): ReadablePlanProjection {
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const readableTasks = tasks.flatMap((task, index): ReadablePlanTask[] => {
    const record = objectRecord(task) ?? {};
    const taskId = stringValue(record.taskId) ?? stringValue(record.id) ?? `task-${index + 1}`;
    const title = stringValue(record.title) ?? taskId;
    const targets = stringArrayValue(record.target);
    return [{
      taskId,
      title,
      objective: stringValue(record.objective) ?? stringValue(record.scope),
      targets,
      acceptance: stringArrayValue(record.acceptanceCriteria),
      failure: stringArrayValue(record.failureCriteria),
      intentKind: stringValue(record.capability),
      metadata: record,
    }];
  });
  const risks = stringArrayValue(plan.risks);
  const checkpoints = stringArrayValue(plan.reviewCheckpoints);
  return {
    schemaVersion: 'deepcode.session.readable-plan.v1',
    titleKey: 'session.projection.plan.title',
    summary: fallbackSummary,
    sourceRefs,
    tasks: readableTasks,
    sections: [
      {
        sectionId: 'summary',
        titleKey: 'session.projection.plan.section.summary',
        items: [projectionItem('summary', 'text', { text: fallbackSummary })],
      },
      {
        sectionId: 'tasks',
        titleKey: 'session.projection.plan.section.tasks',
        emptyMessageKey: 'session.projection.plan.empty.tasks',
        items: readableTasks.map((task) => projectionItem(task.taskId, 'task', {
          text: task.title,
          targetRefs: task.targets,
          metadata: task as unknown as Record<string, unknown>,
        })),
      },
      {
        sectionId: 'risks',
        titleKey: 'session.projection.plan.section.risks',
        emptyMessageKey: 'session.projection.plan.empty.risks',
        items: risks.map((item, index) => projectionItem(`risk-${index + 1}`, 'diagnostic', { text: item })),
      },
      {
        sectionId: 'reviewCheckpoints',
        titleKey: 'session.projection.plan.section.reviewCheckpoints',
        emptyMessageKey: 'session.projection.plan.empty.reviewCheckpoints',
        items: checkpoints.map((item, index) => projectionItem(`review-checkpoint-${index + 1}`, 'fact', { text: item })),
      },
      {
        sectionId: 'boundary',
        titleKey: 'session.projection.plan.section.boundary',
        items: [projectionItem('boundary', 'fact', {
          messageKey: 'session.projection.plan.boundary.notExecution',
        })],
      },
    ],
  };
}

function projectionItem(
  itemId: string,
  kind: ReadableProjectionItem['kind'],
  value: Omit<ReadableProjectionItem, 'itemId' | 'kind'>
): ReadableProjectionItem {
  return { itemId, kind, ...value };
}

function planReviewStatusAwaitingUser(status: string | undefined): boolean {
  return status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending' ||
    status === undefined;
}

function defaultPlanReviewDecisionSummary(
  status: 'accepted' | 'rejected' | 'needsRevision',
  language: PlanProjectionLanguage
): string {
  if (language === 'zh-CN') {
    return status === 'accepted'
      ? '用户已确认计划，准备进入执行。'
      : status === 'rejected'
        ? '用户已忽略计划，本轮会话已中止。'
        : '用户要求修改计划。';
  }
  return status === 'accepted'
    ? 'The user accepted the plan; execution can continue.'
    : status === 'rejected'
      ? 'The user ignored the plan; this run has been cancelled.'
      : 'The user requested plan changes.';
}

function accessScopesFromImplementationPlan(plan: Record<string, unknown> | undefined): unknown[] {
  const accessScopes = Array.isArray(plan?.accessScopes) ? plan.accessScopes : [];
  return accessScopes.filter((item) => Boolean(item) && typeof item === 'object' && !Array.isArray(item));
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}
