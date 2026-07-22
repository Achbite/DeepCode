use super::*;

#[test]
fn bridge_output_reader_drains_payloads_larger_than_pipe_capacity() {
    let child = Command::new("seq")
        .args(["1", "50000"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bridge output fixture");

    let output = wait_for_child_output(child, || false, Some(Duration::from_secs(10)))
        .expect("drain bridge output");

    assert!(output.status.success());
    assert!(output.stdout.len() > 65_536);
    assert!(output.stderr.is_empty());
}

#[test]
fn bridge_timeline_requires_current_structured_projection() {
    let result = json!({
        "timeline": {
            "schemaVersion": "deepcode.session.timeline.v1",
            "sessionId": "session-current",
            "generatedAt": "2026-07-11T00:00:00Z",
            "turns": [],
            "eventCount": 3
        }
    });
    assert!(validated_bridge_timeline(&result, "session-current", 3).is_ok());
    assert!(validated_bridge_timeline(&result, "session-other", 3).is_err());
    assert!(validated_bridge_timeline(&result, "session-current", 4).is_err());
}

#[test]
fn bridge_timeline_rejects_missing_or_legacy_payloads() {
    assert!(validated_bridge_timeline(&json!({}), "session-current", 0).is_err());
    assert!(validated_bridge_timeline(
        &json!({
            "timeline": {
                "sessionId": "session-current",
                "turns": [],
                "eventCount": 0
            }
        }),
        "session-current",
        0,
    )
    .is_err());
}

#[test]
fn project_memory_mode_is_forwarded_to_host_bridge() {
    let body = AgentSessionRunRequest {
        content: Some("test request".to_string()),
        project_memory_mode: Some(json!("auto")),
        ..Default::default()
    };
    let request = host_bridge_request(
        "session-memory-forward",
        "run-memory-forward",
        &body,
        "profile-memory-forward",
        Some("medium".to_string()),
        normalize_project_memory_mode(body.project_memory_mode.clone(), None),
        "strict".to_string(),
        None,
    );
    assert_eq!(
        request.get("projectMemoryMode").and_then(Value::as_str),
        Some("auto")
    );
}

#[test]
fn missing_or_invalid_project_memory_mode_defaults_to_confirm() {
    assert_eq!(normalize_project_memory_mode(None, None), "confirm");
    assert_eq!(
        normalize_project_memory_mode(Some(json!("invalid")), None),
        "confirm"
    );
    assert_eq!(
        normalize_project_memory_mode(None, Some("auto".to_string())),
        "auto"
    );
}

#[test]
fn run_delta_normalization_attaches_monotonic_stream_cursor_fields() {
    let delta = normalize_run_delta(
        "session-generic",
        "run-generic",
        7,
        json!({
            "kind": "stage_delta",
            "payload": {
                "status": "streaming"
            }
        }),
    );
    assert_eq!(
        delta.get("sessionId").and_then(Value::as_str),
        Some("session-generic")
    );
    assert_eq!(
        delta.get("hostRunId").and_then(Value::as_str),
        Some("run-generic")
    );
    assert_eq!(delta.get("deltaSeq").and_then(Value::as_u64), Some(7));
    assert!(delta.get("receivedAt").and_then(Value::as_str).is_some());
}

#[test]
fn terminal_stream_event_tail_does_not_replay_sent_history() {
    let unique = now_millis();
    let events = vec![
        json!({ "id": format!("event-{unique}-a") }),
        json!({ "id": format!("event-{unique}-b") }),
        json!({ "id": format!("event-{unique}-c") }),
    ];
    let (tail, count) = terminal_stream_event_tail(&events, 2);
    let expected_tail_id = format!("event-{unique}-c");
    assert_eq!(count, 3);
    assert_eq!(tail.len(), 1);
    assert_eq!(
        tail[0].get("id").and_then(Value::as_str),
        Some(expected_tail_id.as_str())
    );

    let (empty_tail, empty_count) = terminal_stream_event_tail(&events, count);
    assert_eq!(empty_count, 3);
    assert!(empty_tail.is_empty());
}

#[test]
fn session_memory_cleanup_removes_only_target_session_files() {
    let root = std::env::temp_dir().join(format!("deepcode-agent-memory-cleanup-{}", now_millis()));
    let memory_root = root.join("memory").join("projects");
    let scope_key = format!("workspace-{}", now_millis());
    let session_id = format!("session-{}", now_millis());
    let other_session_id = format!("session-{}-other", now_millis());
    let safe_session = safe_path_segment(&session_id);
    let safe_other_session = safe_path_segment(&other_session_id);
    let archive_dir = memory_root.join(&scope_key);
    let sessions_dir = archive_dir.join("sessions");
    fs::create_dir_all(&sessions_dir).expect("create session memory dir");
    fs::write(archive_dir.join("project.md"), "project memory").expect("project markdown");
    fs::write(
        archive_dir.join("manifest.json"),
        serde_json::to_string_pretty(&json!({
            "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
            "workspaceScopeKey": scope_key,
            "cleanupEvents": []
        }))
        .expect("manifest json"),
    )
    .expect("manifest");
    fs::write(
        sessions_dir.join(format!("{safe_session}.md")),
        "session markdown",
    )
    .expect("session markdown");
    fs::write(
        sessions_dir.join(format!("{safe_session}.memory.json")),
        "{}",
    )
    .expect("session sidecar");
    fs::write(
        sessions_dir.join(format!("{safe_other_session}.md")),
        "other session markdown",
    )
    .expect("other session markdown");
    fs::write(
        sessions_dir.join(format!("{safe_other_session}.memory.json")),
        "{}",
    )
    .expect("other session sidecar");

    let cleanup =
        remove_session_memory_archive(&memory_root, &scope_key, &safe_session, &session_id);
    assert_eq!(
        cleanup.get("workspaceScopeKey").and_then(Value::as_str),
        Some(scope_key.as_str())
    );
    assert_eq!(
        cleanup
            .get("removedFiles")
            .and_then(Value::as_array)
            .map(Vec::len),
        Some(2)
    );
    assert_eq!(
        cleanup
            .get("projectArchiveNeedsRefresh")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert!(!sessions_dir.join(format!("{safe_session}.md")).exists());
    assert!(!sessions_dir
        .join(format!("{safe_session}.memory.json"))
        .exists());
    assert!(sessions_dir
        .join(format!("{safe_other_session}.md"))
        .exists());
    assert!(sessions_dir
        .join(format!("{safe_other_session}.memory.json"))
        .exists());

    let manifest_content =
        fs::read_to_string(archive_dir.join("manifest.json")).expect("manifest content");
    let manifest: Value = serde_json::from_str(&manifest_content).expect("manifest json");
    let cleanup_events = manifest
        .get("cleanupEvents")
        .and_then(Value::as_array)
        .expect("cleanup events");
    assert_eq!(cleanup_events.len(), 1);
    assert_eq!(
        cleanup_events[0].get("event").and_then(Value::as_str),
        Some("session_memory_removed")
    );
    assert_eq!(
        cleanup_events[0].get("sessionId").and_then(Value::as_str),
        Some(session_id.as_str())
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn scoped_session_list_and_current_are_workspace_owned() {
    let mut gui = GuiState::new();
    let now = "2026-06-05T00:00:00Z";
    let session_a = create_agent_session_value(
        "session-a",
        now,
        "Workspace A",
        "plan",
        None,
        Some("workspace-a"),
        Some("hash-a"),
    );
    let session_b = create_agent_session_value(
        "session-b",
        now,
        "Workspace B",
        "plan",
        None,
        Some("workspace-b"),
        Some("hash-b"),
    );
    let scope_a = session_scope_key(&session_a);
    let scope_b = session_scope_key(&session_b);
    gui.sessions = vec![session_b, session_a];
    gui.current_session_ids_by_scope
        .insert(scope_a.clone(), "session-a".to_string());
    gui.current_session_ids_by_scope
        .insert(scope_b.clone(), "session-b".to_string());

    assert_eq!(
        scoped_sessions(&gui, &scope_a, false)
            .iter()
            .filter_map(|session| session.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec!["session-a"]
    );
    assert_eq!(
        scoped_sessions(&gui, &scope_b, false)
            .iter()
            .filter_map(|session| session.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>(),
        vec!["session-b"]
    );
    assert_eq!(
        current_agent_session_id_for_scope(&mut gui, &scope_a).as_deref(),
        Some("session-a")
    );
    assert_eq!(
        current_agent_session_id_for_scope(&mut gui, &scope_b).as_deref(),
        Some("session-b")
    );

    session_mut(&mut gui, "session-a").unwrap()["archivedAt"] = json!(now);
    gui.current_session_ids_by_scope.remove(&scope_a);
    ensure_current_agent_session_for_scope(
        &mut gui,
        &scope_a,
        Some((
            None,
            Some("workspace-a".to_string()),
            Some("hash-a".to_string()),
        )),
    );

    assert_ne!(
        current_agent_session_id_for_scope(&mut gui, &scope_a).as_deref(),
        Some("session-b")
    );
    assert_eq!(
        current_agent_session_id_for_scope(&mut gui, &scope_b).as_deref(),
        Some("session-b")
    );
}

#[test]
fn session_schema_requires_kernel_abi_v1_protocol_v4_and_tool_catalog_v3() {
    let current = create_agent_session_value(
        "session-schema-current",
        "2026-07-12T00:00:00Z",
        "Current schema",
        "plan",
        None,
        None,
        None,
    );
    assert!(session_schema_is_compatible(&current));

    let mut missing_abi = current.clone();
    missing_abi
        .as_object_mut()
        .unwrap()
        .remove("kernelAbiVersion");
    assert!(!session_schema_is_compatible(&missing_abi));

    let mut missing = current.clone();
    missing
        .as_object_mut()
        .unwrap()
        .remove("toolCatalogVersion");
    assert!(!session_schema_is_compatible(&missing));

    let mut old = current;
    old["kernelAbiVersion"] = json!("deepcode.kernel.abi.v0");
    assert!(!session_schema_is_compatible(&old));
    old["kernelAbiVersion"] = json!(deepcode_kernel_runtime::KERNEL_ABI_VERSION);
    old["agentProtocolVersion"] = json!("deepcode.agent.protocol.v3");
    assert!(!session_schema_is_compatible(&old));
}
