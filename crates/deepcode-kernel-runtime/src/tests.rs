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

fn grant_workspace_write(runtime: &mut DeepCodeKernelRuntime) {
    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant-workspace-write".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-workspace-write".to_string(),
                capability: "fs.write".to_string(),
                resource_kind: "workspace".to_string(),
                resource_path: None,
                expires_after_sequence: None,
                reason: Some("test grants explicit workspace write permission".to_string()),
            },
        })
        .expect("temporary fs.write grant succeeds");
}

fn grant_workspace_patch(runtime: &mut DeepCodeKernelRuntime) {
    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant-workspace-patch".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-workspace-patch".to_string(),
                capability: "fs.patch".to_string(),
                resource_kind: "workspace".to_string(),
                resource_path: None,
                expires_after_sequence: None,
                reason: Some("test grants explicit workspace patch permission".to_string()),
            },
        })
        .expect("temporary fs.patch grant succeeds");
}

fn grant_workspace_delete(runtime: &mut DeepCodeKernelRuntime) {
    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant-workspace-delete".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-workspace-delete".to_string(),
                capability: "fs.delete".to_string(),
                resource_kind: "workspace".to_string(),
                resource_path: None,
                expires_after_sequence: None,
                reason: Some("test grants explicit workspace delete permission".to_string()),
            },
        })
        .expect("temporary fs.delete grant succeeds");
}

fn grant_workspace_delete_path(runtime: &mut DeepCodeKernelRuntime, resource_path: &str) {
    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId(format!("req-grant-workspace-delete-{resource_path}")),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: format!("grant-workspace-delete-{resource_path}"),
                capability: "fs.delete".to_string(),
                resource_kind: "workspace".to_string(),
                resource_path: Some(resource_path.to_string()),
                expires_after_sequence: None,
                reason: Some("test grants path-scoped workspace delete permission".to_string()),
            },
        })
        .expect("temporary path-scoped fs.delete grant succeeds");
}

fn grant_external_delete_path(runtime: &mut DeepCodeKernelRuntime, resource_path: &Path) {
    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant-external-delete".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-external-delete".to_string(),
                capability: "fs.delete".to_string(),
                resource_kind: "externalFile".to_string(),
                resource_path: Some(resource_path.to_string_lossy().to_string()),
                expires_after_sequence: None,
                reason: Some("test grants path-scoped external delete permission".to_string()),
            },
        })
        .expect("temporary path-scoped external fs.delete grant succeeds");
}

fn compiled_tool_value(events: &[KernelEvent], action_id: &str, field: &str) -> Option<String> {
    events.iter().find_map(|event| match event {
        KernelEvent::WorkUnitQueued { work_unit, .. }
            if work_unit.get("actionId").and_then(Value::as_str) == Some(action_id) =>
        {
            work_unit
                .get("compiledTool")
                .and_then(|value| value.get(field))
                .and_then(Value::as_str)
                .map(str::to_string)
        }
        _ => None,
    })
}

fn queued_work_unit_value(events: &[KernelEvent], action_id: &str, field: &str) -> Option<Value> {
    events.iter().find_map(|event| match event {
        KernelEvent::WorkUnitQueued { work_unit, .. }
            if work_unit.get("actionId").and_then(Value::as_str) == Some(action_id) =>
        {
            work_unit.get(field).cloned()
        }
        _ => None,
    })
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
fn draft_ledger_submit_records_open_and_chunk_without_workspace_write() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create-draft".to_string()),
            session_id: Some(SessionId("session-draft".to_string())),
            input: UserInput {
                text: "Prepare a generic draft.".to_string(),
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

    let events = runtime
        .dispatch(KernelCommand::DraftLedgerSubmit {
            request_id: RequestId("req-draft-submit".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-draft".to_string())),
            frame: serde_json::json!({
                "schemaVersion": "deepcode.agent.stream.part.v1",
                "partKind": "codeBlockChunk",
                "draftId": "draft-generic",
                "targetPath": "src/generated.txt",
                "chunk": "generic draft content\n"
            }),
        })
        .expect("draft ledger submit succeeds");

    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::DraftOpen { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::DraftChunk { .. })));
    assert!(
        !temp.join("src").join("generated.txt").exists(),
        "draft ledger chunks must not directly write workspace files"
    );
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
fn proposal_submit_plan_review_extracts_code_block_file_targets() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Review a generic file update.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("req-proposal-file-targets".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v3".to_string(),
                proposal_id: "proposal-file-targets".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                source: deepcode_kernel_abi::ProposalEnvelopeSource::Llm,
                kind: deepcode_kernel_abi::ProposalEnvelopeKind::ActionBundle,
                payload: serde_json::json!({
                    "codeBlocks": [
                        {
                            "id": "code-generic-output",
                            "targetPath": "generic-output.txt",
                            "content": "generic output\n"
                        }
                    ],
                    "actionBundle": {
                        "id": "bundle-file-targets",
                        "goal": "Write a generic output file.",
                        "actions": [
                            {
                                "actionId": "write-generic-output",
                                "description": "Write generic output",
                                "kind": "write",
                                "capability": "fs.write",
                                "resourceScope": [],
                                "sourceBlockId": "code-generic-output"
                            }
                        ],
                        "validationExpectations": [
                            { "id": "validation-generic", "description": "Kernel records file write facts." }
                        ],
                        "reviewExpectations": []
                    }
                }),
                referenced_resource_packet_refs: vec![],
                referenced_evidence_refs: vec![],
                parser_diagnostics: None,
            },
        })
        .expect("actionBundle proposal command succeeds");

    let report = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ProposalReviewed { report, .. } => Some(report),
            _ => None,
        })
        .expect("proposal reviewed report is emitted");
    let required_file_operations = report
        .get("requiredFileOperations")
        .and_then(Value::as_array)
        .expect("required file operations are present");
    assert!(required_file_operations.iter().any(|operation| {
        operation.get("operation").and_then(Value::as_str) == Some("write")
            && operation.get("capability").and_then(Value::as_str) == Some("fs.write")
            && operation.get("targetPath").and_then(Value::as_str) == Some("generic-output.txt")
    }));
}

