use super::*;
use deepcode_kernel_abi::KernelActionBatch;
use serde_json::Value;

fn action_batch(actions: Value, content_blocks: Value) -> KernelActionBatch {
    serde_json::from_value(serde_json::json!({
        "planId": "test-plan",
        "contractId": "test-contract",
        "contractHash": "test-contract-hash",
        "actionBundle": {
            "version": "deepcode.agent.protocol.v4",
            "id": "test-bundle",
            "goal": "exercise canonical tool compilation",
            "actions": actions
        },
        "contentBlocks": content_blocks
    }))
    .expect("test action batch uses the canonical ABI")
}

fn compile_test_batch(
    batch: &KernelActionBatch,
) -> Result<Vec<PlannedOperation>, OperationCompileError> {
    let registry = KernelToolRegistry::default();
    OperationCompiler::new(&registry).compile_batch(batch)
}

#[test]
fn registry_covers_core_tool_families() {
    let registry = KernelToolRegistry::default();
    assert_eq!(
        registry.capability_for_tool("fs.write"),
        Some("workspace.write")
    );
    assert_eq!(
        registry.capability_for_tool("fs.edit"),
        Some("workspace.write")
    );
    assert_eq!(registry.capability_for_tool("git.status"), Some("git.read"));
    assert_eq!(
        registry.capability_for_tool("process.exec"),
        Some("process.exec")
    );
    assert_eq!(
        registry.capability_for_tool("web.fetch"),
        Some("network.egress")
    );
    assert_eq!(
        registry.capability_for_tool("browser.click"),
        Some("browser.control")
    );
    assert_eq!(
        registry.capability_for_tool("provider.call"),
        Some("provider.egress")
    );
    assert_eq!(registry.capability_for_tool("missing.tool"), None);
}

#[test]
fn every_registration_owns_one_complete_tool_contract() {
    let registry = KernelToolRegistry::default();
    let snapshot = registry.snapshot();
    assert_eq!(registry.registrations().count(), snapshot.tools.len());

    for registration in registry.registrations() {
        let template = registry
            .contract(registration.tool_id())
            .unwrap_or_else(|| panic!("{} template exists", registration.tool_id()));
        assert_eq!(&template, &registration.contract);
        assert!(template.input.schema.is_object());
        assert!(snapshot
            .tools
            .iter()
            .any(|tool| tool.tool_id == registration.tool_id()));
        assert_eq!(
            registry
                .get_by_operation_kind(registration.operation_kind())
                .map(KernelToolRegistration::tool_id),
            Some(registration.tool_id())
        );
        match registration.execution_mode() {
            OperationExecutionMode::Execute => {
                assert!(registration.executor_binding.is_some())
            }
            OperationExecutionMode::PreviewOnly | OperationExecutionMode::Blocked => {
                assert!(registration.executor_binding.is_none())
            }
        }
        let snapshot_entry = snapshot
            .tools
            .iter()
            .find(|tool| tool.tool_id == registration.tool_id())
            .expect("registration appears in the catalog snapshot");
        assert_eq!(
            snapshot_entry.plan_target_source,
            template.resource.plan_target_source
        );
    }
}

#[test]
fn registry_snapshot_exposes_canonical_delete_tool() {
    let snapshot = KernelToolRegistry::default().snapshot();
    assert_eq!(snapshot.catalog_version, TOOL_REGISTRY_VERSION);
    assert!(snapshot.catalog_hash.starts_with("fnv1a64:"));
    let delete = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool_id == "fs.delete")
        .expect("fs.delete tool descriptor is present");
    assert_eq!(delete.capability, "workspace.write");
    assert_eq!(delete.operation_kind, ToolOperationKind::FsDelete);
    assert_eq!(
        delete.path_scope_policy,
        PathScopePolicy::WorkspacePathScopedGrant
    );
    assert_eq!(delete.plan_target_mode, PlanTargetMode::PerTarget);
    assert_eq!(delete.provider_schema["required"][0], "path");
    assert!(delete.provider_schema["properties"]
        .get("targetResourceKind")
        .is_none());
    assert!(delete.provider_visible);
    assert_eq!(delete.execution_mode, OperationExecutionMode::Execute);
    assert_eq!(delete.permission_mode, ToolPermissionMode::Ask);
    assert!(delete
        .forbidden_fields
        .iter()
        .any(|field| field == "contentBlockId"));
    assert!(delete
        .hard_deny_rules
        .iter()
        .any(|rule| rule == "directoryDeleteWithoutRecursive"));
    assert!(delete.permission_summary.contains("Kernel gate"));
}

