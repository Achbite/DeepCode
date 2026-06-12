use super::*;
use deepcode_kernel_abi::{
    AnswerObligationId, AnswerObligationStatus, MessageRole, UserInput, WorkspaceBinding,
};
use deepcode_kernel_workflow::{
    ActionBundleDraft, PlanContract, PlannedAction, ValidationExpectation, WorkflowEvidence,
};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn binding() -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: Some("ws-1".to_string()),
        workspace_hash: Some("hash-1".to_string()),
        open_path: None,
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

fn start_identity_run(runtime: &mut DeepCodeKernelRuntime) {
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "返回你的身份信息".to_string(),
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
    assert!(skill_ids.contains(&"fs.delete"));
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
fn skill_invoke_records_invocation_lifecycle_in_ledger_even_when_adapter_missing() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);
    let events = runtime
        .dispatch(KernelCommand::SkillInvoke {
            request_id: RequestId("req-skill-invoke".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            skill_id: "fs.read".to_string(),
            input: serde_json::json!({ "path": "README.md" }),
        })
        .unwrap();

    assert!(matches!(
        events.first(),
        Some(KernelEvent::SkillResult {
            ok: false,
            skill_id: Some(skill_id),
            ..
        }) if skill_id == "fs.read"
    ));
    let ledger_events = runtime.ledger.list_all().unwrap();
    let event = ledger_events
        .iter()
        .find(|event| event.kind == "skill.invocation_completed")
        .expect("skill invocation ledger event");
    assert_eq!(event.payload["skillId"], "fs.read");
    assert_eq!(event.payload["invocationId"], "req-skill-invoke");
    assert_eq!(event.payload["ok"], false);
    assert_eq!(
        event.payload["attribution"]["source"],
        "KernelCommand::SkillInvoke"
    );
    assert_eq!(event.payload["attribution"]["runId"], "run-1");
    assert_eq!(event.payload["attribution"]["sessionId"], "session-1");
    assert_eq!(
        event.payload["auditProjection"]["redaction"],
        "raw skill output is excluded from audit projection"
    );
    assert!(event.payload["auditProjection"].get("output").is_none());
    let signed = ledger_events
        .iter()
        .find(|event| event.kind == "audit.signed_entry_created")
        .expect("signed audit ledger event");
    assert_eq!(signed.run_id.as_deref(), Some("run-1"));
    assert_eq!(signed.session_id.as_deref(), Some("session-1"));
    assert_eq!(
        signed.payload["signedEntry"]["event_type"],
        "skill.invocation_completed"
    );
    assert_eq!(signed.payload["signedEntry"]["run_id"], "run-1");
    assert!(signed.payload["signedEntry"]["body_redacted"]
        .get("output")
        .is_none());

    let verify_events = runtime
        .dispatch(KernelCommand::AuditVerify {
            request_id: RequestId("req-audit-verify".to_string()),
            scope: serde_json::json!({ "kind": "all" }),
        })
        .unwrap();
    assert!(matches!(
        verify_events.last(),
        Some(KernelEvent::AuditVerifyCompleted { ok: true, .. })
    ));
}

#[test]
fn skill_invoke_without_active_run_fails_closed() {
    let mut runtime = DeepCodeKernelRuntime::new();
    let error = runtime
        .dispatch(KernelCommand::SkillInvoke {
            request_id: RequestId("req-skill-invoke".to_string()),
            run_id: None,
            session_id: None,
            skill_id: "fs.read".to_string(),
            input: serde_json::json!({ "path": "README.md" }),
        })
        .unwrap_err();

    assert!(matches!(error, KernelError::InvalidCommand(_)));
    assert!(runtime
        .ledger
        .list_all()
        .unwrap()
        .iter()
        .all(|event| event.kind != "skill.invocation_completed"));
}

