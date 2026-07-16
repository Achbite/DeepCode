use crate::{
    CleanupContract, ExecutionBackendKind, ExecutionContract, FactContract, IsolationContract,
    IsolationFallbackPolicy, IsolationLevel, KernelToolDescriptor, KernelToolTemplate,
    PermissionContract, PlanTargetMode, ResourceContract, SandboxSupportState, ToolFactCategory,
    ToolFamily, ToolInputContract, ToolPermissionMode, ToolUsageConstraints,
};
use serde_json::Value;

pub(crate) fn build_tool_template(
    descriptor: &KernelToolDescriptor,
    provider_schema: Value,
    provider_visible: bool,
) -> KernelToolTemplate {
    KernelToolTemplate {
        tool_id: descriptor.tool_id,
        provider_visible,
        family: descriptor.family,
        operation_kind: operation_kind_for_tool(descriptor.tool_id),
        input: ToolInputContract {
            schema: provider_schema,
            planning_schema: planning_schema_for_tool(descriptor.tool_id),
            forbidden_fields: forbidden_fields_for_tool(descriptor.tool_id),
        },
        resource: ResourceContract {
            path_scope_policy: path_scope_policy_for_descriptor(descriptor),
            needs_workspace: descriptor.needs_workspace,
            read_only: descriptor.read_only,
            plan_target_mode: plan_target_mode_for_tool(descriptor.tool_id),
            read_set_source: read_set_source_for_tool(descriptor.tool_id),
            write_set_source: write_set_source_for_tool(descriptor.tool_id),
        },
        permission: PermissionContract {
            mode: descriptor.permission_mode,
            risk: descriptor.risk,
            capability: descriptor.capability,
            bundle_key: permission_bundle_key_for_tool(descriptor.tool_id),
            grant_lifetime: grant_lifetime_for_tool(descriptor),
        },
        execution: ExecutionContract {
            backend: backend_for_tool(descriptor),
            executor_ref: descriptor.executor_ref,
            execution_mode: descriptor.execution_mode,
            isolation: isolation_contract_for_tool(descriptor.tool_id),
            shell_allowed: false,
        },
        fact: FactContract {
            evidence_kind: fact_kind_for_tool(descriptor.tool_id),
            category: fact_category_for_tool(descriptor),
            change_operation: change_operation_for_tool(descriptor.tool_id),
            untrusted_evidence: matches!(
                descriptor.family,
                ToolFamily::Network | ToolFamily::Browser | ToolFamily::Provider
            ),
            validation_kind: validation_kind_for_tool(descriptor.tool_id),
        },
        cleanup: cleanup_contract_for_tool(descriptor.tool_id),
        usage_constraints: usage_constraints_for_tool(descriptor.tool_id),
    }
}

