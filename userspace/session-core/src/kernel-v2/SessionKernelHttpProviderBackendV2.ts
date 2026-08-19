import type {
  DeadlineRequestV2,
  LlmChatRequest,
  RawToolArgumentsV2,
  RequestedResourceV2,
  ScopeIntentV2,
} from '@deepcode/protocol';
import { decodeRawToolArgumentsV2 } from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  providerCallableToolsV2,
  providerWireToolNameV2,
  providerWireToolDefinitionsV2,
  sessionOrchestrationContractV2,
  sessionProviderTurnFrameV1,
} from './providerContext.js';
import type {
  SessionKernelProviderBackendOutputV2,
  SessionKernelProviderBackendV2,
  SessionKernelProviderOrderedItemV2,
  SessionProviderPlanActionDraftV2,
  SessionProviderPlanDraftV2,
  SessionProviderInterventionDraftV1,
} from './SessionKernelProviderAdapterV2.js';
import {
  SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA,
  SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
  SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA,
  SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
  SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
} from './SessionKernelProviderAdapterV2.js';
import type {
  SessionPlanActionCompletionOutcomeV2,
  SessionProviderResultMetadataV2,
  SessionProviderTurnTerminalRecordV3,
  SessionProviderTurnInputV2,
} from './types.js';
import {
  boundedProviderUsageRecordV2,
  SessionKernelProviderTransportError,
} from './providerStreamV1.js';
import {
  isExactSessionProviderOutcomeRecordV2,
} from './providerToolCallQueue.js';
import {
  buildSessionProviderAdmissionSidecarV2,
  planSessionProviderCacheLaneV2,
  sessionProviderSemanticMessagesV2,
} from './providerCacheLaneV2.js';
import type {
  SessionProviderCacheLanePlanV2,
  SessionProviderCacheLaneResetReasonV1,
} from './providerCacheLaneV2.js';
import type {
  SessionKernelLlmStreamResultV2,
  SessionKernelLlmStreamToolItemV2,
  SessionKernelLlmTransportV2,
} from './providerStreamV1.js';

export {
  HttpSessionKernelLlmTransportV2,
  SessionKernelProviderTransportError,
} from './providerStreamV1.js';
export type {
  SessionKernelLlmTransportV2,
} from './providerStreamV1.js';

export type SessionKernelProviderDecodeInputV2 = Pick<
  SessionProviderTurnInputV2,
  'providerTurnId' | 'target' | 'plan' | 'toolContext'
>;

/**
 * Provider-specific wire adapter. Kernel ToolIds are reversibly encoded in
 * provider function names; the separately namespaced Session Plan proposal is
 * decoded locally and can never enter Kernel ToolIntent admission.
 */
export class HttpSessionKernelProviderBackendV2
implements SessionKernelProviderBackendV2 {
  constructor(
    private readonly transport: SessionKernelLlmTransportV2,
    private readonly profileId: string
  ) {}

  async requestTurn(
    input: SessionProviderTurnInputV2
  ): Promise<SessionKernelProviderBackendOutputV2> {
    assertProviderToolContextBindingV2(input);
    const parentCandidateId = input.structuredRepair
      ?.predecessorProviderTurnId
      ?? input.exactReplayPredecessorId
      ?? providerContinuationParentIdV2(input, this.profileId)
      ?? providerConversationHeadParentIdV2(input, this.profileId);
    const tools = providerWireToolDefinitionsV2(input);
    const predecessor = parentCandidateId
      ? await this.transport.inspectCachePredecessor(
          parentCandidateId,
          this.profileId,
          input.providerTurnId,
          input.signal
        )
      : undefined;
    let cacheLane = planSessionProviderCacheLaneV2({
      turn: input,
      fullContextMessages: input.contextAssembly.messages,
      tools,
      ...(predecessor ? { predecessor } : {}),
    });
    let semanticMessages = sessionProviderSemanticMessagesV2(
      input,
      cacheLane,
      predecessor
    );
    let request = sessionProviderRequestV1(
      input,
      this.profileId,
      tools,
      semanticMessages,
      cacheLane
    );
    let response: SessionKernelLlmStreamResultV2;
    try {
      response = await this.transport.request(
        request,
        input.signal,
        input.publicTextObserver,
        input.publicActivityObserver
      );
    } catch (error) {
      const resetReason = cacheLaneResetReasonForPreflightV1(error);
      if (
        (
          cacheLane.mode !== 'append'
          && cacheLane.mode !== 'exactReplay'
        )
        || resetReason === undefined
        || input.signal.aborted
      ) throw error;
      cacheLane = planSessionProviderCacheLaneV2({
        turn: input,
        fullContextMessages: input.contextAssembly.messages,
        tools,
        ...(predecessor ? { predecessor } : {}),
        forcedResetReason: resetReason,
      });
      semanticMessages = sessionProviderSemanticMessagesV2(
        input,
        cacheLane,
        predecessor
      );
      request = sessionProviderRequestV1(
        input,
        this.profileId,
        tools,
        semanticMessages,
        cacheLane
      );
      response = await this.transport.request(
        request,
        input.signal,
        input.publicTextObserver,
        input.publicActivityObserver
      );
    }
    return decodeSessionKernelLlmStreamResultV2(
      input,
      response,
      this.profileId
    );
  }
}

