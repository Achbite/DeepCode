use crate::{
    CleanupContract, CleanupFailurePolicy, CleanupLeasePolicy, ContractExpiry,
    ExecutionBackendKind, ExecutionContract, FactContract, IsolationContract,
    IsolationFallbackPolicy, IsolationLevel, KernelToolContract, PathScopePolicy,
    PermissionBundleKey, PermissionContract, PlanTargetMode, PlanTargetSource, ResourceContract,
    ResourceSetSource, SandboxSupportState, TargetExistence, ToolChangeKind, ToolContentMode,
    ToolFactCategory, ToolFactKind, ToolFamily, ToolInputContract, ToolOperationKind,
    ToolOutputTrust, ToolPermissionMode, ToolTargetKind, ToolUsageConstraints, ToolValidationKind,
};
use serde_json::Value;

use super::{
    provider_schema_for_operation, RegistrationExecution, RegistrationIdentity,
    RegistrationPermission, RegistrationResources,
};

pub(crate) fn build_tool_contract(
    identity: RegistrationIdentity,
    permission: RegistrationPermission,
    execution: RegistrationExecution,
    resources: RegistrationResources,
) -> KernelToolContract {
    let RegistrationIdentity {
        tool_id,
        operation_kind,
        family,
    } = identity;
    let RegistrationPermission {
        capability,
        risk,
        mode: permission_mode,
    } = permission;
    let RegistrationExecution {
        executor_ref,
        mode: execution_mode,
        ..
    } = execution;
    let RegistrationResources {
        needs_workspace,
        read_only,
    } = resources;
    let provider_schema = provider_schema_for_operation(operation_kind);
    let provider_visible = execution_mode != crate::OperationExecutionMode::Blocked
        && operation_kind != ToolOperationKind::FsEnsureDirectory;
    KernelToolContract {
        tool_id,
        provider_visible,
        family,
        operation_kind,
        input: ToolInputContract {
            schema: provider_schema,
            planning_schema: planning_schema_for_operation(operation_kind),
            forbidden_fields: forbidden_fields_for_operation(operation_kind),
        },
        resource: ResourceContract {
            path_scope_policy: path_scope_policy(needs_workspace, read_only),
            needs_workspace,
            read_only,
            plan_target_mode: plan_target_mode_for_operation(operation_kind),
            plan_target_source: plan_target_source_for_operation(operation_kind),
            read_set_source: read_set_source_for_operation(operation_kind),
            write_set_source: write_set_source_for_operation(operation_kind),
        },
        permission: PermissionContract {
            mode: permission_mode,
            risk,
            capability,
            bundle_key: permission_bundle_key_for_operation(operation_kind),
            grant_lifetime: grant_lifetime(permission_mode),
        },
        execution: ExecutionContract {
            backend: backend_for_family(family),
            executor_ref,
            execution_mode,
            isolation: isolation_contract_for_operation(operation_kind),
            shell_allowed: false,
        },
        fact: FactContract {
            evidence_kind: fact_kind_for_operation(operation_kind),
            category: fact_category(family, read_only),
            change_operation: change_operation_for_operation(operation_kind),
            untrusted_evidence: matches!(
                family,
                ToolFamily::Network | ToolFamily::Browser | ToolFamily::Provider
            ),
            validation_kind: validation_kind_for_operation(operation_kind),
        },
        cleanup: cleanup_contract_for_operation(operation_kind),
        usage_constraints: usage_constraints_for_operation(operation_kind),
        hard_deny_rules: hard_deny_rules_for_operation(operation_kind),
    }
}

fn planning_schema_for_operation(operation_kind: ToolOperationKind) -> Value {
    if operation_kind == ToolOperationKind::FsCreate {
        return serde_json::json!({
            "type": "object",
            "properties": {
                "executable": {
                    "type": "boolean",
                    "default": false,
                    "x-deepcode-platforms": ["linux", "macos"]
                }
            },
            "additionalProperties": false
        });
    }
    serde_json::json!({
        "type": "object",
        "properties": {},
        "additionalProperties": false
    })
}

