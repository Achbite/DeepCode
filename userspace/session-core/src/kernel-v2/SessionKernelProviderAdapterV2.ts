import {
  decodeRawToolArgumentsV2,
  type DeadlineRequestV2,
  type KernelFactProjectionV2,
  type ProviderWireToolDefinition,
  type RawToolArgumentsV2,
  type RequestedResourceV2,
  type ScopeIntentV2,
  type ToolAuthorizationShapeV2,
  type ToolDescriptorV2,
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
  SessionPlanEvidenceV4,
  SessionPlanActionCompletionOutcomeV2,
  SessionProviderCompletionReceiptV1,
  SessionProviderOrderedItemV2,
  SessionProviderPlanEvidenceRefreshV1,
  SessionProviderResultMetadataV2,
  SessionProviderToolCallReceiptV2,
  SessionProviderTurnInputV2,
  SessionProviderTurnOutputV2,
  SessionUserInterventionV4,
} from './types.js';
import {
  SESSION_PROVIDER_TOOL_CALL_RECEIPT_V2_SCHEMA,
} from './types.js';
import {
  SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2,
} from './factKinds.js';

export const SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA =
  'deepcode.session.plan-proposal.v5' as const;
export const SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME =
  'deepcode_session_plan_propose_v5' as const;
export const SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA =
  'deepcode.session.intervention-proposal.v1' as const;
export const SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME =
  'deepcode_session_intervention_propose_v1' as const;
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

export function sessionPlanProposalToolV5(
  admittedTools: readonly ToolDescriptorV2[]
): ProviderWireToolDefinition {
  if (
    admittedTools.length === 0
    || admittedTools.some((tool) => tool.availability !== 'ready')
    || admittedTools.some(
      (tool, index) =>
        !/^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)+$/u.test(tool.toolId)
        || (index > 0 && admittedTools[index - 1]!.toolId >= tool.toolId)
    )
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_tool_catalog_invalid',
      'The Session Plan control requires one non-empty strictly ordered ready Kernel ToolDescriptor catalog.'
    );
  }
  const mutationTools = admittedTools.filter(
    (tool) => tool.effectClass === 'mutation'
  );
  return {
    name: SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME,
    description: [
      'Session-only structured Plan control; it never executes a Kernel tool.',
      'Call it exactly once only when every action is necessary for an explicit immediate requested outcome, honors every preserve constraint, and excludes deferred or conditional work.',
      'Workspace facts describe state only; never use this control for inferred repair, scaffolding, or improvement work that the current input did not request.',
      'For an ordinary answer or when user preference, scope, timing, or desired project shape needs clarification, do not call it and reply with natural assistant text.',
      'Commentary may precede this control, but final answer text may not share the response.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'plan'],
      properties: {
        schemaVersion: {
          type: 'string',
          const: SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA,
        },
        plan: {
          type: 'object',
          additionalProperties: false,
          required: [
            'title',
            'objective',
            'narrative',
            'evidence',
            'actions',
          ],
          properties: {
            title: { type: 'string', minLength: 1 },
            objective: { type: 'string', minLength: 1 },
            narrative: { type: 'string', minLength: 1 },
            evidence: sessionPlanEvidenceSchemaV4(),
            actions: {
              type: 'array',
              minItems: 1,
              maxItems: 128,
              items: {
                oneOf: mutationTools.map(sessionPlanActionSchemaV5),
              },
            },
          },
        },
      },
    },
  };
}

function sessionPlanEvidenceSchemaV4(): unknown {
  const unknownSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['unknownId', 'question', 'impact'],
    properties: {
      unknownId: { type: 'string', minLength: 1 },
      question: { type: 'string', minLength: 1 },
      impact: { type: 'string', minLength: 1 },
    },
  };
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'kernelFactRefs',
      'readResources',
      'blockingUnknowns',
      'nonBlockingUnknowns',
      'coverage',
    ],
    properties: {
      kernelFactRefs: {
        type: 'array',
        maxItems: 512,
        items: { type: 'string', minLength: 1 },
      },
      readResources: {
        type: 'array',
        maxItems: 512,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['resourceRef', 'summary', 'factRefs'],
          properties: {
            resourceRef: { type: 'string', minLength: 1 },
            summary: { type: 'string', minLength: 1 },
            factRefs: {
              type: 'array',
              minItems: 1,
              maxItems: 256,
              items: { type: 'string', minLength: 1 },
            },
          },
        },
      },
      blockingUnknowns: {
        type: 'array',
        maxItems: 128,
        items: unknownSchema,
      },
      nonBlockingUnknowns: {
        type: 'array',
        maxItems: 128,
        items: unknownSchema,
      },
      coverage: { type: 'string', minLength: 1 },
    },
  };
}

