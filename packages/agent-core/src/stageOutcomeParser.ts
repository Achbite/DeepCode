import type {
  AgentObservationRef,
  AgentOutcomeKind,
  AgentPlanStep,
  AgentReplanReason,
  AgentRiskLevel,
  AgentStageOutcome,
  AgentWorkflowStage,
} from '@deepcode/protocol';
import { isRecord } from './utils.js';

export interface StageOutcomeParseOptions {
  stage: AgentWorkflowStage;
  fallbackSummary?: string;
  fallbackEvidence?: AgentObservationRef[];
}

export interface StageOutcomeParseError {
  code: string;
  message: string;
}

export interface StageOutcomeParseResult {
  outcome: AgentStageOutcome;
  source: 'jsonBlock' | 'fallback';
  errors: StageOutcomeParseError[];
  raw?: unknown;
}

const OUTCOME_KINDS = new Set<AgentOutcomeKind>([
  'plan.proposed',
  'plan.needs_user_input',
  'check.accepted',
  'check.rejected',
  'complete.progress',
  'complete.blocked',
  'complete.done',
  'review.accepted',
  'review.rejected',
  'permission.approved',
  'permission.rejected',
]);

const REPLAN_REASONS = new Set<AgentReplanReason>([
  'invalid_plan',
  'missing_context',
  'tool_error',
  'test_failed',
  'plan_mismatch',
  'scope_changed',
  'unsafe_operation',
  'permission_required',
  'user_rejected_permission',
  'insufficient_evidence',
  'budget_exceeded',
]);

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asEvidence(value: unknown): AgentObservationRef[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecord)
    .map((item, index) => ({
      id: asString(item.id) ?? `evidence-${index + 1}`,
      kind: isObservationKind(item.kind) ? item.kind : 'review_note',
      summary: asString(item.summary) ?? asString(item.message) ?? 'Evidence item.',
      ok: typeof item.ok === 'boolean' ? item.ok : undefined,
      eventId: asString(item.eventId),
      toolCallId: asString(item.toolCallId),
      dataRef: asString(item.dataRef),
    }));
}

function isObservationKind(value: unknown): value is AgentObservationRef['kind'] {
  return (
    value === 'file_read'
    || value === 'file_diff'
    || value === 'file_write'
    || value === 'shell_exit_code'
    || value === 'tool_result'
    || value === 'permission_decision'
    || value === 'user_message'
    || value === 'review_note'
    || value === 'error'
  );
}

function reason(value: unknown): AgentReplanReason {
  return REPLAN_REASONS.has(value as AgentReplanReason)
    ? value as AgentReplanReason
    : 'insufficient_evidence';
}

function planStepRisk(value: unknown): AgentRiskLevel {
  return value === 'high' || value === 'medium' ? value : 'low';
}

function parsePlanStep(raw: unknown, index: number): AgentPlanStep {
  const item = isRecord(raw) ? raw : {};
  return {
    id: asString(item.id) ?? `step-${index + 1}`,
    title: asString(item.title) ?? `Step ${index + 1}`,
    intent: asString(item.intent) ?? asString(item.title) ?? 'Unspecified intent.',
    expectedTool: asString(item.expectedTool),
    expectedFiles: asStringArray(item.expectedFiles),
    riskLevel: planStepRisk(item.riskLevel),
  };
}

function normalizeOutcomeObject(raw: Record<string, unknown>): AgentStageOutcome | undefined {
  const kind = asString(raw.kind) as AgentOutcomeKind | undefined;
  if (!kind || !OUTCOME_KINDS.has(kind)) return undefined;
  const summary = asString(raw.summary);

  switch (kind) {
    case 'plan.proposed': {
      const plan = isRecord(raw.plan) ? raw.plan : {};
      const steps = Array.isArray(plan.steps) ? plan.steps.map(parsePlanStep) : [];
      return {
        kind,
        plan: {
          id: asString(plan.id) ?? 'plan',
          goal: asString(plan.goal) ?? summary ?? 'Unspecified goal.',
          assumptions: asStringArray(plan.assumptions),
          steps,
          successCriteria: asStringArray(plan.successCriteria),
          allowedTools: asStringArray(plan.allowedTools),
          forbiddenActions: asStringArray(plan.forbiddenActions),
          evidenceRequired: asStringArray(plan.evidenceRequired),
        },
        confidence: typeof raw.confidence === 'number' ? raw.confidence : 0.5,
        summary,
      };
    }
    case 'plan.needs_user_input':
      return {
        kind,
        question: asString(raw.question) ?? 'More user input is required.',
        blockingReason: asString(raw.blockingReason) ?? 'insufficient_context',
        summary,
      };
    case 'check.accepted':
      return {
        kind,
        planId: asString(raw.planId) ?? 'plan',
        notes: asStringArray(raw.notes),
        summary,
      };
    case 'check.rejected':
      return {
        kind,
        planId: asString(raw.planId),
        reason: reason(raw.reason),
        evidence: asEvidence(raw.evidence),
        summary,
      };
    case 'complete.progress':
      return {
        kind,
        completedStepIds: asStringArray(raw.completedStepIds),
        observations: asEvidence(raw.observations),
        remainingStepIds: asStringArray(raw.remainingStepIds),
        summary,
      };
    case 'complete.blocked':
      return {
        kind,
        reason: reason(raw.reason),
        evidence: asEvidence(raw.evidence),
        suggestedRepair: asString(raw.suggestedRepair),
        summary,
      };
    case 'complete.done':
      return {
        kind,
        completedStepIds: asStringArray(raw.completedStepIds),
        evidence: asEvidence(raw.evidence),
        summary,
      };
    case 'review.accepted':
      return {
        kind,
        evidence: asEvidence(raw.evidence),
        summary: summary ?? 'Review accepted.',
      };
    case 'review.rejected':
      return {
        kind,
        reason: reason(raw.reason),
        evidence: asEvidence(raw.evidence),
        summary,
      };
    case 'permission.approved':
      return {
        kind,
        permissionId: asString(raw.permissionId) ?? 'permission',
        summary,
      };
    case 'permission.rejected':
      return {
        kind,
        permissionId: asString(raw.permissionId) ?? 'permission',
        reason: reason(raw.reason),
        summary,
      };
  }
}

