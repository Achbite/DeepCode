import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import {
  AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2,
} from '@deepcode/protocol';
import type {
  AgentEvent,
  AgentEventChannel,
  AgentEventKind,
  AgentEventVisibility,
  AgentTimelineResult,
} from '@deepcode/protocol';
import {
  CanonicalTimelineProjector,
} from '../timelineDelta.js';
import type {
  SessionKernelHostProjectionSinkV2,
} from './SessionKernelHttpPersistenceV2.js';
import type {
  SessionKernelProjectionEventV2,
} from './types.js';
import type {
  SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';

export const SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-host-projection-request.v2' as const;
export const SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-host-projection-reply.v2' as const;
export const SESSION_KERNEL_PUBLIC_PROJECTION_V2_SCHEMA =
  'deepcode.session.kernel-public-projection.v2' as const;

export interface SessionKernelPublicProjectionPayloadV2 {
  schemaVersion: typeof SESSION_KERNEL_PUBLIC_PROJECTION_V2_SCHEMA;
  projectionId: string;
  runId: string;
  projectionKind: SessionKernelProjectionEventV2['kind'];
  channel: AgentEventChannel;
  visibility: AgentEventVisibility;
  status?: string;
  summary?: string;
  [key: string]: unknown;
}

/**
 * Rust Host broker request body for:
 * POST /api/agent/sessions/:sessionId/runs/:hostRunId/kernel-v2/projections
 */
export interface SessionKernelHostProjectionRequestV2 {
  schemaVersion:
    typeof SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA;
  sessionId: string;
  hostRunId: string;
  projectionId: string;
  projectionDigest: string;
  event: SessionKernelProjectionEventV2;
  agentEvent: AgentEvent;
  timeline: AgentTimelineResult;
}

/**
 * The Host applies projectionId+projectionDigest idempotently. A repeated
 * projectionId with different content must return HTTP 409.
 */
export interface SessionKernelHostProjectionReplyV2 {
  schemaVersion:
    typeof SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA;
  projectionId: string;
  projectionDigest: string;
  replayed: boolean;
}

export class HttpSessionKernelHostProjectionSinkV2
implements SessionKernelHostProjectionSinkV2 {
  private readonly endpoint: string;
  readonly #runCapability: string;

  constructor(
    private readonly sessionId: string,
    private readonly hostRunId: string,
    apiBase: string,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    requiredIdentity(sessionId, 'sessionId');
    requiredIdentity(hostRunId, 'hostRunId');
    this.#runCapability = requiredIdentity(
      privateAuth.runCapability,
      'runCapability'
    );
    this.endpoint = [
      normalizeApiBase(apiBase),
      'api/agent/sessions',
      encodeURIComponent(sessionId),
      'runs',
      encodeURIComponent(hostRunId),
      'kernel-v2/projections',
    ].join('/');
  }

  async publish(
    event: SessionKernelProjectionEventV2,
    projectionHistory: SessionKernelProjectionEventV2[]
  ): Promise<void> {
    assertNoTransportCapabilities(event);
    const projectionId = requiredIdentity(
      event.projectionId,
      'projectionId'
    );
    const agentEvent = sessionKernelAgentEventV2(
      this.sessionId,
      event
    );
    const agentEvents = projectionHistory.map(
      (projection) =>
        sessionKernelAgentEventV2(this.sessionId, projection)
    );
    const projected = new CanonicalTimelineProjector(
      this.sessionId,
      agentEvents
    ).snapshot();
    const timeline: AgentTimelineResult = {
      ...projected,
      revision: agentEvents.length,
      sourceEventVersion: agentEvents.length,
      generatedAt: event.recordedAt,
    };
    if (
      agentEvents.at(-1)?.id !== agentEvent.id
      || timeline.sessionId !== this.sessionId
      || timeline.eventCount !== agentEvents.length
      || timeline.sourceEventVersion !== agentEvents.length
    ) {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_timeline_snapshot_identity_mismatch',
        'Canonical timeline does not cover the current durable AgentEvent prefix.'
      );
    }
    const projectionDigest = sha256Hash(canonicalJson({
      event,
      agentEvent,
      timeline,
    }));
    const request: SessionKernelHostProjectionRequestV2 = {
      schemaVersion:
        SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA,
      sessionId: this.sessionId,
      hostRunId: this.hostRunId,
      projectionId,
      projectionDigest,
      event: cloneJson(event),
      agentEvent,
      timeline,
    };
    assertNoTransportCapabilities(request);
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-deepcode-run-capability': this.#runCapability,
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      if (response.status === 409) {
        throw new SessionKernelProjectionTransportError(
          'session_kernel_projection_identity_conflict',
          `Projection ${projectionId} conflicts with Host content.`
        );
      }
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_http_failed',
        `Session v2 projection failed with HTTP ${response.status}.`
      );
    }
    const envelope = exactObject(await response.json(), ['ok', 'data']);
    if (envelope.ok !== true) {
      throw invalidProjectionReply();
    }
    const data = exactObject(
      envelope.data,
      [
        'schemaVersion',
        'projectionId',
        'projectionDigest',
        'replayed',
      ]
    );
    if (
      data.schemaVersion
        !== SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA
      || data.projectionId !== projectionId
      || data.projectionDigest !== projectionDigest
      || typeof data.replayed !== 'boolean'
    ) {
      throw invalidProjectionReply();
    }
  }
}

