mod agent_api;
mod agent_input_v2;
mod agent_kernel_v2;
mod agent_session_api;
mod agent_session_state;
mod agent_timeline;
mod api_response;
mod browser_api;
mod composer_projection_v1;
mod decision_capability_v2;
mod host_admission_v2;
mod host_inspection;
mod host_kernel_operation_store_v2;
mod host_kernel_run_v2;
mod host_kernel_wake_v2;
mod host_run_broker_v2;
mod host_services;
mod host_shutdown_v2;
mod host_v2_storage;
mod host_workspace_registry_v2;
mod kernel_api;
mod kernel_v2_ipc;
mod kernel_v2_transport;
mod llm_provider_transport;
mod llm_stream_parser;
mod llm_transport;
mod prelude;
mod private_analysis_v1;
mod project_store;
mod provider_cache_admission_v1;
mod provider_cache_telemetry_v1;
mod provider_trace_api;
mod provider_trace_v1;
mod routes;
mod session_bootstrap_v2;
mod session_kernel_v2_store;
mod session_metadata_v2;
mod session_public_projection_v2;
mod settings_api;
mod skill_api;
mod startup_readiness_v2;
mod state;
mod terminal_api;
mod terminal_runtime;
mod user_attachment_api_v1;
mod user_attachment_v1;
mod utils;
mod workspace_api;

use crate::prelude::*;

pub(crate) use agent_api::*;
pub(crate) use agent_input_v2::*;
pub(crate) use agent_kernel_v2::*;
pub(crate) use agent_session_api::*;
pub(crate) use agent_session_state::*;
pub(crate) use agent_timeline::*;
pub(crate) use api_response::*;
pub(crate) use browser_api::*;
pub(crate) use composer_projection_v1::*;
pub(crate) use host_admission_v2::*;
pub(crate) use host_services::*;
pub(crate) use host_shutdown_v2::*;
pub(crate) use kernel_api::*;
pub(crate) use llm_provider_transport::*;
pub(crate) use llm_stream_parser::*;
pub(crate) use llm_transport::*;
pub(crate) use private_analysis_v1::*;
pub(crate) use project_store::*;
pub(crate) use provider_cache_admission_v1::*;
pub(crate) use provider_cache_telemetry_v1::*;
pub(crate) use provider_trace_api::*;
pub(crate) use provider_trace_v1::*;
pub(crate) use session_kernel_v2_store::*;
pub(crate) use settings_api::*;
pub(crate) use skill_api::*;
pub(crate) use state::*;
pub(crate) use terminal_api::*;
pub(crate) use user_attachment_api_v1::*;
pub(crate) use user_attachment_v1::*;
pub(crate) use utils::*;
pub(crate) use workspace_api::*;

fn persist_startup_tombstone_outcomes(
    gui: &Arc<Mutex<GuiState>>,
    tombstone_session_ids: &std::collections::HashSet<String>,
    failures: &[crate::host_kernel_run_v2::HostKernelStartupTombstoneFailureV2],
) -> Result<(), String> {
    if tombstone_session_ids.is_empty() {
        return Ok(());
    }
    let failed_at = now_text();
    let mut gui = gui.lock().expect("gui state lock");
    let mut changed = false;
    for session in &mut gui.sessions {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !tombstone_session_ids.contains(session_id) || !session_is_deletion_tombstone(session) {
            continue;
        }
        if let Some(failure) = failures
            .iter()
            .find(|failure| failure.session_id == session_id)
        {
            mark_session_deletion_failed(session, &failed_at, failure.code, &failure.message);
            changed = true;
        } else if session_deletion_status(session) == Some("pending") {
            mark_session_deletion_failed(
                session,
                &failed_at,
                "agent_session_deletion_interrupted",
                "The previous Session deletion owner ended before index finalization; retry deletion explicitly.",
            );
            changed = true;
        }
    }
    if changed {
        crate::session_metadata_v2::persist_session_index(&gui)?;
    }
    Ok(())
}

struct HostStartupFailureV2 {
    code: String,
    message: String,
}

