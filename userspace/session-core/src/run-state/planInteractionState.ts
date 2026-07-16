export function planInteractionAwaitsDecision(payload: Record<string, unknown>): boolean {
  return payload.confirmable === true;
}
