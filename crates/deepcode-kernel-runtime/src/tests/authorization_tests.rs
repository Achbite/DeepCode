use super::*;

#[test]
fn create_derives_parent_operation_and_writes_new_file() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "create-1",
            "toolId": "fs.create",
            "args": { "path": "generated/new.txt", "contentBlockId": "content-1" },
            "description": "Create nested file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "content-1",
            "targetPath": "generated/new.txt",
            "operation": "create",
            "contentLines": ["created"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    let operations = report["executionContract"]["operations"]
        .as_array()
        .expect("contract operations");
    assert_eq!(operations.len(), 2);
    assert_eq!(operations[0]["toolId"], "fs.ensure_directory");
    assert_eq!(operations[1]["toolId"], "fs.create");
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(terminal_tool(&events, "fs.ensure_directory", true));
    assert!(terminal_tool(&events, "fs.create", true));
    assert_eq!(
        fs::read_to_string(workspace.join("generated/new.txt")).unwrap(),
        "created"
    );
}

#[cfg(unix)]
#[test]
fn accepted_plan_create_executable_is_hashed_authorized_and_created_as_0755() {
    use std::os::unix::fs::PermissionsExt;

    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let plan_id = format!("plan-executable-{suffix}");
    let target = format!("entry-{suffix}");
    let review = review_plan_tasks(
        &mut runtime,
        &plan_id,
        vec![TaskIntentTask {
            task_id: format!("task-executable-{suffix}"),
            tool_id: "fs.create".to_string(),
            targets: vec![target.clone()],
            depends_on: Vec::new(),
            args: serde_json::json!({ "executable": true }),
        }],
    );
    let operation = review
        .authorization_contract
        .operations
        .iter()
        .find(|operation| !operation.internal)
        .expect("authorized create operation");
    assert_eq!(operation.fixed_args["executable"], true);
    assert_eq!(operation.args_template["executable"], true);
    accept_plan_review(&mut runtime, &plan_id, &review);

    let block_id = format!("executable-content-{suffix}");
    let mut payload = action_bundle(
        serde_json::json!([{
            "actionId": format!("create-executable-{suffix}"),
            "toolId": "fs.create",
            "args": {
                "path": target,
                "contentBlockId": block_id,
                "executable": true
            },
            "description": "Create an executable text file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": block_id,
            "targetPath": target,
            "operation": "create",
            "contentLines": ["#!/bin/sh", "exit 0"]
        }]),
    );
    payload.as_object_mut().unwrap().insert(
        "authorizationContractId".to_string(),
        Value::String(review.authorization_contract.id.clone()),
    );
    let report = submit_proposal_raw(&mut runtime, payload.clone());
    assert_eq!(report["status"], "authorizedByPlan");
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(terminal_tool(&events, "fs.create", true));
    assert_eq!(
        fs::metadata(workspace.join(target))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o755
    );
}