#[test]
fn plan_contract_submit_produces_review_report_without_entering_complete() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);
    let contract = PlanContract::low_risk_direct("plan-review-1", "read workspace");
    let events = runtime
        .dispatch(KernelCommand::PlanContractSubmit {
            request_id: RequestId("req-plan-review".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            contract: serde_json::to_value(contract).unwrap(),
        })
        .unwrap();

    let report = match events.first().unwrap() {
        KernelEvent::PlanReviewReportProduced {
            report,
            run_id,
            session_id,
            ..
        } => {
            assert_eq!(run_id.as_ref().unwrap().0, "run-1");
            assert_eq!(session_id.as_ref().unwrap().0, "session-1");
            report
        }
        other => panic!("expected plan review report, got {other:?}"),
    };
    assert_eq!(report["status"], "autoAccepted");
    assert_eq!(
        report["kernelGeneratedPermissionSummary"],
        "Kernel preflight: status=autoAccepted; capabilities=workspace.read; permissionGaps=none; hardFloor=none."
    );
    assert_eq!(
        runtime.record_by_run("run-1").unwrap().phase,
        WorkflowPhase::Plan
    );
    let ledger_events = runtime.ledger.list_all().unwrap();
    assert!(ledger_events
        .iter()
        .any(|event| event.kind == "plan.review_report_produced"));
    assert!(ledger_events
        .iter()
        .all(|event| event.kind != "tool.requested"));
}

#[test]
fn plan_contract_submit_malformed_contract_returns_denied_report() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);
    let events = runtime
        .dispatch(KernelCommand::PlanContractSubmit {
            request_id: RequestId("req-plan-review".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            contract: serde_json::json!({ "not": "a typed plan" }),
        })
        .unwrap();

    let report = match events.first().unwrap() {
        KernelEvent::PlanReviewReportProduced { report, .. } => report,
        other => panic!("expected plan review report, got {other:?}"),
    };
    assert_eq!(report["status"], "denied");
    assert_eq!(report["planId"], "invalid-contract");
    assert!(report["deniedReasons"][0]
        .as_str()
        .unwrap()
        .contains("structured PlanContract"));
}

#[test]
fn plan_contract_submit_action_bundle_reports_permission_gap() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);
    let bundle = ActionBundleDraft {
        id: "bundle-write".to_string(),
        goal: "write file".to_string(),
        actions: vec![PlannedAction {
            id: "write-1".to_string(),
            title: "write generated file".to_string(),
            capability: "workspace.write".to_string(),
            resource_scope: vec![".".to_string()],
            can_parallelize: false,
            conflict_keys: vec!["out.txt".to_string()],
            purpose: None,
        }],
        validation_expectations: vec![ValidationExpectation {
            id: "check-1".to_string(),
            description: "file exists".to_string(),
            command: None,
        }],
        review_expectations: Vec::new(),
    };
    let events = runtime
        .dispatch(KernelCommand::PlanContractSubmit {
            request_id: RequestId("req-plan-review".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            contract: serde_json::to_value(bundle).unwrap(),
        })
        .unwrap();

    let report = match events.first().unwrap() {
        KernelEvent::PlanReviewReportProduced { report, .. } => report,
        other => panic!("expected plan review report, got {other:?}"),
    };
    assert_eq!(report["status"], "awaitingTemporaryGrant");
    assert_eq!(report["permissionGaps"][0], "workspace.write");
    assert_eq!(
        runtime.record_by_run("run-1").unwrap().phase,
        WorkflowPhase::Plan
    );
}

#[test]
fn audit_verify_detects_tampered_signed_entry() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);
    runtime
        .dispatch(KernelCommand::SkillInvoke {
            request_id: RequestId("req-skill-invoke".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            skill_id: "fs.read".to_string(),
            input: serde_json::json!({ "path": "README.md" }),
        })
        .unwrap();
    let signed_event = runtime
        .ledger
        .list_all()
        .unwrap()
        .into_iter()
        .find(|event| event.kind == "audit.signed_entry_created")
        .expect("signed audit event");
    let mut signed_entry: deepcode_kernel_audit::SignedAuditEntryV1 =
        serde_json::from_value(signed_event.payload["signedEntry"].clone()).unwrap();
    signed_entry.signature = "tampered".to_string();
    runtime
        .ledger
        .append(LedgerEvent {
            id: "evt-tampered-audit".to_string(),
            run_id: Some("run-1".to_string()),
            session_id: Some("session-1".to_string()),
            kind: "audit.signed_entry_created".to_string(),
            sequence: Some(99),
            payload: serde_json::json!({ "signedEntry": signed_entry }),
            created_at: None,
        })
        .unwrap();

    let verify_events = runtime
        .dispatch(KernelCommand::AuditVerify {
            request_id: RequestId("req-audit-verify".to_string()),
            scope: serde_json::json!({ "kind": "all" }),
        })
        .unwrap();
    assert!(matches!(
        verify_events.last(),
        Some(KernelEvent::AuditVerifyCompleted { ok: false, .. })
    ));
}

