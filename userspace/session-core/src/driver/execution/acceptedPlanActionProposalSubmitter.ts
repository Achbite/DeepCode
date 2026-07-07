import type {
  AgentContextAttachment,
  AgentEvent,
  AgentSessionResult,
  AgentWorkspaceBinding,
  KernelCommandEnvelope,
  KernelReply,
  ProjectionDelta,
} from '@deepcode/protocol';
import type { ProjectMemoryMode } from '../../context/index.js';
import type { ProjectWorkingDirectory } from '../../context/types.js';
import type { AcceptedImplementationPlanContext, AcceptedPlanBatchProgress } from '../../accepted-plan/types.js';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { InteractionOverlayContext } from '../pipelines/interactionOverlayCodec.js';
import { decisionContinuationInput } from '../runContinuation.js';
import { kernelReplyErrorMessage } from './kernelReplyGuard.js';

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
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  interactionOverlay?: InteractionOverlayContext;
}

export interface AcceptedPlanActionProposalState {
  sessionId: string;
  runId: string;
  userRequest: string;
  phase: string;
  acceptedImplementationPlan?: AcceptedImplementationPlanContext;
  resourcePackets: unknown[];
  generatedArtifactEvidence: unknown;
  taskExecutionCursor?: unknown;
  currentTaskContext?: {
    taskId?: string;
  };
  acceptedPlanScopeRepairAttempted?: boolean;
  planReviewRepairAttempted?: boolean;
}