#[test]
fn uncommitted_temporary_create_rolls_back_its_lease_without_touching_user_files() {
    let (runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let missing_target = format!("missing-parent-{suffix}/temporary-{suffix}.txt");
    let event = runtime
        .execute_bound_tool(
            "run-1",
            "session-1",
            format!("temp-create-{suffix}"),
            "fs.create".to_string(),
            ToolOperationKind::FsCreate,
            serde_json::json!({
                "path": &missing_target,
                "content": "temporary",
                "temporary": true,
                "executable": false,
                "kernelContext": {
                    "contractId": format!("contract-temp-create-{suffix}"),
                    "workUnitId": format!("work-unit-temp-create-{suffix}"),
                },
            }),
        )
        .expect("failed tool execution still produces a typed completion fact");
    assert!(event
        .iter()
        .any(|event| matches!(event, KernelEvent::ToolCompleted { fact, .. } if !fact.ok)));
    assert!(!workspace.join(&missing_target).exists());
    assert!(runtime
        .state
        .resource_manager
        .list()
        .iter()
        .filter(|resource| resource.kind == KernelResourceKind::TempArtifact)
        .all(|resource| resource.state == KernelResourceState::Released));

    let user_file = workspace.join("input.txt");
    let original = fs::read_to_string(&user_file).expect("read user file before guarded write");
    let write_error = runtime
        .execute_bound_tool(
            "run-1",
            "session-1",
            format!("temp-write-{suffix}"),
            "fs.write".to_string(),
            ToolOperationKind::FsWrite,
            serde_json::json!({
                "path": "input.txt",
                "content": "must not be written",
                "temporary": true,
                "kernelContext": {
                    "contractId": format!("contract-temp-write-{suffix}"),
                    "workUnitId": format!("work-unit-temp-write-{suffix}"),
                },
            }),
        )
        .expect_err("unleased temporary write must fail before executor invocation");
    assert_eq!(
        KernelErrorEnvelope::from(&write_error).code,
        "temporary_resource_unavailable"
    );
    assert_eq!(
        fs::read_to_string(user_file).expect("read user file after guarded write"),
        original
    );
}

#[test]
fn accepted_plan_authorization_executes_without_repeated_permission_and_releases_lease() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let task_id = format!("task-plan-create-{suffix}");
    let plan_id = format!("plan-authorization-{suffix}");
    let plan_hash = format!("plan-hash-{suffix}");
    let target = format!("generated-{suffix}/nested/output.txt");
    let snapshot = KernelToolRegistry::default().snapshot();
    let reviewed = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("plan-authorization-submit-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: plan_id.clone(),
                plan_hash: plan_hash.clone(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks: vec![TaskIntentTask {
                    task_id: task_id.clone(),
                    tool_id: "fs.create".to_string(),
                    targets: vec![target.clone()],
                    depends_on: Vec::new(),
                    args: serde_json::json!({}),
                }],
            },
        })
        .expect("Kernel compiles plan authorization");
    let review = reviewed
        .iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review.clone()),
            _ => None,
        })
        .expect("plan authorization review");
    assert_eq!(review.status, PlanAuthorizationStatus::Confirmable);
    assert_eq!(review.authorization_contract.operations.len(), 2);
    assert_eq!(
        review.authorization_contract.operations[0].tool_id,
        "fs.ensure_directory"
    );
    assert_eq!(review.authorization_contract.permission_bundles.len(), 1);
    assert_eq!(
        review.authorization_contract.permission_bundles[0]
            .operation_ids
            .len(),
        2
    );

    let authorization_contract_id = review.authorization_contract.id.clone();
    let accepted = runtime
        .dispatch(KernelCommand::PlanAuthorizationDecisionSubmit {
            request_id: RequestId(format!("plan-authorization-accept-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: PlanAuthorizationDecisionSubmit {
                decision_id: format!("plan-decision-{suffix}"),
                authorization_contract_id: authorization_contract_id.clone(),
                plan_id: plan_id.clone(),
                plan_hash,
                contract_hash: review.authorization_contract.contract_hash.clone(),
                decision: PlanAuthorizationDecisionKind::Accept,
            },
        })
        .expect("user accepts Kernel plan authorization contract");
    assert!(accepted.iter().any(|event| matches!(
        event,
        KernelEvent::PlanAuthorizationDecisionRecorded {
            lease_id: Some(_),
            ..
        }
    )));
    assert!(runtime.plan_grant_lease_active("run-1", &authorization_contract_id));

    let mut payload = action_bundle(
        serde_json::json!([{
            "actionId": format!("create-{suffix}"),
            "toolId": "fs.create",
            "args": { "path": target, "contentBlockId": format!("content-{suffix}") },
            "description": "Create an authorized nested file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": format!("content-{suffix}"),
            "targetPath": target,
            "operation": "create",
            "contentLines": ["created by plan authorization"]
        }]),
    );
    let payload_object = payload.as_object_mut().expect("action payload object");
    payload_object.insert(
        "authorizationContractId".to_string(),
        Value::String(authorization_contract_id.clone()),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    assert_eq!(report["status"], "authorizedByPlan");
    assert_eq!(
        report["executionContract"]["authorizationContractId"],
        authorization_contract_id
    );
    assert_eq!(
        report["requiredPermissions"].as_array().map(Vec::len),
        Some(0)
    );

    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::PermissionRequested { .. })));
    assert!(terminal_tool(&events, "fs.ensure_directory", true));
    assert!(terminal_tool(&events, "fs.create", true));
    assert_eq!(
        fs::read_to_string(workspace.join(&target)).expect("authorized file exists"),
        "created by plan authorization"
    );
    assert!(runtime.plan_grant_lease_active("run-1", &authorization_contract_id));

    runtime
        .dispatch(KernelCommand::ReviewGateEvaluate {
            request_id: RequestId(format!("plan-review-gate-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: ReviewGateDecision {
                decision: ReviewGateDecisionKind::Accept,
                guidance: None,
            },
        })
        .expect("review gate releases plan authorization resources");
    assert!(!runtime.plan_grant_lease_active("run-1", &authorization_contract_id));
    assert!(!runtime
        .state
        .plan_authorization_contracts_by_run
        .contains_key("run-1"));
}

