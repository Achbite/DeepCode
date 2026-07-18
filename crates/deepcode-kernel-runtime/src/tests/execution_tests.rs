use super::*;

#[test]
fn proposal_review_derives_contract_and_permission_from_tool_contract() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "content-1" },
            "description": "Overwrite input",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "content-1",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["updated"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload);
    assert_eq!(
        report["executionContract"]["catalogVersion"],
        "deepcode.kernel.tools.v3"
    );
    assert_eq!(
        report["executionContract"]["operations"][0]["toolId"],
        "fs.write"
    );
    assert_eq!(
        report["executionContract"]["permissionBundles"][0]["capability"],
        "workspace.write"
    );
    assert!(report["executionContract"]["operations"][0]["argsHash"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
}

#[test]
fn action_batch_requires_accepted_matching_contract() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "content-1" },
            "description": "Overwrite input",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "content-1",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["updated"]
        }]),
    );
    let report = submit_proposal_raw(&mut runtime, payload.clone());
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(
        events.iter().any(|event| matches!(
            event,
            KernelEvent::WorkUnitFailed { error, .. }
                if error.code == "execution_contract_mismatch"
        )),
        "unexpected unaccepted contract events: {events:#?}"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "alpha\nbeta\ngamma\n"
    );
}

#[test]
fn accepted_write_contract_executes_and_enters_review() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-1",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "content-1" },
            "description": "Overwrite input",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "content-1",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["updated"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(terminal_tool(&events, "fs.write", true));
    let attempt_index = events
        .iter()
        .position(|event| matches!(event, KernelEvent::ToolExecutionAttempted { .. }))
        .expect("tool attempt fact");
    let effect_index = events
        .iter()
        .position(|event| {
            matches!(
                event,
                KernelEvent::ToolEffectObserved { fact, .. }
                    if fact.outcome == deepcode_kernel_abi::ToolEffectOutcome::Observed
            )
        })
        .expect("tool effect fact");
    let completion_index = events
        .iter()
        .position(|event| matches!(event, KernelEvent::ToolCompleted { .. }))
        .expect("tool completion fact");
    assert!(attempt_index < effect_index && effect_index < completion_index);
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert!(events.iter().any(|event| matches!(
        event,
        KernelEvent::RuntimeLifecycleChanged {
            current_state: RuntimeLifecycleState::ReviewReady,
            ..
        }
    )));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "updated"
    );
    let facts = runtime
        .dispatch(KernelCommand::ReviewFactsGet {
            request_id: RequestId("review-facts-write".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
        })
        .expect("review facts");
    let review = facts
        .iter()
        .find_map(|event| match event {
            KernelEvent::ReviewFactsProduced { facts, .. } => Some(facts),
            _ => None,
        })
        .expect("typed review facts");
    assert!(review.batch_review_ready);
    assert_eq!(review.written_files.len(), 1);
    assert_eq!(review.tool_results[0].tool_id, "fs.write");
    runtime
        .dispatch(KernelCommand::ReviewGateEvaluate {
            request_id: RequestId("review-gate-write".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: ReviewGateDecision {
                decision: ReviewGateDecisionKind::Accept,
                guidance: None,
            },
        })
        .expect("review gate accepts completed write facts");
    assert!(runtime
        .state
        .resource_manager
        .list()
        .into_iter()
        .filter(|resource| resource.kind == KernelResourceKind::WorkspaceReadLease)
        .all(|resource| { resource.state == KernelResourceState::Released }));
}

#[test]
fn permission_resolution_resumes_the_same_pending_work_unit() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-permission",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "content-permission" },
            "description": "Overwrite after permission",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "content-permission",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["resumed"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .unwrap();

    let waiting = execute_contract(&mut runtime, &payload, &report);
    let request = waiting
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.clone()),
            _ => None,
        })
        .expect("permission requested");
    assert!(!waiting
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));

    let resumed = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("permission-resume".to_string()),
            permission_id: request.id,
            decision: PermissionDecisionKind::Accept,
        })
        .expect("permission resolution resumes work");
    assert!(terminal_tool(&resumed, "fs.write", true));
    assert!(resumed.iter().any(
        |event| matches!(event, KernelEvent::WorkUnitCompleted { work_unit_id, .. }
        if work_unit_id == "work-unit-bundle-1-write-permission")
    ));
    assert!(resumed
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "resumed"
    );
    assert!(runtime.active_temporary_grants("run-1").is_empty());
    assert!(runtime
        .state
        .resource_manager
        .list()
        .iter()
        .filter(|resource| {
            resource.kind == KernelResourceKind::PermissionGrant
                && resource.cleanup_policy == KernelResourceCleanupPolicy::OnBatchReviewReady
        })
        .all(|resource| resource.state == KernelResourceState::Released));
}