#[test]
fn proposal_submit_plan_review_accepts_matching_action_id_alias() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Review a generic delete action.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("req-proposal-matching-action-id".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v3".to_string(),
                proposal_id: "proposal-matching-action-id".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                source: deepcode_kernel_abi::ProposalEnvelopeSource::Llm,
                kind: deepcode_kernel_abi::ProposalEnvelopeKind::ActionBundle,
                payload: serde_json::json!({
                    "actionBundle": {
                        "id": "bundle-matching-action-id",
                        "goal": "Delete a generic target.",
                        "actions": [
                            {
                                "id": "delete-generic-target",
                                "actionId": "delete-generic-target",
                                "title": "Delete generic target",
                                "description": "Delete generic target",
                                "kind": "delete",
                                "capability": "fs.delete",
                                "resourceScope": ["generic-target.tmp"],
                                "targetPath": "generic-target.tmp"
                            }
                        ],
                        "validationExpectations": [
                            { "id": "validation-generic", "description": "Kernel records file delete facts." }
                        ],
                        "reviewExpectations": []
                    }
                }),
                referenced_resource_packet_refs: vec![],
                referenced_evidence_refs: vec![],
                parser_diagnostics: None,
            },
        })
        .expect("actionBundle proposal command succeeds");

    let report = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ProposalReviewed { report, .. } => Some(report),
            _ => None,
        })
        .expect("proposal reviewed report is emitted");
    assert_ne!(report.get("status").and_then(Value::as_str), Some("denied"));
    assert!(report
        .get("requiredFileOperations")
        .and_then(Value::as_array)
        .is_some_and(|operations| !operations.is_empty()));
}

#[test]
fn proposal_submit_plan_review_accepts_continuation_action_aliases() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Review a generic bundle with continuation actions.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("req-proposal-continuation-alias".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v3".to_string(),
                proposal_id: "proposal-continuation-alias".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                source: deepcode_kernel_abi::ProposalEnvelopeSource::Llm,
                kind: deepcode_kernel_abi::ProposalEnvelopeKind::ActionBundle,
                payload: serde_json::json!({
                    "actionBundle": {
                        "id": "bundle-continuation-alias",
                        "goal": "Review generic continuation field compatibility.",
                        "actions": [
                            {
                                "id": "write-generic-target",
                                "title": "Write generic target",
                                "kind": "write",
                                "capability": "fs.write",
                                "resourceScope": ["generic-output.txt"],
                                "targetPath": "generic-output.txt"
                            }
                        ],
                        "continuationExpectations": [
                            {
                                "actionId": "write-generic-follow-up",
                                "description": "Write generic follow-up",
                                "kind": "write",
                                "capability": "fs.write",
                                "resourceScope": ["generic-follow-up.txt"],
                                "targetPath": "generic-follow-up.txt"
                            }
                        ],
                        "validationExpectations": [
                            { "id": "validation-generic", "description": "Kernel records file facts." }
                        ],
                        "reviewExpectations": []
                    }
                }),
                referenced_resource_packet_refs: vec![],
                referenced_evidence_refs: vec![],
                parser_diagnostics: None,
            },
        })
        .expect("actionBundle proposal command succeeds");

    let report = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ProposalReviewed { report, .. } => Some(report),
            _ => None,
        })
        .expect("proposal reviewed report is emitted");
    assert_ne!(report.get("status").and_then(Value::as_str), Some("denied"));
}

