use super::*;
use deepcode_kernel_abi::{
    AnswerObligationId, AnswerObligationStatus, MessageRole, UserInput, WorkflowDecisionReason,
    WorkspaceBinding,
};
use deepcode_kernel_workflow::WorkflowEvidence;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: Some("ws-1".to_string()),
        workspace_hash: Some("hash-1".to_string()),
        open_path: Some("/workspace".to_string()),
        active_folder_id: Some("wf-0".to_string()),
        folder_hash: Some("folder-hash".to_string()),
    }
}

fn temp_workspace() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "deepcode-kernel-runtime-test-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir_all(&path).unwrap();
    path
}

fn binding_for_root(root: &Path) -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: Some("ws-1".to_string()),
        workspace_hash: Some("hash-1".to_string()),
        open_path: Some(root.to_string_lossy().to_string()),
        active_folder_id: Some("wf-0".to_string()),
        folder_hash: Some("folder-hash".to_string()),
    }
}

fn workspace_output(events: Vec<KernelEvent>) -> Value {
    match events.into_iter().next().unwrap() {
        KernelEvent::WorkspaceResult {
            ok: true,
            output: Some(output),
            ..
        } => output,
        other => panic!("expected ok workspace result, got {other:?}"),
    }
}

fn workspace_error(events: Vec<KernelEvent>) -> String {
    match events.into_iter().next().unwrap() {
        KernelEvent::WorkspaceResult {
            ok: false,
            error: Some(error),
            ..
        } => error.code,
        other => panic!("expected workspace error, got {other:?}"),
    }
}

fn start_temp_lifecycle_run(runtime: &mut DeepCodeKernelRuntime) {
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "返回你的身份信息，测试所有功能组件，新建临时文件读写后删除临时文件"
                    .to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();
}

fn observe(
    runtime: &mut DeepCodeKernelRuntime,
    request_id: &str,
    event: KernelEvent,
) -> WorkflowDecision {
    let events = runtime
        .dispatch(KernelCommand::WorkflowObserve {
            request_id: RequestId(request_id.to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            event: Box::new(event),
        })
        .unwrap();
    match events.into_iter().next().unwrap() {
        KernelEvent::WorkflowDecisionMade { decision, .. } => decision,
        other => panic!("expected workflow decision, got {other:?}"),
    }
}

fn active_llm_call(events: &[KernelEvent]) -> (RunId, String) {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            KernelEvent::LlmCallRequested {
                run_id,
                llm_call_id,
                ..
            } => Some((run_id.clone(), llm_call_id.clone())),
            _ => None,
        })
        .unwrap_or_else(|| panic!("expected active llm call in {events:?}"))
}

#[test]
fn health_check_returns_runtime_ready() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let events = runtime
        .dispatch(KernelCommand::HealthCheck {
            request_id: RequestId("req-1".to_string()),
        })
        .unwrap();

    assert!(matches!(
        events.first(),
        Some(KernelEvent::HostStatus {
            status: HostStatus::Ready,
            ..
        })
    ));
}

#[test]
fn skill_discover_returns_model_visible_catalog_only() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let events = runtime
        .dispatch(KernelCommand::SkillDiscover {
            request_id: RequestId("req-skills".to_string()),
        })
        .unwrap();

    let output = match events.into_iter().next().unwrap() {
        KernelEvent::SkillResult {
            ok: true,
            output: Some(output),
            ..
        } => output,
        other => panic!("expected skill result, got {other:?}"),
    };
    let skill_ids = output["skills"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|skill| skill.get("id").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(skill_ids.contains(&"fs.read"));
    assert!(skill_ids.contains(&"fs.write"));
    assert!(!skill_ids.contains(&"fs.delete"));
}

