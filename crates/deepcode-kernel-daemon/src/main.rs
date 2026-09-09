mod api_response;
mod browser_api;
mod config_root_lease;
mod conversation_api;
mod conversation_catalog;
mod host_connection;
mod host_inspection;
mod host_services;
mod host_shutdown;
mod kernel_api;
mod llm_provider_transport;
mod llm_stream_parser;
mod llm_transport;
mod local_agent_api;
mod local_agent_first_party_plugins;
mod local_agent_kernel;
mod local_agent_mcp;
mod local_agent_plugins;
mod local_agent_product_tools;
mod local_agent_provider_runtime;
mod local_agent_store;
mod local_agent_tool_catalog;
mod local_agent_tool_prompts;
mod prelude;
mod routes;
mod session_service;
mod settings_api;
mod state;
mod terminal_api;
mod terminal_runtime;
mod utils;
mod workspace_api;

use crate::prelude::*;

pub(crate) use api_response::*;
pub(crate) use browser_api::*;
pub(crate) use config_root_lease::*;
pub(crate) use conversation_api::*;
pub(crate) use host_connection::*;
pub(crate) use host_services::*;
pub(crate) use host_shutdown::*;
pub(crate) use kernel_api::*;
pub(crate) use llm_provider_transport::*;
pub(crate) use llm_stream_parser::*;
pub(crate) use llm_transport::*;
pub(crate) use local_agent_api::*;
pub(crate) use session_service::*;
pub(crate) use settings_api::*;
pub(crate) use state::*;
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
        "DeepCode 本地 daemon 只监听 loopback"
    );

    let gui_state = GuiState::open().expect("打开当前配置根");
    let session_store_path = gui_state.paths.session_store_path.clone();
    let tool_record_store_path = gui_state.paths.tool_record_store_path.clone();
    let user_settings = gui_state.user_settings.clone();
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|error| panic!("无法绑定 DeepCode 本地 daemon：{error}"));
    let addr = listener.local_addr().expect("读取 Host 监听地址");
    let gui = Arc::new(Mutex::new(gui_state));
    let workspace_resolver = Arc::new(crate::local_agent_kernel::HostWorkspaceResolver::new(
        gui.clone(),
    ));
    let local_agent = LocalAgentRuntime::open(
        &session_store_path,
        &tool_record_store_path,
        workspace_resolver,
        &user_settings,
    )
    .expect("打开本地 Agent Runtime");
    let session_service = match SessionServiceProcess::spawn(
        &format!("http://{addr}"),
        local_agent.service_token(),
    ) {
        Ok(service) => service,
        Err(error) => {
            let _ = local_agent.shutdown_plugins();
            panic!("启动长驻 Session Service 失败：{error:?}");
        }
    };
    let host_connection =
        HostConnection::from_environment().expect("初始化 Host Shell 本地连接凭证");
    configure_host_process_identity(addr).expect("初始化 Host 进程身份");
    let state = AppState {
        local_agent,
        session_service,
        host_connection,
        gui,
        host_services: HostServices::new(),
        terminal_runtime: Arc::new(Mutex::new(TerminalRuntime::new())),
    };
    let app = routes::build_app(state.clone());
    // Host bootstrap publishes transport credentials while the config-root lease
    // is held. Shells attach to this instance; they never copy Session state.
    let _connection_publication = deepcode_host_connection::LocalHostConnection::new(
        host_process_identity().clone(),
        std::env::var(HOST_SHELL_TOKEN_ENV).expect("Host shell token"),
    )
    .and_then(|connection| connection.publish(&user_config_root()))
    .expect("发布共享 Host 本地连接");
    println!("DeepCode local Agent daemon listening on http://{addr}");
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_host_shutdown())
        .await;
    let cleanup_complete = shutdown_owned_host_resources(&state).await;
    assert!(cleanup_complete, "DeepCode 本地资源未完整回收");
    if let Err(error) = result {
        panic!("DeepCode 本地 daemon 运行失败：{error}");
    }
}

#[derive(Debug, Clone)]
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
) -> Result<
    (
        deepcode_kernel_runtime::executors::KernelExecutorConfig,
        DaemonSecretProvider,
    ),
    String,
> {
    let settings = &gui.user_settings;
    let setting = |key: &str| -> Result<&str, String> {
        match settings.get(key) {
            Some(Value::String(value)) => Ok(value),
            Some(_) => Err(format!("{key} 必须是字符串。")),
            None => Ok(""),
        }
    };
    let secret_store = match read_optional_json_file(&gui.paths.llm_secrets_path)? {
        Some(value) if llm_secret_store_is_current(&value) => value,
        Some(_) => return Err("本地 LLM secret 文件不是当前字符串映射格式。".to_string()),
        None => json!({}),
    };
    let secret_values: HashMap<String, String> = secret_store
        .as_object()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(key, value)| value.as_str().map(|secret| (key, secret.to_string())))
        .collect();
    Ok((
        deepcode_kernel_runtime::executors::KernelExecutorConfig {
            web_search_endpoint_template: setting("agent.web.search.endpointTemplate")?.to_string(),
            web_search_auth_header_name: setting("agent.web.search.authHeaderName")?.to_string(),
            web_search_auth_secret_ref: setting("agent.web.search.authSecretRef")?.to_string(),
        },
        DaemonSecretProvider {
            values: secret_values,
        },
    ))
}
