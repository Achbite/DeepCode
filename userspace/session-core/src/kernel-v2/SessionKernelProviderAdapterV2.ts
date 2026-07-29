import {
  decodeRawToolArgumentsV2,
  type DeadlineRequestV2,
  type RawToolArgumentsV2,
  type RequestedResourceV2,
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
import {
  decodeProviderToolIntentTextFrameV2,
  SESSION_TOOL_INTENT_TEXT_FRAME_V2,
} from './toolIntent.js';
import type {
  SessionNaturalLanguagePlanV2,
  SessionProviderResultMetadataV2,
  SessionProviderTurnInputV2,
  SessionProviderTurnOutputV2,
} from './types.js';

export interface SessionProviderPlanActionDraftV2 {
  toolId: string;
  requestedResources: RequestedResourceV2[];
  previewArguments: RawToolArgumentsV2;
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

export type SessionKernelProviderBackendOutputV2 = (
  | {
      kind: 'plan';
      plan: SessionProviderPlanDraftV2;
    }
  | {
      kind: 'nativeToolCall';
      callId: string;
      toolId: string;
      arguments: unknown;
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
  providerResult: SessionProviderResultMetadataV2;
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

/**
 * Only a provider-native tool call or one exact standalone ToolIntent frame
 * enters the executable lane. Prose, fenced JSON, and embedded objects remain
 * answers and can never trigger execution.
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
          plan: materializeProviderPlanV2(
            input,
            output.plan,
            this.clock.now()
          ),
          providerResult: output.providerResult,
        };
      case 'nativeToolCall':
        const nativeToolId =
          requiredToolId(output.toolId);
        requirePermittedTool(input, nativeToolId);
        return {
          kind: 'toolIntent',
          source: {
            source: 'providerNative',
            callId: requiredIdentity(output.callId, 'callId'),
            toolId: nativeToolId,
            arguments: output.arguments,
          },
          providerResult: output.providerResult,
        };
      case 'text':
        if (!output.text.trim()) {
          return {
            kind: 'noTool',
            providerResult: output.providerResult,
          };
        }
        requiredText(output.text, 'Provider text', 1024 * 1024);
        if (claimsToolIntentFrame(output.text)) {
          const frame =
            decodeProviderToolIntentTextFrameV2(output.text);
          requirePermittedTool(input, frame.toolId);
          return {
            kind: 'toolIntent',
            source: {
              source: 'textFrame',
              frame: output.text,
            },
            providerResult: output.providerResult,
          };
        }
        return {
          kind: 'answer',
          text: output.text,
          providerResult: output.providerResult,
        };
      case 'noTool':
        return {
          kind: 'noTool',
          ...(output.guidance?.trim()
            ? { guidance: output.guidance }
            : {}),
          providerResult: output.providerResult,
        };
    }
  }
}

function requirePermittedTool(
  input: SessionProviderTurnInputV2,
  toolId: string
): void {
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
  const readyToolIds = new Set(
    input.toolContext.tools.map((tool) => tool.toolId)
  );
  for (const action of normalized.actions) {
    if (!readyToolIds.has(action.toolId)) {
      throw new SessionKernelProviderAdapterError(
        'session_kernel_provider_plan_tool_unavailable',
        `Provider plan requested a tool outside the current ready ToolContext: ${action.toolId}.`
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
          requestedResources: action.requestedResources,
        }),
        previewArguments: action.previewArguments,
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
        action.requestedResources.length === 0
        || action.requestedResources.length > 256
      ) {
        throw new SessionKernelProviderAdapterError(
          'session_kernel_provider_plan_resources_invalid',
          'Provider plan requestedResources must contain 1..=256 entries.'
        );
      }
      return {
        toolId: requiredToolId(action.toolId),
        requestedResources:
          action.requestedResources.map(cloneRequestedResource),
        previewArguments:
          decodeRawToolArgumentsV2(action.previewArguments),
        ...(action.deadline
          ? { deadline: cloneDeadline(action.deadline) }
          : {}),
      };
    }),
  };
}

function claimsToolIntentFrame(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return record.schemaVersion === SESSION_TOOL_INTENT_TEXT_FRAME_V2
      || record.kind === 'toolIntent';
  } catch {
    return false;
  }
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
    case 'exactInvocation':
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

export class SessionKernelProviderAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelProviderAdapterError';
  }
}