#[test]
fn sequential_tasks_reuse_plan_permission_bundle_without_resource_identity_collision() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let plan_id = format!("plan-sequential-{suffix}");
    let first_task_id = format!("task-first-{suffix}");
    let second_task_id = format!("task-second-{suffix}");
    let first_target = format!("first-{suffix}.txt");
    let second_target = format!("second-{suffix}.txt");
    let review = review_plan_tasks(
        &mut runtime,
        &plan_id,
        vec![
            TaskIntentTask {
                task_id: first_task_id,
                tool_id: "fs.create".to_string(),
                targets: vec![first_target.clone()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
            TaskIntentTask {
                task_id: second_task_id,
                tool_id: "fs.create".to_string(),
                targets: vec![second_target.clone()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
        ],
    );
    assert_eq!(review.authorization_contract.permission_bundles.len(), 1);
    accept_plan_review(&mut runtime, &plan_id, &review);
    let authorization_contract_id = review.authorization_contract.id.clone();

    for (index, target) in [first_target.clone(), second_target.clone()]
        .into_iter()
        .enumerate()
    {
        let block_id = format!("sequential-content-{suffix}-{index}");
        let mut payload = action_bundle(
            serde_json::json!([{
                "actionId": format!("sequential-create-{suffix}-{index}"),
                "toolId": "fs.create",
                "args": {
                    "path": target,
                    "contentBlockId": block_id,
                    "executable": false
                },
                "description": "Create an authorized task output",
                "dependsOn": []
            }]),
            serde_json::json!([{
                "blockId": block_id,
                "targetPath": target,
                "operation": "create",
                "contentLines": [format!("task-{index}")]
            }]),
        );
        payload.as_object_mut().unwrap().insert(
            "authorizationContractId".to_string(),
            Value::String(authorization_contract_id.clone()),
        );
        let report = submit_proposal_raw(&mut runtime, payload.clone());
        assert_eq!(report["status"], "authorizedByPlan");
        let events = execute_contract(&mut runtime, &payload, &report);
        assert!(!events
            .iter()
            .any(|event| matches!(event, KernelEvent::PermissionRequested { .. })));
        assert!(terminal_tool(&events, "fs.create", true));
    }

    assert!(workspace.join(&first_target).is_file());
    assert!(workspace.join(&second_target).is_file());
    let released_batch_grants = runtime
        .state
        .resource_manager
        .list()
        .into_iter()
        .filter(|resource| {
            resource.kind == KernelResourceKind::PermissionGrant
                && resource.cleanup_policy == KernelResourceCleanupPolicy::OnBatchReviewReady
                && resource.state == KernelResourceState::Released
        })
        .collect::<Vec<_>>();
    assert_eq!(released_batch_grants.len(), 2);
    assert_ne!(
        released_batch_grants[0].resource_id,
        released_batch_grants[1].resource_id
    );
}

#[test]
fn review_replan_releases_plan_grant_but_keeps_run_workspace_lease() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let plan_id = format!("plan-replan-{suffix}");
    let review = review_plan_tasks(
        &mut runtime,
        &plan_id,
        vec![TaskIntentTask {
            task_id: format!("task-replan-{suffix}"),
            tool_id: "fs.create".to_string(),
            targets: vec![format!("replan-{suffix}.txt")],
            depends_on: Vec::new(),
            args: serde_json::json!({}),
        }],
    );
    let authorization_contract_id = review.authorization_contract.id.clone();
    accept_plan_review(&mut runtime, &plan_id, &review);
    assert!(runtime.plan_grant_lease_active("run-1", &authorization_contract_id));
    assert!(runtime
        .state
        .resource_manager
        .list()
        .iter()
        .any(|resource| {
            resource.state == KernelResourceState::Active
                && matches!(
                    &resource.metadata,
                    KernelResourceMetadata::WorkspaceReadLease { .. }
                )
        }));

    let events = runtime
        .dispatch(KernelCommand::ReviewGateEvaluate {
            request_id: RequestId(format!("review-replan-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: ReviewGateDecision {
                decision: ReviewGateDecisionKind::Revise,
                guidance: None,
            },
        })
        .expect("review revision returns the run to ready state");

    assert!(events.iter().any(|event| matches!(
        event,
        KernelEvent::ReviewGateEvaluated { result, .. }
            if result.status == deepcode_kernel_abi::ReviewGateStatus::NeedsReplan
    )));
    assert!(!runtime.plan_grant_lease_active("run-1", &authorization_contract_id));
    assert!(!runtime
        .state
        .plan_authorization_contracts_by_run
        .contains_key("run-1"));
    assert!(runtime
        .state
        .resource_manager
        .list()
        .iter()
        .any(|resource| {
            resource.state == KernelResourceState::Active
                && matches!(
                    &resource.metadata,
                    KernelResourceMetadata::WorkspaceReadLease { .. }
                )
        }));
}

#[test]
fn accepted_plan_and_resource_leases_restore_from_ledger_before_next_task() {
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let workspace = TestWorkspace(std::env::temp_dir().join(format!(
        "deepcode-resource-restore-{}-{suffix}",
        std::process::id()
    )));
    fs::create_dir_all(&workspace.0).expect("create resource recovery workspace");
    let ledger_path = workspace.join("kernel-events.jsonl");
    let mut runtime = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    runtime
        .dispatch(KernelCommand::HostWorkspaceOpen {
            request_id: RequestId(format!("resource-restore-open-{suffix}")),
            path: workspace.to_string_lossy().to_string(),
        })
        .expect("resource recovery workspace opens");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId(format!("resource-restore-run-{suffix}")),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "Verify persisted lease recovery.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: Some(workspace_binding_from_root(&workspace)),
            profile_ref: None,
            run_overrides: None,
        })
        .expect("resource recovery run creates");
    let plan_id = format!("resource-restore-plan-{suffix}");
    let target = format!("restored-{suffix}.txt");
    let review = review_plan_tasks(
        &mut runtime,
        &plan_id,
        vec![TaskIntentTask {
            task_id: format!("resource-restore-task-{suffix}"),
            tool_id: "fs.create".to_string(),
            targets: vec![target.clone()],
            depends_on: Vec::new(),
            args: serde_json::json!({}),
        }],
    );
    accept_plan_review(&mut runtime, &plan_id, &review);
    let authorization_contract_id = review.authorization_contract.id.clone();
    drop(runtime);

    let mut restored = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    restored
        .ensure_session_restored("session-1")
        .expect("resources and authorization restore from ledger");
    assert!(
        restored.state.current_workspace.is_none(),
        "restoring an Agent Run must not mutate Host workspace state"
    );
    assert!(restored.plan_grant_lease_active("run-1", &authorization_contract_id));
    assert_eq!(
        restored.state.plan_authorization_contracts_by_run["run-1"][&authorization_contract_id]
            .status,
        PlanAuthorizationStatus::Accepted
    );

    let block_id = format!("restored-content-{suffix}");
    let mut payload = action_bundle(
        serde_json::json!([{
            "actionId": format!("restored-create-{suffix}"),
            "toolId": "fs.create",
            "args": {
                "path": target,
                "contentBlockId": block_id,
                "executable": false
            },
            "description": "Create output after restoring the accepted plan",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": block_id,
            "targetPath": target,
            "operation": "create",
            "contentLines": ["restored"]
        }]),
    );
    payload.as_object_mut().unwrap().insert(
        "authorizationContractId".to_string(),
        Value::String(authorization_contract_id),
    );
    let report = submit_proposal_raw(&mut restored, payload.clone());
    assert_eq!(report["status"], "authorizedByPlan");
    let events = execute_contract(&mut restored, &payload, &report);
    assert!(terminal_tool(&events, "fs.create", true));
    assert_eq!(
        fs::read_to_string(workspace.join(target)).unwrap(),
        "restored"
    );
}

#[test]
fn plan_authorization_requires_explicit_order_for_same_target_mutations() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let target = format!("generated-{suffix}/unit.txt");
    let unordered = review_plan_tasks(
        &mut runtime,
        &format!("unordered-plan-{suffix}"),
        vec![
            TaskIntentTask {
                task_id: format!("create-{suffix}"),
                tool_id: "fs.create".to_string(),
                targets: vec![target.clone()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
            TaskIntentTask {
                task_id: format!("edit-{suffix}"),
                tool_id: "fs.edit".to_string(),
                targets: vec![target.clone()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
        ],
    );
    assert_eq!(unordered.status, PlanAuthorizationStatus::NeedsRevision);
    assert!(unordered
        .diagnostics
        .iter()
        .any(|diagnostic| diagnostic.contains("unordered_operation_conflict")));

    let create_task_id = format!("ordered-create-{suffix}");
    let edit_task_id = format!("ordered-edit-{suffix}");
    let ordered = review_plan_tasks(
        &mut runtime,
        &format!("ordered-plan-{suffix}"),
        vec![
            TaskIntentTask {
                task_id: create_task_id.clone(),
                tool_id: "fs.create".to_string(),
                targets: vec![target.clone()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            },
            TaskIntentTask {
                task_id: edit_task_id.clone(),
                tool_id: "fs.edit".to_string(),
                targets: vec![target],
                depends_on: vec![create_task_id],
                args: serde_json::json!({}),
            },
        ],
    );
    assert_eq!(ordered.status, PlanAuthorizationStatus::Confirmable);
    let create = ordered
        .authorization_contract
        .operations
        .iter()
        .find(|operation| {
            operation.source_task_id == format!("ordered-create-{suffix}") && !operation.internal
        })
        .expect("ordered create operation");
    let edit = ordered
        .authorization_contract
        .operations
        .iter()
        .find(|operation| operation.source_task_id == edit_task_id)
        .expect("ordered edit operation");
    assert_eq!(edit.depends_on, vec![create.id.clone()]);
    assert_ne!(
        unordered.authorization_contract.operation_set_hash,
        ordered.authorization_contract.operation_set_hash
    );
}

#[test]
fn mixed_delete_plan_expands_exact_targets_and_executes_under_one_plan_grant() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let task_id = format!("task-mixed-delete-{suffix}");
    let directory_target = format!("tree-{suffix}");
    let first_file = format!("obsolete-{suffix}-a.txt");
    let second_file = format!("obsolete-{suffix}-b.txt");
    fs::create_dir_all(workspace.join(&directory_target)).expect("create directory target");
    fs::write(workspace.join(&first_file), "first\n").expect("create first file target");
    fs::write(workspace.join(&second_file), "second\n").expect("create second file target");

    let review = authorize_plan_targets(
        &mut runtime,
        &format!("mixed-delete-plan-{suffix}"),
        &task_id,
        "fs.delete",
        vec![
            directory_target.clone(),
            first_file.clone(),
            second_file.clone(),
        ],
    );
    let operations = &review.authorization_contract.operations;
    assert_eq!(operations.len(), 3);
    assert_eq!(operations[0].id, format!("plan-op-{task_id}-1"));
    assert_eq!(operations[0].targets, [directory_target.clone()]);
    assert_eq!(operations[0].target_kind, Some(ToolTargetKind::Directory));
    assert_eq!(operations[0].recursive, Some(true));
    for (index, target) in [first_file.clone(), second_file.clone()]
        .into_iter()
        .enumerate()
    {
        let operation = &operations[index + 1];
        assert_eq!(operation.targets, [target]);
        assert_eq!(operation.target_kind, Some(ToolTargetKind::File));
        assert_eq!(operation.recursive, Some(false));
    }
    assert_eq!(review.authorization_contract.permission_bundles.len(), 1);
    assert_eq!(
        review.authorization_contract.permission_bundles[0]
            .operation_ids
            .len(),
        3
    );

    let mut payload = action_bundle(
        serde_json::json!([
            {
                "actionId": format!("delete-dir-{suffix}"),
                "toolId": "fs.delete",
                "args": { "path": directory_target, "targetKind": "directory", "recursive": true },
                "description": "Delete the authorized directory target",
                "dependsOn": []
            },
            {
                "actionId": format!("delete-file-a-{suffix}"),
                "toolId": "fs.delete",
                "args": { "path": first_file, "targetKind": "file", "recursive": false },
                "description": "Delete the first authorized file target",
                "dependsOn": []
            },
            {
                "actionId": format!("delete-file-b-{suffix}"),
                "toolId": "fs.delete",
                "args": { "path": second_file, "targetKind": "file", "recursive": false },
                "description": "Delete the second authorized file target",
                "dependsOn": []
            }
        ]),
        serde_json::json!([]),
    );
    payload
        .as_object_mut()
        .expect("mixed delete payload")
        .insert(
            "authorizationContractId".to_string(),
            Value::String(review.authorization_contract.id.clone()),
        );
    let report = submit_proposal(&mut runtime, payload.clone());
    assert_eq!(report["status"], "authorizedByPlan");
    assert_eq!(
        report["requiredPermissions"].as_array().map(Vec::len),
        Some(0)
    );
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::PermissionRequested { .. })));
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event,
                KernelEvent::ToolCompleted { fact, .. }
                    if fact.tool_id == "fs.delete" && fact.ok
            ))
            .count(),
        3
    );
    assert!(!workspace.join(directory_target).exists());
    assert!(!workspace.join(first_file).exists());
    assert!(!workspace.join(second_file).exists());
}

