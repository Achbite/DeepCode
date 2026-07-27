mod agent_api;
mod agent_bridge;
mod agent_run_projection;
mod agent_session_api;
mod agent_session_state;
mod agent_timeline;
mod api_response;
mod browser_api;
mod event_projection;
mod ipc;
mod kernel_api;
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
pub(crate) use agent_run_projection::*;
pub(crate) use agent_session_api::*;
pub(crate) use agent_session_state::*;
pub(crate) use agent_timeline::*;
pub(crate) use api_response::*;
pub(crate) use browser_api::*;
pub(crate) use event_projection::*;
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
    let mut runtime = if let Some(path) = kernel_ledger_path() {
        DeepCodeKernelRuntime::with_ndjson_ledger(path)
    } else {
        DeepCodeKernelRuntime::new()
    };
    let gui_state = GuiState::new();
    configure_runtime_tools(&mut runtime, &gui_state);
    let state = AppState {
        runtime: Arc::new(Mutex::new(runtime)),
        gui: Arc::new(Mutex::new(gui_state)),
        terminal_runtime: Arc::new(Mutex::new(TerminalRuntime::new())),
        kernel_events: Arc::new(Mutex::new(Vec::new())),
        session_runs: Arc::new(Mutex::new(HashMap::new())),
        session_run_deltas: Arc::new(Mutex::new(HashMap::new())),
        projection_delivery: Arc::new(Mutex::new(ProjectionDeliveryBufferState::default())),
    };
    discover_session_run_recovery(&state);
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
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
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
