import type { ProposalEnvelope } from '../protocol/types.js';
import type {
  AcceptedTaskPlanContext,
  AcceptedPlanBatchValidationIssue,
  AcceptedPlanBatchValidationResult,
} from './types.js';

export class AcceptedPlanAdmission {
  validate(
    _accepted: AcceptedTaskPlanContext,
    proposal: ProposalEnvelope
  ): AcceptedPlanBatchValidationResult {
    const payload = objectRecord(proposal.payload);
    const actionBundle = objectRecord(payload?.actionBundle);
    if (!actionBundle) {
      const message = 'Provider output does not contain an actionBundle for the accepted task.';
      return {
        ok: false,
        reasons: [message],
        issues: [{ code: 'missingActionBundle', message }],
      };
    }

    const issues: AcceptedPlanBatchValidationIssue[] = [];
    const actions = Array.isArray(actionBundle.actions) ? actionBundle.actions : undefined;
    if (!actions?.length) {
      issues.push({
        code: 'protocolShapeInvalid',
        message: 'actionBundle.actions must be a non-empty array.',
      });
    } else {
      for (const [index, value] of actions.entries()) {
        const action = objectRecord(value);
        if (
          !stringValue(action?.actionId)
          || !stringValue(action?.toolId)
          || !objectRecord(action?.args)
        ) {
          issues.push({
            code: 'protocolShapeInvalid',
            message: `actionBundle.actions[${index}] requires actionId, toolId, and typed args.`,
          });
        }
      }
    }

    return {
      ok: issues.length === 0,
      reasons: issues.map((issue) => issue.message),
      issues,
    };
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
