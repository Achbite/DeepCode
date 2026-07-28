import {
  decodeRunOpenReplyV2,
  type RunOpenReplyV2,
} from '@deepcode/protocol';
import type {
  SessionKernelHostRunAdapterV2,
  SessionKernelHostRunBindingV2,
  SessionKernelHostRunOpenRequestV2,
} from './SessionKernelHostAdaptersV2.js';
import {
  TransportSessionKernelPortV2,
  type SessionKernelCommandTransportV2,
  type SessionKernelTransportPrivateAuthV2,
} from './SessionKernelPortV2.js';

export const SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA =
  'deepcode.session.prefetched-kernel-run.v2' as const;
export const SESSION_KERNEL_RUN_CAPABILITY_ENV_V2 =
  'DEEPCODE_SESSION_RUN_CAPABILITY_V2' as const;

export interface SessionKernelPrefetchedRunDescriptorV2 {
  schemaVersion: typeof SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA;
  workspaceBindingRef: string;
  inputId: string;
  opaqueInputRef: string;
  runOpenReply: RunOpenReplyV2;
}

/**
 * Daemon performs Host-only RunOpen before spawning Session. This adapter
 * accepts only the safe reply and captures the transport credential in the
 * semantic Kernel port's private field.
 */
export class PrefetchedSessionKernelHostRunAdapterV2
implements SessionKernelHostRunAdapterV2 {
  readonly #descriptor: SessionKernelPrefetchedRunDescriptorV2;
  readonly #binding: SessionKernelHostRunBindingV2;

  constructor(
    descriptor: SessionKernelPrefetchedRunDescriptorV2,
    privateAuth: SessionKernelTransportPrivateAuthV2,
    transport: SessionKernelCommandTransportV2
  ) {
    this.#descriptor = cloneJson(descriptor);
    const kernel = new TransportSessionKernelPortV2(
      descriptor.runOpenReply,
      privateAuth,
      transport
    );
    this.#binding = {
      kernel,
      controlEpoch: descriptor.runOpenReply.controlEpoch,
      toolContext: cloneJson(descriptor.runOpenReply.toolContext),
    };
  }

  async openRun(
    request: SessionKernelHostRunOpenRequestV2
  ): Promise<SessionKernelHostRunBindingV2> {
    if (request.signal?.aborted) {
      throw abortReason(request.signal);
    }
    if (
      request.workspaceBindingRef !== this.#descriptor.workspaceBindingRef
      || request.inputId !== this.#descriptor.inputId
      || request.opaqueInputRef !== this.#descriptor.opaqueInputRef
    ) {
      throw new PrefetchedSessionKernelRunError(
        'session_kernel_prefetched_run_identity_mismatch',
        'Session RunOpen request does not match the Host-prefetched Run identity.'
      );
    }
    return {
      kernel: this.#binding.kernel,
      controlEpoch: this.#binding.controlEpoch,
      toolContext: cloneJson(this.#binding.toolContext),
    };
  }
}

export function decodeSessionKernelPrefetchedRunDescriptorV2(
  value: unknown
): SessionKernelPrefetchedRunDescriptorV2 {
  const record = exactRecord(value, [
    'schemaVersion',
    'workspaceBindingRef',
    'inputId',
    'opaqueInputRef',
    'runOpenReply',
  ]);
  if (record.schemaVersion !== SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA) {
    throw new PrefetchedSessionKernelRunError(
      'session_kernel_prefetched_run_schema_unsupported',
      'Host-prefetched Kernel Run uses an unsupported schema.'
    );
  }
  return {
    schemaVersion: SESSION_KERNEL_PREFETCHED_RUN_V2_SCHEMA,
    workspaceBindingRef: identity(
      record.workspaceBindingRef,
      'workspaceBindingRef'
    ),
    inputId: identity(record.inputId, 'inputId'),
    opaqueInputRef: boundedText(
      record.opaqueInputRef,
      'opaqueInputRef'
    ),
    runOpenReply: decodeRunOpenReplyV2(record.runOpenReply),
  };
}

/**
 * Process-private transport seam. The value is consumed once and deleted
 * immediately. Callers must never place it in request JSON or diagnostics.
 */
export function consumeSessionKernelRunCapabilityFromEnvV2(
  environment: Record<string, string | undefined>
): SessionKernelTransportPrivateAuthV2 {
  const value = environment[SESSION_KERNEL_RUN_CAPABILITY_ENV_V2];
  delete environment[SESSION_KERNEL_RUN_CAPABILITY_ENV_V2];
  if (
    !value
    || value.length < 16
    || value.length > 2_048
    || ![...value].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e;
    })
  ) {
    throw new PrefetchedSessionKernelRunError(
      'session_kernel_run_capability_unavailable',
      'Process-private Kernel Run transport capability is unavailable.'
    );
  }
  return { runCapability: value };
}

function exactRecord(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidDescriptor();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])
  ) {
    throw invalidDescriptor();
  }
  return record;
}

function identity(value: unknown, field: string): string {
  const text = boundedText(value, field);
  if (
    text.trim() !== text
    || /[\u0000-\u001f\u007f-\u009f]/u.test(text)
  ) {
    throw invalidDescriptor();
  }
  return text;
}

function boundedText(value: unknown, _field: string): string {
  if (
    typeof value !== 'string'
    || !value
    || new TextEncoder().encode(value).byteLength > 64 * 1024
  ) {
    throw invalidDescriptor();
  }
  return value;
}

function invalidDescriptor(): PrefetchedSessionKernelRunError {
  return new PrefetchedSessionKernelRunError(
    'session_kernel_prefetched_run_invalid',
    'Host-prefetched Kernel Run descriptor is invalid.'
  );
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Host-prefetched Kernel Run was aborted.');
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class PrefetchedSessionKernelRunError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'PrefetchedSessionKernelRunError';
  }
}