async fn recover_host_startup_v2(
    state: &AppState,
    recoverable_session_ids: &std::collections::HashSet<String>,
    deletion_tombstones: &std::collections::HashSet<String>,
) -> Result<(), HostStartupFailureV2> {
    let reconciliation = match state
        .kernel_session_v2
        .reconcile_startup(recoverable_session_ids, deletion_tombstones)
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            state
                .host_services
                .active_runs_v2
                .record_startup_error(error.code);
            let failures = deletion_tombstones
                .iter()
                .map(
                    |session_id| crate::host_kernel_run_v2::HostKernelStartupTombstoneFailureV2 {
                        session_id: session_id.clone(),
                        code: error.code,
                        message: error.message.clone(),
                    },
                )
                .collect::<Vec<_>>();
            if let Err(persist_error) =
                persist_startup_tombstone_outcomes(&state.gui, deletion_tombstones, &failures)
            {
                state
                    .host_services
                    .active_runs_v2
                    .record_startup_error("agent_session_deletion_startup_failure_persist_failed");
                state
                    .gui
                    .lock()
                    .expect("gui state lock")
                    .session_metadata_error = Some(format!(
                    "Session deletion startup failure state could not be persisted: {persist_error}"
                ));
            }
            return Err(HostStartupFailureV2 {
                code: error.code.to_string(),
                message: error.message,
            });
        }
    };
    if let Err(error) = persist_startup_tombstone_outcomes(
        &state.gui,
        deletion_tombstones,
        &reconciliation.tombstone_failures,
    ) {
        let code = "agent_session_deletion_startup_failure_persist_failed";
        state
            .host_services
            .active_runs_v2
            .record_startup_error(code);
        state
            .gui
            .lock()
            .expect("gui state lock")
            .session_metadata_error = Some(format!(
            "Session deletion startup failure state could not be persisted: {error}"
        ));
        return Err(HostStartupFailureV2 {
            code: code.to_string(),
            message: error,
        });
    }
    let caller_owned_runs = restore_agent_kernel_caller_owners_v2(state, recoverable_session_ids)
        .await
        .map_err(|error| {
            state
                .host_services
                .active_runs_v2
                .record_startup_error(&error.code);
            HostStartupFailureV2 {
                code: error.code,
                message: error.message,
            }
        })?;
    restore_agent_kernel_wait_owners_v2(
        state,
        &reconciliation.continuation_ready_runs,
        &caller_owned_runs,
    )
    .await
    .map_err(|error| {
        state
            .host_services
            .active_runs_v2
            .record_startup_error(&error.code);
        HostStartupFailureV2 {
            code: error.code,
            message: error.message,
        }
    })?;
    Ok(())
}