export function sessionInterventionProposalToolV1(
  admittedTools: readonly ToolDescriptorV2[]
): ProviderWireToolDefinition {
  const planDefinition = sessionPlanProposalToolV5(admittedTools);
  const planSchema = (
    planDefinition.inputSchema as {
      properties: { plan: unknown };
    }
  ).properties.plan;
  return {
    name: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME,
    description: [
      'Session-only control for one consolidated user intervention after out-of-plan mutation intent has been frozen.',
      'Use it only after directly relevant read evidence has converged.',
      'Executable options require a complete candidate Plan containing only unsettled mutation work; guidance-only options must omit candidatePlan.',
      'Explain the recommendation and material tradeoffs. This control grants no effect authority and cannot share Kernel mutation calls or final-answer text.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['schemaVersion', 'intervention'],
      properties: {
        schemaVersion: {
          type: 'string',
          const: SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA,
        },
        intervention: {
          type: 'object',
          additionalProperties: false,
          required: [
            'problemSummary',
            'relevantFactRefs',
            'affectedPlanActionIds',
            'options',
          ],
          properties: {
            problemSummary: { type: 'string', minLength: 1 },
            recommendation: { type: 'string', minLength: 1 },
            relevantFactRefs: {
              type: 'array',
              maxItems: 512,
              items: { type: 'string', minLength: 1 },
            },
            affectedPlanActionIds: {
              type: 'array',
              maxItems: 256,
              items: { type: 'string', minLength: 1 },
            },
            options: {
              type: 'array',
              minItems: 1,
              maxItems: 16,
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'optionId',
                  'kind',
                  'title',
                  'description',
                  'tradeoffs',
                  'recommended',
                ],
                properties: {
                  optionId: { type: 'string', minLength: 1 },
                  kind: {
                    type: 'string',
                    enum: ['executable', 'guidanceOnly'],
                  },
                  title: { type: 'string', minLength: 1 },
                  description: { type: 'string', minLength: 1 },
                  tradeoffs: {
                    type: 'array',
                    minItems: 1,
                    maxItems: 32,
                    items: { type: 'string', minLength: 1 },
                  },
                  recommended: { type: 'boolean' },
                  candidatePlan: planSchema,
                },
              },
            },
          },
        },
      },
    },
  };
}

function sessionPlanActionSchemaV5(
  tool: ToolDescriptorV2
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['toolId', 'scopeIntent'],
    properties: {
      toolId: {
        type: 'string',
        const: tool.toolId,
      },
      scopeIntent: sessionPlanScopeIntentSchemaV3(
        tool.authorizationShape,
        tool.inputSchema
      ),
      deadline: sessionPlanDeadlineSchemaV2(),
    },
  };
}

function sessionPlanScopeIntentSchemaV3(
  authorizationShape: ToolAuthorizationShapeV2,
  toolInputSchema: ToolDescriptorV2['inputSchema']
): unknown {
  if (authorizationShape === 'resourceScope') {
    return {
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
    };
  }
  return {
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
          rawArguments: cloneJson(toolInputSchema),
        },
      },
    },
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

export interface SessionProviderPlanEvidenceResourceDraftV4 {
  resourceRef: string;
  summary: string;
  factRefs: string[];
}

export interface SessionProviderPlanUnknownDraftV4 {
  unknownId: string;
  question: string;
  impact: string;
}

export interface SessionProviderPlanEvidenceDraftV4 {
  kernelFactRefs: string[];
  readResources: SessionProviderPlanEvidenceResourceDraftV4[];
  blockingUnknowns: SessionProviderPlanUnknownDraftV4[];
  nonBlockingUnknowns: SessionProviderPlanUnknownDraftV4[];
  coverage: string;
}

/**
 * Provider-owned prose and requested scope only. Authority identities are
 * deliberately absent and are minted by Session after validation.
 */
export interface SessionProviderPlanDraftV2 {
  title: string;
  objective: string;
  narrative: string;
  evidence: SessionProviderPlanEvidenceDraftV4;
  actions: SessionProviderPlanActionDraftV2[];
}

export interface SessionProviderInterventionOptionDraftV1 {
  optionId: string;
  kind: 'executable' | 'guidanceOnly';
  title: string;
  description: string;
  tradeoffs: string[];
  recommended: boolean;
  candidatePlan?: SessionProviderPlanDraftV2;
}

export interface SessionProviderInterventionDraftV1 {
  problemSummary: string;
  recommendation?: string;
  relevantFactRefs: string[];
  affectedPlanActionIds: string[];
  options: SessionProviderInterventionOptionDraftV1[];
}

export interface SessionProviderInterventionOptionV1
  extends Omit<SessionProviderInterventionOptionDraftV1, 'candidatePlan'> {
  candidatePlan?: SessionNaturalLanguagePlanV2;
}

export interface SessionProviderInterventionProposalV1
  extends Omit<SessionProviderInterventionDraftV1, 'options'> {
  options: SessionProviderInterventionOptionV1[];
}

export type SessionKernelProviderOrderedItemV2 =
  SessionProviderOrderedItemV2;

