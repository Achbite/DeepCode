use super::*;
use crate::host_run_broker_v2::{
    HostActiveRunRegistrationV2, HostRunSettingsCeilingV2, HostRunWorkspaceKindV2,
};
use crate::llm_transport::{
    llm_stream_response, ProviderStreamDispatchAuthorityV1, ProviderStreamTraceContextV1,
    ResolvedLlmProfile,
};
use crate::provider_trace_v1::{
    ProviderTraceIdentityV1, ProviderTraceMetadataV1, ProviderTracePurposeV1,
    ProviderTraceResponseBoundaryV1, ProviderTraceStoreV1, ProviderTraceTerminalKindV1,
    ProviderTraceTerminalV1,
};
use axum::body::{to_bytes, Body};
use axum::http::{header, Response, StatusCode};
use axum::routing::post;
use axum::Router;
use deepcode_kernel_runtime::executors::{EmptySecretProvider, KernelExecutorConfig};
use deepcode_kernel_runtime::v2::KernelSessionServiceV2;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::net::TcpListener as StdTcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

// Supporting development contracts only. These tests exercise durable
// dispatch/fence behavior and owned-resource cleanup; real Provider CLI/GUI/TUI
// conversations remain the acceptance path.

struct TestRoot {
    path: PathBuf,
    cleaned: bool,
}

impl TestRoot {
    fn new(label: &str) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after Unix epoch")
            .as_nanos();
        let sequence = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "deepcode-provider-dispatch-{label}-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("create test-owned dispatch root");
        let path = fs::canonicalize(path).expect("canonicalize test-owned dispatch root");
        Self {
            path,
            cleaned: false,
        }
    }

    fn cleanup(&mut self) {
        match fs::remove_dir_all(&self.path) {
            Ok(()) => self.cleaned = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => self.cleaned = true,
            Err(error) => panic!(
                "remove test-owned dispatch root {}: {error}",
                self.path.display()
            ),
        }
        assert!(!self.path.exists(), "test-owned dispatch root remains");
    }
}

impl Drop for TestRoot {
    fn drop(&mut self) {
        if !self.cleaned {
            match fs::remove_dir_all(&self.path) {
                Ok(()) => self.cleaned = true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => self.cleaned = true,
                Err(error) if std::thread::panicking() => eprintln!(
                    "failed to remove test-owned dispatch root {} during panic: {error}",
                    self.path.display()
                ),
                Err(error) => panic!(
                    "remove test-owned dispatch root {}: {error}",
                    self.path.display()
                ),
            }
        }
    }
}

fn assert_no_structured_secret_fields(value: &serde_json::Value) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                assert_no_structured_secret_fields(item);
            }
        }
        serde_json::Value::Object(fields) => {
            for (key, nested) in fields {
                let normalized_key = key
                    .bytes()
                    .filter(u8::is_ascii_alphanumeric)
                    .map(|byte| byte.to_ascii_lowercase())
                    .collect::<Vec<_>>();
                assert!(
                    !matches!(
                        normalized_key.as_slice(),
                        b"runcapability"
                            | b"decisioncapability"
                            | b"authorization"
                            | b"cookie"
                            | b"apikey"
                            | b"accesstoken"
                            | b"refreshtoken"
                            | b"bearertoken"
                            | b"clientsecret"
                            | b"password"
                            | b"token"
                    ),
                    "Session persistence contains forbidden structured secret field {key}"
                );
                assert_no_structured_secret_fields(nested);
            }
        }
        serde_json::Value::String(text) => {
            assert!(
                !text
                    .get(..7)
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bearer ")),
                "Session persistence contains a bearer credential value"
            );
        }
        _ => {}
    }
}

struct ControlledProvider {
    base_url: String,
    request_count: Arc<AtomicUsize>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), String>>>,
}

#[derive(Clone, Copy)]
enum ControlledProviderReply {
    Success,
    HttpStatus(u16),
}

impl ControlledProvider {
    fn start_with_reply(reply: ControlledProviderReply) -> Self {
        let request_count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&request_count);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let handler_count = Arc::clone(&handler_count);
                async move {
                    handler_count.fetch_add(1, Ordering::SeqCst);
                    match reply {
                        ControlledProviderReply::Success => Response::builder()
                            .status(StatusCode::OK)
                            .header(header::CONTENT_TYPE, "text/event-stream")
                            .body(Body::from(concat!(
                                "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"controlled reasoning\"}}]}\n\n",
                                "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\n",
                                "data: [DONE]\n\n"
                            )))
                            .expect("build controlled Provider response"),
                        ControlledProviderReply::HttpStatus(status) => Response::builder()
                            .status(StatusCode::from_u16(status).expect("valid test HTTP status"))
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(format!(
                                "{{\"error\":\"controlled HTTP {status}\"}}"
                            )))
                            .expect("build controlled Provider error response"),
                    }
                }
            }),
        );
        let listener =
            StdTcpListener::bind("127.0.0.1:0").expect("bind test-owned Provider listener");
        listener
            .set_nonblocking(true)
            .expect("set test-owned Provider listener nonblocking");
        let address = listener.local_addr().expect("resolve Provider listener");
        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        let task = std::thread::Builder::new()
            .name("deepcode-provider-dispatch-test".to_string())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| format!("build controlled Provider runtime: {error}"))?;
                runtime.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(listener)
                        .map_err(|error| format!("adopt controlled Provider listener: {error}"))?;
                    axum::serve(listener, app)
                        .with_graceful_shutdown(async move {
                            let _ = shutdown_rx.await;
                        })
                        .await
                        .map_err(|error| format!("serve controlled Provider: {error}"))
                })
            })
            .expect("spawn controlled Provider owner thread");
        Self {
            base_url: format!("http://{address}/v1"),
            request_count,
            shutdown: Some(shutdown_tx),
            task: Some(task),
        }
    }

    fn request_count(&self) -> usize {
        self.request_count.load(Ordering::SeqCst)
    }

    fn stop_and_join(&mut self) -> Result<(), String> {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(task) = self.task.take() {
            task.join()
                .map_err(|_| "controlled Provider owner thread panicked".to_string())??;
        }
        Ok(())
    }

    fn close(&mut self) {
        self.stop_and_join()
            .expect("controlled Provider shutdown failed");
    }
}

impl Drop for ControlledProvider {
    fn drop(&mut self) {
        if let Err(error) = self.stop_and_join() {
            if std::thread::panicking() {
                eprintln!("controlled Provider cleanup failed during panic: {error}");
            } else {
                panic!("controlled Provider cleanup failed: {error}");
            }
        }
    }
}

