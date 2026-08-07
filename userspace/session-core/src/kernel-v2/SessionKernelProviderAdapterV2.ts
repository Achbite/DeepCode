import {
  decodeRawToolArgumentsV2,
  type DeadlineRequestV2,
  type ProviderWireToolDefinition,
  type RawToolArgumentsV2,
  type RequestedResourceV2,
  type ScopeIntentV2,
} from '@deepcode/protocol';
import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import { createScopeManifestV2 } from './authority.js';
import type {
  SessionKernelClockPortV2,
  SessionKernelProviderPortV2,
} from './ports.js';
import type {
  SessionNaturalLanguagePlanV2,
  SessionPlanActionCompletionOutcomeV2,
  SessionProviderCompletionReceiptV1,
  SessionProviderOrderedItemV2,
  SessionProviderResultMetadataV2,
  SessionProviderToolCallReceiptV2,
  SessionProviderTurnInputV2,
  SessionProviderTurnOutputV2,
} from './types.js';
import {
  SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
} from './types.js';

export const SESSION_PROVIDER_PLAN_PROPOSAL_V3_SCHEMA =
  'deepcode.session.plan-proposal.v3' as const;
export const SESSION_PROVIDER_PLAN_PROPOSAL_V3_TOOL_NAME =
  'deepcode_session_plan_propose_v3' as const;
export const SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA =
  'deepcode.session.plan-action-complete.v2' as const;
export const SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME =
  'deepcode_session_plan_action_complete_v2' as const;

export function sessionPlanActionCompleteToolV2(): ProviderWireToolDefinition {
  return {
    name: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME,
    description: [
      'Session-only control that settles the current approved PlanAction; it never executes a Kernel tool.',
      'Call it exactly once only after the current PlanAction has reached the declared outcome.',
      'Do not combine it with a Kernel tool call, another Session control, or final-answer text.',
      'Use completed only when the approved operation is complete; use no_op, blocked, skipped, or unexecuted for the corresponding non-completion outcome.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'outcome'],
      properties: {
        schemaVersion: {
          type: 'string',
          const: SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA,
        },
        outcome: {
          type: 'string',
          enum: ['completed', 'no_op', 'blocked', 'skipped', 'unexecuted'],
        },
      },
    },
  };
}

export function sessionPlanProposalToolV3(): ProviderWireToolDefinition {
  return {
    name: SESSION_PROVIDER_PLAN_PROPOSAL_V3_TOOL_NAME,
    description: [
      'Session-only structured Plan control; it never executes a Kernel tool.',
      'Call it exactly once only when the requested work requires a Plan for user review.',
      'For an ordinary answer, do not call it and reply with natural assistant text.',
      'Commentary may precede this control, but final answer text may not share the response.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'plan'],
      properties: {
        schemaVersion: {
          type: 'string',
          const: SESSION_PROVIDER_PLAN_PROPOSAL_V3_SCHEMA,
        },
        plan: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'objective', 'narrative', 'actions'],
          properties: {
            title: { type: 'string', minLength: 1 },
            objective: { type: 'string', minLength: 1 },
            narrative: { type: 'string', minLength: 1 },
            actions: {
              type: 'array',
              minItems: 1,
              maxItems: 128,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'toolId',
                  'scopeIntent',
                ],
                properties: {
                  toolId: { type: 'string', minLength: 1 },
                  scopeIntent: sessionPlanScopeIntentSchemaV3(),
                  deadline: sessionPlanDeadlineSchemaV2(),
                },
              },
            },
          },
        },
      },
    },
  };
}

function sessionPlanScopeIntentSchemaV3(): unknown {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'data'],
        properties: {
          kind: { type: 'string', const: 'resourceScope' },
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['requestedResources'],
            properties: {
              requestedResources: {
                type: 'array',
                minItems: 1,
                maxItems: 256,
                items: sessionPlanRequestedResourceSchemaV2(),
              },
            },
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'data'],
        properties: {
          kind: { type: 'string', const: 'exactInvocation' },
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['rawArguments'],
            properties: {
              rawArguments: {
                type: 'object',
                additionalProperties: true,
              },
            },
          },
        },
      },
    ],
  };
}

function sessionPlanRequestedResourceSchemaV2(): unknown {
  const tagged = (
    kind: string,
    properties: Record<string, unknown>,
    required: string[]
  ): Record<string, unknown> => ({
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'data'],
    properties: {
      kind: { type: 'string', const: kind },
      data: {
        type: 'object',
        additionalProperties: false,
        required,
        properties,
      },
    },
  });
  return {
    oneOf: [
      tagged(
        'workspacePath',
        {
          path: { type: 'string', minLength: 1 },
          access: { type: 'string', enum: ['read', 'write'] },
        },
        ['path', 'access']
      ),
      tagged(
        'repository',
        {
          area: {
            type: 'string',
            enum: ['state', 'index', 'history'],
          },
        },
        ['area']
      ),
      tagged(
        'networkUrl',
        { url: { type: 'string', minLength: 1 } },
        ['url']
      ),
      tagged(
        'networkQuery',
        { query: { type: 'string', minLength: 1 } },
        ['query']
      ),
    ],
  };
}