export type SessionKernelProviderBackendOutputV2 = (
  | {
      kind: 'plan';
      plan: SessionProviderPlanDraftV2;
      planProposal: {
        schemaVersion: typeof SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA;
        callId: string;
        toolName: typeof SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME;
        argumentsDigest: string;
      };
    }
  | {
      kind: 'intervention';
      draft: SessionProviderInterventionDraftV1;
      control: {
        schemaVersion:
          typeof SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA;
        callId: string;
        toolName:
          typeof SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME;
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
  | 'controlEpoch'
  | 'currentInput'
  | 'sessionMemory'
  | 'providerOutcomes'
  | 'providerProfile'
  | 'plan'
  | 'target'
  | 'toolContext'
> & {
  kernelFacts?: SessionProviderTurnInputV2['kernelFacts'];
};

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
        try {
          return {
            kind: 'plan',
            ...completionFields,
            plan: materializeProviderPlanV2(
              input,
              output.plan,
              recordedAt
            ),
            control: cloneJson(output.planProposal),
            providerResult: output.providerResult,
          };
        } catch (error) {
          if (!isRecoverablePlanEvidenceErrorV1(error)) throw error;
          const refresh = planEvidenceRefreshV1(
            input,
            output.plan,
            error.code,
            output.planProposal.argumentsDigest
          );
          return {
            kind: 'planEvidenceRefresh',
            ...completionFields,
            guidance: planEvidenceRefreshGuidanceV1(refresh),
            control: cloneJson(output.planProposal),
            refresh,
            providerResult: output.providerResult,
          };
        }
      case 'intervention':
        if (input.target.kind !== 'interventionResearch') {
          throw new SessionKernelProviderAdapterError(
            'session_kernel_provider_intervention_target_invalid',
            'A Provider intervention is accepted only for the active intervention research turn.'
          );
        }
        return {
          kind: 'intervention',
          ...completionFields,
          proposal: materializeProviderInterventionV1(
            input,
            output.draft,
            recordedAt
          ),
          control: cloneJson(output.control),
          providerResult: output.providerResult,
        };
      case 'nativeToolCalls': {
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

/**
 * Rehydrates an already admitted Provider Plan from its immutable Plan record.
 * Recovery must validate the original sealed proposal against the durable
 * semantic result; it must not re-run current evidence admission rules against
 * historical Kernel facts that compact checkpoints intentionally omit.
 */
export function rehydratePersistedProviderPlanOutputV2(
  input: SessionKernelProviderAdapterInputV2,
  output: Extract<SessionKernelProviderBackendOutputV2, { kind: 'plan' }>,
  persistedPlan: SessionNaturalLanguagePlanV2,
  recordedAt: string
): Extract<SessionProviderTurnOutputV2, { kind: 'plan' }> {
  if (
    input.target.kind !== 'planning'
    || input.purpose === 'finalAnswer'
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_target_invalid',
      'A persisted Provider plan must bind one planning turn.'
    );
  }
  assertCompletedProviderBackendOutputV2(input, output);
  const normalized = normalizePlanDraft(output.plan);
  assertPersistedProviderPlanV2(
    input,
    normalized,
    persistedPlan,
    recordedAt
  );
  return {
    kind: 'plan',
    items: cloneJson(output.items),
    completion: cloneJson(output.completion),
    plan: cloneJson(persistedPlan),
    control: cloneJson(output.planProposal),
    providerResult: cloneJson(output.providerResult),
  };
}

/**
 * Rehydrates an already admitted Provider intervention from the immutable
 * Session intervention record. Historical recovery validates the original
 * sealed proposal and candidate Plan identities without re-running current
 * Kernel-fact admission against compacted historical evidence.
 */
export function rehydratePersistedProviderInterventionOutputV2(
  input: SessionKernelProviderAdapterInputV2,
  output: Extract<
    SessionKernelProviderBackendOutputV2,
    { kind: 'intervention' }
  >,
  persistedIntervention: SessionUserInterventionV4,
  recordedAt: string
): Extract<SessionProviderTurnOutputV2, { kind: 'intervention' }> {
  if (input.target.kind !== 'interventionResearch') {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_intervention_target_invalid',
      'A persisted Provider intervention must bind one intervention research turn.'
    );
  }
  assertCompletedProviderBackendOutputV2(input, output);
  const normalized = normalizeInterventionDraftV1(output.draft);
  if (
    persistedIntervention.runId !== input.runId
    || persistedIntervention.inputId !== input.currentInput.inputId
    || persistedIntervention.controlEpoch !== input.controlEpoch
    || persistedIntervention.recordedAt !== recordedAt
    || persistedIntervention.problemSummary !== normalized.problemSummary
    || persistedIntervention.recommendation !== normalized.recommendation
    || canonicalJson(persistedIntervention.relevantFactRefs)
      !== canonicalJson(normalized.relevantFactRefs)
    || canonicalJson(persistedIntervention.affectedPlanActionIds)
      !== canonicalJson(normalized.affectedPlanActionIds)
    || persistedIntervention.options.length !== normalized.options.length
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_persisted_intervention_mismatch',
      'The sealed Provider proposal does not match its immutable admitted intervention record.'
    );
  }
  const options = normalized.options.map((option, index) => {
    const persisted = persistedIntervention.options[index];
    if (!persisted) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_persisted_intervention_mismatch',
        'The persisted intervention lost a Provider option identity.'
      );
    }
    const {
      candidatePlan,
      ...presentation
    } = option;
    if (
      persisted.optionId !== presentation.optionId
      || persisted.kind !== presentation.kind
      || persisted.title !== presentation.title
      || persisted.description !== presentation.description
      || canonicalJson(persisted.tradeoffs)
        !== canonicalJson(presentation.tradeoffs)
      || persisted.recommended !== presentation.recommended
      || (persisted.candidatePlan === undefined)
        !== (candidatePlan === undefined)
    ) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_persisted_intervention_mismatch',
        'A sealed Provider intervention option does not match its immutable admitted record.'
      );
    }
    if (!candidatePlan || !persisted.candidatePlan) {
      return presentation;
    }
    const admittedCandidatePlan = {
      ...cloneJson(persisted.candidatePlan),
      carriedSettlementRefs: [],
    };
    assertPersistedProviderPlanV2(
      input,
      candidatePlan,
      admittedCandidatePlan,
      recordedAt
    );
    return {
      ...presentation,
      candidatePlan: admittedCandidatePlan,
    };
  });
  return {
    kind: 'intervention',
    items: cloneJson(output.items),
    completion: cloneJson(output.completion),
    proposal: {
      problemSummary: normalized.problemSummary,
      ...(normalized.recommendation
        ? { recommendation: normalized.recommendation }
        : {}),
      relevantFactRefs: [...normalized.relevantFactRefs],
      affectedPlanActionIds: [...normalized.affectedPlanActionIds],
      options,
    },
    control: cloneJson(output.control),
    providerResult: cloneJson(output.providerResult),
  };
}