#[test]
fn plan_authorization_derives_parent_operation_and_one_permission_bundle() {
    let token = crate::hash_bytes(b"plan-authorization-tool-contract");
    let target = format!(
        "generated-{}/nested/output.txt",
        token
            .trim_start_matches("sha256:")
            .chars()
            .take(8)
            .collect::<String>()
    );
    let registry = KernelToolRegistry::default();
    let draft = derive_plan_authorization(
        &registry,
        &[PlanTaskIntent {
            task_id: "task-create".to_string(),
            tool_id: "fs.create".to_string(),
            targets: vec![target.clone()],
            depends_on: Vec::new(),
            args: serde_json::json!({}),
        }],
    );

    assert!(draft.diagnostics.is_empty());
    assert_eq!(draft.operations.len(), 2);
    assert_eq!(draft.operations[0].tool_id, "fs.ensure_directory");
    assert!(draft.operations[0].internal);
    assert_eq!(draft.operations[1].tool_id, "fs.create");
    assert_eq!(draft.operations[1].targets, vec![target]);
    assert_eq!(
        draft.operations[1].depends_on,
        vec![draft.operations[0].id.clone()]
    );
    assert_eq!(draft.permission_bundles.len(), 1);
    let bundle = &draft.permission_bundles[0];
    assert_eq!(bundle.capability, "workspace.write");
    assert_eq!(bundle.operation_ids.len(), 2);
    assert_eq!(bundle.tool_ids, vec!["fs.ensure_directory", "fs.create"]);
}