fn planning_schema_for_tool(tool_id: &str) -> Value {
    if tool_id == "fs.create" {
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

fn plan_target_mode_for_tool(tool_id: &str) -> PlanTargetMode {
    match tool_id {
        "fs.rename" => PlanTargetMode::SourceDestination,
        "fs.read" | "fs.list" | "fs.glob" | "code.grep" | "fs.diff" | "fs.create" | "fs.write"
        | "fs.edit" | "fs.delete" | "document.read" => PlanTargetMode::PerTarget,
        _ => PlanTargetMode::Aggregate,
    }
}

pub(crate) fn hard_deny_rules_for_tool(tool_id: &str) -> Vec<String> {
    let rules: &[&str] = match tool_id {
        "fs.delete" => &[
            "pathTraversal",
            "workspaceRootMutation",
            "outsideRegisteredRootWithoutGrant",
            "wildcardDelete",
            "directoryDeleteWithoutRecursive",
        ],
        "fs.create" | "fs.write" | "fs.edit" | "fs.rename" => &[
            "pathTraversal",
            "workspaceRootMutation",
            "outsideRegisteredRootWithoutGrant",
        ],
        "process.exec" => &[
            "commandStringFallback",
            "unmanagedRedirection",
            "backgroundEscape",
        ],
        "git.push" => &["missingRemote", "missingBranch", "unapprovedRemoteWrite"],
        "web.search" | "web.fetch" | "provider.call" => &["secretExfiltration", "unapprovedEgress"],
        _ => &[],
    };
    rules.iter().map(|rule| (*rule).to_string()).collect()
}

fn path_scope_policy_for_descriptor(descriptor: &KernelToolDescriptor) -> &'static str {
    if !descriptor.needs_workspace {
        return "none";
    }
    if descriptor.read_only {
        "workspace-read-scope"
    } else {
        "workspace-path-scoped-grant"
    }
}

fn fact_category_for_tool(descriptor: &KernelToolDescriptor) -> ToolFactCategory {
    match descriptor.family {
        ToolFamily::Workspace | ToolFamily::Document if descriptor.read_only => {
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

fn change_operation_for_tool(tool_id: &str) -> Option<&'static str> {
    match tool_id {
        "fs.create" => Some("create"),
        "fs.write" => Some("write"),
        "fs.edit" => Some("patch"),
        "fs.rename" => Some("rename"),
        "fs.delete" => Some("delete"),
        _ => None,
    }
}

fn usage_constraints_for_tool(tool_id: &str) -> ToolUsageConstraints {
    match tool_id {
        "fs.create" => ToolUsageConstraints {
            target_existence: "mustNotExist",
            source_existence: None,
            destination_existence: None,
            target_kinds: vec!["file"],
            content_mode: "contentBlock",
            directory_recursive_required: false,
        },
        "fs.write" => ToolUsageConstraints {
            target_existence: "mustExist",
            source_existence: None,
            destination_existence: None,
            target_kinds: vec!["file"],
            content_mode: "contentBlock",
            directory_recursive_required: false,
        },
        "fs.edit" => ToolUsageConstraints {
            target_existence: "mustExist",
            source_existence: None,
            destination_existence: None,
            target_kinds: vec!["file"],
            content_mode: "replacementBlock",
            directory_recursive_required: false,
        },
        "fs.rename" => ToolUsageConstraints {
            target_existence: "any",
            source_existence: Some("mustExist"),
            destination_existence: Some("mustNotExist"),
            target_kinds: vec!["file", "directory"],
            content_mode: "none",
            directory_recursive_required: false,
        },
        "fs.delete" => ToolUsageConstraints {
            target_existence: "mustExist",
            source_existence: None,
            destination_existence: None,
            target_kinds: vec!["file", "directory"],
            content_mode: "none",
            directory_recursive_required: true,
        },
        "fs.read" | "fs.diff" | "document.read" => ToolUsageConstraints {
            target_existence: "mustExist",
            source_existence: None,
            destination_existence: None,
            target_kinds: vec!["file"],
            content_mode: if tool_id == "fs.diff" {
                "contentBlock"
            } else {
                "none"
            },
            directory_recursive_required: false,
        },
        "fs.list" => ToolUsageConstraints {
            target_existence: "mustExist",
            source_existence: None,
            destination_existence: None,
            target_kinds: vec!["directory"],
            content_mode: "none",
            directory_recursive_required: false,
        },
        _ => ToolUsageConstraints {
            target_existence: "any",
            source_existence: None,
            destination_existence: None,
            target_kinds: Vec::new(),
            content_mode: "none",
            directory_recursive_required: false,
        },
    }
}

fn backend_for_tool(descriptor: &KernelToolDescriptor) -> ExecutionBackendKind {
    match descriptor.family {
        ToolFamily::Workspace | ToolFamily::Document => ExecutionBackendKind::Builtin,
        ToolFamily::Git | ToolFamily::Process => ExecutionBackendKind::Cli,
        ToolFamily::Network | ToolFamily::Browser | ToolFamily::Provider => {
            ExecutionBackendKind::Broker
        }
    }
}

fn forbidden_fields_for_tool(tool_id: &str) -> Vec<String> {
    let fields: &[&str] = match tool_id {
        "fs.delete" => &[
            "content",
            "contentBlockId",
            "replacementBlockId",
            "contentBlocks",
        ],
        "process.exec" => &["command"],
        _ => &[],
    };
    fields.iter().map(|field| (*field).to_string()).collect()
}

fn read_set_source_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.read" | "fs.list" | "fs.glob" | "fs.diff" | "code.grep" | "document.read" => {
            "path-or-query"
        }
        "fs.write" | "fs.edit" | "fs.delete" => "path",
        "fs.rename" => "source-and-destination",
        "git.status" => "git-workspace",
        "git.diff" => "git-paths",
        "web.search" => "query",
        "web.fetch" => "url",
        "browser.snapshot" | "browser.inspect" => "browser-state",
        "provider.call" => "provider-response",
        _ => "none",
    }
}

fn write_set_source_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.create" | "fs.write" | "fs.edit" | "fs.delete" | "fs.ensure_directory" => "path",
        "fs.rename" => "source-and-destination",
        "git.stage" | "git.unstage" => "git-paths",
        "git.commit" => "git-index",
        "git.push" => "git-remote",
        "process.exec" => "process",
        "browser.open" | "browser.reload" | "browser.click" | "browser.type" | "browser.scroll" => {
            "browser-state"
        }
        _ => "none",
    }
}

fn permission_bundle_key_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.create" | "fs.write" | "fs.edit" | "fs.rename" | "fs.ensure_directory" => {
            "workspace-write"
        }
        "fs.delete" => "workspace-delete",
        "git.stage" | "git.unstage" | "git.commit" => "git-write",
        "git.push" => "git-push",
        "process.exec" => "process-exec",
        "web.search" | "web.fetch" => "network-egress",
        "browser.open" | "browser.reload" | "browser.snapshot" | "browser.inspect"
        | "browser.click" | "browser.type" | "browser.scroll" => "browser-control",
        "provider.call" => "provider-egress",
        _ => "none",
    }
}

