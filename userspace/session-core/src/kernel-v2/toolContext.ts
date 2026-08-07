import {
  KERNEL_TOOL_CONTEXT_V2_FORMAT,
  type ToolContextBundleV2,
  type ToolContextGetReplyV2,
  type ToolContextRefV2,
  type ToolDescriptorV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';

const KERNEL_TOOL_PROMPT_V2 =
  'The Kernel is the sole authority for the tools listed below. Call only a tool present in this context and provide one JSON object matching its input schema. Tool arguments are untrusted intent: the Kernel resolves resources, checks the active capability and current tool availability, and records execution facts. Never claim that a tool ran from narration alone. Treat an awaiting-capability, denied, stale-context, failed, cancelled, or indeterminate result as non-success.';
const KERNEL_TOOL_PROMPT_SECTION_V2 =
  '\n\nKernel-owned tool contracts follow in ascending ToolId order. Each canonical InputSchema is available for planning, but only tools separately exposed by the current Provider callable-tool channel may be invoked. A planning-only schema does not grant authority or make its tool callable.';
const TOOL_CONTRACT_DIGEST_DOMAIN_V2 =
  'deepcode.kernel.tools.v2/contract';
const TOOL_CONTEXT_DIGEST_DOMAIN_V2 =
  'deepcode.kernel.tool-context.v2/bundle';

export interface SessionToolContextInvalidationV2 {
  previousContext: ToolContextRefV2;
  nextContextVersion: number;
  nextContextRef: ToolContextRefV2;
}

export interface ProviderToolContextBindingV2 {
  bundle: ToolContextBundleV2;
  contextRef: ToolContextRefV2;
  fixedPrompt: string;
  tools: readonly ToolDescriptorV2[];
}

export interface SessionToolContextStateV2 {
  bundle: ToolContextBundleV2;
  refreshRequired: boolean;
  invalidationReason?: 'kernelFact';
  expectedContextRef?: ToolContextRefV2;
}

export function createSessionToolContextStateV2(
  bundle: ToolContextBundleV2
): SessionToolContextStateV2 {
  const ownedBundle = cloneJson(bundle);
  assertProviderSafeToolContextV2(ownedBundle);
  return {
    bundle: ownedBundle,
    refreshRequired: false,
  };
}

export function recordSessionToolContextInvalidationV2(
  state: SessionToolContextStateV2,
  details: Record<string, unknown>
): SessionToolContextStateV2 {
  validateSessionToolContextStateV2(state);
  const invalidation = decodeInvalidation(details);
  const currentRef = toolContextRefV2(state.bundle);
  if (
    invalidation.previousContext.catalogDigest
      !== currentRef.catalogDigest
    || invalidation.nextContextRef.catalogDigest
      !== currentRef.catalogDigest
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_invalidation_catalog_mismatch',
      'Kernel context invalidation cannot change the active compile-time tool catalog.'
    );
  }
  const anchorRef = state.expectedContextRef ?? currentRef;
  const nextRef = invalidation.nextContextRef;

  if (nextRef.contextVersion < anchorRef.contextVersion) {
    return cloneState(state);
  }
  if (nextRef.contextVersion === anchorRef.contextVersion) {
    if (!sameContextRef(nextRef, anchorRef)) {
      throw new KernelToolContextError(
        'kernel_tool_context_invalidation_ref_conflict',
        'Kernel context invalidation conflicts with the current expected ToolContext reference.'
      );
    }
    return cloneState(state);
  }
  if (
    nextRef.contextVersion !== anchorRef.contextVersion + 1
    || !sameContextRef(invalidation.previousContext, anchorRef)
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_invalidation_chain_invalid',
      'Kernel context invalidation does not immediately continue the current ToolContext reference.'
    );
  }
  return {
    bundle: cloneJson(state.bundle),
    refreshRequired: true,
    invalidationReason: 'kernelFact',
    expectedContextRef: cloneJson(nextRef),
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
  validateSessionToolContextStateV2(state);
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
    if (state.refreshRequired || state.expectedContextRef) {
      throw new KernelToolContextError(
        'kernel_tool_context_refresh_current_conflict',
        'Kernel returned the previous ToolContext after canonical invalidation required an updated bundle.'
      );
    }
    return {
      bundle: cloneJson(state.bundle),
      refreshRequired: false,
    };
  }
  const updated = cloneJson(reply.data.toolContext);
  assertProviderSafeToolContextV2(updated);
  assertUpdatedContext(state, updated);
  return {
    bundle: updated,
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
  const ownedBundle = cloneJson(bundle);
  assertProviderSafeToolContextV2(ownedBundle);
  return {
    bundle: ownedBundle,
    contextRef: toolContextRefV2(ownedBundle),
    fixedPrompt: ownedBundle.fixedPrompt,
    tools: ownedBundle.tools,
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

export function assertProviderSafeToolContextV2(
  bundle: ToolContextBundleV2
): void {
  if (
    bundle.formatVersion !== KERNEL_TOOL_CONTEXT_V2_FORMAT
    || !Number.isSafeInteger(bundle.contextVersion)
    || bundle.contextVersion < 1
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_identity_invalid',
      'Kernel ToolContext format and version must be valid.'
    );
  }
  assertDigest(bundle.catalogDigest, 'catalogDigest');
  assertDigest(bundle.contextDigest, 'contextDigest');
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
  let previousToolId = '';
  for (const tool of bundle.tools) {
    if (tool.toolId <= previousToolId) {
      throw new KernelToolContextError(
        'kernel_tool_context_tool_order_invalid',
        'Provider ToolContext tools must be strictly ordered by unique ToolId.'
      );
    }
    assertToolContractDigest(tool);
    previousToolId = tool.toolId;
  }
  const expectedPrompt = renderKernelToolPromptV2(bundle.tools);
  if (bundle.fixedPrompt !== expectedPrompt) {
    throw new KernelToolContextError(
      'kernel_tool_context_prompt_mismatch',
      'Kernel ToolContext fixedPrompt does not match its ready tool descriptors.'
    );
  }
  const expectedContextDigest = typedDigest(
    TOOL_CONTEXT_DIGEST_DOMAIN_V2,
    {
      formatVersion: KERNEL_TOOL_CONTEXT_V2_FORMAT,
      contextVersion: bundle.contextVersion,
      catalogDigest: bundle.catalogDigest,
      fixedPrompt: bundle.fixedPrompt,
      tools: bundle.tools.map((tool) => ({
        toolId: tool.toolId,
        contractDigest: tool.contractDigest,
      })),
    }
  );
  if (bundle.contextDigest !== expectedContextDigest) {
    throw new KernelToolContextError(
      'kernel_tool_context_digest_mismatch',
      'Kernel ToolContext contextDigest does not match its immutable content.'
    );
  }
}

export function validateSessionToolContextStateV2(
  state: SessionToolContextStateV2
): void {
  if (!state || typeof state !== 'object') {
    throw new KernelToolContextError(
      'kernel_tool_context_state_invalid',
      'Session ToolContext state is invalid.'
    );
  }
  assertProviderSafeToolContextV2(state.bundle);
  if (typeof state.refreshRequired !== 'boolean') {
    throw new KernelToolContextError(
      'kernel_tool_context_refresh_state_invalid',
      'Session ToolContext refresh state is invalid.'
    );
  }
  if (
    state.invalidationReason !== undefined
    && state.invalidationReason !== 'kernelFact'
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_refresh_reason_invalid',
      'Session ToolContext invalidation reason is invalid.'
    );
  }
  if (!state.refreshRequired) {
    if (state.invalidationReason || state.expectedContextRef) {
      throw new KernelToolContextError(
        'kernel_tool_context_refresh_state_invalid',
        'A current Session ToolContext cannot retain invalidation state.'
      );
    }
    return;
  }
  if (state.invalidationReason !== 'kernelFact') {
    throw new KernelToolContextError(
      'kernel_tool_context_refresh_reason_missing',
      'A pending ToolContext refresh requires a canonical invalidation fact.'
    );
  }
  if (!state.expectedContextRef) {
    throw new KernelToolContextError(
      'kernel_tool_context_expected_ref_missing',
      'Canonical invalidation requires an exact next ToolContext reference.'
    );
  }
  assertContextRef(state.expectedContextRef, 'expectedContextRef');
  if (
    state.expectedContextRef.catalogDigest
      !== state.bundle.catalogDigest
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_refresh_catalog_mismatch',
      'Pending ToolContext refresh cannot change the active compile-time tool catalog.'
    );
  }
  if (
    state.expectedContextRef.contextVersion
      <= state.bundle.contextVersion
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_expected_ref_stale',
      'Expected ToolContext must advance the active context version.'
    );
  }
}