#[test]
fn plan_authorization_propagates_explicit_prior_task_dependencies() {
    let registry = KernelToolRegistry::default();
    let target = "generated/dependent.txt".to_string();
    let draft = derive_plan_authorization(
        &registry,
        &[
            PlanTaskIntent {
                task_id: "task-create".to_string(),
                tool_id: "fs.create".to_string(),
                targets: vec![target.clone()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
            PlanTaskIntent {
                task_id: "task-edit".to_string(),
                tool_id: "fs.edit".to_string(),
                targets: vec![target],
                depends_on: vec!["task-create".to_string()],
                args: serde_json::json!({}),
            },
        ],
    );

    assert!(draft.diagnostics.is_empty());
    let create = draft
        .operations
        .iter()
        .find(|operation| operation.source_task_id == "task-create" && !operation.internal)
        .expect("create operation");
    let edit = draft
        .operations
        .iter()
        .find(|operation| operation.source_task_id == "task-edit")
        .expect("edit operation");
    assert_eq!(edit.depends_on, vec![create.id.clone()]);
}

#[test]
fn plan_authorization_rejects_forward_task_dependencies() {
    let registry = KernelToolRegistry::default();
    let draft = derive_plan_authorization(
        &registry,
        &[
            PlanTaskIntent {
                task_id: "task-first".to_string(),
                tool_id: "fs.create".to_string(),
                targets: vec!["first.txt".to_string()],
                depends_on: vec!["task-later".to_string()],
                args: serde_json::json!({}),
            },
            PlanTaskIntent {
                task_id: "task-later".to_string(),
                tool_id: "fs.create".to_string(),
                targets: vec!["later.txt".to_string()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
        ],
    );

    assert!(draft.diagnostics.iter().any(|diagnostic| {
        diagnostic
            .message
            .contains("plan_authorization_dependency_invalid")
    }));
    assert!(draft
        .operations
        .iter()
        .all(|operation| operation.source_task_id != "task-first"));
}

#[test]
fn plan_authorization_expands_each_delete_target_and_merges_permission_bundle() {
    let registry = KernelToolRegistry::default();
    let targets = vec![
        "tree".to_string(),
        "entry-one".to_string(),
        "entry-two".to_string(),
    ];
    let draft = derive_plan_authorization(
        &registry,
        &[PlanTaskIntent {
            task_id: "task-delete".to_string(),
            tool_id: "fs.delete".to_string(),
            targets: targets.clone(),
            depends_on: Vec::new(),
            args: serde_json::json!({}),
        }],
    );

    assert!(draft.diagnostics.is_empty());
    assert_eq!(draft.operations.len(), targets.len());
    for (index, operation) in draft.operations.iter().enumerate() {
        assert_eq!(operation.id, format!("plan-op-task-delete-{}", index + 1));
        assert_eq!(operation.source_task_id, "task-delete");
        assert_eq!(operation.tool_id, "fs.delete");
        assert_eq!(operation.targets, vec![targets[index].clone()]);
        assert_eq!(operation.args_template["path"], targets[index]);
    }

    assert_eq!(draft.permission_bundles.len(), 1);
    let bundle = &draft.permission_bundles[0];
    assert_eq!(bundle.capability, "workspace.write");
    assert_eq!(bundle.operation_ids.len(), targets.len());
    assert_eq!(bundle.targets, targets);
}

#[test]
fn plan_authorization_canonicalizes_create_executable_default() {
    let draft = derive_plan_authorization(
        &KernelToolRegistry::default(),
        &[PlanTaskIntent {
            task_id: "task-create".to_string(),
            tool_id: "fs.create".to_string(),
            targets: vec!["output.txt".to_string()],
            depends_on: Vec::new(),
            args: serde_json::json!({}),
        }],
    );
    let operation = draft
        .operations
        .iter()
        .find(|operation| !operation.internal)
        .expect("create operation");
    assert_eq!(
        operation.fixed_args,
        serde_json::json!({ "executable": false })
    );
    assert_eq!(operation.args_template["executable"], false);
}

#[test]
fn internal_tools_cannot_be_requested_as_agent_operations() {
    let registry = KernelToolRegistry::default();
    let internal = registry
        .snapshot()
        .tools
        .into_iter()
        .find(|tool| tool.tool_id == "fs.ensure_directory")
        .expect("internal directory operation is registered");
    assert!(!internal.provider_visible);
    assert_eq!(internal.execution_mode, OperationExecutionMode::Execute);

    let authorization = derive_plan_authorization(
        &registry,
        &[PlanTaskIntent {
            task_id: "task-internal".to_string(),
            tool_id: "fs.ensure_directory".to_string(),
            targets: vec!["nested".to_string()],
            depends_on: Vec::new(),
            args: serde_json::json!({}),
        }],
    );
    assert!(authorization.operations.is_empty());
    assert!(authorization.permission_bundles.is_empty());
    assert!(authorization
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.hard_deny));

    let batch = action_batch(
        serde_json::json!([{
            "actionId": "ensure-internal",
            "toolId": "fs.ensure_directory",
            "args": { "path": "nested" },
            "description": "Attempt a direct internal operation",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::UnsupportedToolId { tool_id })
            if tool_id == "fs.ensure_directory"
    ));
}

#[test]
fn registry_marks_git_push_as_reserved_blocked() {
    let snapshot = KernelToolRegistry::default().snapshot();
    let git_push = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool_id == "git.push")
        .expect("git.push remains registered as reserved capability");
    assert!(!git_push.provider_visible);
    assert_eq!(git_push.execution_mode, OperationExecutionMode::Blocked);
    assert_eq!(git_push.risk, ToolRiskLevel::Critical);
    assert_eq!(git_push.permission_mode, ToolPermissionMode::Ask);
    assert_eq!(git_push.capability, "git.push");
    assert!(git_push
        .hard_deny_rules
        .iter()
        .any(|rule| rule == "unapprovedRemoteWrite"));
}

#[test]
fn registry_git_v1_formal_tools_execute_only_through_commit() {
    let registry = KernelToolRegistry::default();
    for tool_id in [
        "git.status",
        "git.diff",
        "git.stage",
        "git.unstage",
        "git.commit",
    ] {
        let registration = registry
            .get(tool_id)
            .unwrap_or_else(|| panic!("{tool_id} descriptor exists"));
        assert_eq!(
            registration.execution_mode(),
            OperationExecutionMode::Execute
        );
    }
    assert_eq!(
        registry.get("git.push").unwrap().execution_mode(),
        OperationExecutionMode::Blocked
    );
}

#[test]
fn registry_keeps_external_control_tools_blocked() {
    let registry = KernelToolRegistry::default();
    for tool_id in [
        "process.exec",
        "browser.open",
        "browser.reload",
        "browser.snapshot",
        "browser.inspect",
        "browser.click",
        "browser.type",
        "browser.scroll",
        "provider.call",
    ] {
        let registration = registry
            .get(tool_id)
            .unwrap_or_else(|| panic!("{tool_id} descriptor exists"));
        assert_eq!(
            registration.execution_mode(),
            OperationExecutionMode::Blocked
        );
    }
}

#[test]
fn process_exec_declares_os_sandbox_without_becoming_executable() {
    let registry = KernelToolRegistry::default();
    let template = registry
        .contract("process.exec")
        .expect("process.exec template exists");

    assert_eq!(
        template.execution.execution_mode,
        OperationExecutionMode::Blocked
    );
    assert_eq!(
        template.execution.isolation.minimum_level,
        IsolationLevel::OsSandbox
    );
    assert_eq!(
        template.execution.isolation.support_state,
        SandboxSupportState::ContractOnly
    );
    assert_eq!(
        template.execution.isolation.backend_requirement.as_deref(),
        Some("bubblewrap")
    );
    assert_eq!(
        template.execution.isolation.fallback,
        IsolationFallbackPolicy::Deny
    );
    assert_eq!(
        template.cleanup.lease_policy,
        CleanupLeasePolicy::SandboxLease
    );
    assert!(template.cleanup.terminate_process_tree);
    assert!(template.cleanup.remove_scratch);
    assert_eq!(
        template.cleanup.failure_policy,
        CleanupFailurePolicy::BlockReviewAcceptance
    );
}

#[test]
fn catalog_snapshot_exposes_isolation_contract_as_metadata() {
    let snapshot = KernelToolRegistry::default().snapshot();
    assert_eq!(snapshot.catalog_version, TOOL_REGISTRY_VERSION);

    let process = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool_id == "process.exec")
        .expect("process.exec catalog entry exists");
    assert_eq!(process.execution_mode, OperationExecutionMode::Blocked);
    assert_eq!(
        process.isolation.support_state,
        SandboxSupportState::ContractOnly
    );
    assert_eq!(process.isolation.minimum_level, IsolationLevel::OsSandbox);

    let read = snapshot
        .tools
        .iter()
        .find(|tool| tool.tool_id == "fs.read")
        .expect("fs.read catalog entry exists");
    assert_eq!(read.isolation.minimum_level, IsolationLevel::None);
    assert_eq!(
        read.isolation.support_state,
        SandboxSupportState::Unavailable
    );
    assert!(read.isolation.backend_requirement.is_none());
}

#[test]
fn compiler_requires_write_content_block() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "src/lib.rs" },
            "description": "Write file",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::InvalidInput(
            ToolInputValidationError::MissingField { field, .. }
        )) if field == "contentBlockId"
    ));
}

