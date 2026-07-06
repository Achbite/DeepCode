import type { ProposalEnvelope } from '../protocol/types.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanBatchValidationResult,
} from './types.js';

export type AcceptedPlanScopeInterventionLanguage = 'en-US' | 'zh-CN';

export interface AcceptedPlanScopeInterventionState {
  runId: string;
  sessionId?: string;
  userRequest: string;
  acceptedPlan?: AcceptedImplementationPlanContext;
  currentTaskId?: string;
}

export interface AcceptedPlanScopeInterventionPorts {
  createId(prefix: string): string;
  visibleLanguageForRequest(userRequest: string): AcceptedPlanScopeInterventionLanguage;
}

export class AcceptedPlanScopeIntervention {
  constructor(private readonly ports: AcceptedPlanScopeInterventionPorts) {}

  createDecisionProposal(
    state: AcceptedPlanScopeInterventionState,
    proposal: ProposalEnvelope,
    validation: AcceptedPlanBatchValidationResult
  ): ProposalEnvelope {
    const proposalId = this.ports.createId('accepted-plan-scope-decision');
    const language = this.ports.visibleLanguageForRequest(state.userRequest);
    const accepted = state.acceptedPlan;
    const expansion = acceptedPlanScopeExpansionCandidate(state, validation);
    const summary = language === 'en-US'
      ? 'The next batch is outside the accepted implementation plan.'
      : '下一批 actionBundle 超出已确认 implementationPlan 范围。';
    const reasons = validation.reasons.length ? validation.reasons : [summary];
    const options = language === 'en-US'
      ? [
        ...(expansion ? [{
          id: 'expand-current-task-scope',
          label: 'Allow this target',
          labelKey: 'session.driver.acceptedPlanScope.option.expand.label',
          description: `Expand only the current accepted task to include ${expansion.targetPath}.`,
          descriptionKey: 'session.driver.acceptedPlanScope.option.expand.description',
          messageArgs: { targetPath: expansion.targetPath },
          recommended: true,
          effect: {
            kind: 'expandCurrentTaskScope',
            taskId: expansion.taskId,
            targetPath: expansion.targetPath,
            targetResourceKind: expansion.targetResourceKind,
            recursive: expansion.recursive,
            reason: 'user approved accepted-plan execution scope expansion',
          },
        }] : []),
        {
          id: 'regenerate-in-scope',
          label: expansion ? 'Regenerate without expanding' : 'Regenerate in scope',
          labelKey: expansion
            ? 'session.driver.acceptedPlanScope.option.regenerateNoExpand.label'
            : 'session.driver.acceptedPlanScope.option.regenerate.label',
          description: 'Keep the accepted plan and ask the agent to output the next batch within its targets and capabilities.',
          descriptionKey: 'session.driver.acceptedPlanScope.option.regenerate.description',
          recommended: !expansion,
          effect: { kind: 'continueCurrentTask' },
        },
        {
          id: 'revise-plan',
          label: 'Revise plan scope',
          labelKey: 'session.driver.acceptedPlanScope.option.revise.label',
          description: 'Treat the new targets or capabilities as a plan revision before continuing.',
          descriptionKey: 'session.driver.acceptedPlanScope.option.revise.description',
          effect: { kind: 'replan', reason: 'revise accepted plan scope' },
        },
      ]
      : [
        ...(expansion ? [{
          id: 'expand-current-task-scope',
          label: '允许当前目标',
          labelKey: 'session.driver.acceptedPlanScope.option.expand.label',
          description: `仅将 ${expansion.targetPath} 加入当前已确认任务的执行范围。`,
          descriptionKey: 'session.driver.acceptedPlanScope.option.expand.description',
          messageArgs: { targetPath: expansion.targetPath },
          recommended: true,
          effect: {
            kind: 'expandCurrentTaskScope',
            taskId: expansion.taskId,
            targetPath: expansion.targetPath,
            targetResourceKind: expansion.targetResourceKind,
            recursive: expansion.recursive,
            reason: 'user approved accepted-plan execution scope expansion',
          },
        }] : []),
        {
          id: 'regenerate-in-scope',
          label: expansion ? '不扩权并重新生成' : '重新生成合规批次',
          labelKey: expansion
            ? 'session.driver.acceptedPlanScope.option.regenerateNoExpand.label'
            : 'session.driver.acceptedPlanScope.option.regenerate.label',
          description: '保持已确认计划不变，让 Agent 重新输出落在目标和能力范围内的下一批。',
          descriptionKey: 'session.driver.acceptedPlanScope.option.regenerate.description',
          recommended: !expansion,
          effect: { kind: 'continueCurrentTask' },
        },
        {
          id: 'revise-plan',
          label: '修订计划范围',
          labelKey: 'session.driver.acceptedPlanScope.option.revise.label',
          description: '把新增目标或能力作为计划修订先确认，再继续执行。',
          descriptionKey: 'session.driver.acceptedPlanScope.option.revise.description',
          effect: { kind: 'replan', reason: 'revise accepted plan scope' },
        },
      ];

    return {
      schemaVersion: 'deepcode.agent.protocol.v3',
      proposalId,
      runId: state.runId,
      sessionId: state.sessionId,
      source: 'system',
      kind: 'decisionRequest',
      payload: {
        id: `accepted-plan-scope-${safeSegment(accepted?.planId ?? proposal.proposalId)}`,
        decisionScope: 'acceptedPlanBatchOutOfScope',
        acceptedPlanId: accepted?.planId,
        sourceProposalId: proposal.proposalId,
        parentRunId: state.runId,
        parentPhase: 'executing_accepted_plan',
        goal: summary,
        summary: `${summary}\n${reasons.map((reason) => `- ${reason}`).join('\n')}`,
        question: language === 'en-US'
          ? 'How should DeepCode continue?'
          : '接下来如何继续？',
        options,
        allowsFreeform: true,
        risks: reasons,
        affectedAreas: uniqueStrings([
          ...(accepted?.targetScopes ?? []),
          ...((accepted?.exactOperationGrants ?? []).map((grant) => grant.targetPath)),
        ]),
        constraints: [
          'Accepted taskPlan controls automatic batch execution scope.',
          'Kernel permissions remain authoritative.',
        ],
      },
      referencedResourcePacketRefs: [],
      referencedEvidenceRefs: [],
    };
  }
}