function assertPersistedProviderPlanV2(
  input: SessionKernelProviderAdapterInputV2,
  normalized: SessionProviderPlanDraftV2,
  persistedPlan: SessionNaturalLanguagePlanV2,
  recordedAt: string
): void {
  const normalizedEvidence = {
    kernelFactRefs: persistedPlan.evidence.kernelFactRefs,
    readResources: persistedPlan.evidence.readResources.map((resource) => ({
      resourceRef: resource.resourceRef,
      summary: resource.summary,
      factRefs: resource.factRefs,
    })),
    blockingUnknowns: persistedPlan.evidence.blockingUnknowns,
    nonBlockingUnknowns: persistedPlan.evidence.nonBlockingUnknowns,
    coverage: persistedPlan.evidence.coverage,
  };
  const digest = sha256Hash(canonicalJson({
    providerTurnId: input.providerTurnId,
    runId: input.runId,
    plan: {
      ...normalized,
      evidence: persistedPlan.evidence,
    },
  })).slice('sha256:'.length);
  const planRevision = `plan-${digest}`;
  const predecessorPlanRef = input.plan
    ? {
        planRevision: input.plan.planRevision,
        planDigest: sha256Hash(canonicalJson(input.plan)),
      }
    : undefined;
  const expectedActions = normalized.actions.map((action, index) => {
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
        kind: 'contractDefault' as const,
        data: {},
      },
    };
  });
  if (
    persistedPlan.runId !== input.runId
    || persistedPlan.inputId !== input.currentInput.inputId
    || persistedPlan.controlEpoch !== input.controlEpoch
    || persistedPlan.recordedAt !== recordedAt
    || persistedPlan.planRevision !== planRevision
    || persistedPlan.title !== normalized.title
    || persistedPlan.objective !== normalized.objective
    || persistedPlan.narrative !== normalized.narrative
    || canonicalJson(normalizedEvidence)
      !== canonicalJson(normalized.evidence)
    || canonicalJson(persistedPlan.predecessorPlanRef)
      !== canonicalJson(predecessorPlanRef)
    || persistedPlan.carriedSettlementRefs.length !== 0
    || canonicalJson(persistedPlan.actions)
      !== canonicalJson(expectedActions)
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_persisted_plan_mismatch',
      'The sealed Provider proposal does not match its immutable admitted Plan record.'
    );
  }
}

const RECOVERABLE_PLAN_EVIDENCE_ERROR_CODES_V1 = [
  'session_kernel_provider_plan_evidence_stale',
  'session_kernel_provider_plan_resource_evidence_mismatch',
  'session_kernel_provider_plan_blocking_unknowns',
  'session_kernel_provider_plan_evidence_debt_unresolved',
] as const;

type RecoverablePlanEvidenceErrorCodeV1 =
  typeof RECOVERABLE_PLAN_EVIDENCE_ERROR_CODES_V1[number];

type PlanEvidenceRefreshV1 = Extract<
  SessionProviderTurnOutputV2,
  { kind: 'planEvidenceRefresh' }
>['refresh'];

function isRecoverablePlanEvidenceErrorV1(
  error: unknown
): error is SessionKernelProviderAdapterError & {
  code: RecoverablePlanEvidenceErrorCodeV1;
} {
  return error instanceof SessionKernelProviderAdapterError
    && RECOVERABLE_PLAN_EVIDENCE_ERROR_CODES_V1.some(
      (code) => code === error.code
    );
}

