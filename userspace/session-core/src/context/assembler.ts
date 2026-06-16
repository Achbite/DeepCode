import type { RequirementRecord } from '../requirement/types.js';
import { canonicalizePrompt } from '../cache/canonicalizer.js';
import { buildPromptEnvelope } from '../prompt/builder.js';
import type { PromptEnvelope, PromptEnvelopeBuilderInput } from '../prompt/types.js';
import type {
  ConversationResourceRoot,
  InitialContextPacket,
  ResourcePacket,
} from './types.js';
import {
  buildSessionMemoryDocument,
  renderSessionMemoryHints,
  type SessionMemoryDocument,
} from './memory.js';
import type { AgentEvent } from '@deepcode/protocol';

export interface PromptCachePlan {
  provider: string;
  model: string;
  templateVersion: string;
  stablePrefixHash: string;
  dynamicSuffixHash: string;
  cacheHash: string;
  auditHash: string;
  deepseekPrefixCache: {
    mode: 'automatic-prefix-cache';
    requestParameterRequired: false;
    strategy: 'maximize-identical-stable-prefix';
  };
  cacheAffectsCorrectness: false;
}

export interface ContextAssemblyResult {
  promptInput: PromptEnvelopeBuilderInput;
  prompt: PromptEnvelope;
  memoryDocument: SessionMemoryDocument;
  cachePlan: PromptCachePlan;
}

export interface ContextAssemblyInput {
  workflowState: string;
  allowedProposals: string[];
  capabilityCatalogSummary: string;
  userRequest: string;
  existingEvents?: AgentEvent[];
  initialContext?: InitialContextPacket;
  resourcePackets?: ResourcePacket[];
  readOnlyResourceBudget?: PromptEnvelopeBuilderInput['readOnlyResourceBudget'];
  conversationRoots?: ConversationResourceRoot[];
  requirement?: RequirementRecord;
  memoryDocument?: SessionMemoryDocument;
  extraMemoryHints?: string[];
  userOverlay?: string;
  profile?: {
    provider?: string;
    model?: string;
  };
  templateVersion?: string;
  auditOnly?: PromptEnvelopeBuilderInput['auditOnly'];
}

export function assembleContext(input: ContextAssemblyInput): ContextAssemblyResult {
  const memoryDocument = input.memoryDocument ?? buildSessionMemoryDocument(input.existingEvents ?? []);
  const promptInput: PromptEnvelopeBuilderInput = {
    workflowState: input.workflowState,
    allowedProposals: input.allowedProposals,
    capabilityCatalogSummary: input.capabilityCatalogSummary,
    memoryHints: [
      ...renderSessionMemoryHints(memoryDocument),
      ...(input.extraMemoryHints ?? []),
    ],
    userOverlay: input.userOverlay,
    userRequest: input.userRequest,
    initialContext: input.initialContext,
    resourcePackets: input.resourcePackets,
    readOnlyResourceBudget: input.readOnlyResourceBudget,
    conversationRoots: input.conversationRoots,
    requirement: input.requirement,
    auditOnly: input.auditOnly,
  };
  const prompt = buildPromptEnvelope(promptInput);
  const provider = input.profile?.provider ?? 'unknown';
  const model = input.profile?.model ?? 'unknown';
  const templateVersion = input.templateVersion ?? 'deepcode-session-context-v1';
  const canonical = canonicalizePrompt({
    stablePrefix: prompt.stablePrefix,
    dynamicSuffix: prompt.dynamicSuffix,
    auditOnly: prompt.auditOnlyContext,
    provider,
    model,
    templateVersion,
  });
  return {
    promptInput,
    prompt,
    memoryDocument,
    cachePlan: {
      provider,
      model,
      templateVersion,
      stablePrefixHash: canonical.stablePrefixHash,
      dynamicSuffixHash: canonical.dynamicSuffixHash,
      cacheHash: canonical.cacheHash,
      auditHash: canonical.auditHash,
      deepseekPrefixCache: {
        mode: 'automatic-prefix-cache',
        requestParameterRequired: false,
        strategy: 'maximize-identical-stable-prefix',
      },
      cacheAffectsCorrectness: false,
    },
  };
}
