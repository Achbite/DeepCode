import type {
  AgentEvent,
  SessionKernelFactRefV1,
} from '@deepcode/protocol';
import { kernelFactRefFromEvent } from '../driver/authority/sessionFactLineage.js';
import type { ProposalEnvelope } from '../protocol/types.js';
import { taskLedgerKernelCompletedTaskIds } from '../run-state/index.js';
import { AcceptedTaskRegistry } from './AcceptedTaskRegistry.js';
import type {
  AcceptedPlanBatchProgress,
  AcceptedTaskPlanContext,
} from './types.js';

export class AcceptedPlanProgressAggregator {
  progress(
    accepted: AcceptedTaskPlanContext,
    proposal: ProposalEnvelope,
    kernelEvents: AgentEvent[]
  ): AcceptedPlanBatchProgress {
    const payload = objectRecord(proposal.payload);
    const actionBundle = objectRecord(payload?.actionBundle);
    const actions = Array.isArray(actionBundle?.actions) ? actionBundle.actions : [];
    const actionRecords = actions
      .map(objectRecord)
      .filter((action): action is Record<string, unknown> => Boolean(action));
    const actionIds = uniqueStrings(
      actionRecords.map((action) => stringValue(action.actionId))
    );
    if (!actionIds.length) {
      throw new Error(
        'session_task_settlement_evidence_unavailable: accepted-plan batch has no exact action identities.'
      );
    }
    const targetPaths = uniqueStrings(actionRecords.flatMap(actionTargets));
    const activeTaskId = accepted.taskLedger.currentTaskId;
    if (!activeTaskId) {
      throw new Error(
        'session_task_ledger_transition_invalid: accepted-plan batch has no active TaskLedgerV2 entry.'
      );
    }

    const refs = kernelEvents.flatMap((event): SessionKernelFactRefV1[] => {
      try {
        const ref = kernelFactRefFromEvent({
          event,
          boundRunId: accepted.runId,
        });
        return ref.kind === 'work_unit.completed'
          && ref.planActionId
          && actionIds.includes(ref.planActionId)
          ? [ref]
          : [];
      } catch {
        return [];
      }
    });
    const completedActionIds = new Set(
      refs.flatMap((ref) => ref.planActionId ? [ref.planActionId] : [])
    );
    const missingActionIds = actionIds.filter(
      (actionId) => !completedActionIds.has(actionId)
    );
    if (missingActionIds.length) {
      throw new Error(
        `session_task_settlement_evidence_unavailable: Kernel facts do not complete exact actions ${missingActionIds.join(', ')}.`
      );
    }

    const nextAccepted = new AcceptedTaskRegistry(accepted).settle({
      taskId: activeTaskId,
      settlement: {
        kind: 'kernelFacts',
        outcome: 'completed',
        kernelFactRefs: refs,
      },
      sourceRefs: refs.map((ref) => ref.kernelEventRef),
    });
    if (!nextAccepted) {
      throw new Error(
        'session_task_ledger_transition_invalid: TaskLedgerV2 settlement did not produce an accepted plan.'
      );
    }
    const nextLedger = nextAccepted.taskLedger;
    return {
      actionIds,
      targetPaths,
      workUnitIds: uniqueStrings(refs.map((ref) => ref.workUnitId)),
      kernelFactRefs: refs,
      newlySettledTaskIds: [activeTaskId],
      kernelCompletedTaskIds: taskLedgerKernelCompletedTaskIds(nextLedger),
      remainingTaskIds: [
        ...(nextLedger.currentTaskId ? [nextLedger.currentTaskId] : []),
        ...nextLedger.pendingTaskIds,
      ],
      taskLedger: nextLedger,
    };
  }
}

function actionTargets(action: Record<string, unknown>): string[] {
  const args = objectRecord(action.args);
  return uniqueStrings([
    stringValue(args?.path),
    stringValue(args?.destinationPath),
  ].map(normalizeRelativePath));
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/g, '');
  return normalized || '.';
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}
