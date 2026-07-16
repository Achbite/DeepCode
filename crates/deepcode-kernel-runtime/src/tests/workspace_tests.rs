use super::*;

#[test]
fn run_create_produces_state_contract_and_driver_request() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let events = runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("run-create-second".to_string()),
            session_id: Some(SessionId("session-2".to_string())),
            input: UserInput {
                text: "Inspect generic resources.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: None,
            profile_ref: None,
            run_overrides: None,
        })
        .expect("run creates");
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::StateEntered { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::DriverRequestProduced { .. })));
}

#[test]
fn workspace_binding_resolve_is_host_only_and_does_not_replace_current_workspace() {
    let path = std::env::temp_dir().join(format!(
        "deepcode-binding-resolve-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&path).expect("create binding root");
    let workspace = TestWorkspace(path.clone());
    let mut runtime = DeepCodeKernelRuntime::new();
    let events = runtime
        .dispatch(KernelCommand::WorkspaceBindingResolve {
            request_id: RequestId("binding-resolve".to_string()),
            path: path.to_string_lossy().to_string(),
        })
        .expect("binding resolves");
    let output = events
        .into_iter()
        .find_map(|event| match event {
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                output,
                ..
            } if tool_name == "workspace.binding.resolve" => output,
            _ => None,
        })
        .expect("binding output");
    assert_eq!(output["rootStatus"], "ready");
    assert_eq!(
        output["workspaceBinding"]["openPath"].as_str(),
        Some(workspace.to_string_lossy().as_ref())
    );
    assert!(runtime.state.current_workspace.is_none());
}

#[test]
fn workspace_binding_resolve_rejects_regular_files() {
    let path = std::env::temp_dir().join(format!(
        "deepcode-binding-file-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    fs::write(&path, "text").expect("write binding candidate");
    let mut runtime = DeepCodeKernelRuntime::new();
    let error = runtime
        .dispatch(KernelCommand::WorkspaceBindingResolve {
            request_id: RequestId("binding-file".to_string()),
            path: path.to_string_lossy().to_string(),
        })
        .expect_err("file cannot become workspace binding");
    assert!(error.to_string().contains("not a directory"));
    let _ = fs::remove_file(path);
}

#[test]
fn resource_resolve_uses_each_run_binding_instead_of_global_workspace() {
    let first_path = std::env::temp_dir().join(format!(
        "deepcode-run-root-a-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let second_path = std::env::temp_dir().join(format!(
        "deepcode-run-root-b-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&first_path).expect("create first run root");
    fs::create_dir_all(&second_path).expect("create second run root");
    fs::write(first_path.join("marker.txt"), "first-root\n").expect("write first marker");
    fs::write(second_path.join("marker.txt"), "second-root\n").expect("write second marker");
    let _first = TestWorkspace(first_path.clone());
    let _second = TestWorkspace(second_path.clone());
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("global-workspace".to_string()),
            path: second_path.to_string_lossy().to_string(),
        })
        .expect("global workspace opens");
    for (session_id, path) in [("session-a", &first_path), ("session-b", &second_path)] {
        runtime
            .dispatch(KernelCommand::RunCreate {
                request_id: RequestId(format!("run-create-{session_id}")),
                session_id: Some(SessionId(session_id.to_string())),
                input: UserInput {
                    text: "Read the bound workspace marker.".to_string(),
                    attachments: Vec::new(),
                },
                workspace_binding: Some(workspace_binding_from_root(path)),
                profile_ref: None,
                run_overrides: None,
            })
            .expect("run creates");
    }

    for (run_id, session_id, expected) in [
        ("run-1", "session-a", "first-root\n"),
        ("run-2", "session-b", "second-root\n"),
    ] {
        let events = runtime
            .dispatch(KernelCommand::ResourceResolve {
                request_id: RequestId(format!("resolve-{run_id}")),
                run_id: Some(RunId(run_id.to_string())),
                session_id: Some(SessionId(session_id.to_string())),
                request: ResourceResolveRequest {
                    manifest: serde_json::json!({
                        "items": [{ "id": "marker", "kind": "file", "path": "marker.txt" }]
                    }),
                },
            })
            .expect("resource resolves");
        let packet = events
            .into_iter()
            .find_map(|event| match event {
                KernelEvent::ResourcePacketProduced { packet, .. } => Some(packet),
                _ => None,
            })
            .expect("resource packet");
        assert_eq!(packet["items"][0]["content"].as_str(), Some(expected));
    }
}

#[test]
fn agent_action_does_not_fall_back_to_host_current_workspace() {
    let path = std::env::temp_dir().join(format!(
        "deepcode-host-only-workspace-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&path).expect("create host workspace");
    let workspace = TestWorkspace(path.clone());
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("host-workspace-open".to_string()),
            path: path.to_string_lossy().to_string(),
        })
        .expect("host workspace opens");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("unbound-run-create".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "Create a generic file.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: None,
            profile_ref: None,
            run_overrides: None,
        })
        .expect("unbound run creates");
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "create-unbound",
            "toolId": "fs.create",
            "args": { "path": "unbound.txt", "contentBlockId": "unbound-content" },
            "description": "Create an unbound file",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "unbound-content",
            "targetPath": "unbound.txt",
            "operation": "create",
            "contentLines": ["content"]
        }]),
    );
    let report = submit_proposal_raw(&mut runtime, payload);
    assert_eq!(report["status"], "denied");
    assert!(!workspace.join("unbound.txt").exists());
}
