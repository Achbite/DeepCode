use super::*;
use deepcode_kernel_abi::{ResourcePacketContentKind, ResourcePacketResolvedKind};

#[test]
fn edit_rename_and_delete_use_distinct_canonical_tools() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([
            {
                "actionId": "edit-1",
                "toolId": "fs.edit",
                "args": {
                    "path": "input.txt",
                    "replacementBlockId": "replacement-1",
                    "patchSpec": { "match": { "kind": "exactBlock", "text": "beta" } }
                },
                "description": "Edit one block",
                "dependsOn": []
            },
            {
                "actionId": "rename-1",
                "toolId": "fs.rename",
                "args": { "path": "nested/child.txt", "destinationPath": "nested/renamed.txt" },
                "description": "Rename nested file",
                "dependsOn": []
            },
            {
                "actionId": "delete-1",
                "toolId": "fs.delete",
                "args": { "path": "nested/renamed.txt", "targetKind": "file", "recursive": false },
                "description": "Delete renamed file",
                "dependsOn": ["rename-1"]
            }
        ]),
        serde_json::json!([{
            "blockId": "replacement-1",
            "targetPath": "input.txt",
            "operation": "replaceBlock",
            "contentLines": ["delta"]
        }]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(terminal_tool(&events, "fs.edit", true));
    assert!(terminal_tool(&events, "fs.rename", true));
    assert!(terminal_tool(&events, "fs.delete", true));
    assert_eq!(
        fs::read_to_string(workspace.join("input.txt")).unwrap(),
        "alpha\ndelta\ngamma\n"
    );
    assert!(!workspace.join("nested/child.txt").exists());
    assert!(!workspace.join("nested/renamed.txt").exists());
}