function planEvidenceRefreshV1(
  input: SessionKernelProviderAdapterInputV2,
  draft: SessionProviderPlanDraftV2,
  errorCode: RecoverablePlanEvidenceErrorCodeV1,
  proposalArgumentsDigest: string
): PlanEvidenceRefreshV1 {
  const normalized = normalizePlanDraft(draft);
  const kernelFacts = input.kernelFacts ?? {
    snapshotHighWater: 0,
    omittedCount: 0,
    facts: [],
  };
  const currentFactIds = [...new Set(
    kernelFacts.facts
      .filter((fact) =>
        fact.lineage.runId === input.runId
        && fact.lineage.controlEpoch === input.controlEpoch
      )
      .map((fact) => fact.factId)
  )].sort();
  const currentFactIdSet = new Set(currentFactIds);
  const proposedFactRefs = [
    ...normalized.evidence.kernelFactRefs,
    ...normalized.evidence.readResources.flatMap(
      (resource) => resource.factRefs
    ),
  ];
  const staleFactRefs = [...new Set(
    proposedFactRefs.filter((factRef) => !currentFactIdSet.has(factRef))
  )].sort();
  const candidateScopeDigest = planCandidateScopeDigestV1(normalized);
  const pendingDebt = pendingPlanEvidenceDebtV1(input, normalized);
  const matchedHistoricalCandidates = input.sessionMemory.historicalReadCandidates
    .filter((candidate) =>
      staleFactRefs.includes(candidate.sourceFactId)
      || normalized.evidence.readResources.some((resource) =>
        candidate.resourceRefs.includes(resource.resourceRef)
      )
    );
  const resourceRefs = [...new Set(
    [
      ...normalized.evidence.readResources.map(
        (resource) => resource.resourceRef
      ),
      ...matchedHistoricalCandidates
        .flatMap((candidate) => candidate.resourceRefs),
    ]
  )].sort();
  const readSubjectDigests = [...new Set([
    ...matchedHistoricalCandidates.map((candidate) => candidate.subjectDigest),
    ...(pendingDebt?.readSubjectDigests ?? []),
  ])].sort();
  const blockingUnknownIds = normalized.evidence.blockingUnknowns
    .map((unknown) => unknown.unknownId)
    .sort();
  const requiresCurrentRead = pendingDebt?.requiresCurrentRead === true
    || staleFactRefs.length > 0
    || resourceRefs.length > 0
    || readSubjectDigests.length > 0;
  return {
    errorCode,
    staleFactRefs,
    resourceRefs,
    readSubjectDigests,
    blockingUnknownIds,
    candidateScopeDigest,
    requiresCurrentRead,
    snapshotHighWater: kernelFacts.snapshotHighWater,
    factSetDigest: sha256Hash(canonicalJson({
      schemaVersion: 'deepcode.session.plan-evidence-fact-set.v1',
      snapshotHighWater: kernelFacts.snapshotHighWater,
      omittedCount: kernelFacts.omittedCount,
      factIds: currentFactIds,
    })),
    evidenceDebtDigest: sha256Hash(canonicalJson({
      schemaVersion: 'deepcode.session.plan-evidence-debt.v1',
      errorCode,
      proposalArgumentsDigest,
      candidateScopeDigest,
      requiresCurrentRead,
      staleFactRefs,
      resourceRefs,
      readSubjectDigests,
      blockingUnknownIds,
    })),
  };
}

