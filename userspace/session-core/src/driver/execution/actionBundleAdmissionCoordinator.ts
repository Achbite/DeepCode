import type { AgentContextAttachment, AgentEvent, AgentSessionResult } from '@deepcode/protocol';
import type { ProposalEnvelope, ResourceRequestDraft } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { RequirementRecord } from '../../requirement/types.js';
import type { ProposalRouterResult } from '../proposal/proposalRouter.js';
import { SessionDriverRepairRuntimeAccessor } from '../runFrame.js';
import type { AcceptedTaskPlanContext } from '../../accepted-plan/types.js';
import { finalSettlementEvidenceMetadata } from '../authority/finalSettlementEvidence.js';
import {
  conversationPresentationLanguageBinding,
  localizedProjectionText,
  type ConversationPresentationLanguageState,
  type ProjectionLanguageBinding,
} from '../projection/index.js';

export interface ActionBundleAdmissionCoordinatorInput {
  sessionId: string;
  content: string;
  attachments?: AgentContextAttachment[];
}

export interface ActionBundleAdmissionCoordinatorState extends ConversationPresentationLanguageState {
  sessionId: string;
  runId: string;
  userRequest: string;
  actionBundleAdmissionRepairAttempted: boolean;
  phase?: string;
  acceptedTaskPlan?: AcceptedTaskPlanContext;
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
    presentationBinding: ProjectionLanguageBinding;
    ts: string;
    id: string;
  }): AgentEvent;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'waiting_plan_review' | 'completed' | 'failed';
    status?: 'waiting' | 'completed' | 'failed';
    reason: 'requirement' | 'session' | 'task_diagnostic';
    decisionOwner: {
      kind: 'requirement' | 'session';
      runId: string;
      targetId: string;
      requirementId?: string;
    };
    ts: string;
    id: string;
  }): AgentEvent;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | ActionBundleAdmissionCoordinatorDiagnostic,
    ts: string,
    id: string,
    presentationBinding: ProjectionLanguageBinding
  ): AgentEvent;
  answerEvent(
    sessionId: string,
    proposal: ProposalEnvelope,
    ts: string,
    id: string,
    metadata?: Record<string, unknown>
  ): AgentEvent;
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
        presentationBinding: conversationPresentationLanguageBinding(state),
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
    if (repaired.kind === 'taskPlan') {
      const presentationBinding = conversationPresentationLanguageBinding(state);
      state.phase = 'failed';
      const diagnosticId = this.ports.createId('action-bundle-admission-repair-plan-forbidden');
      return this.ports.append(state.sessionId, [
        this.ports.finalDiagnosticEvent(
          state.sessionId,
          this.ports.diagnostic(
            'actionBundleAdmissionRepairReturnedPlan',
            localizedProjectionText(presentationBinding.language, {
              zh: 'Action-bundle 入场修复在执行阶段返回了计划提案。Session 不会把执行修复切回计划复核；请改为返回限定范围的 actionBundle、resourceRequest、decisionRequest 或 diagnostic。',
              en: 'Action-bundle admission repair returned a plan proposal during execution. Session will not switch execution repair back into plan review; request a scoped actionBundle, resourceRequest, decisionRequest, or diagnostic instead.',
              neutral: 'action_bundle_admission_repair=returned_plan execution_repair=blocked',
            }),
            { returnedKind: repaired.kind, proposalId: repaired.proposalId }
          ),
          this.ports.now(),
          diagnosticId,
          presentationBinding
        ),
        this.ports.sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'failed',
          status: 'failed',
          reason: 'task_diagnostic',
          decisionOwner: {
            kind: 'session',
            runId: state.runId,
            targetId: diagnosticId,
          },
          ts: this.ports.now(),
          id: this.ports.createId('session-run-action-bundle-repair-plan-failed'),
        }),
      ]) ?? result;
    }
    if (repaired.kind === 'answer') {
      state.phase = 'completed';
      const answerId = this.ports.createId('answer');
      return this.ports.append(state.sessionId, [
        this.ports.answerEvent(
          state.sessionId,
          repaired,
          this.ports.now(),
          answerId,
          finalSettlementEvidenceMetadata(state.acceptedTaskPlan)
        ),
        this.ports.sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'completed',
          status: 'completed',
          reason: 'session',
          decisionOwner: {
            kind: 'session',
            runId: state.runId,
            targetId: answerId,
          },
          ts: this.ports.now(),
          id: this.ports.createId('session-run-action-bundle-repair-answer-completed'),
        }),
      ]) ?? result;
    }
    if (repaired.kind === 'diagnostic') {
      const presentationBinding = conversationPresentationLanguageBinding(state);
      state.phase = 'failed';
      const diagnosticId = this.ports.createId('action-bundle-admission-diagnostic');
      return this.ports.append(state.sessionId, [
        this.ports.finalDiagnosticEvent(
          state.sessionId,
          this.ports.diagnosticSummary(repaired),
          this.ports.now(),
          diagnosticId,
          presentationBinding
        ),
        this.ports.sessionRunStateEvent({
          sessionId: state.sessionId,
          runId: state.runId,
          phase: 'failed',
          status: 'failed',
          reason: 'task_diagnostic',
          decisionOwner: {
            kind: 'session',
            runId: state.runId,
            targetId: diagnosticId,
          },
          ts: this.ports.now(),
          id: this.ports.createId('session-run-action-bundle-repair-diagnostic-failed'),
        }),
      ]) ?? result;
    }
    return this.ports.submitNonExecutableProposal(state, repaired, result);
  }
}