export interface AcceptedPlanActionProposalSubmitterPorts<
  Input extends AcceptedPlanActionProposalInput,
  State extends AcceptedPlanActionProposalState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult | undefined>;
  kernel(request: KernelCommandEnvelope): Promise<KernelReply>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult | undefined>;
  emitProjectionDelta(state: State, delta: ProjectionDelta): Promise<void>;
  emitKernelActivityDeltas(state: State, events: unknown[], stage: string): Promise<void>;
  readActionBundle(proposal: ProposalEnvelope): unknown | undefined;
  tryCompleteReadOnlyActionBundle(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | null>;
  assessActionProposal(input: Record<string, unknown>): { kind: string; [key: string]: unknown };
  admission(): unknown;
  appendScopeIntervention(
    input: Input,
    state: State,
    proposal: ProposalEnvelope,
    validation: unknown
  ): Promise<AgentSessionResult>;
  appendThinking(state: State, message: string, idPrefix: string, metadata?: Record<string, unknown>): Promise<void>;
  repairScope(input: {
    state: State;
    prompt: PromptEnvelope;
    proposal: ProposalEnvelope;
    validation: unknown;
    input: Input;
  }): Promise<ProposalEnvelope>;
  handleScopeResourceFollowup(input: {
    state: State;
    acceptedPlan: AcceptedImplementationPlanContext;
    proposal: ProposalEnvelope;
    request: ResourceRequestDraft;
    result: AgentSessionResult;
  }): Promise<{ kind: 'failed'; result: AgentSessionResult } | { kind: 'resume'; result: AgentSessionResult; content: string }>;
  waitForScopeDecision(input: {
    state: State;
    proposal: ProposalEnvelope;
    request: {
      content: string;
      attachments?: AgentContextAttachment[];
    };
  }): Promise<AgentSessionResult>;
  appendDiagnostic(state: State, code: string, fallback: string, params: Record<string, string | number> | undefined, idPrefix: string): Promise<AgentSessionResult | undefined>;
  submitNonExecutableProposal(state: State, proposal: ProposalEnvelope, fallback: AgentSessionResult): Promise<AgentSessionResult>;
  sessionRunStateEvent(input: Record<string, unknown>): AgentEvent;
  accessScopesCanonicalizedEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    canonicalization: unknown,
    ts: string,
    id: string
  ): AgentEvent;
  findReviewReport(events: unknown[]): Record<string, unknown> | undefined;
  appendTrace(state: State, stage: string, payload: unknown): Promise<void>;
  acceptedPlanNeedsRepair(report: Record<string, unknown>): boolean;
  repairPlanReview(input: Input, state: State, prompt: PromptEnvelope, proposal: ProposalEnvelope, report: Record<string, unknown>): Promise<ProposalEnvelope>;
  answerEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent;
  denied(report: Record<string, unknown>): boolean;
  diagnosticSummary(report: Record<string, unknown>): string;
  nonAcceptedPermissionGaps(report: Record<string, unknown>, accepted: AcceptedImplementationPlanContext): string[];
  executionContext(input: Record<string, unknown>): any;
  temporaryGrantsForPlan(plan: any): unknown[];
  normalizeKernelBatch(input: Record<string, unknown>): { ok: true; batch: Record<string, unknown> } | { ok: false; reasons: string[] };
  normalizationFailureEvents(sessionId: string, runId: string, accepted: AcceptedImplementationPlanContext, reasons: string[], ts: string, id: string): AgentEvent[];
  executionExceptionEvents(sessionId: string, planRef: { runId: string; planId: string }, message: string, code: string, ts: string, id: string): AgentEvent[];
  executionFailureEvents(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    batchEvents: unknown[],
    batch: Record<string, unknown>,
    ts: string,
    id: string
  ): AgentEvent[];
  deletePreflightReasons(batch: Record<string, unknown>, resourcePackets: unknown[]): string[];
  preflightAudit(batch: Record<string, unknown>): unknown;
  acceptedPlanBatchActivitySummary(batch: Record<string, unknown>): string;
  acceptedPlanBatchActivity(input: Record<string, unknown>): unknown;
  generatedPacketFromSuccessfulBatch(state: State, batch: Record<string, unknown>, events: unknown[], id: string): unknown | undefined;
  indexGeneratedPacket(index: unknown, packet: unknown): void;
  recordGeneratedPacket(state: State, packet: unknown, stage: string): Promise<{ result?: AgentSessionResult }>;
  hasFailureOrBlocker(events: unknown[]): boolean;
  actionBatchReadyForReview(events: unknown[]): boolean;
  hasPermissionRequest(events: unknown[]): boolean;
  permissionId(events: unknown[]): string | undefined;
  recordKernelBatchProgress(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    proposal: ProposalEnvelope;
    kernelEvents: unknown[];
  }): {
    progress: AcceptedPlanBatchProgress;
    completedTaskIds: string[];
    nextAcceptedPlan: AcceptedImplementationPlanContext;
  };
  recordModelTaskOutcome(input: {
    acceptedPlan: AcceptedImplementationPlanContext;
    taskId: string;
  }): {
    taskId: string;
    nextAcceptedPlan: AcceptedImplementationPlanContext;
  };
  refreshRuntimeState(state: State): void;
  complete(accepted: AcceptedImplementationPlanContext): boolean;
  batchCheckpointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: unknown[],
    progress: unknown,
    ts: string,
    id: string
  ): AgentEvent;
  taskSavepointEvent(
    sessionId: string,
    runId: string,
    accepted: AcceptedImplementationPlanContext,
    nextAccepted: AcceptedImplementationPlanContext,
    progress: unknown,
    kernelEvents: unknown[],
    cursor: unknown,
    context: unknown,
    ts: string,
    id: string
  ): AgentEvent;
  executionRequest(plan: any, acceptedPlan: AcceptedImplementationPlanContext): string;
  runUserTurn(input: AcceptedPlanActionProposalResumeInput): Promise<AgentSessionResult>;
  staticSyntaxReview(input: {
    profileId?: string;
    state: State;
    prompt: PromptEnvelope;
    accepted: AcceptedImplementationPlanContext;
    batch: Record<string, unknown>;
    batchEvents: unknown[];
  }): Promise<AgentEvent[]>;
  reviewHandoff(input: {
    sessionId: string;
    runId: string;
    planId: string;
    plan: any;
    result: AgentSessionResult;
    currentKernelEvents: unknown[];
    requestIdPrefix: string;
  }): Promise<AgentSessionResult>;
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
  ): Promise<AgentSessionResult> {
    const accepted = state.acceptedImplementationPlan;
    if (proposal.kind === 'taskOutcome') {
      return this.submitTaskOutcome(input, state, prompt, proposal, fallback);
    }
    const actionBundle = this.ports.readActionBundle(proposal);
    if (!accepted || !actionBundle) return fallback;

    const readOnlyActionResult = await this.ports.tryCompleteReadOnlyActionBundle(
      input,
      state,
      prompt,
      proposal,
      fallback
    );
    if (readOnlyActionResult) return readOnlyActionResult;

    const assessment = this.ports.assessActionProposal({
      accepted,
      proposal,
      actionBundle,
      resourcePackets: state.resourcePackets,
      scopeRepairAttempted: state.acceptedPlanScopeRepairAttempted,
      admission: this.ports.admission(),
    });
    if (assessment.kind === 'missingActionBundle') return fallback;
    if (assessment.kind === 'deterministicScopeIntervention') {
      return this.ports.appendScopeIntervention(input, state, proposal, assessment.validation);
    }
    if (assessment.kind === 'scopeRepair') {
      state.acceptedPlanScopeRepairAttempted = true;
      await this.ports.appendThinking(
        state,
        'The current execution batch is outside the confirmed current-task scope; Session is asking the model to continue the current task or request additional authorization.',
        'accepted-plan-scope-repair',
        {
          messageKey: 'session.driver.acceptedPlanScopeRepair',
          messageArgs: {},
        }
      );
      try {
        const repaired = await this.ports.repairScope({
          state,
          prompt,
          proposal,
          validation: assessment.validation,
          input,
        });
        if (repaired.kind === 'actionBundle') {
          return this.submit(input, state, prompt, repaired, fallback);
        }
        if (repaired.kind === 'resourceRequest') {
          const followup = await this.ports.handleScopeResourceFollowup({
            state,
            acceptedPlan: accepted,
            proposal,
            request: repaired.payload as ResourceRequestDraft,
            result: fallback,
          });
          if (followup.kind === 'failed') return followup.result;
          return this.ports.runUserTurn(decisionContinuationInput(input, {
            content: followup.content,
            attachments: accepted.executionRoot ? [accepted.executionRoot.attachment] : [],
            existingEvents: followup.result.events,
            reviewContinuationMode: input.reviewContinuationMode,
            resumeResourcePackets: true,
            acceptedImplementationPlan: accepted,
          }));
        }
        if (repaired.kind === 'decisionRequest') {
          return this.ports.waitForScopeDecision({
            state,
            proposal: repaired,
            request: {
              content: input.content,
              attachments: input.attachments,
            },
          });
        }
        if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
          const appended = await this.ports.appendDiagnostic(
            state,
            'acceptedPlanScopeRepairReturnedPlan',
            'Accepted-plan execution repair returned a plan proposal. Session will not re-enter plan review from an accepted task; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
            { returnedKind: repaired.kind, proposalId: repaired.proposalId },
            'accepted-plan-scope-repair-plan-forbidden'
          );
          return appended ?? fallback;
        }
        return this.ports.submitNonExecutableProposal(state, repaired, fallback);
      } catch {
        return this.ports.appendScopeIntervention(input, state, proposal, assessment.validation);
      }
    }

    const scopeCanonicalization = assessment.scopeCanonicalization as { changed: boolean; proposal: ProposalEnvelope };
    const executionProposal = scopeCanonicalization.proposal;
    state.phase = 'executing_accepted_plan';
    let result = fallback;
    if (scopeCanonicalization.changed) {
      result = await this.ports.append(state.sessionId, [
        this.ports.accessScopesCanonicalizedEvent(
          state.sessionId,
          state.runId,
          accepted,
          scopeCanonicalization,
          this.ports.now(),
          this.ports.createId('accepted-plan-access-scopes-canonicalized')
        ),
      ]) ?? result;
    }
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
        proposal: executionProposal,
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
        'Kernel did not return a proposal.reviewed event for the accepted-plan actionBundle; Session will not auto-execute this batch.',
        undefined,
        'accepted-plan-review-missing'
      );
      return appended ?? result;
    }
    if (this.ports.acceptedPlanNeedsRepair(reviewReport) && !state.planReviewRepairAttempted) {
      state.planReviewRepairAttempted = true;
      await this.ports.appendThinking(
        state,
        'Kernel PlanReview requires revising the current accepted-plan batch; Session is running one controlled repair attempt.',
        'accepted-plan-review-repair'
      );
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.ports.repairPlanReview(input, state, prompt, executionProposal, reviewReport);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const appended = await this.ports.appendDiagnostic(
          state,
          'autoBatchRevisionRepairFailed',
          `The automatic execution batch needs revision, but model repair failed: ${message}`,
          { message },
          'accepted-plan-review-repair-failed'
        );
        return appended ?? result;
      }
      if (repaired.kind === 'actionBundle') {
        return this.submit(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return (await this.ports.append(state.sessionId, [
          this.ports.answerEvent(state.sessionId, repaired, this.ports.now(), this.ports.createId('answer')),
        ])) ?? result;
      }
      return this.ports.submitNonExecutableProposal(state, repaired, fallback);
    }

    result = await this.ports.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? result;
    if (this.ports.denied(reviewReport)) {
      const reasons = this.ports.diagnosticSummary(reviewReport);
      const appended = await this.ports.appendDiagnostic(
        state,
        'autoBatchRejected',
        `Kernel rejected the automatic execution batch: ${reasons}`,
        { reasons },
        'accepted-plan-review-denied'
      );
      return appended ?? result;
    }
    if (reviewReport.status === 'needsRevision') {
      return this.ports.appendScopeIntervention(input, state, executionProposal, {
        ok: false,
        reasons: [`Kernel PlanReview requires revising the current batch: ${this.ports.diagnosticSummary(reviewReport)}`],
      });
    }

    const autoGrantBlockers = this.ports.nonAcceptedPermissionGaps(reviewReport, accepted);
    if (autoGrantBlockers.length) {
      return this.ports.appendScopeIntervention(input, state, executionProposal, {
        ok: false,
        reasons: autoGrantBlockers.map((capability) => `The current batch requires additional permission ${capability}, which is outside the accepted taskPlan automatic execution scope.`),
      });
    }

    const plan = this.ports.executionContext({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: accepted,
      proposal: executionProposal,
      planReviewReport: reviewReport,
    });
    const grantEvents: unknown[] = [];
    for (const grant of this.ports.temporaryGrantsForPlan(plan)) {
      const grantReply = await this.ports.kernel({
        command: {
          kind: 'permissionGrantTemporary',
          requestId: this.ports.createId('accepted-plan-temp-grant'),
          runId: state.runId,
          grant,
        },
      });
      grantEvents.push(...(grantReply.events ?? []));
    }
    if (grantEvents.length) {
      result = await this.ports.appendProjectedKernelEvents(state.sessionId, { ok: true, events: grantEvents }) ?? result;
    }

    const normalizedBatch = this.ports.normalizeKernelBatch({
      planId: accepted.planId,
      plan,
      acceptedPlan: accepted,
    });
    if (!normalizedBatch.ok) {
      return (await this.ports.append(state.sessionId, this.ports.normalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        normalizedBatch.reasons,
        this.ports.now(),
        this.ports.createId('accepted-plan-batch-normalization-failed')
      ))) ?? result;
    }
    const batch = normalizedBatch.batch;
    const deletePreflightReasons = this.ports.deletePreflightReasons(batch, state.resourcePackets);
    if (deletePreflightReasons.length) {
      return (await this.ports.append(state.sessionId, this.ports.normalizationFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        deletePreflightReasons,
        this.ports.now(),
        this.ports.createId('accepted-plan-delete-preflight-failed')
      ))) ?? result;
    }
    await this.ports.appendTrace(state, 'accepted_plan.action_batch_preflight', {
      planId: accepted.planId,
      batchIndex: accepted.batchIndex,
      audit: this.ports.preflightAudit(batch),
    });

    await this.ports.emitProjectionDelta(state, {
      type: 'stage_delta',
      stage: 'accepted_plan.action_batch_submit',
      status: 'running',
      channel: 'progress',
      source: 'session',
      summary: this.ports.acceptedPlanBatchActivitySummary(batch),
      activity: this.ports.acceptedPlanBatchActivity({ accepted, batch, status: 'running' }),
      payload: {
        visibility: 'task',
        planId: accepted.planId,
        batchIndex: accepted.batchIndex,
        actionCount: Array.isArray((batch as Record<string, unknown>).actions)
          ? ((batch as Record<string, unknown>).actions as unknown[]).length
          : undefined,
      },
    } as ProjectionDelta);

    const batchReply = await this.ports.kernel({
      command: {
        kind: 'actionBatchSubmit',
        requestId: this.ports.createId('accepted-plan-action-batch-submit'),
        runId: state.runId,
        sessionId: state.sessionId,
        batch,
      },
    });
    await this.ports.emitKernelActivityDeltas(state, batchReply.events ?? [], 'accepted_plan.action_batch_submit');
    result = await this.ports.appendProjectedKernelEvents(state.sessionId, batchReply) ?? result;
    if (!batchReply.ok) {
      const message = kernelReplyErrorMessage(batchReply, 'Kernel actionBatchSubmit failed');
      const code = stringValue(objectRecord(batchReply.error)?.code) ?? 'accepted_plan_execution_failed';
      return (await this.ports.append(state.sessionId, this.ports.executionExceptionEvents(
        state.sessionId,
        { runId: state.runId, planId: accepted.planId },
        message,
        code,
        this.ports.now(),
        this.ports.createId('accepted-plan-action-batch-submit-failed')
      ))) ?? result;
    }
    const batchEvents = batchReply.events ?? [];
    if (this.ports.hasFailureOrBlocker(batchEvents)) {
      return (await this.ports.append(state.sessionId, this.ports.executionFailureEvents(
        state.sessionId,
        state.runId,
        accepted,
        batchEvents,
        batch,
        this.ports.now(),
        this.ports.createId('accepted-plan-batch-failed')
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
    if (!this.ports.actionBatchReadyForReview(batchReply.events ?? [])) {
      if (this.ports.hasPermissionRequest(batchReply.events ?? [])) {
        const permissionId = this.ports.permissionId(batchReply.events ?? []);
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
      return result;
    }
    const ledgerEffect = this.ports.recordKernelBatchProgress({ acceptedPlan: accepted, proposal: executionProposal, kernelEvents: batchReply.events ?? [] });
    const batchProgress = ledgerEffect.progress;
    const nextAccepted = ledgerEffect.nextAcceptedPlan;
    this.ports.refreshRuntimeState(state);
    const savepointId = this.ports.createId('accepted-plan-task-savepoint');
    result = await this.ports.append(state.sessionId, [
      this.ports.batchCheckpointEvent(
        state.sessionId,
        state.runId,
        accepted,
        executionProposal,
        batchReply.events ?? [],
        batchProgress,
        this.ports.now(),
        this.ports.createId('accepted-plan-batch-checkpoint')
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
        savepointId
      ),
    ]) ?? result;
    if (state.taskExecutionCursor) {
      (state.taskExecutionCursor as { lastSavepointId?: string }).lastSavepointId = savepointId;
    }

    if (!this.ports.hasFailureOrBlocker(batchReply.events ?? []) && !this.ports.complete(nextAccepted)) {
      return this.ports.runUserTurn(decisionContinuationInput(input, {
        content: this.ports.executionRequest(
          {
            ...this.ports.executionContext({
              sessionId: state.sessionId,
              runId: state.runId,
              acceptedPlan: accepted,
              proposal: executionProposal,
              planReviewReport: reviewReport,
            }),
            implementationPlan: accepted.rawPlan,
          },
          nextAccepted
        ),
        attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
        existingEvents: result.events,
        reviewContinuationMode: input.reviewContinuationMode,
        resumeResourcePackets: true,
        acceptedImplementationPlan: nextAccepted,
      }));
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

    return this.ports.reviewHandoff({
      sessionId: state.sessionId,
      runId: state.runId,
      planId: accepted.planId,
      plan,
      result,
      currentKernelEvents: [...(batchReply.events ?? []), ...staticReviewEvents.map((event) => event.payload)],
      requestIdPrefix: 'accepted-plan-review-facts-get',
    });
  }

  private async submitTaskOutcome(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    void prompt;
    const accepted = state.acceptedImplementationPlan;
    const payload = objectRecord(proposal.payload);
    const currentTaskId = stringValue(state.currentTaskContext?.taskId);
    const taskId = stringValue(payload?.taskId) ?? currentTaskId;
    const status = stringValue(payload?.status) ?? 'modelJudgedSufficient';
    const reason = stringValue(payload?.reason) ?? stringValue(payload?.summary);
    if (!accepted || !payload || !taskId || !currentTaskId) {
      const appended = await this.ports.appendDiagnostic(
        state,
        'invalidTaskOutcome',
        'taskOutcome can only be used while an accepted task cursor is active.',
        undefined,
        'task-outcome-invalid-state'
      );
      return appended ?? fallback;
    }
    if (taskId !== currentTaskId) {
      const appended = await this.ports.appendDiagnostic(
        state,
        'taskOutcomeTaskMismatch',
        'taskOutcome.taskId must match the current accepted task cursor.',
        { taskId, currentTaskId },
        'task-outcome-task-mismatch'
      );
      return appended ?? fallback;
    }
    if (status !== 'modelJudgedSufficient') {
      const appended = await this.ports.appendDiagnostic(
        state,
        'unsupportedTaskOutcomeStatus',
        'Only taskOutcome.status="modelJudgedSufficient" advances the accepted task cursor; use diagnostic for blocked or failed tasks.',
        { status },
        'task-outcome-unsupported-status'
      );
      return appended ?? fallback;
    }
    if (!reason) {
      const appended = await this.ports.appendDiagnostic(
        state,
        'taskOutcomeMissingReason',
        'taskOutcome.reason is required so the task cursor can be audited without creating Kernel facts.',
        undefined,
        'task-outcome-missing-reason'
      );
      return appended ?? fallback;
    }

    const ledgerEffect = this.ports.recordModelTaskOutcome({ acceptedPlan: accepted, taskId });
    const nextAccepted = ledgerEffect.nextAcceptedPlan;
    state.acceptedImplementationPlan = nextAccepted;
    this.ports.refreshRuntimeState(state);
    const modelJudgedSufficientTaskIds = nextAccepted.modelJudgedSufficientTaskIds ?? [];
    const settled = new Set([
      ...nextAccepted.completedTaskIds,
      ...modelJudgedSufficientTaskIds,
    ]);
    const progress: AcceptedPlanBatchProgress = {
      actionIds: [],
      targetPaths: currentTaskTargets(state),
      workUnitIds: [],
      newlyCompletedTaskIds: [],
      completedTaskIds: nextAccepted.completedTaskIds,
      newlyModelJudgedSufficientTaskIds: [taskId],
      modelJudgedSufficientTaskIds,
      remainingTaskIds: nextAccepted.tasks
        .map((task) => task.taskId)
        .filter((id) => !settled.has(id)),
    };
    const savepointId = this.ports.createId('accepted-plan-task-savepoint');
    const checkpointResult = await this.ports.append(state.sessionId, [
      this.ports.batchCheckpointEvent(
        state.sessionId,
        state.runId,
        accepted,
        proposal,
        [],
        progress,
        this.ports.now(),
        this.ports.createId('accepted-plan-task-outcome-checkpoint')
      ),
      this.ports.taskSavepointEvent(
        state.sessionId,
        state.runId,
        accepted,
        nextAccepted,
        progress,
        [],
        state.taskExecutionCursor,
        state.currentTaskContext,
        this.ports.now(),
        savepointId
      ),
    ]) ?? fallback;
    if (state.taskExecutionCursor) {
      (state.taskExecutionCursor as { lastSavepointId?: string }).lastSavepointId = savepointId;
    }

    if (!this.ports.complete(nextAccepted)) {
      return this.ports.runUserTurn(decisionContinuationInput(input, {
        content: this.ports.executionRequest(
          {
            sessionId: state.sessionId,
            runId: state.runId,
            acceptedPlan: accepted,
            proposal,
            taskOutcome: payload,
            implementationPlan: accepted.rawPlan,
          },
          nextAccepted
        ),
        attachments: nextAccepted.executionRoot ? [nextAccepted.executionRoot.attachment] : [],
        existingEvents: checkpointResult.events,
        reviewContinuationMode: input.reviewContinuationMode,
        resumeResourcePackets: true,
        acceptedImplementationPlan: nextAccepted,
      }));
    }

    const plan = this.ports.executionContext({
      sessionId: state.sessionId,
      runId: state.runId,
      acceptedPlan: nextAccepted,
      proposal,
      taskOutcome: payload,
    });
    return this.ports.reviewHandoff({
      sessionId: state.sessionId,
      runId: state.runId,
      planId: nextAccepted.planId,
      plan,
      result: checkpointResult,
      currentKernelEvents: [],
      requestIdPrefix: 'accepted-plan-task-outcome-review-facts-get',
    });
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function currentTaskTargets(state: AcceptedPlanActionProposalState): string[] {
  const record = objectRecord(state.currentTaskContext);
  const targets = record?.targets;
  return Array.isArray(targets)
    ? targets.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}
