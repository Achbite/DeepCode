import type {
  ContextCompositionCategoryKind,
  KernelPort,
  ModelMessage,
  ProviderPort,
  SessionEvent,
  ToolDescriptor,
  WorkspaceBindingDisplay,
} from '@deepcode/protocol';

export interface ContextMessageContribution {
  contributionId: string;
  category: Exclude<ContextCompositionCategoryKind, 'messageAttachments' | 'tools'>;
  label: string;
  message: ModelMessage;
}

export interface InstructionContribution {
  id: string;
  text: string;
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
  instructions?: readonly InstructionContribution[];
  contextProviders?: readonly ContextProvider[];
  tools?: readonly ToolDescriptor[];
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
  instructions: readonly InstructionContribution[];
  contextProviders: readonly ContextProvider[];
  tools: readonly ToolDescriptor[];
  provider: ProviderPort;
  memory: MemoryProvider;
  observers: readonly PassiveObserver[];
  kernel: KernelPort;
  dispose(): Promise<void>;
}

export interface ComposeAgentInput {
  plugins: readonly AgentPlugin[];
  workspaceBindings: readonly WorkspaceBindingDisplay[];
  providerId: string;
  memoryId: string;
  kernel: KernelPort;
  signal: AbortSignal;
}

export async function composeAgent(
  input: ComposeAgentInput,
): Promise<AgentComposition> {
  assertUnique(input.plugins.map((plugin) => plugin.id), 'plugin');
  const contributions: PluginContribution[] = [];
  const disposers: Array<() => Promise<void>> = [];
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

  const instructions = contributions.flatMap((value) => value.instructions ?? []);
  const contextProviders = contributions.flatMap((value) => value.contextProviders ?? []);
  const tools = contributions.flatMap((value) => value.tools ?? []);
  const providers = contributions.flatMap((value) => value.providerAdapters ?? []);
  const memories = contributions.flatMap((value) => value.memoryProviders ?? []);
  const observers = contributions.flatMap((value) => value.observers ?? []);
  assertUnique(instructions.map((value) => value.id), 'instruction');
  assertUnique(contextProviders.map((value) => value.id), 'context provider');
  assertUnique(tools.map((value) => value.name), 'tool');
  assertUnique(providers.map((value) => value.id), 'Provider');
  assertUnique(memories.map((value) => value.id), 'Memory provider');
  assertUnique(observers.map((value) => value.id), 'observer');

  const provider = providers.find((value) => value.id === input.providerId)?.port;
  if (!provider) throw new Error(`provider_not_composed:${input.providerId}`);
  const memory = memories.find((value) => value.id === input.memoryId);
  if (!memory) throw new Error(`memory_not_composed:${input.memoryId}`);

  return Object.freeze({
    instructions: Object.freeze([...instructions]),
    contextProviders: Object.freeze([...contextProviders]),
    tools: Object.freeze(tools.map((tool) => Object.freeze({ ...tool }))),
    provider,
    memory,
    observers: Object.freeze([...observers]),
    kernel: input.kernel,
    async dispose(): Promise<void> {
      const errors: unknown[] = [];
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'plugin_dispose_failed');
    },
  });
}

export const completeMemoryProvider: MemoryProvider = {
  id: 'memory.complete',
  select: ({ messages }) => messages,
};

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) throw new Error(`duplicate_${label.replaceAll(' ', '_')}:${value}`);
    seen.add(value);
  }
}