function acceptedPlanScopeExpansionCandidate(
  state: AcceptedPlanScopeInterventionState,
  validation: AcceptedPlanBatchValidationResult
): { taskId?: string; targetPath: string; targetResourceKind: 'file' | 'directory'; recursive: boolean } | undefined {
  const issues = validation.issues ?? [];
  const targetIssues = issues.filter((issue) => issue.code === 'targetOutOfScope' && issue.targetPath);
  const uniqueTargets = uniqueStrings(targetIssues.map((issue) => issue.targetPath).filter((target): target is string => Boolean(target)));
  if (uniqueTargets.length !== 1) return undefined;
  const issue = targetIssues.find((candidate) => candidate.targetPath === uniqueTargets[0]);
  if (!issue) return undefined;
  const normalized = normalizePlanScopeIdentity(issue.targetPath ?? '');
  if (!acceptedPlanTargetListSegmentSafe(normalized)) return undefined;
  return {
    taskId: state.currentTaskId,
    targetPath: normalized,
    targetResourceKind: issue.targetResourceKind ?? (normalized.endsWith('/') ? 'directory' : 'file'),
    recursive: issue.recursive === true || issue.targetResourceKind === 'directory',
  };
}

function acceptedPlanTargetListSegmentSafe(value: string): boolean {
  const normalized = normalizePlanScopeIdentity(value);
  if (!normalized || normalized === '.' || normalized === '..' || normalized === '/') return false;
  if (normalized.startsWith('../') || normalized.includes('/../')) return false;
  if (normalized.includes('*')) return false;
  return !isAbsolutePath(normalized);
}

function normalizePlanScopeIdentity(value: string): string {
  return normalizePlanScope(value).replace(/\/+$/, '');
}

function normalizePlanScope(value: string | undefined): string {
  return (value ?? '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
