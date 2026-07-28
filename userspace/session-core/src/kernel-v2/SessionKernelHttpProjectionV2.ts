import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
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
      lastDeltaSeq: agentEvents.length,
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
    case 'scope.previewed':
      if (data?.kind === 'rejected') {
        return {
          kind: 'permission_result',
          channel: 'tool',
          visibility: 'conversation',
          fields: {
            status: 'denied',
            decision: 'deny',
            guidance: nestedText(data, ['data', 'guidance']),
            operationId: textField(data, 'operationId'),
          },
        };
      }
      return permissionRequestPresentation(event, data);
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
      return {
        kind: 'permission_result',
        channel: 'tool',
        visibility: 'conversation',
        fields: {
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
    case 'planAction.skipped':
      return {
        kind: 'workflow_stage',
        channel: 'task',
        visibility: 'both',
        fields: {
          status: 'skipped',
          planActionId: textField(data, 'planActionId'),
          summary: textField(data, 'reason')
            ?? 'Plan action skipped.',
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
        },
      };
    }
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
