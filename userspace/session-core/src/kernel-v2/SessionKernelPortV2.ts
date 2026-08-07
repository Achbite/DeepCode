import {
  KERNEL_ABI_V2_VERSION,
  decodeKernelCommandResponseEnvelopeV2,
  type CapabilityScopePreviewBatchReplyV2,
  type CapabilityScopePreviewItemV2,
  type ControlEpochAdvancedReplyV2,
  type EpochPreconditionV2,
  type InvocationCancelReplyV2,
  type InvocationCancelTargetV2,
  type KernelCommandEnvelopeV2,
  type KernelCommandV2,
  type KernelFactProjectionPageV2,
  type RunOpenReplyV2,
  type ToolContextGetReplyV2,
  type ToolContextRefV2,
  type ToolIntentSubmitReplyV2,
  type ToolIntentV2,
} from '@deepcode/protocol';

export interface SessionKernelRunRefV2 {
  runId: string;
  workspaceBindingDigest: string;
}

export interface SessionKernelCommandRequestV2 {
  requestId: string;
  signal?: AbortSignal;
}

export interface SessionKernelCapabilityPreviewBatchRequestV2
  extends SessionKernelCommandRequestV2 {
  expectedControlEpoch: number;
  planRevision: string;
  items: CapabilityScopePreviewItemV2[];
  toolContextRef: ToolContextRefV2;
}

export interface SessionKernelToolIntentRequestV2
  extends SessionKernelCommandRequestV2 {
  intent: ToolIntentV2;
}

export interface SessionKernelFactsRequestV2
  extends SessionKernelCommandRequestV2 {
  afterLedgerSequence: number;
  limit: number;
  continuation?: string;
}

export interface SessionKernelEpochAdvanceRequestV2
  extends SessionKernelCommandRequestV2 {
  precondition: EpochPreconditionV2;
  inputId: string;
  opaqueInputRef: string;
}

export interface SessionKernelInvocationCancelRequestV2
  extends SessionKernelCommandRequestV2 {
  expectedControlEpoch: number;
  target: InvocationCancelTargetV2;
  reasonCode: 'userRequested' | 'epochSuperseded';
  reason?: string;
}

/**
 * Semantic Session port. Run capability is deliberately absent from every
 * method and result exposed to the Loop.
 */
export interface SessionKernelPortV2 {
  readonly run: SessionKernelRunRefV2;

  getToolContext(
    request: SessionKernelCommandRequestV2 & {
      knownContext?: ToolContextRefV2;
    }
  ): Promise<ToolContextGetReplyV2>;

  previewCapabilityBatch(
    request: SessionKernelCapabilityPreviewBatchRequestV2
  ): Promise<CapabilityScopePreviewBatchReplyV2>;

  submitToolIntent(
    request: SessionKernelToolIntentRequestV2
  ): Promise<ToolIntentSubmitReplyV2>;

  queryFacts(
    request: SessionKernelFactsRequestV2
  ): Promise<KernelFactProjectionPageV2>;

  advanceControlEpoch(
    request: SessionKernelEpochAdvanceRequestV2
  ): Promise<ControlEpochAdvancedReplyV2>;

  cancelInvocation(
    request: SessionKernelInvocationCancelRequestV2
  ): Promise<InvocationCancelReplyV2>;
}

export interface SessionKernelCommandTransportV2 {
  send(
    envelope: KernelCommandEnvelopeV2,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    signal?: AbortSignal
  ): Promise<unknown>;
}

/**
 * Transport-private authentication. This value must never cross into Loop
 * ports, checkpoints, Prompt input, facts, diagnostics, or error text.
 */
export interface SessionKernelTransportPrivateAuthV2 {
  runCapability: string;
}

interface SessionKernelReplyDataByKindV2 {
  toolContext: ToolContextGetReplyV2;
  capabilityScopePreviewBatchResult: CapabilityScopePreviewBatchReplyV2;
  toolIntentSubmission: ToolIntentSubmitReplyV2;
  kernelFactsProjected: KernelFactProjectionPageV2;
  controlEpochAdvanced: ControlEpochAdvancedReplyV2;
  invocationCancelResult: InvocationCancelReplyV2;
}

