import type { ActionBundleDraft, ProposalEnvelope } from '../../protocol/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import type { PlanContext } from '../proposal/planContextIndex.js';
import type { KernelActionBatchV1, KernelActionV1, KernelContentBlockV1 } from '@deepcode/protocol';

export interface AcceptedPlanReadOnlyResourceCompletion {
  taskId: string;
  newlyCompletedTaskIds: string[];
  completedTaskIds: string[];
  remainingTaskIds: string[];
  coveredTargets: string[];
}

export type NormalizedAcceptedPlanKernelBatch =
  | {
      ok: true;
      batch: KernelActionBatchV1;
      reasons: [];
    }
  | {
      ok: false;
      reasons: string[];
    };

export interface AcceptedPlanExecutorPorts {
  readActionBundle(proposal: ProposalEnvelope): ActionBundleDraft | undefined;
  kernelExecutionContractId(report?: Record<string, unknown>): string | undefined;
  kernelExecutionContractHash(report?: Record<string, unknown>): string | undefined;
}

export class AcceptedPlanExecutor {
  constructor(private readonly ports?: AcceptedPlanExecutorPorts) {}

  executionContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan?: AcceptedTaskPlanContext;
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
      contentBlocks: Array.isArray(payload.contentBlocks) ? payload.contentBlocks : [],
      expectedValidation: stringValue(payload.expectedValidation) ?? '',
      reviewGuide: stringValue(payload.reviewGuide) ?? '',
      planReviewReport: input.planReviewReport,
      taskPlan: input.acceptedPlan?.rawPlan,
    };
  }

  modelTaskOutcomeReviewContext(input: {
    sessionId: string;
    runId: string;
    acceptedPlan: AcceptedTaskPlanContext;
    taskId: string;
    summary: string;
    evidenceRefs: string[];
  }): PlanContext {
    return {
      sessionId: input.sessionId,
      runId: input.runId,
      planId: input.acceptedPlan.planId,
      proposalId: `${input.acceptedPlan.planId}:task-outcome`,
      userPlan: input.acceptedPlan.summary ?? input.acceptedPlan.title ?? 'Accepted task plan',
      actionBundle: {
        version: '1',
        id: `${input.acceptedPlan.planId}:task-outcome`,
        goal: input.summary,
        actions: [],
        validationExpectations: [{
          id: `${input.taskId}:already-satisfied`,
          description: input.summary,
          evidenceRefs: input.evidenceRefs,
          source: 'sessionTaskOutcome',
        }],
        reviewExpectations: [{
          id: `${input.taskId}:review-already-satisfied`,
          description: 'Review the task-scoped evidence showing that no additional workspace mutation was required.',
        }],
      },
      contentBlocks: [],
      expectedValidation: input.summary,
      reviewGuide: 'Distinguish Kernel execution facts from Session modelJudgedSufficient task outcomes.',
      taskPlan: input.acceptedPlan.rawPlan,
      planHash: input.acceptedPlan.planHash,
      authorizationContractId: input.acceptedPlan.authorizationContractId,
      authorizationContractHash: input.acceptedPlan.authorizationContractHash,
      executionRoot: input.acceptedPlan.executionRoot,
    };
  }

  normalizeKernelBatch(input: {
    planId: string;
    plan: PlanContext;
    acceptedPlan?: AcceptedTaskPlanContext;
    resourcePackets?: ResourcePacket[];
  }): NormalizedAcceptedPlanKernelBatch {
    const ports = this.requirePorts();
    const actionBundle = objectRecord(input.plan.actionBundle);
    const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
    const reasons: string[] = [];
    if (!actionBundle || !actions.length) {
      reasons.push('actionBundle.actions must be a non-empty array.');
    }
    const contentBlocks = input.plan.contentBlocks.map((value) => {
      const block = objectRecord(value);
      if (!block) {
        reasons.push(`contentBlocks[] is not an object.`);
        return value;
      }
      const blockId = stringValue(block.blockId);
      if (!blockId || !stringValue(block.targetPath) || !Array.isArray(block.contentLines)) {
        reasons.push('contentBlocks[] requires blockId, targetPath, and contentLines.');
      } else if (block.contentLines.some((line) => typeof line !== 'string')) {
        reasons.push(`contentBlocks[] ${blockId} contains a non-string content line.`);
      }
      return block;
    });

    const normalizedActions = actions.map((value): KernelActionV1 | undefined => {
      const action = objectRecord(value);
      if (!action) {
        reasons.push(`actionBundle.actions[] is not an object.`);
        return undefined;
      }
      const actionId = stringValue(action.actionId);
      const toolId = stringValue(action.toolId);
      const args = objectRecord(action.args);
      const description = stringValue(action.description);
      const dependsOn = stringArrayValue(action.dependsOn);
      if (!actionId || !toolId || !args || !description) {
        reasons.push(`actionBundle.actions[] requires actionId, toolId, and typed args.`);
        return undefined;
      }
      return { actionId, toolId, args, description, dependsOn };
    });

    const contractId = ports.kernelExecutionContractId(input.plan.planReviewReport);
    const contractHash = ports.kernelExecutionContractHash(input.plan.planReviewReport);
    if (!contractId || !contractHash) reasons.push('Kernel execution contract id/hash is unavailable.');

    if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] };
    const normalizedContentBlocks = contentBlocks.map((value): KernelContentBlockV1 => {
      const block = value as Record<string, unknown>;
      return {
        blockId: stringValue(block.blockId)!,
        targetPath: stringValue(block.targetPath)!,
        ...(stringValue(block.language) ? { language: stringValue(block.language) } : {}),
        operation: block.operation as KernelContentBlockV1['operation'],
        contentLines: [...(block.contentLines as string[])],
        allowEmptyContent: block.allowEmptyContent === true,
      };
    });
    const continuationExpectations = arrayRecords(actionBundle?.continuationExpectations).map((item) => ({
      id: stringValue(item.id)!,
      description: stringValue(item.description)!,
      target: stringArrayValue(item.target),
      ...(stringValue(item.reason) ? { reason: stringValue(item.reason) } : {}),
      dependsOn: stringArrayValue(item.dependsOn),
    }));
    const validationExpectations = arrayRecords(actionBundle?.validationExpectations).map((item) => ({
      id: stringValue(item.id)!,
      description: stringValue(item.description)!,
    }));
    const reviewExpectations = arrayRecords(actionBundle?.reviewExpectations).map((item) => ({
      id: stringValue(item.id)!,
      description: stringValue(item.description)!,
    }));
    return {
      ok: true,
      reasons: [],
      batch: {
        planId: input.planId,
        contractId: contractId!,
        contractHash: contractHash!,
        actionBundle: {
          version: stringValue(actionBundle?.version) ?? '1',
          id: stringValue(actionBundle?.id)!,
          goal: stringValue(actionBundle?.goal)!,
          ...(stringValue(actionBundle?.requirementId) ? { requirementId: stringValue(actionBundle?.requirementId) } : {}),
          actions: normalizedActions.filter((item): item is KernelActionV1 => Boolean(item)),
          continuationExpectations,
          validationExpectations,
          reviewExpectations,
        },
        contentBlocks: normalizedContentBlocks,
      },
    };
  }

  private requirePorts(): AcceptedPlanExecutorPorts {
    if (!this.ports) {
      throw new Error('AcceptedPlanExecutor requires ports for execution context and kernel batch normalization.');
    }
    return this.ports;
  }

}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function stringArrayValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