#[test]
fn mutation_batch_preflight_prevents_partial_delete_after_target_type_drift() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let task_id = format!("task-preflight-delete-{suffix}");
    let targets = (0..3)
        .map(|index| format!("preflight-{suffix}-{index}.txt"))
        .collect::<Vec<_>>();
    for target in &targets {
        fs::write(workspace.join(target), format!("{target}\n")).expect("create delete target");
    }
    let review = authorize_plan_targets(
        &mut runtime,
        &format!("preflight-delete-plan-{suffix}"),
        &task_id,
        "fs.delete",
        targets.clone(),
    );
    let actions = targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            serde_json::json!({
                "actionId": format!("preflight-delete-{suffix}-{index}"),
                "toolId": "fs.delete",
                "args": { "path": target, "targetKind": "file", "recursive": false },
                "description": "Delete an authorized file target",
                "dependsOn": []
            })
        })
        .collect::<Vec<_>>();
    let mut payload = action_bundle(Value::Array(actions), serde_json::json!([]));
    payload.as_object_mut().expect("preflight payload").insert(
        "authorizationContractId".to_string(),
        Value::String(review.authorization_contract.id.clone()),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    assert_eq!(report["status"], "authorizedByPlan");

    fs::remove_file(workspace.join(&targets[1])).expect("replace file target");
    fs::create_dir(workspace.join(&targets[1])).expect("create type-drift directory");
    let events = execute_contract(&mut runtime, &payload, &report);

    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitStarted { .. })));
    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::ToolCompleted { .. })));
    assert!(events.iter().any(|event| matches!(
        event,
        KernelEvent::WorkUnitFailed { error, .. }
            if error.code == "mutation_batch_preflight_failed"
    )));
    assert!(workspace.join(&targets[0]).is_file());
    assert!(workspace.join(&targets[1]).is_dir());
    assert!(workspace.join(&targets[2]).is_file());
}

