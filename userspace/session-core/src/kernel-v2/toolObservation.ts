import type { KernelFactProjectionV2 } from '@deepcode/protocol';
import type {
  SessionProviderKernelFactsProjectionV2,
  SessionProviderOutcomeRecordV2,
  SessionProviderSettledToolCallV2,
  SessionToolCorrectionV2,
} from './types.js';
import {
  SESSION_KERNEL_FACT_KINDS_V2,
  SESSION_KERNEL_OBSERVED_EFFECT_FACT_KINDS_V2,
} from './factKinds.js';

export const SESSION_PROVIDER_TOOL_OBSERVATIONS_V2_SCHEMA =
  'deepcode.session.provider-tool-observations.v2' as const;

type ToolObservationOutcomeV1 =
  | 'admitted'
  | 'completed'
  | 'denied'
  | 'failedBeforeEffect'
  | 'failedAfterObservedEffect'
  | 'indeterminate'
  | 'cancelled'
  | 'timedOut'
  | 'rejected'
  | 'pending';

interface ToolObservationV1 {
  kind: 'tool';
  operationId: string;
  toolId?: string;
  canonicalAction?: string;
  outcome: ToolObservationOutcomeV1;
  invocationId?: string;
  retry?: SessionToolCorrectionV2;
  targets: string[];
  resourceRefs: string[];
  factRefs: string[];
  effectRefs: string[];
  result?: unknown;
  denial?: {
    reason?: string;
    guidance?: string;
    factRefs: string[];
  };
  cleanup?: {
    factKinds: string[];
    factRefs: string[];
  };
  indeterminateReason?: string;
  firstLedgerSequence: number;
  lastLedgerSequence: number;
}

interface KernelStateObservationV1 {
  kind: 'kernelFact';
  factId: string;
  ledgerSequence: number;
  domain: KernelFactProjectionV2['domain'];
  factKind: string;
  planActionIds: string[];
  resourceRefs: string[];
}

export interface SessionProviderToolObservationSectionV2 {
  schemaVersion: typeof SESSION_PROVIDER_TOOL_OBSERVATIONS_V2_SCHEMA;
  snapshotHighWater: number;
  omittedCount: number;
  observations: Array<ToolObservationV1 | KernelStateObservationV1>;
}

export function sessionProviderToolObservationsV2(input: {
  facts: SessionProviderKernelFactsProjectionV2;
  selectedFacts: readonly KernelFactProjectionV2[];
  providerOutcomes: readonly SessionProviderOutcomeRecordV2[];
}): SessionProviderToolObservationSectionV2 {
  const callsByOperation = settledCallsByOperation(input.providerOutcomes);
  const operationFacts = new Map<string, KernelFactProjectionV2[]>();
  const unscopedFacts: KernelFactProjectionV2[] = [];
  for (const fact of [...input.selectedFacts].sort(compareFacts)) {
    const operationId = fact.lineage.operationId;
    if (!operationId) {
      unscopedFacts.push(fact);
      continue;
    }
    const facts = operationFacts.get(operationId) ?? [];
    facts.push(fact);
    operationFacts.set(operationId, facts);
  }

  const observations: Array<ToolObservationV1 | KernelStateObservationV1> = [
    ...[...operationFacts.entries()].map(([operationId, facts]) =>
      toolObservation(operationId, facts, callsByOperation.get(operationId))
    ),
    ...unscopedFacts.map(kernelStateObservation),
  ].sort((left, right) =>
    observationLedgerSequence(left) - observationLedgerSequence(right)
      || observationIdentity(left).localeCompare(observationIdentity(right))
  );

  return {
    schemaVersion: SESSION_PROVIDER_TOOL_OBSERVATIONS_V2_SCHEMA,
    snapshotHighWater: input.facts.snapshotHighWater,
    omittedCount:
      input.facts.omittedCount
      + input.facts.facts.length
      - input.selectedFacts.length,
    observations,
  };
}

