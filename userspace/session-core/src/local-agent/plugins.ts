import type {
  ContextCompositionPartitionKind,
  KernelPort,
  ModelMessage,
  ProviderPort,
  RunPreparationPort,
  SessionEvent,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';

export interface ContextMessageContribution {
  contributionId: string;
  contributionKind: Exclude<ContextCompositionPartitionKind, 'filesystemReferences' | 'tools'>;
  label: string;
  message: ModelMessage;
}

export interface ContextProvider {
  id: string;
  provide(input: {
    sessionId: string;
    events: readonly SessionEvent[];
  }): Promise<readonly ModelMessage[]> | readonly ModelMessage[];
}

export interface ProviderAdapter {
  id: string;
  port: ProviderPort;
}

export interface MemoryProvider {
  id: string;
  select(input: {
    events: readonly SessionEvent[];
    messages: readonly ContextMessageContribution[];
  }): Promise<readonly ContextMessageContribution[]> | readonly ContextMessageContribution[];
}

export interface PassiveObserver {
  id: string;
  observe(event: SessionEvent): Promise<void> | void;
}

export interface PluginContribution {
  contextProviders?: readonly ContextProvider[];
  providerAdapters?: readonly ProviderAdapter[];
  memoryProviders?: readonly MemoryProvider[];
  observers?: readonly PassiveObserver[];
}

export interface PluginSetupContext {
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  signal: AbortSignal;
}

export interface AgentPlugin {
  id: string;
  setup(
    context: PluginSetupContext,
  ):
    | PluginContribution
    | Promise<PluginContribution>
    | { contribution: PluginContribution; dispose(): Promise<void> }
    | Promise<{ contribution: PluginContribution; dispose(): Promise<void> }>;
}

export interface AgentComposition {
  contextProviders: readonly ContextProvider[];
  provider: ProviderPort;
  memory: MemoryProvider;
  observers: readonly PassiveObserver[];
  kernel: KernelPort;
  runPreparation: RunPreparationPort;
  dispose(): Promise<void>;
}

export interface ComposeAgentInput {
  plugins: readonly AgentPlugin[];
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  providerId: string;
  memoryId: string;
  kernel: KernelPort;
  runPreparation: RunPreparationPort;
  signal: AbortSignal;
}

export async function composeAgent(
  input: ComposeAgentInput,
): Promise<AgentComposition> {
  assertUnique(input.plugins.map((plugin) => plugin.id), 'plugin');
  const contributions: PluginContribution[] = [];
  const disposers: Array<() => Promise<void>> = [];
  try {
    for (const plugin of input.plugins) {
      const installed = await plugin.setup({
        workspaceBindings: input.workspaceBindings.map((binding) => Object.freeze({ ...binding })),
        signal: input.signal,
      });
      if ('contribution' in installed) {
        contributions.push(installed.contribution);
        disposers.push(() => installed.dispose());
      } else {
        contributions.push(installed);
      }
    }

    const contextProviders = contributions.flatMap((value) => value.contextProviders ?? []);
    const providers = contributions.flatMap((value) => value.providerAdapters ?? []);
    const memories = contributions.flatMap((value) => value.memoryProviders ?? []);
    const observers = contributions.flatMap((value) => value.observers ?? []);
    assertUnique(contextProviders.map((value) => value.id), 'context provider');
    assertUnique(providers.map((value) => value.id), 'Provider');
    assertUnique(memories.map((value) => value.id), 'Memory provider');
    assertUnique(observers.map((value) => value.id), 'observer');

    const provider = providers.find((value) => value.id === input.providerId)?.port;
    if (!provider) throw new Error(`provider_not_composed:${input.providerId}`);
    const memory = memories.find((value) => value.id === input.memoryId);
    if (!memory) throw new Error(`memory_not_composed:${input.memoryId}`);

    let disposed = false;
    return Object.freeze({
      contextProviders: Object.freeze([...contextProviders]),
      provider,
      memory,
      observers: Object.freeze([...observers]),
      kernel: input.kernel,
      runPreparation: input.runPreparation,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await disposePlugins(disposers);
      },
    });
  } catch (error) {
    try {
      await disposePlugins(disposers);
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        'plugin_setup_rollback_failed',
      );
    }
    throw error;
  }
}

export const completeMemoryProvider: MemoryProvider = {
  id: 'memory.complete',
  select: ({ messages }) => messages,
};

async function disposePlugins(
  disposers: readonly (() => Promise<void>)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      await disposers[index]();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'plugin_dispose_failed');
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) throw new Error(`duplicate_${label.replaceAll(' ', '_')}:${value}`);
    seen.add(value);
  }
}