fn plan_target_mode_for_operation(operation_kind: ToolOperationKind) -> PlanTargetMode {
    match operation_kind {
        ToolOperationKind::FsRename => PlanTargetMode::SourceDestination,
        ToolOperationKind::FsRead
        | ToolOperationKind::FsList
        | ToolOperationKind::FsGlob
        | ToolOperationKind::CodeGrep
        | ToolOperationKind::FsDiff
        | ToolOperationKind::FsCreate
        | ToolOperationKind::FsWrite
        | ToolOperationKind::FsEdit
        | ToolOperationKind::FsDelete
        | ToolOperationKind::DocumentRead => PlanTargetMode::PerTarget,
        _ => PlanTargetMode::Aggregate,
    }
}

fn plan_target_source_for_operation(operation_kind: ToolOperationKind) -> PlanTargetSource {
    match operation_kind {
        ToolOperationKind::FsGlob | ToolOperationKind::CodeGrep => {
            PlanTargetSource::PathOrCurrentDirectory
        }
        ToolOperationKind::FsRead
        | ToolOperationKind::FsList
        | ToolOperationKind::FsDiff
        | ToolOperationKind::FsCreate
        | ToolOperationKind::FsWrite
        | ToolOperationKind::FsEdit
        | ToolOperationKind::FsDelete
        | ToolOperationKind::FsEnsureDirectory
        | ToolOperationKind::DocumentRead => PlanTargetSource::Path,
        ToolOperationKind::FsRename => PlanTargetSource::SourceDestination,
        ToolOperationKind::GitStatus | ToolOperationKind::GitDiff => PlanTargetSource::GitWorkspace,
        ToolOperationKind::GitStage
        | ToolOperationKind::GitUnstage
        | ToolOperationKind::GitCommit => PlanTargetSource::GitIndex,
        ToolOperationKind::GitPush => PlanTargetSource::GitRemote,
        ToolOperationKind::WebSearch => PlanTargetSource::NetworkQuery,
        ToolOperationKind::WebFetch => PlanTargetSource::NetworkUrl,
        ToolOperationKind::ProcessExec
        | ToolOperationKind::BrowserOpen
        | ToolOperationKind::BrowserReload
        | ToolOperationKind::BrowserSnapshot
        | ToolOperationKind::BrowserInspect
        | ToolOperationKind::BrowserClick
        | ToolOperationKind::BrowserType
        | ToolOperationKind::BrowserScroll
        | ToolOperationKind::ProviderCall => PlanTargetSource::None,
    }
}

fn hard_deny_rules_for_operation(operation_kind: ToolOperationKind) -> Vec<String> {
    let rules: &[&str] = match operation_kind {
        ToolOperationKind::FsDelete => &[
            "pathTraversal",
            "workspaceRootMutation",
            "outsideRegisteredRootWithoutGrant",
            "wildcardDelete",
            "directoryDeleteWithoutRecursive",
        ],
        ToolOperationKind::FsCreate
        | ToolOperationKind::FsWrite
        | ToolOperationKind::FsEdit
        | ToolOperationKind::FsRename => &[
            "pathTraversal",
            "workspaceRootMutation",
            "outsideRegisteredRootWithoutGrant",
        ],
        ToolOperationKind::ProcessExec => &[
            "rawCommandString",
            "unmanagedRedirection",
            "backgroundEscape",
        ],
        ToolOperationKind::GitPush => &["missingRemote", "missingBranch", "unapprovedRemoteWrite"],
        ToolOperationKind::WebSearch
        | ToolOperationKind::WebFetch
        | ToolOperationKind::ProviderCall => &["secretExfiltration", "unapprovedEgress"],
        _ => &[],
    };
    rules.iter().map(|rule| (*rule).to_string()).collect()
}

fn path_scope_policy(needs_workspace: bool, read_only: bool) -> PathScopePolicy {
    if !needs_workspace {
        return PathScopePolicy::None;
    }
    if read_only {
        PathScopePolicy::WorkspaceReadScope
    } else {
        PathScopePolicy::WorkspacePathScopedGrant
    }
}

fn fact_category(family: ToolFamily, read_only: bool) -> ToolFactCategory {
    match family {
        ToolFamily::Workspace | ToolFamily::Document if read_only => {
            ToolFactCategory::WorkspaceRead
        }
        ToolFamily::Workspace => ToolFactCategory::WorkspaceMutation,
        ToolFamily::Git => ToolFactCategory::Git,
        ToolFamily::Network | ToolFamily::Browser | ToolFamily::Provider => {
            ToolFactCategory::ExternalEvidence
        }
        _ => ToolFactCategory::Other,
    }
}

