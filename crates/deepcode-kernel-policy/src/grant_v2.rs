use deepcode_kernel_abi::{
    OperationExecutionMode, TargetExistence, ToolOperationKind, ToolPermissionMode, ToolRiskLevel,
};
use serde::{Deserialize, Serialize};

/// Kernel-owned autonomy mode used only by the v2 grant preview path.
///
/// This type intentionally does not replace the v1 `PolicyProfile` autonomy
/// levels. The v2 authority path remains dark until Runtime explicitly wires a
/// trusted ToolContract and resolved resource projection into this evaluator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GrantAutonomyModeV2 {
    Strict,
    TrustedWorkspace,
    Maximum,
}

/// Resource scope after Kernel resource resolution.
///
/// `ExactWorkspace` and `ExactGitWorkspace` mean the Kernel has resolved a
/// finite, non-empty set. An unresolved, wildcard, root-wide, or otherwise
/// open-ended request must use `UnresolvedOrUnbounded` and cannot be
/// auto-issued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum GrantResolvedScopeV2 {
    ExactWorkspace { resources: Vec<String> },
    ExactGitWorkspace { resources: Vec<String> },
    External { resources: Vec<String> },
    Process,
    Network,
    Browser,
    Provider,
    RuntimePermission,
    UnresolvedOrUnbounded,
}

impl GrantResolvedScopeV2 {
    fn has_complete_exact_scope(&self) -> bool {
        match self {
            Self::ExactWorkspace { resources } | Self::ExactGitWorkspace { resources } => {
                !resources.is_empty()
                    && resources.iter().all(|resource| !resource.trim().is_empty())
            }
            _ => false,
        }
    }

    fn is_external_or_non_workspace_authority(&self) -> bool {
        matches!(
            self,
            Self::External { .. }
                | Self::Process
                | Self::Network
                | Self::Browser
                | Self::Provider
                | Self::RuntimePermission
        )
    }
}

