import {
  consumeSessionKernelPrivateProcessBindingFromEnvV2,
} from './kernel-v2/PrefetchedSessionKernelHostRunAdapterV2.js';
import {
  SESSION_KERNEL_PRODUCTION_MAX_FRAME_BYTES,
  SessionKernelProductionActorV2,
  type SessionKernelProductionSettledFrameV2,
} from './kernel-v2/SessionKernelProductionBridgeV2.js';

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stdout: {
    write(
      value: string,
      callback?: (error?: Error | null) => void
    ): boolean;
  };
  stderr: { write(value: string): boolean };
};

const MAX_IN_FLIGHT_FRAMES = 64;

async function main(): Promise<void> {
  try {
    // Consume and remove the inherited capability before reading any
    // untrusted request bytes. The value never enters frame JSON or output.
    const privateBinding =
      consumeSessionKernelPrivateProcessBindingFromEnvV2(
        process.env
      );
    const actor = new SessionKernelProductionActorV2(
      privateBinding.privateAuth,
      privateBinding.apiBase
    );
    const inFlight = new Set<Promise<void>>();
    let observedFrame = false;

    for await (const encoded of readBoundedStdinFrames()) {
      observedFrame = true;
      let value: unknown;
      try {
        value = JSON.parse(encoded) as unknown;
      } catch {
        throw new HostBridgeV2InputError(
          'session_kernel_production_frame_json_invalid'
        );
      }
      const task = actor.submitFrame(value)
        .then((frame) => writeResponseFrame(frame));
      inFlight.add(task);
      void task.then(
        () => inFlight.delete(task),
        () => inFlight.delete(task)
      );
      if (inFlight.size >= MAX_IN_FLIGHT_FRAMES) {
        await Promise.race(inFlight);
      }
    }
    if (!observedFrame) {
      throw new HostBridgeV2InputError(
        'session_kernel_production_frame_missing'
      );
    }
    await Promise.all(inFlight);
    await stdoutWrites;
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(`[FAIL] ${safeErrorCode(error)}\n`);
  }
}

let stdoutWrites: Promise<void> = Promise.resolve();

function writeResponseFrame(
  settled: SessionKernelProductionSettledFrameV2
): Promise<void> {
  const write = stdoutWrites.then(() =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(settled.encodedLine, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    })
  );
  stdoutWrites = write;
  return write;
}

async function* readBoundedStdinFrames(): AsyncGenerator<string> {
  let parts: Uint8Array[] = [];
  let frameBytes = 0;
  for await (const chunk of process.stdin) {
    const bytes = stdinChunkBytes(chunk);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.byteLength : newline;
      const part = bytes.subarray(offset, end);
      frameBytes += part.byteLength;
      if (
        frameBytes
          > SESSION_KERNEL_PRODUCTION_MAX_FRAME_BYTES
      ) {
        throw new HostBridgeV2InputError(
          'session_kernel_production_frame_too_large'
        );
      }
      if (part.byteLength > 0) parts.push(part);
      if (newline === -1) break;
      const payload = joinFrameParts(parts, frameBytes);
      const withoutCarriageReturn =
        payload[payload.byteLength - 1] === 0x0d
          ? payload.subarray(0, payload.byteLength - 1)
          : payload;
      if (withoutCarriageReturn.byteLength === 0) {
        throw new HostBridgeV2InputError(
          'session_kernel_production_frame_empty'
        );
      }
      try {
        yield new TextDecoder('utf-8', { fatal: true })
          .decode(withoutCarriageReturn);
      } catch {
        throw new HostBridgeV2InputError(
          'session_kernel_production_frame_utf8_invalid'
        );
      }
      parts = [];
      frameBytes = 0;
      offset = newline + 1;
    }
  }
  if (frameBytes !== 0) {
    throw new HostBridgeV2InputError(
      'session_kernel_production_frame_unterminated'
    );
  }
}

function stdinChunkBytes(chunk: unknown): Uint8Array {
  if (typeof chunk === 'string') {
    return new TextEncoder().encode(chunk);
  }
  if (chunk instanceof Uint8Array) return chunk;
  throw new HostBridgeV2InputError(
    'session_kernel_production_frame_chunk_invalid'
  );
}

function joinFrameParts(
  parts: readonly Uint8Array[],
  byteLength: number
): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function safeErrorCode(error: unknown): string {
  const candidate =
    error && typeof error === 'object' && !Array.isArray(error)
      ? error as { code?: unknown }
      : undefined;
  return typeof candidate?.code === 'string'
    && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(candidate.code)
      ? candidate.code
      : 'session_kernel_production_actor_failed';
}

class HostBridgeV2InputError extends Error {
  constructor(readonly code: string) {
    super('Session Kernel v2 actor input framing is invalid.');
    this.name = 'HostBridgeV2InputError';
  }
}

void main();