fn change_operation_for_operation(operation_kind: ToolOperationKind) -> Option<ToolChangeKind> {
    match operation_kind {
        ToolOperationKind::FsCreate => Some(ToolChangeKind::Create),
        ToolOperationKind::FsWrite => Some(ToolChangeKind::Write),
        ToolOperationKind::FsEdit => Some(ToolChangeKind::Edit),
        ToolOperationKind::FsRename => Some(ToolChangeKind::Rename),
        ToolOperationKind::FsDelete => Some(ToolChangeKind::Delete),
        _ => None,
    }
}

fn usage_constraints_for_operation(operation_kind: ToolOperationKind) -> ToolUsageConstraints {
    match operation_kind {
        ToolOperationKind::FsCreate => ToolUsageConstraints {
            target_existence: TargetExistence::MustNotExist,
            source_existence: None,
            destination_existence: None,
            target_kinds: vec![ToolTargetKind::File],
            content_mode: ToolContentMode::ContentBlock,
            directory_recursive_required: false,
        },
        ToolOperationKind::FsWrite => ToolUsageConstraints {
            target_existence: TargetExistence::MustExist,
            source_existence: None,
            destination_existence: None,
            target_kinds: vec![ToolTargetKind::File],
            content_mode: ToolContentMode::ContentBlock,
            directory_recursive_required: false,
        },
        ToolOperationKind::FsEdit => ToolUsageConstraints {
            target_existence: TargetExistence::MustExist,
            source_existence: None,
            destination_existence: None,
            target_kinds: vec![ToolTargetKind::File],
            content_mode: ToolContentMode::ReplacementBlock,
            directory_recursive_required: false,
        },
        ToolOperationKind::FsRename => ToolUsageConstraints {
            target_existence: TargetExistence::Any,
            source_existence: Some(TargetExistence::MustExist),
            destination_existence: Some(TargetExistence::MustNotExist),
            target_kinds: vec![ToolTargetKind::File, ToolTargetKind::Directory],
            content_mode: ToolContentMode::None,
            directory_recursive_required: false,
        },
        ToolOperationKind::FsDelete => ToolUsageConstraints {
            target_existence: TargetExistence::MustExist,
            source_existence: None,
            destination_existence: None,
            target_kinds: vec![ToolTargetKind::File, ToolTargetKind::Directory],
            content_mode: ToolContentMode::None,
            directory_recursive_required: true,
        },
        ToolOperationKind::FsRead | ToolOperationKind::FsDiff | ToolOperationKind::DocumentRead => {
            ToolUsageConstraints {
                target_existence: TargetExistence::MustExist,
                source_existence: None,
                destination_existence: None,
                target_kinds: vec![ToolTargetKind::File],
                content_mode: if operation_kind == ToolOperationKind::FsDiff {
                    ToolContentMode::ContentBlock
                } else {
                    ToolContentMode::None
                },
                directory_recursive_required: false,
            }
        }
        ToolOperationKind::FsList => ToolUsageConstraints {
            target_existence: TargetExistence::MustExist,
            source_existence: None,
            destination_existence: None,
            target_kinds: vec![ToolTargetKind::Directory],
            content_mode: ToolContentMode::None,
            directory_recursive_required: false,
        },
        _ => ToolUsageConstraints {
            target_existence: TargetExistence::Any,
            source_existence: None,
            destination_existence: None,
            target_kinds: Vec::new(),
            content_mode: ToolContentMode::None,
            directory_recursive_required: false,
        },
    }
}

fn backend_for_family(family: ToolFamily) -> ExecutionBackendKind {
    match family {
        ToolFamily::Workspace | ToolFamily::Document => ExecutionBackendKind::Builtin,
        ToolFamily::Git | ToolFamily::Process => ExecutionBackendKind::Cli,
        ToolFamily::Network | ToolFamily::Browser | ToolFamily::Provider => {
            ExecutionBackendKind::Broker
        }
    }
}

fn forbidden_fields_for_operation(operation_kind: ToolOperationKind) -> Vec<String> {
    let fields: &[&str] = match operation_kind {
        ToolOperationKind::FsDelete => &[
            "content",
            "contentBlockId",
            "replacementBlockId",
            "contentBlocks",
        ],
        ToolOperationKind::ProcessExec => &["command"],
        _ => &[],
    };
    fields.iter().map(|field| (*field).to_string()).collect()
}