function firstOutcomeBlock(content: string): unknown | undefined {
  const blockPattern = /```(?:deepcode-outcome|deepcode-workflow-outcome)\s*([\s\S]*?)```/g;
  const match = blockPattern.exec(content);
  if (!match) return undefined;
  const parsed = JSON.parse(match[1].trim()) as unknown;
  if (isRecord(parsed) && isRecord(parsed.outcome)) return parsed.outcome;
  if (isRecord(parsed) && isRecord(parsed.deepcodeWorkflowOutcome)) return parsed.deepcodeWorkflowOutcome;
  return parsed;
}

function fallbackOutcome(options: StageOutcomeParseOptions): AgentStageOutcome {
  const summary = options.fallbackSummary ?? 'No structured stage outcome was produced.';
  const evidence = options.fallbackEvidence ?? [];
  if (options.stage === 'plan') {
    return {
      kind: 'plan.needs_user_input',
      question: 'Please provide confirmation or more context before execution continues.',
      blockingReason: 'missing_structured_outcome',
      summary,
    };
  }
  if (options.stage === 'check') {
    return {
      kind: 'check.rejected',
      reason: 'insufficient_evidence',
      evidence,
      summary,
    };
  }
  if (options.stage === 'review') {
    return {
      kind: 'review.rejected',
      reason: 'insufficient_evidence',
      evidence,
      summary,
    };
  }
  return {
    kind: 'complete.blocked',
    reason: 'insufficient_evidence',
    evidence,
    suggestedRepair: 'Ask the model to return a deepcode-outcome JSON block.',
    summary,
  };
}

export function parseStageOutcome(
  content: string,
  options: StageOutcomeParseOptions
): StageOutcomeParseResult {
  try {
    const raw = firstOutcomeBlock(content);
    if (isRecord(raw)) {
      const outcome = normalizeOutcomeObject(raw);
      if (outcome) {
        return { outcome, source: 'jsonBlock', errors: [], raw };
      }
      return {
        outcome: fallbackOutcome(options),
        source: 'fallback',
        errors: [{ code: 'invalid_outcome_block', message: 'Outcome block kind is missing or unsupported.' }],
        raw,
      };
    }
    return {
      outcome: fallbackOutcome(options),
      source: 'fallback',
      errors: [{ code: 'missing_outcome_block', message: 'No deepcode-outcome block found.' }],
    };
  } catch (err) {
    return {
      outcome: fallbackOutcome(options),
      source: 'fallback',
      errors: [{
        code: 'outcome_json_parse_error',
        message: err instanceof Error ? err.message : String(err),
      }],
    };
  }
}

export function normalizeOutcome(
  outcome: AgentStageOutcome,
  observations: AgentObservationRef[]
): AgentStageOutcome {
  if (observations.length === 0) return outcome;
  if (outcome.kind === 'check.rejected') {
    return { ...outcome, evidence: [...outcome.evidence, ...observations] };
  }
  if (outcome.kind === 'complete.progress') {
    return { ...outcome, observations: [...outcome.observations, ...observations] };
  }
  if (outcome.kind === 'complete.blocked') {
    return { ...outcome, evidence: [...outcome.evidence, ...observations] };
  }
  if (outcome.kind === 'complete.done') {
    return { ...outcome, evidence: [...outcome.evidence, ...observations] };
  }
  if (outcome.kind === 'review.accepted' || outcome.kind === 'review.rejected') {
    return { ...outcome, evidence: [...outcome.evidence, ...observations] };
  }
  return outcome;
}
