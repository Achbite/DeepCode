import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProviderTurnCycleResult } from './pipelines/providerTurnCycle.js';
import type { ProposalRouterInput, ProposalRouterResult } from './proposal/proposalRouter.js';
import type {
  AcceptedPlanReviewHandoffPlan,
  AcceptedPlanReviewHandoffRunInput,
} from './review/acceptedPlanReviewHandoffCoordinator.js';
import type { RunCommand } from './runCommand.js';
import type { RunEffect } from './runEffect.js';

export interface RunEngineLifecycleResult<State> {
  readonly state: State;
  readonly lastResult: AgentSessionResult;
}

export interface RunEngineState {
  readonly sessionId: string;
  readonly runId: string;
  phase: string;
}

export interface RunEnginePorts<Input, State extends RunEngineState> {
  initialize(input: Input): Promise<RunEngineLifecycleResult<State>>;
  resume(input: Input): Promise<RunEngineLifecycleResult<State>>;
  shouldBuildRequirementConfirmation(input: Input): boolean;
  waitForRequirementDecision(input: Input, state: State): Promise<AgentSessionResult>;
  runProviderTurn(input: {
    input: Input;
    state: State;
    lastResult: AgentSessionResult;
  }): Promise<ProviderTurnCycleResult>;
  executeDirective(input: ProposalRouterInput<Input, State>): Promise<ProposalRouterResult>;
  assembleReview(
    input: AcceptedPlanReviewHandoffRunInput<AcceptedPlanReviewHandoffPlan>
  ): Promise<AgentSessionResult>;
}

// RunEngine owns command/effect transitions; all session side effects stay behind ports.
export class RunEngine<Input, State extends RunEngineState> {
  constructor(private readonly ports: RunEnginePorts<Input, State>) {}

  async run(input: Input): Promise<AgentSessionResult> {
    return this.runFromCommand(input, { kind: 'initializeRun' });
  }

  async resume(input: Input): Promise<AgentSessionResult> {
    return this.runFromCommand(input, { kind: 'resumeRun' });
  }

  private async runFromCommand(input: Input, initialCommand: RunCommand): Promise<AgentSessionResult> {
    let command: RunCommand = initialCommand;
    let state: State | undefined;
    let lastResult: AgentSessionResult | undefined;
    let pendingDirective: Extract<RunEffect<State>, { kind: 'providerDirectiveReady' }> | undefined;
    let pendingReview: Extract<RunEffect<State>, { kind: 'reviewAssemblyRequired' }> | undefined;

    while (true) {
      if (command.kind === 'initializeRun') {
        const effect: RunEffect<State> = {
          kind: 'initialized',
          ...await this.ports.initialize(input),
        };
        state = effect.state;
        lastResult = effect.lastResult;
        command = { kind: 'maybeBuildRequirementConfirmation' };
        continue;
      }

      if (command.kind === 'resumeRun') {
        const effect: RunEffect<State> = {
          kind: 'initialized',
          ...await this.ports.resume(input),
        };
        state = effect.state;
        lastResult = effect.lastResult;
        command = { kind: 'maybeBuildRequirementConfirmation' };
        continue;
      }

      if (command.kind === 'maybeBuildRequirementConfirmation') {
        if (!state || !lastResult) throw new Error('RunEngine initialized state is missing.');
        command = this.ports.shouldBuildRequirementConfirmation(input)
          ? { kind: 'waitForRequirementDecision' }
          : { kind: 'callProviderAndParse' };
        continue;
      }

      if (command.kind === 'waitForRequirementDecision') {
        if (!state) throw new Error('RunEngine requirement state is missing.');
        const effect: RunEffect<State> = {
          kind: 'requirementDecisionRequired',
          result: await this.ports.waitForRequirementDecision(input, state),
        };
        return this.terminal(effect.result);
      }

      if (command.kind === 'callProviderAndParse') {
        if (!state || !lastResult) throw new Error('RunEngine provider state is missing.');
        const cycle = await this.ports.runProviderTurn({ input, state, lastResult });
        if (cycle.kind === 'failed') {
          return this.terminal(cycle.result);
        }
        pendingDirective = {
          kind: 'providerDirectiveReady',
          prompt: cycle.prompt,
          lastResult: cycle.lastResult,
          proposal: cycle.proposal,
          directive: cycle.directive,
        };
        command = { kind: 'executeDirective' };
        continue;
      }

      if (command.kind === 'executeDirective') {
        if (!state || !pendingDirective) throw new Error('RunEngine pending directive is missing.');
        if (pendingDirective.directive.kind === 'providerResume') {
          lastResult = pendingDirective.lastResult;
          pendingDirective = undefined;
          command = { kind: 'callProviderAndParse' };
          continue;
        }
        if (!pendingDirective.proposal) throw new Error('RunEngine proposal directive is missing its proposal.');
        const handled = await this.ports.executeDirective({
          input,
          state,
          prompt: pendingDirective.prompt,
          proposal: pendingDirective.proposal,
          routed: pendingDirective.directive,
          lastResult: pendingDirective.lastResult,
        });
        const effect = this.effectFromDirective(pendingDirective, handled);
        pendingDirective = undefined;
        if (effect.kind === 'directiveReturned') {
          return this.terminal(effect.result);
        }
        if (effect.kind === 'reviewAssemblyRequired') {
          pendingReview = effect;
          command = { kind: 'assembleReview' };
          continue;
        }
        lastResult = effect.lastResult;
        command = this.nextCommandAfterDirective(effect);
        continue;
      }

      if (command.kind === 'assembleReview') {
        if (!pendingReview) throw new Error('RunEngine pending review assembly is missing.');
        const result = await this.ports.assembleReview(pendingReview.request);
        pendingReview = undefined;
        return this.terminal(result);
      }

      throw new Error('RunEngine command is not wired yet.');
    }
  }

  private effectFromDirective(
    pending: Extract<RunEffect<State>, { kind: 'providerDirectiveReady' }>,
    handled: ProposalRouterResult
  ): Extract<
    RunEffect<State>,
    { kind: 'directiveReturned' } | { kind: 'directiveContinue' } | { kind: 'reviewAssemblyRequired' }
  > {
    if (handled.kind === 'return') {
      return {
        kind: 'directiveReturned',
        result: handled.result,
        proposal: pending.proposal,
        directive: pending.directive,
      };
    }
    if (handled.kind === 'assembleReview') {
      return {
        kind: 'reviewAssemblyRequired',
        request: handled.request,
        proposal: pending.proposal,
        directive: pending.directive,
      };
    }
    if (pending.directive.kind !== 'resourceRequest' && pending.directive.kind !== 'action') {
      throw new Error(`RunEngine directive continue requires resourceRequest or action, got ${pending.directive.kind}.`);
    }
    return {
      kind: 'directiveContinue',
      lastResult: handled.lastResult,
      proposal: pending.proposal,
      directive: pending.directive,
    };
  }

  private nextCommandAfterDirective(
    _effect: Extract<RunEffect<State>, { kind: 'directiveContinue' }>
  ): RunCommand {
    return { kind: 'callProviderAndParse' };
  }

  private terminal(result: AgentSessionResult): AgentSessionResult {
    const effect: RunEffect<State> = { kind: 'terminal', result };
    return effect.result;
  }
}