#[test]
fn directory_delete_requires_explicit_recursive_contract() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let invalid = action_bundle(
        serde_json::json!([{
            "actionId": "delete-dir",
            "toolId": "fs.delete",
            "args": { "path": "nested", "targetKind": "directory", "recursive": false },
            "description": "Delete directory",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    let report = submit_proposal(&mut runtime, invalid.clone());
    let events = execute_contract(&mut runtime, &invalid, &report);
    assert!(events.iter().any(|event| matches!(
        event,
        KernelEvent::WorkUnitFailed { error, .. }
            if error.message.contains("fs.delete") && error.message.contains("recursive")
    )));
    assert!(workspace.join("nested").exists());

    let valid = action_bundle(
        serde_json::json!([{
            "actionId": "delete-dir-valid",
            "toolId": "fs.delete",
            "args": { "path": "nested", "targetKind": "directory", "recursive": true },
            "description": "Delete directory recursively",
            "dependsOn": []
        }]),
        serde_json::json!([]),
    );
    let report = submit_proposal(&mut runtime, valid.clone());
    let events = execute_contract(&mut runtime, &valid, &report);
    assert!(terminal_tool(&events, "fs.delete", true));
    assert!(!workspace.join("nested").exists());
}

#[test]
fn read_glob_and_grep_execute_as_operational_facts() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([
            {
                "actionId": "read-1",
                "toolId": "fs.read",
                "args": { "path": "input.txt", "startLine": 2, "endLine": 2 },
                "description": "Read one line",
                "dependsOn": []
            },
            {
                "actionId": "glob-1",
                "toolId": "fs.glob",
                "args": { "path": ".", "pattern": "**/*.txt", "maxResults": 20 },
                "description": "Find text files",
                "dependsOn": []
            },
            {
                "actionId": "grep-1",
                "toolId": "code.grep",
                "args": { "path": ".", "query": "beta", "strategy": "literal", "maxResults": 20 },
                "description": "Search literal text",
                "dependsOn": []
            }
        ]),
        serde_json::json!([]),
    );
    let report = submit_proposal(&mut runtime, payload.clone());
    assert_eq!(report["executionContract"]["status"], "authorizedByPlan");
    let events = execute_contract(&mut runtime, &payload, &report);
    assert!(terminal_tool(&events, "fs.read", true));
    assert!(
        terminal_tool(&events, "fs.glob", true),
        "fs.glob events: {events:#?}"
    );
    assert!(terminal_tool(&events, "code.grep", true));
}

#[test]
fn blocked_tools_never_produce_success_facts() {
    let registry = KernelToolRegistry::default();
    for (tool_id, args) in [
        (
            "git.push",
            serde_json::json!({ "remote": "origin", "branch": "topic" }),
        ),
        (
            "process.exec",
            serde_json::json!({ "cwd": ".", "argv": ["true"] }),
        ),
        (
            "browser.open",
            serde_json::json!({ "url": "https://example.invalid" }),
        ),
        (
            "provider.call",
            serde_json::json!({ "profileRef": "default" }),
        ),
    ] {
        let draft = derive_plan_authorization(
            &registry,
            &[PlanTaskIntent {
                task_id: format!("blocked-{tool_id}"),
                tool_id: tool_id.to_string(),
                targets: plan_targets_for_action(tool_id, &args),
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            }],
        );
        assert!(draft
            .diagnostics
            .iter()
            .any(|diagnostic| diagnostic.hard_deny));
        assert!(draft
            .operations
            .iter()
            .all(|operation| { operation.execution_mode == OperationExecutionMode::Blocked }));

        let payload = action_bundle(
            serde_json::json!([{
                "actionId": format!("blocked-{tool_id}"),
                "toolId": tool_id,
                "args": args,
                "description": "Verify blocked contract",
                "dependsOn": []
            }]),
            serde_json::json!([]),
        );
        let proposal = serde_json::from_value::<KernelActionProposal>(payload)
            .expect("blocked tool proposal uses canonical action fields");
        assert!(OperationCompiler::new(&registry)
            .compile_proposal(&proposal)
            .is_err());
    }
}

#[test]
fn web_permission_policy_distinguishes_public_and_private_targets() {
    let config = crate::executors::KernelExecutorConfig {
        web_read_permission: ToolPermissionMode::Allow,
        private_web_read_permission: ToolPermissionMode::Ask,
        ..crate::executors::KernelExecutorConfig::default()
    };
    assert_eq!(
        web_permission_mode_for_tool_args(
            &config,
            ToolOperationKind::WebFetch,
            &serde_json::json!({ "url": "http://93.184.216.34/evidence" }),
        ),
        Some(ToolPermissionMode::Allow)
    );
    assert_eq!(
        web_permission_mode_for_tool_args(
            &config,
            ToolOperationKind::WebFetch,
            &serde_json::json!({ "url": "http://127.0.0.1/evidence" }),
        ),
        Some(ToolPermissionMode::Ask)
    );
}

#[test]
fn run_cancel_and_typed_audit_query_return_structured_events() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    assert!(runtime
        .state
        .resource_manager
        .list()
        .iter()
        .any(|resource| resource.kind == KernelResourceKind::WorkspaceReadLease));
    let audit = runtime
        .dispatch(KernelCommand::AuditQuery {
            request_id: RequestId("audit-query".to_string()),
            filter: AuditQueryFilter {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                contract_id: None,
                tool_id: None,
                after_sequence: None,
                before_sequence: None,
                limit: 20,
            },
        })
        .expect("audit query succeeds");
    assert!(audit
        .iter()
        .any(|event| matches!(event, KernelEvent::AuditQueryCompleted { .. })));

    let cancelled = runtime
        .dispatch(KernelCommand::RunCancel {
            request_id: RequestId("run-cancel".to_string()),
            run_id: RunId("run-1".to_string()),
        })
        .expect("run cancel succeeds");
    assert!(cancelled.iter().any(|event| matches!(
        event,
        KernelEvent::RunCompleted { status, .. } if *status == RunStatus::Cancelled
    )));
    let workspace_read_leases = runtime
        .state
        .resource_manager
        .list()
        .into_iter()
        .filter(|resource| resource.kind == KernelResourceKind::WorkspaceReadLease)
        .collect::<Vec<_>>();
    assert!(!workspace_read_leases.is_empty());
    assert!(workspace_read_leases.iter().all(|resource| {
        resource.state == deepcode_kernel_ledger::KernelResourceState::Released
    }));
}