#[test]
fn skill_trust_approve_records_brokered_trust_and_rejects_direct_host() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let events = runtime
        .dispatch(KernelCommand::SkillTrustApprove {
            request_id: RequestId("req-trust".to_string()),
            skill_id: "external.github.search".to_string(),
            decision: serde_json::json!({
                "decision": "accept",
                "trustMode": "brokeredScript",
                "scriptHash": "sha256:abc",
                "approvedCapabilities": ["network.egress"],
                "approvedBy": "user"
            }),
        })
        .unwrap();

    assert!(matches!(
        events.first(),
        Some(KernelEvent::SkillTrustGranted { .. })
    ));
    assert_eq!(runtime.state.skill_trust_records.len(), 1);
    assert_eq!(
        runtime.state.skill_trust_records[0].trust_mode,
        SkillTrustMode::BrokeredScript
    );

    let error = runtime
        .dispatch(KernelCommand::SkillTrustApprove {
            request_id: RequestId("req-direct".to_string()),
            skill_id: "external.direct".to_string(),
            decision: serde_json::json!({
                "decision": "accept",
                "trustMode": "directHostScript"
            }),
        })
        .unwrap_err();
    assert!(matches!(error, KernelError::PermissionDenied(_)));
}

#[test]
fn mcp_risk_acknowledgment_records_understanding_without_permission_grant() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let events = runtime
        .dispatch(KernelCommand::McpRiskAcknowledgmentSubmit {
            request_id: RequestId("req-mcp-risk".to_string()),
            connector_id: "fixture.mcp.text-tools".to_string(),
            binding_id: Some("text.reverse".to_string()),
            acknowledgment: serde_json::json!({
                "decision": "acknowledge",
                "revisionHash": "sha256:fixture",
                "acknowledgedBy": "user",
                "riskLevel": "high"
            }),
        })
        .unwrap();

    let output = match events.into_iter().next().unwrap() {
        KernelEvent::SkillResult {
            ok: true,
            output: Some(output),
            ..
        } => output,
        other => panic!("expected mcp risk acknowledgment skill result, got {other:?}"),
    };
    assert_eq!(runtime.state.mcp_risk_acknowledgments.len(), 1);
    assert_eq!(output["permissionGranted"], false);
    assert!(output["boundary"]
        .as_str()
        .unwrap()
        .contains("does not grant"));
    let ledger_events = runtime.ledger.list_all().unwrap();
    assert!(ledger_events
        .iter()
        .any(|event| event.kind == "mcp.risk_acknowledgment_recorded"));
}

#[test]
fn run_start_without_workspace_binding_fails_closed() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let error = runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: None,
            input: UserInput {
                text: "hello".to_string(),
                attachments: vec![],
            },
            workspace_binding: None,
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap_err();

    assert!(matches!(error, KernelError::MissingWorkspaceBinding));
}

#[test]
fn run_start_creates_headless_skeleton_events_and_ledger() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let events = runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "plan a change".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    assert_eq!(events.len(), 5);
    assert!(matches!(events[0], KernelEvent::RunStarted { .. }));
    assert!(matches!(
        events[1],
        KernelEvent::ConfigSnapshotAttached { .. }
    ));
    assert!(matches!(
        events[2],
        KernelEvent::WorkflowCheckpointed { .. }
    ));
    assert!(matches!(
        events[3],
        KernelEvent::StageChanged {
            status: StageStatus::Running,
            ..
        }
    ));
    assert!(matches!(events[4], KernelEvent::LlmCallRequested { .. }));

    let snapshot = runtime.snapshot(Some("session-1"));
    assert_eq!(snapshot.workflow_phase.as_deref(), Some("plan"));
    assert_eq!(snapshot.events.len(), 5);

    let ledger = runtime.ledger("run-1").unwrap();
    assert_eq!(ledger.len(), 5);
    assert_eq!(ledger[0].kind, "run.started");
    assert_eq!(ledger[4].kind, "llm.call_requested");
}

#[test]
fn run_resume_emits_resume_event_and_snapshot() {
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "plan a change".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    let events = runtime
        .dispatch(KernelCommand::RunResume {
            request_id: RequestId("req-resume".to_string()),
            session_id: SessionId("session-1".to_string()),
        })
        .unwrap();

    assert!(matches!(events[0], KernelEvent::WorkflowResumed { .. }));
    assert!(matches!(events[1], KernelEvent::SnapshotReady { .. }));
    assert_eq!(runtime.ledger("run-1").unwrap().len(), 6);
}

