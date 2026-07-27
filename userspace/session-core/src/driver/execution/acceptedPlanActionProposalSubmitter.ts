import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  ConversationLanguage,
  KernelCommandEnvelope,
  KernelActionBatchV1,
  KernelProposalEnvelopeV1,
  KernelReply,
  ProjectionDelta,
} from '@deepcode/protocol';
import {
  appendTaskLocalCompactRecord,
  buildTaskLocalCompactRecord,
  type ContextAssemblyRecord,
  type ContextAssemblyTaskLocalCompactRecord,
  type ProjectMemoryMode,
} from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import type { AcceptedTaskPlanContext, AcceptedPlanBatchProgress } from '../../accepted-plan/types.js';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';
import type { ProposalRouterResult } from '../proposal/proposalRouter.js';
import { kernelReplyErrorMessage } from './kernelReplyGuard.js';
import type { KernelReplyObservation } from './kernelEventStatusIndex.js';
import {
  conversationPresentationLanguageBinding,
  conversationPresentationLanguage,
  localizedProjectionText,
  type ConversationPresentationLanguage,
} from '../projection/conversationPresentationLanguage.js';

export interface AcceptedPlanActionProposalInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
  workspaceBinding?: AgentWorkspaceBinding;
  projectWorkingDirectory?: ProjectWorkingDirectory;
  profileId?: string;
  workflow?: string;
  reviewContinuationMode?: 'auto' | 'ask' | 'off';
  interventionLevel?: 'low' | 'medium' | 'high';
  projectMemoryMode?: ProjectMemoryMode;
}