function sessionProviderRequestV1(
  input: SessionProviderTurnInputV2,
  profileId: string,
  tools: ReturnType<typeof providerWireToolDefinitionsV2>,
  semanticMessages: LlmChatRequest['messages'],
  cacheLane: SessionProviderCacheLanePlanV2
): LlmChatRequest {
  const sidecar = buildSessionProviderAdmissionSidecarV2({
    turn: input,
    semanticMessages,
    fullContextMessages: input.contextAssembly.messages,
    tools,
    cacheLane,
  });
  return {
    requestId: input.providerTurnId,
    ...(cacheLane.predecessorRequestId
      ? { parentRequestId: cacheLane.predecessorRequestId }
      : {}),
    profileId,
    stream: true,
    messages: semanticMessages,
    tools,
    providerOptions: {
      deepcode: {
        sessionKernelV2: sidecar,
      },
    },
  };
}

function providerContinuationParentIdV2(
  input: SessionProviderTurnInputV2,
  expectedProfileId: string
): string | undefined {
  if (
    (input.purpose !== 'continuation' && input.purpose !== 'finalAnswer')
    || input.structuredRepair
    || input.providerProfile.reasoningTransport !== 'openaiPlaintext'
  ) return undefined;
  const previous = input.providerOutcomes.at(-1);
  if (
    input.providerProfile.providerProfileId !== expectedProfileId
    || !isExactSessionProviderOutcomeRecordV2(
      previous,
      expectedProfileId
    )
    || previous.providerResult.providerProfileId
      !== input.providerProfile.providerProfileId
  ) {
    return undefined;
  }
  if (
    previous.outputKind === 'plan'
    || previous.outputKind === 'planEvidenceRefresh'
    || previous.outputKind === 'planActionComplete'
    || previous.outputKind === 'intervention'
  ) {
    const settlement = input.pendingProviderControlSettlement;
    if (
      !settlement
      || settlement.predecessorProviderTurnId !== previous.providerTurnId
      || settlement.runId !== input.runId
      || settlement.inputId !== input.currentInput.inputId
      || settlement.controlEpoch !== input.controlEpoch
      || settlement.nextTargetKind !== input.target.kind
    ) {
      throw new Error(
        'Session control continuation is missing its exact durable settlement.'
      );
    }
    return previous.providerTurnId;
  }
  if (
    input.purpose !== 'continuation'
    || input.pendingProviderControlSettlement !== undefined
    || previous.outputKind !== 'toolIntent'
    || previous.toolCallReceipt.providerTurnId
      !== previous.providerTurnId
    || previous.toolCallReceipt.callCount <= 0
    || previous.toolCalls.length !== previous.toolCallReceipt.callCount
    || previous.toolCalls.some((call, index) =>
      call.ordinal !== index + 1
    )
    || (
      previous.toolSettlement.status === 'completed'
      && previous.toolCalls.some((call) => call.status !== 'completed')
    )
    || (
      previous.toolSettlement.status === 'aborted'
      && previous.toolCalls.every((call) => call.status === 'completed')
    )
  ) {
    return undefined;
  }
  return previous.providerTurnId;
}

function providerConversationHeadParentIdV2(
  input: SessionProviderTurnInputV2,
  expectedProfileId: string
): string | undefined {
  const head = input.sessionMemory.providerConversationHead;
  if (
    input.purpose !== 'primary'
    || input.exactReplayPredecessorId
    || !head
    || input.providerProfile.reasoningTransport !== 'openaiPlaintext'
    || input.providerProfile.providerProfileId !== expectedProfileId
    || head.sessionId !== input.sessionMemory.sessionId
    || head.providerProfileId !== expectedProfileId
  ) return undefined;
  return head.providerTurnId;
}