#[test]
fn permission_resolution_persistence_failure_keeps_checkpoint_and_grants_uncommitted() {
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let workspace = TestWorkspace(std::env::temp_dir().join(format!(
        "deepcode-runtime-permission-atomic-{}-{suffix}",
        std::process::id()
    )));
    fs::create_dir_all(&workspace.0).expect("create permission atomic workspace");
    fs::write(workspace.join("input.txt"), "before\n").expect("write permission atomic input");
    let fail_permission_resolution = Arc::new(AtomicBool::new(false));
    let ledger = PermissionResolutionFailingLedger {
        inner: InMemoryEventLedger::new(),
        fail_permission_resolution: Arc::clone(&fail_permission_resolution),
    };
    let mut runtime = DeepCodeKernelRuntime::with_ledger(Box::new(ledger));
    runtime
        .dispatch(KernelCommand::HostWorkspaceOpen {
            request_id: RequestId(format!("permission-atomic-workspace-{suffix}")),
            path: workspace.to_string_lossy().to_string(),
        })
        .expect("permission atomic workspace opens");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId(format!("permission-atomic-run-{suffix}")),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "Verify atomic permission resolution persistence.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: Some(workspace_binding_from_root(&workspace)),
            profile_ref: None,
            run_overrides: None,
        })
        .expect("permission atomic run creates");
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-permission-atomic",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "content-permission-atomic" },
            "description": "Overwrite after atomic permission persistence",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "content-permission-atomic",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["after"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .expect("release plan batch grants before runtime permission gate");
    let waiting = execute_contract(&mut runtime, &payload, &report);
    let permission_id = waiting
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.id.clone()),
            _ => None,
        })
        .expect("runtime permission is requested");

    fail_permission_resolution.store(true, Ordering::SeqCst);
    runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId(format!("permission-atomic-fail-{suffix}")),
            permission_id: permission_id.clone(),
            decision: PermissionDecisionKind::Accept,
        })
        .expect_err("permission resolution persistence failure must fail closed");
    assert!(runtime.state.pending_tools.contains_key(&permission_id));
    assert!(runtime.active_temporary_grants("run-1").is_empty());
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).expect("read unchanged permission input"),
        "before\n"
    );

    fail_permission_resolution.store(false, Ordering::SeqCst);
    let resumed = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId(format!("permission-atomic-retry-{suffix}")),
            permission_id,
            decision: PermissionDecisionKind::Accept,
        })
        .expect("permission resolution retries from the preserved checkpoint");
    assert!(terminal_tool(&resumed, "fs.write", true));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).expect("read resumed permission input"),
        "after"
    );
}

#[test]
fn permission_resolution_restores_pending_write_from_contract_and_draft_ledger() {
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let workspace = TestWorkspace(std::env::temp_dir().join(format!(
        "deepcode-runtime-recovery-{}-{suffix}",
        std::process::id()
    )));
    fs::create_dir_all(&workspace.0).expect("create recovery workspace");
    fs::write(workspace.join("input.txt"), "before\n").expect("write recovery input");
    let ledger_path = workspace.join("kernel-events.jsonl");
    let mut runtime = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    runtime
        .dispatch(KernelCommand::HostWorkspaceOpen {
            request_id: RequestId("recovery-workspace-open".to_string()),
            path: workspace.to_string_lossy().to_string(),
        })
        .expect("recovery workspace opens");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("recovery-run-create".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "Verify pending operation recovery.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: Some(workspace_binding_from_root(&workspace)),
            profile_ref: None,
            run_overrides: None,
        })
        .expect("recovery run creates");
    submit_artifact_draft(
        &mut runtime,
        "recovery-draft-chunk",
        artifact_draft_chunk("draft-recovery", "frame-recovery-1", 1, &["after"], true),
    )
    .expect("recovery draft content is recorded");
    submit_artifact_draft(
        &mut runtime,
        "recovery-draft-done",
        artifact_draft_done("draft-recovery", "frame-recovery-done", 2, "complete"),
    )
    .expect("recovery draft is finalized");
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-recovery",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "block-slot-draft-1" },
            "description": "Overwrite after Kernel restart",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-slot-draft-1",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["after"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .unwrap();
    let waiting = execute_contract(&mut runtime, &payload, &report);
    let permission_id = waiting
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.id.clone()),
            _ => None,
        })
        .expect("recovery permission is requested");
    drop(runtime);

    let mut restored = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    let events = restored
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("recovery-permission-resolve".to_string()),
            permission_id,
            decision: PermissionDecisionKind::Accept,
        })
        .expect("restored Kernel resumes the pending operation");
    assert!(terminal_tool(&events, "fs.write", true));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "after"
    );
}

