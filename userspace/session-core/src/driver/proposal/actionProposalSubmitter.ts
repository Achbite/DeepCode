import type {
  AgentEvent,
  AgentSessionResult,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import {
  normalizeProposalRouterResult,
  type ProposalRouterResult,
} from './proposalRouter.js';
import {
  conversationPresentationLanguageBinding,
  localizedProjectionText,
  type ConversationPresentationLanguageState,
  type ProjectionLanguageBinding,
} from '../projection/index.js';

export interface ActionProposalSubmitterInput {
  profileId?: string;
}

export interface ActionProposalSubmitterState extends ConversationPresentationLanguageState {
  sessionId: string;
  runId: string;
  phase: string;
  acceptedTaskPlan?: unknown;
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
  readActionBundle(proposal: ProposalEnvelope): unknown;
  submitAcceptedPlanActionProposal(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    proposal: ProposalEnvelope,
    fallback: AgentSessionResult
  ): Promise<AgentSessionResult | ProposalRouterResult>;
  finalDiagnosticEvent(
    sessionId: string,
    content: string | ActionProposalSubmitterDiagnostic,
    ts: string,
    id: string,
    presentationBinding: ProjectionLanguageBinding
  ): AgentEvent;
  sessionRunStateEvent(input: {
    sessionId: string;
    runId: string;
    phase: 'failed';
    status: 'failed';
    reason: 'task_diagnostic';
    decisionOwner: {
      kind: 'session';
      runId: string;
      targetId: string;
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
  ): Promise<ProposalRouterResult> {
    const executable = Boolean(this.ports.readActionBundle(proposal));
    if (state.acceptedTaskPlan && executable) {
      return normalizeProposalRouterResult(
        await this.ports.submitAcceptedPlanActionProposal(input, state, prompt, proposal, fallback)
      );
    }
    return {
      kind: 'return',
      result: await this.failClosed(
        state,
        'providerActionOutsideAcceptedTask',
        'Provider action directives are valid only for the active accepted task contract.'
      ),
    };
  }

  submitNonExecutable(
    state: State,
    _proposal: ProposalEnvelope,
    _fallback: AgentSessionResult
  ): Promise<AgentSessionResult> {
    return this.failClosed(
      state,
      'unsupportedProviderDirective',
      'The provider returned a directive that is not registered for the current Session profile.'
    );
  }

  private failClosed(state: State, code: string, fallback: string): Promise<AgentSessionResult> {
    const presentationBinding = conversationPresentationLanguageBinding(state);
    const localizedFallback = localizedProjectionText(presentationBinding.language, {
      zh: code === 'providerActionOutsideAcceptedTask'
        ? 'Provider 动作指令仅在当前已接受任务合同内有效；Session 已拒绝脱离合同的执行。'
        : 'Provider 返回了当前 Session profile 未注册的指令；Session 已停止处理该指令。',
      en: fallback,
      neutral: `session_directive_rejected code=${code}`,
    });
    state.phase = 'failed';
    const diagnosticId = this.ports.createId('provider-directive-rejected');
    return this.ports.append(state.sessionId, [
      this.ports.finalDiagnosticEvent(
        state.sessionId,
        this.ports.diagnostic(code, localizedFallback),
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
        id: this.ports.createId('session-run-provider-directive-rejected'),
      }),
    ]);
  }
}