function cacheLaneResetReasonForPreflightV1(
  error: unknown
): SessionProviderCacheLaneResetReasonV1 | undefined {
  if (!(error instanceof SessionKernelProviderTransportError)) {
    return undefined;
  }
  const reasons: Readonly<Record<
    string,
    SessionProviderCacheLaneResetReasonV1
  >> = {
    provider_cache_lane_reset_required_daemon_trace_unavailable:
      'daemonTraceUnavailable',
    provider_cache_lane_reset_required_daemon_trace_invalid:
      'daemonTraceInvalid',
    provider_cache_lane_reset_required_legacy_session_cold_start:
      'legacySessionColdStart',
    provider_cache_lane_reset_required_semantic_lane_changed:
      'semanticLaneChanged',
    provider_cache_lane_reset_required_provider_profile_changed:
      'providerProfileChanged',
    provider_cache_lane_reset_required_model_changed:
      'modelChanged',
    provider_cache_lane_reset_required_system_contract_changed:
      'systemContractChanged',
    provider_cache_lane_reset_required_tool_schema_changed:
      'toolSchemaChanged',
    provider_cache_lane_reset_required_response_format_changed:
      'responseFormatChanged',
    provider_cache_lane_reset_required_context_compaction:
      'contextCompaction',
    provider_cache_lane_exact_replay_mismatch:
      'semanticLaneChanged',
  };
  return reasons[error.code];
}

/**
 * Pure sealed-response decoder shared by the live transport and deterministic
 * recovery. It performs the same ToolContext name mapping and semantic text,
 * Plan, and tool classification without issuing a Provider request.
 */