function sessionPlanDeadlineSchemaV2(): unknown {
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'data'],
        properties: {
          kind: { type: 'string', const: 'contractDefault' },
          data: {
            type: 'object',
            additionalProperties: false,
          },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'data'],
        properties: {
          kind: { type: 'string', const: 'exactMilliseconds' },
          data: {
            type: 'object',
            additionalProperties: false,
            required: ['value'],
            properties: {
              value: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    ],
  };
}

export interface SessionProviderPlanActionDraftV2 {
  toolId: string;
  scopeIntent: ScopeIntentV2;
  deadline?: DeadlineRequestV2;
}

/**
 * Provider-owned prose and requested scope only. Authority identities are
 * deliberately absent and are minted by Session after validation.
 */
export interface SessionProviderPlanDraftV2 {
  title: string;
  objective: string;
  narrative: string;
  actions: SessionProviderPlanActionDraftV2[];
}

export type SessionKernelProviderOrderedItemV2 =
  SessionProviderOrderedItemV2;

export type SessionKernelProviderBackendOutputV2 = (
  | {
      kind: 'plan';
      plan: SessionProviderPlanDraftV2;
      planProposal: {
        schemaVersion: typeof SESSION_PROVIDER_PLAN_PROPOSAL_V3_SCHEMA;
        callId: string;
        toolName: typeof SESSION_PROVIDER_PLAN_PROPOSAL_V3_TOOL_NAME;
        argumentsDigest: string;
      };
    }
  | {
      kind: 'nativeToolCalls';
      calls: Array<{
        callId: string;
        toolName: string;
        toolId: string;
        arguments: RawToolArgumentsV2;
      }>;
    }
  | {
      kind: 'planActionComplete';
      outcome: SessionPlanActionCompletionOutcomeV2;
      control: {
        schemaVersion:
          typeof SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA;
        callId: string;
        toolName:
          typeof SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME;
        argumentsDigest: string;
      };
    }
  | {
      kind: 'text';
      text: string;
    }
  | {
      kind: 'noTool';
      guidance?: string;
    }
) & {
  items: SessionKernelProviderOrderedItemV2[];
  completion: SessionProviderCompletionReceiptV1;
  providerResult: SessionProviderResultMetadataV2;
  responseDigest: string;
};

/**
 * Provider-specific implementations runtime-decode their wire format before
 * returning this semantic union. They own any reversible provider tool-name
 * encoding; this boundary always uses the namespaced Kernel ToolId.
 */
export interface SessionKernelProviderBackendV2 {
  requestTurn(
    input: SessionProviderTurnInputV2
  ): Promise<SessionKernelProviderBackendOutputV2>;
}

export interface SessionKernelProviderAdapterV2
  extends SessionKernelProviderPortV2 {}

export type SessionKernelProviderAdapterInputV2 = Pick<
  SessionProviderTurnInputV2,
  | 'providerTurnId'
  | 'purpose'
  | 'runId'
  | 'currentInput'
  | 'providerProfile'
  | 'plan'
  | 'target'
  | 'toolContext'
>;

/**
 * Only provider-native Kernel tool calls enter the executable lane. The
 * Session-only Plan control remains orchestration data and never becomes a
 * ToolIntent. The complete response is reduced to a safe receipt before
 * Session can persist and admit the ordered call queue. Prose, fenced JSON,
 * and embedded objects remain text and can never execute.
 */
export class StrictSessionKernelProviderAdapterV2
implements SessionKernelProviderAdapterV2 {
  constructor(
    private readonly backend: SessionKernelProviderBackendV2,
    private readonly clock: SessionKernelClockPortV2
  ) {}

  async requestTurn(
    input: SessionProviderTurnInputV2
  ): Promise<SessionProviderTurnOutputV2> {
    const output = await this.backend.requestTurn(input);
    return adaptSessionKernelProviderBackendOutputV2(
      input,
      output,
      this.clock.now()
    );
  }
}

/**
 * Pure strict adapter shared by live Provider requests and daemon-terminal
 * recovery. `recordedAt` is supplied by the durable boundary so replay never
 * invents a new Plan or tool-call receipt timestamp.
 */