#[test]
fn compiler_builds_workspace_write_operation() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": {
                "path": "src/lib.rs",
                "contentBlockId": "block-1"
            },
            "description": "Write file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "src/lib.rs",
            "operation": "overwrite",
            "contentLines": ["fn main() {}"]
        }]),
    );
    let operations = compile_test_batch(&batch).unwrap();
    assert_eq!(operations.len(), 1);
    assert_eq!(operations[0].write_set, vec!["src/lib.rs"]);
    assert!(matches!(
        &operations[0].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::Write
    ));
}

#[test]
fn compiler_builds_workspace_delete_operation_without_code_block() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "delete-1",
            "toolId": "fs.delete",
            "args": {
                "path": "generated/obsolete.txt",
                "targetKind": "file",
                "recursive": false
            },
            "description": "Delete file",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    let operations = compile_test_batch(&batch).unwrap();
    assert_eq!(operations.len(), 1);
    assert_eq!(operations[0].write_set, vec!["generated/obsolete.txt"]);
    assert!(matches!(
        &operations[0].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::Delete
    ));
}

#[test]
fn compiler_preserves_workspace_directory_delete_metadata() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "delete-directory",
            "toolId": "fs.delete",
            "args": {
                "path": "generated",
                "targetKind": "directory",
                "recursive": true
            },
            "description": "Delete directory",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    let operations = compile_test_batch(&batch).unwrap();
    assert_eq!(operations.len(), 1);
    match &operations[0].operation {
        PlannedOperationKind::Workspace(operation) => {
            assert_eq!(operation.kind, WorkspaceOperationKind::Delete);
            assert_eq!(operation.target_kind.as_deref(), Some("directory"));
            assert!(operation.recursive);
        }
        other => panic!("expected workspace delete operation, got {other:?}"),
    }
}