#[test]
fn llm_response_submit_advances_workflow_under_kernel_control() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let started = runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "plan a change".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();
    let (run_id, llm_call_id) = match started.last().unwrap() {
        KernelEvent::LlmCallRequested {
            run_id,
            llm_call_id,
            ..
        } => (run_id.clone(), llm_call_id.clone()),
        other => panic!("expected llm call request, got {other:?}"),
    };

    let events = runtime
        .dispatch(KernelCommand::LlmResponseSubmit {
            request_id: RequestId("req-llm".to_string()),
            run_id,
            session_id: Some(SessionId("session-1".to_string())),
            llm_call_id,
            response_envelope: serde_json::json!({
                "assistantMessage": {
                    "content": "<plan>Use Kernel managed workflow.</plan>",
                    "toolCalls": []
                }
            }),
        })
        .unwrap();

    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::MessageAppended { .. })));
    assert!(events.iter().any(|event| matches!(
        event,
        KernelEvent::StageChanged { phase, .. } if phase == "check"
    )));
    assert!(events.iter().any(|event| matches!(
        event,
        KernelEvent::LlmCallRequested { phase, .. } if phase == "check"
    )));
    assert_eq!(
        runtime
            .snapshot(Some("session-1"))
            .workflow_phase
            .as_deref(),
        Some("check")
    );
}

#[test]
fn workspace_summary_component_request_requires_kernel_tool_evidence() {
    let state = RunDecisionState::from_user_input(
            "读取当前工作区文件并总结输出给我，这是一个测试请求，用于测试agent能否调用各组件正常执行任务，最后返回你的身份信息",
        );

    let decision = state.decide("plan");
    assert_eq!(decision.action, WorkflowDecisionAction::Continue);
    assert_eq!(
        decision.reason,
        WorkflowDecisionReason::PendingCriticalSteps
    );
    assert!(decision
        .pending_steps
        .iter()
        .any(|step| step.contains("list workspace")));
    assert!(decision
        .pending_steps
        .iter()
        .any(|step| step.contains("read at least one workspace file")));
    assert!(decision
        .pending_steps
        .iter()
        .any(|step| step.contains("code.search")));
}

