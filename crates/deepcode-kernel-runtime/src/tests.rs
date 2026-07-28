use super::*;
use deepcode_kernel_abi::{
    ArtifactDraftBatchMetadata, ArtifactDraftFrameBase, ArtifactDraftLedgerFrame,
    KernelActionBatch, KernelActionProposal, PermissionDecisionKind, ProposalEnvelopeSource,
    ReviewGateDecision, ReviewGateDecisionKind, TaskIntentTask, ARTIFACT_DRAFT_SCHEMA_VERSION,
};
use std::collections::HashMap;
use std::ops::Deref;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

static TEMP_INDEX: AtomicU64 = AtomicU64::new(0);

struct PermissionResolutionFailingLedger {
    inner: InMemoryEventLedger,
    fail_permission_resolution: Arc<AtomicBool>,
}

struct EventKindFailingLedger {
    inner: InMemoryEventLedger,
    fail_kind: String,
    enabled: Arc<AtomicBool>,
}

impl EventLedger for EventKindFailingLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        if self.enabled.load(Ordering::SeqCst) && event.kind == self.fail_kind {
            return Err(KernelError::Other(format!(
                "injected {} persistence failure",
                self.fail_kind
            )));
        }
        self.inner.append(event)
    }

    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        if self.enabled.load(Ordering::SeqCst)
            && events.iter().any(|event| event.kind == self.fail_kind)
        {
            return Err(KernelError::Other(format!(
                "injected {} persistence failure",
                self.fail_kind
            )));
        }
        self.inner.append_batch(events)
    }

    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        self.inner.list_all()
    }

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        self.inner.list_by_run(run_id)
    }

    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        self.inner.list_by_session(session_id)
    }
}

impl EventLedger for PermissionResolutionFailingLedger {
    fn append(&self, event: LedgerEvent) -> KernelResult<()> {
        self.inner.append(event)
    }

    fn append_batch(&self, events: Vec<LedgerEvent>) -> KernelResult<()> {
        if self.fail_permission_resolution.load(Ordering::SeqCst)
            && events
                .iter()
                .any(|event| event.kind == "permission.resolved")
        {
            return Err(KernelError::Other(
                "injected permission resolution persistence failure".to_string(),
            ));
        }
        self.inner.append_batch(events)
    }

    fn list_all(&self) -> KernelResult<Vec<LedgerEvent>> {
        self.inner.list_all()
    }

    fn list_by_run(&self, run_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        self.inner.list_by_run(run_id)
    }

    fn list_by_session(&self, session_id: &str) -> KernelResult<Vec<LedgerEvent>> {
        self.inner.list_by_session(session_id)
    }
}

struct TestWorkspace(PathBuf);