export function decodeSessionKernelLlmStreamResultV2(
  input: SessionKernelProviderDecodeInputV2,
  response: SessionKernelLlmStreamResultV2,
  expectedProfileId: string
): SessionKernelProviderBackendOutputV2 {
    if (response.requestId !== input.providerTurnId) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_identity_mismatch',
        'Provider response identity does not match the persisted turn.'
      );
    }
    const providerResult = providerResultMetadataV2(
      response,
      expectedProfileId
    );
    const exposed = providerCallableToolsV2(input);
    const encodedNames = new Map(
      exposed.map((tool) => [
        providerWireToolNameV2(tool.toolId),
        tool.toolId,
      ])
    );
    const streamCalls = response.items.filter(
      (item): item is SessionKernelLlmStreamToolItemV2 =>
        item.kind === 'toolCall'
    );
    if (streamCalls.length > 32) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_tool_call_count_exceeded',
        'One Provider turn may return at most 32 ordered function calls.'
      );
    }
    const planProposalCalls = streamCalls.filter(
      (item) => item.name === SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME
    );
    if (planProposalCalls.length > 0) {
      if (
        input.target.kind !== 'planning'
        || planProposalCalls.length !== 1
        || streamCalls.length !== 1
      ) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_plan_proposal_conflict',
          'A Session Plan proposal must be the only control or Kernel tool in one planning response.'
        );
      }
      const control = planProposalCalls[0]!;
      const controlIndex = response.items.indexOf(control);
      const textItems = response.items.filter(
        (item): item is Extract<
          SessionKernelLlmStreamResultV2['items'][number],
          { kind: 'text' }
        > => item.kind === 'text'
      );
      if (
        response.items.slice(controlIndex + 1).some(
          (item) => item.kind === 'text'
        )
        || textItems.some((item) => item.phase === 'final_answer')
      ) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_plan_proposal_phase_conflict',
          'A Session Plan proposal may follow commentary but cannot share or precede final answer text.'
        );
      }
      const plan = normalizeProviderPlanToolIdsV2(
        decodeProviderPlanProposalArgumentsV2(control.arguments),
        encodedNames,
        new Set(exposed.map((tool) => tool.toolId))
      );
      return {
        kind: 'plan',
        plan,
        planProposal: {
          schemaVersion: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
          callId: requiredIdentity(control.callId, 'callId'),
          toolName: SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
          argumentsDigest: sha256Hash(canonicalJson(
            decodeProviderNativeArguments(control.arguments)
          )),
        },
        items: textItems.map((item) => ({
          kind: 'text',
          phase: 'commentary',
          text: item.text,
        })),
        completion: response.completion,
        providerResult,
        responseDigest: response.completion.responseDigest,
      };
    }
    const planActionCompleteCalls = streamCalls.filter(
      (item) =>
        item.name === SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME
    );
    if (planActionCompleteCalls.length > 0) {
      if (
        input.target.kind !== 'planAction'
        || planActionCompleteCalls.length !== 1
        || streamCalls.length !== 1
      ) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_plan_action_complete_conflict',
          'PlanActionComplete must be the only Session control or Kernel tool in the current PlanAction response.'
        );
      }
      const control = planActionCompleteCalls[0]!;
      const controlIndex = response.items.indexOf(control);
      const textItems = response.items.filter(
        (item): item is Extract<
          SessionKernelLlmStreamResultV2['items'][number],
          { kind: 'text' }
        > => item.kind === 'text'
      );
      if (
        response.items.slice(controlIndex + 1).some(
          (item) => item.kind === 'text'
        )
        || textItems.some((item) => item.phase === 'final_answer')
      ) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_plan_action_complete_phase_conflict',
          'PlanActionComplete may follow commentary but cannot share or precede final-answer text.'
        );
      }
      const decodedArguments = decodeProviderNativeArguments(
        control.arguments
      );
      const outcome = decodeProviderPlanActionCompleteArgumentsV2(
        decodedArguments
      );
      return {
        kind: 'planActionComplete',
        outcome,
        control: {
          schemaVersion: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA,
          callId: requiredIdentity(control.callId, 'callId'),
          toolName: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
          argumentsDigest: sha256Hash(canonicalJson(decodedArguments)),
        },
        items: textItems.map((item) => ({
          kind: 'text',
          phase: 'commentary',
          text: item.text,
        })),
        completion: response.completion,
        providerResult,
        responseDigest: response.completion.responseDigest,
      };
    }
    const interventionCalls = streamCalls.filter(
      (item) =>
        item.name === SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME
    );
    if (interventionCalls.length > 0) {
      if (
        input.target.kind !== 'interventionResearch'
        || interventionCalls.length !== 1
        || streamCalls.length !== 1
      ) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_intervention_proposal_conflict',
          'A Session intervention proposal must be the only control or Kernel tool in one intervention research response.'
        );
      }
      const control = interventionCalls[0]!;
      const controlIndex = response.items.indexOf(control);
      const textItems = response.items.filter(
        (item): item is Extract<
          SessionKernelLlmStreamResultV2['items'][number],
          { kind: 'text' }
        > => item.kind === 'text'
      );
      if (
        response.items.slice(controlIndex + 1).some(
          (item) => item.kind === 'text'
        )
        || textItems.some((item) => item.phase === 'final_answer')
      ) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_intervention_proposal_phase_conflict',
          'A Session intervention proposal may follow commentary but cannot share or precede final-answer text.'
        );
      }
      const decodedArguments = decodeProviderNativeArguments(
        control.arguments
      );
      const draft = normalizeProviderInterventionToolIdsV1(
        decodeProviderInterventionArgumentsV1(decodedArguments),
        encodedNames,
        new Set(exposed.map((tool) => tool.toolId))
      );
      return {
        kind: 'intervention',
        draft,
        control: {
          schemaVersion: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA,
          callId: requiredIdentity(control.callId, 'callId'),
          toolName: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
          argumentsDigest: sha256Hash(canonicalJson(decodedArguments)),
        },
        items: textItems.map((item) => ({
          kind: 'text',
          phase: 'commentary',
          text: item.text,
        })),
        completion: response.completion,
        providerResult,
        responseDigest: response.completion.responseDigest,
      };
    }
    let toolOrdinal = 0;
    const decodedItems: SessionKernelProviderOrderedItemV2[] =
      response.items.map((item) => {
        if (item.kind === 'text') {
          return {
            kind: 'text',
            phase: item.phase,
            text: item.text,
          };
        }
        const toolId = encodedNames.get(item.name);
        if (!toolId) {
          throw new SessionKernelProviderTransportError(
            'session_kernel_provider_tool_name_unknown',
            'Provider returned a tool name outside the current encoded ToolContext.'
          );
        }
        toolOrdinal += 1;
        return {
          kind: 'toolCall',
          source: 'providerNative',
          ordinal: toolOrdinal,
          callId: requiredIdentity(item.callId, 'callId'),
          toolName: requiredIdentity(item.name, 'toolName'),
          toolId,
          arguments: decodeProviderNativeArguments(item.arguments),
        };
      });
    const decodedCalls = decodedItems.filter(
      (item): item is Extract<
        SessionKernelProviderOrderedItemV2,
        { kind: 'toolCall' }
      > => item.kind === 'toolCall'
    );
    const responseDigest = response.completion.responseDigest;
    if (decodedCalls.length > 0) {
      return {
        kind: 'nativeToolCalls',
        calls: decodedCalls,
        items: decodedItems,
        completion: response.completion,
        providerResult,
        responseDigest,
      };
    }
    const textItems = decodedItems.filter(
      (item): item is Extract<
        SessionKernelProviderOrderedItemV2,
        { kind: 'text' }
      > => item.kind === 'text'
    );
    const firstFinalIndex = textItems.findIndex(
      (item) => item.phase === 'final_answer'
    );
    const lastCommentaryIndex = textItems.findLastIndex(
      (item) => item.phase === 'commentary'
    );
    const finalItems = firstFinalIndex >= 0
      ? textItems.slice(firstFinalIndex)
      : textItems
        .slice(lastCommentaryIndex + 1)
        .filter((item) => item.phase === 'unknown');
    if (textItems.length > 0 && finalItems.length === 0) {
      throw new SessionKernelProviderTransportError(
        'session_kernel_provider_final_answer_missing',
        'Provider response ended after commentary without final or unphased answer text.'
      );
    }
    const text = finalItems.map((item) => item.text).join('');
    if (!text.trim()) {
      return {
        kind: 'noTool',
        items: decodedItems,
        completion: response.completion,
        providerResult,
        responseDigest,
      };
    }
    return {
      kind: 'text',
      text,
      items: decodedItems,
      completion: response.completion,
      providerResult,
      responseDigest,
    };
}