#[test]
fn complete_phase_auto_runs_workspace_summary_tools_before_review() {
    let root = temp_workspace();
    fs::write(root.join("README.md"), "DeepCode workspace summary smoke").unwrap();

    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("req-open".to_string()),
            path: root.to_string_lossy().to_string(),
        })
        .unwrap();

    let started = runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "读取当前工作区文件并总结输出给我，这是一个测试请求，用于测试agent能否调用各组件正常执行任务，最后返回你的身份信息".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(WorkspaceBinding {
                    workspace_id: Some("ws-1".to_string()),
                    workspace_hash: None,
                    open_path: Some(root.to_string_lossy().to_string()),
                    active_folder_id: Some("wf-0".to_string()),
                    folder_hash: None,
                }),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();

    let (run_id, plan_call_id) = active_llm_call(&started);
    let plan_events = runtime
            .dispatch(KernelCommand::LlmResponseSubmit {
                request_id: RequestId("req-plan".to_string()),
                run_id: run_id.clone(),
                session_id: Some(SessionId("session-1".to_string())),
                llm_call_id: plan_call_id,
                response_envelope: serde_json::json!({
                    "assistantMessage": { "content": "<plan>Read workspace and verify components.</plan>", "toolCalls": [] }
                }),
            })
            .unwrap();

    let (_, check_call_id) = active_llm_call(&plan_events);
    let check_events = runtime
            .dispatch(KernelCommand::LlmResponseSubmit {
                request_id: RequestId("req-check".to_string()),
                run_id: run_id.clone(),
                session_id: Some(SessionId("session-1".to_string())),
                llm_call_id: check_call_id,
                response_envelope: serde_json::json!({
                    "assistantMessage": { "content": "<observe>Plan is safe.</observe>", "toolCalls": [] }
                }),
            })
            .unwrap();

    let (_, complete_call_id) = active_llm_call(&check_events);
    let complete_events = runtime
        .dispatch(KernelCommand::LlmResponseSubmit {
            request_id: RequestId("req-complete".to_string()),
            run_id,
            session_id: Some(SessionId("session-1".to_string())),
            llm_call_id: complete_call_id,
            response_envelope: serde_json::json!({
                "assistantMessage": { "content": "<say>开始执行工具验证。</say>", "toolCalls": [] }
            }),
        })
        .unwrap();

    assert!(complete_events.iter().any(|event| matches!(
        event,
        KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "fs.list"
    )));
    assert!(complete_events.iter().any(|event| matches!(
        event,
        KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "fs.read"
    )));
    assert!(complete_events.iter().any(|event| matches!(
        event,
        KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "code.search"
    )));
    assert!(complete_events.iter().any(|event| matches!(
        event,
        KernelEvent::WorkflowDecisionMade { decision, .. }
            if decision.action == WorkflowDecisionAction::Review
    )));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_syscalls_manage_files_under_current_workspace() {
    let root = temp_workspace();
    fs::write(root.join("README.md"), "DeepCode workspace smoke").unwrap();

    let mut runtime = DeepCodeKernelRuntime::new();
    let opened = workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-open".to_string()),
                path: root.to_string_lossy().to_string(),
            })
            .unwrap(),
    );
    assert_eq!(opened["workspace"]["folders"][0]["id"], "wf-0");

    let listed = workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceList {
                request_id: RequestId("req-list".to_string()),
                folder_id: Some("wf-0".to_string()),
                path: Some(".".to_string()),
                depth: Some(1),
            })
            .unwrap(),
    );
    assert!(listed["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|node| node["path"] == "README.md"));

    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceCreate {
                request_id: RequestId("req-create".to_string()),
                folder_id: None,
                path: "_agent_tmp_kernel.txt".to_string(),
                content: Some("kernel created".to_string()),
            })
            .unwrap(),
    );
    let read = workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceRead {
                request_id: RequestId("req-read".to_string()),
                folder_id: None,
                path: "_agent_tmp_kernel.txt".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(read["content"], "kernel created");

    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceWrite {
                request_id: RequestId("req-write".to_string()),
                folder_id: None,
                path: "_agent_tmp_kernel.txt".to_string(),
                content: "needle updated".to_string(),
                create: false,
            })
            .unwrap(),
    );
    let searched = workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceSearch {
                request_id: RequestId("req-search".to_string()),
                folder_id: None,
                query: "needle".to_string(),
                include: None,
                is_regex: false,
            })
            .unwrap(),
    );
    assert_eq!(searched["matches"].as_array().unwrap().len(), 1);

    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceRename {
                request_id: RequestId("req-rename".to_string()),
                folder_id: None,
                old_path: "_agent_tmp_kernel.txt".to_string(),
                new_path: "_agent_tmp_kernel_renamed.txt".to_string(),
            })
            .unwrap(),
    );
    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceDelete {
                request_id: RequestId("req-delete".to_string()),
                folder_id: None,
                path: "_agent_tmp_kernel_renamed.txt".to_string(),
            })
            .unwrap(),
    );
    assert!(!root.join("_agent_tmp_kernel_renamed.txt").exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_syscalls_fail_closed_without_workspace_or_for_unsafe_paths() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let error = workspace_error(
        runtime
            .dispatch(KernelCommand::WorkspaceRead {
                request_id: RequestId("req-read".to_string()),
                folder_id: None,
                path: "README.md".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(error, "workspace_binding_required");

    let root = temp_workspace();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("req-open".to_string()),
            path: root.to_string_lossy().to_string(),
        })
        .unwrap();

    for path in ["/tmp/escape.txt", "../escape.txt"] {
        let error = workspace_error(
            runtime
                .dispatch(KernelCommand::WorkspaceWrite {
                    request_id: RequestId("req-write".to_string()),
                    folder_id: None,
                    path: path.to_string(),
                    content: "blocked".to_string(),
                    create: true,
                })
                .unwrap(),
        );
        assert_eq!(error, "permission_denied");
    }

    let error = workspace_error(
        runtime
            .dispatch(KernelCommand::WorkspaceWrite {
                request_id: RequestId("req-write-config".to_string()),
                folder_id: None,
                path: ".deepcode/prompts/project.md".to_string(),
                content: "blocked".to_string(),
                create: true,
            })
            .unwrap(),
    );
    assert_eq!(error, "permission_denied");

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn plan_and_temporary_grant_commands_are_recorded() {
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "plan a change".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    let accepted = runtime
        .dispatch(KernelCommand::PlanAccept {
            request_id: RequestId("req-plan".to_string()),
            run_id: RunId("run-1".to_string()),
            plan_id: "plan-1".to_string(),
        })
        .unwrap();
    assert!(matches!(accepted[0], KernelEvent::PlanAccepted { .. }));

    let grant = runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-1".to_string(),
                capability: "workspace.write".to_string(),
                resource_kind: "workspaceFile".to_string(),
                resource_path: Some("src/main.rs".to_string()),
                expires_after_sequence: Some(10),
                reason: Some("test grant".to_string()),
            },
        })
        .unwrap();
    assert!(matches!(grant[0], KernelEvent::MessageAppended { .. }));
    assert!(matches!(grant[1], KernelEvent::AutonomyTransitioned { .. }));
    assert_eq!(runtime.ledger("run-1").unwrap().len(), 8);
}