#[test]
fn plan_authorization_rejects_absolute_agent_tool_targets() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let snapshot = KernelToolRegistry::default().snapshot();
    let events = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("absolute-plan-submit-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: format!("absolute-plan-{suffix}"),
                plan_hash: format!("absolute-plan-hash-{suffix}"),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks: vec![TaskIntentTask {
                    task_id: format!("absolute-task-{suffix}"),
                    tool_id: "fs.write".to_string(),
                    targets: vec![workspace.join("input.txt").to_string_lossy().to_string()],
                    depends_on: Vec::new(),
                    args: serde_json::json!({}),
                }],
            },
        })
        .expect("invalid plan target produces a structured review");
    let review = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review),
            _ => None,
        })
        .expect("plan authorization review");
    assert_eq!(review.status, PlanAuthorizationStatus::NeedsRevision);
    assert!(review
        .diagnostics
        .iter()
        .any(|message| message.contains("root-relative path")));
    assert!(review.authorization_contract.operations.is_empty());
    assert!(review.authorization_contract.permission_bundles.is_empty());
    assert!(review.authorization_contract.interventions.is_empty());
}

#[cfg(unix)]
#[test]
fn plan_authorization_uses_tool_contract_read_semantics_for_in_root_symlinks() {
    use std::os::unix::fs::symlink;

    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let target = format!("read-target-{suffix}.txt");
    let link = format!("read-link-{suffix}.txt");
    fs::write(workspace.join(&target), "value\n").expect("write read target");
    symlink(&target, workspace.join(&link)).expect("create in-root read symlink");
    let snapshot = KernelToolRegistry::default().snapshot();

    let events = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("symlink-read-plan-submit-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: format!("symlink-read-plan-{suffix}"),
                plan_hash: format!("symlink-read-plan-hash-{suffix}"),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks: vec![TaskIntentTask {
                    task_id: format!("symlink-read-task-{suffix}"),
                    tool_id: "fs.read".to_string(),
                    targets: vec![link.clone()],
                    depends_on: Vec::new(),
                    args: serde_json::json!({}),
                }],
            },
        })
        .expect("read plan authorization returns a structured review");
    let review = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review),
            _ => None,
        })
        .expect("plan authorization review");

    assert_eq!(review.status, PlanAuthorizationStatus::Confirmable);
    assert_eq!(review.authorization_contract.operations.len(), 1);
    assert_eq!(
        review.authorization_contract.operations[0].tool_id,
        "fs.read"
    );
    assert_eq!(review.authorization_contract.operations[0].targets, [link]);
}

