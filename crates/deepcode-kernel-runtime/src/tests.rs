use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

static TEMP_INDEX: AtomicU64 = AtomicU64::new(0);

fn runtime_with_workspace() -> (DeepCodeKernelRuntime, PathBuf) {
    let temp = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-smoke-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&temp);
    fs::create_dir_all(&temp).expect("create temp workspace");
    fs::write(temp.join("input.txt"), "generic input\n").expect("write file");
    fs::create_dir(temp.join("nested")).expect("create nested dir");
    fs::write(temp.join("nested").join("child.txt"), "child\n").expect("write child");
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("req-workspace-open".to_string()),
            path: temp.to_string_lossy().to_string(),
        })
        .expect("workspace opens");
    (runtime, temp)
}

#[test]
fn run_create_produces_state_contract_and_driver_request() {
    let (mut runtime, _temp) = runtime_with_workspace();
    let events = runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Analyze the attached resource.".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: None,
                workspace_hash: None,
                open_path: None,
                active_folder_id: None,
                folder_hash: None,
            }),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::StateEntered { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::DriverRequestProduced { .. })));
}

#[test]
fn proposal_submit_accepts_only_protocol_v3() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Return a generic answer.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let accepted = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("req-proposal".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v3".to_string(),
                proposal_id: "proposal-generic".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                source: deepcode_kernel_abi::ProposalEnvelopeSource::Llm,
                kind: deepcode_kernel_abi::ProposalEnvelopeKind::Answer,
                payload: serde_json::json!({
                    "format": "markdown",
                    "content": "Generic answer."
                }),
                referenced_resource_packet_refs: vec![],
                referenced_evidence_refs: vec![],
                parser_diagnostics: None,
            },
        })
        .expect("v3 proposal command succeeds");
    assert!(accepted
        .iter()
        .any(|event| matches!(event, KernelEvent::ProposalAccepted { .. })));

    let rejected = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("req-proposal-reject".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "unsupported.protocol.schema".to_string(),
                proposal_id: "proposal-invalid".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                source: deepcode_kernel_abi::ProposalEnvelopeSource::Llm,
                kind: deepcode_kernel_abi::ProposalEnvelopeKind::Answer,
                payload: serde_json::json!({}),
                referenced_resource_packet_refs: vec![],
                referenced_evidence_refs: vec![],
                parser_diagnostics: None,
            },
        })
        .expect("invalid proposal returns rejection event");
    assert!(rejected
        .iter()
        .any(|event| matches!(event, KernelEvent::ProposalRejected { .. })));
}

#[test]
fn resource_resolve_reads_explicit_file_and_directory_manifest_entries() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Resolve generic resources.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let manifest = serde_json::json!({
        "id": "manifest-generic",
        "entries": [
            {
                "id": "entry-file",
                "kind": "file",
                "resourceRef": temp.join("input.txt").to_string_lossy(),
                "reason": "explicit file"
            },
            {
                "id": "entry-dir",
                "kind": "directory",
                "resourceRef": temp.join("nested").to_string_lossy(),
                "reason": "explicit directory"
            }
        ]
    });
    let events = runtime
        .dispatch(KernelCommand::ResourceResolve {
            request_id: RequestId("req-resource".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-generic".to_string())),
            request: ResourceResolveRequest { manifest },
        })
        .expect("resource resolve succeeds");

    let packet = events
        .iter()
        .find_map(|event| {
            if let KernelEvent::ResourcePacketProduced { packet, .. } = event {
                Some(packet)
            } else {
                None
            }
        })
        .expect("resource packet event");
    let items = packet
        .get("items")
        .and_then(Value::as_array)
        .expect("items");
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .any(|item| item.get("contentKind").and_then(Value::as_str) == Some("fileText")));
    assert!(items
        .iter()
        .any(|item| item.get("contentKind").and_then(Value::as_str) == Some("directoryTree")));
}
