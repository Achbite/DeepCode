use super::*;

fn archive_test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("deepcode-{label}-{}", now_millis()))
}

#[test]
fn observability_redaction_preserves_cache_counts_and_removes_credentials() {
    let value = redact_archive_value(json!({
        "rawUsage": {
            "prompt_cache_hit_tokens": 80,
            "prompt_cache_miss_tokens": 20,
            "total_tokens": 120
        },
        "apiToken": "credential-value",
        "authorization": "Bearer credential-value",
        "nested": { "access_token": "credential-value" }
    }));

    assert_eq!(value["rawUsage"]["prompt_cache_hit_tokens"], 80);
    assert_eq!(value["rawUsage"]["prompt_cache_miss_tokens"], 20);
    assert_eq!(value["rawUsage"]["total_tokens"], 120);
    assert_eq!(value["apiToken"], "[redacted]");
    assert_eq!(value["authorization"], "[redacted]");
    assert_eq!(value["nested"]["access_token"], "[redacted]");
}

#[test]
fn projection_delivery_sanitizer_keeps_only_metadata() {
    let sanitized = sanitize_projection_delivery_entry(
        "session-canonical",
        json!({
            "schemaVersion": "deepcode.session.projection-delivery.v1",
            "stage": "gui.reducer_applied",
            "at": "1784555088972",
            "sessionId": "session-untrusted",
            "runId": "run-1",
            "turnId": "turn-1",
            "itemId": "semantic-call-1",
            "blockId": "block-1",
            "op": "text.append",
            "revision": 2,
            "deltaSeq": 4,
            "deliveryMode": "live",
            "charLength": 12,
            "contentHash": "fnv1a32:12345678",
            "failureCode": "semantic_draft_invalid_json",
            "result": "accepted",
            "content": "must not be archived",
            "payload": { "authorization": "Bearer secret" },
            "rawEventRefs": ["evt-secret"],
            "absolutePath": "/private/workspace/file.cpp"
        }),
    )
    .expect("projection delivery metadata");

    assert_eq!(sanitized["sessionId"], "session-canonical");
    assert_eq!(sanitized["runId"], "run-1");
    assert_eq!(sanitized["itemId"], "semantic-call-1");
    assert_eq!(sanitized["failureCode"], "semantic_draft_invalid_json");
    assert_eq!(sanitized["deltaSeq"], 4);
    assert_eq!(sanitized["charLength"], 12);
    assert!(sanitized.get("content").is_none());
    assert!(sanitized.get("payload").is_none());
    assert!(sanitized.get("rawEventRefs").is_none());
    assert!(sanitized.get("absolutePath").is_none());
}

#[test]
fn projection_delivery_sanitizer_rejects_unknown_schema() {
    let result = sanitize_projection_delivery_entry(
        "session-1",
        json!({
            "schemaVersion": "unknown",
            "stage": "gui.reducer_applied",
            "at": "1",
            "runId": "run-1"
        }),
    );
    assert!(result.is_err());
}

#[test]
fn projection_delivery_sanitizer_rejects_unknown_stage() {
    let result = sanitize_projection_delivery_entry(
        "session-1",
        json!({
            "schemaVersion": "deepcode.session.projection-delivery.v1",
            "stage": "provider.secret_payload",
            "at": "1",
            "runId": "run-1"
        }),
    );
    assert!(result.is_err());
}

#[test]
fn wire_ledger_rejects_reasoning_records_and_strips_nested_reasoning_fields() {
    assert!(is_hidden_reasoning_wire_record(&json!({
        "kind": "hiddenReasoning",
        "content": "not persisted"
    })));
    let stripped = strip_hidden_reasoning_fields(json!({
        "kind": "providerRequest",
        "reasoning_content": "not persisted",
        "messages": [{
            "role": "assistant",
            "content": "visible semantic output",
            "reasoningContent": "not persisted"
        }]
    }));
    assert!(stripped.get("reasoning_content").is_none());
    assert!(stripped["messages"][0].get("reasoningContent").is_none());
    assert_eq!(
        stripped["messages"][0]["content"],
        "visible semantic output"
    );
}