#[test]
fn proposal_submit_plan_review_rejects_conflicting_action_id_alias() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Review a generic action conflict.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("req-proposal-conflicting-action-id".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v3".to_string(),
                proposal_id: "proposal-conflicting-action-id".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                source: deepcode_kernel_abi::ProposalEnvelopeSource::Llm,
                kind: deepcode_kernel_abi::ProposalEnvelopeKind::ActionBundle,
                payload: serde_json::json!({
                    "actionBundle": {
                        "id": "bundle-conflicting-action-id",
                        "goal": "Review a conflicting action.",
                        "actions": [
                            {
                                "id": "action-a",
                                "actionId": "action-b",
                                "title": "Conflicting generic action",
                                "description": "Conflicting generic action",
                                "capability": "fs.write",
                                "resourceScope": ["generic-output.txt"],
                                "targetPath": "generic-output.txt"
                            }
                        ],
                        "validationExpectations": [
                            { "id": "validation-generic", "description": "Kernel records file facts." }
                        ],
                        "reviewExpectations": []
                    }
                }),
                referenced_resource_packet_refs: vec![],
                referenced_evidence_refs: vec![],
                parser_diagnostics: None,
            },
        })
        .expect("actionBundle proposal command succeeds");

    let report = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ProposalReviewed { report, .. } => Some(report),
            _ => None,
        })
        .expect("proposal reviewed report is emitted");
    assert_eq!(report.get("status").and_then(Value::as_str), Some("denied"));
    assert!(report
        .get("deniedReasons")
        .and_then(Value::as_array)
        .is_some_and(|reasons| reasons.iter().any(|reason| {
            reason
                .as_str()
                .is_some_and(|text| text.contains("id/actionId conflict"))
        })));
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
fn resource_resolve_returns_search_results_manifest_entries() {
    let (mut runtime, temp) = runtime_with_workspace();
    fs::write(
        temp.join("nested").join("searchable.txt"),
        "before\nneedle generic anchor\nafter\n",
    )
    .expect("write searchable file");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create-search".to_string()),
            session_id: Some(SessionId("session-generic-search".to_string())),
            input: UserInput {
                text: "Resolve generic search evidence.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let manifest = serde_json::json!({
        "id": "manifest-search",
        "entries": [
            {
                "id": "entry-search",
                "kind": "search",
                "resourceRef": temp.to_string_lossy(),
                "query": "needle generic anchor",
                "include": ["nested/"],
                "contextLines": 1,
                "maxResults": 5,
                "reason": "generic search"
            }
        ]
    });
    let events = runtime
        .dispatch(KernelCommand::ResourceResolve {
            request_id: RequestId("req-resource-search".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-generic-search".to_string())),
            request: ResourceResolveRequest { manifest },
        })
        .expect("resource search resolve succeeds");

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
    let search_item = items
        .iter()
        .find(|item| item.get("manifestEntryId").and_then(Value::as_str) == Some("entry-search"))
        .expect("search item");
    assert_eq!(
        search_item.get("contentKind").and_then(Value::as_str),
        Some("searchResults")
    );
    assert_eq!(
        search_item.get("returnedMatches").and_then(Value::as_u64),
        Some(1)
    );
    let matches = search_item
        .get("matches")
        .and_then(Value::as_array)
        .expect("matches");
    assert_eq!(
        matches[0].get("path").and_then(Value::as_str),
        Some("nested/searchable.txt")
    );
    assert!(matches[0].get("before").and_then(Value::as_array).is_some());
    assert!(matches[0].get("after").and_then(Value::as_array).is_some());
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
fn artifact_register_records_metadata_only_evidence() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Register a generic subtask artifact.".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    let events = runtime
        .dispatch(KernelCommand::ArtifactRegister {
            request_id: RequestId("req-artifact".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            artifact: serde_json::json!({
                "id": "artifact-generic",
                "kind": "subtaskSummary",
                "summary": "Generic subtask evidence."
            }),
        })
        .expect("artifact register succeeds");

    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ArtifactRegistered {
                evidence_ref,
                artifact,
                ..
            } if evidence_ref == "artifact:artifact-generic"
                && artifact.get("sideEffectPolicy").and_then(Value::as_str) == Some("metadata-only")
        )
    }));
    let resource = runtime
        .state
        .resource_registry
        .get("artifact-generic")
        .expect("artifact resource registered");
    assert_eq!(resource.kind, KernelResourceKind::Artifact);
}

#[test]
fn action_batch_submit_requests_permission_for_workspace_write_without_grant() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Create a generic file after permission.".to_string(),
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
                    "goal": "Create a generic file after permission.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["generated/output.txt"],
                            "sourceBlockId": "block-generic"
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::PermissionRequested { request, .. }
                if request.capability == "fs.write"
        )
    }));
    assert!(!events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ..
            } if tool_name == "fs.write"
        )
    }));
    assert!(!events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::StageChanged { phase, .. } if phase == "review"
        )
    }));
    assert!(
        !temp.join("generated").join("output.txt").exists(),
        "permission-gated write must not touch disk before the user grants permission"
    );
}