function normalizeProviderPlanToolIdsV2(
  plan: SessionProviderPlanDraftV2,
  encodedNames: ReadonlyMap<string, string>,
  admittedToolIds: ReadonlySet<string>
): SessionProviderPlanDraftV2 {
  return {
    ...plan,
    actions: plan.actions.map((action) => {
      const canonicalToolId = admittedToolIds.has(action.toolId)
        ? action.toolId
        : encodedNames.get(action.toolId);
      if (!canonicalToolId || !admittedToolIds.has(canonicalToolId)) {
        throw new SessionKernelProviderTransportError(
          'session_kernel_provider_plan_tool_unknown',
          'Provider Plan referenced a tool outside the exact admitted ToolContext.'
        );
      }
      return {
        ...action,
        toolId: canonicalToolId,
      };
    }),
  };
}

function normalizeProviderInterventionToolIdsV1(
  draft: SessionProviderInterventionDraftV1,
  encodedNames: ReadonlyMap<string, string>,
  admittedToolIds: ReadonlySet<string>
): SessionProviderInterventionDraftV1 {
  return {
    ...draft,
    options: draft.options.map((option) => ({
      ...option,
      ...(option.candidatePlan
        ? {
            candidatePlan: normalizeProviderPlanToolIdsV2(
              option.candidatePlan,
              encodedNames,
              admittedToolIds
            ),
          }
        : {}),
    })),
  };
}

/**
 * Rehydrates one daemon-written completed terminal into the exact live stream
 * result shape, then routes it through the shared sealed-response decoder.
 */
export function decodeCompletedProviderTerminalV3(
  input: SessionKernelProviderDecodeInputV2,
  terminal: SessionProviderTurnTerminalRecordV3,
  expectedProfileId: string
): SessionKernelProviderBackendOutputV2 {
  const data = terminal.data;
  if (
    data.terminalKind !== 'completed'
    || data.providerTurnId !== input.providerTurnId
    || !data.completion
    || !data.providerResult
    || !data.responseDigest
    || data.completion.responseDigest !== data.responseDigest
    || data.completion.trace.terminalDigest
      !== data.traceRef.terminalDigest
    || data.completion.trace.sealDigest !== data.traceRef.sealDigest
    || data.completion.trace.recordCount !== data.traceRef.recordCount
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_terminal_evidence_invalid',
      'Completed Provider terminal cannot be reconstructed as one sealed response.'
    );
  }
  return decodeSessionKernelLlmStreamResultV2(
    input,
    {
      requestId: data.providerTurnId,
      items: cloneJson(data.orderedItems),
      ...(data.providerResult.usage
        ? { usage: cloneJson(data.providerResult.usage) }
        : {}),
      providerProfileId: data.providerResult.providerProfileId,
      provider: data.providerResult.provider,
      model: data.providerResult.model,
      completion: cloneJson(data.completion),
    },
    expectedProfileId
  );
}

function decodeProviderNativeArguments(
  value: unknown
): RawToolArgumentsV2 {
  if (typeof value !== 'string') return decodeRawToolArgumentsV2(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_tool_arguments_invalid',
      'Provider-native tool arguments are not valid JSON.'
    );
  }
  return decodeRawToolArgumentsV2(parsed);
}