export function adaptSessionKernelProviderBackendOutputV2(
  input: SessionKernelProviderAdapterInputV2,
  output: SessionKernelProviderBackendOutputV2,
  recordedAt: string
): SessionProviderTurnOutputV2 {
    if (
      (input.target.kind === 'finalAnswer')
        !== (input.purpose === 'finalAnswer')
    ) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_final_answer_purpose_mismatch',
        'Final-answer purpose and target must be bound together.'
      );
    }
    assertCompletedProviderBackendOutputV2(input, output);
    const completionFields = {
      items: cloneJson(output.items),
      completion: cloneJson(output.completion),
    };
    switch (output.kind) {
      case 'plan':
        if (input.target.kind !== 'planning') {
          throw new SessionKernelProviderAdapterError(
            'session_kernel_provider_plan_target_invalid',
            'A Provider plan is accepted only for a Session planning turn.'
          );
        }
        return {
          kind: 'plan',
          ...completionFields,
          plan: materializeProviderPlanV2(
            input,
            output.plan,
            recordedAt
          ),
          providerResult: output.providerResult,
        };
      case 'nativeToolCalls': {
        const ownershipRepair = planActionOwnershipRepairV2(
          input,
          output.calls
        );
        if (ownershipRepair) {
          return {
            kind: 'noTool',
            ...completionFields,
            guidance: ownershipRepair.guidance,
            repair: ownershipRepair.repair,
            providerResult: output.providerResult,
          };
        }
        const sources = [];
        for (let index = 0; index < output.calls.length; index += 1) {
          const call = output.calls[index]!;
          const nativeToolId = requiredToolId(call.toolId);
          const descriptor = requirePermittedTool(input, nativeToolId);
          const mismatch = toolArgumentsSchemaMismatchV2(
            call.arguments,
            descriptor.inputSchema,
            nativeToolId,
            'arguments'
          );
          if (mismatch) {
            return {
              kind: 'noTool',
              ...completionFields,
              guidance: providerToolArgumentRepairGuidanceV2(
                nativeToolId,
                mismatch
              ),
              repair: {
                kind: 'toolArguments',
                toolId: nativeToolId,
                callOrdinal: index + 1,
              },
              providerResult: output.providerResult,
            };
          }
          sources.push({
            source: 'providerNative' as const,
            callId: requiredIdentity(call.callId, 'callId'),
            toolId: nativeToolId,
            arguments: cloneJson(call.arguments),
          });
        }
        return {
          kind: 'toolIntent',
          ...completionFields,
          sources,
          receipt: providerToolCallReceipt(
            input.providerTurnId,
            output.responseDigest,
            output.calls.map((call) => ({
              callId: call.callId,
              toolName: call.toolName,
              toolId: call.toolId,
              arguments: call.arguments,
            })),
            recordedAt
          ),
          providerResult: output.providerResult,
        };
      }
      case 'planActionComplete':
        if (input.target.kind !== 'planAction') {
          throw new SessionKernelProviderAdapterError(
            'session_kernel_provider_plan_action_complete_target_invalid',
            'PlanActionComplete is accepted only for the current Session PlanAction turn.'
          );
        }
        return {
          kind: 'planActionComplete',
          ...completionFields,
          outcome: output.outcome,
          control: cloneJson(output.control),
          providerResult: output.providerResult,
        };
      case 'text':
        if (!output.text.trim()) {
          return {
            kind: 'noTool',
            ...completionFields,
            providerResult: output.providerResult,
          };
        }
        requiredText(output.text, 'Provider text', 1024 * 1024);
        return {
          kind: 'answer',
          ...completionFields,
          text: output.text,
          providerResult: output.providerResult,
        };
      case 'noTool':
        if (input.target.kind === 'finalAnswer') {
          throw new SessionKernelProviderAdapterError(
            'session_kernel_provider_final_answer_missing',
            'A final-answer Provider turn must return non-empty answer text.'
          );
        }
        return {
          kind: 'noTool',
          ...completionFields,
          ...(output.guidance?.trim()
            ? { guidance: output.guidance }
            : {}),
          providerResult: output.providerResult,
        };
    }
}