/**
 * Session owns the semantic UI projection. Host persists and publishes this
 * AgentEvent unchanged; it must not infer Plan, permission, tool, or Review
 * meaning from the private kernel-v2 event.
 */
export function sessionKernelAgentEventV2(
  sessionId: string,
  event: SessionKernelProjectionEventV2
): AgentEvent {
  const data = objectRecord(event.data);
  const presentation = publicPresentation(event, data);
  return {
    id: `kernel-v2:${event.projectionId}`,
    sessionId,
    ts: event.recordedAt,
    kind: presentation.kind,
    payload: {
      schemaVersion: SESSION_KERNEL_PUBLIC_PROJECTION_V2_SCHEMA,
      projectionId: event.projectionId,
      runId: event.runId,
      projectionKind: event.kind,
      channel: presentation.channel,
      visibility: presentation.visibility,
      ...presentation.fields,
    } satisfies SessionKernelPublicProjectionPayloadV2,
  };
}

function publicPresentation(
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): {
  kind: AgentEventKind;
  channel: AgentEventChannel;
  visibility: AgentEventVisibility;
  fields: Record<string, unknown>;
} {
  switch (event.kind) {
    case 'input.persisted':
      return {
        kind: 'user_msg',
        channel: 'user',
        visibility: 'conversation',
        fields: {
          content: textField(data, 'text') ?? '',
          inputId: textField(data, 'inputId'),
          attachments: Array.isArray(data?.attachments)
            ? cloneJson(data.attachments)
            : [],
          controlEpoch: data?.controlEpoch,
        },
      };
    case 'plan.persisted':
      return {
        kind: 'plan_card',
        channel: 'task',
        visibility: 'both',
        fields: {
          planId: textField(data, 'planRevision'),
          planRevision: textField(data, 'planRevision'),
          title: textField(data, 'title') ?? 'Plan',
          summary: textField(data, 'objective')
            ?? textField(data, 'narrative')
            ?? 'Plan is ready for review.',
          userPlan: textField(data, 'narrative'),
          status: 'awaitingUserApproval',
          confirmable: true,
          tasks: Array.isArray(data?.actions)
            ? cloneJson(data.actions)
            : [],
        },
      };
    case 'plan.decided': {
      const decision = textField(data, 'decision');
      const status = decision === 'accept'
        ? 'accepted'
        : decision === 'reject'
          ? 'rejected'
          : 'needsRevision';
      return {
        kind: 'plan_review',
        channel: decision === 'accept' ? 'progress' : 'task',
        visibility: 'both',
        fields: {
          planId: textField(data, 'planRevision'),
          planRevision: textField(data, 'planRevision'),
          status,
          decision,
          guidance: textField(data, 'guidance'),
          confirmable: false,
          summary: decision === 'accept'
            ? 'Plan accepted for scoped execution.'
            : decision === 'reject'
              ? 'Plan rejected; replanning guidance recorded.'
              : 'Plan revision requested; guidance recorded.',
        },
      };
    }
    case 'scope.previewed':
      if (data?.kind === 'rejected') {
        return rejectedPlanScopePresentation(data);
      }
      return planScopePreviewPresentation(event, data);
    case 'capability.awaiting':
      return permissionRequestPresentation(event, data);
    case 'toolIntent.submitted':
      return {
        kind: 'tool_call',
        channel: 'tool',
        visibility: 'both',
        fields: {
          status: textField(data, 'replyKind') ?? 'submitted',
          operationId: textField(data, 'operationId'),
          requestId: textField(data, 'requestId'),
          toolId: textField(data, 'toolId'),
          controlEpoch: data?.expectedControlEpoch,
          authorityKind: textField(data, 'authorityKind'),
          planRevision: textField(data, 'planRevision'),
          planActionId: textField(data, 'planActionId'),
          summary: 'Kernel tool intent submitted.',
        },
      };
    case 'kernelFacts.reconciled':
      return {
        kind: 'tool_result',
        channel: 'observation',
        visibility: 'trace',
        fields: {
          status: 'reconciled',
          factIds: Array.isArray(data?.pageFactIds)
            ? cloneJson(data.pageFactIds)
            : [],
          snapshotHighWater: data?.snapshotHighWater,
          summary: 'Canonical Kernel facts reconciled.',
        },
      };
    case 'authorization.decided': {
      const factKind = textField(data, 'factKind');
      const allowed = factKind === 'capabilityIssued'
        || factKind === 'expansionAllowed';
      const lease = objectRecord(data?.capabilityLease);
      const previewId = textField(data, 'previewId');
      return {
        kind: 'permission_result',
        channel: 'tool',
        visibility: 'conversation',
        fields: {
          id: previewId,
          permissionId: previewId,
          previewId,
          status: allowed ? 'allowed' : 'denied',
          decision: allowed ? 'allow' : 'deny',
          factId: textField(data, 'factId'),
          factKind,
          operationId: textField(data, 'operationId'),
          planActionIds: Array.isArray(data?.planActionIds)
            ? cloneJson(data.planActionIds)
            : [],
          leaseId: textField(lease, 'leaseId'),
          leaseVersion: lease?.version,
          scopeDigest: textField(lease, 'scopeDigest'),
          scopeDelta: data?.scopeDelta === undefined
            ? undefined
            : cloneJson(data.scopeDelta),
          guidance: textField(data, 'guidance'),
          details: data?.details === undefined
            ? undefined
            : cloneJson(data.details),
          summary: allowed
            ? 'Canonical Kernel scope authorization recorded.'
            : 'Canonical Kernel scope denial recorded.',
        },
      };
    }
    case 'review.revised':
      return {
        kind: 'review_summary',
        channel: 'final',
        visibility: 'both',
        fields: {
          reviewId: `kernel-v2-review:${String(data?.revision ?? 'unknown')}`,
          status: data?.status === 'final'
            ? 'completed'
            : 'waitingUserReview',
          revision: data?.revision,
          snapshotHighWater: data?.snapshotHighWater,
          summary: data?.status === 'final'
            ? 'Review finalized from canonical Kernel facts.'
            : 'Review updated from canonical Kernel facts.',
          review: cloneJson(event.data),
        },
      };
    case 'planAction.completed':
      return {
        kind: 'workflow_stage',
        channel: 'task',
        visibility: 'both',
        fields: {
          status: 'completed',
          planActionId: textField(data, 'planActionId'),
          providerTurnId: textField(data, 'providerTurnId'),
          completionKind: textField(data, 'completionKind'),
          summary: 'Plan action completed by the Session provider loop.',
        },
      };
    case 'provider.completed': {
      const result = objectRecord(data?.result);
      return {
        kind: result?.kind === 'answer'
          ? 'assistant_msg'
          : 'workflow_stage',
        channel: result?.kind === 'answer' ? 'final' : 'progress',
        visibility: 'conversation',
        fields: {
          status: 'completed',
          content: textField(result, 'text'),
          outputKind: data?.outputKind,
          providerTurnId: data?.providerTurnId,
          controlEpoch: data?.controlEpoch,
          providerOutcome: data?.providerOutcome === undefined
            ? undefined
            : cloneJson(data.providerOutcome),
        },
      };
    }
    case 'provider.started':
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: 'running',
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          contextAssembly: data?.contextAssembly === undefined
            ? undefined
            : cloneJson(data.contextAssembly),
          summary: 'Session provider turn started.',
        },
      };
    case 'provider.stale':
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: 'cancelled',
          providerTurnId: textField(data, 'providerTurnId'),
          controlEpoch: data?.controlEpoch,
          summary: 'Session provider turn was superseded.',
        },
      };
    case 'wait.changed': {
      const wait = objectRecord(event.data);
      return {
        kind: 'session_run_state',
        channel: 'progress',
        visibility: 'conversation',
        fields: wait
          ? {
              status: 'waiting',
              reason: wait.kind,
              targetId: textField(wait, 'previewId')
                ?? textField(wait, 'invocationId')
                ?? textField(wait, 'operationId'),
              decisionKind: wait.kind === 'capability'
                ? 'permission'
                : undefined,
              summary: `Session is waiting for ${String(wait.kind)}.`,
            }
          : {
              status: 'running',
              reason: 'waitCleared',
              summary: 'Session wait cleared.',
            },
      };
    }
    case 'diagnostic':
      return {
        kind: 'error',
        channel: 'error',
        visibility: 'conversation',
        fields: {
          code: textField(data, 'code') ?? 'session_kernel_diagnostic',
          message: textField(data, 'message')
            ?? textField(data, 'stage')
            ?? 'Session Kernel diagnostic.',
        },
      };
    default:
      return {
        kind: 'workflow_stage',
        channel: 'progress',
        visibility: 'trace',
        fields: {
          status: event.kind,
          summary: `Session projection ${event.kind}.`,
        },
      };
  }
}