impl Deref for TestWorkspace {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl Drop for TestWorkspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn runtime_with_workspace() -> (DeepCodeKernelRuntime, TestWorkspace) {
    let path = std::env::temp_dir().join(format!(
        "deepcode-runtime-v4-{}-{}",
        std::process::id(),
        TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&path);
    fs::create_dir_all(path.join("nested")).expect("create test workspace");
    fs::write(path.join("input.txt"), "alpha\nbeta\ngamma\n").expect("write input");
    fs::write(path.join("nested/child.txt"), "child\n").expect("write nested input");

    let mut runtime = DeepCodeKernelRuntime::new();
    runtime
        .dispatch(KernelCommand::HostWorkspaceOpen {
            request_id: RequestId("workspace-open".to_string()),
            path: path.to_string_lossy().to_string(),
        })
        .expect("workspace opens");
    runtime
        .dispatch(KernelCommand::RunCreate {
            request_id: RequestId("run-create".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            input: UserInput {
                text: "Execute a generic tool verification batch.".to_string(),
                attachments: Vec::new(),
            },
            workspace_binding: Some(workspace_binding_from_root(&path)),
            profile_ref: None,
            run_overrides: None,
        })
        .expect("run creates");
    (runtime, TestWorkspace(path))
}

fn action_bundle(actions: Value, content_blocks: Value) -> Value {
    serde_json::json!({
        "userPlanMarkdown": "# Plan\n\n## Summary\nExercise canonical Kernel tools.",
        "contentBlocks": content_blocks,
        "actionBundle": {
            "version": "deepcode.agent.protocol.v4",
            "id": "bundle-1",
            "goal": "Exercise canonical Kernel tools.",
            "actions": actions,
            "validationExpectations": [{
                "id": "validation-terminal-facts",
                "description": "Kernel emits terminal tool facts."
            }],
            "reviewExpectations": [{
                "id": "review-terminal-facts",
                "description": "Review facts reflect actual terminal results."
            }]
        }
    })
}

fn submit_proposal_raw(runtime: &mut DeepCodeKernelRuntime, payload: Value) -> Value {
    let events = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("proposal-submit".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v4".to_string(),
                proposal_id: "proposal-1".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                source: ProposalEnvelopeSource::Llm,
                kind: ProposalEnvelopeKind::ActionBundle,
                payload,
                referenced_resource_packet_refs: Vec::new(),
                referenced_evidence_refs: Vec::new(),
                parser_diagnostics: None,
            },
        })
        .expect("proposal submit succeeds");
    events
        .into_iter()
        .find_map(|event| match event {
            KernelEvent::ProposalReviewed { report, .. } => {
                Some(serde_json::to_value(report).expect("serialize typed proposal report"))
            }
            _ => None,
        })
        .expect("proposal review report")
}

fn submit_proposal(runtime: &mut DeepCodeKernelRuntime, mut payload: Value) -> Value {
    if payload
        .get("authorizationContractId")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        return submit_proposal_raw(runtime, payload);
    }
    let suffix = TEMP_INDEX.fetch_add(1, Ordering::SeqCst);
    let snapshot = KernelToolRegistry::default().snapshot();
    let actions = payload["actionBundle"]["actions"]
        .as_array()
        .expect("test action bundle actions");
    let task_ids_by_action = actions
        .iter()
        .enumerate()
        .map(|(index, action)| {
            (
                action["actionId"]
                    .as_str()
                    .expect("test action actionId")
                    .to_string(),
                format!("task-{suffix}-{index}"),
            )
        })
        .collect::<HashMap<_, _>>();
    let tasks = actions
        .iter()
        .enumerate()
        .map(|(index, action)| {
            let tool_id = action["toolId"].as_str().expect("test action toolId");
            let depends_on = action["dependsOn"]
                .as_array()
                .expect("test action dependsOn")
                .iter()
                .map(|dependency| {
                    let action_id = dependency.as_str().expect("test action dependency id");
                    task_ids_by_action
                        .get(action_id)
                        .unwrap_or_else(|| panic!("unknown test action dependency {action_id}"))
                        .clone()
                })
                .collect();
            TaskIntentTask {
                task_id: format!("task-{suffix}-{index}"),
                tool_id: tool_id.to_string(),
                targets: plan_targets_for_action(tool_id, &action["args"]),
                depends_on,
                args: serde_json::json!({}),
            }
        })
        .collect::<Vec<_>>();
    let plan_id = format!("plan-{suffix}");
    let plan_hash = format!("plan-hash-{suffix}");
    let reviewed = runtime
        .dispatch(KernelCommand::PlanAuthorizationSubmit {
            request_id: RequestId(format!("plan-submit-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            intent: TaskIntentEnvelope {
                schema_version: deepcode_kernel_abi::TASK_INTENT_SCHEMA_VERSION.to_string(),
                plan_id: plan_id.clone(),
                plan_hash: plan_hash.clone(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                workspace_binding_hash: None,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                tasks,
            },
        })
        .expect("Kernel compiles test plan authorization");
    let review = reviewed
        .iter()
        .find_map(|event| match event {
            KernelEvent::PlanAuthorizationReviewed { review, .. } => Some(review.clone()),
            _ => None,
        })
        .expect("plan authorization review");
    assert_eq!(review.status, PlanAuthorizationStatus::Confirmable);
    runtime
        .dispatch(KernelCommand::PlanAuthorizationDecisionSubmit {
            request_id: RequestId(format!("plan-accept-{suffix}")),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            decision: PlanAuthorizationDecisionSubmit {
                decision_id: format!("plan-decision-{suffix}"),
                authorization_contract_id: review.authorization_contract.id.clone(),
                plan_id,
                plan_hash,
                contract_hash: review.authorization_contract.contract_hash,
                decision: PlanAuthorizationDecisionKind::Accept,
            },
        })
        .expect("Kernel accepts test plan authorization");
    payload
        .as_object_mut()
        .expect("test proposal payload")
        .insert(
            "authorizationContractId".to_string(),
            Value::String(review.authorization_contract.id),
        );
    submit_proposal_raw(runtime, payload)
}

fn plan_targets_for_action(tool_id: &str, args: &Value) -> Vec<String> {
    let path = args.get("path").and_then(Value::as_str).map(str::to_string);
    match tool_id {
        "fs.rename" => [
            path,
            args.get("destinationPath")
                .and_then(Value::as_str)
                .map(str::to_string),
        ]
        .into_iter()
        .flatten()
        .collect(),
        "fs.glob" | "code.grep" => vec![path.unwrap_or_else(|| ".".to_string())],
        tool if tool.starts_with("fs.") || tool == "document.read" => path.into_iter().collect(),
        "git.status" | "git.diff" => args
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|item| format!("git:{item}"))
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec!["git:workspace".to_string()]),
        "git.stage" | "git.unstage" => args
            .get("paths")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|item| format!("git:{item}"))
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty())
            .unwrap_or_else(|| vec!["git:index".to_string()]),
        "git.commit" | "git.push" => vec!["git:index".to_string()],
        "web.fetch" => args
            .get("url")
            .and_then(Value::as_str)
            .map(|value| vec![format!("network:{value}")])
            .unwrap_or_default(),
        "web.search" => args
            .get("query")
            .and_then(Value::as_str)
            .map(|value| vec![format!("network:{value}")])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn execute_contract(
    runtime: &mut DeepCodeKernelRuntime,
    payload: &Value,
    report: &Value,
) -> Vec<KernelEvent> {
    let batch = KernelActionBatch {
        plan_id: "bundle-1".to_string(),
        contract_id: report["executionContract"]["id"]
            .as_str()
            .expect("execution contract id")
            .to_string(),
        contract_hash: report["executionContract"]["contractHash"]
            .as_str()
            .expect("execution contract hash")
            .to_string(),
        action_bundle: serde_json::from_value(payload["actionBundle"].clone())
            .expect("canonical action bundle"),
        content_blocks: serde_json::from_value(
            payload
                .get("contentBlocks")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new())),
        )
        .expect("canonical content blocks"),
    };
    runtime
        .dispatch(KernelCommand::ActionBatchSubmit {
            request_id: RequestId("batch-submit".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            batch,
        })
        .expect("action batch returns events")
}