export interface HttpKernelCommandTransportV2Options {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: () => HeadersInit;
}

const MAX_KERNEL_V2_HTTP_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * Raw HTTP seam. Host-provided authentication is carried only in a transport
 * header and is never serialized into the command JSON or diagnostics.
 */
export class HttpKernelCommandTransportV2
implements SessionKernelCommandTransportV2 {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: () => HeadersInit;

  constructor(options: HttpKernelCommandTransportV2Options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
    this.headers = options.headers ?? (() => ({}));
  }

  async send(
    envelope: KernelCommandEnvelopeV2,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    signal?: AbortSignal
  ): Promise<unknown> {
    const headers = new Headers(this.headers());
    headers.set('content-type', 'application/json');
    headers.set(
      'x-deepcode-run-capability',
      privateAuth.runCapability
    );
    const response = await this.fetchImpl(
      `${this.baseUrl}/api/kernel/v2/commands`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
        signal,
      }
    );
    if (!response.ok) {
      const transportError = await decodeHttpTransportError(
        response,
        envelope.requestId
      );
      throw new SessionKernelPortError(
        'session_kernel_transport_http_failed',
        `Kernel v2 command failed with HTTP ${response.status}${
          transportError.code ? ` (${transportError.code})` : ''
        }.`,
        transportError.disposition
      );
    }
    return readBoundedJsonResponse(response);
  }
}

/**
 * Transport-bound adapter. #runCapability is never exposed by the semantic
 * port, error text, Prompt types, facts state, or public run reference.
 */
export class TransportSessionKernelPortV2 implements SessionKernelPortV2 {
  readonly run: SessionKernelRunRefV2;
  readonly #runCapability: string;

  constructor(
    runOpen: RunOpenReplyV2,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    private readonly transport: SessionKernelCommandTransportV2
  ) {
    this.run = Object.freeze({
      runId: runOpen.runId,
      workspaceBindingDigest: runOpen.workspaceBindingDigest,
    });
    this.#runCapability = privateAuth.runCapability;
  }

  async getToolContext(
    request: SessionKernelCommandRequestV2 & {
      knownContext?: ToolContextRefV2;
    }
  ): Promise<ToolContextGetReplyV2> {
    const reply = await this.exchange(
      request.requestId,
      {
        kind: 'toolContextGet',
        data: {
          runId: this.run.runId,
          ...(request.knownContext
            ? { knownContext: { ...request.knownContext } }
            : {}),
        },
      },
      'toolContext',
      request.signal
    );
    if (
      reply.kind === 'current'
      && request.knownContext
      && !sameToolContextRef(reply.data.contextRef, request.knownContext)
    ) {
      throw new SessionKernelPortError(
        'session_kernel_context_reply_mismatch',
        'Kernel current ToolContext reference does not match the submitted reference.'
      );
    }
    return reply;
  }

  async previewCapabilityBatch(
    request: SessionKernelCapabilityPreviewBatchRequestV2
  ): Promise<CapabilityScopePreviewBatchReplyV2> {
    const reply = await this.exchange(
      request.requestId,
      {
        kind: 'capabilityScopePreviewBatch',
        data: {
          runId: this.run.runId,
          expectedControlEpoch: request.expectedControlEpoch,
          planRevision: request.planRevision,
          items: request.items.map((item) => ({ ...item })),
          toolContextRef: request.toolContextRef,
        },
      },
      'capabilityScopePreviewBatchResult',
      request.signal
    );
    if (
      reply.runId !== this.run.runId
      || reply.acceptedControlEpoch !== request.expectedControlEpoch
      || reply.planRevision !== request.planRevision
      || reply.results.length !== request.items.length
    ) {
      throw new SessionKernelPortError(
        'session_kernel_scope_preview_batch_correlation_mismatch',
        'Kernel scope preview batch does not match the submitted Plan identity.'
      );
    }
    for (const [index, item] of request.items.entries()) {
      const result = reply.results[index]!;
      const correlation = result.kind === 'previewed'
        ? result.data.preview
        : result.data;
      if (
        correlation.planActionId !== item.planActionId
        || correlation.operationId !== item.operationId
        || correlation.toolId !== item.toolId
        || (
          result.kind === 'previewed'
          && (
            result.data.preview.runId !== this.run.runId
            || result.data.preview.controlEpoch
              !== request.expectedControlEpoch
            || result.data.preview.planRevision !== request.planRevision
            || !sameToolContextRef(
              result.data.preview.contextRef,
              request.toolContextRef
            )
          )
        )
      ) {
        throw new SessionKernelPortError(
          'session_kernel_scope_preview_batch_correlation_mismatch',
          'Kernel scope preview batch item does not match the submitted PlanAction identity.'
        );
      }
    }
    return reply;
  }