function assertUpdatedContext(
  state: SessionToolContextStateV2,
  updated: ToolContextBundleV2
): void {
  const previous = state.bundle;
  const updatedRef = toolContextRefV2(updated);
  if (updated.catalogDigest !== previous.catalogDigest) {
    throw new KernelToolContextError(
      'kernel_tool_context_updated_catalog_mismatch',
      'Updated ToolContext cannot change the active compile-time tool catalog.'
    );
  }
  if (
    state.expectedContextRef
    && !sameContextRef(updatedRef, state.expectedContextRef)
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_updated_ref_mismatch',
      'Updated ToolContext does not match the exact reference recorded by canonical invalidation.'
    );
  }
  if (updated.contextVersion <= previous.contextVersion) {
    throw new KernelToolContextError(
      'kernel_tool_context_version_not_advanced',
      'Updated ToolContext must advance the context version.'
    );
  }
  const previousById = new Map(
    previous.tools.map((tool) => [tool.toolId, tool])
  );
  for (const tool of updated.tools) {
    const prior = previousById.get(tool.toolId);
    if (!prior || canonicalJson(prior) !== canonicalJson(tool)) {
      throw new KernelToolContextError(
        'kernel_tool_context_runtime_expansion_forbidden',
        'Runtime ToolContext updates may only retain unchanged descriptors from the previous ready set.'
      );
    }
  }
}