fn terminal_tool(events: &[KernelEvent], tool_id: &str, ok: bool) -> bool {
    events.iter().any(|event| {
        matches!(
            event,
            KernelEvent::ToolCompleted { fact, .. }
                if fact.tool_id == tool_id && fact.ok == ok
        )
    })
}

fn artifact_draft_chunk(
    draft_id: &str,
    frame_id: &str,
    sequence: u64,
    lines: &[&str],
    final_chunk: bool,
) -> ArtifactDraftLedgerFrame {
    let content_lines = lines
        .iter()
        .map(|line| (*line).to_string())
        .collect::<Vec<_>>();
    let serialized = serde_json::to_string(&content_lines).expect("serialize draft chunk");
    ArtifactDraftLedgerFrame::ArtifactChunk {
        base: artifact_draft_base(draft_id, frame_id, sequence, test_fnv1a64(&serialized)),
        slot_id: "slot-draft-1".to_string(),
        content_lines,
        final_chunk,
        edit_match: None,
    }
}

fn artifact_draft_chunk_owned(
    draft_id: &str,
    frame_id: &str,
    sequence: u64,
    lines: Vec<String>,
    final_chunk: bool,
) -> ArtifactDraftLedgerFrame {
    let serialized = serde_json::to_string(&lines).expect("serialize draft chunk");
    ArtifactDraftLedgerFrame::ArtifactChunk {
        base: artifact_draft_base(draft_id, frame_id, sequence, test_fnv1a64(&serialized)),
        slot_id: "slot-draft-1".to_string(),
        content_lines: lines,
        final_chunk,
        edit_match: None,
    }
}

fn artifact_draft_done(
    draft_id: &str,
    frame_id: &str,
    sequence: u64,
    summary: &str,
) -> ArtifactDraftLedgerFrame {
    ArtifactDraftLedgerFrame::BatchDone {
        base: artifact_draft_base(draft_id, frame_id, sequence, test_fnv1a64(summary)),
        metadata: ArtifactDraftBatchMetadata {
            summary: summary.to_string(),
        },
    }
}

fn artifact_draft_base(
    draft_id: &str,
    frame_id: &str,
    sequence: u64,
    content_hash: String,
) -> ArtifactDraftFrameBase {
    ArtifactDraftFrameBase {
        schema_version: ARTIFACT_DRAFT_SCHEMA_VERSION.to_string(),
        draft_id: draft_id.to_string(),
        frame_id: frame_id.to_string(),
        run_id: "run-1".to_string(),
        session_id: "session-1".to_string(),
        task_id: "task-draft".to_string(),
        sequence,
        content_hash,
        expected_slot_ids: vec!["slot-draft-1".to_string()],
    }
}

fn submit_artifact_draft(
    runtime: &mut DeepCodeKernelRuntime,
    request_id: &str,
    frame: ArtifactDraftLedgerFrame,
) -> KernelResult<Vec<KernelEvent>> {
    runtime.dispatch(KernelCommand::DraftLedgerSubmit {
        request_id: RequestId(request_id.to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        frame,
    })
}

fn test_fnv1a64(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

mod authorization_tests;
mod draft_tests;
mod execution_tests;
mod tool_tests;
mod v2_grant_tests;
mod v2_invocation_tests;
mod workspace_tests;