function planScopePreviewPresentation(
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const plan = objectRecord(data?.plan);
  const previews = scopePreviewRecords(data);
  const currentPreview = objectRecord(objectRecord(data?.data)?.preview);
  const planRevision = textField(plan, 'planRevision')
    ?? textField(currentPreview, 'planRevision')
    ?? textField(data, 'planRevision');
  const planId = planRevision ?? event.projectionId;
  const title = textField(plan, 'title') ?? 'Plan';
  const objective = textField(plan, 'objective')
    ?? textField(plan, 'narrative')
    ?? 'Plan is ready for review.';
  return {
    kind: 'plan_card',
    channel: 'task',
    visibility: 'both',
    fields: {
      planId,
      planRevision,
      title,
      summary: objective,
      userPlan: textField(plan, 'narrative'),
      status: 'awaitingUserApproval',
      confirmable: true,
      tasks: planTasksWithScopePreviews(plan, previews),
      scopePreviews: cloneJson(previews),
      scopeApprovalView: {
        planRevision,
        previews: previews.map((preview) => ({
          previewId: textField(preview, 'previewId'),
          planActionId: textField(preview, 'planActionId'),
          operationId: textField(preview, 'operationId'),
          toolId: textField(preview, 'toolId'),
          authorizationDigest:
            textField(preview, 'authorizationDigest'),
          approvalView: preview.approvalView === undefined
            ? undefined
            : cloneJson(preview.approvalView),
        })),
      },
      readablePlan: readablePlanScopeApproval(
        plan,
        planId,
        title,
        objective,
        previews
      ),
    },
  };
}