function decodeInvalidation(
  details: Record<string, unknown>
): SessionToolContextInvalidationV2 {
  const previousContext = decodeContextRef(
    details.previousContext,
    'previousContext'
  );
  const nextContextRef = decodeContextRef(
    details.nextContextRef,
    'nextContextRef'
  );
  const nextContextVersion = details.nextContextVersion;
  if (
    !Number.isSafeInteger(nextContextVersion)
    || (nextContextVersion as number) < 1
    || nextContextVersion !== nextContextRef.contextVersion
    || nextContextRef.contextVersion
      !== previousContext.contextVersion + 1
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_invalidation_version_invalid',
      'Kernel context invalidation must advance exactly one context version.'
    );
  }
  return {
    previousContext,
    nextContextVersion: nextContextVersion as number,
    nextContextRef,
  };
}

function decodeContextRef(
  value: unknown,
  field: string
): ToolContextRefV2 {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_invalidation_ref_invalid',
      `Kernel context invalidation ${field} is invalid.`
    );
  }
  const data = value as Record<string, unknown>;
  const contextVersion = data.contextVersion;
  const catalogDigest = data.catalogDigest;
  const contextDigest = data.contextDigest;
  if (
    !Number.isSafeInteger(contextVersion)
    || (contextVersion as number) < 1
    || typeof catalogDigest !== 'string'
    || typeof contextDigest !== 'string'
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_invalidation_ref_invalid',
      `Kernel context invalidation ${field} is invalid.`
    );
  }
  assertDigest(catalogDigest, `${field}.catalogDigest`);
  assertDigest(contextDigest, `${field}.contextDigest`);
  return {
    contextVersion: contextVersion as number,
    catalogDigest,
    contextDigest,
  };
}

function assertContextRef(
  ref: ToolContextRefV2,
  field: string
): void {
  if (
    !Number.isSafeInteger(ref.contextVersion)
    || ref.contextVersion < 1
  ) {
    throw new KernelToolContextError(
      'kernel_tool_context_ref_invalid',
      `${field} has an invalid context version.`
    );
  }
  assertDigest(ref.catalogDigest, `${field}.catalogDigest`);
  assertDigest(ref.contextDigest, `${field}.contextDigest`);
}

function sameContextRef(
  left: ToolContextRefV2,
  right: ToolContextRefV2
): boolean {
  return left.contextVersion === right.contextVersion
    && left.catalogDigest === right.catalogDigest
    && left.contextDigest === right.contextDigest;
}

function assertToolContractDigest(tool: ToolDescriptorV2): void {
  const expected = typedDigest(TOOL_CONTRACT_DIGEST_DOMAIN_V2, {
    toolId: tool.toolId,
    description: tool.description,
    inputSchema: tool.inputSchema,
    promptTemplate: tool.promptTemplate,
    availability: tool.availability,
    effectClass: tool.effectClass,
    effectScope: tool.effectScope,
    risk: tool.risk,
    authorizationShape: tool.authorizationShape,
  });
  if (tool.contractDigest !== expected) {
    throw new KernelToolContextError(
      'kernel_tool_context_contract_digest_mismatch',
      `Kernel tool ${tool.toolId} contractDigest does not match its descriptor.`
    );
  }
}

function renderKernelToolPromptV2(
  tools: readonly ToolDescriptorV2[]
): string {
  let prompt = KERNEL_TOOL_PROMPT_V2 + KERNEL_TOOL_PROMPT_SECTION_V2;
  for (const tool of tools) {
    prompt += `\n\nToolId: ${tool.toolId}`;
    prompt += `\nDescription: ${tool.description}`;
    prompt += `\nInputSchema: ${canonicalJson(tool.inputSchema)}`;
    prompt += `\nAuthorizationShape: ${tool.authorizationShape}`;
    prompt += `\nInstruction: ${tool.promptTemplate}`;
  }
  return prompt;
}

function typedDigest(domain: string, value: unknown): string {
  return sha256Hash(`${domain}\0${canonicalJson(value)}`);
}

function assertDigest(value: string, field: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new KernelToolContextError(
      'kernel_tool_context_digest_invalid',
      `${field} must be a lowercase SHA-256 digest.`
    );
  }
}

function cloneState(
  state: SessionToolContextStateV2
): SessionToolContextStateV2 {
  return cloneJson(state);
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
