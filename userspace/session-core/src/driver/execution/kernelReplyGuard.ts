import type { KernelReply } from '@deepcode/protocol';

export function kernelReplyErrorMessage(reply: KernelReply, fallback: string): string {
  const message = reply.error?.message?.trim();
  const code = reply.error?.code?.trim();
  if (message && code) return `${code}: ${message}`;
  return message || code || fallback;
}

export function assertKernelReplyOk(
  reply: KernelReply,
  createError: (code: string, message: string) => Error,
  code: string,
  fallback: string
): void {
  if (reply.ok) return;
  if ((reply.events ?? []).length > 0) return;
  throw createError(code, kernelReplyErrorMessage(reply, fallback));
}