#[tokio::main]
async fn main() {
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DEEPCODE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(31245);
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
    assert!(
        addr.ip().is_loopback(),
        "Kernel v2 capability transport requires a loopback listener"
    );
    let gui_state = GuiState::new();
    let metadata_available = gui_state.session_metadata_error.is_none();
    let recoverable_session_ids = gui_state
        .sessions
        .iter()
        .filter(|session| metadata_available && session_is_verified_selectable(session))
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    let deletion_tombstones = gui_state
        .sessions
        .iter()
        .filter(|session| metadata_available && session_is_deletion_tombstone(session))
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<std::collections::HashSet<_>>();
    let (kernel_v2_executor_config, kernel_v2_secrets) = runtime_tool_configuration(&gui_state);
    let kernel_v2_fact_store_path =
        deepcode_kernel_ledger::v2::configured_fact_store_path(user_config_root())
            .expect("resolve canonical Kernel v2 fact store path");
    let kernel_v2_service = deepcode_kernel_runtime::v2::KernelSessionServiceV2::open(
        kernel_v2_fact_store_path,
        kernel_v2_executor_config,
        Arc::new(kernel_v2_secrets),
    )
    .expect("open canonical Kernel v2 service");
    let provider_trace_v1 = ProviderTraceStoreV1::new(gui_state.paths.sessions_dir.clone());
    let private_analysis_v1 =
        PrivateAnalysisLeaseStoreV1::new(gui_state.paths.sessions_dir.clone());
    let provider_cache_telemetry_v1 =
        ProviderCacheTelemetryStoreV1::new(gui_state.paths.sessions_dir.clone());
    let host_services = HostServices::from_projects(
        &gui_state.projects,
        gui_state.paths.sessions_dir.clone(),
        kernel_v2_service.clone(),
        Some(kernel_v2_service.fact_reader()),
        &recoverable_session_ids,
        &deletion_tombstones,
    )
    .expect("initialize Host services with operating-system authority entropy");
    let gui = Arc::new(Mutex::new(gui_state));
    let kernel_v2 = crate::kernel_v2_transport::KernelV2TransportState::new(
        kernel_v2_service,
        host_services.workspace.resolver_v2(),
        Arc::new(GuiRunSettingsResolverV2 {
            gui: Arc::clone(&gui),
        }),
        host_services.session_kernel_v2.clone(),
    )
    .expect("initialize Kernel v2 transport");
    if let Ok(port_kind) = std::env::var("DEEPCODE_DAEMON_IPC_V2_PORT") {
        let port = match port_kind.as_str() {
            "session-command" => {
                let capability = std::env::var("DEEPCODE_KERNEL_V2_RUN_CAPABILITY")
                    .ok()
                    .and_then(|value| deepcode_kernel_abi::RunCapabilityV2::new(value).ok())
                    .expect("session-command IPC requires a valid private Run capability");
                crate::kernel_v2_ipc::KernelV2IpcPortV2::SessionCommand {
                    transport_run_capability: capability,
                }
            }
            "user-decision" => crate::kernel_v2_ipc::KernelV2IpcPortV2::UserDecision,
            _ => panic!("DEEPCODE_DAEMON_IPC_V2_PORT must be session-command or user-decision"),
        };
        crate::kernel_v2_ipc::KernelV2IpcDispatcher::new(kernel_v2)
            .serve_length_prefixed(&port, &mut io::stdin().lock(), &mut io::stdout().lock())
            .expect("serve framed Kernel v2 IPC");
        return;
    }
    let host_shell_authority =
        HostShellAuthorityV2::from_environment().expect("initialize Host shell admission");
    configure_host_process_identity_v2(addr).expect("initialize Host process identity");
    let kernel_v2_bridge_assets =
        crate::host_kernel_run_v2::HostKernelBridgeAssetsV2::resolve_at_daemon_start()
            .expect("resolve trusted Session Kernel v2 bridge assets");
    let kernel_session_v2 = crate::host_kernel_run_v2::HostKernelRunCoordinatorV2::new(
        host_services.clone(),
        kernel_v2.clone(),
        kernel_v2_bridge_assets,
        format!("http://{addr}"),
    )
    .expect("initialize Host-owned Session Kernel v2 coordinator");
    let kernel_wake_v2 = crate::host_kernel_wake_v2::HostKernelWakeSupervisorV2::new();
    let startup_readiness_v2 = crate::startup_readiness_v2::HostStartupReadinessV2::recovering();
    let state = AppState {
        kernel_v2,
        kernel_session_v2,
        kernel_wake_v2,
        startup_readiness_v2,
        host_shell_authority,
        gui,
        host_services,
        provider_trace_v1,
        private_analysis_v1,
        provider_cache_telemetry_v1,
        provider_trace_export_limiter_v1:
            crate::provider_trace_api::ProviderTraceExportLimiterV1::default(),
        terminal_runtime: Arc::new(Mutex::new(TerminalRuntime::new())),
        session_runs: Arc::new(Mutex::new(HashMap::new())),
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        Err(error) => {
            state
                .startup_readiness_v2
                .mark_failed("host_http_listener_bind_failed");
            let _ = shutdown_owned_host_resources_v2(&state).await;
            panic!("bind deepcode web host: {error}");
        }
    };
    let app = routes::build_app(state.clone());
    println!("DeepCode Kernel daemon listening on http://{addr}");
    let mut server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(wait_for_host_shutdown_v2())
            .await
    });
    tokio::task::yield_now().await;
    let startup = tokio::select! {
        startup = recover_host_startup_v2(
            &state,
            &recoverable_session_ids,
            &deletion_tombstones,
        ) => Some(startup),
        server_result = &mut server => {
            state
                .startup_readiness_v2
                .mark_failed("host_http_server_ended_during_startup");
            let _ = shutdown_owned_host_resources_v2(&state).await;
            if host_shutdown_requested_v2() {
                return;
            }
            panic!("Kernel daemon server ended during startup recovery: {server_result:?}");
        }
    };
    if host_shutdown_requested_v2() {
        let _ = server.await;
        return;
    }
    match startup.expect("startup branch returns a result") {
        Ok(()) => {
            if let Err(message) = state.startup_readiness_v2.mark_ready() {
                state
                    .startup_readiness_v2
                    .mark_failed("host_startup_readiness_transition_failed");
                let _ = shutdown_owned_host_resources_v2(&state).await;
                request_host_shutdown_v2();
                let _ = server.await;
                panic!("Host startup readiness transition failed: {message}");
            }
        }
        Err(failure) => {
            state.startup_readiness_v2.mark_failed(failure.code.clone());
            let _ = shutdown_owned_host_resources_v2(&state).await;
            request_host_shutdown_v2();
            if tokio::time::timeout(Duration::from_secs(5), &mut server)
                .await
                .is_err()
            {
                server.abort();
                let _ = server.await;
            }
            panic!(
                "Host startup recovery failed [{}]: {}",
                failure.code, failure.message
            );
        }
    }
    match server.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = shutdown_owned_host_resources_v2(&state).await;
            panic!("serve kernel daemon: {error}");
        }
        Err(error) => {
            let _ = shutdown_owned_host_resources_v2(&state).await;
            panic!("Kernel daemon server owner failed: {error}");
        }
    }
}