function rejectedPlanScopePresentation(
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const plan = objectRecord(data?.plan);
  const planRevision = textField(plan, 'planRevision')
    ?? textField(data, 'planRevision');
  const guidance = nestedText(data, ['data', 'guidance']);
  return {
    kind: 'plan_review',
    channel: 'task',
    visibility: 'both',
    fields: {
      planId: planRevision,
      planRevision,
      status: 'needsRevision',
      decision: 'revise',
      confirmable: false,
      guidance,
      operationId: textField(data, 'operationId'),
      planActionId: textField(data, 'planActionId'),
      summary: guidance
        ?? 'Kernel rejected a planned scope; replanning is required.',
    },
  };
}

function scopePreviewRecords(
  data: Record<string, unknown> | undefined
): Record<string, unknown>[] {
  const previews = Array.isArray(data?.scopePreviews)
    ? data.scopePreviews.flatMap((value) => {
        const preview = objectRecord(value);
        return preview ? [preview] : [];
      })
    : [];
  const current = objectRecord(objectRecord(data?.data)?.preview);
  if (
    current
    && !previews.some(
      (preview) =>
        textField(preview, 'previewId') === textField(current, 'previewId')
    )
  ) {
    previews.push(current);
  }
  return previews;
}

function planTasksWithScopePreviews(
  plan: Record<string, unknown> | undefined,
  previews: Record<string, unknown>[]
): unknown[] {
  if (!Array.isArray(plan?.actions)) return [];
  return plan.actions.map((value) => {
    const action = objectRecord(value);
    if (!action) return cloneJson(value);
    const manifest = objectRecord(action.manifest);
    const operationId = textField(manifest, 'operationId');
    const preview = previews.find(
      (candidate) =>
        textField(candidate, 'operationId') === operationId
    );
    return preview
      ? {
          ...cloneJson(action),
          scopePreview: cloneJson(preview),
          approvalView: preview.approvalView === undefined
            ? undefined
            : cloneJson(preview.approvalView),
        }
      : cloneJson(action);
  });
}

