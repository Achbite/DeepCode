use super::*;
use crate::host_run_broker_v2::{
    HostActiveRunRegistrationV2, HostRunSettingsCeilingV2, HostRunWorkspaceKindV2,
};
use crate::llm_transport::{
    llm_stream_response, ProviderStreamDispatchAuthorityV1, ProviderStreamTraceContextV1,
    ResolvedLlmProfile,
};
use crate::provider_trace_v1::{
    ProviderTraceIdentityV1, ProviderTracePurposeV1, ProviderTraceStoreV1,
    ProviderTraceTerminalKindV1,
};
use axum::body::{to_bytes, Body};
use axum::http::{header, Response, StatusCode};
use axum::routing::post;
use axum::Router;
use serde_json::json;
use std::fs;
use std::net::TcpListener as StdTcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

static TEST_ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(1);

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

struct ControlledProvider {
    base_url: String,
    request_count: Arc<AtomicUsize>,
    shutdown: Option<oneshot::Sender<()>>,
    task: Option<JoinHandle<Result<(), String>>>,
}

impl ControlledProvider {
    fn start() -> Self {
        let request_count = Arc::new(AtomicUsize::new(0));
        let handler_count = Arc::clone(&request_count);
        let app = Router::new().route(
            "/v1/chat/completions",
            post(move || {
                let handler_count = Arc::clone(&handler_count);
                async move {
                    handler_count.fetch_add(1, Ordering::SeqCst);
                    Response::builder()
                        .status(StatusCode::OK)
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(Body::from(concat!(
                            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"controlled reasoning\"}}]}\n\n",
                            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"},\"finish_reason\":\"stop\"}]}\n\n",
                            "data: [DONE]\n\n"
                        )))
                        .expect("build controlled Provider response")
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
}

impl DispatchScenario {
    fn label(self) -> &'static str {
        match self {
            Self::SameAuthorityCheckpoint => "same-authority",
            Self::AuthorityChangingCheckpoint => "authority-changing",
        }
    }
}

fn sha256_literal(fill: char) -> String {
    format!("sha256:{}", fill.to_string().repeat(64))
}

fn persistence_record(
    session_id: &str,
    run_id: &str,
    record_id: String,
    record_kind: SessionKernelPersistenceRecordKindV2,
    recorded_at: &str,
    data: Value,
) -> SessionKernelPersistenceRecordV2 {
    let mut record = SessionKernelPersistenceRecordV2 {
        schema_version: SESSION_KERNEL_PERSISTENCE_RECORD_V2_SCHEMA.to_string(),
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
    record: SessionKernelPersistenceRecordV2,
) {
    store
        .append(
            session_id,
            run_id,
            capability,
            SessionKernelPersistenceAppendRequestV2 {
                schema_version: SESSION_KERNEL_PERSISTENCE_APPEND_REQUEST_V2_SCHEMA.to_string(),
                session_id: session_id.to_string(),
                run_id: run_id.to_string(),
                record,
            },
        )
        .expect("durably append Session Kernel record");
}

fn current_input(
    provider_turn_id: &str,
    run_id: &str,
    control_epoch: u64,
    input_id: &str,
) -> Value {
    json!({
        "schemaVersion": "deepcode.session.provider-current-input.v2",
        "providerTurnId": provider_turn_id,
        "runId": run_id,
        "controlEpoch": control_epoch,
        "purpose": "primary",
        "currentInput": {
            "inputId": input_id,
            "text": "dispatch fence contract"
        }
    })
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
) -> Value {
    json!({
        "schemaVersion": SESSION_KERNEL_CHECKPOINT_V2_SCHEMA,
        "checkpointRevision": revision,
        "savedAt": format!("2026-08-03T00:00:0{revision}Z"),
        "state": {
            "runId": run_id,
            "checkpointRevision": revision,
            "controlEpoch": control_epoch,
            "currentInputId": input_id,
            "providerTurn": {
                "providerTurnId": provider_turn_id,
                "controlEpoch": control_epoch,
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
                        }]
                    }
                }
            }
        }
    })
}

async fn run_dispatch_scenario(scenario: DispatchScenario) {
    let mut root = TestRoot::new(scenario.label());
    let mut provider = ControlledProvider::start();
    let unique = TEST_ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let session_id = format!("session-dispatch-{}-{unique}", scenario.label());
    let host_run_id = format!("host-run-{unique}");
    let run_id = format!("run-{unique}");
    let provider_turn_id = format!("provider-turn-{unique}");
    let initial_input_id = format!("input-{unique}-1");
    let profile_id = format!("profile-{unique}");
    let profile_revision = sha256_literal('6');
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
                workspace_binding_digest: sha256_literal('2'),
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
        )
        .expect("register test active Run");
    active_runs
        .bind_run_transport_capability(&turn, &host_run_id, &run_id, &capability)
        .expect("bind test Run capability");
    drop(turn);

