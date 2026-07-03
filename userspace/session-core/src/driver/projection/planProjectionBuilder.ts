import type { AgentEvent } from '@deepcode/protocol';
import type { ActionBundleDraft, ProposalEnvelope } from '../../agent-plan/types.js';
import type { ConversationResourceRoot } from '../../context/types.js';
import {
  AcceptedPlanExecutionRootResolver,
  type ImplementationBatchContext,
} from '../execution/index.js';

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
    const kernelPlan = this.renderKernelExecutionContractPlan(userPlan, report);
    const overlayPayload = this.ports.interactionOverlayProjection(state.interactionOverlay);
    const executionRoot = AcceptedPlanExecutionRootResolver.fromState(state);
    return {
      id,
      sessionId: state.sessionId,
      ts,
      kind: 'plan_card',
      payload: {
        title: 'Plan',
        summary: kernelPlan.summary,
        content: kernelPlan.content,
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
        expectedValidation: typeof payload.expectedValidation === 'string' ? payload.expectedValidation : '',
        reviewGuide: typeof payload.reviewGuide === 'string' ? payload.reviewGuide : '',
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
    const language = this.ports.visibleLanguageForRequest(state.userRequest);
    const planId = stringValue(implementationPlan.id) ?? proposal.proposalId;
    const title = stringValue(implementationPlan.title) ?? localizedImplementationPlanHeading(language);
    const summary = stringValue(implementationPlan.summary) ?? title;
    const content = renderImplementationPlanMarkdown(implementationPlan, summary, language);
    const overlayPayload = this.ports.interactionOverlayProjection(state.interactionOverlay);
    const executionRoot = AcceptedPlanExecutionRootResolver.fromState(state);
    return {
      id,
      sessionId: state.sessionId,
      ts,
      kind: 'plan_card',
      payload: {
        title,
        summary,
        content,
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
        expectedValidation: '',
        reviewGuide: language === 'zh-CN'
          ? '请先审查任务清单、验收标准和失败重规划条件；确认后再生成编辑内容。'
          : 'Review the task checklist, acceptance criteria, and failure criteria before edits are generated.',
        channel: 'action',
        visibility: 'conversation',
        presentation: 'body',
      },
    };
  }

  private renderKernelExecutionContractPlan(
    userPlan: string,
    report: Record<string, unknown> | undefined
  ): { summary: string; content: string } {
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
    const sections = [
      '# Kernel 执行合约',
      '',
      '## 门禁状态',
      `- 状态：${status}`,
      `- 摘要：${kernelSummary}`,
      contract?.id ? `- 合约：${String(contract.id)}` : undefined,
      '',
      '## 将发生的操作',
      operations.length
        ? operations.map((operation) => `- ${operation.operation} ${operation.targetPath} (${operation.capability})`).join('\n')
        : '- 当前 Kernel report 未列出可执行文件操作。',
      '',
      '## 权限门禁',
      bundles.length
        ? bundles.map((bundle) => {
          const targets = bundle.targets.length ? `；目标：${bundle.targets.join(', ')}` : '';
          return `- ${bundle.capability} / ${bundle.resourceKind} / ${bundle.riskLevel}${targets}`;
        }).join('\n')
        : '- 当前合约没有额外权限 bundle。',
      '',
      '## 用户介入',
      interventions.length
        ? interventions.map((item) => `- ${item.interventionKind}: ${item.summary}`).join('\n')
        : '- 无额外用户介入项。',
      diagnostics.length
        ? '\n## Kernel 诊断\n' + [...new Set(diagnostics)].map((item) => `- ${item}`).join('\n')
        : undefined,
      '',
      '## LLM 说明',
      userPlan,
    ].filter((item): item is string => typeof item === 'string');
    return {
      summary: kernelSummary,
      content: sections.join('\n'),
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

function renderImplementationPlanMarkdown(
  plan: Record<string, unknown>,
  fallbackSummary: string,
  language: PlanProjectionLanguage
): string {
  const headings = implementationPlanMarkdownLabels(language);
  const lines = [`## ${headings.plan}`, '', fallbackSummary, ''];
  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  if (tasks.length) {
    lines.push(`## ${headings.checklist}`, '');
    for (const task of tasks) {
      const record = objectRecord(task) ?? {};
      const title = stringValue(record.title) ?? stringValue(record.taskId) ?? headings.task;
      lines.push(`- ${title}`);
      const target = stringArrayValue(record.target);
      if (target.length) lines.push(`  - Target: ${target.join(', ')}`);
      const scope = stringValue(record.scope);
      if (scope) lines.push(`  - Scope: ${scope}`);
      const capability = stringValue(record.capability);
      if (capability) lines.push(`  - Capability: ${capability}`);
      const acceptance = stringArrayValue(record.acceptanceCriteria);
      if (acceptance.length) lines.push(`  - Acceptance: ${acceptance.join('; ')}`);
      const failure = stringArrayValue(record.failureCriteria);
      if (failure.length) lines.push(`  - Stop/Replan: ${failure.join('; ')}`);
    }
    lines.push('');
  }
  const risks = stringArrayValue(plan.risks);
  if (risks.length) {
    lines.push(`## ${headings.risks}`, '', ...risks.map((item) => `- ${item}`), '');
  }
  const checkpoints = stringArrayValue(plan.reviewCheckpoints);
  if (checkpoints.length) {
    lines.push(`## ${headings.reviewCheckpoints}`, '', ...checkpoints.map((item) => `- ${item}`), '');
  }
  lines.push(`## ${headings.boundary}`, '', `- ${headings.boundaryMessage}`);
  return lines.join('\n');
}

function localizedImplementationPlanHeading(language: PlanProjectionLanguage): string {
  return language === 'zh-CN' ? '实现计划' : 'Implementation plan';
}

function implementationPlanMarkdownLabels(language: PlanProjectionLanguage): {
  plan: string;
  checklist: string;
  task: string;
  risks: string;
  reviewCheckpoints: string;
  boundary: string;
  boundaryMessage: string;
} {
  if (language === 'zh-CN') {
    return {
      plan: '计划',
      checklist: '任务清单',
      task: '任务',
      risks: '风险',
      reviewCheckpoints: 'Review 节点',
      boundary: '边界',
      boundaryMessage: '这只是计划，不是执行结果；代码和命令只会在用户确认后生成。',
    };
  }
  return {
    plan: 'Plan',
    checklist: 'Checklist',
    task: 'Task',
    risks: 'Risks',
    reviewCheckpoints: 'Review Checkpoints',
    boundary: 'Boundary',
    boundaryMessage: 'This plan is not execution. Code and commands are generated only after user acceptance.',
  };
}

function planReviewStatusAwaitingUser(status: string | undefined): boolean {
  return status === 'awaitingUserApproval' ||
    status === 'awaitingTemporaryGrant' ||
    status === 'pending' ||
    status === undefined;
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