#[test]
fn conversation_archive_projection_and_transcript_create_exports() {
    let root = archive_test_root("conversation-archive");
    let session_id = "session/test";
    let session = json!({
        "id": session_id,
        "workspaceId": "wf/0",
        "workspaceHash": "hash:1"
    });
    let projection = json!({
        "kind": "user_msg",
        "payload": {
            "content": "测试归档",
            "kernelEvent": { "runId": "run/1" },
            "actionBundleDraft": { "version": "1" },
            "apiToken": "plain-secret-token"
        }
    });
    let transcript = json!({
        "role": "user",
        "channel": "user",
        "runId": "run/1",
        "content": "完整请求",
        "authorization": "Bearer abc"
    });
    let context_trace = json!({
        "type": "metadata",
        "role": "assistant",
        "channel": "trace",
        "runId": "run/1",
        "kind": "provider_trace",
        "payload": {
            "stage": "provider_call.request",
            "runId": "run/1",
            "payload": {
                "contextAssembly": {
                    "schemaVersion": "deepcode.session.context-assembly.v2",
                    "contextAssemblyId": "context-generic",
                    "stablePrefixHash": "hash-stable",
                    "dynamicSuffixHash": "hash-dynamic",
                    "cacheHash": "hash-cache",
                    "resourceFullTextCharCount": 0,
                    "resourceSummaryCharCount": 42,
                    "segments": [{
                        "name": "protocolContract",
                        "cacheClass": "globalStable",
                        "stablePrefix": true,
                        "auditOnly": false,
                        "contentHash": "hash-segment",
                        "charLength": 42
                    }],
                    "resourceBlocks": [{
                        "blockKey": "resource-block-generic",
                        "displayRef": "generic/file.txt",
                        "retention": "summary",
                        "status": "resolved",
                        "contentHash": "hash-resource",
                        "charLength": 128,
                        "volatileFieldStripped": true
                    }]
                }
            }
        }
    });
    let provider_error = json!({
        "kind": "error",
        "payload": {
            "summary": "ProviderJsonDecodeFailed:\n  provider = openaiCompatible\n  status = 200\n  content_type = text/html\n  is_stream = false\n  body_preview = <html>bad gateway</html>\n  expected_schema = openai.chat.completion.v1: choices[0].message",
            "runId": "run/1",
            "providerError": {
                "reason": "ProviderJsonDecodeFailed",
                "provider": "openaiCompatible",
                "status": 200,
                "contentType": "text/html",
                "isStream": false,
                "bodyPreview": "<html>bad gateway</html>",
                "expectedSchema": "openai.chat.completion.v1: choices[0].message"
            }
        }
    });
    let reasoning = json!({
        "kind": "assistant_msg",
        "payload": {
            "channel": "reasoning",
            "content": "内部推理摘要",
            "runId": "run/1"
        }
    });
    let llm_trace = json!({
        "kind": "llm.requested",
        "payload": {
            "traceKind": "llm.requested",
            "visibility": "trace",
            "runId": "run/1",
            "llmCallId": "llm-run-1",
            "requestEnvelope": {
                "messages": [
                    {
                        "role": "user",
                        "content": "读取上下文"
                    }
                ]
            }
        }
    });

    append_conversation_archive_projection(&root, session_id, Some(&session), &[projection])
        .expect("projection archive append");
    append_conversation_archive_projection(
        &root,
        session_id,
        Some(&session),
        &[provider_error, reasoning, llm_trace],
    )
    .expect("provider error projection archive append");
    append_conversation_archive_transcript(
        &root,
        session_id,
        Some(&session),
        &[transcript, context_trace],
    )
    .expect("transcript archive append");

    let archive_dir = root
        .join("workspace-wf_0-hash_1")
        .join("session_test")
        .join("run_1");
    assert!(archive_dir.join("manifest.json").exists());
    assert!(archive_dir.join("projection.jsonl").exists());
    assert!(archive_dir.join("transcript.jsonl").exists());
    assert!(archive_dir
        .join("debug")
        .join("projection-events.jsonl")
        .exists());
    assert!(archive_dir
        .join("debug")
        .join("transcript-events.jsonl")
        .exists());
    assert!(archive_dir
        .join("debug")
        .join("action-bundle-drafts.jsonl")
        .exists());
    assert!(archive_dir
        .join("debug")
        .join("llm-provider-errors.jsonl")
        .exists());
    assert!(archive_dir
        .join("debug")
        .join("trace-events.jsonl")
        .exists());
    assert!(archive_dir
        .join("debug")
        .join("llm-exchanges.jsonl")
        .exists());
    assert!(archive_dir
        .join("debug")
        .join("context-assemblies.jsonl")
        .exists());
    assert!(archive_dir.join("exports").join("complete.md").exists());
    assert!(archive_dir.join("exports").join("debug.json").exists());
    assert!(archive_dir
        .join("exports")
        .join("context-assemblies.md")
        .exists());
    let session_archive_dir = root
        .join("workspace-wf_0-hash_1")
        .join("session_test")
        .join("session");
    assert!(session_archive_dir
        .join("exports")
        .join("chronological.md")
        .exists());
    assert!(session_archive_dir
        .join("exports")
        .join("chronological-debug.json")
        .exists());

    let projection_content =
        fs::read_to_string(archive_dir.join("projection.jsonl")).expect("projection jsonl");
    let transcript_content =
        fs::read_to_string(archive_dir.join("transcript.jsonl")).expect("transcript jsonl");
    assert!(projection_content.contains("[redacted]"));
    assert!(!projection_content.contains("plain-secret-token"));
    assert!(transcript_content.contains("[redacted]"));
    assert!(!transcript_content.contains("Bearer abc"));

    let manifests = read_conversation_archive_manifests(&root, session_id);
    assert_eq!(manifests.len(), 2);
    let run_manifest = manifests
        .iter()
        .find(|manifest| manifest.get("runId").and_then(Value::as_str) == Some("run/1"))
        .expect("run archive manifest");
    let files = run_manifest
        .get("files")
        .and_then(Value::as_array)
        .expect("manifest files");
    assert!(files
        .iter()
        .any(|file| { file.get("path").and_then(Value::as_str) == Some("projection.jsonl") }));
    assert!(files
        .iter()
        .any(|file| { file.get("path").and_then(Value::as_str) == Some("exports/complete.md") }));
    assert!(files.iter().any(|file| {
        file.get("path").and_then(Value::as_str) == Some("debug/action-bundle-drafts.jsonl")
    }));
    assert!(files.iter().any(|file| {
        file.get("path").and_then(Value::as_str) == Some("debug/llm-provider-errors.jsonl")
    }));
    assert!(files.iter().any(|file| {
        file.get("path").and_then(Value::as_str) == Some("debug/context-assemblies.jsonl")
    }));
    let context_export =
        fs::read_to_string(archive_dir.join("exports").join("context-assemblies.md"))
            .expect("context assemblies markdown");
    assert!(context_export.contains("context-generic"));
    assert!(context_export.contains("globalStable"));
    assert!(context_export.contains("resource-block-generic"));
    assert!(context_export.contains("resourceSummaryCharCount"));
    let chronological =
        fs::read_to_string(session_archive_dir.join("exports").join("chronological.md"))
            .expect("chronological markdown");
    assert!(chronological.contains("DeepCode Chronological Conversation"));
    assert!(chronological.contains("测试归档"));
    assert!(chronological.contains("完整请求"));
    assert!(chronological.contains("ProviderJsonDecodeFailed:"));
    assert!(chronological.contains("expected_schema = openai.chat.completion.v1"));
    assert!(chronological.contains("Projection / Thinking / run/1"));
    assert!(chronological.contains("Projection / Trace / run/1"));

    let _ = fs::remove_dir_all(root);
}

