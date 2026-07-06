import type {
  AgentEvent,
  AgentSessionResult,
  LlmChatRequest,
} from '@deepcode/protocol';
import type { ProposalEnvelope } from '../../protocol/types.js';
import type { PromptEnvelope } from '../../prompt/types.js';
import type { DriverProviderTurnFrame } from '../runFrame.js';

export interface ProviderProposalParseError {
  code: string;
  message: string;
}

export interface ProviderProposalCoordinatorInput {
  profileId?: string;
}

export interface ProviderProposalCoordinatorState {
  sessionId: string;
  runId: string;
  acceptedImplementationPlan?: unknown;
  providerTurnFrame?: DriverProviderTurnFrame;
}

export interface ProviderProposalCoordinatorPorts<
  Input extends ProviderProposalCoordinatorInput,
  State extends ProviderProposalCoordinatorState,
> {
  append(sessionId: string, events: AgentEvent[]): Promise<AgentSessionResult>;
  createId(prefix: string): string;
  now(): string;
  thinkingEvent(sessionId: string, content: string, ts: string, id: string): AgentEvent;
  providerResult(input: Input, state: State, prompt: PromptEnvelope, contract: DriverProviderTurnFrame): Promise<string | ProposalEnvelope>;
  runRepair(input: Input, state: State, stage: string, messages: LlmChatRequest['messages']): Promise<string>;
  repairMessageState(state: State): unknown;
  repairMessages(
    prompt: PromptEnvelope,
    state: unknown,
    raw: string,
    error: ProviderProposalParseError
  ): LlmChatRequest['messages'];
  actionBundleCompactionRepairMessages(
    prompt: PromptEnvelope,
    state: unknown,
    reason: string,
    raw: string
  ): LlmChatRequest['messages'];
  repairAllowedKinds(input: {
    acceptedPlanActive: boolean;
    errorCode: string;
  }): string[];
  parseProposal(input: {
    raw: string;
    state: State;
    allowBriefActionBundleUserPlan: boolean;
  }): ProposalEnvelope;
  parseRepairedProposal(input: {
    raw: string;
    state: State;
    allowedKinds: string[];
    allowBriefActionBundleUserPlan: boolean;
  }): ProposalEnvelope;
  shouldAttemptActionBundleCompactionRepair(state: State): boolean;
  normalizeParseError(error: unknown): ProviderProposalParseError;
  createError(code: string, message: string): Error;
  isDriverErrorCode(error: unknown, code: string): boolean;
}

export class ProviderProposalCoordinator<
  Input extends ProviderProposalCoordinatorInput,
  State extends ProviderProposalCoordinatorState,
> {
  constructor(private readonly ports: ProviderProposalCoordinatorPorts<Input, State>) {}

  async callAndParse(input: Input, state: State, prompt: PromptEnvelope): Promise<ProposalEnvelope> {
    let raw: string;
    try {
      const contract = state.providerTurnFrame;
      if (!contract) {
        throw this.ports.createError(
          'provider_turn_contract_missing',
          'Provider turn contract is required before calling the provider.'
        );
      }
      const providerResult = await this.ports.providerResult(input, state, prompt, contract);
      if (typeof providerResult !== 'string') return providerResult;
      raw = providerResult;
    } catch (error) {
      if (this.ports.isDriverErrorCode(error, 'llm_empty_response')) {
        return this.repairEmptyResponse(input, state, prompt);
      }
      throw error;
    }
    try {
      return this.ports.parseProposal({
        raw,
        state,
        allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
      });
    } catch (error) {
      return this.repairParseFailure(input, state, prompt, raw, this.ports.normalizeParseError(error));
    }
  }

  private async repairEmptyResponse(
    input: Input,
    state: State,
    prompt: PromptEnvelope
  ): Promise<ProposalEnvelope> {
    const parseError = {
      code: 'llm_empty_response',
      message: 'LLM provider returned an empty response before emitting a JSON proposal.',
    };
    if (!this.ports.shouldAttemptActionBundleCompactionRepair(state)) {
      await this.ports.append(state.sessionId, [
        this.ports.thinkingEvent(
          state.sessionId,
          `Model output requires Agent Protocol v3 repair: ${parseError.message}`,
          this.ports.now(),
          this.ports.createId('protocol-repair')
        ),
      ]);
      const repairedRaw = await this.ports.runRepair(
        input,
        state,
        'protocol_repair',
        this.ports.repairMessages(prompt, this.ports.repairMessageState(state), '', parseError)
      );
      try {
        return this.ports.parseRepairedProposal({
          raw: repairedRaw,
          state,
          allowedKinds: this.ports.repairAllowedKinds({
            acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
            errorCode: 'llm_empty_response',
          }),
          allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
        });
      } catch (repairError) {
        throw this.ports.createError(
          'agent_protocol_repair_failed',
          `Empty model response still could not be parsed after repair: ${this.ports.normalizeParseError(repairError).message}`
        );
      }
    }
    await this.ports.append(state.sessionId, [
      this.ports.thinkingEvent(
        state.sessionId,
        'The model did not return valid JSON; Session is asking it to narrow the response to the next reviewable actionBundle.',
        this.ports.now(),
        this.ports.createId('action-bundle-compaction-repair')
      ),
    ]);
    const repairedRaw = await this.ports.runRepair(
      input,
      state,
      'action_bundle_compaction_repair',
      this.ports.actionBundleCompactionRepairMessages(prompt, this.ports.repairMessageState(state), parseError.message, '')
    );
    try {
      return this.ports.parseRepairedProposal({
        raw: repairedRaw,
        state,
        allowedKinds: ['actionBundle', 'resourceRequest', 'decisionRequest', 'diagnostic'],
        allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
      });
    } catch (repairError) {
      throw this.ports.createError(
        'agent_protocol_repair_failed',
        `Empty model response still could not be parsed after repair: ${this.ports.normalizeParseError(repairError).message}`
      );
    }
  }

  private async repairParseFailure(
    input: Input,
    state: State,
    prompt: PromptEnvelope,
    raw: string,
    parseError: ProviderProposalParseError
  ): Promise<ProposalEnvelope> {
    await this.ports.append(state.sessionId, [
      this.ports.thinkingEvent(
        state.sessionId,
        `Model output requires Agent Protocol v3 repair: ${parseError.message}`,
        this.ports.now(),
        this.ports.createId('protocol-repair')
      ),
    ]);
    const repairStage = parseError.code === 'action_bundle_budget_exceeded'
      ? 'action_bundle_budget_repair'
      : 'protocol_repair';
    const repairPrompt = parseError.code === 'action_bundle_budget_exceeded'
      ? this.ports.actionBundleCompactionRepairMessages(prompt, this.ports.repairMessageState(state), parseError.message, raw)
      : this.ports.repairMessages(prompt, this.ports.repairMessageState(state), raw, parseError);
    const repairedRaw = await this.ports.runRepair(input, state, repairStage, repairPrompt);
    try {
      return this.ports.parseRepairedProposal({
        raw: repairedRaw,
        state,
        allowedKinds: this.ports.repairAllowedKinds({
          acceptedPlanActive: Boolean(state.acceptedImplementationPlan),
          errorCode: parseError.code,
        }),
        allowBriefActionBundleUserPlan: Boolean(state.acceptedImplementationPlan),
      });
    } catch (repairError) {
      throw this.ports.createError(
        'agent_protocol_repair_failed',
        `Model output still does not satisfy Agent Protocol v3 after repair: ${this.ports.normalizeParseError(repairError).message}`
      );
    }
  }
}