#[derive(Clone, Copy)]
enum DispatchScenario {
    SameAuthorityCheckpoint,
    AuthorityChangingCheckpoint,
    ContextChangingCheckpoint,
    ServerFailure,
    RateLimited,
}

impl DispatchScenario {
    fn label(self) -> &'static str {
        match self {
            Self::SameAuthorityCheckpoint => "same-authority",
            Self::AuthorityChangingCheckpoint => "authority-changing",
            Self::ContextChangingCheckpoint => "context-changing",
            Self::ServerFailure => "server-failure",
            Self::RateLimited => "rate-limited",
        }
    }

    fn provider_reply(self) -> ControlledProviderReply {
        match self {
            Self::ServerFailure => ControlledProviderReply::HttpStatus(503),
            Self::RateLimited => ControlledProviderReply::HttpStatus(429),
            Self::SameAuthorityCheckpoint
            | Self::AuthorityChangingCheckpoint
            | Self::ContextChangingCheckpoint => ControlledProviderReply::Success,
        }
    }
}

fn sha256_literal(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("sha256:{:x}", Sha256::digest(bytes))
}

fn persistence_record(
    session_id: &str,
    run_id: &str,
    record_id: String,
    record_kind: SessionKernelPersistenceRecordKindV3,
    recorded_at: &str,
    data: Value,
) -> SessionKernelPersistenceRecordV3 {
    let mut record = SessionKernelPersistenceRecordV3 {
        schema_version: SESSION_KERNEL_PERSISTENCE_RECORD_V3_SCHEMA.to_string(),
        record_id,
        session_id: session_id.to_string(),
        run_id: run_id.to_string(),
        record_kind,
        recorded_at: recorded_at.to_string(),
        data,
        record_digest: String::new(),
    };
    let value = serde_json::to_value(&record).expect("encode persistence record");
    record.record_digest = canonical_sha256(
        &value_without_field(&value, "recordDigest").expect("remove record digest"),
    )
    .expect("digest persistence record");
    record
}

fn append_record(
    store: &SessionKernelV2Store,
    capability: &RunCapabilityV2,
    session_id: &str,
    run_id: &str,
    record: SessionKernelPersistenceRecordV3,
) -> SessionKernelPersistenceAppendReplyV2 {
    let record_id = record.record_id.clone();
    match store.append(
        session_id,
        run_id,
        capability,
        SessionKernelPersistenceAppendRequestV2 {
            schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA.to_string(),
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
            record,
        },
    ) {
        Ok(reply) => reply,
        Err(error) => panic!("durably append Session Kernel record {record_id}: {error:?}"),
    }
}

fn current_input(
    provider_turn_id: &str,
    run_id: &str,
    control_epoch: u64,
    context_ref: &deepcode_kernel_abi::ToolContextRefV2,
    input: &Value,
) -> Value {
    json!({
        "schemaVersion": "deepcode.session.provider-current-input.v2",
        "providerTurnId": provider_turn_id,
        "runId": run_id,
        "controlEpoch": control_epoch,
        "purpose": "primary",
        "toolContextRef": context_ref,
        "currentInput": input,
        "target": { "kind": "planning" },
        "guidance": [],
    })
}

fn input_data(input_id: &str, unique: u64, recorded_at: &str) -> Value {
    json!({
        "inputId": input_id,
        "opaqueInputRef": format!("opaque-input-{unique}"),
        "text": "dispatch fence contract",
        "attachments": [],
        "recordedAt": recorded_at,
    })
}

fn record_ref(record: &SessionKernelPersistenceRecordV3) -> SessionProviderTurnRecordRefV3 {
    SessionProviderTurnRecordRefV3 {
        record_id: record.record_id.clone(),
        record_digest: record.record_digest.clone(),
    }
}

fn checkpoint(
    revision: u64,
    run_id: &str,
    provider_turn_id: &str,
    control_epoch: u64,
    input_id: &str,
    current_input_digest: &str,
    profile_id: &str,
    profile_revision: &str,
    workspace_binding_digest: &str,
    context_ref: &deepcode_kernel_abi::ToolContextRefV2,
    current_input_ref: &SessionProviderTurnRecordRefV3,
    parent_ref: Option<&SessionProviderTurnRecordRefV3>,
) -> Value {
    json!({
        "schemaVersion": SESSION_KERNEL_CHECKPOINT_V3_SCHEMA,
        "checkpointRevision": revision,
        "savedAt": format!("2026-08-03T00:00:0{revision}Z"),
        "parentRef": parent_ref,
        "commitScope": { "kind": "standalone" },
        "authority": {
            "runId": run_id,
            "workspaceBindingDigest": workspace_binding_digest,
            "controlEpoch": control_epoch,
            "currentInputId": input_id,
            "currentInputRef": current_input_ref,
            "providerProfileId": profile_id,
            "providerProfileRevisionDigest": profile_revision,
            "toolContext": {
                "currentRef": context_ref,
                "refreshRequired": false,
            },
            "previews": {},
            "operationPlanActionBindings": {},
        },
        "cursor": {
            "inputRefs": [current_input_ref],
            "inputHistoryOmittedCount": 0,
            "providerTerminalRefs": [],
            "providerOutcomeHistoryOmittedCount": 0,
            "reviewFactsAfterLedgerSequence": 0,
            "afterLedgerSequence": 0,
            "snapshotHighWater": 0,
        },
        "active": {
            "pendingGuidance": [],
            "providerReservation": {
                "providerTurnId": provider_turn_id,
                "purpose": "primary",
                "target": { "kind": "planning" },
                "controlEpoch": control_epoch,
                "contextRef": context_ref,
                "factProjection": {},
                "status": "active",
                "contextAssembly": {
                    "providerProfile": {
                        "providerProfileId": profile_id,
                        "providerProfileRevisionDigest": profile_revision
                    },
                    "trimming": {
                        "sections": [{
                            "section": "currentInput",
                            "digest": current_input_digest
                        }, {
                            "section": "planDecision",
                            "digest": sha256_literal('7'),
                            "originalCount": 0,
                            "selectedCount": 0,
                            "omittedCount": 0
                        }]
                    }
                },
                "startedAt": format!("2026-08-03T00:00:0{revision}Z")
            },
            "factBarriers": {},
            "publicRequests": {},
            "kernelWakeHint": false,
        },
        "refs": {
            "planActionSettlements": {},
        },
    })
}

