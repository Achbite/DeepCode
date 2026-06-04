mod agent_api;
mod agent_loop;
mod api_response;
mod browser_api;
mod event_projection;
mod ipc;
mod kernel_api;
mod llm_transport;
mod prelude;
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
pub(crate) use agent_loop::*;
pub(crate) use api_response::*;
pub(crate) use browser_api::*;
pub(crate) use event_projection::*;
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
        kernel_events: Arc::new(Mutex::new(Vec::new())),
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
    let mut app = Router::new()
        .route("/", get(gui_index))
        .route("/index.html", get(gui_index))
        .route("/assets/*asset_path", get(gui_asset))
        .route("/api/health", get(health))
        .route("/api/kernel/commands", post(kernel_commands))
        .route("/api/kernel/snapshot", get(kernel_snapshot))
        .route("/api/kernel/events/stream", get(kernel_events_stream))
        .route("/api/session-store/index", get(session_store_index))
        .route(
            "/api/session-store/:session_id/projection",
            get(session_store_projection_get).post(session_store_projection_append),
        )
        .route(
            "/api/session-store/:session_id/transcript",
            get(session_store_transcript_get).post(session_store_transcript_append),
        )
        .route(
            "/api/session-store/:session_id/archive",
            get(session_store_archive_get),
        )
        .route(
            "/api/session-store/:session_id/archive/file",
            get(session_store_archive_file_get),
        )
        .route("/api/workspaces/current", get(workspace_current))
        .route("/api/workspaces/open", post(workspace_open))
        .route("/api/workspaces/save-file", post(workspace_save_file))
        .route(
            "/api/workspaces/current/settings",
            patch(workspace_patch_settings),
        )
        .route("/api/fs/initial-locations", get(fs_initial_locations))
        .route("/api/fs/browse", get(fs_browse))
        .route("/api/skills/scan-mount", post(skill_mount_scan))
        .route("/api/files/tree", get(file_tree))
        .route("/api/files/read", get(file_read))
        .route("/api/files/write", post(file_write))
        .route("/api/files/create", post(file_create))
        .route("/api/files/delete", post(file_delete))
        .route("/api/files/rename", post(file_rename))
        .route("/api/folders/create", post(folder_create))
        .route(
            "/api/user-settings",
            get(user_settings_get).patch(user_settings_patch),
        )
        .route(
            "/api/llm/profiles",
            get(llm_profiles_get).patch(llm_profiles_patch),
        )
        .route("/api/llm/probe", post(llm_probe))
        .route("/api/llm/chat", post(llm_chat))
        .route("/api/code/search", post(code_search))
        .route("/api/runtime/shell", get(runtime_shell))
        .route("/api/terminal/capabilities", get(terminal_capabilities))
        .route(
            "/api/terminal/warmup",
            get(terminal_warmup).post(terminal_warmup),
        )
        .route(
            "/api/terminal/sessions",
            get(terminal_sessions).post(terminal_create_session),
        )
        .route(
            "/api/terminal/sessions/:session_id/input",
            post(terminal_input),
        )
        .route(
            "/api/terminal/sessions/:session_id/resize",
            post(terminal_resize),
        )
        .route(
            "/api/terminal/sessions/:session_id/restart",
            post(terminal_restart),
        )
        .route(
            "/api/terminal/sessions/:session_id",
            patch(terminal_update).delete(terminal_delete),
        )
        .route("/api/terminal/events", get(terminal_events))
        .route(
            "/api/agent/sessions",
            get(agent_sessions_list).post(agent_session_create),
        )
        .route("/api/agent/sessions/current", get(agent_session_current))
        .route(
            "/api/agent/sessions/:session_id/activate",
            post(agent_session_activate),
        )
        .route(
            "/api/agent/sessions/:session_id/archive",
            post(agent_session_archive),
        )
        .route(
            "/api/agent/sessions/:session_id/events",
            post(agent_session_append_events),
        )
        .route(
            "/api/agent/sessions/:session_id/messages",
            post(agent_session_send_message),
        )
        .route(
            "/api/agent/sessions/:session_id/cancel",
            post(agent_session_cancel),
        )
        .route(
            "/api/agent/sessions/:session_id/trace",
            get(agent_session_trace),
        )
        .route(
            "/api/agent/sessions/:session_id",
            patch(agent_session_rename),
        )
        .route(
            "/api/agent/permissions/:permission_id/resolve",
            post(agent_permission_resolve),
        )
        .route("/api/agent/feedback", post(agent_feedback))
        .route(
            "/api/agent/workflow-config",
            get(agent_workflow_config_get).patch(agent_workflow_config_patch),
        )
        .route("/api/agent/parse-actions", post(agent_parse_actions))
        .route("/api/agent/fixtures/run", post(agent_fixture_run))
        .route("/api/agent/prompt-layers", get(agent_prompt_layers))
        .route("/api/agent/tools", get(agent_tools))
        .route("/api/agent/skills", get(agent_tools))
        .route("/api/agent/tools/execute", post(agent_tool_execute))
        .route("/api/browser/runtime-status", get(browser_status))
        .route("/api/browser/open", post(browser_open))
        .route("/api/browser/reload", post(browser_reload))
        .route("/api/browser/inspect-mode", post(browser_inspect_mode))
        .route("/api/browser/panel-snapshot", get(browser_panel_snapshot))
        .route(
            "/api/browser/panel-snapshot/attach",
            post(browser_attach_snapshot),
        )
        .route("/api/*path", any(api_not_implemented));
    if let Some(client_dist) = client_dist_dir() {
        let index_path = client_dist.join("index.html");
        app = app.fallback_service(
            ServeDir::new(client_dist.clone()).not_found_service(ServeFile::new(index_path)),
        );
        println!(
            "DeepCode daemon GUI assets served from {}",
            client_dist.display()
        );
    }
    let app = app.with_state(state).layer(localhost_cors_layer());
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