    let session_store = SessionKernelV2Store::new(root.path.clone(), active_runs);
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        persistence_record(
            &session_id,
            &run_id,
            format!("session-kernel-v2:{run_id}:store"),
            SessionKernelPersistenceRecordKindV2::StoreHeader,
            "2026-08-03T00:00:00Z",
            json!({ "schemaVersion": SESSION_KERNEL_PERSISTENCE_V2_SCHEMA }),
        ),
    );

    let initial_input = current_input(&provider_turn_id, &run_id, 1, &initial_input_id);
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
    );
    let initial_checkpoint_digest =
        canonical_sha256(&initial_checkpoint).expect("digest initial checkpoint");
    append_record(
        &session_store,
        &capability,
        &session_id,
        &run_id,
        persistence_record(
            &session_id,
            &run_id,
            "checkpoint:1".to_string(),
            SessionKernelPersistenceRecordKindV2::Checkpoint,
            "2026-08-03T00:00:01Z",
            initial_checkpoint,
        ),
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
        name: "Controlled Provider".to_string(),
        kind: "openaiCompatible".to_string(),
        provider_flavor: None,
        base_url: Some(provider.base_url.clone()),
        model: "controlled-model".to_string(),
        max_output_tokens: Some(1024),
        temperature: None,
        reasoning_effort: None,
        thinking: Some("enabled".to_string()),
        api_key: Some("test-provider-key-not-secret-0001".to_string()),
    };
    let request_envelope = json!({
        "messages": [{
            "role": "user",
            "content": serde_json::to_string(&initial_input).expect("encode current input")
        }],
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
                provider_kind: "openaiCompatible".to_string(),
                model: "controlled-model".to_string(),
                profile_id: profile_id.clone(),
                profile_revision: profile_revision.clone(),
                control_epoch: 1,
                purpose: ProviderTracePurposeV1::Primary,
            },
            dispatch_authority: ProviderStreamDispatchAuthorityV1 {
                session_store: session_store.clone(),
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

    let (next_epoch, next_input_id, next_input_digest) = match scenario {
        DispatchScenario::SameAuthorityCheckpoint => {
            (1, initial_input_id.clone(), initial_input_digest.clone())
        }
        DispatchScenario::AuthorityChangingCheckpoint => {
            let next_input_id = format!("input-{unique}-2");
            let next_input = current_input(&provider_turn_id, &run_id, 2, &next_input_id);
            let next_input_digest =
                canonical_sha256(&next_input).expect("digest superseding current input");
            (2, next_input_id, next_input_digest)
        }
    };
    let next_checkpoint = checkpoint(
        2,
        &run_id,
        &provider_turn_id,
        next_epoch,
        &next_input_id,
        &next_input_digest,
        &profile_id,
        &profile_revision,
    );
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
            "checkpoint:2".to_string(),
            SessionKernelPersistenceRecordKindV2::Checkpoint,
            "2026-08-03T00:00:02Z",
            next_checkpoint,
        ),
    );
    let current_admission = session_store
        .provider_turn_admission(&session_id, &run_id, &capability, &provider_turn_id)
        .expect("re-read durable Provider admission");
    match scenario {
        DispatchScenario::SameAuthorityCheckpoint => {
            assert_eq!(current_admission, captured_admission);
        }
        DispatchScenario::AuthorityChangingCheckpoint => {
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
        DispatchScenario::AuthorityChangingCheckpoint => {
            assert_eq!(provider.request_count(), 0);
            assert!(body.contains("provider_dispatch_stale"), "{body}");
            assert!(!trace_path.exists());
            assert!(trace_store
                .list_verified_metadata(&session_id)
                .expect("list stale Provider Traces")
                .is_empty());
        }
    }

    provider.close();
    drop(trace_store);
    drop(session_store);
    root.cleanup();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_dispatch_commits_durable_fence_before_network_and_stales_preceding_epoch() {
    run_dispatch_scenario(DispatchScenario::SameAuthorityCheckpoint).await;
    run_dispatch_scenario(DispatchScenario::AuthorityChangingCheckpoint).await;
}