  async submitToolIntent(
    request: SessionKernelToolIntentRequestV2
  ): Promise<ToolIntentSubmitReplyV2> {
    if (request.intent.runId !== this.run.runId) {
      throw new SessionKernelPortError(
        'session_kernel_run_mismatch',
        'ToolIntent belongs to a different Kernel run.',
        'deterministic'
      );
    }
    const reply = await this.exchange(
      request.requestId,
      {
        kind: 'toolIntentSubmit',
        data: { ...request.intent },
      },
      'toolIntentSubmission',
      request.signal
    );
    if (
      reply.data.runId !== this.run.runId
      || reply.data.operationId !== request.intent.operationId
    ) {
      throw new SessionKernelPortError(
        'session_kernel_tool_intent_correlation_mismatch',
        'Kernel ToolIntent reply does not match the submitted run and operation.'
      );
    }
    if (
      reply.kind !== 'rejected'
      && reply.data.acceptedControlEpoch !== request.intent.expectedControlEpoch
    ) {
      throw new SessionKernelPortError(
        'session_kernel_tool_intent_epoch_mismatch',
        'Kernel admitted ToolIntent under an unexpected control epoch.'
      );
    }
    return reply;
  }

  async queryFacts(
    request: SessionKernelFactsRequestV2
  ): Promise<KernelFactProjectionPageV2> {
    const page = await this.exchange(
      request.requestId,
      {
        kind: 'kernelFactsQueryScoped',
        data: {
          runId: this.run.runId,
          afterLedgerSequence: request.afterLedgerSequence,
          limit: request.limit,
          ...(request.continuation
            ? { continuation: request.continuation }
            : {}),
        },
      },
      'kernelFactsProjected',
      request.signal
    );
    if (
      page.requestedAfterLedgerSequence !== request.afterLedgerSequence
    ) {
      throw new SessionKernelPortError(
        'session_kernel_fact_page_correlation_mismatch',
        'Kernel facts page does not match the submitted cursor.'
      );
    }
    return page;
  }

  async advanceControlEpoch(
    request: SessionKernelEpochAdvanceRequestV2
  ): Promise<ControlEpochAdvancedReplyV2> {
    const reply = await this.exchange(
      request.requestId,
      {
        kind: 'controlEpochAdvance',
        data: {
          runId: this.run.runId,
          precondition: request.precondition,
          inputId: request.inputId,
          opaqueInputRef: request.opaqueInputRef,
        },
      },
      'controlEpochAdvanced',
      request.signal
    );
    const expectedEpoch = request.precondition.kind === 'noCurrentEpoch'
      ? 1
      : request.precondition.data.controlEpoch + 1;
    if (
      reply.runId !== this.run.runId
      || reply.acceptedControlEpoch !== expectedEpoch
    ) {
      throw new SessionKernelPortError(
        'session_kernel_epoch_advance_correlation_mismatch',
        'Kernel epoch advance reply does not match the submitted run and precondition.'
      );
    }
    return reply;
  }