fn read_set_source_for_operation(operation_kind: ToolOperationKind) -> ResourceSetSource {
    match operation_kind {
        ToolOperationKind::FsRead
        | ToolOperationKind::FsList
        | ToolOperationKind::FsGlob
        | ToolOperationKind::FsDiff
        | ToolOperationKind::CodeGrep
        | ToolOperationKind::DocumentRead => ResourceSetSource::PathOrQuery,
        ToolOperationKind::FsWrite | ToolOperationKind::FsEdit | ToolOperationKind::FsDelete => {
            ResourceSetSource::Path
        }
        ToolOperationKind::FsRename => ResourceSetSource::SourceAndDestination,
        ToolOperationKind::GitStatus => ResourceSetSource::GitWorkspace,
        ToolOperationKind::GitDiff => ResourceSetSource::GitPaths,
        ToolOperationKind::WebSearch => ResourceSetSource::Query,
        ToolOperationKind::WebFetch => ResourceSetSource::Url,
        ToolOperationKind::BrowserSnapshot | ToolOperationKind::BrowserInspect => {
            ResourceSetSource::BrowserState
        }
        ToolOperationKind::ProviderCall => ResourceSetSource::ProviderResponse,
        _ => ResourceSetSource::None,
    }
}

fn write_set_source_for_operation(operation_kind: ToolOperationKind) -> ResourceSetSource {
    match operation_kind {
        ToolOperationKind::FsCreate
        | ToolOperationKind::FsWrite
        | ToolOperationKind::FsEdit
        | ToolOperationKind::FsDelete
        | ToolOperationKind::FsEnsureDirectory => ResourceSetSource::Path,
        ToolOperationKind::FsRename => ResourceSetSource::SourceAndDestination,
        ToolOperationKind::GitStage | ToolOperationKind::GitUnstage => ResourceSetSource::GitPaths,
        ToolOperationKind::GitCommit => ResourceSetSource::GitIndex,
        ToolOperationKind::GitPush => ResourceSetSource::GitRemote,
        ToolOperationKind::ProcessExec => ResourceSetSource::Process,
        ToolOperationKind::BrowserOpen
        | ToolOperationKind::BrowserReload
        | ToolOperationKind::BrowserClick
        | ToolOperationKind::BrowserType
        | ToolOperationKind::BrowserScroll => ResourceSetSource::BrowserState,
        _ => ResourceSetSource::None,
    }
}

fn permission_bundle_key_for_operation(operation_kind: ToolOperationKind) -> PermissionBundleKey {
    match operation_kind {
        ToolOperationKind::FsCreate
        | ToolOperationKind::FsWrite
        | ToolOperationKind::FsEdit
        | ToolOperationKind::FsRename
        | ToolOperationKind::FsEnsureDirectory => PermissionBundleKey::WorkspaceWrite,
        ToolOperationKind::FsDelete => PermissionBundleKey::WorkspaceDelete,
        ToolOperationKind::GitStage
        | ToolOperationKind::GitUnstage
        | ToolOperationKind::GitCommit => PermissionBundleKey::GitWrite,
        ToolOperationKind::GitPush => PermissionBundleKey::GitPush,
        ToolOperationKind::ProcessExec => PermissionBundleKey::ProcessExec,
        ToolOperationKind::WebSearch | ToolOperationKind::WebFetch => {
            PermissionBundleKey::NetworkEgress
        }
        ToolOperationKind::BrowserOpen
        | ToolOperationKind::BrowserReload
        | ToolOperationKind::BrowserSnapshot
        | ToolOperationKind::BrowserInspect
        | ToolOperationKind::BrowserClick
        | ToolOperationKind::BrowserType
        | ToolOperationKind::BrowserScroll => PermissionBundleKey::BrowserControl,
        ToolOperationKind::ProviderCall => PermissionBundleKey::ProviderEgress,
        _ => PermissionBundleKey::None,
    }
}

fn grant_lifetime(permission_mode: ToolPermissionMode) -> ContractExpiry {
    if permission_mode == ToolPermissionMode::Ask {
        ContractExpiry::RunBatchUntilReview
    } else {
        ContractExpiry::NotRequired
    }
}