#[test]
fn action_batch_permission_accept_executes_pending_workspace_write_and_enters_review() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Create a generic file after permission.".to_string(),
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

    let requested = runtime
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
                    "goal": "Create a generic file after permission.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["generated/output.txt"],
                            "sourceBlockId": "block-generic"
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    let permission_id = requested
        .iter()
        .find_map(|event| match event {
            KernelEvent::PermissionRequested { request, .. } => Some(request.id.clone()),
            _ => None,
        })
        .expect("fs.write permission requested");

    let accepted = runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("req-permission-accept".to_string()),
            permission_id,
            decision: deepcode_kernel_abi::PermissionDecisionKind::Accept,
        })
        .expect("permission accept succeeds");

    assert!(accepted.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.write"
        )
    }));
    assert!(accepted
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. })));
    assert!(accepted.iter().any(|event| {
        matches!(
            event,
            KernelEvent::StageChanged { phase, .. } if phase == "review"
        )
    }));
    assert_eq!(
        fs::read_to_string(temp.join("generated").join("output.txt")).expect("written file"),
        "generic generated content\n"
    );

    let review = runtime
        .dispatch(KernelCommand::ReviewFactsGet {
            request_id: RequestId("req-review-facts".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
        })
        .expect("review facts succeeds");
    let facts = review
        .iter()
        .find_map(|event| match event {
            KernelEvent::ReviewFactsProduced { facts, .. } => Some(facts),
            _ => None,
        })
        .expect("review facts produced");
    assert_eq!(facts["writtenFiles"].as_array().unwrap().len(), 1);
    assert_eq!(facts["completedWorkUnits"].as_array().unwrap().len(), 1);
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

    grant_workspace_write(&mut runtime);

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
                            "capability": "fs.write",
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
fn action_batch_submit_executes_workspace_delete_with_grant() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": ["input.txt"],
                            "targetPath": "input.txt",
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "path").as_deref(),
        Some("input.txt")
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.delete"
        )
    }));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. })));
    assert!(
        !temp.join("input.txt").exists(),
        "fs.delete removes the targeted file"
    );
}

#[test]
fn action_batch_submit_executes_workspace_delete_without_kind_with_grant() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-without-kind".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "resourceScope": ["input.txt"],
                            "targetPath": "input.txt",
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "path").as_deref(),
        Some("input.txt")
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.delete"
        )
    }));
    assert!(
        !temp.join("input.txt").exists(),
        "fs.delete without kind still removes the targeted file"
    );
}

#[test]
fn action_batch_submit_executes_workspace_delete_from_resource_scope_only() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-resource-scope".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": ["input.txt"],
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "path").as_deref(),
        Some("input.txt")
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.delete"
        )
    }));
    assert!(
        !temp.join("input.txt").exists(),
        "fs.delete can derive its path from resourceScope"
    );
}

#[test]
fn action_batch_submit_executes_workspace_delete_from_target_ref() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-target-ref".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "targetRef": {
                                "kind": "workspaceRelative",
                                "path": "input.txt"
                            },
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "path").as_deref(),
        Some("input.txt")
    );
    let target_ref = queued_work_unit_value(&events, "delete-generic", "targetRef")
        .expect("queued work unit exposes targetRef");
    assert_eq!(
        target_ref.get("kind").and_then(Value::as_str),
        Some("workspaceRelative")
    );
    assert_eq!(
        target_ref.get("path").and_then(Value::as_str),
        Some("input.txt")
    );
    assert!(
        !temp.join("input.txt").exists(),
        "fs.delete can derive its path from targetRef"
    );
}

#[test]
fn action_batch_submit_deletes_relative_file_under_dot_directory_attachment() {
    let attached_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-dot-attachment-delete-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&attached_root);
    fs::create_dir_all(&attached_root).expect("create attached root");
    fs::write(attached_root.join("target.txt"), "delete me\n").expect("write target file");
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file from the selected directory.".to_string(),
                attachments: vec![serde_json::json!({
                    "kind": "directory",
                    "path": ".",
                    "absolutePath": attached_root.to_string_lossy(),
                    "source": "userSelected",
                    "scope": "session"
                })],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-dot-attachment".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file from the selected directory.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "targetPath": "target.txt",
                            "resourceScope": ["target.txt"],
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "path").as_deref(),
        Some("target.txt")
    );
    assert!(
        !attached_root.join("target.txt").exists(),
        "fs.delete removes a workspace-relative file under the selected directory attachment"
    );
}

#[test]
fn action_batch_compile_error_does_not_start_work_unit() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete an invalid generic path.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-root".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-invalid-delete",
                "actionBundle": {
                    "id": "bundle-invalid-delete",
                    "goal": "Delete an invalid generic path.",
                    "actions": [
                        {
                            "id": "delete-invalid-root",
                            "title": "Delete invalid root",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "targetRef": {
                                "kind": "absolutePath",
                                "path": "/"
                            },
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch returns compile failure event");

    let compile_error = queued_work_unit_value(&events, "delete-invalid-root", "compileError")
        .expect("queued work unit exposes compileError");
    assert_eq!(
        compile_error.get("code").and_then(Value::as_str),
        Some("invalid_command")
    );
    assert!(!events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::WorkUnitStarted { work_unit_id, .. }
                if work_unit_id == "work-unit-plan-invalid-delete-delete-invalid-root"
        )
    }));
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::WorkUnitFailed { work_unit_id, .. }
                if work_unit_id == "work-unit-plan-invalid-delete-delete-invalid-root"
        )
    }));
}