#[test]
fn resource_resolve_skips_binary_content() {
    let (mut runtime, workspace) = runtime_with_workspace();
    fs::write(
        workspace.join("binary.bin"),
        [0x7f, b'E', b'L', b'F', 0, 1, 2],
    )
    .expect("write binary fixture");
    let events = runtime
        .dispatch(KernelCommand::ResourceResolve {
            request_id: RequestId("resource-resolve".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            request: ResourceResolveRequest {
                manifest: serde_json::json!({
                    "items": [{
                        "id": "binary-item",
                        "kind": "file",
                        "path": "binary.bin"
                    }]
                }),
            },
        })
        .expect("resource resolve succeeds");
    let packet = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ResourcePacketProduced { packet, .. } => Some(packet),
            _ => None,
        })
        .expect("resource packet");
    assert_eq!(
        packet.items[0].content_kind,
        Some(ResourcePacketContentKind::FileSkipped)
    );
    assert!(packet.items[0].content.is_none());
}

#[test]
fn resource_resolve_supports_bounded_inventory_and_metadata_only_reads() {
    let (mut runtime, workspace) = runtime_with_workspace();
    let token = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let directory_name = format!("inventory-{token}");
    let directory = workspace.join(&directory_name);
    fs::create_dir_all(directory.join(format!("nested-{token}"))).expect("create inventory");
    for index in 0..24 {
        fs::write(
            directory.join(format!("entry-{token}-{index}.txt")),
            format!("value-{index}"),
        )
        .expect("write inventory entry");
    }
    let metadata_name = format!("metadata-{token}.txt");
    fs::write(workspace.join(&metadata_name), "metadata-only content")
        .expect("write metadata target");

    let events = runtime
        .dispatch(KernelCommand::ResourceResolve {
            request_id: RequestId(format!("resource-options-{token}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            request: ResourceResolveRequest {
                manifest: serde_json::json!({
                    "id": format!("manifest-{token}"),
                    "workspaceScopeKey": format!("scope-{token}"),
                    "items": [
                        {
                            "id": format!("root-{token}"),
                            "rootId": format!("root-{token}"),
                            "kind": "directory",
                            "path": directory_name,
                            "directoryOptions": {
                                "maxDepth": 1,
                                "maxEntries": 20,
                                "includeContent": false
                            }
                        },
                        {
                            "id": format!("metadata-{token}"),
                            "rootId": format!("root-{token}"),
                            "kind": "resource",
                            "path": metadata_name,
                            "readMode": "metadataOnly"
                        },
                        {
                            "id": format!("missing-{token}"),
                            "rootId": format!("root-{token}"),
                            "kind": "resource",
                            "path": format!("absent-{token}.txt"),
                            "readMode": "metadataOnly"
                        }
                    ]
                }),
            },
        })
        .expect("resource resolve succeeds");
    let packet = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ResourcePacketProduced { packet, .. } => Some(packet),
            _ => None,
        })
        .expect("resource packet");

    assert_eq!(packet.workspace_scope_key, format!("scope-{token}"));
    let inventory = &packet.items[0];
    assert_eq!(
        inventory.content_kind,
        Some(ResourcePacketContentKind::DirectoryTree)
    );
    assert_eq!(inventory.returned_count, Some(20));
    assert_eq!(inventory.truncated, Some(true));
    assert_eq!(inventory.directory_depth, Some(1));
    assert!(inventory
        .nodes
        .iter()
        .all(|node| node.name.is_some() && node.path.is_some()));

    let metadata = &packet.items[1];
    assert_eq!(
        metadata.content_kind,
        Some(ResourcePacketContentKind::Metadata)
    );
    assert_eq!(
        metadata.resolved_kind,
        Some(ResourcePacketResolvedKind::File)
    );
    assert!(metadata.content.is_none());
    assert!(metadata
        .metadata_hash
        .as_deref()
        .is_some_and(|value| value.starts_with("sha256:")));

    let missing = &packet.items[2];
    assert_eq!(missing.status, ResourcePacketStatus::NotFound);
    assert_eq!(missing.reason.as_deref(), Some("not_found"));
}