#[test]
fn compiler_builds_workspace_create_operation_with_parent_dependency() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "create-1",
            "toolId": "fs.create",
            "args": {
                "path": "generated/new.txt",
                "contentBlockId": "block-1"
            },
            "description": "Create file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "generated/new.txt",
            "operation": "create",
            "contentLines": ["new"]
        }]),
    );
    let operations = compile_test_batch(&batch).unwrap();
    assert_eq!(operations.len(), 2);
    assert!(matches!(
        &operations[0].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::EnsureDirectory
    ));
    assert!(matches!(
        &operations[1].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::Create
    ));
    assert_eq!(operations[1].depends_on, vec![operations[0].id.clone()]);
}

#[test]
fn compiler_rejects_workspace_delete_without_target() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "delete-1",
            "toolId": "fs.delete",
            "args": {},
            "description": "Delete file",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::InvalidInput(
            ToolInputValidationError::MissingField { field, .. }
        )) if field == "path"
    ));
}

#[test]
fn compiler_rejects_workspace_delete_root_target() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "delete-1",
            "toolId": "fs.delete",
            "args": { "path": ".", "targetKind": "directory", "recursive": true },
            "description": "Delete root",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::DeleteWorkspaceRoot { .. })
    ));
}

#[test]
fn compiler_rejects_empty_write_content_by_default() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "src/lib.rs", "contentBlockId": "block-1" },
            "description": "Write file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "src/lib.rs",
            "operation": "overwrite",
            "contentLines": []
        }]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::InvalidInput(
            ToolInputValidationError::EmptyContentBlock { .. }
        ))
    ));
}

#[test]
fn compiler_preserves_empty_lines_inside_non_empty_content() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "write-logical-block",
            "toolId": "fs.write",
            "args": { "path": "notes.txt", "contentBlockId": "block-1" },
            "description": "Write text with intentional blank lines",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "notes.txt",
            "operation": "overwrite",
            "contentLines": ["first", "", "third"]
        }]),
    );
    let operations = compile_test_batch(&batch).expect("blank lines are valid text content");
    assert!(matches!(
        &operations[0].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::Write
                && operation.content.as_deref() == Some("first\n\nthird")
    ));
}

#[test]
fn compiler_rejects_noncanonical_action_fields() {
    let result = serde_json::from_value::<KernelActionBatch>(serde_json::json!({
        "planId": "test-plan",
        "contractId": "test-contract",
        "contractHash": "test-contract-hash",
        "actionBundle": {
            "version": "deepcode.agent.protocol.v4",
            "id": "test-bundle",
            "goal": "reject noncanonical action fields",
            "actions": [{
                "actionId": "delete-1",
                "toolId": "fs.delete",
                "capability": "workspace.write",
                "args": { "path": "obsolete.txt" },
                "description": "Delete file",
                "dependsOn": []
            }]
        },
        "contentBlocks": []
    }));
    let error = result.expect_err("provider cannot declare capability");
    assert!(error.to_string().contains("unknown field `capability`"));
}

#[test]
fn compiler_rejects_args_outside_the_tool_contract() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "delete-1",
            "toolId": "fs.delete",
            "args": {
                "path": "obsolete.txt",
                "targetResourceKind": "file"
            },
            "description": "Delete file",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::InvalidInput(
            ToolInputValidationError::UnknownField { field, .. }
        )) if field == "targetResourceKind"
    ));
}

#[test]
fn compiler_rejects_content_block_target_mismatch() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "src/lib.rs", "contentBlockId": "block-1" },
            "description": "Write file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "src/other.rs",
            "operation": "overwrite",
            "contentLines": ["fn value() {}"]
        }]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::ContentBlockTargetMismatch { .. })
    ));
}

#[test]
fn compiler_rejects_content_block_operation_mismatch() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "src/lib.rs", "contentBlockId": "block-1" },
            "description": "Write file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "src/lib.rs",
            "operation": "create",
            "contentLines": ["fn value() {}"]
        }]),
    );
    assert!(matches!(
        compile_test_batch(&batch),
        Err(OperationCompileError::ContentBlockOperationMismatch { .. })
    ));
}

