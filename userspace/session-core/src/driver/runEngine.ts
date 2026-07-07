import type { AgentSessionResult } from '@deepcode/protocol';
import type { ProviderTurnCycleResult } from './pipelines/providerTurnCycle.js';
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
  shouldBuildRequirementConfirmation(input: Input): boolean;
  waitForRequirementDecision(input: Input, state: State): Promise<AgentSessionResult>;
  runProviderTurn(input: {
    input: Input;
    state: State;
    lastResult: AgentSessionResult;
  }): Promise<ProviderTurnCycleResult>;
}

// RunEngine owns command/effect transitions; all session side effects stay behind ports.
export class RunEngine<Input, State extends RunEngineState> {
  constructor(private readonly ports: RunEnginePorts<Input, State>) {}

  async run(input: Input): Promise<AgentSessionResult> {
    return this.runFromCommand(input, { kind: 'initializeRun' });
  }

  async continueSameLoop(input: Input): Promise<AgentSessionResult> {
    return this.runFromCommand(input, { kind: 'continueSameLoop' });
  }

  private async runFromCommand(input: Input, initialCommand: RunCommand): Promise<AgentSessionResult> {
    let command: RunCommand = initialCommand;
    let state: State | undefined;
    let lastResult: AgentSessionResult | undefined;

    while (true) {
      if (command.kind === 'continueSameLoop') {
        command = this.nextCommandAfterContinuation({ kind: 'continuationEntered' });
        continue;
      }

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
        if (cycle.kind === 'return') {
          const effect: RunEffect<State> = { kind: 'providerCycleReturned', result: cycle.result };
          return this.terminal(effect.result);
        }
        const effect: RunEffect<State> = {
          kind: 'resourceRequestContinue',
          lastResult: cycle.lastResult,
          proposal: cycle.proposal,
        };
        lastResult = effect.lastResult;
        command = { kind: 'callProviderAndParse' };
        continue;
      }

      throw new Error('RunEngine command is not wired yet.');
    }
  }

  private nextCommandAfterContinuation(_effect: Extract<RunEffect<State>, { kind: 'continuationEntered' }>): RunCommand {
    return { kind: 'initializeRun' };
  }

  private terminal(result: AgentSessionResult): AgentSessionResult {
    const effect: RunEffect<State> = { kind: 'terminal', result };
    return effect.result;
  }
}