function planEvidenceRefreshGuidanceV1(
  refresh: PlanEvidenceRefreshV1
): string {
  const reasons = [
    refresh.staleFactRefs.length > 0
      ? `${refresh.staleFactRefs.length} cited fact reference(s) are outside the current canonical Kernel snapshot`
      : undefined,
    refresh.readSubjectDigests.length > 0
      ? `${refresh.readSubjectDigests.length} previously observed read subject(s) require current canonical revalidation`
      : refresh.resourceRefs.length > 0
        ? 'the cited resource instances require replacement by current canonical read evidence'
      : undefined,
    refresh.blockingUnknownIds.length > 0
      ? `${refresh.blockingUnknownIds.length} blocking unknown(s) remain`
      : undefined,
    refresh.requiresCurrentRead
      ? 'the current mutation scope still requires at least one canonical read observation'
      : undefined,
  ].filter((value): value is string => value !== undefined);
  return [
    'The proposed mutation Plan was not admitted and grants no authority.',
    reasons.length > 0 ? `Reason: ${reasons.join('; ')}.` : '',
    'Prior conversation text and old Run facts are semantic reference only.',
    'Use the ready read tools to revalidate the directly relevant resources, then cite only fact IDs supplied by the current planEvidenceAuthority frame.',
    'Do not guess, translate, or substitute fact IDs. If permitted reads cannot eliminate a blocking unknown, ask one concise clarification question instead of resubmitting the same Plan.',
  ].filter(Boolean).join(' ');
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
        !== SESSION_PROVIDER_PLAN_PROPOSAL_V5_SCHEMA
      || output.planProposal.toolName
        !== SESSION_PROVIDER_PLAN_PROPOSAL_V5_TOOL_NAME
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
  if (output.kind === 'intervention') {
    if (
      output.control.schemaVersion
        !== SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_SCHEMA
      || output.control.toolName
        !== SESSION_PROVIDER_INTERVENTION_PROPOSAL_V1_TOOL_NAME
    ) {
      throw providerCompletionInvalid();
    }
    requiredIdentity(output.control.callId, 'intervention.callId');
    requiredDigest(
      output.control.argumentsDigest,
      'intervention.argumentsDigest'
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
        || output.kind === 'intervention'
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
  if (input.target.kind === 'finalAnswer') {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_final_answer_tool_forbidden',
      'A final-answer Provider turn cannot return tool calls.'
    );
  }
  return descriptor;
}

export function materializeProviderPlanV2(
  input: Pick<
    SessionProviderTurnInputV2,
    | 'providerTurnId'
    | 'runId'
    | 'controlEpoch'
    | 'currentInput'
    | 'toolContext'
    | 'sessionMemory'
    | 'providerOutcomes'
    | 'plan'
  > & { kernelFacts?: SessionProviderTurnInputV2['kernelFacts'] },
  draft: SessionProviderPlanDraftV2,
  recordedAt: string
): SessionNaturalLanguagePlanV2 {
  const normalized = normalizePlanDraft(draft);
  if (normalized.evidence.blockingUnknowns.length > 0) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_blocking_unknowns',
      'An executable mutation Plan cannot be admitted while blocking unknowns remain.'
    );
  }
  const exactFacts = input.kernelFacts
    ? new Map(
        input.kernelFacts.facts
          .filter((fact) =>
            fact.lineage.runId === input.runId
            && fact.lineage.controlEpoch === input.controlEpoch
          )
          .map((fact) => [fact.factId, fact])
      )
    : undefined;
  const evidence = materializeProviderPlanEvidenceV5(
    normalized.evidence,
    exactFacts,
    input.controlEpoch,
    input.runId,
    input.sessionMemory.historicalReadCandidates
  );
  assertPendingPlanEvidenceDebtResolvedV1(input, normalized, evidence);
  const admittedPlanningTools = new Map(
    input.toolContext.tools
      .map((tool) => [tool.toolId, tool])
  );
  for (const action of normalized.actions) {
    const descriptor = admittedPlanningTools.get(action.toolId);
    if (!descriptor || descriptor.availability !== 'ready') {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_tool_unavailable',
        `Provider plan requested a tool outside the exact admitted planning catalog: ${action.toolId}.`
      );
    }
    if (descriptor.effectClass !== 'mutation') {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_read_action_invalid',
        `Provider Plan actions are mutation-only; ${action.toolId} must be executed as an automatically admitted read instead.`
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
    plan: {
      ...normalized,
      evidence,
    },
  })).slice('sha256:'.length);
  const planRevision = `plan-${digest}`;
  return {
    runId: input.runId,
    inputId: input.currentInput.inputId,
    controlEpoch: input.controlEpoch,
    planRevision,
    title: normalized.title,
    objective: normalized.objective,
    narrative: normalized.narrative,
    evidence,
    ...(input.plan
      ? {
          predecessorPlanRef: {
            planRevision: input.plan.planRevision,
            planDigest: sha256Hash(canonicalJson(input.plan)),
          },
        }
      : {}),
    carriedSettlementRefs: [],
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
    evidence: {
      kernelFactRefs: uniqueSortedIdentities(
        draft.evidence.kernelFactRefs,
        'plan.evidence.kernelFactRefs'
      ),
      readResources: draft.evidence.readResources.map((resource) => ({
        resourceRef: requiredIdentity(
          resource.resourceRef,
          'plan.evidence.resourceRef'
        ),
        summary: requiredText(
          resource.summary,
          'plan.evidence.resourceSummary',
          64 * 1024
        ),
        factRefs: uniqueSortedIdentities(
          resource.factRefs,
          'plan.evidence.resourceFactRefs'
        ),
      })),
      blockingUnknowns: normalizePlanUnknownsV4(
        draft.evidence.blockingUnknowns,
        'plan.evidence.blockingUnknowns'
      ),
      nonBlockingUnknowns: normalizePlanUnknownsV4(
        draft.evidence.nonBlockingUnknowns,
        'plan.evidence.nonBlockingUnknowns'
      ),
      coverage: requiredText(
        draft.evidence.coverage,
        'plan.evidence.coverage',
        64 * 1024
      ),
    },
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

function planCandidateScopeDigestV1(
  draft: SessionProviderPlanDraftV2
): string {
  const actions = draft.actions.map((action) => canonicalJson({
    toolId: action.toolId,
    scopeIntent: action.scopeIntent,
  })).sort();
  return sha256Hash(canonicalJson({
    schemaVersion: 'deepcode.session.plan-candidate-scope.v1',
    actions,
  }));
}

function pendingPlanEvidenceDebtV1(
  input: Pick<SessionProviderTurnInputV2, 'providerOutcomes'>,
  draft: SessionProviderPlanDraftV2
): SessionProviderPlanEvidenceRefreshV1 | undefined {
  const candidateScopeDigest = planCandidateScopeDigestV1(draft);
  for (let index = input.providerOutcomes.length - 1; index >= 0; index -= 1) {
    const outcome = input.providerOutcomes[index]!;
    if (outcome.outputKind === 'plan') return undefined;
    if (
      outcome.outputKind === 'planEvidenceRefresh'
      && outcome.refresh.candidateScopeDigest === candidateScopeDigest
    ) {
      return outcome.refresh;
    }
  }
  return undefined;
}

function assertPendingPlanEvidenceDebtResolvedV1(
  input: Pick<SessionProviderTurnInputV2, 'providerOutcomes'>,
  draft: SessionProviderPlanDraftV2,
  evidence: SessionPlanEvidenceV4
): void {
  const pending = pendingPlanEvidenceDebtV1(input, draft);
  if (!pending) return;
  const reboundSubjects = new Set(
    evidence.historicalRebinds.map((rebind) => rebind.subjectDigest)
  );
  if (
    (pending.requiresCurrentRead && evidence.readResources.length === 0)
    || pending.readSubjectDigests.some(
      (subjectDigest) => !reboundSubjects.has(subjectDigest)
    )
  ) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_evidence_debt_unresolved',
      'The current mutation scope still lacks the current-Run read evidence required by its latest Plan evidence rejection.'
    );
  }
}