#[test]
fn permission_resolution_fails_closed_when_draft_content_cannot_be_restored() {
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let workspace = TestWorkspace(std::env::temp_dir().join(format!(
        "deepcode-runtime-recovery-missing-draft-{}-{suffix}",
        std::process::id()
    )));
    fs::create_dir_all(&workspace.0).expect("create recovery workspace");
    fs::write(workspace.join("input.txt"), "before\n").expect("write recovery input");
    let ledger_path = workspace.join("kernel-events.jsonl");
    let mut runtime = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    runtime
        .dispatch(KernelCommand::HostWorkspaceOpen {
            request_id: RequestId("missing-draft-workspace-open".to_string()),
            path: workspace.to_string_lossy().to_string(),
        })
        .expect("recovery workspace opens");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("missing-draft-run-create".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "Verify fail-closed pending operation recovery.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: Some(workspace_binding_from_root(&workspace)),
            profile_ref: None,
            run_overrides: None,
        })
        .expect("recovery run creates");
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "write-missing-draft",
            "toolId": "fs.write",
            "args": { "path": "input.txt", "contentBlockId": "block-slot-missing-1" },
            "description": "Overwrite after Kernel restart",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "block-slot-missing-1",
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["after"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .unwrap();
    let waiting = execute_contract(&mut runtime, &payload, &report);
    let permission_id = waiting
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.id.clone()),
            _ => None,
        })
        .expect("recovery permission is requested");
    drop(runtime);

    let mut restored = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    let error = restored
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("missing-draft-permission-resolve".to_string()),
            permission_id,
            decision: PermissionDecisionKind::Accept,
        })
        .expect_err("missing durable draft content must fail closed");
    assert!(matches!(
        error,
        KernelError::PendingPermissionUnavailable(_)
    ));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "before\n"
    );
}

#[test]
fn permission_bundle_groups_operations_and_resumes_every_work_unit() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([
            {
                "actionId": "write-first",
                "toolId": "fs.write",
                "args": { "path": "input.txt", "contentBlockId": "content-first" },
                "description": "Overwrite first file",
                "dependsOn": []
            },
            {
                "actionId": "write-second",
                "toolId": "fs.write",
                "args": { "path": "nested/child.txt", "contentBlockId": "content-second" },
                "description": "Overwrite second file",
                "dependsOn": []
            }
        ]),
        serde_json::json!([
            {
                "blockId": "content-first",
                "targetPath": "input.txt",
                "operation": "overwrite",
                "contentLines": ["first"]
            },
            {
                "blockId": "content-second",
                "targetPath": "nested/child.txt",
                "operation": "overwrite",
                "contentLines": ["second"]
            }
        ]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .unwrap();

    let waiting = execute_contract(&mut runtime, &payload, &report);
    let requests = waiting
        .iter()
        .filter_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].affected_operation_ids.len(), 2);
    assert_eq!(requests[0].work_unit_ids.len(), 2);

    let resumed = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("permission-bundle-accept".to_string()),
            permission_id: requests[0].id.clone(),
            decision: PermissionDecisionKind::Accept,
        })
        .expect("permission bundle resumes all work units");
    assert_eq!(
        resumed
            .iter()
            .filter(|event| matches!(event, KernelEvent::ToolCompleted { fact, .. } if fact.tool_id == "fs.write" && fact.ok))
            .count(),
        2
    );
    assert_eq!(
        resumed
            .iter()
            .filter(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. }))
            .count(),
        2
    );
    assert!(resumed
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "first"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("nested/child.txt")).unwrap(),
        "second"
    );
}