#[derive(Debug)]
pub(crate) struct DaemonSecretProvider {
    values: HashMap<String, String>,
}

impl deepcode_kernel_runtime::executors::SecretProvider for DaemonSecretProvider {
    fn resolve(&self, secret_ref: &str) -> Option<String> {
        let key = secret_ref
            .strip_prefix("local-secret:")
            .unwrap_or(secret_ref);
        self.values.get(key).cloned()
    }
}

pub(crate) fn runtime_tool_configuration(
    gui: &GuiState,
) -> (
    deepcode_kernel_runtime::executors::KernelExecutorConfig,
    DaemonSecretProvider,
) {
    runtime_tool_configuration_for_settings(&gui.user_settings, &gui.paths.llm_secrets_path)
}

pub(crate) fn runtime_tool_configuration_for_settings(
    settings: &Value,
    secrets_path: &FsPath,
) -> (
    deepcode_kernel_runtime::executors::KernelExecutorConfig,
    DaemonSecretProvider,
) {
    let secret_store = read_json_file(&secrets_path.to_path_buf()).unwrap_or_else(|| json!({}));
    runtime_tool_configuration_from_values(settings, &secret_store)
}

pub(crate) fn runtime_tool_configuration_from_values(
    settings: &Value,
    secret_store: &Value,
) -> (
    deepcode_kernel_runtime::executors::KernelExecutorConfig,
    DaemonSecretProvider,
) {
    let setting = |key: &str| settings.get(key).and_then(Value::as_str).unwrap_or("");
    let secret_values = secret_store
        .as_object()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|secret| (key, secret.to_string())))
        .collect();
    (
        deepcode_kernel_runtime::executors::KernelExecutorConfig {
            web_search_endpoint_template: setting("agent.web.search.endpointTemplate").to_string(),
            web_search_auth_header_name: setting("agent.web.search.authHeaderName").to_string(),
            web_search_auth_secret_ref: setting("agent.web.search.authSecretRef").to_string(),
        },
        DaemonSecretProvider {
            values: secret_values,
        },
    )
}

fn kernel_v2_settings_ceiling(gui: &GuiState) -> deepcode_kernel_runtime::v2::SettingsCeilingV2 {
    kernel_v2_settings_ceiling_from_value(&gui.user_settings)
}

pub(crate) fn kernel_v2_settings_ceiling_from_value(
    settings: &Value,
) -> deepcode_kernel_runtime::v2::SettingsCeilingV2 {
    let permission_enabled =
        |key: &str, default_enabled: bool| match settings.get(key).and_then(Value::as_str) {
            Some("allow" | "ask") => true,
            Some(_) => false,
            None => default_enabled,
        };
    deepcode_kernel_runtime::v2::SettingsCeilingV2 {
        workspace_read: permission_enabled("agent.permissions.workspaceRead", true),
        workspace_write: permission_enabled("agent.permissions.workspaceWrite", true),
        web_read: permission_enabled("agent.permissions.webRead", false),
        auto_approve_plans: settings
            .get("agent.permissions.autoApprovePlans")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

#[derive(Clone)]
struct GuiRunSettingsResolverV2 {
    gui: Arc<Mutex<GuiState>>,
}

impl crate::kernel_v2_transport::HostRunSettingsResolverV2 for GuiRunSettingsResolverV2 {
    fn resolve_run_settings(
        &self,
        _workspace_binding_ref: &deepcode_kernel_abi::WorkspaceBindingRefV2,
    ) -> Result<
        deepcode_kernel_runtime::v2::SettingsCeilingV2,
        crate::host_workspace_registry_v2::HostWorkspaceResolveErrorV2,
    > {
        self.gui
            .lock()
            .map(|gui| kernel_v2_settings_ceiling(&gui))
            .map_err(|_| {
                crate::host_workspace_registry_v2::HostWorkspaceResolveErrorV2::Unavailable
            })
    }
}