function assertProviderToolContextBindingV2(
  input: SessionProviderTurnInputV2
): void {
  const bundle = input.toolContext.bundle;
  const contextRef = input.toolContext.contextRef;
  const messages = input.contextAssembly.messages;
  const systemMessages = messages.filter(
    (message) => message.role === 'system'
  );
  const finalMessage = messages.at(-1);
  if (
    input.toolContext.fixedPrompt !== bundle.fixedPrompt
    || canonicalJson(input.toolContext.tools)
      !== canonicalJson(bundle.tools)
    || contextRef.contextVersion !== bundle.contextVersion
    || contextRef.catalogDigest !== bundle.catalogDigest
    || contextRef.contextDigest !== bundle.contextDigest
    || bundle.tools.some((tool) => tool.availability !== 'ready')
    || messages.length < 3
    || systemMessages.length !== 2
    || messages[0]?.role !== 'system'
    || messages[0]?.content
      !== bundle.fixedPrompt
    || messages[1]?.role !== 'system'
    || messages[1]?.content !== sessionOrchestrationContractV2()
    || messages.slice(2).some((message) => message.role !== 'user')
    || finalMessage?.role !== 'user'
    || finalMessage.content !== canonicalJson(
      sessionProviderTurnFrameV1(input)
    )
    || input.contextAssembly.receipt.providerProfile
      .providerProfileId
      !== input.providerProfile.providerProfileId
    || input.contextAssembly.receipt.providerProfile
      .providerProfileRevisionDigest
      !== input.providerProfile.providerProfileRevisionDigest
    || input.contextAssembly.receipt.providerProfile
      .reasoningTransport
      !== input.providerProfile.reasoningTransport
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_tool_context_binding_invalid',
      'Provider ToolContext binding differs from the immutable Kernel bundle.'
    );
  }
}

export function decodeProviderPlanProposalArgumentsV2(
  value: unknown
): SessionProviderPlanDraftV2 {
  const decoded = decodeProviderNativeArguments(value);
  const record = objectRecord(decoded);
  if (!record) throw invalidPlanningResult();
  exactKeys(record, ['schemaVersion', 'plan']);
  if (record.schemaVersion !== SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA) {
    throw invalidPlanningResult();
  }
  return decodeProviderPlanDraft(record.plan);
}

export function decodeProviderPlanActionCompleteArgumentsV2(
  value: unknown
): SessionPlanActionCompletionOutcomeV2 {
  const decoded = decodeRawToolArgumentsV2(value);
  const record = objectRecord(decoded);
  if (!record) throw invalidPlanActionComplete();
  exactKeys(record, ['schemaVersion', 'outcome']);
  if (
    record.schemaVersion
      !== SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA
    || (
      record.outcome !== 'completed'
      && record.outcome !== 'no_op'
      && record.outcome !== 'blocked'
      && record.outcome !== 'skipped'
      && record.outcome !== 'unexecuted'
    )
  ) {
    throw invalidPlanActionComplete();
  }
  return record.outcome;
}

export function decodeProviderInterventionArgumentsV1(
  value: unknown
): SessionProviderInterventionDraftV1 {
  const decoded = decodeRawToolArgumentsV2(value);
  const record = objectRecord(decoded);
  if (!record) throw invalidInterventionResult();
  exactKeys(record, ['schemaVersion', 'intervention']);
  if (
    record.schemaVersion !== SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA
  ) {
    throw invalidInterventionResult();
  }
  const intervention = objectRecord(record.intervention);
  if (!intervention) throw invalidInterventionResult();
  exactKeys(
    intervention,
    ['problemSummary', 'relevantFactRefs', 'affectedPlanActionIds', 'options'],
    ['recommendation']
  );
  if (
    !Array.isArray(intervention.relevantFactRefs)
    || !Array.isArray(intervention.affectedPlanActionIds)
    || !Array.isArray(intervention.options)
    || intervention.relevantFactRefs.length > 512
    || intervention.affectedPlanActionIds.length > 256
    || intervention.options.length < 1
    || intervention.options.length > 16
  ) {
    throw invalidInterventionResult();
  }
  return {
    problemSummary: requiredText(
      intervention.problemSummary,
      'problemSummary'
    ),
    ...(intervention.recommendation !== undefined
      ? {
          recommendation: requiredText(
            intervention.recommendation,
            'recommendation'
          ),
        }
      : {}),
    relevantFactRefs: intervention.relevantFactRefs.map((factRef) =>
      requiredIdentity(factRef, 'relevantFactRef')
    ),
    affectedPlanActionIds: intervention.affectedPlanActionIds.map((actionId) =>
      requiredIdentity(actionId, 'affectedPlanActionId')
    ),
    options: intervention.options.map((value) => {
      const option = objectRecord(value);
      if (!option) throw invalidInterventionResult();
      exactKeys(
        option,
        [
          'optionId',
          'kind',
          'title',
          'description',
          'tradeoffs',
          'recommended',
        ],
        ['candidatePlan']
      );
      if (
        (option.kind !== 'executable' && option.kind !== 'guidanceOnly')
        || !Array.isArray(option.tradeoffs)
        || option.tradeoffs.length < 1
        || option.tradeoffs.length > 32
        || typeof option.recommended !== 'boolean'
        || (option.kind === 'executable') !== (option.candidatePlan !== undefined)
      ) {
        throw invalidInterventionResult();
      }
      return {
        optionId: requiredIdentity(option.optionId, 'optionId'),
        kind: option.kind,
        title: requiredText(option.title, 'option.title'),
        description: requiredText(option.description, 'option.description'),
        tradeoffs: option.tradeoffs.map((tradeoff) =>
          requiredText(tradeoff, 'option.tradeoff')
        ),
        recommended: option.recommended,
        ...(option.candidatePlan !== undefined
          ? { candidatePlan: decodeProviderPlanDraft(option.candidatePlan) }
          : {}),
      };
    }),
  };
}