  async cancelInvocation(
    request: SessionKernelInvocationCancelRequestV2
  ): Promise<InvocationCancelReplyV2> {
    const reply = await this.exchange(
      request.requestId,
      {
        kind: 'invocationCancel',
        data: {
          runId: this.run.runId,
          expectedControlEpoch: request.expectedControlEpoch,
          target: request.target,
          reasonCode: request.reasonCode,
          ...(request.reason ? { reason: request.reason } : {}),
        },
      },
      'invocationCancelResult',
      request.signal
    );
    if (
      reply.kind === 'noActiveInvocation'
      && (
        reply.data.runId !== this.run.runId
        || reply.data.controlEpoch !== request.expectedControlEpoch
      )
    ) {
      throw new SessionKernelPortError(
        'session_kernel_cancel_correlation_mismatch',
        'Kernel cancellation reply does not match the submitted run and epoch.'
      );
    }
    if (
      request.target.kind === 'exact'
      && reply.kind !== 'noActiveInvocation'
      && reply.data.invocationId !== request.target.data.invocationId
    ) {
      throw new SessionKernelPortError(
        'session_kernel_cancel_correlation_mismatch',
        'Kernel cancellation reply does not match the submitted invocation.'
      );
    }
    return reply;
  }

  private async exchange<K extends keyof SessionKernelReplyDataByKindV2>(
    requestId: string,
    command: KernelCommandV2,
    expectedKind: K,
    signal?: AbortSignal
  ): Promise<SessionKernelReplyDataByKindV2[K]> {
    if (
      !requestId
      || new TextEncoder().encode(requestId).byteLength > 512
      || requestId.trim() !== requestId
      || /[\u0000-\u001f\u007f-\u009f]/u.test(requestId)
    ) {
      throw new SessionKernelPortError(
        'session_kernel_request_identity_invalid',
        'Kernel requestId must be a bounded identity without surrounding whitespace or control characters.',
        'deterministic'
      );
    }
    const wire = await this.transport.send(
      {
        abiVersion: KERNEL_ABI_V2_VERSION,
        requestId,
        command,
      },
      { runCapability: this.#runCapability },
      signal
    );
    const envelope = decodeKernelCommandResponseEnvelopeV2(wire);
    if (envelope.kind === 'uncorrelatedWireFailure') {
      throw new SessionKernelPortError(
        'session_kernel_uncorrelated_wire_failure',
        `Kernel rejected the command envelope: ${envelope.data.error.kind}.`
      );
    }
    if (envelope.data.requestId !== requestId) {
      throw new SessionKernelPortError(
        'session_kernel_response_correlation_mismatch',
        'Kernel response requestId does not match the submitted command.'
      );
    }
    if (envelope.data.reply.kind === 'error') {
      throw new SessionKernelPortError(
        'session_kernel_command_rejected',
        `Kernel rejected the command: ${envelope.data.reply.data.kind}.`,
        'deterministic'
      );
    }
    if (envelope.data.reply.kind !== expectedKind) {
      throw new SessionKernelPortError(
        'session_kernel_reply_kind_mismatch',
        `Kernel returned ${envelope.data.reply.kind}; expected ${expectedKind}.`
      );
    }
    return envelope.data.reply.data as SessionKernelReplyDataByKindV2[K];
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const candidate = value ?? (
    typeof globalThis.location === 'object'
      ? globalThis.location.origin
      : undefined
  );
  if (
    !candidate
    || candidate.trim() !== candidate
    || candidate.includes('?')
    || candidate.includes('#')
  ) {
    throw invalidKernelBaseUrl();
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw invalidKernelBaseUrl();
  }
  const schemeDelimiter = candidate.indexOf('://');
  const authority = schemeDelimiter < 0
    ? ''
    : candidate
        .slice(schemeDelimiter + 3)
        .split('/')[0] ?? '';
  if (
    url.protocol !== 'http:'
    || !isLoopbackIpHostname(url.hostname)
    || authority.includes('@')
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
  ) {
    throw invalidKernelBaseUrl();
  }
  return url.origin;
}

function invalidKernelBaseUrl(): SessionKernelPortError {
  return new SessionKernelPortError(
    'session_kernel_transport_base_url_invalid',
    'Kernel v2 HTTP base URL must be an absolute loopback IP HTTP origin.',
    'deterministic'
  );
}

function isLoopbackIpHostname(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  if (normalized === '::1') return true;
  const octets = normalized.split('.');
  return octets.length === 4
    && octets.every(
      (octet) => /^\d{1,3}$/u.test(octet)
        && Number(octet) >= 0
        && Number(octet) <= 255
    )
    && Number(octets[0]) === 127;
}

function sameToolContextRef(
  left: ToolContextRefV2,
  right: ToolContextRefV2
): boolean {
  return left.contextVersion === right.contextVersion
    && left.catalogDigest === right.catalogDigest
    && left.contextDigest === right.contextDigest;
}

const KERNEL_HTTP_ERROR_CODES = new Set([
  'payload_too_large',
  'invalid_json',
  'duplicate_json_key',
  'missing_abi_version',
  'invalid_abi_version',
  'unsupported_abi_version',
  'invalid_payload',
  'host_authority_required',
  'host_authority_invalid',
  'run_capability_required',
  'run_capability_invalid',
  'workspace_binding_not_found',
  'workspace_binding_stale',
  'workspace_binding_unavailable',
  'decision_capability_required',
  'decision_capability_invalid',
  'decision_capability_expired',
  'decision_capability_binding_mismatch',
  'decision_capability_request_conflict',
  'decision_capability_in_use',
  'response_too_large',
  'service_unavailable',
]);

async function decodeHttpTransportError(
  response: Response,
  expectedRequestId: string
): Promise<{
  code?: string;
  disposition: SessionKernelPortFailureDispositionV2;
}> {
  let value: unknown;
  try {
    value = await readBoundedJsonResponse(response);
  } catch {
    return { disposition: 'unknown' };
  }
  if (!isRecord(value)) {
    return { disposition: dispositionForHttpStatus(response.status) };
  }
  const format = value.format;
  const code = value.code;
  const requestId = value.requestId;
  if (
    format !== 'deepcode.kernel.http-error.v2'
    || typeof code !== 'string'
    || !KERNEL_HTTP_ERROR_CODES.has(code)
    || (
      requestId !== undefined
      && (
        typeof requestId !== 'string'
        || requestId !== expectedRequestId
      )
    )
  ) {
    return { disposition: dispositionForHttpStatus(response.status) };
  }
  if (
    code === 'service_unavailable'
    || code === 'workspace_binding_unavailable'
  ) {
    return { code, disposition: 'unknown' };
  }
  return {
    code,
    disposition: dispositionForHttpStatus(response.status),
  };
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null
    && /^\d+$/u.test(declaredLength)
    && Number(declaredLength) > MAX_KERNEL_V2_HTTP_RESPONSE_BYTES
  ) {
    throw responseTooLarge();
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw invalidJsonResponse();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      if (
        next.value.byteLength
        > MAX_KERNEL_V2_HTTP_RESPONSE_BYTES - total
      ) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge();
      }
      total += next.value.byteLength;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidJsonResponse();
  }
}

function responseTooLarge(): SessionKernelPortError {
  return new SessionKernelPortError(
    'session_kernel_transport_response_too_large',
    `Kernel v2 response exceeded the ${MAX_KERNEL_V2_HTTP_RESPONSE_BYTES}-byte transport limit.`,
    'unknown'
  );
}

function invalidJsonResponse(): SessionKernelPortError {
  return new SessionKernelPortError(
    'session_kernel_transport_json_invalid',
    'Kernel v2 command returned an invalid JSON response.',
    'unknown'
  );
}

function dispositionForHttpStatus(
  status: number
): SessionKernelPortFailureDispositionV2 {
  return [
    400,
    401,
    403,
    404,
    409,
    410,
    413,
    422,
    426,
  ].includes(status)
    ? 'deterministic'
    : 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type SessionKernelPortFailureDispositionV2 =
  | 'deterministic'
  | 'unknown';

export class SessionKernelPortError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly disposition: SessionKernelPortFailureDispositionV2 = 'unknown'
  ) {
    super(message);
    this.name = 'SessionKernelPortError';
  }
}