#[test]
fn plan_authorization_scope_expansion_uses_kernel_permission_gate_and_resumes_work_unit() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let task_id = format!("task-plan-write-{suffix}");
    let plan_id = format!("plan-write-{suffix}");
    let plan_hash = format!("plan-write-hash-{suffix}");
    let snapshot = KernelToolRegistry::default().snapshot();
    let reviewed = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("plan-write-submit-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: plan_id.clone(),
                plan_hash: plan_hash.clone(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks: vec![TaskIntentTask {
                    task_id: task_id.clone(),
                    tool_id: "fs.write".to_string(),
                    targets: vec!["input.txt".to_string()],
                    depends_on: Vec::new(),
                    args: serde_json::json!({}),
                }],
            },
        })
        .expect("Kernel compiles write plan");
    let review = reviewed
        .iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review.clone()),
            _ => None,
        })
        .expect("write plan authorization review");
    runtime
        .dispatch(KernelCommand::PlanAuthorizationDecisionSubmit {
            request_id: RequestId(format!("plan-write-accept-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: PlanAuthorizationDecisionSubmit {
                decision_id: format!("plan-write-decision-{suffix}"),
                authorization_contract_id: review.authorization_contract.id.clone(),
                plan_id,
                plan_hash,
                contract_hash: review.authorization_contract.contract_hash.clone(),
                decision: PlanAuthorizationDecisionKind::Accept,
            },
        })
        .expect("accept write plan authorization");

    let expanded_target = "nested/child.txt";
    let mut payload = action_bundle(
        serde_json::json!([{
            "actionId": format!("expanded-write-{suffix}"),
            "toolId": "fs.write",
            "args": { "path": expanded_target, "contentBlockId": format!("expanded-content-{suffix}") },
            "description": "Write an operation outside the accepted target set",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": format!("expanded-content-{suffix}"),
            "targetPath": expanded_target,
            "operation": "overwrite",
            "contentLines": ["expanded write"]
        }]),
    );
    let payload_object = payload.as_object_mut().expect("expanded action payload");
    payload_object.insert(
        "authorizationContractId".to_string(),
        Value::String(review.authorization_contract.id.clone()),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    assert_eq!(report["status"], "awaitingUserApproval");
    assert!(report["diagnostics"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| {
            item.as_str()
                .is_some_and(|text| text.contains("execution_scope_expansion"))
        })));

    let waiting = execute_contract(&mut runtime, &payload, &report);
    let permission = waiting
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.clone()),
            _ => None,
        })
        .expect("Kernel gates the expanded operation");
    assert!(!terminal_tool(&waiting, "fs.write", true));
    assert_eq!(
        fs::read_to_string(workspace.join(expanded_target)).expect("original file remains"),
        "child\n"
    );

    let resumed = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId(format!("expanded-permission-accept-{suffix}")),
            permission_id: permission.id,
            decision: PermissionDecisionKind::Accept,
        })
        .expect("Kernel resumes the same expanded work unit");
    assert!(terminal_tool(&resumed, "fs.write", true));
    assert!(resumed.iter().any(|event| matches!(
        event,
        KernelEvent::WorkUnitCompleted { work_unit_id, .. }
            if work_unit_id.contains("expanded-write")
    )));
    assert_eq!(
        fs::read_to_string(workspace.join(expanded_target)).expect("expanded target written"),
        "expanded write"
    );
}