function readablePlanScopeApproval(
  plan: Record<string, unknown> | undefined,
  planId: string,
  title: string,
  objective: string,
  previews: Record<string, unknown>[]
): Record<string, unknown> {
  const actions = Array.isArray(plan?.actions)
    ? plan.actions.flatMap((value) => {
        const action = objectRecord(value);
        return action ? [action] : [];
      })
    : [];
  const readableTasks = actions.map((action, index) => {
    const manifest = objectRecord(action.manifest);
    const taskId = textField(action, 'taskId')
      ?? textField(manifest, 'planActionId')
      ?? `plan-action-${index + 1}`;
    const toolId = textField(manifest, 'toolId') ?? 'kernel.tool';
    const operationId = textField(manifest, 'operationId');
    return {
      taskId,
      title: toolId,
      objective: operationId
        ? `operationId=${operationId}`
        : undefined,
      targets: requestedResourceRefs(manifest),
      acceptance: [],
      failure: [],
      intentKind: toolId,
    };
  });
  return {
    schemaVersion: AGENT_TIMELINE_READABLE_PLAN_SCHEMA_V2,
    titleKey: 'session.projection.plan.title',
    title,
    summary: objective,
    sourceRefs: {
      planRevision: planId,
    },
    tasks: readableTasks,
    sections: [
      {
        sectionId: 'summary',
        titleKey: 'session.projection.plan.section.summary',
        items: [{
          itemId: 'summary',
          kind: 'text',
          text: textField(plan, 'narrative') ?? objective,
        }],
      },
      {
        sectionId: 'tasks',
        titleKey: 'session.projection.plan.section.tasks',
        emptyMessageKey: 'session.projection.plan.empty.tasks',
        items: readableTasks.map((task) => ({
          itemId: task.taskId,
          kind: 'task',
          text: task.title,
          targetRefs: task.targets,
          metadata: {
            objective: task.objective,
            acceptance: task.acceptance,
            failure: task.failure,
          },
        })),
      },
      {
        sectionId: 'scopeApproval',
        titleKey:
          'session.projection.plan.section.permissionBundles',
        emptyMessageKey:
          'session.projection.plan.empty.permissionBundles',
        items: previews.map(scopeApprovalProjectionItem),
      },
    ],
  };
}

function scopeApprovalProjectionItem(
  preview: Record<string, unknown>
): Record<string, unknown> {
  const approval = objectRecord(preview.approvalView);
  const previewId = textField(preview, 'previewId') ?? 'scope-preview';
  const toolId = textField(preview, 'toolId') ?? 'kernel.tool';
  const risk = textField(approval, 'risk')
    ?? textField(preview, 'risk')
    ?? 'unknown';
  const effectClass = textField(approval, 'effectClass')
    ?? textField(preview, 'effectClass')
    ?? 'unknown';
  const effectScope = textField(approval, 'effectScope')
    ?? textField(preview, 'effectScope')
    ?? 'unknown';
  const scopeDigest = textField(approval, 'scopeDigest')
    ?? textField(preview, 'scopeDigest')
    ?? 'unknown';
  const summary = textField(approval, 'summary')
    ?? 'Canonical Kernel scope';
  return {
    itemId: previewId,
    kind: 'permission',
    text: `${toolId}: ${summary} [risk=${risk}; effect=${effectClass}/${effectScope}; scopeDigest=${scopeDigest}]`,
    status: textField(preview, 'disposition'),
    targetRefs: stringArrayField(approval, 'canonicalTargets'),
    auditRefs: [
      previewId,
      scopeDigest,
      textField(preview, 'authorizationDigest'),
    ].filter((value): value is string => Boolean(value)),
    metadata: {
      objective: [
        `planActionId=${textField(preview, 'planActionId') ?? 'unknown'}`,
        `operationId=${textField(preview, 'operationId') ?? 'unknown'}`,
        `authorizationDigest=${
          textField(preview, 'authorizationDigest') ?? 'unknown'
        }`,
      ].join('; '),
      acceptance: stringArrayField(approval, 'scopeDelta'),
      failure: [],
    },
  };
}