function invalidInterventionResult(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_intervention_invalid',
    'Intervention proposal arguments are not one exact deepcode.session.intervention-proposal.v1 record.'
  );
}

function invalidPlanActionComplete(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_plan_action_complete_invalid',
    'PlanActionComplete must use the exact current Session control schema and one declared outcome.'
  );
}

function decodeProviderPlanDraft(
  value: unknown
): SessionProviderPlanDraftV2 {
  const record = objectRecord(value);
  if (!record) throw invalidPlanningResult();
  exactKeys(
    record,
    ['title', 'objective', 'narrative', 'evidence', 'actions']
  );
  if (!Array.isArray(record.actions)) {
    throw invalidPlanningResult();
  }
  if (record.actions.length < 1 || record.actions.length > 128) {
    throw invalidPlanningResult();
  }
  return {
    title: requiredText(record.title, 'title'),
    objective: requiredText(record.objective, 'objective'),
    narrative: requiredText(record.narrative, 'narrative'),
    evidence: decodePlanEvidenceV4(record.evidence),
    actions: record.actions.map(decodePlanAction),
  };
}

function decodePlanEvidenceV4(
  value: unknown
): SessionProviderPlanDraftV2['evidence'] {
  const record = objectRecord(value);
  if (!record) throw invalidPlanningResult();
  exactKeys(record, [
    'kernelFactRefs',
    'readResources',
    'blockingUnknowns',
    'nonBlockingUnknowns',
    'coverage',
  ]);
  if (
    !Array.isArray(record.kernelFactRefs)
    || !Array.isArray(record.readResources)
    || !Array.isArray(record.blockingUnknowns)
    || !Array.isArray(record.nonBlockingUnknowns)
    || record.kernelFactRefs.length > 512
    || record.readResources.length > 512
    || record.blockingUnknowns.length > 128
    || record.nonBlockingUnknowns.length > 128
  ) {
    throw invalidPlanningResult();
  }
  const decodeUnknown = (unknown: unknown) => {
    const item = objectRecord(unknown);
    if (!item) throw invalidPlanningResult();
    exactKeys(item, ['unknownId', 'question', 'impact']);
    return {
      unknownId: requiredIdentity(item.unknownId, 'unknownId'),
      question: requiredText(item.question, 'question'),
      impact: requiredText(item.impact, 'impact'),
    };
  };
  return {
    kernelFactRefs: record.kernelFactRefs.map((factRef) =>
      requiredIdentity(factRef, 'kernelFactRef')
    ),
    readResources: record.readResources.map((resource) => {
      const item = objectRecord(resource);
      if (!item) throw invalidPlanningResult();
      exactKeys(item, ['resourceRef', 'summary', 'factRefs']);
      if (
        !Array.isArray(item.factRefs)
        || item.factRefs.length < 1
        || item.factRefs.length > 256
      ) {
        throw invalidPlanningResult();
      }
      return {
        resourceRef: requiredIdentity(item.resourceRef, 'resourceRef'),
        summary: requiredText(item.summary, 'resourceSummary'),
        factRefs: item.factRefs.map((factRef) =>
          requiredIdentity(factRef, 'resourceFactRef')
        ),
      };
    }),
    blockingUnknowns: record.blockingUnknowns.map(decodeUnknown),
    nonBlockingUnknowns: record.nonBlockingUnknowns.map(decodeUnknown),
    coverage: requiredText(record.coverage, 'coverage'),
  };
}

function decodePlanAction(
  value: unknown
): SessionProviderPlanActionDraftV2 {
  const record = objectRecord(value);
  if (!record) throw invalidPlanningResult();
  exactKeys(
    record,
    ['toolId', 'scopeIntent'],
    ['deadline']
  );
  return {
    toolId: requiredIdentity(record.toolId, 'toolId'),
    scopeIntent: decodePlanScopeIntent(record.scopeIntent),
    ...(record.deadline !== undefined
      ? { deadline: decodeDeadline(record.deadline) }
      : {}),
  };
}