function materializeProviderPlanEvidenceV5(
  evidence: SessionProviderPlanEvidenceDraftV4,
  exactFacts: ReadonlyMap<string, KernelFactProjectionV2> | undefined,
  controlEpoch: number,
  runId: string,
  historicalCandidates: SessionProviderTurnInputV2['sessionMemory']['historicalReadCandidates']
): SessionPlanEvidenceV4 {
  const evidenceFactRefs = new Set(evidence.kernelFactRefs);
  for (const resource of evidence.readResources) {
    resource.factRefs.forEach((factRef) => evidenceFactRefs.add(factRef));
  }
  for (const factRef of evidenceFactRefs) {
    if (!exactFacts?.has(factRef)) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_evidence_stale',
        `Plan evidence references a Kernel fact outside the exact current snapshot: ${factRef}.`
      );
    }
  }

  const canonicalResourceRefs = new Set<string>();
  const historicalRebinds: SessionPlanEvidenceV4['historicalRebinds'] = [];
  const readResources = evidence.readResources.map((resource) => {
    const referencedFacts = resource.factRefs.map(
      (factRef) => exactFacts!.get(factRef)!
    );
    const operationIds = new Set(
      referencedFacts.flatMap((fact) =>
        fact.lineage.operationId ? [fact.lineage.operationId] : []
      )
    );
    const relatedFacts = [...exactFacts!.values()].filter((fact) =>
      resource.factRefs.includes(fact.factId)
      || (
        fact.lineage.operationId !== undefined
        && operationIds.has(fact.lineage.operationId)
      )
    );
    const candidates = relatedFacts.flatMap((fact) =>
      canonicalReadEvidenceCandidatesV5(
        fact,
        controlEpoch,
        relatedFacts
      )
    );
    const exactMatches = candidates.filter(
      (candidate) => candidate.resourceRef === resource.resourceRef
    );
    const selected = exactMatches.length === 1
      ? exactMatches[0]
      : undefined;
    if (!selected) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_resource_evidence_mismatch',
        `Plan evidence resource ${resource.resourceRef} does not resolve to one canonical read observation.`
      );
    }
    if (canonicalResourceRefs.has(selected.resourceRef)) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_evidence_duplicate',
        `Plan evidence resolves more than once to ${selected.resourceRef}.`
      );
    }
    canonicalResourceRefs.add(selected.resourceRef);
    const historical = [...historicalCandidates]
      .filter((candidate) =>
        candidate.sourceRunId !== runId
        && candidate.subjectDigest === selected.subjectDigest
      )
      .sort((left, right) =>
        right.sourceEventVersion - left.sourceEventVersion
        || right.sourceEventId.localeCompare(left.sourceEventId)
        || right.candidateDigest.localeCompare(left.candidateDigest)
      )[0];
    if (historical) {
      const withoutId = {
        sourceEventId: historical.sourceEventId,
        sourceEventDigest: historical.sourceEventDigest,
        sourceEventVersion: historical.sourceEventVersion,
        sourceRunId: historical.sourceRunId,
        sourceFactId: historical.sourceFactId,
        sourceControlEpoch: historical.sourceControlEpoch,
        sourceOperationId: historical.sourceOperationId,
        sourceToolId: historical.toolId,
        subjectDigest: historical.subjectDigest,
        sourceEvidenceDigest: historical.sourceEvidenceDigest,
        sourceCandidateDigest: historical.candidateDigest,
        currentRunId: runId,
        currentControlEpoch: controlEpoch,
        currentFactRef: selected.factRef,
        currentEvidenceDigest: selected.digest,
        resourceRef: selected.resourceRef,
        contentRelation: historical.sourceEvidenceDigest === selected.digest
          ? 'sameDigest' as const
          : 'changedDigest' as const,
      };
      historicalRebinds.push({
        rebindId: `historical-rebind-${sha256Hash(
          canonicalJson(withoutId)
        ).slice('sha256:'.length)}`,
        ...withoutId,
      });
    }
    return {
      resourceRef: selected.resourceRef,
      digest: selected.digest,
      summary: resource.summary,
      factRefs: uniqueSortedIdentities(
        resource.factRefs.includes(selected.factRef)
          ? resource.factRefs
          : [...resource.factRefs, selected.factRef],
        'plan.evidence.resourceFactRefs'
      ),
    };
  });

  return {
    kernelFactRefs: evidence.kernelFactRefs,
    readResources,
    historicalRebinds,
    blockingUnknowns: evidence.blockingUnknowns,
    nonBlockingUnknowns: evidence.nonBlockingUnknowns,
    coverage: evidence.coverage,
  };
}

function canonicalReadEvidenceCandidatesV5(
  fact: KernelFactProjectionV2,
  controlEpoch: number,
  relatedFacts: readonly KernelFactProjectionV2[]
): Array<{
  resourceRef: string;
  digest: string;
  factRef: string;
  toolId: string;
  subjectDigest: string;
}> {
  if (
    fact.domain !== 'effect'
    || fact.lineage.controlEpoch !== controlEpoch
    || !SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2.has(
      fact.factKind
    )
  ) return [];
  const details = providerEvidenceRecordV5(fact.details);
  const identity = providerEvidenceRecordV5(details?.identity);
  const authority = providerEvidenceRecordV5(identity?.authority);
  const digest = details?.evidenceDigest;
  const subjects = relatedFacts.flatMap((candidate) => {
    if (
      candidate.factKind !== 'toolIntentAdmitted'
      || candidate.lineage.operationId !== fact.lineage.operationId
    ) return [];
    const admission = providerEvidenceRecordV5(candidate.details);
    const admissionIdentity = providerEvidenceRecordV5(admission?.identity);
    const admissionAuthority = providerEvidenceRecordV5(
      admissionIdentity?.authority
    );
    if (
      admissionAuthority?.kind !== 'read'
      || typeof admission?.toolId !== 'string'
      || !admission.toolId
      || typeof admission.canonicalArgumentsDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(
        admission.canonicalArgumentsDigest
      )
      || typeof admission.workspaceBindingDigest !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(
        admission.workspaceBindingDigest
      )
    ) return [];
    return [{
      toolId: admission.toolId,
      subjectDigest: sha256Hash(canonicalJson({
        schemaVersion: 'deepcode.session.read-subject.v1',
        toolId: admission.toolId,
        canonicalArgumentsDigest: admission.canonicalArgumentsDigest,
        workspaceBindingDigest: admission.workspaceBindingDigest,
      })),
    }];
  });
  const uniqueSubjects = [...new Map(
    subjects.map((subject) => [canonicalJson(subject), subject])
  ).values()];
  const subject = uniqueSubjects.length === 1
    ? uniqueSubjects[0]
    : undefined;
  if (
    authority?.kind !== 'read'
    || !subject
    || typeof digest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(digest)
  ) {
    return [];
  }
  const affectedResourceIds = details?.affectedResourceIds;
  const affected = Array.isArray(affectedResourceIds)
    ? affectedResourceIds.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : [];
  const resourceRefs = [...new Set([
    ...affected,
    ...fact.lineage.resourceIds,
  ])];
  return resourceRefs.map((resourceRef) => ({
    resourceRef,
    digest,
    factRef: fact.factId,
    toolId: subject.toolId,
    subjectDigest: subject.subjectDigest,
  }));
}

