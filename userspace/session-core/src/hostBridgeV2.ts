import {
  consumeSessionKernelRunCapabilityFromEnvV2,
} from './kernel-v2/PrefetchedSessionKernelHostRunAdapterV2.js';
import {
  executeSessionKernelProductionRequestV2,
  sessionKernelProductionFailureV2,
} from './kernel-v2/SessionKernelProductionBridgeV2.js';

declare const process: {
  env: Record<string, string | undefined>;
  exitCode?: number;
  stdin: AsyncIterable<unknown>;
  stdout: { write(value: string): boolean };
};

const MAX_STDIN_BYTES = 4 * 1024 * 1024;

async function main(): Promise<void> {
  try {
    // Consume and remove the inherited capability before reading any
    // untrusted request bytes. The value never enters request JSON or output.
    const privateAuth =
      consumeSessionKernelRunCapabilityFromEnvV2(process.env);
    const value = JSON.parse(await readBoundedStdin()) as unknown;
    const result = await executeSessionKernelProductionRequestV2(
      value,
      privateAuth
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.exitCode = 1;
    process.stdout.write(
      `${JSON.stringify(sessionKernelProductionFailureV2(error))}\n`
    );
  }
}

async function readBoundedStdin(): Promise<string> {
  const decoder = new TextEncoder();
  let bytes = 0;
  let value = '';
  for await (const chunk of process.stdin) {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    bytes += decoder.encode(text).byteLength;
    if (bytes > MAX_STDIN_BYTES) {
      throw new HostBridgeV2InputError();
    }
    value += text;
  }
  if (!value.trim()) throw new HostBridgeV2InputError();
  return value;
}

class HostBridgeV2InputError extends Error {
  readonly code = 'session_kernel_production_input_invalid';

  constructor() {
    super('Session Kernel v2 input is missing or too large.');
    this.name = 'HostBridgeV2InputError';
  }
}

void main();