fn completed_terminal(
    metadata: &ProviderTraceMetadataV1,
    profile_id: &str,
    provider: &str,
    model: &str,
    response_digest: &str,
) -> SessionProviderTurnTerminalCommitV3 {
    SessionProviderTurnTerminalCommitV3 {
        terminal_kind: SessionProviderTurnTerminalKindV3::Completed,
        reason_code: None,
        response_digest: Some(response_digest.to_string()),
        completion: Some(json!({
            "schemaVersion": SESSION_PROVIDER_COMPLETION_RECEIPT_V1_SCHEMA,
            "nativeCompletion": {
                "providerKind": "openaiCompatible",
                "terminalSignal": "[DONE]",
                "finishReason": "tool_calls",
            },
            "reasoningPresent": true,
            "reasoningTransport": "openaiPlaintext",
            "reasoningDigest": sha256_literal('8'),
            "responseDigest": response_digest,
            "trace": {
                "sealed": true,
                "sealDigest": metadata.seal_digest,
                "terminalDigest": metadata.terminal_digest,
                "recordCount": metadata.record_count,
            }
        })),
        provider_result: Some(json!({
            "providerProfileId": profile_id,
            "provider": provider,
            "model": model,
        })),
        ordered_items: vec![json!({
            "kind": "toolCall",
            "index": 0,
            "callId": "call-terminal-1",
            "name": "fs.read",
            "arguments": "{\"path\":\"README.md\"}",
        })],
    }
}

async fn create_test_session_store(
    root: &TestRoot,
    session_id: &str,
    host_run_id: &str,
    run_id: &str,
    initial_input_id: &str,
    workspace_binding_digest: &str,
    capability: &RunCapabilityV2,
    unique: u64,
) -> SessionKernelV2Store {
    let active_runs =
        HostActiveRunBrokerV2::new(root.path.clone()).expect("create test active-run broker");
    let turn = active_runs
        .begin_session_turn(session_id)
        .await
        .expect("begin test Session turn");
    active_runs
        .register(
            &turn,
            HostActiveRunRegistrationV2 {
                session_id: session_id.to_string(),
                host_run_id: host_run_id.to_string(),
                run_id: run_id.to_string(),
                bootstrap_digest: sha256_literal('1'),
                workspace_binding_ref: format!("workspace-ref-{unique}"),
                workspace_binding_digest: workspace_binding_digest.to_string(),
                workspace_binding_identity: format!("workspace-identity-{unique}"),
                workspace_kind: HostRunWorkspaceKindV2::Bound,
                active_folder_id: Some(format!("folder-{unique}")),
                empty_workspace_key: None,
                initial_input_id: initial_input_id.to_string(),
                initial_opaque_input_ref: format!("opaque-input-{unique}"),
                run_settings: HostRunSettingsCeilingV2 {
                    workspace_read: true,
                    workspace_write: false,
                    web_read: false,
                    auto_approve_plans: false,
                },
                recorded_at: "2026-08-03T00:00:00Z".to_string(),
            },
            Some(root.path.as_path()),
        )
        .expect("register test active Run");
    active_runs
        .bind_run_transport_capability(&turn, host_run_id, run_id, capability)
        .expect("bind test Run capability");
    drop(turn);
    SessionKernelV2Store::new(root.path.clone(), active_runs)
}