export interface AcceptedPlanActionProposalResumeInput extends AcceptedPlanActionProposalInput {
  existingEvents?: AgentEvent[];
  appendUserMessage: false;
  requirementConfirmationMode: 'off';
  resumeResourcePackets?: boolean;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedPlanActionProposalState {
  sessionId: string;
  runId: string;
  userRequest: string;
  phase: string;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
  resourcePackets: unknown[];
  generatedArtifactEvidence: unknown;
  taskExecutionCursor?: unknown;
  currentTaskContext?: {
    taskId?: string;
  };
  contextAssembly?: ContextAssemblyRecord;
  taskLocalCompactRecords?: ContextAssemblyTaskLocalCompactRecord[];
  userAuthorityFrame?: {
    effectiveLanguage: ConversationLanguage;
    languagePolicy?: {
      status?: string;
      revision?: number;
      sourceTurnId?: string;
    };
  };
}

export interface AcceptedPlanActionProposalSubmitterPorts<
  Input extends AcceptedPlanActionProposalInput,
  State extends AcceptedPlanActionProposalState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult | undefined>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  observeKernel(request: KernelCommandEnvelope): Promise<KernelReplyObservation>;
  appendProjectedKernelEvents(
    sessionId: string,
    reply: KernelReply,
    language: ConversationPresentationLanguage
  ): Promise<AgentSessionResult | undefined>;
  emitProjectionDelta(state: State, delta: ProjectionDelta): Promise<void>;
  emitKernelActivityDeltas(state: State, events: unknown[], stage: string): Promise<void>;
  readActionBundle(proposal: ProposalEnvelope): unknown | undefined;
  appendDiagnostic(state: State, code: string, fallback: string, params: Record<string, string | number> | undefined, idPrefix: string): Promise<AgentSessionResult | undefined>;
  sessionRunStateEvent(input: Record<string, unknown>): AgentEvent;
  findReviewReport(events: unknown[]): Record<string, unknown> | undefined;
  appendTrace(state: State, stage: string, payload: unknown): Promise<void>;
  denied(report: Record<string, unknown>): boolean;
  diagnosticSummary(report: Record<string, unknown>): string;
  executionContext(input: Record<string, unknown>): any;
  normalizeKernelBatch(input: Record<string, unknown>): { ok: true; batch: KernelActionBatchV1 } | { ok: false; reasons: string[] };
  normalizationFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    reasons: string[],
    ts: string,
    id: string,
    language?: ConversationLanguage
  ): AgentEvent[];
  executionExceptionEvents(
    sessionId: string,
    planRef: { runId: string; planId: string },
    message: string,
    code: string,
    ts: string,
    id: string,
    language?: ConversationLanguage
  ): AgentEvent[];
  executionFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    batchEvents: unknown[],
    batch: KernelActionBatchV1,
    ts: string,
    id: string,
    language?: ConversationLanguage
  ): AgentEvent[];
  preflightAudit(batch: KernelActionBatchV1): unknown;
  acceptedPlanBatchActivitySummary(
    batch: KernelActionBatchV1,
    language: ConversationPresentationLanguage
  ): string;
  acceptedPlanBatchActivity(input: {
    accepted: AcceptedTaskPlanContext;
    batch: KernelActionBatchV1;
    status: 'running' | 'completed';
    language: ConversationPresentationLanguage;
  }): unknown;
  generatedPacketFromSuccessfulBatch(state: State, batch: KernelActionBatchV1, events: unknown[], id: string): unknown | undefined;
  indexGeneratedPacket(index: unknown, packet: unknown): void;
  recordGeneratedPacket(state: State, packet: unknown, stage: string): Promise<{ result?: AgentSessionResult }>;
  recordKernelBatchProgress(input: {
    acceptedPlan: AcceptedTaskPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: AgentEvent[];
  }): {
    progress: AcceptedPlanBatchProgress;
    nextAcceptedPlan: AcceptedTaskPlanContext;
  };
  refreshRuntimeState(state: State): void;
  complete(accepted: AcceptedTaskPlanContext): boolean;
  batchCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[],
    progress: unknown,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord,
    language?: ConversationPresentationLanguage
  ): AgentEvent;
  taskSavepointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedTaskPlanContext,
    nextAccepted: AcceptedTaskPlanContext,
    progress: unknown,
    kernelEvents: unknown[],
    cursor: unknown,
    context: unknown,
    ts: string,
    id: string,
    contextCompactRecord?: ContextAssemblyTaskLocalCompactRecord,
    language?: ConversationPresentationLanguage
  ): AgentEvent;
  executionRequest(plan: any, acceptedPlan: AcceptedTaskPlanContext): string;
  staticSyntaxReview(input: {
    profileId?: string;
    state: State;
    prompt: PromptEnvelope;
    accepted: AcceptedTaskPlanContext;
    batch: KernelActionBatchV1;
    batchEvents: unknown[];
  }): Promise<AgentEvent[]>;
  beforeKernelMutation?(input: {
    input: Input;
    state: State;
    proposal: ProposalEnvelope;
    batch: KernelActionBatchV1;
    requestId: string;
    contractId: string;
    currentResult: AgentSessionResult;
  }): Promise<AgentSessionResult>;
  afterKernelObservation?(input: {
    input: Input;
    state: State;
    proposal: ProposalEnvelope;
    batch: KernelActionBatchV1;
    requestId: string;
    contractId: string;
    observation: KernelReplyObservation;
    projectedKernelEvents: AgentEvent[];
  }): void | Promise<void>;
}

export class AcceptedPlanActionProposalSubmitter<
  Input extends AcceptedPlanActionProposalInput,
  State extends AcceptedPlanActionProposalState,