#[test]
fn action_batch_submit_executes_external_absolute_delete_with_scoped_grant() {
    let (mut runtime, workspace_root) = runtime_with_workspace();
    let external_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-external-delete-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&external_root);
    fs::create_dir_all(&external_root).expect("create external root");
    let external_file = external_root.join("delete-target.txt");
    fs::write(&external_file, "delete me\n").expect("write external file");

    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete an explicitly reviewed outside file.".to_string(),
                attachments: vec![],
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

    grant_external_delete_path(&mut runtime, &external_file);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-external".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-external-delete",
                "actionBundle": {
                    "id": "bundle-external-delete",
                    "goal": "Delete an explicitly reviewed outside file.",
                    "actions": [
                        {
                            "id": "delete-external",
                            "title": "Delete external file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "targetPath": external_file.to_string_lossy(),
                            "resourceScope": [external_file.to_string_lossy()],
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("external delete action batch succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-external", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-external", "path").as_deref(),
        Some("delete-target.txt")
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.delete"
        )
    }));
    assert!(
        !external_file.exists(),
        "external absolute fs.delete removes only the reviewed file"
    );
    assert_eq!(
        runtime
            .state
            .current_workspace
            .as_ref()
            .map(|workspace| workspace.root.clone()),
        Some(
            workspace_root
                .canonicalize()
                .unwrap_or_else(|_| workspace_root.clone())
        ),
        "external file execution must not replace the current workspace root"
    );
    let _ = fs::remove_dir_all(workspace_root);
    let _ = fs::remove_dir_all(external_root);
}

#[test]
fn action_batch_submit_executes_workspace_delete_when_target_path_is_empty() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-empty-target".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "targetPath": "",
                            "resourceScope": ["input.txt"],
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete succeeds");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "path").as_deref(),
        Some("input.txt")
    );
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::WorkUnitQueued { work_unit, .. }
                if work_unit.get("deleteSet").and_then(Value::as_array).map(|items| {
                    items.iter().filter_map(Value::as_str).collect::<Vec<_>>()
                }) == Some(vec!["input.txt"])
        )
    }));
    assert!(
        !temp.join("input.txt").exists(),
        "fs.delete ignores an empty targetPath and derives its path from resourceScope/writeSet"
    );
}

#[test]
fn action_batch_submit_mixed_write_and_delete_keep_distinct_fs_tools() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Update one generic file and delete another.".to_string(),
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

    grant_workspace_write(&mut runtime);
    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-mixed-fs".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-mixed-fs",
                "codeBlocks": [
                    {
                        "id": "write-generic-block",
                        "path": "generated/output.txt",
                        "operation": "create",
                        "content": "generic output\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic-mixed-fs",
                    "goal": "Write one generic file and delete another.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "create",
                            "resourceScope": ["generated/output.txt"],
                            "targetPath": "generated/output.txt",
                            "sourceBlockId": "write-generic-block",
                            "permissionLabels": ["fs.write"]
                        },
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": ["input.txt"],
                            "targetPath": "input.txt",
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("mixed action batch succeeds");

    assert_eq!(
        compiled_tool_value(&events, "write-generic", "toolName").as_deref(),
        Some("fs.write")
    );
    assert_eq!(
        compiled_tool_value(&events, "delete-generic", "toolName").as_deref(),
        Some("fs.delete")
    );
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
    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.delete"
        )
    }));
    assert_eq!(
        fs::read_to_string(temp.join("generated").join("output.txt")).expect("written file"),
        "generic output\n"
    );
    assert!(
        !temp.join("input.txt").exists(),
        "mixed batch delete removes the targeted file"
    );
}

#[test]
fn action_batch_submit_workspace_delete_path_grant_does_not_cover_other_files() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a different generic file.".to_string(),
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

    grant_workspace_delete_path(&mut runtime, "input.txt");

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-other".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete-other",
                "actionBundle": {
                    "id": "bundle-generic-delete-other",
                    "goal": "Delete another generic file.",
                    "actions": [
                        {
                            "id": "delete-other-generic",
                            "title": "Delete another generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": ["nested/child.txt"],
                            "targetPath": "nested/child.txt",
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch delete returns permission wait");

    assert!(events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::PermissionRequested { request, .. }
                if request.capability == "fs.delete"
        )
    }));
    assert!(
        temp.join("nested").join("child.txt").exists(),
        "path-scoped fs.delete grant must not delete ungranted files"
    );
}