function planActionOwnershipRepairV2(
  input: SessionKernelProviderAdapterInputV2,
  calls: Readonly<Extract<
    SessionKernelProviderBackendOutputV2,
    { kind: 'nativeToolCalls' }
  >['calls']>
): {
  guidance: string;
  repair: Extract<
    NonNullable<
      Extract<
        SessionProviderTurnOutputV2,
        { kind: 'noTool' }
      >['repair']
    >,
    { kind: 'planActionOwnership' }
  >;
} | undefined {
  if (input.target.kind !== 'planAction') return undefined;
  const plan = input.plan;
  const currentPlanActionId = input.target.planActionId;
  const currentIndex = plan?.actions.findIndex(
    (action) =>
      action.manifest.planActionId === currentPlanActionId
  ) ?? -1;
  if (!plan || currentIndex < 0) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_action_missing',
      'PlanAction output admission requires its exact persisted Plan action.'
    );
  }
  const current = plan.actions[currentIndex]!;
  for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
    const call = calls[callIndex]!;
    const toolId = requiredToolId(call.toolId);
    const matchesCurrent =
      current.manifest.toolId === toolId;
    if (matchesCurrent) continue;
    const siblingIndexes = plan.actions.flatMap(
      (action, index) =>
        index > currentIndex
        && action.manifest.toolId === toolId
          ? [index]
          : []
    );
    if (siblingIndexes.length !== 1) continue;
    const siblingIndex = siblingIndexes[0]!;
    const currentSequence = currentIndex + 1;
    const siblingSequence = siblingIndex + 1;
    return {
      guidance: [
        `Provider call ${String(callIndex + 1)} matches pending Plan action sequence ${String(siblingSequence)}`,
        `while sequence ${String(currentSequence)} is current.`,
        'No Kernel ToolIntent was created.',
        'Replan the current work before any further execution; do not start the later action under the current PlanAction authority.',
      ].join(' '),
      repair: {
        kind: 'planActionOwnership',
        toolId,
        callOrdinal: callIndex + 1,
        currentSequence,
        siblingSequence,
      },
    };
  }
  return undefined;
}

function assertCompletedProviderBackendOutputV2(
  input: SessionKernelProviderAdapterInputV2,
  output: SessionKernelProviderBackendOutputV2
): void {
  const completion = output.completion;
  if (
    !completion
    || !completion.nativeCompletion
    || completion.schemaVersion
      !== 'deepcode.provider-stream-terminal.v1'
    || completion.reasoningPresent !== true
    || completion.trace?.sealed !== true
    || !Number.isSafeInteger(completion.trace.recordCount)
    || completion.trace.recordCount <= 0
    || output.responseDigest !== completion.responseDigest
  ) {
    throw providerCompletionInvalid();
  }
  if (output.kind === 'plan') {
    if (
      output.planProposal.schemaVersion
        !== SESSION_PROVIDER_PLAN_PROPOSAL_V3_SCHEMA
      || output.planProposal.toolName
        !== SESSION_PROVIDER_PLAN_PROPOSAL_V3_TOOL_NAME
    ) {
      throw providerCompletionInvalid();
    }
    requiredIdentity(output.planProposal.callId, 'planProposal.callId');
    requiredDigest(
      output.planProposal.argumentsDigest,
      'planProposal.argumentsDigest'
    );
  }
  if (output.kind === 'planActionComplete') {
    if (
      output.control.schemaVersion
        !== SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_SCHEMA
      || output.control.toolName
        !== SESSION_PROVIDER_PLAN_ACTION_COMPLETE_V2_TOOL_NAME
      || ![
        'completed',
        'no_op',
        'blocked',
        'skipped',
        'unexecuted',
      ].includes(output.outcome)
    ) {
      throw providerCompletionInvalid();
    }
    requiredIdentity(output.control.callId, 'planActionComplete.callId');
    requiredDigest(
      output.control.argumentsDigest,
      'planActionComplete.argumentsDigest'
    );
  }
  requiredDigest(completion.reasoningDigest, 'reasoningDigest');
  requiredDigest(completion.responseDigest, 'responseDigest');
  requiredDigest(completion.trace.sealDigest, 'trace.sealDigest');
  requiredDigest(
    completion.trace.terminalDigest,
    'trace.terminalDigest'
  );
  const expectedReasoningTransport =
    completion.nativeCompletion.providerKind === 'openaiCompatible'
      ? 'openaiPlaintext'
      : completion.nativeCompletion.providerKind === 'anthropic'
        ? 'anthropicPlaintext'
        : completion.nativeCompletion.providerKind === 'ollama'
          ? 'ollamaPlaintext'
          : undefined;
  if (
    !expectedReasoningTransport
    || completion.reasoningTransport !== expectedReasoningTransport
  ) {
    throw providerCompletionInvalid();
  }
  if (
    completion.reasoningTransport
      !== input.providerProfile.reasoningTransport
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_reasoning_transport_mismatch',
      'Provider completion reasoning transport differs from the immutable Profile revision.'
    );
  }
  if (
    output.providerResult.providerProfileId !== undefined
    && output.providerResult.providerProfileId
      !== input.providerProfile.providerProfileId
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_profile_result_mismatch',
      'Provider result profile differs from the immutable Run bootstrap.'
    );
  }
  if (!Array.isArray(output.items) || output.items.length > 96) {
    throw providerCompletionInvalid();
  }
  let finalStarted = false;
  const orderedTools: Array<
    Extract<SessionKernelProviderOrderedItemV2, { kind: 'toolCall' }>
  > = [];
  for (const [index, item] of output.items.entries()) {
    if (item.kind === 'text') {
      requiredText(item.text, 'Provider ordered text', 1024 * 1024);
      if (
        item.phase !== 'commentary'
        && item.phase !== 'final_answer'
        && item.phase !== 'unknown'
      ) {
        throw providerCompletionInvalid();
      }
      if (finalStarted && item.phase === 'commentary') {
        throw new SessionKernelProviderAdapterError(
          'session_kernel_provider_phase_conflict',
          'Provider commentary cannot appear after final answer output began.'
        );
      }
      if (item.phase === 'final_answer') finalStarted = true;
      continue;
    }
    if (item.kind !== 'toolCall' || finalStarted) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_phase_conflict',
        'Provider final answer and tool calls cannot share one response.'
      );
    }
    if (item.ordinal !== orderedTools.length + 1) {
      throw providerCompletionInvalid();
    }
    if (item.source !== 'providerNative') {
      throw providerCompletionInvalid();
    }
    requiredIdentity(item.callId, `items[${index}].callId`);
    requiredIdentity(item.toolName, `items[${index}].toolName`);
    requiredToolId(item.toolId);
    orderedTools.push(item);
  }
  if (
    input.target.kind === 'finalAnswer'
    && orderedTools.length > 0
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_final_answer_tool_forbidden',
      'A final-answer Provider turn cannot return tool calls.'
    );
  }
  if (
    finalStarted
    && orderedTools.length > 0
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_phase_conflict',
      'Provider final answer and tool calls cannot share one response.'
    );
  }
  if (output.kind === 'nativeToolCalls') {
    if (
      orderedTools.length !== output.calls.length
      || output.calls.some((call, index) => {
        const ordered = orderedTools[index];
        return !ordered
          || ordered.callId !== call.callId
          || ordered.toolName !== call.toolName
          || ordered.toolId !== call.toolId
          || canonicalJson(ordered.arguments)
            !== canonicalJson(call.arguments);
      })
    ) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_ordered_items_mismatch',
        'Provider semantic tool calls differ from the sealed ordered response.'
      );
    }
  } else if (orderedTools.length > 0) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_ordered_items_mismatch',
      'Provider semantic output omitted sealed ordered tool calls.'
    );
  }
  const native = completion.nativeCompletion;
  if (
    native.providerKind === 'openaiCompatible'
    && (
      native.terminalSignal !== '[DONE]'
      || (
        orderedTools.length > 0
        || output.kind === 'plan'
        || output.kind === 'planActionComplete'
          ? native.finishReason !== 'tool_calls'
          : native.finishReason !== 'stop'
      )
    )
  ) {
    throw providerCompletionInvalid();
  }
  if (
    native.providerKind === 'anthropic'
    && native.terminalSignal !== 'message_stop'
  ) {
    throw providerCompletionInvalid();
  }
  if (
    native.providerKind === 'ollama'
    && native.terminalSignal !== 'done:true'
  ) {
    throw providerCompletionInvalid();
  }
}