#[test]
fn conversation_archive_uses_unbound_workspace_without_session_metadata() {
    let root = archive_test_root("conversation-unbound");
    append_conversation_archive_projection(
        &root,
        "session without metadata",
        None,
        &[json!({
            "kind": "assistant_msg",
            "payload": { "content": "hello", "runId": "run alpha" }
        })],
    )
    .expect("projection archive append");

    let archive_dir = root
        .join("unbound-workspace")
        .join("session_without_metadata")
        .join("run_alpha");
    assert!(archive_dir.join("manifest.json").exists());

    let _ = fs::remove_dir_all(root);
}

#[test]
fn memory_archive_writes_markdown_sidecars_and_manifest() {
    let root = archive_test_root("memory-archive");
    let session_id = "session/archive";
    let session = json!({
        "id": session_id,
        "workspaceId": "workspace/alpha",
        "workspaceHash": "hash/beta"
    });
    let body = json!({
        "snapshot": {
            "metadata": {
                "projectMarkdownPreview": "# Project Memory\n\n- Boundary retained",
                "sessionMarkdownPreview": "# Session Memory\n\n- Next checkpoint retained",
                "archiveDescriptor": {
                    "schemaVersion": "deepcode.session.memory-archive.v1",
                    "workspaceScopeKey": "workspace-workspace_alpha-hash_beta"
                },
                "archiveSidecar": {
                    "schemaVersion": "deepcode.session.memory-sidecar.v1",
                    "items": [{
                        "scope": "session",
                        "kind": "checkpoint",
                        "content": "checkpoint retained",
                        "sourceRefs": [{
                            "sessionId": session_id,
                            "eventId": "event-generic"
                        }]
                    }]
                }
            }
        }
    });

    let result = write_session_memory_archive(&root, session_id, Some(&session), &body)
        .expect("memory archive write");
    let archive_dir = root.join("workspace-workspace_alpha-hash_beta");
    let safe_session = safe_path_segment(session_id);
    assert_eq!(
        result.get("workspaceScopeKey").and_then(Value::as_str),
        Some("workspace-workspace_alpha-hash_beta")
    );
    assert!(archive_dir.join("project.md").exists());
    assert!(archive_dir.join("project.memory.json").exists());
    assert!(archive_dir
        .join("sessions")
        .join(format!("{safe_session}.md"))
        .exists());
    assert!(archive_dir
        .join("sessions")
        .join(format!("{safe_session}.memory.json"))
        .exists());
    let project_markdown =
        fs::read_to_string(archive_dir.join("project.md")).expect("project memory markdown");
    assert!(project_markdown.contains("Boundary retained"));
    let project_sidecar =
        read_json_file(&archive_dir.join("project.memory.json")).expect("project sidecar");
    assert_eq!(
        project_sidecar.get("memoryScope").and_then(Value::as_str),
        Some("project")
    );
    let manifest = read_json_file(&archive_dir.join("manifest.json")).expect("manifest");
    assert_eq!(
        manifest.get("schemaVersion").and_then(Value::as_str),
        Some("deepcode.session.memory-archive-manifest.v1")
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn restore_session_index_uses_archive_manifest_and_projection_fallback() {
    let root = archive_test_root("session-restore");
    let sessions_dir = root.join("sessions");
    let archive_root = root.join("conversation-archives");
    let paths = HostPaths {
        settings_path: root.join("settings.json"),
        llm_profiles_path: root.join("profiles.json"),
        llm_secrets_path: root.join("secrets.json"),
        workflow_config_path: root.join("workflow.json"),
        projects_path: root.join("projects.json"),
        sessions_index_path: root.join("agent-sessions.json"),
        sessions_dir: sessions_dir.clone(),
        conversation_archives_dir: archive_root.clone(),
        memory_archives_dir: root.join("memory").join("projects"),
    };

    let archived_session_id = "session-12345";
    let archived_session = create_agent_session_value(
        archived_session_id,
        "12345",
        "New Agent Session",
        "plan",
        None,
        Some("ws/1"),
        Some("hash/1"),
    );
    let archived_user = json!({
        "id": "evt-user-1",
        "sessionId": archived_session_id,
        "ts": "12346",
        "kind": "user_msg",
        "payload": { "content": "恢复历史对话标题", "runId": "run-1" }
    });
    let archived_answer = json!({
        "id": "evt-assistant-1",
        "sessionId": archived_session_id,
        "ts": "12347",
        "kind": "assistant_msg",
        "payload": { "content": "ok", "runId": "run-1" }
    });
    append_session_projection_jsonl(
        &sessions_dir,
        archived_session_id,
        &[archived_user.clone(), archived_answer],
    )
    .expect("archived projection jsonl");
    append_conversation_archive_projection(
        &archive_root,
        archived_session_id,
        Some(&archived_session),
        &[archived_user],
    )
    .expect("archived conversation manifest");

    let fallback_session_id = "session-99999";
    append_session_projection_jsonl(
        &sessions_dir,
        fallback_session_id,
        &[json!({
            "id": "evt-user-2",
            "sessionId": fallback_session_id,
            "ts": "99999",
            "kind": "user_msg",
            "payload": { "content": "只有 projection 的会话" }
        })],
    )
    .expect("fallback projection jsonl");

    let restored = restore_session_index(&paths);
    assert_eq!(restored.len(), 2);
    let archived = restored
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(archived_session_id))
        .expect("archived session restored");
    assert_eq!(archived.get("eventCount").and_then(Value::as_u64), Some(2));
    assert_eq!(
        archived.get("title").and_then(Value::as_str),
        Some("恢复历史对话标题")
    );
    assert_eq!(
        archived.get("workspaceScopeKey").and_then(Value::as_str),
        Some("workspace-ws_1-hash_1")
    );

    let fallback = restored
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(fallback_session_id))
        .expect("projection-only session restored");
    assert_eq!(fallback.get("eventCount").and_then(Value::as_u64), Some(1));
    assert_eq!(
        fallback.get("title").and_then(Value::as_str),
        Some("只有 projection 的会话")
    );
    assert_eq!(
        fallback.get("workspaceScopeKey").and_then(Value::as_str),
        Some("unbound-workspace")
    );

    let current_by_scope = restored_current_session_ids_by_scope(&restored);
    assert_eq!(
        current_by_scope
            .get("workspace-ws_1-hash_1")
            .map(String::as_str),
        Some(archived_session_id)
    );
    assert_eq!(
        current_by_scope
            .get("unbound-workspace")
            .map(String::as_str),
        Some(fallback_session_id)
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn append_session_projection_hydrates_restored_history_before_append() {
    let root = archive_test_root("projection-hydrate");
    let sessions_dir = root.join("sessions");
    let archive_root = root.join("conversation-archives");
    let session_id = "session-123456";
    let paths = HostPaths {
        settings_path: root.join("settings.json"),
        llm_profiles_path: root.join("profiles.json"),
        llm_secrets_path: root.join("secrets.json"),
        workflow_config_path: root.join("workflow.json"),
        projects_path: root.join("projects.json"),
        sessions_index_path: root.join("agent-sessions.json"),
        sessions_dir: sessions_dir.clone(),
        conversation_archives_dir: archive_root,
        memory_archives_dir: root.join("memory").join("projects"),
    };
    let historical_event = json!({
        "id": "evt-history",
        "sessionId": session_id,
        "ts": "1",
        "kind": "user_msg",
        "payload": { "content": "历史问题" }
    });
    let appended_event = json!({
        "id": "evt-next",
        "sessionId": session_id,
        "ts": "2",
        "kind": "user_msg",
        "payload": { "content": "继续追问" }
    });
    append_session_projection_jsonl(&sessions_dir, session_id, &[historical_event.clone()])
        .expect("historical projection");

    let session = create_agent_session_value(
        session_id,
        "1",
        "历史问题",
        "plan",
        None,
        Some("ws"),
        Some("hash"),
    );
    let state = AppState {
        runtime: Arc::new(Mutex::new(DeepCodeKernelRuntime::new())),
        gui: Arc::new(Mutex::new(GuiState {
            paths,
            user_settings: json!({}),
            llm_profiles: json!({}),
            workflow_config: json!({}),
            projects: Vec::new(),
            sessions: vec![session],
            current_session_id: Some(session_id.to_string()),
            current_session_ids_by_scope: HashMap::new(),
            session_projection_cache: HashMap::new(),
            session_timeline_cache: HashMap::new(),
            trace_events: HashMap::new(),
        })),
        terminal_runtime: Arc::new(Mutex::new(crate::terminal_api::TerminalRuntime::new())),
        kernel_events: Arc::new(Mutex::new(Vec::new())),
        session_runs: Arc::new(Mutex::new(HashMap::new())),
        session_run_deltas: Arc::new(Mutex::new(HashMap::new())),
        projection_delivery: Arc::new(Mutex::new(ProjectionDeliveryBufferState::default())),
    };

    append_session_projection(&state, session_id, vec![appended_event.clone()]);
    let stored = session_projection(&state, session_id);
    assert_eq!(stored.len(), 2);
    assert_eq!(stored[0], historical_event);
    assert_eq!(stored[1], appended_event);
    let event_count = state
        .gui
        .lock()
        .expect("gui lock")
        .sessions
        .first()
        .and_then(|session| session.get("eventCount"))
        .and_then(Value::as_u64);
    assert_eq!(event_count, Some(2));

    let _ = fs::remove_dir_all(root);
}
