mod agent_api;
mod agent_timeline;
mod api_response;
mod browser_api;
mod event_projection;
mod git_api;
mod ipc;
mod kernel_api;
mod llm_transport;
mod prelude;
mod routes;
mod session_store;
mod settings_api;
mod skill_api;
mod state;
mod static_assets;
mod terminal_api;
mod utils;
mod workspace_api;

use crate::prelude::*;

pub(crate) use agent_api::*;
pub(crate) use agent_timeline::*;
pub(crate) use api_response::*;
pub(crate) use browser_api::*;
pub(crate) use event_projection::*;
pub(crate) use git_api::*;
pub(crate) use ipc::*;
pub(crate) use kernel_api::*;
pub(crate) use llm_transport::*;
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
    let runtime = if let Some(path) = kernel_ledger_path() {
        DeepCodeKernelRuntime::with_ndjson_ledger(path)
    } else {
        DeepCodeKernelRuntime::new()
    };
    let state = AppState {
        runtime: Arc::new(Mutex::new(runtime)),
        gui: Arc::new(Mutex::new(GuiState::new())),
        terminal_runtime: Arc::new(Mutex::new(TerminalRuntime::new())),
        kernel_events: Arc::new(Mutex::new(Vec::new())),
        session_runs: Arc::new(Mutex::new(HashMap::new())),
        session_run_deltas: Arc::new(Mutex::new(HashMap::new())),
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
