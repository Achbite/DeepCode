import type { ProposalEnvelope } from '../agent-plan/types.js';
import type { ResourcePacket } from '../context/types.js';
import type { AcceptedPlanScopeMatcher } from './AcceptedPlanScopeMatcher.js';
import type {
  AcceptedImplementationPlanContext,
  AcceptedPlanBatchValidationIssue,
  AcceptedPlanBatchValidationResult,
} from './types.js';

export interface AcceptedPlanAdmissionPorts {
  scopeMatcher: AcceptedPlanScopeMatcher;
  fileOperationFreshnessReasons(
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    resourcePackets: ResourcePacket[]
  ): string[];
}

export class AcceptedPlanAdmission {
  constructor(private readonly ports: AcceptedPlanAdmissionPorts) {}

  validate(
    accepted: AcceptedImplementationPlanContext,
    proposal: ProposalEnvelope,
    resourcePackets: ResourcePacket[] = []
  ): AcceptedPlanBatchValidationResult {
    const matcher = this.ports.scopeMatcher;
    const actionBundle = matcher.readActionBundle(proposal);
    if (!actionBundle) {
      const message = '当前 provider 输出不包含 actionBundle，无法按已确认计划自动执行。';
      return {
        ok: false,
        reasons: [message],
        issues: [{ code: 'missingActionBundle', message }],
      };
    }

    const reasons: string[] = [];
    const issues: AcceptedPlanBatchValidationIssue[] = [];
    const addIssue = (issue: AcceptedPlanBatchValidationIssue) => {
      reasons.push(issue.message);
      issues.push(issue);
    };

    const allowedCapabilities = matcher.canonicalCapabilities(accepted);
    const hasCanonicalCapabilityContract = allowedCapabilities.size > 0;
    const batchTargets = matcher.proposalTargetScopes(proposal, accepted);
    for (const target of batchTargets) {
      const targetError = matcher.targetError(target, accepted);
      if (targetError) addIssue({
        code: 'invalidTargetPath',
        message: targetError,
        targetPath: target.normalized,
      });
    }

    for (const action of actionBundle.actions ?? []) {
      const actionRecord = matcher.objectRecord(action) ?? {};
      const capability = matcher.actionEffectiveCapability(actionRecord);
      const actionId = matcher.stringValue(actionRecord.actionId)
        ?? matcher.stringValue(actionRecord.id)
        ?? matcher.stringValue(actionRecord.title);

      if (!matcher.autoExecutableCapability(capability)) {
        addIssue({
          code: 'capabilityRequiresDecision',
          message: `能力 ${capability || '[empty]'} 需要单独用户介入，不能在 accepted taskPlan 后自动执行。`,
          capability,
          actionId,
        });
        continue;
      }

      if (hasCanonicalCapabilityContract && !matcher.capabilitySetAllows(allowedCapabilities, capability)) {
        addIssue({
          code: 'capabilityOutOfScope',
          message: `能力 ${capability} 未出现在已确认 implementationPlan 的任务能力列表中。`,
          capability,
          actionId,
        });
      }

      const scopes = matcher.actionTargetScopes(action, proposal)
        .map((scope) => matcher.normalizeTargetScope(scope, accepted))
        .filter(Boolean);
      if (scopes.length === 0) {
        addIssue({
          code: 'missingTarget',
          message: `动作 ${actionId || '[unnamed]'} 缺少 target/resourceScope，不能证明其落在已确认计划范围内。`,
          capability,
          actionId,
        });
        continue;
      }

      for (const scope of scopes) {
        if (!matcher.scopeCovered(scope, capability, accepted)) {
          addIssue({
            code: 'targetOutOfScope',
            message: `目标 ${scope} 超出已确认 implementationPlan 的 target 范围。`,
            targetPath: scope,
            capability,
            actionId,
            targetResourceKind: matcher.deleteTargetResourceKind(actionRecord) === 'directory'
              ? 'directory'
              : 'file',
            recursive: matcher.deleteRecursive(actionRecord),
          });
        }
      }
    }

    for (const message of this.ports.fileOperationFreshnessReasons(accepted, proposal, resourcePackets)) {
      reasons.push(message);
      issues.push({ code: 'freshEvidenceMissing', message });
    }

    return { ok: reasons.length === 0, reasons: [...new Set(reasons)], issues };
  }

  needsDeterministicScopeIntervention(validation: AcceptedPlanBatchValidationResult): boolean {
    return (validation.issues ?? []).some((issue) =>
      issue.code === 'targetOutOfScope' ||
      issue.code === 'capabilityOutOfScope' ||
      issue.code === 'capabilityRequiresDecision'
    );
  }
}
