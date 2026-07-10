import type { AgentContextAttachment, AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type { ProposalRouterResult } from '../proposal/proposalRouter.js';
import { SessionDriverRepairRuntimeAccessor } from '../runFrame.js';

export interface ActionBundleAdmissionCoordinatorInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
}

export interface ActionBundleAdmissionCoordinatorState {
  sessionId: string;
  runId: string;
  userRequest: string;
  actionBundleAdmissionRepairAttempted: boolean;
  phase?: string;
}

export interface ActionBundleAdmissionCoordinatorDiagnostic {
  code: string;
  fallback: string;
  params?: Record<string, string | number>;
}

export type ActionBundleAdmissionResourceFollowupResult =
  | { kind: 'failed'; result: AgentSessionResult }
  | { kind: 'resume'; result: AgentSessionResult; content: string };

export interface ActionBundleAdmissionCoordinatorPorts<
  Input extends ActionBundleAdmissionCoordinatorInput,
  State extends ActionBundleAdmissionCoordinatorState,
> {
  now(): string;
  createId(prefix: string): string;
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  admissionFailureEvents(input: {
    sessionId: string;
    runId: string;
    proposal: ProposalEnvelope;
    reasons: string[];
    ts: string;
    id: string;
  }): AgentEvent[];
  admissionRepairingEvent(input: {
    sessionId: string;
    runId: string;
    proposal: ProposalEnvelope;
    reasons: string[];
    ts: string;
    id: string;
  }): AgentEvent;
  repair(input: {
    input: Input;
    state: State;
    prompt: PromptEnvelope;
    proposal: ProposalEnvelope;
    reasons: string[];
  }): Promise<ProposalEnvelope>;
  repairErrorMessage(error: unknown): string;
  resourceFollowup(input: {
    state: State;
    proposal: ProposalEnvelope;
    request: ResourceRequestDraft;
    reasons: string[];
    result: AgentSessionResult;
  }): Promise<ActionBundleAdmissionResourceFollowupResult>;
  submitActionProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<ProposalRouterResult>;
  submitNonExecutableProposal(
    state: State,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult>;
  requirementRecordFromProposal(input: {
    proposal: ProposalEnvelope;
    sessionId: string;
    runId: string;
    userRequest: string;
    timestamp: string;
  }): RequirementRecord;
  confirmationEvent(input: {
    sessionId: string;
    runId: string;
    requirement: RequirementRecord;
    proposal: ProposalEnvelope;
    originalUserRequest: string;
    attachments: AgentContextAttachment[];
    ts: string;
    id: string;
  }): AgentEvent;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'waiting_plan_review';
    reason: 'requirement';
    decisionOwner: {
      kind: 'requirement';
      runId: string;
      targetId: string;
      requirementId: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | ActionBundleAdmissionCoordinatorDiagnostic,
    ts: string,
    id: string
  ): AgentEvent;
  answerEvent(sessionId: string, proposal: ProposalEnvelope, ts: string, id: string): AgentEvent;
  diagnosticSummary(proposal: ProposalEnvelope): string;
  diagnostic(code: string, fallback: string, params?: Record<string, string | number>): ActionBundleAdmissionCoordinatorDiagnostic;
}

export class ActionBundleAdmissionCoordinator<
  Input extends ActionBundleAdmissionCoordinatorInput,
  State extends ActionBundleAdmissionCoordinatorState,
> {
  constructor(private readonly ports: ActionBundleAdmissionCoordinatorPorts<Input, State>) {}

  async repair(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    reasons: string[],
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult> {
    const repairRuntime = new SessionDriverRepairRuntimeAccessor(state);
    if (repairRuntime.attempted('actionBundleAdmissionRepairAttempted')) {
      return this.ports.append(state.sessionId, this.ports.admissionFailureEvents({
        sessionId: state.sessionId,
        runId: state.runId,
        proposal,
        reasons,
        ts: this.ports.now(),
        id: this.ports.createId('action-bundle-admission-failed'),
      })) ?? fallback;
    }
    repairRuntime.markAttempted('actionBundleAdmissionRepairAttempted');
    let result = await this.ports.append(state.sessionId, [
      this.ports.admissionRepairingEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        proposal,
        reasons,
        ts: this.ports.now(),
        id: this.ports.createId('action-bundle-admission-repairing'),
      }),
    ]) ?? fallback;

    let repaired: ProposalEnvelope;
    try {
      repaired = await this.ports.repair({ input, state, prompt, proposal, reasons });
    } catch (error) {
      const message = this.ports.repairErrorMessage(error);
      return this.ports.append(state.sessionId, this.ports.admissionFailureEvents({
        sessionId: state.sessionId,
        runId: state.runId,
        proposal,
        reasons: [`actionBundle admission repair failed: ${message}`],
        ts: this.ports.now(),
        id: this.ports.createId('action-bundle-admission-repair-failed'),
      })) ?? result;
    }

    if (repaired.kind === 'actionBundle') {
      return this.ports.submitActionProposal(input, state, prompt, repaired, result);
    }
    if (repaired.kind === 'resourceRequest') {
      const followup = await this.ports.resourceFollowup({
        state,
        proposal,
        request: repaired.payload as ResourceRequestDraft,
        reasons,
        result,
      });
      if (followup.kind === 'failed') return followup.result;
      return { kind: 'continue', lastResult: followup.result };
    }
    if (repaired.kind === 'decisionRequest') {
      const requirement = this.ports.requirementRecordFromProposal({
        proposal: repaired,
        sessionId: state.sessionId,
        runId: state.runId,
        userRequest: input.content,
        timestamp: this.ports.now(),
      });
      const confirmation = this.ports.confirmationEvent({
        sessionId: state.sessionId,
        runId: state.runId,
        requirement,
        proposal: repaired,
        originalUserRequest: input.content,
        attachments: input.attachments ?? [],
        ts: this.ports.now(),
        id: this.ports.createId('action-bundle-admission-decision'),
      });
      state.phase = 'waiting_plan_review';
      return this.ports.append(state.sessionId, [
        confirmation,
        this.ports.sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'waiting_plan_review',
          reason: 'requirement',
          decisionOwner: {
            kind: 'requirement',
            runId: state.runId,
            targetId: requirement.requirementId,
            requirementId: requirement.requirementId,
          },
          ts: this.ports.now(),
          id: this.ports.createId('session-run-waiting-action-bundle-admission-decision'),
        }),
      ]) ?? result;
    }
    if (repaired.kind === 'taskPlan' || repaired.kind === 'implementationPlan') {
      return this.ports.append(state.sessionId, [
        this.ports.finalDiagnosticEvent(
          state.sessionId,
          this.ports.diagnostic(
            'actionBundleAdmissionRepairReturnedPlan',
            'Action-bundle admission repair returned a plan proposal during execution. Session will not switch execution repair back into plan review; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
            { returnedKind: repaired.kind, proposalId: repaired.proposalId }
          ),
          this.ports.now(),
          this.ports.createId('action-bundle-admission-repair-plan-forbidden')
        ),
      ]) ?? result;
    }
    if (repaired.kind === 'answer') {
      return this.ports.append(state.sessionId, [
        this.ports.answerEvent(state.sessionId, repaired, this.ports.now(), this.ports.createId('answer')),
      ]) ?? result;
    }
    if (repaired.kind === 'diagnostic') {
      return this.ports.append(state.sessionId, [
        this.ports.finalDiagnosticEvent(
          state.sessionId,
          this.ports.diagnosticSummary(repaired),
          this.ports.now(),
          this.ports.createId('action-bundle-admission-diagnostic')
        ),
      ]) ?? result;
    }
    return this.ports.submitNonExecutableProposal(state, repaired, result);
  }
}
