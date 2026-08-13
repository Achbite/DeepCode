import type {
  LlmChatMessage,
  ProviderWireToolDefinition,
  ToolDescriptorV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import type {
  SessionContextMemoryEntryV2,
  SessionContextMemoryV2,
} from './sessionMemory.js';
import {
  SESSION_CONTEXT_MEMORY_V2_SCHEMA,
} from './sessionMemory.js';
import type {
  SessionProviderContextAssemblyV2,
  SessionProviderContextSectionReceiptV2,
  SessionPlanActionCompletionOutcomeV2,
  SessionPlanActionV2,
  SessionProviderOutcomeRecordV2,
  SessionProviderTurnInputV2,
  SessionUserInputRecordV2,
} from './types.js';
import {
  SESSION_PROVIDER_CONTEXT_RECEIPT_V2_SCHEMA,
} from './types.js';
import {
  sessionPlanActionCompleteToolV2,
  sessionInterventionProposalToolV1,
  sessionPlanProposalToolV4,
} from './SessionKernelProviderAdapterV2.js';
import {
  sessionProviderToolObservationsV2,
} from './toolObservation.js';

const PROVIDER_TURN_FRAME_V1_SCHEMA =
  'deepcode.session.provider-turn-frame.v1';
const PROVIDER_TURN_PLAN_DECISION_V3_SCHEMA =
  'deepcode.session.provider-plan-decision.v3';
const PROVIDER_TURN_CURRENT_PLAN_ACTION_VIEW_V3_SCHEMA =
  'deepcode.session.provider-current-plan-action-view.v3';
const PROVIDER_TURN_REVIEW_V3_SCHEMA =
  'deepcode.session.provider-review.v3';
const PROVIDER_TURN_OUTCOMES_V3_SCHEMA =
  'deepcode.session.provider-outcomes.v3';
const PROVIDER_TURN_CONVERSATION_MEMORY_V3_SCHEMA =
  'deepcode.session.provider-conversation-memory.v3';
const TOKEN_ESTIMATOR = 'utf8-bytes-upper-bound.v2' as const;

type ProviderContextInputV2 = Omit<
  SessionProviderTurnInputV2,
  'contextAssembly' | 'signal'
> & {
  planActionSettlementOutcomes: Readonly<
    Record<string, SessionPlanActionCompletionOutcomeV2>
  >;
};

type ProviderConversationMemoryItemV2 =
  | {
      kind: 'priorSessionMessage';
      entry: SessionContextMemoryEntryV2;
    }
  | {
      kind: 'currentRunUserInput';
      input: Pick<SessionUserInputRecordV2, 'text'>;
    };

export function buildSessionProviderContextV2(
  input: ProviderContextInputV2
): SessionProviderContextAssemblyV2 {
  validateProviderProfile(input);
  if (
    input.target.kind === 'finalAnswer'
    && (
      input.purpose !== 'finalAnswer'
      || input.review?.status !== 'final'
      || input.target.inputId !== input.currentInput.inputId
      || input.target.controlEpoch !== input.controlEpoch
      || input.review.revision !== input.target.reviewRevision
      || input.review.snapshotHighWater
        !== input.target.snapshotHighWater
      || !input.review.workAuthority
      || canonicalJson(input.review.workAuthority)
        !== canonicalJson(input.target.workAuthority)
      || (
        input.target.workAuthority.kind === 'plan'
        && input.review.planRevision
          !== input.target.workAuthority.planRevision
      )
      || (
        input.target.workAuthority.kind === 'contextRead'
        && input.review.planRevision !== undefined
      )
    )
  ) {
    throw new SessionProviderContextErrorV2(
      'session_provider_final_answer_review_invalid',
      'Final-answer context requires its exact frozen Review binding.'
    );
  }
  const orchestrationContract = sessionOrchestrationContractV2();
  const contractSection = [orchestrationContract];
  const currentInput = sessionProviderTurnFrameV1(input);
  const planDecision = providerPlanDecisionContextV2(input);
  const review = providerReviewContextV3(input.review);
  const inputTokenBudget =
    input.providerProfile.contextWindowTokens
    - input.providerProfile.maxOutputTokens;
  const toolDefinitions = providerWireToolDefinitionsV2(input);
  const kernelFixedPromptSection = {
    fixedPrompt: input.toolContext.bundle.fixedPrompt,
    toolDefinitions,
  };
  const fixedPromptTokens =
    estimateTokens(input.toolContext.bundle.fixedPrompt)
    + estimateTokens(canonicalJson(toolDefinitions));
  const contractTokens = contractSection.reduce(
    (total, message) => total + estimateTokens(message),
    0
  );
  const currentTokens = estimateTokens(canonicalJson(currentInput));
  const planTokens = estimateTokens(canonicalJson(planDecision));
  const reviewTokens = estimateTokens(canonicalJson(review));
  const conversationMemoryItems = providerConversationMemoryItems(input);
  const emptyConversationMemory = conversationMemoryWithSelectedItems(
    input.sessionMemory,
    input.conversationInputOmittedCount,
    conversationMemoryItems,
    []
  );
  const emptyProviderOutcomes = providerOutcomesWithSelectedRecords(
    input.providerOutcomes,
    input.providerOutcomeOmittedCount,
    []
  );
  const emptyCanonicalFacts = toolObservationsWithSelectedFacts(
    input.kernelFacts,
    [],
    input.providerOutcomes
  );
  const emptyMemoryTokens =
    estimateTokens(canonicalJson(emptyConversationMemory));
  const emptyOutcomesTokens =
    estimateTokens(canonicalJson(emptyProviderOutcomes));
  const emptyFactsTokens =
    estimateTokens(canonicalJson(emptyCanonicalFacts));
  const requestEnvelopeTokens = estimateTokens(canonicalJson({
    messages: [
      { role: 'system', content: '' },
      { role: 'system', content: '' },
      { role: 'user', content: '' },
      { role: 'user', content: '' },
      { role: 'user', content: '' },
      { role: 'user', content: '' },
      { role: 'user', content: '' },
      { role: 'user', content: '' },
    ],
    tools: [],
  }));
  const requiredTokens =
    requestEnvelopeTokens
    + fixedPromptTokens
    + contractTokens
    + currentTokens
    + planTokens
    + reviewTokens
    + emptyMemoryTokens
    + emptyOutcomesTokens
    + emptyFactsTokens;
  if (requiredTokens > inputTokenBudget) {
    throw new SessionProviderContextErrorV2(
      'session_provider_required_context_exceeds_profile',
      'Required Provider context containers exceed the immutable Provider input budget.'
    );
  }
  const remaining = inputTokenBudget - requiredTokens;
  const memoryBudget =
    emptyMemoryTokens + Math.floor(remaining * 0.4);
  const outcomesBudget =
    emptyOutcomesTokens + Math.floor(remaining * 0.2);
  const factsBudget =
    emptyFactsTokens
    + remaining
    - (memoryBudget - emptyMemoryTokens)
    - (outcomesBudget - emptyOutcomesTokens);

  const memorySelection = selectNewestSectionWithinTokenBudget(
    conversationMemoryItems,
    memoryBudget,
    (selected) => conversationMemoryWithSelectedItems(
      input.sessionMemory,
      input.conversationInputOmittedCount,
      conversationMemoryItems,
      selected
    )
  );
  const conversationMemory = memorySelection.section;
  const outcomes = selectNewestSectionWithinTokenBudget(
    input.providerOutcomes,
    outcomesBudget,
    (selected) => providerOutcomesWithSelectedRecords(
      input.providerOutcomes,
      input.providerOutcomeOmittedCount,
      selected
    )
  );
  const facts = selectNewestSectionWithinTokenBudget(
    input.kernelFacts.facts,
    factsBudget,
    (selected) => toolObservationsWithSelectedFacts(
      input.kernelFacts,
      selected,
      input.providerOutcomes
    )
  );
  const providerOutcomes = outcomes.section;
  const canonicalFacts = facts.section;
  const messages: LlmChatMessage[] = [
    {
      role: 'system',
      content: input.toolContext.bundle.fixedPrompt,
    },
    {
      role: 'system',
      content: orchestrationContract,
    },
    {
      role: 'user',
      content: canonicalJson(conversationMemory),
    },
    {
      role: 'user',
      content: canonicalJson(planDecision),
    },
    {
      role: 'user',
      content: canonicalJson(review),
    },
    {
      role: 'user',
      content: canonicalJson(providerOutcomes),
    },
    {
      role: 'user',
      content: canonicalJson(canonicalFacts),
    },
    {
      role: 'user',
      content: canonicalJson(currentInput),
    },
  ];
  const estimatedInputTokens = estimateTokens(canonicalJson({
    messages,
    tools: toolDefinitions,
  }));
  if (estimatedInputTokens > inputTokenBudget) {
    throw new SessionProviderContextErrorV2(
      'session_provider_context_budget_exceeded',
      'Deterministic Provider context trimming did not satisfy the immutable input budget.'
    );
  }
  const sections: SessionProviderContextSectionReceiptV2[] = [
    sectionReceipt(
      'kernelFixedPrompt',
      kernelFixedPromptSection,
      1,
      1,
      fixedPromptTokens
    ),
    sectionReceipt(
      'sessionContract',
      contractSection,
      contractSection.length,
      contractSection.length,
      contractTokens
    ),
    sectionReceipt(
      'currentInput',
      currentInput,
      1,
      1,
      currentTokens
    ),
    sectionReceipt(
      'priorSessionMemory',
      conversationMemory,
      conversationMemoryItems.length,
      memorySelection.selectedCount
    ),
    sectionReceipt(
      'planDecision',
      planDecision,
      input.plan || input.planDecision ? 1 : 0,
      input.plan || input.planDecision ? 1 : 0,
      planTokens
    ),
    sectionReceipt(
      'review',
      review,
      input.review ? 1 : 0,
      input.review ? 1 : 0,
      reviewTokens
    ),
    sectionReceipt(
      'providerOutcomes',
      providerOutcomes,
      input.providerOutcomes.length,
      outcomes.selectedCount
    ),
    sectionReceipt(
      'canonicalFacts',
      canonicalFacts,
      input.kernelFacts.facts.length,
      facts.selectedCount
    ),
  ];
  return {
    messages,
    receipt: {
      schemaVersion: SESSION_PROVIDER_CONTEXT_RECEIPT_V2_SCHEMA,
      providerProfile: {
        providerProfileId:
          input.providerProfile.providerProfileId,
        providerProfileRevisionDigest:
          input.providerProfile.providerProfileRevisionDigest,
        reasoningTransport:
          input.providerProfile.reasoningTransport,
        contextWindowTokens:
          input.providerProfile.contextWindowTokens,
        maxOutputTokens:
          input.providerProfile.maxOutputTokens,
      },
      inputTokenBudget,
      estimatedInputTokens,
      memory: memoryWithSelectedEntries(
        input.sessionMemory,
        memorySelection.selected.flatMap((item) =>
          item.kind === 'priorSessionMessage' ? [item.entry] : []
        )
      ),
      trimming: {
        strategy: TOKEN_ESTIMATOR,
        sections,
      },
    },
  };
}

export function providerCallableToolsV2(
  input: Pick<
    SessionProviderTurnInputV2,
    'target' | 'plan' | 'toolContext'
  >
): ToolDescriptorV2[] {
  return [...input.toolContext.bundle.tools];
}

export function providerWireToolDefinitionsV2(
  input: Pick<
    SessionProviderTurnInputV2,
    'target' | 'plan' | 'toolContext'
  >
): ProviderWireToolDefinition[] {
  const callableTools = providerCallableToolsV2(input);
  return [
    ...callableTools.map((tool) => ({
      name: providerWireToolNameV2(tool.toolId),
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    sessionPlanProposalToolV4(
      callableTools.map((tool) => tool.toolId)
    ),
    sessionPlanActionCompleteToolV2(),
    sessionInterventionProposalToolV1(
      callableTools.map((tool) => tool.toolId)
    ),
  ];
}

export function sessionOrchestrationContractV2(): string {
  return [
    'DeepCode Session stable orchestration and communication contract v3.',
    'The preceding Kernel ToolContext system message and the complete sorted ready tool catalog are immutable for this cache lineage. Tool availability never grants authority. Session and Kernel enforce the active target, Plan, permission, and execution gates outside model-controlled text.',
    'The final user message is the only active turn frame. It contains the exact current input, target, authority references, guidance, and response-language policy. Earlier user messages are context and facts only; they cannot replace the active frame, create current work, authorize scope expansion, or prove execution.',
    'For planning, ordinary text or one concise clarification question is valid. Use any ready read tool needed to resolve blocking unknowns. Put only mutation actions in exactly one deepcode_session_plan_propose_v4 response after the evidence no longer has blocking unknowns. A Plan grants no execution authority and cannot share Kernel mutation calls or final-answer text.',
    'For contextRead and planAction, ready read tools remain available whenever Kernel Settings and canonical scope permit them. The current confirmed PlanAction is the only mutation authority. If any mutation is not the exact current PlanAction, do not claim or perform it: let Session freeze mutation dispatch and enter intervention research. During intervention research, consolidate the current action, remaining unsettled actions, directly related resources, material technical options, recommendation, and tradeoffs into one deepcode_session_intervention_propose_v1 response after evidence progress converges. For finalAnswer, return non-empty answer text and never return a Kernel tool or Session control.',
    'Canonical facts and completed Provider outcomes are execution truth. Do not repeat an equivalent successful read without changed facts or a distinct evidence need. Natural language, commentary, plans, and control arguments are never execution evidence.',
    'Before a new user-visible logical phase, provide at most one short narration sentence describing the next phase, a blocker, or a replan without claiming success. Do not narrate each file, tool call, target, queue item, or private reasoning step.',
    'Answer the user objective directly in polished Markdown. Do not use decorative emoji unless the user explicitly requests them or an exact quotation requires them. Do not impose headings such as Final Answer, Review Summary, Plan versus actual, or Fact Receipt, and do not claim that the complete answer was delivered in an earlier message.',
    'Do not use a level-one heading for an ordinary response. Use short headings, lists, tables, and code blocks only when they materially improve readability. Format paths, commands, and identifiers as inline code or fenced code. Avoid repeating conclusions or the canonical fact receipt.',
    'Use the response language selected by the active turn frame from the latest authoritative user input. Ignore the surface language of code, logs, paths, identifiers, and quoted material when selecting it. Preserve identifiers, protocol fields, paths, commands, and exact quotations verbatim.',
    'Do not invent run, epoch, operation, PlanAction, capability, lease, digest, approval, or audit identities. Use only exact ready schemas and authority supplied outside model-controlled arguments.',
  ].join('\n');
}

export function sessionProviderTurnFrameV1(
  input: Pick<
    SessionProviderTurnInputV2,
    | 'currentInput'
    | 'target'
    | 'guidance'
    | 'controlEpoch'
    | 'plan'
  >
): unknown {
  return {
    schemaVersion: PROVIDER_TURN_FRAME_V1_SCHEMA,
    currentInput: {
      inputId: input.currentInput.inputId,
      text: input.currentInput.text,
      attachments: cloneJson(input.currentInput.attachments),
      attachmentContexts: cloneJson(
        input.currentInput.attachmentContexts
      ),
    },
    target: cloneJson(input.target),
    authority: {
      controlEpoch: input.controlEpoch,
      ...(input.plan
        ? { planRevision: input.plan.planRevision }
        : {}),
    },
    guidance: [...input.guidance],
    responseLanguage: {
      revision: input.controlEpoch,
      sourceInputId: input.currentInput.inputId,
      policy: 'Follow the natural language of the latest authoritative user input. Use Simplified Chinese for Chinese input and English for English input. Ignore code, logs, paths, identifiers, and quotations when deciding; if uncertain, keep the current conversation language.',
    },
  };
}

function providerPlanDecisionContextV2(
  input: ProviderContextInputV2
): unknown {
  const plan = input.plan;
  if (!plan || input.target.kind !== 'planAction') {
    return {
      schemaVersion: PROVIDER_TURN_PLAN_DECISION_V3_SCHEMA,
      ...(plan ? { plan: providerPlanViewV3(plan) } : {}),
      ...(input.planDecision
        ? {
            planDecision: {
              decision: input.planDecision.decision,
              ...(input.planDecision.guidance
                ? { guidance: input.planDecision.guidance }
                : {}),
            },
          }
        : {}),
    };
  }
  const currentPlanActionId = input.target.planActionId;
  const currentIndex = plan.actions.findIndex(
    (action) =>
      action.manifest.planActionId === currentPlanActionId
  );
  if (currentIndex < 0) {
    throw new SessionProviderContextErrorV2(
      'session_provider_current_plan_action_missing',
      'Provider PlanAction context requires its exact current persisted action.'
    );
  }
  return {
    schemaVersion: PROVIDER_TURN_PLAN_DECISION_V3_SCHEMA,
    plan: {
      schemaVersion: PROVIDER_TURN_CURRENT_PLAN_ACTION_VIEW_V3_SCHEMA,
      title: plan.title,
      objective: plan.objective,
      narrative: plan.narrative,
      actions: plan.actions.map((action, index) => ({
        sequence: index + 1,
        status: index === currentIndex
          ? 'current'
          : input.planActionSettlementOutcomes[
              action.manifest.planActionId
            ] ?? 'pending',
        summary: providerPlanActionSummaryV2(action),
        ...(index === currentIndex
          ? {
              executable: {
                toolId: action.manifest.toolId,
                scopeIntent: action.manifest.scopeIntent,
                deadline: action.deadline,
              },
            }
          : {}),
      })),
    },
    ...(input.planDecision
      ? {
          planDecision: {
            decision: input.planDecision.decision,
            ...(input.planDecision.guidance
              ? { guidance: input.planDecision.guidance }
              : {}),
          },
        }
      : {}),
  };
}

function providerPlanViewV3(
  plan: NonNullable<ProviderContextInputV2['plan']>
): unknown {
  return {
    title: plan.title,
    objective: plan.objective,
    narrative: plan.narrative,
    actions: plan.actions.map((action, index) => ({
      sequence: index + 1,
      summary: providerPlanActionSummaryV2(action),
    })),
  };
}

function providerReviewContextV3(
  review: ProviderContextInputV2['review']
): unknown {
  return {
    schemaVersion: PROVIDER_TURN_REVIEW_V3_SCHEMA,
    ...(review
      ? {
          review: {
            status: review.status,
            ...(review.plan
              ? {
                  plan: {
                    title: review.plan.title,
                    objective: review.plan.objective,
                    narrative: review.plan.narrative,
                  },
                }
              : {}),
            planned: review.planned.map((action, index) => ({
              sequence: index + 1,
              toolId: action.toolId,
            })),
            unexecuted: review.unexecuted.map((action, index) => ({
              sequence: index + 1,
              toolId: action.toolId,
            })),
            scopeExpansions: review.scopeExpansions.map(
              providerReviewFactViewV3
            ),
            actualEffects: review.actualEffects.map(
              providerReviewFactViewV3
            ),
            denied: review.denied.map(providerReviewFactViewV3),
            rejections: review.rejections.map(
              providerReviewFactViewV3
            ),
            completions: review.completions.map((completion) => ({
              outcome: completion.outcome,
            })),
            cleanup: review.cleanup.map(providerReviewFactViewV3),
            indeterminate: review.indeterminate.map(
              providerReviewFactViewV3
            ),
            priorEpochLateFacts: review.priorEpochLateFacts.map(
              providerReviewFactViewV3
            ),
            factCoverage: cloneJson(review.factCoverage),
            pendingCleanupCount: review.pendingCleanupCount,
          },
        }
      : {}),
  };
}

function providerReviewFactViewV3(
  fact: NonNullable<ProviderContextInputV2['review']>[
    'actualEffects'
  ][number]
): unknown {
  return {
    domain: fact.domain,
    factKind: fact.factKind,
    resourceIds: [...fact.resourceIds],
    details: cloneJson(fact.details),
  };
}

function providerPlanActionSummaryV2(
  action: SessionPlanActionV2
): string {
  const resourceCount = action.manifest.scopeIntent.kind === 'resourceScope'
    ? action.manifest.scopeIntent.data.requestedResources.length
    : 1;
  return [
    action.manifest.toolId,
    'planned operation over',
    String(resourceCount),
    action.manifest.scopeIntent.kind === 'resourceScope'
      ? resourceCount === 1
        ? 'approved resource scope'
        : 'approved resource scopes'
      : 'approved exact invocation',
  ].join(' ');
}

function memoryWithSelectedEntries(
  memory: SessionContextMemoryV2,
  selected: readonly SessionContextMemoryEntryV2[]
): SessionContextMemoryV2 {
  const withoutDigest = {
    schemaVersion: SESSION_CONTEXT_MEMORY_V2_SCHEMA,
    sessionId: memory.sessionId,
    sourceEventVersion: memory.sourceEventVersion,
    sourceEventCount: memory.sourceEventCount,
    omittedEntryCount:
      memory.omittedEntryCount
      + memory.entries.length
      - selected.length,
    truncated:
      memory.truncated || selected.length < memory.entries.length,
    entries: selected.map(cloneJson),
    ...(memory.providerConversationHead
      ? {
          providerConversationHead: cloneJson(
            memory.providerConversationHead
          ),
        }
      : {}),
  };
  return {
    ...withoutDigest,
    contextDigest: sha256Hash(canonicalJson(withoutDigest)),
  };
}

function providerConversationMemoryItems(
  input: ProviderContextInputV2
): ProviderConversationMemoryItemV2[] {
  return [
    ...input.sessionMemory.entries.map((entry) => ({
      kind: 'priorSessionMessage' as const,
      entry: cloneJson(entry),
    })),
    ...input.conversationInputs
      .filter((candidate) =>
        candidate.inputId !== input.currentInput.inputId
      )
      .map((candidate) => ({
        kind: 'currentRunUserInput' as const,
        input: {
          text: candidate.text,
        },
      })),
  ];
}

function conversationMemoryWithSelectedItems(
  priorSessionMemory: SessionContextMemoryV2,
  previouslyOmittedRunInputs: number,
  allItems: readonly ProviderConversationMemoryItemV2[],
  selectedItems: readonly ProviderConversationMemoryItemV2[]
): {
  schemaVersion:
    typeof PROVIDER_TURN_CONVERSATION_MEMORY_V3_SCHEMA;
  currentRunUserInputs: {
    omittedCount: number;
    entries: Array<{ text: string }>;
  };
  priorSessionMemory: {
    omittedEntryCount: number;
    truncated: boolean;
    entries: Array<{
      role: SessionContextMemoryEntryV2['role'];
      text: string;
      attachments: SessionContextMemoryEntryV2['attachments'];
    }>;
  };
} {
  const allRunInputs = allItems.filter(
    (item): item is Extract<
      ProviderConversationMemoryItemV2,
      { kind: 'currentRunUserInput' }
    > => item.kind === 'currentRunUserInput'
  );
  const selectedRunInputs = selectedItems.filter(
    (item): item is Extract<
      ProviderConversationMemoryItemV2,
      { kind: 'currentRunUserInput' }
    > => item.kind === 'currentRunUserInput'
  );
  const selectedPriorEntries = selectedItems
    .filter(
      (item): item is Extract<
        ProviderConversationMemoryItemV2,
        { kind: 'priorSessionMessage' }
      > => item.kind === 'priorSessionMessage'
    )
    .map((item) => item.entry);
  return {
    schemaVersion:
      PROVIDER_TURN_CONVERSATION_MEMORY_V3_SCHEMA,
    currentRunUserInputs: {
      omittedCount:
        previouslyOmittedRunInputs
        + allRunInputs.length
        - selectedRunInputs.length,
      entries: selectedRunInputs.map((item) =>
        cloneJson(item.input)
      ),
    },
    priorSessionMemory: {
      omittedEntryCount:
        priorSessionMemory.omittedEntryCount
        + priorSessionMemory.entries.length
        - selectedPriorEntries.length,
      truncated:
        priorSessionMemory.truncated
        || selectedPriorEntries.length
          < priorSessionMemory.entries.length,
      entries: selectedPriorEntries.map((entry) => ({
        role: entry.role,
        text: entry.text,
        attachments: cloneJson(entry.attachments),
      })),
    },
  };
}

function providerOutcomesWithSelectedRecords(
  allRecords: readonly SessionProviderOutcomeRecordV2[],
  previouslyOmittedCount: number,
  selected: readonly SessionProviderOutcomeRecordV2[]
): {
  schemaVersion: typeof PROVIDER_TURN_OUTCOMES_V3_SCHEMA;
  omittedCount: number;
  records: unknown[];
} {
  return {
    schemaVersion: PROVIDER_TURN_OUTCOMES_V3_SCHEMA,
    omittedCount:
      previouslyOmittedCount + allRecords.length - selected.length,
    records: selected.map(providerOutcomeViewV3),
  };
}

function providerOutcomeViewV3(
  outcome: SessionProviderOutcomeRecordV2
): unknown {
  return {
    outputKind: outcome.outputKind,
    ...(outcome.summary ? { summary: outcome.summary } : {}),
    ...(outcome.outputKind === 'toolIntent'
      ? {
          toolSettlement: {
            status: outcome.toolSettlement.status,
          },
          toolCalls: outcome.toolCalls.map((call) => ({
            ordinal: call.ordinal,
            toolId: call.toolId,
            status: call.status,
            ...(call.settlementReason
              ? { settlementReason: call.settlementReason }
              : {}),
            ...(call.rejection
              ? {
                  rejection: {
                    reason: call.rejection.reason,
                    guidance: call.rejection.guidance,
                  },
                }
              : {}),
            ...(call.correction
              ? { retryOrdinal: call.correction.retryOrdinal }
              : {}),
          })),
        }
      : {}),
  };
}

function toolObservationsWithSelectedFacts(
  facts: SessionProviderTurnInputV2['kernelFacts'],
  selected: ReadonlyArray<
    SessionProviderTurnInputV2['kernelFacts']['facts'][number]
  >,
  outcomes: readonly SessionProviderOutcomeRecordV2[]
) {
  return sessionProviderToolObservationsV2({
    facts,
    selectedFacts: selected,
    providerOutcomes: outcomes,
  });
}

function selectNewestSectionWithinTokenBudget<T, TSection>(
  values: readonly T[],
  tokenBudget: number,
  buildSection: (selected: readonly T[]) => TSection
): {
  section: TSection;
  selectedCount: number;
  selected: T[];
} {
  const selected: T[] = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const candidate = values[index]!;
    const next = [cloneJson(candidate), ...selected];
    if (
      estimateTokens(canonicalJson(buildSection(next)))
      > tokenBudget
    ) {
      break;
    }
    selected.splice(0, selected.length, ...next);
  }
  return {
    section: buildSection(selected),
    selectedCount: selected.length,
    selected,
  };
}

function sectionReceipt(
  section: SessionProviderContextSectionReceiptV2['section'],
  value: unknown,
  originalCount: number,
  selectedCount: number,
  estimatedTokens = estimateTokens(canonicalJson(value))
): SessionProviderContextSectionReceiptV2 {
  return {
    section,
    estimatedTokens,
    originalCount,
    selectedCount,
    omittedCount: originalCount - selectedCount,
    digest: sha256Hash(
      typeof value === 'string' ? value : canonicalJson(value)
    ),
  };
}

function validateProviderProfile(
  input: ProviderContextInputV2
): void {
  const profile = input.providerProfile;
  if (
    profile.schemaVersion
      !== 'deepcode.host.provider-profile-bootstrap.v2'
    || !Number.isSafeInteger(profile.contextWindowTokens)
    || profile.contextWindowTokens <= 0
    || !Number.isSafeInteger(profile.maxOutputTokens)
    || profile.maxOutputTokens <= 0
    || profile.maxOutputTokens >= profile.contextWindowTokens
  ) {
    throw new SessionProviderContextErrorV2(
      'session_provider_profile_budget_invalid',
      'Provider profile bootstrap has invalid immutable token limits.'
    );
  }
}

function estimateTokens(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SessionProviderContextErrorV2 extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionProviderContextErrorV2';
  }
}

export function providerWireToolNameV2(toolId: string): string {
  const bytes = new TextEncoder().encode(toolId);
  return `dcv2_${[...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}