fn fact_kind_for_operation(operation_kind: ToolOperationKind) -> ToolFactKind {
    match operation_kind {
        ToolOperationKind::FsRead => ToolFactKind::FileText,
        ToolOperationKind::FsList => ToolFactKind::DirectoryTree,
        ToolOperationKind::FsGlob => ToolFactKind::FileMatches,
        ToolOperationKind::FsDiff => ToolFactKind::DiffPreview,
        ToolOperationKind::CodeGrep => ToolFactKind::SearchResults,
        ToolOperationKind::FsCreate => ToolFactKind::FileCreate,
        ToolOperationKind::FsWrite => ToolFactKind::FileWrite,
        ToolOperationKind::FsEdit => ToolFactKind::FilePatch,
        ToolOperationKind::FsRename => ToolFactKind::FileRename,
        ToolOperationKind::FsDelete => ToolFactKind::FileDelete,
        ToolOperationKind::DocumentRead => ToolFactKind::DocumentText,
        ToolOperationKind::FsEnsureDirectory => ToolFactKind::DirectoryEnsure,
        ToolOperationKind::GitStatus => ToolFactKind::GitStatus,
        ToolOperationKind::GitDiff => ToolFactKind::GitDiff,
        ToolOperationKind::GitStage | ToolOperationKind::GitUnstage => {
            ToolFactKind::GitIndexMutation
        }
        ToolOperationKind::GitCommit => ToolFactKind::GitCommit,
        ToolOperationKind::GitPush => ToolFactKind::GitPush,
        ToolOperationKind::ProcessExec => ToolFactKind::ProcessResult,
        ToolOperationKind::WebSearch => ToolFactKind::WebSearchEvidence,
        ToolOperationKind::WebFetch => ToolFactKind::WebFetchEvidence,
        ToolOperationKind::ProviderCall => ToolFactKind::ProviderCall,
        ToolOperationKind::BrowserOpen
        | ToolOperationKind::BrowserReload
        | ToolOperationKind::BrowserSnapshot
        | ToolOperationKind::BrowserInspect
        | ToolOperationKind::BrowserClick
        | ToolOperationKind::BrowserType
        | ToolOperationKind::BrowserScroll => ToolFactKind::BrowserEvidence,
    }
}

fn validation_kind_for_operation(operation_kind: ToolOperationKind) -> Option<ToolValidationKind> {
    match operation_kind {
        ToolOperationKind::FsCreate | ToolOperationKind::FsWrite => {
            Some(ToolValidationKind::ReadBack)
        }
        ToolOperationKind::FsEdit => Some(ToolValidationKind::PatchReadBack),
        ToolOperationKind::FsRename => Some(ToolValidationKind::RenameVerified),
        ToolOperationKind::FsDelete => Some(ToolValidationKind::DeleteVerified),
        _ => None,
    }
}

fn isolation_contract_for_operation(operation_kind: ToolOperationKind) -> IsolationContract {
    match operation_kind {
        ToolOperationKind::ProcessExec => IsolationContract {
            minimum_level: IsolationLevel::OsSandbox,
            support_state: SandboxSupportState::ContractOnly,
            backend_requirement: Some("bubblewrap".to_string()),
            profile_ref: Some("bubblewrap.read-only-workspace.v1".to_string()),
            fallback: IsolationFallbackPolicy::Deny,
            output_trust: ToolOutputTrust::UntrustedEvidence,
        },
        _ => IsolationContract {
            minimum_level: IsolationLevel::None,
            support_state: SandboxSupportState::Unavailable,
            backend_requirement: None,
            profile_ref: None,
            fallback: IsolationFallbackPolicy::Deny,
            output_trust: ToolOutputTrust::ToolFact,
        },
    }
}

fn cleanup_contract_for_operation(operation_kind: ToolOperationKind) -> CleanupContract {
    match operation_kind {
        ToolOperationKind::ProcessExec => CleanupContract {
            lease_policy: CleanupLeasePolicy::SandboxLease,
            terminate_process_tree: true,
            remove_scratch: true,
            revoke_broker_grant: false,
            deadline_ms: 5_000,
            failure_policy: CleanupFailurePolicy::BlockReviewAcceptance,
        },
        ToolOperationKind::ProviderCall => CleanupContract {
            lease_policy: CleanupLeasePolicy::ProviderStream,
            terminate_process_tree: false,
            remove_scratch: false,
            revoke_broker_grant: true,
            deadline_ms: 5_000,
            failure_policy: CleanupFailurePolicy::RecordFailure,
        },
        _ => CleanupContract {
            lease_policy: CleanupLeasePolicy::None,
            terminate_process_tree: false,
            remove_scratch: false,
            revoke_broker_grant: false,
            deadline_ms: 0,
            failure_policy: CleanupFailurePolicy::RecordFailure,
        },
    }
}
