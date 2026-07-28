import {
  canonicalJson,
  sha256Hash,
} from '../cache/canonicalizer.js';
import type {
  SessionKernelHostProjectionSinkV2,
} from './SessionKernelHttpPersistenceV2.js';
import type {
  SessionKernelProjectionEventV2,
} from './types.js';

export const SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA =
  'deepcode.session.kernel-host-projection-request.v2' as const;
export const SESSION_KERNEL_HOST_PROJECTION_REPLY_V2_SCHEMA =
  'deepcode.session.kernel-host-projection-reply.v2' as const;

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

  constructor(
    private readonly sessionId: string,
    private readonly hostRunId: string,
    apiBase: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    requiredIdentity(sessionId, 'sessionId');
    requiredIdentity(hostRunId, 'hostRunId');
    this.endpoint = [
      normalizeApiBase(apiBase),
      'api/agent/sessions',
      encodeURIComponent(sessionId),
      'runs',
      encodeURIComponent(hostRunId),
      'kernel-v2/projections',
    ].join('/');
  }

  async publish(event: SessionKernelProjectionEventV2): Promise<void> {
    assertNoTransportCapabilities(event);
    const projectionId = requiredIdentity(
      event.projectionId,
      'projectionId'
    );
    const projectionDigest = sha256Hash(canonicalJson(event));
    const request: SessionKernelHostProjectionRequestV2 = {
      schemaVersion:
        SESSION_KERNEL_HOST_PROJECTION_REQUEST_V2_SCHEMA,
      sessionId: this.sessionId,
      hostRunId: this.hostRunId,
      projectionId,
      projectionDigest,
      event: cloneJson(event),
    };
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
