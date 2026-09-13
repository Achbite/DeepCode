import type { PlanOperation, PlanProjection } from '@deepcode/protocol';

/** A presentation diff only: confirmation still addresses the complete published revision. */
export function planScopeAddition(previous: PlanProjection | undefined, current: PlanProjection): {
  reason: string; operations: PlanOperation[];
} | null {
  if (!previous || previous.planId !== current.planId || previous.runId !== current.runId
    || previous.title !== current.title || current.revision !== previous.revision + 1
    || previous.steps.length !== current.steps.length
    || previous.steps.some((step, index) => {
      const next = current.steps[index]!;
      return step.stepId !== next.stepId || step.title !== next.title || step.details !== next.details
        || JSON.stringify(step.verification ?? []) !== JSON.stringify(next.verification ?? []);
    })) return null;
  const prefix = `${previous.summary}\n\n`;
  if (!current.summary.startsWith(prefix)) return null;
  const reason = current.summary.slice(prefix.length).trim();
  const before = new Set(previous.mutationManifest.map((item) => JSON.stringify(item)));
  const after = new Set(current.mutationManifest.map((item) => JSON.stringify(item)));
  if (!reason || [...before].some((item) => !after.has(item))) return null;
  const operations = current.mutationManifest.filter((item) => !before.has(JSON.stringify(item)));
  return operations.length ? { reason, operations } : null;
}