/// Immutable projection of a Kernel-owned ToolContract and resolved request.
///
/// `resource_scope` and `effect_scope` are the exact values that a subsequent
/// CapabilityGrant would bind. `tool_id` is carried as opaque identity and is
/// not used for semantic classification; `operation_kind` must come from the
/// same trusted ToolContract. The evaluator never parses provider prose or
/// tool arguments to infer policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantAutoIssueCandidateV2 {
    pub autonomy_mode: GrantAutonomyModeV2,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub permission_mode: ToolPermissionMode,
    pub execution_mode: OperationExecutionMode,
    pub risk: ToolRiskLevel,
    pub resource_scope: GrantResolvedScopeV2,
    pub effect_scope: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename_destination_existence: Option<TargetExistence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityGrantAutoIssueDecisionV2 {
    AutoIssue,
    RequireExplicitDecision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityGrantAutoIssueReasonV2 {
    LowRiskLocalTool,
    BoundedMediumWorkspaceMutation,
    MaximumReversibleHighOperation,
    ToolContractDenied,
    ToolContractNotExecutable,
    ToolContractMismatch,
    MissingExactResourceOrEffectScope,
    ExternalOrNonWorkspaceAuthority,
    CriticalRisk,
    ExcludedOperation,
    RenameMayOverwrite,
    AutonomyInsufficient,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityGrantAutoIssueEvaluationV2 {
    pub decision: CapabilityGrantAutoIssueDecisionV2,
    pub reason: CapabilityGrantAutoIssueReasonV2,
}

impl CapabilityGrantAutoIssueEvaluationV2 {
    const fn auto(reason: CapabilityGrantAutoIssueReasonV2) -> Self {
        Self {
            decision: CapabilityGrantAutoIssueDecisionV2::AutoIssue,
            reason,
        }
    }

    const fn explicit(reason: CapabilityGrantAutoIssueReasonV2) -> Self {
        Self {
            decision: CapabilityGrantAutoIssueDecisionV2::RequireExplicitDecision,
            reason,
        }
    }

    pub const fn is_auto_issue(self) -> bool {
        matches!(self.decision, CapabilityGrantAutoIssueDecisionV2::AutoIssue)
    }
}

/// Evaluate whether Kernel may auto-issue a v2 CapabilityGrant.
///
/// This function is deliberately fail-closed. A ToolContract mismatch,
/// unresolved scope, missing effect scope, or explicit ToolContract denial
/// always requires an explicit decision. It does not mint a Grant and is not a
/// substitute for the Runtime before-effect guard.
pub fn evaluate_capability_grant_auto_issue_v2(
    candidate: &CapabilityGrantAutoIssueCandidateV2,
) -> CapabilityGrantAutoIssueEvaluationV2 {
    if candidate.permission_mode == ToolPermissionMode::Deny {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::ToolContractDenied,
        );
    }

    if candidate.execution_mode != OperationExecutionMode::Execute {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::ToolContractNotExecutable,
        );
    }

    if !candidate_satisfies_policy_invariants(candidate) {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::ToolContractMismatch,
        );
    }

    if candidate
        .resource_scope
        .is_external_or_non_workspace_authority()
        || is_external_operation(candidate.operation_kind)
    {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::ExternalOrNonWorkspaceAuthority,
        );
    }

    if candidate.risk == ToolRiskLevel::Critical {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::CriticalRisk,
        );
    }

    if is_never_auto_operation(candidate.operation_kind) {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::ExcludedOperation,
        );
    }

    if !candidate.resource_scope.has_complete_exact_scope()
        || candidate.effect_scope.is_empty()
        || candidate
            .effect_scope
            .iter()
            .any(|effect| effect.trim().is_empty())
    {
        return CapabilityGrantAutoIssueEvaluationV2::explicit(
            CapabilityGrantAutoIssueReasonV2::MissingExactResourceOrEffectScope,
        );
    }

    if candidate.risk == ToolRiskLevel::Low {
        return CapabilityGrantAutoIssueEvaluationV2::auto(
            CapabilityGrantAutoIssueReasonV2::LowRiskLocalTool,
        );
    }

    if candidate.risk == ToolRiskLevel::Medium
        && is_bounded_workspace_mutation(candidate.operation_kind)
        && matches!(
            &candidate.resource_scope,
            GrantResolvedScopeV2::ExactWorkspace { .. }
        )
    {
        return if matches!(
            candidate.autonomy_mode,
            GrantAutonomyModeV2::TrustedWorkspace | GrantAutonomyModeV2::Maximum
        ) {
            CapabilityGrantAutoIssueEvaluationV2::auto(
                CapabilityGrantAutoIssueReasonV2::BoundedMediumWorkspaceMutation,
            )
        } else {
            CapabilityGrantAutoIssueEvaluationV2::explicit(
                CapabilityGrantAutoIssueReasonV2::AutonomyInsufficient,
            )
        };
    }

    if candidate.risk == ToolRiskLevel::High
        && candidate.autonomy_mode == GrantAutonomyModeV2::Maximum
    {
        return match candidate.operation_kind {
            ToolOperationKind::FsRename => {
                if candidate.rename_destination_existence == Some(TargetExistence::MustNotExist)
                    && matches!(
                        &candidate.resource_scope,
                        GrantResolvedScopeV2::ExactWorkspace { .. }
                    )
                {
                    CapabilityGrantAutoIssueEvaluationV2::auto(
                        CapabilityGrantAutoIssueReasonV2::MaximumReversibleHighOperation,
                    )
                } else {
                    CapabilityGrantAutoIssueEvaluationV2::explicit(
                        CapabilityGrantAutoIssueReasonV2::RenameMayOverwrite,
                    )
                }
            }
            ToolOperationKind::GitStage | ToolOperationKind::GitUnstage
                if matches!(
                    &candidate.resource_scope,
                    GrantResolvedScopeV2::ExactGitWorkspace { .. }
                ) =>
            {
                CapabilityGrantAutoIssueEvaluationV2::auto(
                    CapabilityGrantAutoIssueReasonV2::MaximumReversibleHighOperation,
                )
            }
            _ => CapabilityGrantAutoIssueEvaluationV2::explicit(
                CapabilityGrantAutoIssueReasonV2::AutonomyInsufficient,
            ),
        };
    }

    CapabilityGrantAutoIssueEvaluationV2::explicit(
        CapabilityGrantAutoIssueReasonV2::AutonomyInsufficient,
    )
}

fn candidate_satisfies_policy_invariants(candidate: &CapabilityGrantAutoIssueCandidateV2) -> bool {
    !candidate.tool_id.trim().is_empty()
        && candidate.risk >= minimum_policy_risk(candidate.operation_kind)
        && rename_metadata_matches(candidate)
        && scope_matches_operation(candidate)
}

fn rename_metadata_matches(candidate: &CapabilityGrantAutoIssueCandidateV2) -> bool {
    if candidate.operation_kind == ToolOperationKind::FsRename {
        candidate.rename_destination_existence.is_some()
    } else {
        candidate.rename_destination_existence.is_none()
    }
}