#[test]
fn batch_review_ready_releases_permission_leases_and_removes_only_temporary_files() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([
            {
                "actionId": "create-persistent",
                "toolId": "fs.create",
                "args": {
                    "path": "kept.txt",
                    "contentBlockId": "kept-content"
                },
                "description": "Create a persistent project file",
                "dependsOn": []
            },
            {
                "actionId": "create-temporary",
                "toolId": "fs.create",
                "args": {
                    "path": "scratch.txt",
                    "contentBlockId": "scratch-content",
                    "temporary": true
                },
                "description": "Create a batch-scoped temporary file",
                "dependsOn": []
            }
        ]),
        serde_json::json!([
            {
                "blockId": "kept-content",
                "targetPath": "kept.txt",
                "operation": "create",
                "contentLines": ["persistent"]
            },
            {
                "blockId": "scratch-content",
                "targetPath": "scratch.txt",
                "operation": "create",
                "contentLines": ["temporary"]
            }
        ]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    assert_eq!(
        report["executionContract"]["operations"][1]["cleanup"]["leasePolicy"],
        "batchTemporaryFile"
    );
    assert!(runtime
        .state
        .resource_manager
        .list()
        .iter()
        .any(|resource| resource.kind == KernelResourceKind::PermissionGrant));

    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert_eq!(
        fs::read_to_string(workspace.join("kept.txt")).unwrap(),
        "persistent"
    );
    assert!(!workspace.join("scratch.txt").exists());
    assert!(runtime.active_temporary_grants("run-1").is_empty());

    let facts = runtime
        .dispatch(KernelCommand::ReviewFactsGet {
            request_id: RequestId("review-facts-resource-cleanup".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
        })
        .expect("review facts after cleanup");
    let review = facts
        .iter()
        .find_map(|event| match event {
            KernelEvent::ReviewFactsProduced { facts, .. } => Some(facts),
            _ => None,
        })
        .expect("typed review facts");
    assert!(review.cleanup_failures.is_empty());
    assert!(review
        .resource_events
        .iter()
        .any(|event| { event.kind == ResourceLifecycleKind::AcquiredBatch }));
    assert!(review
        .resource_events
        .iter()
        .any(|event| event.kind == ResourceLifecycleKind::Released));
}

#[test]
fn cleanup_failure_keeps_run_terminating_and_resume_emits_final_review_state() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let temporary_directory = workspace.join(format!("cleanup-directory-{suffix}"));
    fs::create_dir_all(&temporary_directory).expect("create cleanup failure target");
    let resource_id = format!("cleanup-resource-{suffix}");
    runtime
        .acquire_resource_batch(
            "run-1",
            "session-1",
            "Register a cleanup retry test resource.",
            vec![KernelResource::active(
                KernelResourceIdentity::new(
                    resource_id.clone(),
                    format!("cleanup:{suffix}"),
                    format!("cleanup:run-1:{suffix}"),
                ),
                KernelResourceKind::TempArtifact,
                KernelResourceOwner::agent_run(Some("session-1"), "run-1"),
                KernelResourceScope::Run,
                KernelResourceCleanupPolicy::OnRunEnd,
                KernelResourceMetadata::TempArtifact {
                    path: format!("cleanup-directory-{suffix}"),
                    absolute_path: Some(temporary_directory.to_string_lossy().to_string()),
                    source_tool: "fs.create".to_string(),
                    tool_call_id: format!("cleanup-call-{suffix}"),
                },
            )],
        )
        .expect("register cleanup retry resource");
    runtime
        .transition_runtime_lifecycle(
            Some(RequestId(format!("cleanup-start-{suffix}"))),
            "run-1",
            "session-1",
            RuntimeLifecycleState::Terminating,
            "testCleanupStarted",
        )
        .expect("enter terminating state");
    let cleanup = runtime
        .release_run_resources_with_intent(
            "run-1",
            "session-1",
            "testReviewCleanup",
            Some(RunStatus::Completed),
            Some(ReviewGateDecision {
                decision: ReviewGateDecisionKind::Accept,
                guidance: None,
            }),
        )
        .expect("cleanup failure is recorded");
    assert_eq!(cleanup.failures.len(), 1);
    assert_eq!(
        runtime.record_by_run("run-1").unwrap().lifecycle_state,
        RuntimeLifecycleState::Terminating
    );
    assert_eq!(
        runtime.state.cleanup_state_by_run.get("run-1"),
        Some(&KernelCleanupState::Failed)
    );

    fs::remove_dir(&temporary_directory).expect("remove cleanup blocker");
    let retried = runtime
        .dispatch(KernelCommand::RunResume {
            request_id: RequestId(format!("cleanup-retry-{suffix}")),
            session_id: SessionId("session-1".to_string()),
        })
        .expect("resume retries cleanup");

    assert!(retried.iter().any(|event| matches!(
        event,
        KernelEvent::ReviewGateEvaluated { result, .. }
            if result.status == deepcode_kernel_abi::ReviewGateStatus::Accepted
    )));
    assert!(retried.iter().any(|event| matches!(
        event,
        KernelEvent::RunCompleted {
            status: RunStatus::Completed,
            ..
        }
    )));
    assert!(!retried
        .iter()
        .any(|event| matches!(event, KernelEvent::RuntimeResumed { .. })));
    assert_eq!(
        runtime.record_by_run("run-1").unwrap().lifecycle_state,
        RuntimeLifecycleState::Terminal
    );
    assert_eq!(
        runtime
            .state
            .resource_manager
            .get(&resource_id)
            .unwrap()
            .state,
        KernelResourceState::Released
    );
    assert!(!runtime
        .state
        .cleanup_checkpoints_by_run
        .contains_key("run-1"));
}