function toolObservation(
  operationId: string,
  facts: readonly KernelFactProjectionV2[],
  call: SessionProviderSettledToolCallV2 | undefined
): ToolObservationV1 {
  const ordered = [...facts].sort(compareFacts);
  const terminal = newestTerminalFact(ordered);
  const completed = [...ordered].reverse().find(
    (fact) =>
      fact.domain === 'invocation'
      && fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.completed
  );
  const admitted = ordered.find(
    (fact) =>
      fact.domain === 'invocation'
      && fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.admitted
  );
  const rejectionFact = call?.rejection
    ? ordered.find((fact) => fact.factId === call.rejection!.rejectionFactId)
    : undefined;
  const authorizationFacts = ordered.filter(
    (fact) => fact.domain === 'authorization'
  );
  const denialFacts = authorizationFacts.filter((fact) =>
    fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityDenied
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied
  );
  const cleanupFacts = ordered.filter((fact) => fact.domain === 'cleanup');
  const effectFacts = ordered.filter((fact) => fact.domain === 'effect');
  const detailCandidates = ordered.map((fact) => factDetailData(fact.details));
  const toolId = firstString(
    admitted ? factDetailData(admitted.details).toolId : undefined,
    ...detailCandidates.map((details) => details.toolId),
    call?.toolId
  );
  const targets = sortedUnique(
    detailCandidates.flatMap(canonicalWorkspaceTargets)
  );
  const resourceRefs = sortedUnique(
    ordered.flatMap((fact) => fact.lineage.resourceIds)
  );
  const effectRefs = sortedUnique(
    effectFacts.flatMap((fact) =>
      fact.lineage.effectId ? [fact.lineage.effectId] : []
    )
  );
  const denialDetails = denialFacts.map((fact) => factDetailData(fact.details));
  const denialReason = firstString(
    ...denialDetails.map((details) => details.reason),
    ...denialDetails.map((details) => details.reasonCode),
    rejectionFact ? call?.rejection?.reason : undefined
  );
  const denialGuidance = firstString(
    ...denialDetails.map((details) => details.guidance),
    rejectionFact ? call?.rejection?.guidance : undefined
  );
  const indeterminate = [...ordered].reverse().find((fact) =>
    fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.effect.indeterminate
  );
  const completedDetails = completed
    ? factDetailData(completed.details)
    : undefined;

  return {
    kind: 'tool',
    operationId,
    ...(toolId ? { toolId, canonicalAction: toolId } : {}),
    outcome: toolOutcome(ordered, terminal, rejectionFact !== undefined),
    ...firstString(
      terminal?.lineage.invocationId,
      admitted?.lineage.invocationId,
      call?.invocationId
    )
      ? {
          invocationId: firstString(
            terminal?.lineage.invocationId,
            admitted?.lineage.invocationId,
            call?.invocationId
          )!,
        }
      : {},
    ...(call?.correction ? { retry: cloneJson(call.correction) } : {}),
    targets,
    resourceRefs,
    factRefs: ordered.map((fact) => fact.factId),
    effectRefs,
    ...(completedDetails && 'output' in completedDetails
      ? { result: cloneJson(completedDetails.output) }
      : {}),
    ...(denialFacts.length > 0 || rejectionFact
      ? {
          denial: {
            ...(denialReason ? { reason: denialReason } : {}),
            ...(denialGuidance ? { guidance: denialGuidance } : {}),
            factRefs: sortedUnique([
              ...denialFacts.map((fact) => fact.factId),
              ...(rejectionFact ? [rejectionFact.factId] : []),
            ]),
          },
        }
      : {}),
    ...(cleanupFacts.length > 0
      ? {
          cleanup: {
            factKinds: cleanupFacts.map((fact) => fact.factKind),
            factRefs: cleanupFacts.map((fact) => fact.factId),
          },
        }
      : {}),
    ...(indeterminate
      ? {
          indeterminateReason: firstString(
            factDetailData(indeterminate.details).reason,
            factDetailData(indeterminate.details).reasonCode
          ) ?? 'kernelReportedIndeterminate',
        }
      : {}),
    firstLedgerSequence: ordered[0]!.ledgerSequence,
    lastLedgerSequence: ordered[ordered.length - 1]!.ledgerSequence,
  };
}