#[test]
fn brokered_script_dispatch_routes_read_through_workspace_boundary_and_ledger() {
    let workspace = temp_workspace();
    fs::write(workspace.join("README.md"), "DeepCode broker read").unwrap();
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("req-open".to_string()),
            path: workspace.to_string_lossy().to_string(),
        })
        .unwrap();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "broker read".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding_for_root(&workspace)),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    let response = runtime
        .brokered_script_dispatch(
            Some(RunId("run-1".to_string())),
            Some(SessionId("session-1".to_string())),
            deepcode_kernel_skills::BrokeredScriptRequest {
                request_id: "broker-read".to_string(),
                invocation_id: "invoke-broker".to_string(),
                capability: deepcode_kernel_policy::Capability::workspace_read(),
                method: "kernel.fs.read".to_string(),
                arguments: serde_json::json!({ "path": "README.md" }),
            },
            vec![deepcode_kernel_policy::Capability::workspace_read()],
        )
        .unwrap();

    assert!(response.ok);
    assert_eq!(response.output.unwrap()["content"], "DeepCode broker read");
    let ledger_events = runtime.ledger.list_all().unwrap();
    let event = ledger_events
        .iter()
        .find(|event| event.kind == "skill.broker_request_completed")
        .expect("broker request ledger event");
    assert_eq!(event.run_id.as_deref(), Some("run-1"));
    assert_eq!(event.session_id.as_deref(), Some("session-1"));
    assert_eq!(event.payload["method"], "kernel.fs.read");
    assert_eq!(event.payload["auditProjection"]["authorized"], true);
    assert!(event.payload["auditProjection"].get("arguments").is_none());
    assert!(ledger_events
        .iter()
        .any(|event| event.kind == "audit.signed_entry_created"
            && event.payload["signedEntry"]["event_type"] == "skill.broker_request_completed"));
}

#[test]
fn brokered_script_dispatch_rejects_write_without_permission_continuation() {
    let workspace = temp_workspace();
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::WorkspaceOpen {
            request_id: RequestId("req-open".to_string()),
            path: workspace.to_string_lossy().to_string(),
        })
        .unwrap();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "broker write".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(binding_for_root(&workspace)),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    let response = runtime
        .brokered_script_dispatch(
            Some(RunId("run-1".to_string())),
            Some(SessionId("session-1".to_string())),
            deepcode_kernel_skills::BrokeredScriptRequest {
                request_id: "broker-write".to_string(),
                invocation_id: "invoke-broker".to_string(),
                capability: deepcode_kernel_policy::Capability::workspace_write(),
                method: "kernel.fs.write".to_string(),
                arguments: serde_json::json!({ "path": "out.txt", "content": "x" }),
            },
            vec![deepcode_kernel_policy::Capability::workspace_write()],
        )
        .unwrap();

    assert!(!response.ok);
    assert!(response.error.unwrap().contains("permission continuation"));
    assert!(!workspace.join("out.txt").exists());
}