#[test]
fn ndjson_ledger_restores_pending_permission_and_continues_tool() {
    let root = temp_workspace();
    let workspace = root.join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let ledger_path = root.join("events.ndjson");
    let workspace_binding = binding_for_root(&workspace);

    {
        let mut runtime = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-replay".to_string())),
                input: UserInput {
                    text: "create a temp file".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(workspace_binding.clone()),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .unwrap();
        let events = runtime
            .dispatch(KernelCommand::ToolInvoke {
                request_id: RequestId("req-tool".to_string()),
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-replay".to_string())),
                tool_call_id: "tool-write-replay".to_string(),
                tool_name: "fs.write".to_string(),
                arguments: serde_json::json!({
                    "path": "_agent_tmp_replay.txt",
                    "content": "restored write"
                }),
                workspace_binding: Some(workspace_binding),
            })
            .unwrap();
        assert!(events
            .iter()
            .any(|event| matches!(event, KernelEvent::PermissionRequested { .. })));
    }

    let mut restored = DeepCodeKernelRuntime::with_ndjson_ledger(&ledger_path);
    let snapshot = restored.snapshot(Some("session-replay"));
    assert_eq!(
        snapshot.run_id.as_ref().map(|run| run.0.as_str()),
        Some("run-1")
    );
    assert_eq!(
        snapshot
            .pending_permission
            .as_ref()
            .map(|permission| permission.id.as_str()),
        Some("tool-write-replay")
    );

    let resolved = restored
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("req-resolve".to_string()),
            permission_id: "tool-write-replay".to_string(),
            decision: deepcode_kernel_abi::PermissionDecisionKind::Accept,
        })
        .unwrap();
    assert!(resolved.iter().any(|event| matches!(
        event,
        KernelEvent::ToolCompleted { tool_name, ok: true, .. } if tool_name == "fs.write"
    )));
    assert_eq!(
        fs::read_to_string(workspace.join("_agent_tmp_replay.txt")).unwrap(),
        "restored write"
    );
    let ledger = restored.ledger("run-1").unwrap();
    assert!(ledger
        .iter()
        .any(|event| event.kind == "permission.resolved"));
    assert!(ledger
        .iter()
        .any(|event| event.kind == "change.operation_recorded"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn tool_execution_records_changes_validations_and_review_gate_evidence() {
    let root = temp_workspace();
    let workspace_binding = binding_for_root(&root);
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "write a file and run tests".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(workspace_binding.clone()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    runtime
        .dispatch(KernelCommand::ToolInvoke {
            request_id: RequestId("req-write".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            tool_call_id: "tool-write".to_string(),
            tool_name: "fs.write".to_string(),
            arguments: serde_json::json!({
                "path": "_agent_tmp_change.txt",
                "content": "change evidence"
            }),
            workspace_binding: Some(workspace_binding.clone()),
        })
        .unwrap();
    runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("req-write-accept".to_string()),
            permission_id: "tool-write".to_string(),
            decision: deepcode_kernel_abi::PermissionDecisionKind::Accept,
        })
        .unwrap();

    runtime
        .dispatch(KernelCommand::ToolInvoke {
            request_id: RequestId("req-shell".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            tool_call_id: "tool-shell-test".to_string(),
            tool_name: "shell.exec".to_string(),
            arguments: serde_json::json!({
                "command": "printf test",
                "cwd": "."
            }),
            workspace_binding: Some(workspace_binding),
        })
        .unwrap();
    runtime
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("req-shell-accept".to_string()),
            permission_id: "tool-shell-test".to_string(),
            decision: deepcode_kernel_abi::PermissionDecisionKind::Accept,
        })
        .unwrap();

    let ledger = runtime.ledger("run-1").unwrap();
    assert!(ledger
        .iter()
        .any(|event| event.kind == "change.operation_recorded"));
    assert!(ledger
        .iter()
        .any(|event| event.kind == "change_set.recorded"));
    assert!(ledger.iter().any(|event| event.kind == "validation.result"));

    let change_set = runtime.change_set_for_run("run-1").unwrap().unwrap();
    assert_eq!(change_set.touched_files, vec!["_agent_tmp_change.txt"]);
    let validations = runtime.validations_for_run("run-1").unwrap();
    assert!(validations
        .iter()
        .any(|validation| { validation.kind == ValidationKind::Test && validation.passed }));
    let review_result = ReviewGate.evaluate(
        "run-1",
        Some(&change_set),
        &validations,
        runtime.evidence_refs_for_run("run-1").unwrap(),
    );
    assert_eq!(review_result.status, ReviewGateStatus::Accepted);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn run_cancel_remains_fail_closed() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let error = runtime
        .dispatch(KernelCommand::RunCancel {
            request_id: RequestId("req-cancel".to_string()),
            run_id: RunId("run-1".to_string()),
        })
        .unwrap_err();

    assert!(matches!(error, KernelError::NotImplemented("run.cancel")));
}

#[test]
fn workflow_observe_only_listed_temp_lifecycle_continues() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_temp_lifecycle_run(&mut runtime);

    let decision = observe(
        &mut runtime,
        "req-observe-1",
        KernelEvent::ToolCompleted {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            tool_call_id: "tool-list".to_string(),
            tool_name: "fs.list".to_string(),
            ok: true,
            output: Some(serde_json::json!({ "path": "." })),
            error: None,
            sequence: Some(5),
        },
    );

    assert_eq!(decision.action, WorkflowDecisionAction::Continue);
    assert_eq!(
        decision.reason,
        WorkflowDecisionReason::PendingCriticalSteps
    );
    assert!(decision
        .pending_steps
        .iter()
        .any(|step| step.contains("create")));
    assert!(!decision.fail_closed);
}

