import type {
  ToolContextBundleV2,
  ToolContextGetReplyV2,
  ToolContextRefV2,
  ToolDescriptorV2,
} from '@deepcode/protocol';
import type { PromptEnvelopeBuilderInput } from '../prompt/types.js';

export interface ProviderToolContextBindingV2 {
  bundle: ToolContextBundleV2;
  contextRef: ToolContextRefV2;
  fixedPrompt: string;
  tools: readonly ToolDescriptorV2[];
}

export interface SessionToolContextStateV2 {
  bundle: ToolContextBundleV2;
  refreshRequired: boolean;
  invalidationReason?: 'kernelFact' | 'staleReply' | 'runtimeNotification';
}

export function createSessionToolContextStateV2(
  bundle: ToolContextBundleV2
): SessionToolContextStateV2 {
  assertProviderSafeToolContextV2(bundle);
  return {
    bundle,
    refreshRequired: false,
  };
}

export function requireSessionToolContextRefreshV2(
  state: SessionToolContextStateV2,
  reason: NonNullable<SessionToolContextStateV2['invalidationReason']>
): SessionToolContextStateV2 {
  return {
    ...state,
    refreshRequired: true,
    invalidationReason: reason,
  };
}

/**
 * A caller invokes this only at the next provider-turn boundary. There is no
 * timer or polling path in Session.
 */
export function applySessionToolContextReplyV2(
  state: SessionToolContextStateV2,
  reply: ToolContextGetReplyV2
): SessionToolContextStateV2 {
  if (reply.kind === 'current') {
    const current = toolContextRefV2(state.bundle);
    if (
      current.contextVersion !== reply.data.contextRef.contextVersion
      || current.catalogDigest !== reply.data.contextRef.catalogDigest
      || current.contextDigest !== reply.data.contextRef.contextDigest
    ) {
      throw new KernelToolContextError(
        'kernel_tool_context_current_ref_mismatch',
        'Kernel returned current for a different ToolContext reference.'
      );
    }
    return {
      bundle: state.bundle,
      refreshRequired: false,
    };
  }
  assertProviderSafeToolContextV2(reply.data.toolContext);
  return {
    bundle: reply.data.toolContext,
    refreshRequired: false,
  };
}

/**
 * Builds the provider binding without synthesizing, summarizing, or
 * canonicalizing any Kernel-owned tool semantics.
 */
export function providerToolContextBindingV2(
  bundle: ToolContextBundleV2
): ProviderToolContextBindingV2 {
  assertProviderSafeToolContextV2(bundle);
  return {
    bundle: cloneJson(bundle),
    contextRef: toolContextRefV2(bundle),
    fixedPrompt: bundle.fixedPrompt,
    tools: bundle.tools,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function toolContextRefV2(bundle: ToolContextBundleV2): ToolContextRefV2 {
  return {
    contextVersion: bundle.contextVersion,
    catalogDigest: bundle.catalogDigest,
    contextDigest: bundle.contextDigest,
  };
}

/**
 * The Prompt builder consumes fixedPrompt verbatim. Any caller-supplied
 * catalog summary is cleared so Session cannot publish a second, divergent
 * tool description beside the Kernel-owned block.
 */
export function withKernelToolContextV2(
  input: PromptEnvelopeBuilderInput,
  bundle: ToolContextBundleV2
): PromptEnvelopeBuilderInput {
  assertProviderSafeToolContextV2(bundle);
  const {
    toolCatalogSummary: _discardedToolCatalogSummary,
    ...withoutCallerCatalog
  } = input;
  return {
    ...withoutCallerCatalog,
    kernelToolContext: bundle,
  };
}

export function assertProviderSafeToolContextV2(
  bundle: ToolContextBundleV2
): void {
  if (!bundle.fixedPrompt.length) {
    throw new KernelToolContextError(
      'kernel_tool_context_prompt_missing',
      'Kernel ToolContext fixedPrompt must not be empty.'
    );
  }
  if (bundle.tools.some((tool) => tool.availability !== 'ready')) {
    throw new KernelToolContextError(
      'kernel_tool_context_non_ready_tool',
      'Provider ToolContext may contain only ready Kernel tools.'
    );
  }
  const toolIds = bundle.tools.map((tool) => tool.toolId);
  if (new Set(toolIds).size !== toolIds.length) {
    throw new KernelToolContextError(
      'kernel_tool_context_duplicate_tool',
      'Provider ToolContext contains duplicate tool identities.'
    );
  }
}

export class KernelToolContextError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'KernelToolContextError';
  }
}