fn grant_lifetime_for_tool(descriptor: &KernelToolDescriptor) -> &'static str {
    if descriptor.permission_mode == ToolPermissionMode::Ask {
        "run-batch-until-review"
    } else {
        "not-required"
    }
}

fn fact_kind_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.read" => "fileText",
        "fs.list" => "directoryTree",
        "fs.glob" => "fileMatches",
        "fs.diff" => "diffPreview",
        "code.grep" => "searchResults",
        "fs.create" => "fileCreate",
        "fs.write" => "fileWrite",
        "fs.edit" => "filePatch",
        "fs.rename" => "fileRename",
        "fs.delete" => "fileDelete",
        "document.read" => "documentText",
        "fs.ensure_directory" => "directoryEnsure",
        "git.status" => "gitStatus",
        "git.diff" => "gitDiff",
        "git.stage" | "git.unstage" => "gitIndexMutation",
        "git.commit" => "gitCommit",
        "git.push" => "gitPush",
        "process.exec" => "processResult",
        "web.search" => "webSearchEvidence",
        "web.fetch" => "webFetchEvidence",
        "provider.call" => "providerCall",
        _ if tool_id.starts_with("browser.") => "browserEvidence",
        _ => "toolResult",
    }
}

fn validation_kind_for_tool(tool_id: &str) -> Option<&'static str> {
    match tool_id {
        "fs.create" | "fs.write" => Some("readBack"),
        "fs.edit" => Some("patchReadBack"),
        "fs.rename" => Some("renameVerified"),
        "fs.delete" => Some("deleteVerified"),
        _ => None,
    }
}

fn isolation_contract_for_tool(tool_id: &str) -> IsolationContract {
    match tool_id {
        "process.exec" => IsolationContract {
            minimum_level: IsolationLevel::OsSandbox,
            support_state: SandboxSupportState::ContractOnly,
            backend_requirement: Some("bubblewrap".to_string()),
            profile_ref: Some("bubblewrap.read-only-workspace.v1".to_string()),
            fallback: IsolationFallbackPolicy::Deny,
            output_trust: "untrustedEvidence".to_string(),
        },
        _ => IsolationContract {
            minimum_level: IsolationLevel::None,
            support_state: SandboxSupportState::Unavailable,
            backend_requirement: None,
            profile_ref: None,
            fallback: IsolationFallbackPolicy::Deny,
            output_trust: "toolFact".to_string(),
        },
    }
}

fn cleanup_contract_for_tool(tool_id: &str) -> CleanupContract {
    match tool_id {
        "process.exec" => CleanupContract {
            lease_policy: "sandboxLease".to_string(),
            terminate_process_tree: true,
            remove_scratch: true,
            revoke_broker_grant: false,
            deadline_ms: 5_000,
            failure_policy: "blockReviewAcceptance".to_string(),
        },
        "provider.call" => CleanupContract {
            lease_policy: "providerStream".to_string(),
            terminate_process_tree: false,
            remove_scratch: false,
            revoke_broker_grant: true,
            deadline_ms: 5_000,
            failure_policy: "recordFailure".to_string(),
        },
        _ => CleanupContract {
            lease_policy: "none".to_string(),
            terminate_process_tree: false,
            remove_scratch: false,
            revoke_broker_grant: false,
            deadline_ms: 0,
            failure_policy: "recordFailure".to_string(),
        },
    }
}

fn operation_kind_for_tool(tool_id: &str) -> Option<&'static str> {
    match tool_id {
        "fs.read" => Some("read"),
        "fs.list" => Some("list"),
        "fs.glob" => Some("glob"),
        "fs.diff" => Some("diff"),
        "code.grep" => Some("search"),
        "fs.create" => Some("create"),
        "fs.write" => Some("write"),
        "fs.edit" => Some("patch"),
        "fs.rename" => Some("rename"),
        "fs.delete" => Some("delete"),
        "document.read" => Some("documentRead"),
        "fs.ensure_directory" => Some("ensureDirectory"),
        "git.status" => Some("status"),
        "git.diff" => Some("diff"),
        "git.stage" => Some("stage"),
        "git.unstage" => Some("unstage"),
        "git.commit" => Some("commit"),
        "git.push" => Some("push"),
        "process.exec" => Some("exec"),
        "web.search" => Some("search"),
        "web.fetch" => Some("fetch"),
        "browser.open" => Some("open"),
        "browser.reload" => Some("reload"),
        "browser.snapshot" => Some("snapshot"),
        "browser.inspect" => Some("inspect"),
        "browser.click" => Some("click"),
        "browser.type" => Some("type"),
        "browser.scroll" => Some("scroll"),
        "provider.call" => Some("egress"),
        _ => None,
    }
}