> {
  constructor(private readonly ports: AcceptedPlanActionProposalSubmitterPorts<Input, State>) {}

  async submit(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult> {
    const accepted = state.acceptedTaskPlan;
    const actionBundle = this.ports.readActionBundle(proposal);
    if (!accepted || !actionBundle) return fallback;

    if (
      !accepted.authorizationContractId
      || !accepted.authorizationContractHash
      || !accepted.planHash
    ) {
      const appended = await this.ports.appendDiagnostic(
        state,
        'acceptedPlanAuthorizationUnavailable',
        localizedProjectionText(conversationPresentationLanguage(state), {
          zh: '已接受的 taskPlan 缺少 Kernel 计划授权绑定；Session 不会提交脱离授权合同的执行提案。',
          en: 'The accepted taskPlan is missing its Kernel plan authorization binding; Session will not submit a detached execution proposal.',
          neutral: 'accepted_plan_authorization=unavailable detached_execution_proposal=blocked',
        }),
        undefined,
        'accepted-plan-authorization-unavailable'
      );
      return appended ?? fallback;
    }
    const executionProposal: ProposalEnvelope = {
      ...proposal,
      payload: {
        ...(objectRecord(proposal.payload) ?? {}),
        authorizationContractId: accepted.authorizationContractId,
      },
    };
    state.phase = 'executing_accepted_plan';
    let result = fallback;
    result = await this.ports.append(state.sessionId, [
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'executing_accepted_plan',
        status: 'running',
        reason: 'accepted_plan_execution',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: accepted.planId,
          planId: accepted.planId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-accepted-plan-execution'),
      }),
    ]) ?? result;

    const proposalReply = await this.ports.kernel({
      command: {
        kind: 'proposalSubmit',
        requestId: this.ports.createId('proposal-submit-accepted-plan'),
        runId: state.runId,
        sessionId: state.sessionId,
        proposal: kernelProposal(executionProposal),
      },
    });
    const reviewReport = this.ports.findReviewReport(proposalReply.events);
    await this.ports.appendTrace(state, 'accepted_plan_batch_review_report', {
      acceptedPlanId: accepted.planId,
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    });
    if (!reviewReport) {
      const appended = await this.ports.appendDiagnostic(
        state,
        'autoPlanProposalReviewedMissing',
        localizedProjectionText(conversationPresentationLanguage(state), {
          zh: 'Kernel 未为已接受计划的 actionBundle 返回 proposal.reviewed 事件；Session 不会自动执行该批次。',
          en: 'Kernel did not return a proposal.reviewed event for the accepted-plan actionBundle; Session will not auto-execute this batch.',
          neutral: 'proposal_reviewed=missing auto_execute=false',
        }),
        undefined,
        'accepted-plan-review-missing'
      );
      return appended ?? result;
    }
    result = await this.ports.appendProjectedKernelEvents(
      state.sessionId,
      proposalReply,
      conversationPresentationLanguage(state)
    ) ?? result;
    if (this.ports.denied(reviewReport)) {
      const reasons = this.ports.diagnosticSummary(reviewReport);
      const appended = await this.ports.appendDiagnostic(
        state,
        'autoBatchRejected',
        localizedProjectionText(conversationPresentationLanguage(state), {
          zh: `Kernel 拒绝自动执行批次：${reasons}`,
          en: `Kernel rejected the automatic execution batch: ${reasons}`,
          neutral: `automatic_execution_batch=rejected detail=${reasons}`,
        }),
        { reasons },
        'accepted-plan-review-denied'
      );
      return appended ?? result;
    }
    const plan = this.ports.executionContext({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: accepted,
      proposal: executionProposal,
      planReviewReport: reviewReport,
    });
    const normalizedBatch = this.ports.normalizeKernelBatch({
      planId: accepted.planId,
      plan,
      acceptedPlan: accepted,
      resourcePackets: state.resourcePackets,
    });
    if (!normalizedBatch.ok) {
      return (await this.ports.append(state.sessionId, this.ports.normalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        normalizedBatch.reasons,
        this.ports.now(),
        this.ports.createId('accepted-plan-batch-normalization-failed'),
        state.userAuthorityFrame?.effectiveLanguage
      ))) ?? result;
    }
    const batch = normalizedBatch.batch;
    const contractId = stringValue(batch.contractId);
    if (!contractId) {
      return (await this.ports.append(state.sessionId, this.ports.executionExceptionEvents(
        state.sessionId,
        { runId: state.runId, planId: accepted.planId },
        'Kernel proposal review did not produce an execution contract for the accepted task batch.',
        'missing_execution_contract',
        this.ports.now(),
        this.ports.createId('accepted-plan-execution-contract-missing'),
        state.userAuthorityFrame?.effectiveLanguage
      ))) ?? result;
    }
    await this.ports.appendTrace(state, 'accepted_plan.action_batch_preflight', {
      planId: accepted.planId,
      batchIndex: accepted.batchIndex,
      audit: this.ports.preflightAudit(batch),
    });

    const presentationBinding = conversationPresentationLanguageBinding(state);
    const presentationLanguage = presentationBinding.language;
    await this.ports.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.action_batch_submit',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: this.ports.acceptedPlanBatchActivitySummary(batch, presentationLanguage),
      activity: this.ports.acceptedPlanBatchActivity({
        accepted,
        batch,
        status: 'running',
        language: presentationLanguage,
      }),
      payload: {
        visibility: 'task',
        presentationLanguage,
        languageRevision: presentationBinding.revision,
        languageStatus: presentationBinding.status,
        sourceTurnId: presentationBinding.sourceTurnId,
        planId: accepted.planId,
        batchIndex: accepted.batchIndex,
        actionCount: batch.actionBundle.actions.length,
      },
    } as ProjectionDelta);

    const actionRequestId = this.ports.createId(
      'accepted-plan-action-batch-submit'
    );
    if (this.ports.beforeKernelMutation) {
      result = await this.ports.beforeKernelMutation({
        input,
        state,
        proposal,
        batch,
        requestId: actionRequestId,
        contractId,
        currentResult: result,
      });
    }
    const observed = await this.ports.observeKernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: actionRequestId,
        runId: state.runId,
        sessionId: state.sessionId,
        batch,
      },
    });
    const batchReply = observed.reply;
    await this.ports.emitKernelActivityDeltas(state, batchReply.events ?? [], 'accepted_plan.action_batch_submit');
    const projectionStart = result.events.length;
    result = await this.ports.appendProjectedKernelEvents(
      state.sessionId,
      batchReply,
      conversationPresentationLanguage(state)
    ) ?? result;
    const projectedKernelEvents = result.events.slice(projectionStart);
    await this.ports.afterKernelObservation?.({
      input,
      state,
      proposal,
      batch,
      requestId: actionRequestId,
      contractId,
      observation: observed,
      projectedKernelEvents,
    });
    if (observed.kind === 'commandFailed') {
      const message = kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed');
      const code = observed.code;
      return (await this.ports.append(state.sessionId, this.ports.executionExceptionEvents(
        state.sessionId,
        { runId: state.runId, planId: accepted.planId },
        message,
        code,
        this.ports.now(),
        this.ports.createId('accepted-plan-action-batch-submit-failed'),
        state.userAuthorityFrame?.effectiveLanguage
      ))) ?? result;
    }
    const batchEvents = batchReply.events ?? [];
    if (observed.kind === 'factsObserved' && observed.hasFailureOrBlocker) {
      return (await this.ports.append(state.sessionId, this.ports.executionFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        batchEvents,
        batch,
        this.ports.now(),
        this.ports.createId('accepted-plan-batch-failed'),
        state.userAuthorityFrame?.effectiveLanguage
      ))) ?? result;
    }
    const generatedPacket = this.ports.generatedPacketFromSuccessfulBatch(
      state,
      batch,
      batchEvents,
      this.ports.createId('generated-artifact-evidence')
    );
    if (generatedPacket) {
      this.ports.indexGeneratedPacket(state.generatedArtifactEvidence, generatedPacket);
      result = (await this.ports.recordGeneratedPacket(
        state,
        generatedPacket,
        'accepted-plan-generated-artifact-evidence'
      )).result ?? result;
    }
    if (observed.kind === 'permissionInterrupted') {
      const permissionId = observed.permissionId;
      return (await this.ports.append(state.sessionId, [
        this.ports.sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'waiting_permission',
          reason: 'permission',
          decisionOwner: {
            kind: 'permission',
            runId: state.runId,
            targetId: permissionId,
            permissionId,
            planId: accepted.planId,
          },
          ts: this.ports.now(),
          id: this.ports.createId('session-run-waiting-permission'),
        }),
      ])) ?? result;
    }
    if (observed.kind !== 'factsObserved' || !observed.readyForReview) {
      return result;
    }
    const completedTaskId = state.currentTaskContext?.taskId;
    const ledgerEffect = this.ports.recordKernelBatchProgress({
      acceptedPlan: accepted,
      proposal: executionProposal,
      kernelEvents: projectedKernelEvents,
    });
    const batchProgress = ledgerEffect.progress;
    const nextAccepted = ledgerEffect.nextAcceptedPlan;
    state.acceptedTaskPlan = nextAccepted;
    this.ports.refreshRuntimeState(state);
    const savepointId = this.ports.createId('accepted-plan-task-savepoint');
    const contextCompactRecord = buildTaskLocalCompactRecord({
      contextAssembly: state.contextAssembly,
      source: 'kernelBatchCheckpoint',
      status: 'completedByKernelFacts',
      planId: accepted.planId,
      runId: state.runId,
      taskId: completedTaskId,
    });
    state.taskLocalCompactRecords = appendTaskLocalCompactRecord(
      state.taskLocalCompactRecords,
      contextCompactRecord
    );
    result = await this.ports.append(state.sessionId, [
      this.ports.batchCheckpointEvent(
        state.sessionId,
        state.runId,
        nextAccepted,
        executionProposal,
        batchReply.events ?? [],
        batchProgress,
        this.ports.now(),
        this.ports.createId('accepted-plan-batch-checkpoint'),
        contextCompactRecord,
        presentationLanguage
      ),
      this.ports.taskSavepointEvent(
        state.sessionId,
        state.runId,
        accepted,
        nextAccepted,
        batchProgress,
        batchReply.events ?? [],
        state.taskExecutionCursor,
        state.currentTaskContext,
        this.ports.now(),
        savepointId,
        contextCompactRecord,
        presentationLanguage
      ),
    ]) ?? result;
    if (state.taskExecutionCursor) {
      (state.taskExecutionCursor as { lastSavepointId?: string }).lastSavepointId = savepointId;
    }

    if (!observed.hasFailureOrBlocker && !this.ports.complete(nextAccepted)) {
      return { kind: 'continue', lastResult: result };
    }

    const staticReviewEvents = await this.ports.staticSyntaxReview({
      profileId: input.profileId,
      state,
      prompt,
      accepted,
      batch,
      batchEvents,
    });
    if (staticReviewEvents.length) {
      result = await this.ports.append(state.sessionId, staticReviewEvents) ?? result;
    }

    return {
      kind: 'assembleReview',
      request: {
        sessionId: state.sessionId,
        runId: state.runId,
        planId: accepted.planId,
        plan,
        result,
        currentKernelEvents: [...(batchReply.events ?? []), ...staticReviewEvents.map((event) => event.payload)],
        requestIdPrefix: 'accepted-plan-review-facts-get',
        presentationBinding,
      },
    };
  }

}

function kernelProposal(proposal: ProposalEnvelope): KernelProposalEnvelopeV1 {
  if (proposal.kind !== 'actionBundle') {
    throw new Error(`kernel_abi_event_invalid: expected actionBundle proposal, received ${proposal.kind}.`);
  }
  return {
    schemaVersion: proposal.schemaVersion,
    proposalId: proposal.proposalId,
    runId: proposal.runId,
    ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
    source: proposal.source,
    kind: proposal.kind,
    payload: proposal.payload,
    referencedResourcePacketRefs: proposal.referencedResourcePacketRefs,
    referencedEvidenceRefs: proposal.referencedEvidenceRefs,
    ...(proposal.parserDiagnostics !== undefined ? { parserDiagnostics: proposal.parserDiagnostics } : {}),
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