function providerCompletionInvalid():
  SessionKernelProviderAdapterError {
  return new SessionKernelProviderAdapterError(
    'session_kernel_provider_completion_receipt_invalid',
    'Provider output is not bound to a valid native completion and durable trace receipt.'
  );
}

function providerToolCallReceipt(
  providerTurnId: string,
  responseDigest: string,
  calls: Array<{
    callId: string;
    toolName: string;
    toolId: string;
    arguments: RawToolArgumentsV2;
  }>,
  recordedAt: string
): SessionProviderToolCallReceiptV2 {
  if (calls.length === 0 || calls.length > 32) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_tool_call_count_invalid',
      'Provider tool calls must contain 1..=32 entries.'
    );
  }
  const callIds = new Set<string>();
  for (const call of calls) {
    const callId = requiredIdentity(call.callId, 'callId');
    if (callIds.has(callId)) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_tool_call_identity_duplicate',
        'Provider tool-call identities must be unique within one response.'
      );
    }
    callIds.add(callId);
  }
  return {
    schemaVersion: SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
    providerTurnId: requiredIdentity(providerTurnId, 'providerTurnId'),
    responseDigest: requiredDigest(responseDigest, 'responseDigest'),
    callCount: calls.length,
    calls: calls.map((call, index) => ({
      ordinal: index + 1,
      callId: requiredIdentity(call.callId, 'callId'),
      toolName: requiredIdentity(call.toolName, 'toolName'),
      toolId: requiredToolId(call.toolId),
      argumentsDigest: sha256Hash(canonicalJson(call.arguments)),
    })),
    recordedAt: requiredIdentity(recordedAt, 'recordedAt'),
  };
}

