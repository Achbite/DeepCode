mod agent_api;
mod agent_bridge;
mod agent_kernel_v2;
mod agent_run_projection;
mod agent_session_api;
mod agent_session_state;
mod agent_timeline;
mod api_response;
mod browser_api;
mod decision_capability_v2;
mod event_projection;
mod goal_api;
mod host_inspection;
mod host_kernel_operation_store_v2;
mod host_kernel_run_v2;
mod host_run_broker_v2;
mod host_services;
mod host_v2_storage;
mod host_workspace_registry_v2;
mod ipc;
mod kernel_api;
mod kernel_v2_ipc;
mod kernel_v2_transport;
mod llm_provider_transport;
mod llm_stream_parser;
mod llm_transport;
mod prelude;
mod project_store;
mod projection_delivery;
mod routes;
mod session_archive;
mod session_archive_render;
mod session_fact_lineage;
mod session_kernel_v2_store;
mod session_memory_store;
mod session_store;
mod settings_api;
mod skill_api;
mod state;
mod static_assets;
mod terminal_api;
mod terminal_runtime;
mod utils;
mod workspace_api;

use crate::prelude::*;

pub(crate) use agent_api::*;
pub(crate) use agent_bridge::*;
pub(crate) use agent_kernel_v2::*;
pub(crate) use agent_run_projection::*;
pub(crate) use agent_session_api::*;
pub(crate) use agent_session_state::*;
pub(crate) use agent_timeline::*;
pub(crate) use api_response::*;
pub(crate) use browser_api::*;
pub(crate) use event_projection::*;
pub(crate) use goal_api::*;
pub(crate) use host_services::*;
pub(crate) use ipc::*;
pub(crate) use kernel_api::*;
pub(crate) use llm_provider_transport::*;
pub(crate) use llm_stream_parser::*;
pub(crate) use llm_transport::*;
pub(crate) use project_store::*;
pub(crate) use projection_delivery::*;
pub(crate) use session_archive::*;
pub(crate) use session_archive_render::*;
pub(crate) use session_fact_lineage::*;
pub(crate) use session_kernel_v2_store::*;
pub(crate) use session_memory_store::*;
pub(crate) use session_store::*;
pub(crate) use settings_api::*;
pub(crate) use skill_api::*;
pub(crate) use state::*;
pub(crate) use static_assets::*;
pub(crate) use terminal_api::*;
pub(crate) use utils::*;
pub(crate) use workspace_api::*;

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
    let mut runtime = if let Some(path) = kernel_ledger_path() {
        DeepCodeKernelRuntime::with_ndjson_ledger(path)
    } else {
        DeepCodeKernelRuntime::new()
    };
    let gui_state = GuiState::new();
    configure_runtime_tools(&mut runtime, &gui_state);
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
    let host_services = HostServices::from_projects(
        &gui_state.projects,
        gui_state.paths.sessions_dir.clone(),
        kernel_v2_service.clone(),
        Some(kernel_v2_service.fact_reader()),
    );
    let gui = Arc::new(Mutex::new(gui_state));
    let (kernel_v2_host_authority, kernel_v2_host_capability) =
        crate::kernel_v2_transport::HostTransportAuthorityV2::new_pair()
            .expect("initialize Host-only Kernel v2 transport authority");
    let kernel_v2 = crate::kernel_v2_transport::KernelV2TransportState::new(
        kernel_v2_service,
        host_services.workspace.resolver_v2(),
        Arc::new(GuiRunSettingsResolverV2 {
            gui: Arc::clone(&gui),
        }),
        kernel_v2_host_authority,
    )
    .expect("initialize Kernel v2 transport");
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
    if let Err(error) = kernel_session_v2.reconcile_startup().await {
        host_services
            .active_runs_v2
            .record_startup_error(error.code);
    }
    let state = AppState {
        runtime: Arc::new(Mutex::new(runtime)),
        kernel_v2,
        kernel_session_v2,
        kernel_v2_host_capability,
        gui,
        host_services,
        terminal_runtime: Arc::new(Mutex::new(TerminalRuntime::new())),
        kernel_events: Arc::new(Mutex::new(Vec::new())),
        session_runs: Arc::new(Mutex::new(HashMap::new())),
        session_run_deltas: Arc::new(Mutex::new(HashMap::new())),
        projection_delivery: Arc::new(Mutex::new(ProjectionDeliveryBufferState::default())),
    };
    if std::env::var("DEEPCODE_DAEMON_IPC_STDIO")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        if std::env::var("DEEPCODE_DAEMON_IPC_FRAMED")
            .map(|value| value == "1")
            .unwrap_or(false)
        {
            run_length_prefixed_ipc(state);
        } else {
            run_stdio_ipc(state);
        }
        return;
    }
    let app = routes::build_app(state);
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind deepcode web host");
    println!("DeepCode Kernel daemon listening on http://{addr}");
    println!("Open DeepCode GUI at http://{addr}/");
    axum::serve(listener, app)
        .await
        .expect("serve kernel daemon");
}

#[derive(Debug)]
struct DaemonSecretProvider {
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

fn configure_runtime_tools(runtime: &mut DeepCodeKernelRuntime, gui: &GuiState) {
    let (config, secrets) = runtime_tool_configuration(gui);
    runtime.configure_tool_runtime(config, Arc::new(secrets));
}

fn runtime_tool_configuration(
    gui: &GuiState,
) -> (
    deepcode_kernel_runtime::executors::KernelExecutorConfig,
    DaemonSecretProvider,
) {
    let setting = |key: &str| {
        gui.user_settings
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    let secret_values = read_json_file(&gui.paths.llm_secrets_path)
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|secret| (key, secret.to_string())))
        .collect();
    (
        deepcode_kernel_runtime::executors::KernelExecutorConfig {
            web_search_endpoint_template: setting("agent.web.search.endpointTemplate").to_string(),
            web_search_auth_header_name: setting("agent.web.search.authHeaderName").to_string(),
            web_search_auth_secret_ref: setting("agent.web.search.authSecretRef").to_string(),
            web_read_permission: permission_mode_setting(setting("agent.permissions.webRead")),
            private_web_read_permission: permission_mode_setting(setting(
                "agent.permissions.privateWebRead",
            )),
        },
        DaemonSecretProvider {
            values: secret_values,
        },
    )
}

fn permission_mode_setting(value: &str) -> deepcode_kernel_tools::ToolPermissionMode {
    match value {
        "allow" => deepcode_kernel_tools::ToolPermissionMode::Allow,
        "deny" => deepcode_kernel_tools::ToolPermissionMode::Deny,
        _ => deepcode_kernel_tools::ToolPermissionMode::Ask,
    }
}

fn kernel_v2_settings_ceiling(gui: &GuiState) -> deepcode_kernel_runtime::v2::SettingsCeilingV2 {
    let permission_enabled =
        |key: &str, default_enabled: bool| match gui.user_settings.get(key).and_then(Value::as_str)
        {
            Some("deny") => false,
            Some(_) => true,
            None => default_enabled,
        };
    deepcode_kernel_runtime::v2::SettingsCeilingV2 {
        workspace_read: permission_enabled("agent.permissions.workspaceRead", true),
        workspace_write: permission_enabled("agent.permissions.workspaceWrite", true),
        git_write: permission_enabled("agent.permissions.gitWrite", false),
        web_read: permission_enabled("agent.permissions.webRead", false),
        private_web_read: permission_enabled("agent.permissions.privateWebRead", false),
        auto_approve_plans: gui
            .user_settings
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