fn authorize_plan_targets(
    runtime: &mut DeepCodeKernelRuntime,
    plan_id: &str,
    task_id: &str,
    tool_id: &str,
    targets: Vec<String>,
) -> PlanAuthorizationReview {
    let snapshot = KernelToolRegistry::default().snapshot();
    let plan_hash = format!("hash-{plan_id}");
    let events = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("submit-{plan_id}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: plan_id.to_string(),
                plan_hash: plan_hash.clone(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks: vec![TaskIntentTask {
                    task_id: task_id.to_string(),
                    tool_id: tool_id.to_string(),
                    targets,
                    depends_on: Vec::new(),
                    args: serde_json::json!({}),
                }],
            },
        })
        .expect("Kernel compiles exact target authorization");
    let review = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review.clone()),
            _ => None,
        })
        .expect("plan authorization review");
    assert_eq!(review.status, PlanAuthorizationStatus::Confirmable);
    runtime
        .dispatch(KernelCommand::PlanAuthorizationDecisionSubmit {
            request_id: RequestId(format!("accept-{plan_id}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: PlanAuthorizationDecisionSubmit {
                decision_id: format!("decision-{plan_id}"),
                authorization_contract_id: review.authorization_contract.id.clone(),
                plan_id: plan_id.to_string(),
                plan_hash,
                contract_hash: review.authorization_contract.contract_hash.clone(),
                decision: PlanAuthorizationDecisionKind::Accept,
            },
        })
        .expect("accept exact target authorization");
    review
}

fn review_plan_tasks(
    runtime: &mut DeepCodeKernelRuntime,
    plan_id: &str,
    tasks: Vec<TaskIntentTask>,
) -> PlanAuthorizationReview {
    let snapshot = KernelToolRegistry::default().snapshot();
    let events = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("submit-{plan_id}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: plan_id.to_string(),
                plan_hash: format!("hash-{plan_id}"),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks,
            },
        })
        .expect("Kernel reviews plan tasks");
    events
        .into_iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review),
            _ => None,
        })
        .expect("plan authorization review")
}

fn accept_plan_review(
    runtime: &mut DeepCodeKernelRuntime,
    plan_id: &str,
    review: &PlanAuthorizationReview,
) {
    runtime
        .dispatch(KernelCommand::PlanAuthorizationDecisionSubmit {
            request_id: RequestId(format!("accept-{plan_id}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: PlanAuthorizationDecisionSubmit {
                decision_id: format!("decision-{plan_id}"),
                authorization_contract_id: review.authorization_contract.id.clone(),
                plan_id: plan_id.to_string(),
                plan_hash: format!("hash-{plan_id}"),
                contract_hash: review.authorization_contract.contract_hash.clone(),
                decision: PlanAuthorizationDecisionKind::Accept,
            },
        })
        .expect("accept reviewed plan authorization");
}