#[test]
fn action_batch_submit_workspace_delete_requires_target_without_write_error() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic file.".to_string(),
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
            request_id: RequestId("req-action-batch-delete-missing".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic file.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic file",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": [],
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch returns compile failure event");

    let error_message = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::WorkUnitFailed { error, .. } => Some(error.message.as_str()),
            _ => None,
        })
        .expect("work unit failed");
    assert!(
        error_message
            .contains("fs.delete action delete-generic requires targetPath or resourceScope"),
        "missing delete target should be reported as a delete compile error"
    );
    assert!(
        !error_message.contains("fs.write target path is empty"),
        "missing delete target must not be reported as a fs.write path error"
    );
}

#[test]
fn action_batch_submit_workspace_delete_rejects_workspace_root_without_write_error() {
    let (mut runtime, _temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic target.".to_string(),
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
            request_id: RequestId("req-action-batch-delete-root".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete",
                "actionBundle": {
                    "id": "bundle-generic-delete",
                    "goal": "Delete a generic target.",
                    "actions": [
                        {
                            "id": "delete-generic",
                            "title": "Delete generic target",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": ["."],
                            "targetPath": ".",
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch returns compile failure event");

    let error_message = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::WorkUnitFailed { error, .. } => Some(error.message.as_str()),
            _ => None,
        })
        .expect("work unit failed");
    assert!(
        error_message.contains("fs.delete cannot remove workspace root"),
        "root delete target should be rejected as a delete operation"
    );
    assert!(
        !error_message.contains("fs.write target path is empty"),
        "root delete target must not be reported as a fs.write path error"
    );
}

#[test]
fn action_batch_submit_workspace_delete_rejects_directory_without_write_error() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Delete a generic directory.".to_string(),
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

    grant_workspace_delete(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch-delete-directory".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic-delete-directory",
                "actionBundle": {
                    "id": "bundle-generic-delete-directory",
                    "goal": "Delete a generic directory.",
                    "actions": [
                        {
                            "id": "delete-generic-directory",
                            "title": "Delete generic directory",
                            "capability": "fs.delete",
                            "kind": "delete",
                            "resourceScope": ["nested"],
                            "targetPath": "nested",
                            "permissionLabels": ["fs.delete"]
                        }
                    ]
                }
            }),
        })
        .expect("action batch returns delete failure event");

    assert_eq!(
        compiled_tool_value(&events, "delete-generic-directory", "toolName").as_deref(),
        Some("fs.delete")
    );
    let error_message = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::WorkUnitFailed { error, .. } => Some(error.message.as_str()),
            _ => None,
        })
        .expect("work unit failed");
    assert!(
        error_message.contains("fs.delete only accepts files"),
        "directory delete target should be rejected as a delete operation"
    );
    assert!(
        !error_message.contains("fs.write target path is empty"),
        "directory delete target must not be reported as a fs.write path error"
    );
    assert!(
        temp.join("nested").exists(),
        "directory delete is fail-closed"
    );
}