#[test]
fn workflow_observe_temp_lifecycle_requires_cleanup_before_review() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_temp_lifecycle_run(&mut runtime);

    for (request_id, tool_call_id, tool_name) in [
        ("req-observe-1", "tool-list", "fs.list"),
        ("req-observe-2", "tool-write", "fs.write"),
        ("req-observe-3", "tool-read", "fs.read"),
        ("req-observe-4", "tool-search", "code.search"),
    ] {
        observe(
            &mut runtime,
            request_id,
            KernelEvent::ToolCompleted {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                tool_call_id: tool_call_id.to_string(),
                tool_name: tool_name.to_string(),
                ok: true,
                output: Some(serde_json::json!({ "path": "_agent_tmp_test.txt" })),
                error: None,
                sequence: Some(5),
            },
        );
    }

    let decision = observe(
        &mut runtime,
        "req-observe-4",
        KernelEvent::StageChanged {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            stage_run_id: None,
            phase: "complete".to_string(),
            status: StageStatus::Completed,
            reason: None,
            sequence: Some(8),
        },
    );

    assert_eq!(decision.action, WorkflowDecisionAction::Continue);
    assert!(decision
        .pending_steps
        .iter()
        .any(|step| step.contains("cleanup")));
}

#[test]
fn workflow_observe_temp_lifecycle_cleanup_enters_review_then_done() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_temp_lifecycle_run(&mut runtime);
    observe(
        &mut runtime,
        "req-enter-complete",
        KernelEvent::StageChanged {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            stage_run_id: None,
            phase: "complete".to_string(),
            status: StageStatus::Running,
            reason: None,
            sequence: Some(4),
        },
    );

    for (request_id, tool_call_id, tool_name) in [
        ("req-observe-1", "tool-list", "fs.list"),
        ("req-observe-2", "tool-write", "fs.write"),
        ("req-observe-3", "tool-read", "fs.read"),
        ("req-observe-4", "tool-search", "code.search"),
    ] {
        observe(
            &mut runtime,
            request_id,
            KernelEvent::ToolCompleted {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                tool_call_id: tool_call_id.to_string(),
                tool_name: tool_name.to_string(),
                ok: true,
                output: Some(serde_json::json!({ "path": "_agent_tmp_test.txt" })),
                error: None,
                sequence: Some(5),
            },
        );
    }
    observe(
        &mut runtime,
        "req-observe-5",
        KernelEvent::ToolRequested {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            tool_call_id: "tool-shell".to_string(),
            tool_name: "shell.exec".to_string(),
            args_preview: serde_json::json!({ "command": "rm _agent_tmp_test.txt" }),
            sequence: Some(8),
        },
    );
    let review = observe(
        &mut runtime,
        "req-observe-6",
        KernelEvent::ToolCompleted {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            tool_call_id: "tool-shell".to_string(),
            tool_name: "shell.exec".to_string(),
            ok: true,
            output: Some(serde_json::json!({ "exitCode": 0 })),
            error: None,
            sequence: Some(9),
        },
    );

    assert_eq!(review.action, WorkflowDecisionAction::Review);
    assert_eq!(
        review.reason,
        WorkflowDecisionReason::CompletionCriteriaSatisfied
    );

    let done = observe(
            &mut runtime,
            "req-observe-7",
            KernelEvent::MessageAppended {
                run_id: Some(RunId("run-1".to_string())),
                session_id: Some(SessionId("session-1".to_string())),
                turn_id: None,
                role: MessageRole::Agent,
                channel: Some("final".to_string()),
                content: Some(
                    "我是 DeepCode Agent。fs.read fs.list fs.write shell.exec 均已测试，临时文件已创建、读取并清理删除。"
                        .to_string(),
                ),
                message_key: None,
                args: None,
                sequence: Some(10),
            },
        );

    assert_eq!(done.action, WorkflowDecisionAction::Done);
    assert!(done.pending_steps.is_empty());
}