async fn run_dispatch_scenario(scenario: DispatchScenario) {
    let mut root = TestRoot::new(scenario.label());
    let mut provider = ControlledProvider::start_with_reply(scenario.provider_reply());
    let unique = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let session_id = format!("session-dispatch-{}-{unique}", scenario.label());
    let host_run_id = format!("host-run-{unique}");
    let run_id = format!("run-{unique}");
    let provider_turn_id = format!("provider-turn-{unique}");
    let initial_input_id = format!("input-{unique}-1");
    let profile_id = format!("profile-{unique}");
    let profile_revision = sha256_literal('6');
    let workspace_binding_digest = sha256_literal('2');
    let capability = RunCapabilityV2::new(format!("test-run-capability-{unique}-0123456789abcdef"))
        .expect("valid test Run capability");

    let active_runs =
        HostActiveRunBrokerV2::new(root.path.clone()).expect("create test active-run broker");
    let turn = active_runs
        .begin_session_turn(&session_id)
        .await
        .expect("begin test Session turn");
    active_runs
        .register(
            &turn,
            HostActiveRunRegistrationV2 {
                session_id: session_id.clone(),
                host_run_id: host_run_id.clone(),
                run_id: run_id.clone(),
                bootstrap_digest: sha256_literal('1'),
                workspace_binding_ref: format!("workspace-ref-{unique}"),
                workspace_binding_digest: workspace_binding_digest.clone(),
                workspace_binding_identity: format!("workspace-identity-{unique}"),
                workspace_kind: HostRunWorkspaceKindV2::Bound,
                active_folder_id: Some(format!("folder-{unique}")),
                empty_workspace_key: None,
                initial_input_id: initial_input_id.clone(),
                initial_opaque_input_ref: format!("opaque-input-{unique}"),
                run_settings: HostRunSettingsCeilingV2 {
                    workspace_read: true,
                    workspace_write: false,
                    web_read: false,
                    auto_approve_plans: false,
                },
                recorded_at: "2026-08-03T00:00:00Z".to_string(),
            },
            Some(root.path.as_path()),
        )
        .expect("register test active Run");
    active_runs
        .bind_run_transport_capability(&turn, &host_run_id, &run_id, &capability)
        .expect("bind test Run capability");
    drop(turn);

    let session_store = SessionKernelV2Store::new(root.path.clone(), active_runs);
    let kernel_service = KernelSessionServiceV2::open(
        root.path.join("kernel-v2.sqlite3"),
        KernelExecutorConfig::default(),
        Arc::new(EmptySecretProvider),
    )
    .expect("open test-owned canonical Kernel service");
    let registry = deepcode_kernel_tools::KernelToolRegistry::new();
    let tool_context = registry
        .tool_context_v2(
            deepcode_kernel_tools::ToolContextVersionV2::new(1).expect("valid ToolContext version"),
        )
        .expect("build canonical ToolContext");
    let context_ref = tool_context.context_ref();
    let snapshot_ref = session_store
        .persist_tool_context_snapshot(&session_id, &run_id, &capability, &tool_context)
        .expect("persist initial Daemon ToolContext snapshot");
    assert_eq!(
        snapshot_ref.record_id,
        format!(
            "session-kernel-v3:{run_id}:tool-context:{}",
            context_ref.context_digest.as_str()
        )
    );

    let initial_input_data = input_data(&initial_input_id, unique, "2026-08-03T00:00:00Z");
    let initial_input_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:input:{initial_input_id}"),
        SessionKernelPersistenceRecordKindV3::Input,
        "2026-08-03T00:00:00Z",
        initial_input_data.clone(),
    );
    let initial_input_ref = record_ref(&initial_input_record);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        initial_input_record,
    );

    let initial_input = current_input(
        &provider_turn_id,
        &run_id,
        1,
        &context_ref,
        &initial_input_data,
    );
    let initial_input_digest = canonical_sha256(&initial_input).expect("digest current input");
    let initial_checkpoint = checkpoint(
        1,
        &run_id,
        &provider_turn_id,
        1,
        &initial_input_id,
        &initial_input_digest,
        &profile_id,
        &profile_revision,
        &workspace_binding_digest,
        &context_ref,
        &initial_input_ref,
        None,
    );
    let initial_checkpoint_digest =
        canonical_sha256(&initial_checkpoint).expect("digest initial checkpoint");
    let initial_checkpoint_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:checkpoint:1"),
        SessionKernelPersistenceRecordKindV3::Checkpoint,
        "2026-08-03T00:00:01Z",
        initial_checkpoint,
    );
    let initial_checkpoint_ref = record_ref(&initial_checkpoint_record);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        initial_checkpoint_record,
    );
    let captured_admission = session_store
        .provider_turn_admission(&session_id, &run_id, &capability, &provider_turn_id)
        .expect("capture durable Provider admission");
    let trace_store = ProviderTraceStoreV1::new(root.path.clone());
    let trace_path = trace_store
        .trace_path(&session_id, &provider_turn_id)
        .expect("resolve Provider trace path");
    let profile = ResolvedLlmProfile {
        id: profile_id.clone(),
        kind: "openaiCompatible".to_string(),
        provider_flavor: Some("deepseek".to_string()),
        base_url: Some(provider.base_url.clone()),
        model: "controlled-model".to_string(),
        max_output_tokens: Some(1024),
        temperature: None,
        reasoning_effort: None,
        thinking: Some("enabled".to_string()),
        api_key: Some("test-provider-key-not-secret-0001".to_string()),
    };
    let request_envelope = json!({
        "messages": [
            {
                "role": "user",
                "content": serde_json::to_string(&initial_input).expect("encode current input")
            },
            {
                "role": "user",
                "content": serde_json::to_string(&json!({
                    "schemaVersion": "deepcode.session.provider-plan-decision.v2"
                })).expect("encode empty plan context")
            },
            {
                "role": "user",
                "content": serde_json::to_string(&json!({
                    "schemaVersion": "deepcode.session.provider-review.v2"
                })).expect("encode empty review context")
            }
        ],
        "tools": []
    });
    let response = llm_stream_response(
        profile,
        request_envelope,
        provider_turn_id.clone(),
        ProviderStreamTraceContextV1 {
            store: trace_store.clone(),
            identity: ProviderTraceIdentityV1 {
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                user_turn_id: initial_input_id.clone(),
                provider_turn_id: provider_turn_id.clone(),
                provider_kind: "deepseek".to_string(),
                model: "controlled-model".to_string(),
                profile_id: profile_id.clone(),
                profile_revision: profile_revision.clone(),
                control_epoch: 1,
                purpose: ProviderTracePurposeV1::Primary,
            },
            dispatch_authority: ProviderStreamDispatchAuthorityV1 {
                session_store: session_store.clone(),
                kernel_service,
                run_capability: capability.clone(),
                admission: captured_admission.clone(),
            },
        },
        crate::session_private_io_lock(&session_id)
            .read_owned()
            .await,
    );
    assert_eq!(
        provider.request_count(),
        0,
        "lazy Body sent a request early"
    );
    assert!(!trace_path.exists(), "lazy Body created a Trace early");

    let (next_epoch, next_input_id, next_input_digest, next_input_ref, next_context_ref) =
        match scenario {
            DispatchScenario::SameAuthorityCheckpoint
            | DispatchScenario::ServerFailure
            | DispatchScenario::RateLimited => (
                1,
                initial_input_id.clone(),
                initial_input_digest.clone(),
                initial_input_ref.clone(),
                context_ref.clone(),
            ),
            DispatchScenario::AuthorityChangingCheckpoint => {
                let next_input_id = format!("input-{unique}-2");
                let next_input_data = input_data(&next_input_id, unique, "2026-08-03T00:00:02Z");
                let next_input = current_input(
                    &provider_turn_id,
                    &run_id,
                    2,
                    &context_ref,
                    &next_input_data,
                );
                let next_input_digest =
                    canonical_sha256(&next_input).expect("digest superseding current input");
                let next_input_record = persistence_record(
                    &session_id,
                    &run_id,
                    format!("session-kernel-v3:{run_id}:input:{next_input_id}"),
                    SessionKernelPersistenceRecordKindV3::Input,
                    "2026-08-03T00:00:02Z",
                    next_input_data,
                );
                let next_input_ref = record_ref(&next_input_record);
                append_record(
                    &session_store,
                    &capability,
                    &session_id,
                    &run_id,
                    next_input_record,
                );
                (
                    2,
                    next_input_id,
                    next_input_digest,
                    next_input_ref,
                    context_ref.clone(),
                )
            }
            DispatchScenario::ContextChangingCheckpoint => {
                let next_tool_context = registry
                    .tool_context_v2(
                        deepcode_kernel_tools::ToolContextVersionV2::new(2)
                            .expect("valid refreshed ToolContext version"),
                    )
                    .expect("build refreshed canonical ToolContext");
                let next_context_ref = next_tool_context.context_ref();
                session_store
                    .persist_tool_context_snapshot(
                        &session_id,
                        &run_id,
                        &capability,
                        &next_tool_context,
                    )
                    .expect("persist refreshed Daemon ToolContext snapshot");
                let next_input = current_input(
                    &provider_turn_id,
                    &run_id,
                    1,
                    &next_context_ref,
                    &initial_input_data,
                );
                let next_input_digest =
                    canonical_sha256(&next_input).expect("digest context-refreshed current input");
                (
                    1,
                    initial_input_id.clone(),
                    next_input_digest,
                    initial_input_ref.clone(),
                    next_context_ref,
                )
            }
        };
    let mut next_checkpoint = checkpoint(
        2,
        &run_id,
        &provider_turn_id,
        next_epoch,
        &next_input_id,
        &next_input_digest,
        &profile_id,
        &profile_revision,
        &workspace_binding_digest,
        &next_context_ref,
        &next_input_ref,
        Some(&initial_checkpoint_ref),
    );
    if matches!(scenario, DispatchScenario::AuthorityChangingCheckpoint) {
        next_checkpoint["cursor"]["inputRefs"] = json!([initial_input_ref, next_input_ref]);
    }
    let next_checkpoint_digest =
        canonical_sha256(&next_checkpoint).expect("digest next checkpoint");
    assert_ne!(initial_checkpoint_digest, next_checkpoint_digest);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        persistence_record(
            &session_id,
            &run_id,
            format!("session-kernel-v3:{run_id}:checkpoint:2"),
            SessionKernelPersistenceRecordKindV3::Checkpoint,
            "2026-08-03T00:00:02Z",
            next_checkpoint,
        ),
    );
    let current_admission = session_store
        .provider_turn_admission(&session_id, &run_id, &capability, &provider_turn_id)
        .expect("re-read durable Provider admission");
    match scenario {
        DispatchScenario::SameAuthorityCheckpoint
        | DispatchScenario::ServerFailure
        | DispatchScenario::RateLimited => {
            assert_eq!(current_admission, captured_admission);
        }
        DispatchScenario::AuthorityChangingCheckpoint
        | DispatchScenario::ContextChangingCheckpoint => {
            assert_ne!(current_admission, captured_admission);
        }
    }

    let body = tokio::time::timeout(
        Duration::from_secs(10),
        to_bytes(response.into_body(), 2 * 1024 * 1024),
    )
    .await
    .expect("Provider response Body timed out")
    .expect("read Provider response Body");
    let body = std::str::from_utf8(&body).expect("Provider response is UTF-8");

    match scenario {
        DispatchScenario::SameAuthorityCheckpoint => {
            assert_eq!(provider.request_count(), 1);
            assert!(body.contains("provider_terminal"), "{body}");
            assert!(!body.contains("provider_error"), "{body}");
            assert!(trace_path.is_file());
            let metadata = trace_store
                .list_verified_metadata(&session_id)
                .expect("verify completed Provider Trace");
            assert_eq!(metadata.len(), 1);
            assert_eq!(metadata[0].provider_turn_id, provider_turn_id);
            assert_eq!(
                metadata[0].terminal_kind,
                ProviderTraceTerminalKindV1::Completed
            );
            assert!(metadata[0].record_count >= 4);
        }
        DispatchScenario::AuthorityChangingCheckpoint
        | DispatchScenario::ContextChangingCheckpoint => {
            assert_eq!(provider.request_count(), 0);
            assert!(body.contains("provider_dispatch_stale"), "{body}");
            assert!(!trace_path.exists());
            assert!(trace_store
                .list_verified_metadata(&session_id)
                .expect("list stale Provider Traces")
                .is_empty());
        }
        DispatchScenario::ServerFailure | DispatchScenario::RateLimited => {
            assert_eq!(provider.request_count(), 1);
            let expected_public_error = match scenario {
                DispatchScenario::ServerFailure => "provider_retryable_no_mutation",
                DispatchScenario::RateLimited => "llm_chat_failed",
                _ => unreachable!(),
            };
            assert!(body.contains(expected_public_error), "{body}");
            assert!(!body.contains("provider_terminal"), "{body}");
            let metadata = trace_store
                .list_verified_metadata(&session_id)
                .expect("verify failed Provider Trace");
            assert_eq!(metadata.len(), 1);
            assert_eq!(
                metadata[0].terminal_kind,
                ProviderTraceTerminalKindV1::Failed
            );
            let records = session_store
                .list(&session_id, &run_id, &capability)
                .expect("read failed terminal record");
            let terminal = records
                .iter()
                .find(|record| {
                    record.record_kind == SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
                })
                .expect("durable Provider terminal");
            let expected_reason = match scenario {
                DispatchScenario::ServerFailure => "provider_retryable_no_mutation",
                DispatchScenario::RateLimited => "ProviderHttpStatusFailed",
                _ => unreachable!(),
            };
            assert_eq!(
                terminal.data.get("reasonCode").and_then(Value::as_str),
                Some(expected_reason)
            );
            assert!(terminal.data.get("completion").is_none());
            assert!(terminal.data.get("providerResult").is_none());
            assert!(terminal
                .data
                .get("orderedItems")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty));
        }
    }

    provider.close();
    drop(trace_store);
    drop(session_store);
    root.cleanup();
}