function requiredDigest(value: string, field: string): string {
  const digest = requiredIdentity(value, field);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_digest_invalid',
      `${field} is not a canonical sha256 digest.`
    );
  }
  return digest;
}

function requirePermittedTool(
  input: SessionKernelProviderAdapterInputV2,
  toolId: string
): SessionKernelProviderAdapterInputV2['toolContext']['tools'][number] {
  const descriptor = input.toolContext.tools.find(
    (tool) => tool.toolId === toolId
  );
  if (!descriptor) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_tool_unavailable',
      `Provider requested a tool outside the current ready ToolContext: ${toolId}.`
    );
  }
  if (
    input.target.kind === 'planning'
    && descriptor.effectClass !== 'read'
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_planning_mutation_forbidden',
      'A planning turn cannot invoke a mutation without a confirmed PlanAction.'
    );
  }
  return descriptor;
}

export function materializeProviderPlanV2(
  input: Pick<
    SessionProviderTurnInputV2,
    'providerTurnId' | 'runId' | 'currentInput' | 'toolContext'
  >,
  draft: SessionProviderPlanDraftV2,
  recordedAt: string
): SessionNaturalLanguagePlanV2 {
  const normalized = normalizePlanDraft(draft);
  const readyTools = new Map(
    input.toolContext.tools.map((tool) => [tool.toolId, tool])
  );
  for (const action of normalized.actions) {
    const descriptor = readyTools.get(action.toolId);
    if (!descriptor || descriptor.availability !== 'ready') {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_tool_unavailable',
        `Provider plan requested a tool outside the current ready ToolContext: ${action.toolId}.`
      );
    }
    if (descriptor.authorizationShape !== action.scopeIntent.kind) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_scope_shape_invalid',
        `Provider Plan scopeIntent for ${action.toolId} does not match the immutable Kernel authorization shape.`
      );
    }
    if (action.scopeIntent.kind === 'exactInvocation') {
      assertToolArgumentsMatchSchemaV2(
        action.scopeIntent.data.rawArguments,
        descriptor.inputSchema,
        action.toolId
      );
    }
  }
  const digest = sha256Hash(canonicalJson({
    providerTurnId: input.providerTurnId,
    runId: input.runId,
    plan: normalized,
  })).slice('sha256:'.length);
  const planRevision = `plan-${digest}`;
  return {
    runId: input.runId,
    inputId: input.currentInput.inputId,
    planRevision,
    title: normalized.title,
    objective: normalized.objective,
    narrative: normalized.narrative,
    actions: normalized.actions.map((action, index) => {
      const ordinal = String(index + 1).padStart(4, '0');
      const planActionId = `plan-action-${digest}-${ordinal}`;
      const operationId = `operation-${digest}-${ordinal}`;
      return {
        taskId: `task-${digest}-${ordinal}`,
        manifest: createScopeManifestV2({
          planRevision,
          planActionId,
          operationId,
          toolId: action.toolId,
          scopeIntent: action.scopeIntent,
        }),
        idempotencyKey: `intent-${digest}-${ordinal}`,
        deadline: action.deadline ?? {
          kind: 'contractDefault',
          data: {},
        },
      };
    }),
    recordedAt: requiredText(recordedAt, 'recordedAt', 1024),
  };
}

function normalizePlanDraft(
  draft: SessionProviderPlanDraftV2
): SessionProviderPlanDraftV2 {
  if (draft.actions.length === 0 || draft.actions.length > 128) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_actions_invalid',
      'Provider plan actions must contain 1..=128 entries.'
    );
  }
  return {
    title: requiredText(draft.title, 'plan.title', 64 * 1024),
    objective: requiredText(
      draft.objective,
      'plan.objective',
      64 * 1024
    ),
    narrative: requiredText(
      draft.narrative,
      'plan.narrative',
      64 * 1024
    ),
    actions: draft.actions.map((action) => {
      if (
        action.scopeIntent.kind === 'resourceScope'
        && (
          action.scopeIntent.data.requestedResources.length === 0
          || action.scopeIntent.data.requestedResources.length > 256
        )
      ) {
        throw new SessionKernelProviderAdapterError(
          'session_kernel_provider_plan_resources_invalid',
          'Provider plan requestedResources must contain 1..=256 entries.'
        );
      }
      return {
        toolId: requiredToolId(action.toolId),
        scopeIntent: action.scopeIntent.kind === 'resourceScope'
          ? {
              kind: action.scopeIntent.kind,
              data: {
                requestedResources:
                  action.scopeIntent.data.requestedResources
                    .map(cloneRequestedResource),
              },
            }
          : {
              kind: action.scopeIntent.kind,
              data: {
                rawArguments: decodeRawToolArgumentsV2(
                  action.scopeIntent.data.rawArguments
                ),
              },
            },
        ...(action.deadline
          ? { deadline: cloneDeadline(action.deadline) }
          : {}),
      };
    }),
  };
}