#[test]
fn compiler_allows_explicit_empty_file_creation() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "create-empty",
            "toolId": "fs.create",
            "args": { "path": "empty.txt", "contentBlockId": "block-1" },
            "description": "Create empty file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "empty.txt",
            "operation": "createEmpty",
            "contentLines": [],
            "allowEmptyContent": true
        }]),
    );
    let operations = compile_test_batch(&batch).unwrap();
    assert!(matches!(
        &operations[0].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::Create
                && operation.allow_empty_content
    ));
}

#[test]
fn compiler_builds_workspace_patch_operation() {
    let batch = action_batch(
        serde_json::json!([{
            "actionId": "patch-1",
            "toolId": "fs.edit",
            "args": {
                "path": "src/lib.rs",
                "replacementBlockId": "block-1",
                "patchSpec": {
                    "match": { "kind": "exactBlock", "text": "old()" }
                }
            },
            "description": "Edit file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-1",
            "targetPath": "src/lib.rs",
            "operation": "replaceBlock",
            "contentLines": ["new()"]
        }]),
    );
    let operations = compile_test_batch(&batch).unwrap();
    assert!(matches!(
        &operations[0].operation,
        PlannedOperationKind::Workspace(operation)
            if operation.kind == WorkspaceOperationKind::Patch
    ));
}

#[test]
fn graph_groups_reads_and_serial_writes() {
    let operations = vec![
        PlannedOperation {
            id: "read".to_string(),
            title: "Read".to_string(),
            tool_id: "fs.read".to_string(),
            operation_kind: ToolOperationKind::FsRead,
            depends_on: Vec::new(),
            capability: "fs.read".to_string(),
            permission_labels: Vec::new(),
            target_ref: Some(FileTargetRef::from_path("src/lib.rs")),
            read_set: vec!["src/lib.rs".to_string()],
            write_set: Vec::new(),
            conflict_keys: vec!["src/lib.rs".to_string()],
            execution_mode: OperationExecutionMode::Execute,
            operation: PlannedOperationKind::Workspace(Box::new(WorkspaceOperation {
                kind: WorkspaceOperationKind::Read,
                target_path: Some("src/lib.rs".to_string()),
                target_kind: None,
                recursive: false,
                content_block_id: None,
                replacement_block_id: None,
                content: None,
                patch_spec: None,
                allow_empty_content: false,
                temporary: false,
                executable: false,
                query: None,
                pattern: None,
                depth: None,
                include_hidden: false,
                include: Vec::new(),
                exclude: Vec::new(),
                strategy: None,
                context_lines: None,
                max_results: None,
                rename_to: None,
                start_line: None,
                end_line: None,
                start_page: None,
                end_page: None,
            })),
        },
        PlannedOperation {
            id: "write".to_string(),
            title: "Write".to_string(),
            tool_id: "fs.write".to_string(),
            operation_kind: ToolOperationKind::FsWrite,
            depends_on: Vec::new(),
            capability: "fs.write".to_string(),
            permission_labels: Vec::new(),
            target_ref: Some(FileTargetRef::from_path("src/lib.rs")),
            read_set: Vec::new(),
            write_set: vec!["src/lib.rs".to_string()],
            conflict_keys: vec!["src/lib.rs".to_string()],
            execution_mode: OperationExecutionMode::Execute,
            operation: PlannedOperationKind::Workspace(Box::new(WorkspaceOperation {
                kind: WorkspaceOperationKind::Write,
                target_path: Some("src/lib.rs".to_string()),
                target_kind: None,
                recursive: false,
                content_block_id: Some("block".to_string()),
                replacement_block_id: None,
                content: Some("x".to_string()),
                patch_spec: None,
                allow_empty_content: false,
                temporary: false,
                executable: false,
                query: None,
                pattern: None,
                depth: None,
                include_hidden: false,
                include: Vec::new(),
                exclude: Vec::new(),
                strategy: None,
                context_lines: None,
                max_results: None,
                rename_to: None,
                start_line: None,
                end_line: None,
                start_page: None,
                end_page: None,
            })),
        },
    ];
    let graph = WorkUnitGraph::from_operations(&operations);
    assert_eq!(graph.concurrency_groups[0].mode, "parallel");
    assert_eq!(graph.concurrency_groups[1].mode, "serial");
}