async fn assert_raw_camel_case_public_request_settlement_wire() {
    let mut root = TestRoot::new("public-request-settlement-wire");
    let unique = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let session_id = format!("session-public-settlement-{unique}");
    let host_run_id = format!("host-run-public-settlement-{unique}");
    let run_id = format!("run-public-settlement-{unique}");
    let input_id = format!("input-public-settlement-{unique}");
    let provider_turn_id = format!("provider-turn-public-settlement-{unique}");
    let request_id = format!("request-public-settlement-{unique}");
    let projection_id = format!("projection-public-settlement-{unique}");
    let profile_id = format!("profile-public-settlement-{unique}");
    let profile_revision = sha256_literal('6');
    let workspace_binding_digest = sha256_literal('2');
    let outcome_digest = sha256_literal('a');
    let capability = RunCapabilityV2::new(format!(
        "test-public-settlement-capability-{unique}-0123456789abcdef"
    ))
    .expect("valid public-settlement Run capability");
    let session_store = create_test_session_store(
        &root,
        &session_id,
        &host_run_id,
        &run_id,
        &input_id,
        &workspace_binding_digest,
        &capability,
        unique,
    )
    .await;

    let tool_context = deepcode_kernel_tools::KernelToolRegistry::new()
        .tool_context_v2(
            deepcode_kernel_tools::ToolContextVersionV2::new(1)
                .expect("valid public-settlement ToolContext version"),
        )
        .expect("build public-settlement ToolContext");
    let context_ref = tool_context.context_ref();
    session_store
        .persist_tool_context_snapshot(&session_id, &run_id, &capability, &tool_context)
        .expect("persist public-settlement ToolContext snapshot");

    let current_input_data = input_data(&input_id, unique, "2026-08-03T00:00:00Z");
    let input_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:input:{input_id}"),
        SessionKernelPersistenceRecordKindV3::Input,
        "2026-08-03T00:00:00Z",
        current_input_data.clone(),
    );
    let input_ref = record_ref(&input_record);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        input_record,
    );

    let request_intent = json!({
        "kind": "toolContextGet",
        "payload": { "knownContext": context_ref },
    });
    let request_digest = canonical_sha256(&json!({
        "requestId": &request_id,
        "lane": "query",
        "intent": &request_intent,
    }))
    .expect("digest exact public request identity");
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        persistence_record(
            &session_id,
            &run_id,
            format!("session-kernel-v3:{run_id}:request:{request_id}:attempt:1"),
            SessionKernelPersistenceRecordKindV3::PublicRequest,
            "2026-08-03T00:00:00Z",
            json!({
                "requestId": request_id,
                "lane": "query",
                "intent": request_intent,
                "startedAt": "2026-08-03T00:00:00Z",
                "attemptCount": 1,
            }),
        ),
    );

    let provider_input = current_input(
        &provider_turn_id,
        &run_id,
        1,
        &context_ref,
        &current_input_data,
    );
    let provider_input_digest =
        canonical_sha256(&provider_input).expect("digest public-settlement current input");
    let commit_scope = json!({
        "kind": "publicRequestSettlement",
        "requestId": request_id,
        "requestDigest": request_digest,
        "outcomeDigest": outcome_digest,
    });
    let mut checkpoint_data = checkpoint(
        1,
        &run_id,
        &provider_turn_id,
        1,
        &input_id,
        &provider_input_digest,
        &profile_id,
        &profile_revision,
        &workspace_binding_digest,
        &context_ref,
        &input_ref,
        None,
    );
    checkpoint_data["commitScope"] = commit_scope.clone();
    let checkpoint_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:checkpoint:1"),
        SessionKernelPersistenceRecordKindV3::Checkpoint,
        "2026-08-03T00:00:01Z",
        checkpoint_data,
    );
    let checkpoint_ref = record_ref(&checkpoint_record);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        checkpoint_record,
    );

    let projection_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:projection:{projection_id}"),
        SessionKernelPersistenceRecordKindV3::Projection,
        "2026-08-03T00:00:01Z",
        json!({
            "schemaVersion": SESSION_KERNEL_PROJECTION_RECORD_V3_SCHEMA,
            "commitScope": commit_scope,
            "event": {
                "projectionId": projection_id,
                "runId": run_id,
                "recordedAt": "2026-08-03T00:00:01Z",
                "kind": "diagnostic",
                "data": { "code": "public-settlement-wire-contract" },
            },
        }),
    );
    let projection_ref = record_ref(&projection_record);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        projection_record,
    );

    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        persistence_record(
            &session_id,
            &run_id,
            format!("session-kernel-v3:{run_id}:request:{request_id}:settled"),
            SessionKernelPersistenceRecordKindV3::PublicRequestSettled,
            "2026-08-03T00:00:01Z",
            json!({
                "schemaVersion": SESSION_KERNEL_PUBLIC_REQUEST_SETTLEMENT_V3_SCHEMA,
                "requestId": request_id,
                "requestDigest": request_digest,
                "outcomeDigest": outcome_digest,
                "checkpointRef": checkpoint_ref,
                "projectionRefs": [projection_ref],
            }),
        ),
    );

    let records = session_store
        .list(&session_id, &run_id, &capability)
        .expect("replay successful raw camelCase settlement history");
    assert!(records.iter().any(|record| {
        record.record_kind == SessionKernelPersistenceRecordKindV3::PublicRequestSettled
    }));

    drop(session_store);
    root.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_dispatch_commits_durable_fence_before_network_and_stales_preceding_epoch() {
    run_dispatch_scenario(DispatchScenario::SameAuthorityCheckpoint).await;
    run_dispatch_scenario(DispatchScenario::AuthorityChangingCheckpoint).await;
    run_dispatch_scenario(DispatchScenario::ContextChangingCheckpoint).await;
    assert_raw_camel_case_public_request_settlement_wire().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tool_context_snapshot_is_daemon_only_replay_exact_and_history_conflicts_fail_closed() {
    let mut root = TestRoot::new("tool-context-snapshot");
    let unique = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let session_id = format!("session-tool-context-{unique}");
    let host_run_id = format!("host-run-tool-context-{unique}");
    let run_id = format!("run-tool-context-{unique}");
    let initial_input_id = format!("input-tool-context-{unique}");
    let workspace_binding_digest = sha256_literal('2');
    let capability = RunCapabilityV2::new(format!(
        "test-tool-context-capability-{unique}-0123456789abcdef"
    ))
    .expect("valid test Run capability");
    let session_store = create_test_session_store(
        &root,
        &session_id,
        &host_run_id,
        &run_id,
        &initial_input_id,
        &workspace_binding_digest,
        &capability,
        unique,
    )
    .await;
    let registry = deepcode_kernel_tools::KernelToolRegistry::new();
    let context_version =
        deepcode_kernel_tools::ToolContextVersionV2::new(1).expect("valid ToolContext version");
    let tool_context = registry
        .tool_context_v2(context_version)
        .expect("build canonical ToolContext");

    let first_ref = session_store
        .persist_tool_context_snapshot(&session_id, &run_id, &capability, &tool_context)
        .expect("persist Daemon-owned ToolContext snapshot");
    let replay_ref = session_store
        .persist_tool_context_snapshot(&session_id, &run_id, &capability, &tool_context)
        .expect("exact ToolContext replay");
    assert_eq!(replay_ref.record_id, first_ref.record_id);
    assert_eq!(replay_ref.record_digest, first_ref.record_digest);

    let records = session_store
        .list(&session_id, &run_id, &capability)
        .expect("list ToolContext snapshot history");
    assert_eq!(records.len(), 2, "exact replay must not append a record");
    assert_eq!(
        records[0].record_kind,
        SessionKernelPersistenceRecordKindV3::StoreHeader
    );
    assert_eq!(
        records[1].record_kind,
        SessionKernelPersistenceRecordKindV3::ToolContextSnapshot
    );
    let snapshot_record = records[1].clone();

    let daemon_append_error = session_store
        .append(
            &session_id,
            &run_id,
            &capability,
            SessionKernelPersistenceAppendRequestV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA.to_string(),
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                record: snapshot_record.clone(),
            },
        )
        .expect_err("Session append must reject Daemon-only ToolContext records");
    assert_eq!(
        daemon_append_error.code,
        "session_kernel_daemon_record_forbidden"
    );

    let secret_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:input:secret-{unique}"),
        SessionKernelPersistenceRecordKindV3::Input,
        "2026-08-03T00:00:03Z",
        json!({
            "inputId": format!("secret-{unique}"),
            "opaqueInputRef": format!("opaque-secret-{unique}"),
            "text": "must fail before persistence",
            "attachments": [],
            "recordedAt": "2026-08-03T00:00:03Z",
            "apiKey": "must-never-enter-history",
        }),
    );
    let secret_error = session_store
        .append(
            &session_id,
            &run_id,
            &capability,
            SessionKernelPersistenceAppendRequestV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA.to_string(),
                session_id: session_id.clone(),
                run_id: run_id.clone(),
                record: secret_record,
            },
        )
        .expect_err("structured secret must not enter Session persistence");
    assert_eq!(secret_error.code, "host_v2_transport_secret_forbidden");

    let mut unavailable = BTreeMap::new();
    unavailable.insert(
        deepcode_kernel_tools::ToolIdV2::parse("fs.read").expect("registered namespaced ToolId"),
        deepcode_kernel_tools::ToolAvailabilityV2::Unavailable,
    );
    let conflicting_context = registry
        .tool_context_v2_with_runtime_availability(context_version, &unavailable)
        .expect("build another valid bundle for the same context version");
    assert_ne!(
        conflicting_context.context_digest,
        tool_context.context_digest
    );
    let version_error = session_store
        .persist_tool_context_snapshot(&session_id, &run_id, &capability, &conflicting_context)
        .expect_err("one version cannot identify different ToolContext content");
    assert_eq!(
        version_error.code,
        "session_kernel_tool_context_version_conflict"
    );

    let path = session_store
        .run_store_path(&session_id, &run_id)
        .expect("resolve test-owned Session store");
    let raw_before_corruption = fs::read_to_string(&path).expect("read test-owned Session store");
    assert!(!raw_before_corruption.contains("must-never-enter-history"));
    assert!(!raw_before_corruption.contains("test-tool-context-capability"));

    let mut corrupted_snapshot = snapshot_record;
    corrupted_snapshot.data["schemaVersion"] = json!("deepcode.session.tool-context-snapshot.v2");
    let corrupted_value =
        serde_json::to_value(&corrupted_snapshot).expect("encode corrupted snapshot fixture");
    corrupted_snapshot.record_digest = canonical_sha256(
        &value_without_field(&corrupted_value, "recordDigest")
            .expect("remove corrupted record digest"),
    )
    .expect("digest corrupted snapshot fixture");
    append_json_line_durable(
        &path,
        &serde_json::to_value(corrupted_snapshot).expect("encode corrupt history line"),
    )
    .expect("append test-owned corrupt history line");
    let history_error = session_store
        .list(&session_id, &run_id, &capability)
        .expect_err("invalid durable ToolContext history must fail closed");
    assert_eq!(history_error.code, "UnsupportedHistorySchema");

    drop(session_store);
    root.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_terminal_v3_binds_trace_provider_flavor_retry_reason_and_replay() {
    run_dispatch_scenario(DispatchScenario::ServerFailure).await;
    run_dispatch_scenario(DispatchScenario::RateLimited).await;

    let mut root = TestRoot::new("provider-terminal-exact");
    let unique = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let session_id = format!("session-provider-terminal-{unique}");
    let host_run_id = format!("host-run-provider-terminal-{unique}");
    let run_id = format!("run-provider-terminal-{unique}");
    let input_id = format!("input-provider-terminal-{unique}");
    let provider_turn_id = format!("provider-turn-terminal-{unique}");
    let profile_id = format!("profile-terminal-{unique}");
    let profile_revision = sha256_literal('6');
    let workspace_binding_digest = sha256_literal('2');
    let capability = RunCapabilityV2::new(format!(
        "test-provider-terminal-capability-{unique}-0123456789abcdef"
    ))
    .expect("valid test Run capability");
    let session_store = create_test_session_store(
        &root,
        &session_id,
        &host_run_id,
        &run_id,
        &input_id,
        &workspace_binding_digest,
        &capability,
        unique,
    )
    .await;
    let tool_context = deepcode_kernel_tools::KernelToolRegistry::new()
        .tool_context_v2(
            deepcode_kernel_tools::ToolContextVersionV2::new(1).expect("valid ToolContext version"),
        )
        .expect("build canonical ToolContext");
    let context_ref = tool_context.context_ref();
    session_store
        .persist_tool_context_snapshot(&session_id, &run_id, &capability, &tool_context)
        .expect("persist ToolContext before Provider reservation");

    let terminal_input_data = input_data(&input_id, unique, "2026-08-03T00:00:00Z");
    let input_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:input:{input_id}"),
        SessionKernelPersistenceRecordKindV3::Input,
        "2026-08-03T00:00:00Z",
        terminal_input_data.clone(),
    );
    let input_ref = record_ref(&input_record);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        input_record,
    );
    let provider_input = current_input(
        &provider_turn_id,
        &run_id,
        1,
        &context_ref,
        &terminal_input_data,
    );
    let provider_input_digest =
        canonical_sha256(&provider_input).expect("digest Provider current input");
    let checkpoint_record = persistence_record(
        &session_id,
        &run_id,
        format!("session-kernel-v3:{run_id}:checkpoint:1"),
        SessionKernelPersistenceRecordKindV3::Checkpoint,
        "2026-08-03T00:00:01Z",
        checkpoint(
            1,
            &run_id,
            &provider_turn_id,
            1,
            &input_id,
            &provider_input_digest,
            &profile_id,
            &profile_revision,
            &workspace_binding_digest,
            &context_ref,
            &input_ref,
            None,
        ),
    );
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        checkpoint_record,
    );
    let admission = session_store
        .provider_turn_admission(&session_id, &run_id, &capability, &provider_turn_id)
        .expect("resolve exact durable Provider admission");
    let binding = SessionProviderDispatchBindingV2 {
        provider_turn_id: provider_turn_id.clone(),
        run_id: run_id.clone(),
        control_epoch: 1,
        current_input_id: input_id.clone(),
        current_input_digest: provider_input_digest,
        purpose: ProviderTracePurposeV1::Primary,
        plan_revision: None,
        work_authority: admission.work_authority.clone(),
        review_revision: None,
        snapshot_high_water: None,
    };
    let trace_store = ProviderTraceStoreV1::new(root.path.clone());
    let request_body = br#"{"messages":[{"role":"user","content":"safe request"}],"tools":[]}"#;
    let trace_identity = ProviderTraceIdentityV1 {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        user_turn_id: input_id.clone(),
        provider_turn_id: provider_turn_id.clone(),
        provider_kind: "deepseek".to_string(),
        model: "deepseek-contract-model".to_string(),
        profile_id: profile_id.clone(),
        profile_revision: profile_revision.clone(),
        control_epoch: 1,
        purpose: ProviderTracePurposeV1::Primary,
    };
    let dispatch = session_store
        .commit_provider_dispatch(
            &capability,
            &admission,
            &binding,
            &trace_store,
            trace_identity.clone(),
            request_body,
        )
        .expect("commit exact Provider dispatch before Trace activity");
    let SessionProviderTurnDispatchCommitV3 { mut trace, receipt } = dispatch;
    trace
        .response_boundary(ProviderTraceResponseBoundaryV1 {
            status_code: 200,
            content_type: Some("text/event-stream".to_string()),
        })
        .expect("archive Provider response boundary");
    let reasoning = "controlled terminal reasoning";
    trace
        .append_normalized_event(json!({
            "type": "reasoning_delta",
            "content": reasoning,
        }))
        .expect("archive exact plaintext reasoning");
    trace
        .append_normalized_event(json!({
            "type": "validatedTerminal",
            "nativeCompletion": {
                "providerKind": "openaiCompatible",
                "terminalSignal": "[DONE]",
                "finishReason": "tool_calls",
            },
            "reasoningPresent": true,
            "reasoningTransport": "openaiPlaintext",
            "reasoningDigest": sha256_bytes(reasoning.as_bytes()),
            "responseDigest": sha256_literal('9'),
            "providerResult": {
                "providerProfileId": profile_id,
                "provider": "deepseek",
                "model": "deepseek-contract-model",
            },
            "orderedItems": [{
                "kind": "toolCall",
                "index": 0,
                "callId": "call-terminal-1",
                "name": "fs.read",
                "arguments": "{\"path\":\"README.md\"}",
            }]
        }))
        .expect("archive safe validated terminal event");
    let metadata = trace
        .finish(ProviderTraceTerminalV1 {
            kind: ProviderTraceTerminalKindV1::Completed,
            reason_code: None,
        })
        .expect("seal completed Provider Trace");
    let response_digest = sha256_literal('9');
    let recovered_trace = trace_store
        .verified_terminal_recovery(&session_id, &provider_turn_id)
        .expect("recover exact safe terminal from sealed Trace");
    assert_eq!(recovered_trace.metadata.seal_digest, metadata.seal_digest);
    assert_eq!(
        recovered_trace
            .completed
            .as_ref()
            .map(|completed| completed.response_digest.as_str()),
        Some(response_digest.as_str())
    );
    let first_terminal_ref = session_store
        .commit_provider_terminal(
            &receipt,
            &metadata,
            completed_terminal(
                &metadata,
                &profile_id,
                "deepseek",
                "deepseek-contract-model",
                &response_digest,
            ),
        )
        .expect("commit terminal bound to exact sealed Trace");
    let replay_terminal_ref = session_store
        .commit_provider_terminal(
            &receipt,
            &metadata,
            completed_terminal(
                &metadata,
                &profile_id,
                "deepseek",
                "deepseek-contract-model",
                &response_digest,
            ),
        )
        .expect("exact terminal replay");
    assert_eq!(replay_terminal_ref.record_id, first_terminal_ref.record_id);
    assert_eq!(
        replay_terminal_ref.record_digest,
        first_terminal_ref.record_digest
    );

    let flavor_error = session_store
        .commit_provider_terminal(
            &receipt,
            &metadata,
            completed_terminal(
                &metadata,
                &profile_id,
                "openaiCompatible",
                "deepseek-contract-model",
                &response_digest,
            ),
        )
        .expect_err("safe Provider result flavor must bind Trace identity");
    assert_eq!(flavor_error.code, "provider_terminal_result_trace_conflict");

    let replay_conflict = session_store
        .commit_provider_terminal(
            &receipt,
            &metadata,
            completed_terminal(
                &metadata,
                &profile_id,
                "deepseek",
                "deepseek-contract-model",
                &sha256_literal('a'),
            ),
        )
        .expect_err("same terminal identity cannot change immutable response evidence");
    assert_eq!(replay_conflict.code, "provider_terminal_replay_conflict");

    let dispatch_replay = match session_store.commit_provider_dispatch(
        &capability,
        &admission,
        &binding,
        &trace_store,
        trace_identity.clone(),
        request_body,
    ) {
        Ok(_) => panic!("durable dispatch must never be sent a second time"),
        Err(error) => error,
    };
    assert_eq!(dispatch_replay.code, "provider_dispatch_already_committed");
    let dispatch_conflict = match session_store.commit_provider_dispatch(
        &capability,
        &admission,
        &binding,
        &trace_store,
        trace_identity,
        br#"{"messages":[{"role":"user","content":"changed request"}],"tools":[]}"#,
    ) {
        Ok(_) => panic!("same Provider turn cannot change exact request bytes"),
        Err(error) => error,
    };
    assert_eq!(dispatch_conflict.code, "provider_dispatch_replay_conflict");

    let records = session_store
        .list(&session_id, &run_id, &capability)
        .expect("read exact Provider terminal history");
    assert_eq!(
        records
            .iter()
            .filter(|record| {
                record.record_kind == SessionKernelPersistenceRecordKindV3::ProviderTurnDispatch
            })
            .count(),
        1
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| {
                record.record_kind == SessionKernelPersistenceRecordKindV3::ProviderTurnTerminal
            })
            .count(),
        1
    );
    let raw_history = fs::read_to_string(
        session_store
            .run_store_path(&session_id, &run_id)
            .expect("resolve terminal history path"),
    )
    .expect("read terminal history");
    for line in raw_history.lines() {
        let record: serde_json::Value =
            serde_json::from_str(line).expect("decode terminal history record");
        assert_no_structured_secret_fields(&record);
    }
    assert!(!raw_history.contains("test-provider-terminal-capability"));

    drop(trace);
    drop(trace_store);
    drop(session_store);
    root.cleanup();
}