#[test]
fn multiple_permission_bundles_wait_for_all_decisions_and_run_independent_operations() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let payload = action_bundle(
        serde_json::json!([
            {
                "actionId": format!("write-{suffix}"),
                "toolId": "fs.write",
                "args": { "path": "input.txt", "contentBlockId": format!("content-{suffix}") },
                "description": "Write an independent workspace target",
                "dependsOn": []
            },
            {
                "actionId": format!("fetch-{suffix}"),
                "toolId": "web.fetch",
                "args": { "url": format!("http://127.0.0.1:{}/evidence", 31000 + (suffix % 1000)) },
                "description": "Fetch independent private evidence",
                "dependsOn": []
            }
        ]),
        serde_json::json!([{
            "blockId": format!("content-{suffix}"),
            "targetPath": "input.txt",
            "operation": "overwrite",
            "contentLines": ["permission groups resolved"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .unwrap();

    let waiting = execute_contract(&mut runtime, &payload, &report);
    let requests = waiting
        .iter()
        .filter_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.clone()),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(requests.len(), 2);
    assert!(!waiting
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitStarted { .. })));
    let write_permission = requests
        .iter()
        .find(|request| request.tool_id.as_deref() == Some("fs.write"))
        .expect("workspace permission request");
    let web_permission = requests
        .iter()
        .find(|request| request.tool_id.as_deref() == Some("web.fetch"))
        .expect("private web permission request");

    let first_decision = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId(format!("accept-write-{suffix}")),
            permission_id: write_permission.id.clone(),
            decision: PermissionDecisionKind::Accept,
        })
        .expect("record first permission decision");
    assert!(!first_decision
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitStarted { .. })));

    let resumed = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId(format!("reject-web-{suffix}")),
            permission_id: web_permission.id.clone(),
            decision: PermissionDecisionKind::Reject,
        })
        .expect("last permission decision resumes the batch");
    assert!(terminal_tool(&resumed, "fs.write", true));
    assert!(resumed.iter().any(|event| matches!(
        event,
        KernelEvent::WorkUnitBlocked { reason, .. } if reason == "permission rejected by user"
    )));
    assert!(resumed
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "permission groups resolved"
    );
}

#[test]
fn rejected_permission_bundle_blocks_only_affected_work_units() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([
            {
                "actionId": "reject-first",
                "toolId": "fs.write",
                "args": { "path": "input.txt", "contentBlockId": "reject-content-first" },
                "description": "Request first overwrite",
                "dependsOn": []
            },
            {
                "actionId": "reject-second",
                "toolId": "fs.write",
                "args": { "path": "nested/child.txt", "contentBlockId": "reject-content-second" },
                "description": "Request second overwrite",
                "dependsOn": []
            }
        ]),
        serde_json::json!([
            {
                "blockId": "reject-content-first",
                "targetPath": "input.txt",
                "operation": "overwrite",
                "contentLines": ["not-written"]
            },
            {
                "blockId": "reject-content-second",
                "targetPath": "nested/child.txt",
                "operation": "overwrite",
                "contentLines": ["not-written"]
            }
        ]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    runtime
        .release_batch_resources("run-1", "session-1", "testPermissionReset")
        .unwrap();
    let waiting = execute_contract(&mut runtime, &payload, &report);
    let permission_id = waiting
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.id.clone()),
            _ => None,
        })
        .expect("permission requested");

    let rejected = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("permission-bundle-reject".to_string()),
            permission_id,
            decision: PermissionDecisionKind::Reject,
        })
        .expect("permission bundle rejection is terminal");
    assert_eq!(
        rejected
            .iter()
            .filter(|event| matches!(event, KernelEvent::WorkUnitBlocked { .. }))
            .count(),
        2
    );
    assert!(!rejected
        .iter()
        .any(|event| matches!(event, KernelEvent::ToolCompleted { fact, .. } if fact.ok)));
    assert!(rejected
        .iter()
        .any(|event| matches!(event, KernelEvent::BatchReviewReady { .. })));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "alpha\nbeta\ngamma\n"
    );
    assert_eq!(
        fs::read_to_string(workspace.join("nested/child.txt")).unwrap(),
        "child\n"
    );
}
