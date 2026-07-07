import type {
  AgentEvent,
  AgentSessionResult,
  KernelReply,
  LlmChatRequest,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { ResourcePacket } from '../../context/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import { SessionDriverRepairRuntimeAccessor } from '../runFrame.js';

export interface ActionProposalSubmitterInput {
  profileId?: string;
}

export interface ActionProposalSubmitterState {
  sessionId: string;
  runId: string;
  resourcePackets: ResourcePacket[];
  acceptedImplementationPlan?: unknown;
  planReviewRepairAttempted: boolean;
  phase?: string;
}

export interface ActionProposalSubmitterDiagnostic {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export interface ActionProposalSubmitterPorts<
  Input extends ActionProposalSubmitterInput,
  State extends ActionProposalSubmitterState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  appendProjectedKernelEvents(sessionId: string, reply: KernelReply): Promise<AgentSessionResult | undefined>;
  readActionBundle(proposal: ProposalEnvelope): unknown;
  actionBundleAdmissionBatch(proposal: ProposalEnvelope): Record<string, unknown>;
  deleteAdmissionReasons(batch: Record<string, unknown>, resourcePackets: ResourcePacket[]): string[];
  repairActionBundleAdmission(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    reasons: string[],
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult>;
  submitAcceptedPlanActionProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult>;
  submitProposal(state: State, proposal: ProposalEnvelope, requestId: string): Promise<KernelReply>;
  findReviewReport(events: unknown[]): Record<string, unknown> | undefined;
  appendTrace(state: State, stage: string, payload: Record<string, unknown>): Promise<void>;
  needsRepair(report: Record<string, unknown>): boolean;
  denied(report: Record<string, unknown>): boolean;
  diagnosticSummary(report: Record<string, unknown>): string;
  buildRepairMessages(
    prompt: PromptEnvelope,
    state: State,
    proposal: ProposalEnvelope,
    report: Record<string, unknown>
  ): LlmChatRequest['messages'];
  runRepair(input: Input, state: State, stage: string, messages: LlmChatRequest['messages']): Promise<string>;
  parseRepairedProposal(raw: string, state: State, allowedKinds: string[]): ProposalEnvelope;
  repairErrorMessage(error: unknown): string;
  thinkingEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | ActionProposalSubmitterDiagnostic,
    ts: string,
    id: string
  ): AgentEvent;
  answerEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent;
  planCardEvent(input: {
    state: State;
    proposal: ProposalEnvelope;
    report: Record<string, unknown>;
    ts: string;
    id: string;
  }): AgentEvent;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'waiting_plan_review';
    reason: 'plan_review';
    decisionOwner: {
      kind: 'plan';
      runId: string;
      targetId: string;
      planId: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
  diagnostic(code: string, fallback: string, params?: Record<string, string | number>): ActionProposalSubmitterDiagnostic;
}

export class ActionProposalSubmitter<
  Input extends ActionProposalSubmitterInput,
  State extends ActionProposalSubmitterState,
> {
  constructor(private readonly ports: ActionProposalSubmitterPorts<Input, State>) {}

  async submit(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const actionBundle = this.ports.readActionBundle(proposal);
    if (actionBundle && state.acceptedImplementationPlan) {
      return this.ports.submitAcceptedPlanActionProposal(input, state, prompt, proposal, fallback);
    }
    if (actionBundle) {
      const admissionBatch = this.ports.actionBundleAdmissionBatch(proposal);
      const admissionReasons = this.ports.deleteAdmissionReasons(admissionBatch, state.resourcePackets);
      if (admissionReasons.length) {
        return this.ports.repairActionBundleAdmission(input, state, prompt, proposal, admissionReasons, fallback);
      }
    }
    const proposalReply = await this.ports.submitProposal(state, proposal, this.ports.createId('proposal-submit'));
    if (!actionBundle) return await this.ports.appendProjectedKernelEvents(state.sessionId, proposalReply) ?? fallback;

    const reviewReport = this.ports.findReviewReport(proposalReply.events);
    await this.ports.appendTrace(state, 'plan_review_report', {
      proposalId: proposal.proposalId,
      report: reviewReport,
      events: proposalReply.events,
    });
    if (!reviewReport) {
      return this.ports.append(state.sessionId, [
        this.ports.finalDiagnosticEvent(
          state.sessionId,
          this.ports.diagnostic(
            'planProposalReviewedMissing',
            'Kernel did not return a proposal.reviewed event for the actionBundle; Session will not display a confirmable plan.'
          ),
          this.ports.now(),
          this.ports.createId('plan-review-missing')
        ),
      ]);
    }
    const repairRuntime = new SessionDriverRepairRuntimeAccessor(state);
    if (this.ports.needsRepair(reviewReport) && !repairRuntime.attempted('planReviewRepairAttempted')) {
      repairRuntime.markAttempted('planReviewRepairAttempted');
      await this.ports.append(state.sessionId, [
        this.ports.thinkingEvent(
          state.sessionId,
          'Kernel PlanReview requires additional proposal evidence; Session is running one controlled repair attempt.',
          this.ports.now(),
          this.ports.createId('plan-review-repair')
        ),
      ]);
      let repaired: ProposalEnvelope;
      try {
        repaired = await this.repairPlanReview(input, state, prompt, proposal, reviewReport);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.ports.append(state.sessionId, [
          this.ports.finalDiagnosticEvent(
            state.sessionId,
            this.ports.diagnostic(
              'planRevisionRepairFailed',
              `The plan needs revision, but model repair failed: ${message}`,
              { message }
            ),
            this.ports.now(),
            this.ports.createId('plan-review-repair-failed')
          ),
        ]);
      }
      if (repaired.kind === 'actionBundle') {
        return this.submit(input, state, prompt, repaired, fallback);
      }
      if (repaired.kind === 'answer') {
        return this.ports.append(state.sessionId, [
          this.ports.answerEvent(state.sessionId, repaired, this.ports.now(), this.ports.createId('answer')),
        ]);
      }
      return this.submitNonExecutable(state, repaired, fallback);
    }

    let result = await this.ports.appendProjectedKernelEvents(state.sessionId, proposalReply);
    if (this.ports.denied(reviewReport)) {
      const reasons = this.ports.diagnosticSummary(reviewReport);
      return this.ports.append(state.sessionId, [
        this.ports.finalDiagnosticEvent(
          state.sessionId,
          this.ports.diagnostic('planRejected', `Kernel rejected the plan: ${reasons}`, { reasons }),
          this.ports.now(),
          this.ports.createId('plan-review-denied')
        ),
      ]);
    }
    const planCard = this.ports.planCardEvent({
      state,
      proposal,
      report: reviewReport,
      ts: this.ports.now(),
      id: this.ports.createId('plan-card'),
    });
    const planId = stringValue(objectRecord(planCard.payload)?.planId) ?? proposal.proposalId;
    state.phase = 'waiting_plan_review';
    result = await this.ports.append(state.sessionId, [
      planCard,
      this.ports.sessionRunStateEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        phase: 'waiting_plan_review',
        reason: 'plan_review',
        decisionOwner: {
          kind: 'plan',
          runId: state.runId,
          targetId: planId,
          planId,
        },
        ts: this.ports.now(),
        id: this.ports.createId('session-run-waiting-plan'),
      }),
    ]);
    return result ?? fallback;
  }

  async submitNonExecutable(
    state: State,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    const proposalReply = await this.ports.submitProposal(state, proposal, this.ports.createId('proposal-submit'));
    const result = await this.ports.appendProjectedKernelEvents(state.sessionId, proposalReply);
    return result ?? fallback;
  }

  async repairPlanReview(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    report: Record<string, unknown>
  ): Promise<ProposalEnvelope> {
    const raw = await this.ports.runRepair(
      input,
      state,
      'plan_review_repair',
      this.ports.buildRepairMessages(prompt, state, proposal, report)
    );
    try {
      return this.ports.parseRepairedProposal(raw, state, [
        'actionBundle',
        'resourceRequest',
        'decisionRequest',
        'diagnostic',
      ]);
    } catch (error) {
      throw new Error(`Model plan output still could not be parsed after repair: ${this.ports.repairErrorMessage(error)}`);
    }
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