function decodePlanScopeIntent(value: unknown): ScopeIntentV2 {
  const tagged = objectRecord(value);
  if (!tagged) throw invalidPlanningResult();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanningResult();
  if (tagged.kind === 'resourceScope') {
    exactKeys(data, ['requestedResources']);
    if (!Array.isArray(data.requestedResources)) {
      throw invalidPlanningResult();
    }
    return {
      kind: tagged.kind,
      data: {
        requestedResources:
          data.requestedResources.map(decodeRequestedResource),
      },
    };
  }
  if (tagged.kind === 'exactInvocation') {
    exactKeys(data, ['rawArguments']);
    return {
      kind: tagged.kind,
      data: {
        rawArguments: decodeRawToolArgumentsV2(data.rawArguments),
      },
    };
  }
  throw invalidPlanningResult();
}

function decodeRequestedResource(value: unknown): RequestedResourceV2 {
  const tagged = objectRecord(value);
  if (!tagged) throw invalidPlanningResult();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanningResult();
  switch (tagged.kind) {
    case 'workspacePath':
      exactKeys(data, ['path', 'access']);
      if (data.access !== 'read' && data.access !== 'write') {
        throw invalidPlanningResult();
      }
      return {
        kind: tagged.kind,
        data: {
          path: requiredText(data.path, 'path'),
          access: data.access,
        },
      };
    case 'repository':
      exactKeys(data, ['area']);
      if (
        data.area !== 'state'
        && data.area !== 'index'
        && data.area !== 'history'
      ) {
        throw invalidPlanningResult();
      }
      return { kind: tagged.kind, data: { area: data.area } };
    case 'networkUrl':
      exactKeys(data, ['url']);
      return {
        kind: tagged.kind,
        data: { url: requiredText(data.url, 'url') },
      };
    case 'networkQuery':
      exactKeys(data, ['query']);
      return {
        kind: tagged.kind,
        data: { query: requiredText(data.query, 'query') },
      };
    default:
      throw invalidPlanningResult();
  }
}

function decodeDeadline(value: unknown): DeadlineRequestV2 {
  const tagged = objectRecord(value);
  if (!tagged) throw invalidPlanningResult();
  exactKeys(tagged, ['kind', 'data']);
  const data = objectRecord(tagged.data);
  if (!data) throw invalidPlanningResult();
  if (tagged.kind === 'contractDefault') {
    exactKeys(data, []);
    return { kind: tagged.kind, data: {} };
  }
  if (
    tagged.kind === 'exactMilliseconds'
    && Number.isSafeInteger(data.value)
    && Number(data.value) > 0
  ) {
    exactKeys(data, ['value']);
    return {
      kind: tagged.kind,
      data: { value: Number(data.value) },
    };
  }
  throw invalidPlanningResult();
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): void {
  const permitted = new Set([...required, ...optional]);
  if (
    required.some(
      (key) => !Object.prototype.hasOwnProperty.call(record, key)
    )
    || Object.keys(record).some((key) => !permitted.has(key))
  ) {
    throw invalidPlanningResult();
  }
}

function providerResultMetadataV2(
  result: SessionKernelLlmStreamResultV2,
  expectedProfileId: string
): SessionProviderResultMetadataV2 {
  if (
    result.providerProfileId !== undefined
    && result.providerProfileId !== expectedProfileId
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_profile_result_mismatch',
      'Provider result profile does not match the immutable Run bootstrap.'
    );
  }
  const provider = requiredMetadataIdentity(
    result.provider,
    'provider'
  );
  const model = requiredMetadataIdentity(result.model, 'model');
  const usage = result.usage === undefined
    ? undefined
    : boundedProviderUsageRecordV2(result.usage);
  return {
    providerProfileId: expectedProfileId,
    provider,
    model,
    ...(usage ? { usage } : {}),
  };
}

function requiredMetadataIdentity(
  value: unknown,
  field: string
): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 1024
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new SessionKernelProviderTransportError(
      'session_kernel_provider_result_metadata_invalid',
      `Provider result ${field} is missing or invalid.`
    );
  }
  return value;
}

function objectRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requiredIdentity(value: unknown, field: string): string {
  const text = requiredText(value, field);
  if (
    text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw invalidPlanningResult();
  }
  return text;
}

function requiredText(value: unknown, _field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || new TextEncoder().encode(value).byteLength > 64 * 1024
  ) {
    throw invalidPlanningResult();
  }
  return value;
}

function invalidPlanningResult(): SessionKernelProviderTransportError {
  return new SessionKernelProviderTransportError(
    'session_kernel_provider_plan_proposal_invalid',
    'Session Plan proposal arguments are not one exact deepcode.session.plan-proposal.v5 record.'
  );
}