#[test]
fn action_batch_submit_executes_exact_block_patch() {
    let (mut runtime, temp) = runtime_with_workspace();
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Patch a generic file.".to_string(),
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

    grant_workspace_patch(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [
                    {
                        "id": "replacement-generic",
                        "path": "input.txt",
                        "operation": "replaceBlock",
                        "content": "patched generic input\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Patch a generic file.",
                    "actions": [
                        {
                            "id": "patch-generic",
                            "title": "Patch generic file",
                            "capability": "fs.patch",
                            "kind": "replaceBlock",
                            "resourceScope": ["input.txt"],
                            "targetPath": "input.txt",
                            "replacementBlockId": "replacement-generic",
                            "patchSpec": {
                                "match": {
                                    "kind": "exactBlock",
                                    "text": "generic input\n"
                                }
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
            KernelEvent::ToolCompleted {
                tool_name,
                ok: true,
                ..
            } if tool_name == "fs.patch"
        )
    }));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::WorkUnitCompleted { .. })));
    assert_eq!(
        fs::read_to_string(temp.join("input.txt")).expect("patched file"),
        "patched generic input\n"
    );

    let review = runtime
        .dispatch(KernelCommand::ReviewFactsGet {
            request_id: RequestId("req-review-facts".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
        })
        .expect("review facts succeeds");
    let facts = review
        .iter()
        .find_map(|event| match event {
            KernelEvent::ReviewFactsProduced { facts, .. } => Some(facts),
            _ => None,
        })
        .expect("review facts produced");
    assert_eq!(facts["writtenFiles"].as_array().unwrap().len(), 1);
    assert_eq!(facts["patchChangedRanges"].as_array().unwrap().len(), 1);
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
                    "scope": "message",
                    "rootId": "primary-root-generic"
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

    grant_workspace_write(&mut runtime);

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
                    },
                    {
                        "id": "block-root-id",
                        "path": "primary-root-generic/root-id.txt",
                        "content": "root id path content\n"
                    },
                    {
                        "id": "block-manifest-id",
                        "path": "attachment-0-project-root/manifest-id.txt",
                        "content": "manifest id path content\n"
                    },
                    {
                        "id": "block-basename",
                        "path": "project-root/basename.txt",
                        "content": "basename path content\n"
                    },
                    {
                        "id": "block-repeated",
                        "path": "project-root/project-root/repeated.txt",
                        "content": "repeated root path content\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Create a generic file under the explicit project directory.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["generated/output.txt"],
                            "sourceBlockId": "block-generic"
                        },
                        {
                            "id": "write-prefixed",
                            "title": "Write prefixed generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["project-root/prefixed.txt"],
                            "sourceBlockId": "block-prefixed"
                        },
                        {
                            "id": "write-root-id",
                            "title": "Write root id generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["primary-root-generic/root-id.txt"],
                            "sourceBlockId": "block-root-id"
                        },
                        {
                            "id": "write-manifest-id",
                            "title": "Write manifest id generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["attachment-0-project-root/manifest-id.txt"],
                            "sourceBlockId": "block-manifest-id"
                        },
                        {
                            "id": "write-basename",
                            "title": "Write basename generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["project-root/basename.txt"],
                            "sourceBlockId": "block-basename"
                        },
                        {
                            "id": "write-repeated",
                            "title": "Write repeated root generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": ["project-root/project-root/repeated.txt"],
                            "sourceBlockId": "block-repeated"
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
    assert_eq!(
        fs::read_to_string(attached_root.join("root-id.txt"))
            .expect("root id file written under attached root"),
        "root id path content\n"
    );
    assert_eq!(
        fs::read_to_string(attached_root.join("manifest-id.txt"))
            .expect("manifest id file written under attached root"),
        "manifest id path content\n"
    );
    assert_eq!(
        fs::read_to_string(attached_root.join("basename.txt"))
            .expect("basename file written under attached root"),
        "basename path content\n"
    );
    assert_eq!(
        fs::read_to_string(attached_root.join("repeated.txt"))
            .expect("repeated root file written under attached root"),
        "repeated root path content\n"
    );
    assert!(
        !workspace_root.join("generated").join("output.txt").exists(),
        "relative writes with one explicit directory attachment must not fall back to the editor workspace root"
    );
    assert!(
        !attached_root
            .join("project-root")
            .join("prefixed.txt")
            .exists(),
        "paths prefixed with the attachment display path must be normalized under the attachment root"
    );
    assert!(
        !attached_root
            .join("project-root")
            .join("project-root")
            .join("repeated.txt")
            .exists(),
        "duplicate root prefixes must not create repeated directory trees"
    );

    let review = runtime
        .dispatch(KernelCommand::ReviewFactsGet {
            request_id: RequestId("req-review-facts".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
        })
        .expect("review facts succeeds");
    let facts = review
        .iter()
        .find_map(|event| match event {
            KernelEvent::ReviewFactsProduced { facts, .. } => Some(facts),
            _ => None,
        })
        .expect("review facts produced");
    assert_eq!(facts["generatedArtifacts"].as_array().unwrap().len(), 6);
    assert!(facts["pathNormalizationDiagnostics"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["duplicateRootPathDetected"].as_bool() == Some(true)));
}

#[test]
fn action_batch_submit_normalizes_absolute_child_under_attachment_root() {
    let (mut runtime, workspace_root) = runtime_with_workspace();
    let attached_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-attachment-absolute-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&attached_root);
    fs::create_dir_all(&attached_root).expect("create attached root");
    let target = attached_root.join("generated").join("absolute-output.txt");

    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Create a generic file under an explicit project directory.".to_string(),
                attachments: vec![serde_json::json!({
                    "kind": "directory",
                    "path": "project-root",
                    "absolutePath": attached_root.to_string_lossy(),
                    "source": "userSelected",
                    "scope": "message",
                    "rootId": "primary-root-generic"
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

    grant_workspace_write(&mut runtime);

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
                        "path": target.to_string_lossy(),
                        "content": "absolute child content\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Create a generic file under an explicit project directory.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": [target.to_string_lossy()],
                            "sourceBlockId": "block-generic"
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
        fs::read_to_string(&target).expect("absolute child written under attached root"),
        "absolute child content\n"
    );
    assert!(
        !workspace_root
            .join("generated")
            .join("absolute-output.txt")
            .exists(),
        "absolute attachment child writes must not fall back to the editor workspace root"
    );
    let tool_output = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ToolCompleted { output, .. } => output.as_ref(),
            _ => None,
        })
        .expect("tool output exists");
    assert_eq!(
        tool_output["pathNormalization"]["normalizedTargetPath"].as_str(),
        Some("generated/absolute-output.txt")
    );
    assert_eq!(
        tool_output["pathNormalization"]["rootSource"].as_str(),
        Some("attachment")
    );
}