#[test]
fn non_final_messages_cannot_satisfy_answer_obligations() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_temp_lifecycle_run(&mut runtime);

    let decision = observe(
        &mut runtime,
        "req-non-final",
        KernelEvent::MessageAppended {
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            turn_id: None,
            role: MessageRole::Agent,
            channel: Some("plan".to_string()),
            content: Some(
                "我是 DeepCode Agent。fs.read fs.list fs.write fs.delete 都已经完成。".to_string(),
            ),
            message_key: None,
            args: None,
            sequence: Some(10),
        },
    );

    assert_ne!(decision.action, WorkflowDecisionAction::Done);
    assert!(decision
        .answer_obligations
        .iter()
        .all(|obligation| { obligation.status == AnswerObligationStatus::Pending }));
}

#[test]
fn check_phase_final_message_cannot_satisfy_identity_obligation() {
    // 验证 plan/check 阶段即便 channel == final，identity / tool_summary 也不能被满足。
    // 闭合用户报告的"身份信息在 check 阶段被提前输出"问题。
    let mut state = RunDecisionState::from_user_input("返回你的身份信息");
    state.evidence.clear();
    let event = KernelEvent::MessageAppended {
        run_id: Some(RunId("run-1".to_string())),
        session_id: Some(SessionId("session-1".to_string())),
        turn_id: None,
        role: MessageRole::Agent,
        channel: Some("final".to_string()),
        content: Some("我是 DeepCode Agent。这是 check 阶段的回答。".to_string()),
        message_key: None,
        args: None,
        sequence: Some(1),
    };
    state.apply_event(&event, "check");
    // check 阶段不允许 satisfy。
    assert!(state
        .answer_obligations
        .iter()
        .filter(|obligation| obligation.id == AnswerObligationId::Identity)
        .all(|obligation| obligation.status == AnswerObligationStatus::Pending));

    // review 阶段应允许 satisfy 同样的内容。
    state.apply_event(&event, "review");
    assert!(state
        .answer_obligations
        .iter()
        .filter(|obligation| obligation.id == AnswerObligationId::Identity)
        .all(|obligation| obligation.status == AnswerObligationStatus::Satisfied));
}