const SUPPORTED_TOOL_SCHEMA_KEYWORDS_V2 = new Set([
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'minItems',
  'maxItems',
  'const',
  'oneOf',
]);

class UnsupportedToolSchemaV2 extends Error {}

function assertToolArgumentsMatchSchemaV2(
  argumentsValue: unknown,
  schema: unknown,
  toolId: string
): void {
  const mismatch = toolArgumentsSchemaMismatchV2(
    argumentsValue,
    schema,
    toolId,
    'scopeIntent.rawArguments'
  );
  if (mismatch) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_arguments_invalid',
      `Provider Plan exact-invocation arguments for ${toolId} do not match the immutable ToolContext JSON Schema: ${mismatch}`
    );
  }
}

function toolArgumentsSchemaMismatchV2(
  argumentsValue: unknown,
  schema: unknown,
  toolId: string,
  path: string
): string | undefined {
  try {
    return validateToolSchemaValueV2(
      argumentsValue,
      schema,
      path
    );
  } catch (error) {
    if (error instanceof UnsupportedToolSchemaV2) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_tool_schema_unsupported',
        `Kernel ToolContext schema for ${toolId} cannot be validated: ${error.message}`
      );
    }
    throw error;
  }
}

function providerToolArgumentRepairGuidanceV2(
  toolId: string,
  mismatch: string
): string {
  return [
    `Tool arguments for ${toolId} do not match the immutable ToolContext JSON Schema: ${mismatch}.`,
    'Correct the arguments and submit a new tool call.',
    'For a workspace-root path use "." (or omit an optional path field); never send an empty path string.',
  ].join(' ');
}

function validateToolSchemaValueV2(
  value: unknown,
  schemaValue: unknown,
  path: string
): string | undefined {
  const schema = requireToolSchemaRecordV2(schemaValue, path);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_TOOL_SCHEMA_KEYWORDS_V2.has(keyword)) {
      throw new UnsupportedToolSchemaV2(
        `${path} uses unsupported keyword ${keyword}`
      );
    }
  }

  if ('const' in schema && canonicalJson(value) !== canonicalJson(schema.const)) {
    return `${path} does not equal its required constant`;
  }
  if ('enum' in schema) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
      throw new UnsupportedToolSchemaV2(`${path}.enum must be non-empty`);
    }
    if (!schema.enum.some((candidate) =>
      canonicalJson(candidate) === canonicalJson(value)
    )) {
      return `${path} is outside the permitted enum`;
    }
  }
  if ('oneOf' in schema) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new UnsupportedToolSchemaV2(`${path}.oneOf must be non-empty`);
    }
    let matches = 0;
    for (const candidate of schema.oneOf) {
      if (validateToolSchemaValueV2(value, candidate, path) === undefined) {
        matches += 1;
      }
    }
    if (matches !== 1) {
      return `${path} must match exactly one schema variant`;
    }
  }

  if (!('type' in schema)) return undefined;
  if (typeof schema.type !== 'string') {
    throw new UnsupportedToolSchemaV2(`${path}.type must be a string`);
  }
  switch (schema.type) {
    case 'object':
      return validateToolSchemaObjectV2(value, schema, path);
    case 'array':
      if (!Array.isArray(value)) return `${path} must be an array`;
      if ('minItems' in schema) {
        if (!Number.isSafeInteger(schema.minItems) || Number(schema.minItems) < 0) {
          throw new UnsupportedToolSchemaV2(
            `${path}.minItems must be a non-negative safe integer`
          );
        }
        if (value.length < Number(schema.minItems)) {
          return `${path} must contain at least ${String(schema.minItems)} items`;
        }
      }
      if ('maxItems' in schema) {
        if (!Number.isSafeInteger(schema.maxItems) || Number(schema.maxItems) < 0) {
          throw new UnsupportedToolSchemaV2(
            `${path}.maxItems must be a non-negative safe integer`
          );
        }
        if (value.length > Number(schema.maxItems)) {
          return `${path} must contain at most ${String(schema.maxItems)} items`;
        }
      }
      if (!('items' in schema)) return undefined;
      return firstSchemaMismatchV2(
        value.map((item, index) =>
          validateToolSchemaValueV2(item, schema.items, `${path}[${index}]`)
        )
      );
    case 'string': {
      if (typeof value !== 'string') return `${path} must be a string`;
      if ('minLength' in schema) {
        if (!Number.isSafeInteger(schema.minLength) || Number(schema.minLength) < 0) {
          throw new UnsupportedToolSchemaV2(
            `${path}.minLength must be a non-negative safe integer`
          );
        }
        if ([...value].length < Number(schema.minLength)) {
          return `${path} must contain at least ${String(schema.minLength)} characters`;
        }
      }
      return undefined;
    }
    case 'integer':
      if (!Number.isSafeInteger(value)) {
        return `${path} must be a cross-language safe integer`;
      }
      if ('minimum' in schema) {
        if (!Number.isSafeInteger(schema.minimum)) {
          throw new UnsupportedToolSchemaV2(
            `${path}.minimum must be a safe integer`
          );
        }
        if (Number(value) < Number(schema.minimum)) {
          return `${path} must be at least ${String(schema.minimum)}`;
        }
      }
      if ('maximum' in schema) {
        if (!Number.isSafeInteger(schema.maximum)) {
          throw new UnsupportedToolSchemaV2(
            `${path}.maximum must be a safe integer`
          );
        }
        if (Number(value) > Number(schema.maximum)) {
          return `${path} must be at most ${String(schema.maximum)}`;
        }
      }
      return undefined;
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : `${path} must be a boolean`;
    default:
      throw new UnsupportedToolSchemaV2(
        `${path} uses unsupported type ${schema.type}`
      );
  }
}