function requestedResourceRefs(
  manifest: Record<string, unknown> | undefined
): string[] {
  if (!Array.isArray(manifest?.requestedResources)) return [];
  return manifest.requestedResources.flatMap((value) => {
    const resource = objectRecord(value);
    const kind = textField(resource, 'kind');
    const details = objectRecord(resource?.data);
    const target = textField(details, 'path')
      ?? textField(details, 'url')
      ?? textField(details, 'query')
      ?? textField(details, 'invocationDigest')
      ?? textField(details, 'area');
    if (kind && target) return [`${kind}:${target}`];
    return kind ? [kind] : [];
  });
}

function permissionRequestPresentation(
  event: SessionKernelProjectionEventV2,
  data: Record<string, unknown> | undefined
): ReturnType<typeof publicPresentation> {
  const preview = objectRecord(data?.preview)
    ?? objectRecord(objectRecord(data?.data)?.preview);
  const operationId = textField(data, 'operationId')
    ?? textField(preview, 'operationId');
  const previewId = textField(preview, 'previewId')
    ?? event.projectionId;
  return {
    kind: 'permission_request',
    channel: 'tool',
    visibility: 'conversation',
    fields: {
      id: previewId,
      permissionId: previewId,
      requestKind: 'scopeExpansion',
      operationId,
      affectedOperationIds: operationId ? [operationId] : [],
      toolName: textField(preview, 'toolId') ?? 'kernel.tool',
      riskLevel: textField(preview, 'risk') ?? 'medium',
      summary: 'Review the exact canonical Kernel scope.',
      argumentsPreview: preview ? cloneJson(preview) : null,
      preview: preview ? cloneJson(preview) : undefined,
      status: 'awaitingUserDecision',
    },
  };
}

function nestedText(
  value: Record<string, unknown> | undefined,
  path: string[]
): string | undefined {
  let current: unknown = value;
  for (const key of path) current = objectRecord(current)?.[key];
  return typeof current === 'string' ? current : undefined;
}

function textField(
  value: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' ? candidate : undefined;
}

function stringArrayField(
  value: Record<string, unknown> | undefined,
  key: string
): string[] {
  const candidate = value?.[key];
  return Array.isArray(candidate)
    ? candidate.filter(
        (item): item is string => typeof item === 'string'
      )
    : [];
}

function objectRecord(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidProjectionReply();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidProjectionReply();
  }
  return record;
}

function requiredIdentity(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.trim() !== value
    || new TextEncoder().encode(value).byteLength > 512
    || /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new SessionKernelProjectionTransportError(
      'session_kernel_projection_identity_invalid',
      `${field} is not a valid bounded identity.`
    );
  }
  return value;
}

function assertNoTransportCapabilities(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertNoTransportCapabilities);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'runCapability' || key === 'decisionCapability') {
      throw new SessionKernelProjectionTransportError(
        'session_kernel_projection_secret_forbidden',
        'Transport capabilities cannot enter Session projection.'
      );
    }
    assertNoTransportCapabilities(nested);
  }
}

function normalizeApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidApiBase();
  }
  const authority = value
    .split('://')[1]
    ?.split('/')[0] ?? '';
  const hostname = url.hostname.startsWith('[')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  const loopback = hostname === '::1'
    || (
      hostname.split('.').length === 4
      && hostname.split('.').every(
        (part) =>
          /^\d{1,3}$/u.test(part)
          && Number(part) >= 0
          && Number(part) <= 255
      )
      && Number(hostname.split('.')[0]) === 127
    );
  if (
    value.trim() !== value
    || url.protocol !== 'http:'
    || !loopback
    || authority.includes('@')
    || url.username
    || url.password
    || url.search
    || url.hash
    || !['', '/'].includes(url.pathname)
  ) {
    throw invalidApiBase();
  }
  return url.origin;
}

function invalidApiBase(): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'session_kernel_projection_api_base_invalid',
    'Session v2 projection requires an absolute loopback HTTP origin.'
  );
}

function invalidProjectionReply(): SessionKernelProjectionTransportError {
  return new SessionKernelProjectionTransportError(
    'session_kernel_projection_response_invalid',
    'Host returned an invalid Session v2 projection acknowledgement.'
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SessionKernelProjectionTransportError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SessionKernelProjectionTransportError';
  }
}