#[test]
fn mcp_stdio_tool_call_completion_writes_signed_audit_entry() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);
    runtime
        .record_mcp_stdio_tool_call_completed(
            Some(RunId("run-1".to_string())),
            Some(SessionId("session-1".to_string())),
            "mcp-invoke-1".to_string(),
            "fixture.mcp.text-tools".to_string(),
            "text.reverse".to_string(),
            true,
            None,
        )
        .unwrap();

    let ledger_events = runtime.ledger.list_all().unwrap();
    assert!(ledger_events
        .iter()
        .any(|event| event.kind == "mcp.stdio_tool_call_completed"));
    let signed = ledger_events
        .iter()
        .find(|event| {
            event.kind == "audit.signed_entry_created"
                && event.payload["signedEntry"]["event_type"] == "mcp.stdio_tool_call_completed"
        })
        .expect("mcp stdio signed audit entry");
    assert_eq!(signed.payload["signedEntry"]["run_id"], "run-1");
    assert_eq!(
        signed.payload["signedEntry"]["body_redacted"]["connectorId"],
        "fixture.mcp.text-tools"
    );
    assert!(signed.payload["signedEntry"]["body_redacted"]
        .get("stdout")
        .is_none());
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
fn llm_response_submit_waits_for_plan_accept_before_execution() {
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
    assert!(!events.iter().any(|event| matches!(
        event,
        KernelEvent::StageChanged { phase, .. } if phase == "check"
    )));
    assert!(!events.iter().any(|event| matches!(
        event,
        KernelEvent::LlmCallRequested { phase, .. } if phase == "check"
    )));
    assert_eq!(
        runtime
            .snapshot(Some("session-1"))
            .workflow_phase
            .as_deref(),
        Some("plan")
    );

    let accepted = runtime
        .dispatch(KernelCommand::PlanAccept {
            request_id: RequestId("req-plan-accept".to_string()),
            run_id: RunId("run-1".to_string()),
            plan_id: "plan-1".to_string(),
        })
        .unwrap();
    assert!(accepted
        .iter()
        .any(|event| matches!(event, KernelEvent::PlanAccepted { .. })));
    assert!(accepted.iter().any(|event| matches!(
        event,
        KernelEvent::StageChanged { phase, .. } if phase == "complete"
    )));
    assert!(accepted.iter().any(|event| matches!(
        event,
        KernelEvent::LlmCallRequested { phase, .. } if phase == "complete"
    )));
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
fn workspace_delete_recursively_removes_directories() {
    let root = temp_workspace();
    fs::create_dir_all(root.join("tmp-dir/nested")).unwrap();
    fs::write(root.join("tmp-dir/nested/file.txt"), "delete me").unwrap();

    let mut runtime = DeepCodeKernelRuntime::new();
    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-open".to_string()),
                path: root.to_string_lossy().to_string(),
            })
            .unwrap(),
    );

    let deleted = workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceDelete {
                request_id: RequestId("req-delete-dir".to_string()),
                folder_id: Some("wf-0".to_string()),
                path: "tmp-dir".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(deleted["kind"], "directory");
    assert!(!root.join("tmp-dir").exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_delete_removes_hidden_files() {
    let root = temp_workspace();
    fs::write(root.join(".DS_Store"), "finder metadata").unwrap();

    let mut runtime = DeepCodeKernelRuntime::new();
    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-open".to_string()),
                path: root.to_string_lossy().to_string(),
            })
            .unwrap(),
    );

    let deleted = workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceDelete {
                request_id: RequestId("req-delete-hidden".to_string()),
                folder_id: Some("wf-0".to_string()),
                path: ".DS_Store".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(deleted["kind"], "file");
    assert_eq!(deleted["path"], ".DS_Store");
    assert!(!root.join(".DS_Store").exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn workspace_delete_rejects_root_and_package_runtime_data() {
    let root = temp_workspace();
    fs::create_dir_all(root.join("bin/macos-arm64/sessions/session-1")).unwrap();
    fs::write(
        root.join("bin/macos-arm64/sessions/session-1/projection.jsonl"),
        "{}\n",
    )
    .unwrap();

    let mut runtime = DeepCodeKernelRuntime::new();
    workspace_output(
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-open".to_string()),
                path: root.to_string_lossy().to_string(),
            })
            .unwrap(),
    );

    let root_error = workspace_error(
        runtime
            .dispatch(KernelCommand::WorkspaceDelete {
                request_id: RequestId("req-delete-root".to_string()),
                folder_id: Some("wf-0".to_string()),
                path: ".".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(root_error, "permission_denied");
    assert!(root.exists());

    let protected_error = workspace_error(
        runtime
            .dispatch(KernelCommand::WorkspaceDelete {
                request_id: RequestId("req-delete-protected".to_string()),
                folder_id: Some("wf-0".to_string()),
                path: "bin/macos-arm64/sessions".to_string(),
            })
            .unwrap(),
    );
    assert_eq!(protected_error, "permission_denied");
    assert!(root
        .join("bin/macos-arm64/sessions/session-1/projection.jsonl")
        .exists());

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

    let ledger = runtime.ledger("run-1").unwrap();
    assert!(ledger.iter().any(|event| event.kind == "plan.accepted"));
    assert!(ledger
        .iter()
        .any(|event| event.kind == "temporaryGrant.created"));
}

#[test]
fn temporary_grant_allows_matching_tool_without_permission_prompt() {
    let root = temp_workspace();
    let workspace_binding = binding_for_root(&root);
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "write granted file".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(workspace_binding.clone()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-write".to_string(),
                capability: "workspace.write".to_string(),
                resource_kind: "workspaceFile".to_string(),
                resource_path: Some("granted.txt".to_string()),
                expires_after_sequence: Some(10),
                reason: Some("plan accepted".to_string()),
            },
        })
        .unwrap();

    let events = runtime
        .dispatch(KernelCommand::ToolInvoke {
            request_id: RequestId("req-write".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            tool_call_id: "tool-write-granted".to_string(),
            tool_name: "fs.write".to_string(),
            arguments: serde_json::json!({
                "path": "granted.txt",
                "content": "granted write"
            }),
            workspace_binding: Some(workspace_binding),
        })
        .unwrap();

    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::PermissionRequested { .. })));
    assert!(events
        .iter()
        .any(|event| matches!(event, KernelEvent::ToolCompleted { ok: true, .. })));
    let write_output = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ToolCompleted {
                tool_name, output, ..
            } if tool_name == "fs.write" => output.as_ref(),
            _ => None,
        })
        .expect("fs.write output");
    assert_eq!(write_output["validation"]["kind"], "readBack");
    assert_eq!(write_output["validation"]["passed"], true);
    assert_eq!(
        write_output["workspaceRoot"].as_str(),
        Some(root.canonicalize().unwrap().to_string_lossy().as_ref())
    );
    let granted_path = root.join("granted.txt");
    assert_eq!(
        write_output["absolutePath"].as_str(),
        Some(
            granted_path
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .as_ref()
        )
    );
    assert_eq!(
        fs::read_to_string(root.join("granted.txt")).unwrap(),
        "granted write"
    );

    let ledger = runtime.ledger("run-1").unwrap();
    assert!(ledger
        .iter()
        .any(|event| event.kind == "temporaryGrant.created"));
    assert!(ledger
        .iter()
        .any(|event| event.kind == "change.operation_recorded"));
    assert!(ledger
        .iter()
        .all(|event| event.kind != "permission.requested"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn temporary_grant_delete_executes_and_validates_missing_file() {
    let root = temp_workspace();
    let workspace_binding = binding_for_root(&root);
    fs::write(root.join("delete-me.txt"), "temporary").unwrap();
    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::RunStart {
            request_id: RequestId("req-run".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "delete granted file".to_string(),
                attachments: vec![],
            },
            workspace_binding: Some(workspace_binding.clone()),
            profile_ref: None,
            workflow_ref: None,
            run_overrides: None,
        })
        .unwrap();

    runtime
        .dispatch(KernelCommand::PermissionGrantTemporary {
            request_id: RequestId("req-grant-delete".to_string()),
            run_id: RunId("run-1".to_string()),
            grant: deepcode_kernel_abi::TemporaryGrantEnvelope {
                id: "grant-delete".to_string(),
                capability: "workspace.delete".to_string(),
                resource_kind: "workspaceFile".to_string(),
                resource_path: Some("delete-me.txt".to_string()),
                expires_after_sequence: Some(10),
                reason: Some("review accepted".to_string()),
            },
        })
        .unwrap();

    let events = runtime
        .dispatch(KernelCommand::ToolInvoke {
            request_id: RequestId("req-delete".to_string()),
            run_id: Some(RunId("run-1".to_string())),
            session_id: Some(SessionId("session-1".to_string())),
            tool_call_id: "tool-delete-granted".to_string(),
            tool_name: "fs.delete".to_string(),
            arguments: serde_json::json!({
                "path": "delete-me.txt",
                "reason": "review accepted"
            }),
            workspace_binding: Some(workspace_binding),
        })
        .unwrap();

    assert!(!events
        .iter()
        .any(|event| matches!(event, KernelEvent::PermissionRequested { .. })));
    let delete_output = events
        .iter()
        .find_map(|event| match event {
            KernelEvent::ToolCompleted {
                tool_name, output, ..
            } if tool_name == "fs.delete" => output.as_ref(),
            _ => None,
        })
        .expect("fs.delete output");
    assert_eq!(delete_output["validation"]["kind"], "deleteVerified");
    assert_eq!(delete_output["validation"]["passed"], true);
    assert_eq!(delete_output["validation"]["exists"], false);
    assert!(!root.join("delete-me.txt").exists());

    fs::remove_dir_all(root).unwrap();
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

    let resolve_error = restored
        .dispatch(KernelCommand::PermissionResolve {
            request_id: RequestId("req-resolve".to_string()),
            permission_id: "tool-write-replay".to_string(),
            decision: deepcode_kernel_abi::PermissionDecisionKind::Accept,
        })
        .unwrap_err();
    assert!(matches!(
        resolve_error,
        KernelError::PendingPermissionUnavailable(_)
    ));
    assert!(resolve_error
        .to_string()
        .contains("permission tool-write-replay has no live pending tool arguments"));
    let ledger = restored.ledger("run-1").unwrap();
    let permission_requested = ledger
        .iter()
        .find(|event| event.kind == "permission.requested")
        .expect("permission request recorded");
    assert!(permission_requested.payload.get("arguments").is_none());
    assert!(permission_requested.payload.get("argumentsRef").is_some());
    assert!(ledger
        .iter()
        .all(|event| event.kind != "change.operation_recorded"));

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
    runtime
        .complete_run_event("run-1", "session-1")
        .expect("complete run");
    assert!(!root.join("_agent_tmp_change.txt").exists());
    assert!(runtime
        .ledger("run-1")
        .unwrap()
        .iter()
        .any(|event| event.kind == "resource.released"));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn kernel_command_gate_rejects_terminal_escape_background_rm_and_redirect() {
    for (command, category) in [
        ("open -a Terminal", "nestedTerminal"),
        ("nohup sleep 60", "backgroundEscape"),
        ("tmux new-session", "terminalReuseEscape"),
        ("rm managed-resource.tmp", "deleteBypass"),
        ("printf hello > managed-output.tmp", "unmanagedRedirect"),
    ] {
        let denial = deny_kernel_shell_command(
            "shell.exec",
            &serde_json::json!({
                "command": command
            }),
        )
        .expect("command denied");
        assert_eq!(denial.category, category);
    }
    assert!(deny_kernel_shell_command(
        "shell.exec",
        &serde_json::json!({
            "command": "printf test"
        })
    )
    .is_none());
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
fn non_final_messages_cannot_satisfy_answer_obligations() {
    let mut runtime = DeepCodeKernelRuntime::new();
    start_identity_run(&mut runtime);

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
    // 验证 plan/check 阶段即便 channel == final，identity 也不能被满足。
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
        output: Some(serde_json::json!({"path": "managed-resource.tmp"})),
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
    let mut state = RunDecisionState::from_user_input("inspect workspace tools");
    state.evidence.push(WorkflowEvidence {
        tool_name: "fs.delete".to_string(),
        tool_call_id: Some("call-1".to_string()),
        status: "ok".to_string(),
        path: Some("managed-resource.tmp".to_string()),
        permission_decision: Some("Accept".to_string()),
        cleanup_status: Some("cleaned".to_string()),
        kernel_event_refs: vec!["evt-1".to_string()],
    });
    let prompt = compile_kernel_phase_instruction("review", &state);
    assert!(prompt.contains("Kernel tool-fact evidence"));
    assert!(prompt.contains("\"fs.delete\""));
    assert!(prompt.contains("\"ok\""));
    assert!(prompt.contains("only fact source"));

    // plan 阶段不应注入 evidence JSON。
    let plan_prompt = compile_kernel_phase_instruction("plan", &state);
    assert!(!plan_prompt.contains("Kernel tool-fact evidence"));
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
                && prompt.contains("fs.diff")
                && prompt.contains("fs.write")
                && prompt.contains("fs.delete")
                && prompt.contains("code.search")
                && prompt.contains("shell.propose")
                && prompt.contains("shell.exec"),
            "phase {phase} prompt must list allowed DeepCode tool names"
        );
        assert!(
            !prompt.contains("fs.delete 是隐藏"),
            "phase {phase} prompt must not describe fs.delete as hidden"
        );
    }
}

#[test]
fn plan_envelope_exposes_tool_catalog_without_callable_tools() {
    let state = RunDecisionState::default();
    let plan = compile_llm_request_envelope("plan", "你是谁？", &state, Some("ctx-1"));
    let catalog = plan["toolCatalog"].as_array().unwrap();
    let callable = plan["tools"].as_array().unwrap();
    let names = catalog
        .iter()
        .filter_map(|tool| tool.get("name").and_then(Value::as_str))
        .collect::<Vec<_>>();
    assert!(names.contains(&"fs.delete"));
    assert!(names.contains(&"fs.diff"));
    assert!(names.contains(&"shell.propose"));
    assert!(callable.is_empty());

    let complete = compile_llm_request_envelope("complete", "执行计划", &state, Some("ctx-2"));
    assert_eq!(
        complete["tools"].as_array().unwrap().len(),
        complete["toolCatalog"].as_array().unwrap().len()
    );
}