function toolOutcome(
  facts: readonly KernelFactProjectionV2[],
  terminal: KernelFactProjectionV2 | undefined,
  rejected: boolean
): ToolObservationOutcomeV1 {
  if (terminal) {
    switch (terminal.factKind) {
      case SESSION_KERNEL_FACT_KINDS_V2.invocation.completed:
        return 'completed';
      case SESSION_KERNEL_FACT_KINDS_V2.invocation.failedBeforeEffect:
        return 'failedBeforeEffect';
      case SESSION_KERNEL_FACT_KINDS_V2.invocation.failedAfterObservedEffect:
        return 'failedAfterObservedEffect';
      case SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate:
        return 'indeterminate';
      case SESSION_KERNEL_FACT_KINDS_V2.invocation.cancelledBeforeEffect:
        return 'cancelled';
      case SESSION_KERNEL_FACT_KINDS_V2.invocation.timedOutBeforeEffect:
        return 'timedOut';
      default:
        break;
    }
  }
  if (facts.some((fact) =>
    fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.authorization.capabilityDenied
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.authorization.expansionDenied
  )) return 'denied';
  if (rejected) return 'rejected';
  if (facts.some((fact) =>
    fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.admitted
  )) return 'admitted';
  return 'pending';
}

function newestTerminalFact(
  facts: readonly KernelFactProjectionV2[]
): KernelFactProjectionV2 | undefined {
  return [...facts].reverse().find((fact) =>
    fact.domain === 'invocation'
    && (
      fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.completed
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.failedBeforeEffect
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.cancelledBeforeEffect
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.timedOutBeforeEffect
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.failedAfterObservedEffect
      || fact.factKind === SESSION_KERNEL_FACT_KINDS_V2.invocation.indeterminate
    )
  );
}

function kernelStateObservation(
  fact: KernelFactProjectionV2
): KernelStateObservationV1 {
  return {
    kind: 'kernelFact',
    factId: fact.factId,
    ledgerSequence: fact.ledgerSequence,
    domain: fact.domain,
    factKind: fact.factKind,
    planActionIds: [...fact.lineage.planActionIds],
    resourceRefs: [...fact.lineage.resourceIds],
  };
}

function settledCallsByOperation(
  outcomes: readonly SessionProviderOutcomeRecordV2[]
): Map<string, SessionProviderSettledToolCallV2> {
  const result = new Map<string, SessionProviderSettledToolCallV2>();
  for (const outcome of outcomes) {
    if (outcome.outputKind !== 'toolIntent') continue;
    for (const call of outcome.toolCalls) {
      result.set(call.operationId, call);
    }
  }
  return result;
}

function canonicalWorkspaceTargets(
  details: Record<string, unknown>
): string[] {
  const scope = objectValue(details.resourceScope);
  const data = objectValue(scope?.data);
  if (scope?.kind !== 'workspace' || !Array.isArray(data?.targets)) return [];
  return data.targets.flatMap((target) => {
    const path = objectValue(target)?.relativePath;
    return typeof path === 'string' && path.trim() === path && path
      ? [path]
      : [];
  });
}

function factDetailData(value: unknown): Record<string, unknown> {
  const details = objectValue(value) ?? {};
  return objectValue(details.data) ?? details;
}

function objectValue(
  value: unknown
): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string =>
      typeof value === 'string' && value.trim() === value && value.length > 0
  );
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function compareFacts(
  left: KernelFactProjectionV2,
  right: KernelFactProjectionV2
): number {
  return left.ledgerSequence - right.ledgerSequence
    || left.factId.localeCompare(right.factId);
}

function observationLedgerSequence(
  observation: ToolObservationV1 | KernelStateObservationV1
): number {
  return observation.kind === 'tool'
    ? observation.lastLedgerSequence
    : observation.ledgerSequence;
}

function observationIdentity(
  observation: ToolObservationV1 | KernelStateObservationV1
): string {
  return observation.kind === 'tool'
    ? observation.operationId
    : observation.factId;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