function validateToolSchemaObjectV2(
  value: unknown,
  schema: Record<string, unknown>,
  path: string
): string | undefined {
  if (!isJsonRecordV2(value)) return `${path} must be an object`;
  const properties = 'properties' in schema
    ? requireToolSchemaRecordV2(schema.properties, `${path}.properties`)
    : {};
  const required = schema.required ?? [];
  if (
    !Array.isArray(required)
    || required.some((key) => typeof key !== 'string')
    || new Set(required).size !== required.length
  ) {
    throw new UnsupportedToolSchemaV2(
      `${path}.required must contain unique strings`
    );
  }
  for (const key of required as string[]) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return `${path}.${key} is required`;
    }
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (Object.prototype.hasOwnProperty.call(properties, key)) {
      const mismatch = validateToolSchemaValueV2(
        fieldValue,
        properties[key],
        `${path}.${key}`
      );
      if (mismatch) return mismatch;
      continue;
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      return `${path}.${key} is not permitted`;
    }
    if (isJsonRecordV2(additional)) {
      const mismatch = validateToolSchemaValueV2(
        fieldValue,
        additional,
        `${path}.${key}`
      );
      if (mismatch) return mismatch;
    } else if (additional !== undefined && additional !== true) {
      throw new UnsupportedToolSchemaV2(
        `${path}.additionalProperties must be boolean or a schema`
      );
    }
  }
  return undefined;
}

function requireToolSchemaRecordV2(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (!isJsonRecordV2(value)) {
    throw new UnsupportedToolSchemaV2(`${path} must be a schema object`);
  }
  return value;
}

function isJsonRecordV2(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value);
}

function firstSchemaMismatchV2(
  mismatches: Array<string | undefined>
): string | undefined {
  return mismatches.find((mismatch) => mismatch !== undefined);
}

function cloneRequestedResource(
  resource: RequestedResourceV2
): RequestedResourceV2 {
  switch (resource.kind) {
    case 'workspacePath':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'repository':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'networkUrl':
      return { kind: resource.kind, data: { ...resource.data } };
    case 'networkQuery':
      return { kind: resource.kind, data: { ...resource.data } };
  }
}

function cloneDeadline(
  deadline: DeadlineRequestV2
): DeadlineRequestV2 {
  if (deadline.kind === 'contractDefault') {
    return { kind: deadline.kind, data: {} };
  }
  if (
    !Number.isSafeInteger(deadline.data.value)
    || deadline.data.value <= 0
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_deadline_invalid',
      'Provider exact deadline must be a positive safe integer.'
    );
  }
  return {
    kind: deadline.kind,
    data: { value: deadline.data.value },
  };
}

function requiredIdentity(value: string, field: string): string {
  const text = requiredText(value, field, 512);
  if (
    text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_identity_invalid',
      `${field} is not a valid bounded identity.`
    );
  }
  return text;
}

function requiredToolId(value: string): string {
  const toolId = requiredIdentity(value, 'toolId');
  if (!/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(toolId)) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_tool_id_invalid',
      'Provider toolId must be a lowercase namespaced identity.'
    );
  }
  return toolId;
}

function requiredText(
  value: string,
  field: string,
  maxBytes: number
): string {
  if (
    !value.trim()
    || new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_text_invalid',
      `${field} must contain bounded non-empty text.`
    );
  }
  return value;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SessionKernelProviderAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelProviderAdapterError';
  }
}