function providerEvidenceRecordV5(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeInterventionDraftV1(
  draft: SessionProviderInterventionDraftV1
): SessionProviderInterventionDraftV1 {
  if (draft.options.length < 1 || draft.options.length > 16) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_intervention_options_invalid',
      'Provider intervention options must contain 1..=16 entries.'
    );
  }
  const optionIds = new Set<string>();
  return {
    problemSummary: requiredText(
      draft.problemSummary,
      'intervention.problemSummary',
      64 * 1024
    ),
    ...(draft.recommendation !== undefined
      ? {
          recommendation: requiredText(
            draft.recommendation,
            'intervention.recommendation',
            64 * 1024
          ),
        }
      : {}),
    relevantFactRefs: uniqueSortedIdentities(
      draft.relevantFactRefs,
      'intervention.relevantFactRefs'
    ),
    affectedPlanActionIds: uniqueSortedIdentities(
      draft.affectedPlanActionIds,
      'intervention.affectedPlanActionIds'
    ),
    options: draft.options.map((option) => {
      const optionId = requiredIdentity(
        option.optionId,
        'intervention.optionId'
      );
      if (!optionIds.add(optionId)) {
        throw new SessionKernelProviderAdapterError(
          'session_kernel_provider_intervention_option_duplicate',
          `Provider intervention repeats optionId ${optionId}.`
        );
      }
      if (
        (option.kind === 'executable') !== Boolean(option.candidatePlan)
      ) {
        throw new SessionKernelProviderAdapterError(
          'session_kernel_provider_intervention_option_shape_invalid',
          'Executable intervention options require candidatePlan and guidance-only options must omit it.'
        );
      }
      if (option.tradeoffs.length < 1 || option.tradeoffs.length > 32) {
        throw new SessionKernelProviderAdapterError(
          'session_kernel_provider_intervention_tradeoffs_invalid',
          'Each intervention option must contain 1..=32 material tradeoffs.'
        );
      }
      return {
        optionId,
        kind: option.kind,
        title: requiredText(
          option.title,
          'intervention.option.title',
          64 * 1024
        ),
        description: requiredText(
          option.description,
          'intervention.option.description',
          64 * 1024
        ),
        tradeoffs: option.tradeoffs.map((tradeoff) => requiredText(
          tradeoff,
          'intervention.option.tradeoff',
          64 * 1024
        )),
        recommended: option.recommended,
        ...(option.candidatePlan
          ? { candidatePlan: normalizePlanDraft(option.candidatePlan) }
          : {}),
      };
    }),
  };
}

function materializeProviderInterventionV1(
  input: SessionKernelProviderAdapterInputV2,
  draft: SessionProviderInterventionDraftV1,
  recordedAt: string
): SessionProviderInterventionProposalV1 {
  const normalized = normalizeInterventionDraftV1(draft);
  return {
    ...normalized,
    options: normalized.options.map((option) => {
      const { candidatePlan, ...presentation } = option;
      return {
        ...presentation,
        ...(candidatePlan
        ? {
            candidatePlan: materializeProviderPlanV2(
              input,
              candidatePlan,
              recordedAt
            ),
          }
        : {}),
      };
    }),
  };
}

function uniqueSortedIdentities(
  values: readonly string[],
  field: string
): string[] {
  const normalized = values.map((value) => requiredIdentity(value, field));
  if (new Set(normalized).size !== normalized.length) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_evidence_duplicate',
      `${field} must contain unique identities.`
    );
  }
  return normalized.sort();
}

function normalizePlanUnknownsV4(
  values: readonly SessionProviderPlanUnknownDraftV4[],
  field: string
): SessionProviderPlanUnknownDraftV4[] {
  if (values.length > 128) {
    throw new SessionKernelProviderAdapterError(
      'session_kernel_provider_plan_unknowns_invalid',
      `${field} exceeds the bounded evidence contract.`
    );
  }
  const ids = new Set<string>();
  return values.map((value) => {
    const unknownId = requiredIdentity(value.unknownId, `${field}.unknownId`);
    if (!ids.add(unknownId)) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_unknowns_duplicate',
        `${field} repeats unknownId ${unknownId}.`
      );
    }
    return {
      unknownId,
      question: requiredText(value.question, `${field}.question`, 64 * 1024),
      impact: requiredText(value.impact, `${field}.impact`, 64 * 1024),
    };
  });
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