#[test]
fn action_batch_submit_rejects_attachment_directory_as_write_target() {
    let (mut runtime, _workspace_root) = runtime_with_workspace();
    let attached_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-attachment-directory-target-{}-{}",
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
                text: "Create a generic file under an explicit project directory.".to_string(),
                attachments: vec![serde_json::json!({
                    "kind": "directory",
                    "path": "project-root",
                    "absolutePath": attached_root.to_string_lossy(),
                    "source": "userSelected",
                    "scope": "message",
                    "rootId": "primary-root-generic"
                })],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    grant_workspace_write(&mut runtime);

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
                        "path": attached_root.to_string_lossy(),
                        "content": "directory target content\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Attempt to write a directory target.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": [attached_root.to_string_lossy()],
                            "sourceBlockId": "block-generic"
                        }
                    ]
                }
            }),
        })
        .expect("action batch returns failed work unit event");

    let error_message = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::WorkUnitFailed { error, .. } => Some(error.message.as_str()),
            _ => None,
        })
        .expect("work unit failed");
    assert!(
        error_message.contains("fs.write target resolves to an attachment directory, not a file"),
        "directory target failure should explain that the target is not a file"
    );
}

#[test]
fn action_batch_submit_absolute_path_disambiguates_multiple_attachment_roots() {
    let (mut runtime, _workspace_root) = runtime_with_workspace();
    let first_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-attachment-first-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let second_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-attachment-second-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&first_root);
    let _ = fs::remove_dir_all(&second_root);
    fs::create_dir_all(&first_root).expect("create first root");
    fs::create_dir_all(&second_root).expect("create second root");
    let target = second_root.join("chosen.txt");

    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Create a generic file under one selected root.".to_string(),
                attachments: vec![
                    serde_json::json!({
                        "kind": "directory",
                        "path": "first-root",
                        "absolutePath": first_root.to_string_lossy(),
                        "source": "userSelected",
                        "scope": "message"
                    }),
                    serde_json::json!({
                        "kind": "directory",
                        "path": "second-root",
                        "absolutePath": second_root.to_string_lossy(),
                        "source": "userSelected",
                        "scope": "message"
                    }),
                ],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    grant_workspace_write(&mut runtime);

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
                        "path": target.to_string_lossy(),
                        "content": "chosen root content\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Create a generic file under one selected root.",
                    "actions": [
                        {
                            "id": "write-generic",
                            "title": "Write generic file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": [target.to_string_lossy()],
                            "sourceBlockId": "block-generic"
                        }
                    ]
                }
            }),
        })
        .expect("action batch succeeds");

    assert_eq!(
        fs::read_to_string(&target).expect("absolute target written under second root"),
        "chosen root content\n"
    );
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
}

#[test]
fn action_batch_submit_file_attachment_allows_only_the_attached_file() {
    let (mut runtime, _workspace_root) = runtime_with_workspace();
    let file_root = std::env::temp_dir().join(format!(
        "deepcode-runtime-v3-file-attachment-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&file_root);
    fs::create_dir_all(&file_root).expect("create file root");
    let attached_file = file_root.join("allowed.txt");
    let sibling_file = file_root.join("sibling.txt");
    fs::write(&attached_file, "old\n").expect("seed attached file");

    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("req-run-create".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            input: UserInput {
                text: "Update an attached file.".to_string(),
                attachments: vec![serde_json::json!({
                    "kind": "file",
                    "path": "allowed.txt",
                    "absolutePath": attached_file.to_string_lossy(),
                    "source": "userSelected",
                    "scope": "message"
                })],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .expect("runCreate succeeds");

    grant_workspace_write(&mut runtime);

    let events = runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("req-action-batch".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-generic".to_string())),
            batch: serde_json::json!({
                "planId": "plan-generic",
                "codeBlocks": [
                    {
                        "id": "block-allowed",
                        "path": attached_file.to_string_lossy(),
                        "content": "new\n"
                    },
                    {
                        "id": "block-sibling",
                        "path": sibling_file.to_string_lossy(),
                        "content": "sibling\n"
                    }
                ],
                "actionBundle": {
                    "id": "bundle-generic",
                    "goal": "Update one attached file and reject sibling writes.",
                    "actions": [
                        {
                            "id": "write-allowed",
                            "title": "Write attached file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": [attached_file.to_string_lossy()],
                            "sourceBlockId": "block-allowed"
                        },
                        {
                            "id": "write-sibling",
                            "title": "Write sibling file",
                            "capability": "fs.write",
                            "kind": "write",
                            "resourceScope": [sibling_file.to_string_lossy()],
                            "sourceBlockId": "block-sibling"
                        }
                    ]
                }
            }),
        })
        .expect("action batch returns mixed events");

    assert_eq!(
        fs::read_to_string(&attached_file).expect("attached file updated"),
        "new\n"
    );
    assert!(
        !sibling_file.exists(),
        "sibling file must not be created through a file attachment"
    );
    let failure = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::WorkUnitFailed { error, .. } => Some(error.message.as_str()),
            _ => None,
        })
        .expect("sibling work unit failed");
    assert!(
        failure.contains("outside workspace binding and explicit attachments"),
        "sibling failure should remain a workspace boundary denial"
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
fn action_batch_submit_blocks_git_push_until_phase9_policy() {
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
            KernelEvent::WorkUnitBlocked { reason, .. } if reason.contains("git.push")
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
