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

#[test]
fn resource_resolve_reads_file_byte_ranges() {
    let (mut runtime, temp) = runtime_with_workspace();
    fs::write(
        temp.join("range.txt"),
        "0123456789abcdefghijklmnopqrstuvwxyz",
    )
    .expect("write range file");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Resolve generic file range.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let manifest = serde_json::json!({
        "id": "manifest-range",
        "entries": [
            {
                "id": "entry-range",
                "kind": "file",
                "resourceRef": temp.join("range.txt").to_string_lossy(),
                "offsetBytes": 10,
                "limitBytes": 6,
                "reason": "explicit file range"
            },
            {
                "id": "entry-out-of-bounds",
                "kind": "file",
                "resourceRef": temp.join("range.txt").to_string_lossy(),
                "offsetBytes": 9999,
                "limitBytes": 6,
                "reason": "invalid range"
            }
        ]
    });
    let events = runtime
        .dispatch(KernelCommand::ResourceResolve {
            request_id: RequestId("req-resource-range".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-generic".to_string())),
            request: ResourceResolveRequest { manifest },
        })
        .expect("resource range resolve succeeds");

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
    let range_item = items
        .iter()
        .find(|item| item.get("manifestEntryId").and_then(Value::as_str) == Some("entry-range"))
        .expect("range item");
    assert_eq!(
        range_item.get("content").and_then(Value::as_str),
        Some("abcdef")
    );
    assert_eq!(
        range_item.get("offsetBytes").and_then(Value::as_u64),
        Some(10)
    );
    assert_eq!(
        range_item.get("returnedBytes").and_then(Value::as_u64),
        Some(6)
    );
    assert_eq!(
        range_item.get("rangeComplete").and_then(Value::as_bool),
        Some(false)
    );

    let invalid_item = items
        .iter()
        .find(|item| {
            item.get("manifestEntryId").and_then(Value::as_str) == Some("entry-out-of-bounds")
        })
        .expect("invalid range item");
    assert_eq!(
        invalid_item.get("status").and_then(Value::as_str),
        Some("error")
    );
    assert_eq!(
        invalid_item.get("reason").and_then(Value::as_str),
        Some("range_out_of_bounds")
    );
}

#[test]
fn action_batch_submit_executes_minimal_workspace_write() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Create a generic file.".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: None,
                workspace_hash: None,
                open_path: Some(temp.to_string_lossy().to_string()),
                active_folder_id: None,
                folder_hash: None,
            }),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [
                    {
                        "id": "block-generic",
                        "path": "generated/output.txt",
                        "content": "generic generated content\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Create a generic file.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "workspace.write",
                            "kind": "write",
                            "resourceScope": ["generated/output.txt"],
                            "sourceBlockId": "block-generic"
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::ActionBatchAccepted { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitQueued { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitStarted { .. })));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.write"
        )
    }));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. })));
    assert_eq!(
        fs::read_to_string(temp.join("generated").join("output.txt")).expect("written file"),
        "generic generated content\n"
    );
}

#[test]
fn action_batch_submit_prefers_single_directory_attachment_for_relative_write() {
    let (mut runtime, workspace_root) = runtime_with_workspace();
    let attached_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-attachment-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&attached_root);
    fs::create_dir_all(&attached_root).expect("create attached root");

    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Create a generic file under the explicit project directory.".to_string(),
                attachments: vec![serde_json::json!({
                    "kind": "directory",
                    "path": "project-root",
                    "absolutePath": attached_root.to_string_lossy(),
                    "source": "userSelected",
                    "scope": "message"
                })],
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: None,
                workspace_hash: None,
                open_path: Some(workspace_root.to_string_lossy().to_string()),
                active_folder_id: None,
                folder_hash: None,
            }),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [
                    {
                        "id": "block-generic",
                        "path": "generated/output.txt",
                        "content": "attached root content\n"
                    },
                    {
                        "id": "block-prefixed",
                        "path": "project-root/prefixed.txt",
                        "content": "prefixed path content\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Create a generic file under the explicit project directory.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "workspace.write",
                            "kind": "write",
                            "resourceScope": ["generated/output.txt"],
                            "sourceBlockId": "block-generic"
                        },
                        {
                            "id": "write-prefixed",
                            "title": "Write prefixed generic file",
                            "capability": "workspace.write",
                            "kind": "write",
                            "resourceScope": ["project-root/prefixed.txt"],
                            "sourceBlockId": "block-prefixed"
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.write"
        )
    }));
    assert_eq!(
        fs::read_to_string(attached_root.join("generated").join("output.txt"))
            .expect("file written under attached root"),
        "attached root content\n"
    );
    assert_eq!(
        fs::read_to_string(attached_root.join("prefixed.txt"))
            .expect("prefixed file written under attached root"),
        "prefixed path content\n"
    );
    assert!(
        !workspace_root.join("generated").join("output.txt").exists(),
        "relative writes with one explicit directory attachment must not fall back to the editor workspace root"
    );
    assert!(
        !attached_root.join("project-root").join("prefixed.txt").exists(),
        "paths prefixed with the attachment display path must be normalized under the attachment root"
    );
}

#[test]
fn action_batch_submit_executes_git_status_as_read_only() {
    let (mut runtime, temp) = runtime_with_workspace();
    let init_output = std::process::Command::new("git")
        .args(["init"])
        .current_dir(&temp)
        .output()
        .expect("start git init");
    assert!(
        init_output.status.success(),
        "git init failed: {}",
        String::from_utf8_lossy(&init_output.stderr)
    );

    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Inspect generic version control state.".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: None,
                workspace_hash: None,
                open_path: Some(temp.to_string_lossy().to_string()),
                active_folder_id: None,
                folder_hash: None,
            }),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Inspect generic version control state.",
                    "actions": [
                        {
                            "id": "git-status-generic",
                            "title": "Read generic git status",
                            "capability": "git.read",
                            "resourceScope": ["workspace"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "git.status"
        )
    }));
    assert!(!events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::PermissionRequested { request, .. } if request.capability == "git.read"
        )
    }));
}

#[test]
fn action_batch_submit_requests_permission_for_git_push() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Publish a generic version control update.".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(WorkspaceBinding {
                workspace_id: None,
                workspace_hash: None,
                open_path: Some(temp.to_string_lossy().to_string()),
                active_folder_id: None,
                folder_hash: None,
            }),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Publish a generic version control update.",
                    "actions": [
                        {
                            "id": "git-push-generic",
                            "title": "Push generic git update",
                            "capability": "git.push",
                            "kind": "push",
                            "resourceScope": ["workspace"],
                            "toolArgs": {
                                "remote": "origin",
                                "branch": "main"
                            }
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::PermissionRequested { request, .. } if request.capability == "git.push"
        )
    }));
    assert!(!events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted { tool_name, .. } if tool_name == "git.push"
        )
    }));
}

#[test]
fn action_batch_submit_blocks_unsupported_capability() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Propose a generic unsupported action.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Try unsupported action.",
                    "actions": [
                        {
                            "id": "exec-generic",
                            "title": "Run generic command",
                            "capability": "process.exec",
                            "kind": "command",
                            "resourceScope": ["workspace"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitBlocked { .. })));
    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::ToolCompleted { .. })));
}
