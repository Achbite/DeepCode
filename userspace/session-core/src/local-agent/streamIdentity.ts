/** Display identity only: native output indexes and aggregate turn text remain distinct. */
export function providerTextStreamId(
  sessionId: string,
  runId: string,
  providerRequestId: string,
  outputIndex?: number,
): string {
  return `provider-stream:${JSON.stringify([
    sessionId, runId, providerRequestId, outputIndex ?? 'aggregate',
  ])}`;
}