#[test]
fn evidence_records_tool_completion_status_and_path() {
    // 验证 ToolCompleted 后 WorkflowEvidence 被累积，包含 toolName/status/path/cleanupStatus。
    // review 阶段据此构造唯一事实源，杜绝 LLM 自行推断"工具不可用"。
    let mut state = RunDecisionState::default();
    let event = KernelEvent::ToolCompleted {
        run_id: Some(RunId("run-1".to_string())),
        session_id: Some(SessionId("session-1".to_string())),
        turn_id: None,
        tool_call_id: "call-1".to_string(),
        tool_name: "fs.delete".to_string(),
        ok: true,
        output: Some(serde_json::json!({"path": "_agent_tmp_test.txt"})),
        error: None,
        sequence: Some(1),
    };
    state.apply_event(&event, "complete");
    assert_eq!(state.evidence.len(), 1);
    let evidence = &state.evidence[0];
    assert_eq!(evidence.tool_name, "fs.delete");
    assert_eq!(evidence.status, "ok");
    assert_eq!(evidence.cleanup_status.as_deref(), Some("cleaned"));
}

#[test]
fn review_phase_prompt_includes_evidence_json() {
    // 验证 compile_kernel_phase_instruction 在 review 阶段把 evidence 注入 prompt。
    // 这是 P0-3 的核心契约：LLM 看到的 prompt 必须包含 Kernel 工具事实。
    let mut state = RunDecisionState::from_user_input("test workspace tools");
    state.evidence.push(WorkflowEvidence {
        tool_name: "fs.delete".to_string(),
        tool_call_id: Some("call-1".to_string()),
        status: "ok".to_string(),
        path: Some("_agent_tmp_test.txt".to_string()),
        permission_decision: Some("Accept".to_string()),
        cleanup_status: Some("cleaned".to_string()),
        kernel_event_refs: vec!["evt-1".to_string()],
    });
    let prompt = compile_kernel_phase_instruction("review", &state);
    assert!(prompt.contains("Kernel 工具事实证据"));
    assert!(prompt.contains("\"fs.delete\""));
    assert!(prompt.contains("\"ok\""));
    assert!(prompt.contains("唯一事实源"));

    // plan 阶段不应注入 evidence JSON。
    let plan_prompt = compile_kernel_phase_instruction("plan", &state);
    assert!(!plan_prompt.contains("Kernel 工具事实证据"));
}

#[test]
fn phase_prompt_forbids_non_deepcode_tool_names() {
    // 验证 prompt 显式禁止 list_dir/write_file/read_file/delete_file/execute_command 等
    // 非 DeepCode 工具名，闭合用户报告的"工具命名混乱"问题。
    let state = RunDecisionState::default();
    for phase in ["plan", "check", "complete", "review"] {
        let prompt = compile_kernel_phase_instruction(phase, &state);
        assert!(
            prompt.contains("list_dir")
                && prompt.contains("write_file")
                && prompt.contains("execute_command"),
            "phase {phase} prompt must explicitly forbid non-DeepCode tool names"
        );
        assert!(
            prompt.contains("fs.list")
                && prompt.contains("fs.read")
                && prompt.contains("fs.write")
                && prompt.contains("fs.delete")
                && prompt.contains("code.search"),
            "phase {phase} prompt must list allowed DeepCode tool names"
        );
    }
}