fn scope_matches_operation(candidate: &CapabilityGrantAutoIssueCandidateV2) -> bool {
    match candidate.operation_kind {
        operation if operation.has_workspace_path() => matches!(
            &candidate.resource_scope,
            GrantResolvedScopeV2::ExactWorkspace { .. }
                | GrantResolvedScopeV2::External { .. }
                | GrantResolvedScopeV2::UnresolvedOrUnbounded
        ),
        ToolOperationKind::GitStatus
        | ToolOperationKind::GitDiff
        | ToolOperationKind::GitStage
        | ToolOperationKind::GitUnstage
        | ToolOperationKind::GitCommit
        | ToolOperationKind::GitPush => matches!(
            &candidate.resource_scope,
            GrantResolvedScopeV2::ExactGitWorkspace { .. }
                | GrantResolvedScopeV2::External { .. }
                | GrantResolvedScopeV2::UnresolvedOrUnbounded
        ),
        ToolOperationKind::ProcessExec => {
            matches!(&candidate.resource_scope, GrantResolvedScopeV2::Process)
        }
        ToolOperationKind::WebSearch | ToolOperationKind::WebFetch => {
            matches!(&candidate.resource_scope, GrantResolvedScopeV2::Network)
        }
        ToolOperationKind::BrowserOpen
        | ToolOperationKind::BrowserReload
        | ToolOperationKind::BrowserSnapshot
        | ToolOperationKind::BrowserInspect
        | ToolOperationKind::BrowserClick
        | ToolOperationKind::BrowserType
        | ToolOperationKind::BrowserScroll => {
            matches!(&candidate.resource_scope, GrantResolvedScopeV2::Browser)
        }
        ToolOperationKind::ProviderCall => {
            matches!(&candidate.resource_scope, GrantResolvedScopeV2::Provider)
        }
        _ => false,
    }
}

const fn is_external_operation(operation: ToolOperationKind) -> bool {
    matches!(
        operation,
        ToolOperationKind::ProcessExec
            | ToolOperationKind::WebSearch
            | ToolOperationKind::WebFetch
            | ToolOperationKind::BrowserOpen
            | ToolOperationKind::BrowserReload
            | ToolOperationKind::BrowserSnapshot
            | ToolOperationKind::BrowserInspect
            | ToolOperationKind::BrowserClick
            | ToolOperationKind::BrowserType
            | ToolOperationKind::BrowserScroll
            | ToolOperationKind::ProviderCall
    )
}

const fn is_bounded_workspace_mutation(operation: ToolOperationKind) -> bool {
    matches!(
        operation,
        ToolOperationKind::FsCreate
            | ToolOperationKind::FsWrite
            | ToolOperationKind::FsEdit
            | ToolOperationKind::FsEnsureDirectory
    )
}

const fn is_never_auto_operation(operation: ToolOperationKind) -> bool {
    matches!(
        operation,
        ToolOperationKind::FsDelete
            | ToolOperationKind::GitCommit
            | ToolOperationKind::GitPush
            | ToolOperationKind::ProcessExec
            | ToolOperationKind::WebSearch
            | ToolOperationKind::WebFetch
            | ToolOperationKind::BrowserOpen
            | ToolOperationKind::BrowserReload
            | ToolOperationKind::BrowserSnapshot
            | ToolOperationKind::BrowserInspect
            | ToolOperationKind::BrowserClick
            | ToolOperationKind::BrowserType
            | ToolOperationKind::BrowserScroll
            | ToolOperationKind::ProviderCall
    )
}

const fn minimum_policy_risk(operation: ToolOperationKind) -> ToolRiskLevel {
    match operation {
        ToolOperationKind::FsRead
        | ToolOperationKind::FsList
        | ToolOperationKind::FsGlob
        | ToolOperationKind::FsDiff
        | ToolOperationKind::CodeGrep
        | ToolOperationKind::DocumentRead
        | ToolOperationKind::GitStatus
        | ToolOperationKind::GitDiff => ToolRiskLevel::Low,
        ToolOperationKind::FsCreate
        | ToolOperationKind::FsWrite
        | ToolOperationKind::FsEdit
        | ToolOperationKind::FsEnsureDirectory => ToolRiskLevel::Medium,
        ToolOperationKind::FsRename
        | ToolOperationKind::FsDelete
        | ToolOperationKind::GitStage
        | ToolOperationKind::GitUnstage
        | ToolOperationKind::GitCommit
        | ToolOperationKind::ProcessExec
        | ToolOperationKind::WebSearch
        | ToolOperationKind::WebFetch
        | ToolOperationKind::BrowserOpen
        | ToolOperationKind::BrowserReload
        | ToolOperationKind::BrowserSnapshot
        | ToolOperationKind::BrowserInspect
        | ToolOperationKind::BrowserClick
        | ToolOperationKind::BrowserType
        | ToolOperationKind::BrowserScroll
        | ToolOperationKind::ProviderCall => ToolRiskLevel::High,
        ToolOperationKind::GitPush => ToolRiskLevel::Critical,
    }
}
