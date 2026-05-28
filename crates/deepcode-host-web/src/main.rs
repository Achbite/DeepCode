use axum::extract::{Path, Query, State};
use axum::http::{header, Method};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post};
use axum::{Json, Router};
use deepcode_kernel_abi::{
    KernelCommand, KernelErrorEnvelope, KernelEvent, KernelSnapshot, RequestId, WorkspaceBinding,
};
use deepcode_kernel_runtime::DeepCodeKernelRuntime;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tower_http::services::{ServeDir, ServeFile};

#[derive(Clone)]
struct AppState {
    runtime: Arc<Mutex<DeepCodeKernelRuntime>>,
    gui: Arc<Mutex<GuiState>>,
    kernel_events: Arc<Mutex<Vec<KernelEvent>>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiResponse {
    ok: bool,
    data: Option<Value>,
    error: Option<String>,
    message: Option<String>,
}

impl ApiResponse {
    fn ok(data: Value) -> Json<Self> {
        Json(Self {
            ok: true,
            data: Some(data),
            error: None,
            message: None,
        })
    }

    fn error(code: impl Into<String>, message: impl Into<String>) -> Json<Self> {
        Json(Self {
            ok: false,
            data: None,
            error: Some(code.into()),
            message: Some(message.into()),
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KernelCommandEnvelope {
    request_id: Option<String>,
    command: KernelCommand,
    idempotency_key: Option<String>,
    expected_snapshot_seq: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct KernelReply {
    ok: bool,
    events: Vec<KernelEvent>,
    snapshot: Option<KernelSnapshot>,
    error: Option<KernelErrorEnvelope>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KernelSnapshotQuery {
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KernelEventStreamQuery {
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenWorkspaceRequest {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileQuery {
    folder_id: Option<String>,
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileWriteRequest {
    folder_id: Option<String>,
    path: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileCreateRequest {
    folder_id: Option<String>,
    path: String,
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderCreateRequest {
    folder_id: Option<String>,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileDeleteRequest {
    folder_id: Option<String>,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileRenameRequest {
    folder_id: Option<String>,
    old_path: String,
    new_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchRequest {
    folder_id: Option<String>,
    query: String,
    include: Option<Vec<String>>,
    is_regex: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolExecuteRequest {
    workspace_binding: Option<WorkspaceBinding>,
    tool_call: ToolCallRequest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolCallRequest {
    id: Option<String>,
    name: String,
    arguments: Value,
}

#[derive(Debug, Clone)]
struct ResolvedLlmProfile {
    id: String,
    name: String,
    kind: String,
    base_url: Option<String>,
    model: String,
    max_output_tokens: Option<u32>,
    temperature: Option<f64>,
    reasoning_effort: Option<String>,
    thinking: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Clone)]
struct LlmToolDefinition {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Debug, Clone)]
struct LlmToolCall {
    id: String,
    name: String,
    arguments: Value,
}

#[derive(Debug, Clone, Default)]
struct LlmChatOutput {
    content: String,
    reasoning: Option<String>,
    tool_calls: Vec<LlmToolCall>,
}

#[derive(Debug, Clone)]
struct AgentRunRequest {
    content: String,
    workflow: String,
    profile_id: Option<String>,
    workspace_binding: Option<WorkspaceBinding>,
}

type SharedRuntime = Arc<Mutex<DeepCodeKernelRuntime>>;

#[derive(Debug)]
struct HostPaths {
    settings_path: PathBuf,
    llm_profiles_path: PathBuf,
    llm_secrets_path: PathBuf,
    workflow_config_path: PathBuf,
    sessions_dir: PathBuf,
}

#[derive(Debug)]
struct GuiState {
    paths: HostPaths,
    user_settings: Value,
    llm_profiles: Value,
    workflow_config: Value,
    sessions: Vec<Value>,
    current_session_id: Option<String>,
    session_projection_cache: HashMap<String, Vec<Value>>,
    trace_events: HashMap<String, Vec<Value>>,
    browser: BrowserState,
    terminals: Vec<Value>,
    terminal_events: HashMap<String, Vec<Value>>,
}

#[derive(Debug)]
struct BrowserState {
    current_url: Option<String>,
    inspect_state: String,
    snapshot: Option<Value>,
    attached: bool,
    last_action: Option<String>,
    last_action_at: Option<String>,
    last_action_result: Option<String>,
}

impl GuiState {
    fn new() -> Self {
        let paths = HostPaths::new();
        let user_settings =
            read_json_file(&paths.settings_path).unwrap_or_else(default_user_settings);
        let llm_profiles =
            read_json_file(&paths.llm_profiles_path).unwrap_or_else(default_llm_profiles);
        let workflow_config =
            read_json_file(&paths.workflow_config_path).unwrap_or_else(default_workflow_config);
        Self {
            paths,
            user_settings,
            llm_profiles,
            workflow_config,
            sessions: Vec::new(),
            current_session_id: None,
            session_projection_cache: HashMap::new(),
            trace_events: HashMap::new(),
            browser: BrowserState::default(),
            terminals: Vec::new(),
            terminal_events: HashMap::new(),
        }
    }
}

impl HostPaths {
    fn new() -> Self {
        let root = user_config_root();
        let settings_dir = root
            .join("config")
            .join("user")
            .join("local")
            .join("settings");
        let secrets_dir = root
            .join("config")
            .join("user")
            .join("local")
            .join("secrets");
        Self {
            settings_path: settings_dir.join("user-settings.json"),
            llm_profiles_path: settings_dir.join("llm-profiles.json"),
            llm_secrets_path: secrets_dir.join("llm-secrets.json"),
            workflow_config_path: settings_dir.join("agent-workflow-config.json"),
            sessions_dir: root.join("sessions"),
        }
    }
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            current_url: None,
            inspect_state: "off".to_string(),
            snapshot: None,
            attached: false,
            last_action: None,
            last_action_at: None,
            last_action_result: None,
        }
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("DEEPCODE_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
    let port = std::env::var("DEEPCODE_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(31245);
    let state = AppState {
        runtime: Arc::new(Mutex::new(DeepCodeKernelRuntime::new())),
        gui: Arc::new(Mutex::new(GuiState::new())),
        kernel_events: Arc::new(Mutex::new(Vec::new())),
    };
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
        .route("/api/workspaces/current", get(workspace_current))
        .route("/api/workspaces/open", post(workspace_open))
        .route("/api/workspaces/save-file", post(workspace_save_file))
        .route(
            "/api/workspaces/current/settings",
            patch(workspace_patch_settings),
        )
        .route("/api/fs/initial-locations", get(fs_initial_locations))
        .route("/api/fs/browse", get(fs_browse))
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
        println!("DeepCode GUI assets served from {}", client_dist.display());
    }
    let app = app.with_state(state);
    let addr: SocketAddr = format!("{host}:{port}").parse().expect("valid host/port");
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("bind deepcode web host");
    println!("DeepCode Rust web host listening on http://{addr}");
    println!("Open DeepCode GUI at http://{addr}/");
    axum::serve(listener, app).await.expect("serve web host");
}

fn client_dist_dir() -> Option<PathBuf> {
    let path = std::env::var_os("DEEPCODE_CLIENT_DIST").map(PathBuf::from)?;
    if path.join("index.html").is_file() {
        Some(path)
    } else {
        eprintln!(
            "DEEPCODE_CLIENT_DIST={} does not contain index.html; static GUI disabled",
            path.display()
        );
        None
    }
}

async fn health(State(state): State<AppState>) -> Json<ApiResponse> {
    let workspace = current_workspace_json(&state.runtime).unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "service": "deepcode-host-web",
        "status": "ok",
        "kernel": "ready",
        "workspace": workspace
    }))
}

async fn gui_index() -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let index_path = client_dist.join("index.html");
    match fs::read(index_path) {
        Ok(content) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache, no-store, must-revalidate"),
            ],
            content,
        )
            .into_response(),
        Err(error) => {
            ApiResponse::error("gui_index_unavailable", error.to_string()).into_response()
        }
    }
}

async fn gui_asset(Path(asset_path): Path<String>) -> Response {
    let Some(client_dist) = client_dist_dir() else {
        return ApiResponse::error(
            "gui_not_configured",
            "DEEPCODE_CLIENT_DIST is not configured",
        )
        .into_response();
    };
    let asset_root = client_dist.join("assets");
    let Some(relative_path) = safe_asset_path(&asset_path) else {
        return ApiResponse::error("invalid_asset_path", "Invalid asset path").into_response();
    };
    let requested_path = asset_root.join(&relative_path);
    if requested_path.is_file() {
        return serve_asset_file(&requested_path, false);
    }
    if asset_path.starts_with("heartbeatSocket-") && asset_path.ends_with(".js") {
        if let Some(current_heartbeat) = find_current_heartbeat_asset(&asset_root) {
            return serve_asset_file(&current_heartbeat, true);
        }
    }
    ApiResponse::error("asset_not_found", "Asset not found").into_response()
}

fn safe_asset_path(asset_path: &str) -> Option<PathBuf> {
    let path = FsPath::new(asset_path);
    if path.components().all(|component| {
        matches!(
            component,
            std::path::Component::Normal(_) | std::path::Component::CurDir
        )
    }) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

fn find_current_heartbeat_asset(asset_root: &FsPath) -> Option<PathBuf> {
    let entries = fs::read_dir(asset_root).ok()?;
    entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("heartbeatSocket-") && name.ends_with(".js"))
                .unwrap_or(false)
        })
}

fn serve_asset_file(path: &FsPath, disable_cache: bool) -> Response {
    match fs::read(path) {
        Ok(content) => (
            [
                (header::CONTENT_TYPE, asset_content_type(path)),
                (
                    header::CACHE_CONTROL,
                    if disable_cache {
                        "no-cache, no-store, must-revalidate"
                    } else {
                        "public, max-age=31536000, immutable"
                    },
                ),
            ],
            content,
        )
            .into_response(),
        Err(error) => ApiResponse::error("asset_unavailable", error.to_string()).into_response(),
    }
}

fn asset_content_type(path: &FsPath) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        _ => "application/octet-stream",
    }
}

async fn kernel_commands(
    State(state): State<AppState>,
    Json(body): Json<KernelCommandEnvelope>,
) -> Json<KernelReply> {
    let session_id = kernel_command_session_id(&body.command);
    let _request_id = body.request_id.as_deref();
    let _idempotency_key = body.idempotency_key.as_deref();
    let _expected_snapshot_seq = body.expected_snapshot_seq;

    let result = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime.dispatch(body.command)
    };

    match result {
        Ok(events) => {
            record_kernel_events(&state, &events);
            let snapshot = {
                let runtime = state.runtime.lock().expect("kernel runtime lock");
                runtime.snapshot(session_id.as_deref())
            };
            Json(KernelReply {
                ok: true,
                events,
                snapshot: Some(snapshot),
                error: None,
            })
        }
        Err(error) => Json(KernelReply {
            ok: false,
            events: Vec::new(),
            snapshot: None,
            error: Some(KernelErrorEnvelope::from(&error)),
        }),
    }
}

async fn kernel_snapshot(
    State(state): State<AppState>,
    Query(query): Query<KernelSnapshotQuery>,
) -> Json<KernelReply> {
    let snapshot = {
        let runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime.snapshot(query.session_id.as_deref())
    };
    Json(KernelReply {
        ok: true,
        events: Vec::new(),
        snapshot: Some(snapshot),
        error: None,
    })
}

async fn kernel_events_stream(
    State(state): State<AppState>,
    Query(query): Query<KernelEventStreamQuery>,
) -> Response {
    let events = {
        let events = state
            .kernel_events
            .lock()
            .expect("kernel event stream lock");
        events
            .iter()
            .filter(|event| {
                query
                    .session_id
                    .as_deref()
                    .map(|session_id| kernel_event_session_id(event).as_deref() == Some(session_id))
                    .unwrap_or(true)
            })
            .cloned()
            .collect::<Vec<_>>()
    };

    let mut body = String::new();
    if events.is_empty() {
        body.push_str(": deepcode kernel event stream ready\n\n");
    } else {
        for event in events {
            let data = serde_json::to_string(&event)
                .unwrap_or_else(|_| "{\"kind\":\"error\"}".to_string());
            body.push_str("event: kernel\n");
            body.push_str("data: ");
            body.push_str(&data);
            body.push_str("\n\n");
        }
    }

    (
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

async fn session_store_index(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "storeRoot": gui.paths.sessions_dir.to_string_lossy()
    }))
}

async fn session_store_projection_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let entries = session_projection(&state, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries,
        "events": entries
    }))
}

async fn session_store_projection_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let entries = body
        .get("entries")
        .or_else(|| body.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    append_session_projection(&state, &session_id, entries);
    let stored = session_projection(&state, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "appended": body
            .get("entries")
            .or_else(|| body.get("events"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default(),
        "entryCount": stored.len(),
        "entries": stored,
        "events": stored
    }))
}

async fn session_store_transcript_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let entries = read_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl");
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries
    }))
}

async fn session_store_transcript_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let entry = body.get("entry").cloned().unwrap_or(body);
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    match append_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl", &[entry]) {
        Ok(()) => {
            let entries = read_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl");
            ApiResponse::ok(json!({
                "sessionId": session_id,
                "entryCount": entries.len(),
                "entries": entries
            }))
        }
        Err(error) => ApiResponse::error("write_session_transcript_failed", error.to_string()),
    }
}

async fn workspace_current(State(state): State<AppState>) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceCurrent {
            request_id: rid("workspace-current"),
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn workspace_open(
    State(state): State<AppState>,
    Json(body): Json<OpenWorkspaceRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceOpen {
            request_id: rid("workspace-open"),
            path: body.path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn workspace_save_file(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let Ok(current) = current_workspace_json(&state.runtime) else {
        return ApiResponse::error("no_workspace", "current workspace is missing");
    };
    let Some(workspace) = current.get("current").filter(|value| !value.is_null()) else {
        return ApiResponse::error("no_workspace", "current workspace is missing");
    };
    let default_file_name = workspace
        .get("name")
        .and_then(Value::as_str)
        .map(workspace_file_name_from_label)
        .unwrap_or_else(|| "DeepCode.code-workspace".to_string());
    let file_name = match normalize_workspace_file_name(
        body.get("fileName")
            .and_then(Value::as_str)
            .unwrap_or(&default_file_name),
    ) {
        Ok(file_name) => file_name,
        Err(message) => return ApiResponse::error("invalid_workspace_file_name", message),
    };
    let folder_path = workspace
        .get("folders")
        .and_then(Value::as_array)
        .and_then(|folders| folders.first())
        .and_then(|folder| folder.get("absolutePath"))
        .or_else(|| {
            workspace
                .get("folders")
                .and_then(Value::as_array)
                .and_then(|folders| folders.first())
                .and_then(|folder| folder.get("path"))
        })
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let Some(folder_path) = folder_path else {
        return ApiResponse::error("no_workspace_folder", "current workspace folder is missing");
    };
    let workspace_file_path = folder_path.join(&file_name);
    let overwritten = workspace_file_path.exists();
    let content = json!({
        "folders": [{ "path": "." }],
        "settings": workspace.get("settings").cloned().unwrap_or_else(|| json!({}))
    });
    if let Err(error) = atomic_write_json(&workspace_file_path, &content) {
        return ApiResponse::error("write_workspace_file_failed", error);
    }
    let reopened = match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceOpen {
            request_id: rid("workspace-save-open"),
            path: workspace_file_path.to_string_lossy().to_string(),
        },
    ) {
        Ok(output) => output,
        Err(error) => return ApiResponse::error(error.code, error.message),
    };
    let workspace = reopened.get("workspace").cloned().unwrap_or(Value::Null);
    ApiResponse::ok(json!({
        "workspaceFilePath": workspace_file_path.to_string_lossy(),
        "workspace": workspace,
        "created": !overwritten,
        "overwritten": overwritten
    }))
}

async fn workspace_patch_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let settings = body.get("settings").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.user_settings, &settings);
    let write_result = atomic_write_json(&gui.paths.settings_path, &gui.user_settings);
    match write_result {
        Ok(()) => ApiResponse::ok(json!({ "settings": settings })),
        Err(error) => ApiResponse::error("write_settings_failed", error),
    }
}

async fn fs_initial_locations(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut locations = Vec::new();
    if let Some(home) = home_dir() {
        locations.push(json!({
            "label": "Home",
            "absolutePath": home.to_string_lossy(),
            "kind": "home"
        }));
    }
    for drive in drive_locations() {
        locations.push(json!({
            "label": drive.display,
            "absolutePath": drive.path.to_string_lossy(),
            "kind": "drive"
        }));
    }
    if let Ok(current) = current_workspace_json(&state.runtime) {
        if let Some(path) = current
            .get("current")
            .and_then(|workspace| workspace.get("folders"))
            .and_then(Value::as_array)
            .and_then(|folders| folders.first())
            .and_then(|folder| folder.get("absolutePath"))
            .or_else(|| {
                current
                    .get("current")
                    .and_then(|workspace| workspace.get("folders"))
                    .and_then(Value::as_array)
                    .and_then(|folders| folders.first())
                    .and_then(|folder| folder.get("path"))
            })
            .and_then(Value::as_str)
        {
            locations.push(json!({
                "label": "Current Workspace",
                "absolutePath": path,
                "kind": "workspace"
            }));
        }
    }
    ApiResponse::ok(json!({
        "platform": platform_id(),
        "locations": locations
    }))
}

async fn fs_browse(Query(query): Query<FileQuery>) -> Json<ApiResponse> {
    let path = query
        .path
        .map(PathBuf::from)
        .or_else(home_dir)
        .unwrap_or_else(|| PathBuf::from("/"));
    let target = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/"))
    };
    let entries = match sorted_dir_entries(&target) {
        Ok(entries) => entries
            .into_iter()
            .map(|entry| {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let is_dir = path.is_dir();
                json!({
                    "name": name,
                    "absolutePath": path.to_string_lossy(),
                    "type": if is_dir { "directory" } else { "file" },
                    "isCodeWorkspace": path.extension().and_then(|ext| ext.to_str()) == Some("code-workspace"),
                    "hidden": name.starts_with('.')
                })
            })
            .collect::<Vec<_>>(),
        Err(error) => return ApiResponse::error("browse_failed", format!("browse {}: {error}", target.display())),
    };
    ApiResponse::ok(json!({
        "absolutePath": target.to_string_lossy(),
        "parentPath": target.parent().map(|path| path.to_string_lossy().to_string()),
        "entries": entries
    }))
}

async fn file_tree(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceList {
            request_id: rid("workspace-list"),
            folder_id: query.folder_id,
            path: query.path,
            depth: Some(2),
        },
    ) {
        Ok(output) => {
            let nodes = output
                .get("nodes")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            ApiResponse::ok(nodes)
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn file_read(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> Json<ApiResponse> {
    let Some(path) = query.path else {
        return ApiResponse::error("invalid_request", "path is required");
    };
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceRead {
            request_id: rid("workspace-read"),
            folder_id: query.folder_id,
            path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn file_write(
    State(state): State<AppState>,
    Json(body): Json<FileWriteRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceWrite {
            request_id: rid("workspace-write"),
            folder_id: body.folder_id,
            path: body.path,
            content: body.content,
            create: true,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn file_create(
    State(state): State<AppState>,
    Json(body): Json<FileCreateRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceCreate {
            request_id: rid("workspace-create"),
            folder_id: body.folder_id,
            path: body.path,
            content: body.content,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn folder_create(
    State(state): State<AppState>,
    Json(body): Json<FolderCreateRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceCreateFolder {
            request_id: rid("workspace-create-folder"),
            folder_id: body.folder_id,
            path: body.path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn file_delete(
    State(state): State<AppState>,
    Json(body): Json<FileDeleteRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceDelete {
            request_id: rid("workspace-delete"),
            folder_id: body.folder_id,
            path: body.path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn file_rename(
    State(state): State<AppState>,
    Json(body): Json<FileRenameRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceRename {
            request_id: rid("workspace-rename"),
            folder_id: body.folder_id,
            old_path: body.old_path,
            new_path: body.new_path,
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn code_search(
    State(state): State<AppState>,
    Json(body): Json<SearchRequest>,
) -> Json<ApiResponse> {
    match dispatch_workspace(
        &state.runtime,
        KernelCommand::WorkspaceSearch {
            request_id: rid("workspace-search"),
            folder_id: body.folder_id,
            query: body.query,
            include: body.include,
            is_regex: body.is_regex.unwrap_or(false),
        },
    ) {
        Ok(output) => ApiResponse::ok(output),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

async fn user_settings_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "settings": gui.user_settings,
        "overriddenKeys": [],
        "storePath": gui.paths.settings_path.to_string_lossy()
    }))
}

async fn user_settings_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let patches = body.get("patches").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.user_settings, &patches);
    let changed_keys = patches
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    match atomic_write_json(&gui.paths.settings_path, &gui.user_settings) {
        Ok(()) => ApiResponse::ok(json!({
            "settings": gui.user_settings,
            "changedKeys": changed_keys
        })),
        Err(error) => ApiResponse::error("write_settings_failed", error),
    }
}

async fn llm_profiles_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let mut profiles = gui.llm_profiles.clone();
    if let Some(object) = profiles.as_object_mut() {
        object.insert(
            "storePath".to_string(),
            Value::String(gui.paths.llm_profiles_path.to_string_lossy().to_string()),
        );
    }
    ApiResponse::ok(profiles)
}

async fn llm_profiles_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let mut profiles = body.get("profiles").cloned().unwrap_or_else(|| json!([]));
    let secrets = body.get("secrets").cloned().unwrap_or_else(|| json!({}));
    let mut secret_store = read_json_file(&gui.paths.llm_secrets_path).unwrap_or_else(|| json!({}));
    if let (Some(profile_items), Some(secret_items), Some(secret_object)) = (
        profiles.as_array_mut(),
        secrets.as_object(),
        secret_store.as_object_mut(),
    ) {
        for profile in profile_items {
            let Some(profile_object) = profile.as_object_mut() else {
                continue;
            };
            let Some(profile_id) = profile_object
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            let Some(secret) = secret_items.get(&profile_id).and_then(Value::as_str) else {
                continue;
            };
            if secret.trim().is_empty() {
                continue;
            }
            secret_object.insert(profile_id.clone(), Value::String(secret.to_string()));
            profile_object.insert(
                "secretRef".to_string(),
                Value::String(format!("local-secret:{profile_id}")),
            );
        }
    }
    gui.llm_profiles = json!({
        "profiles": profiles,
        "defaultProfileId": body.get("defaultProfileId").cloned().unwrap_or(Value::Null),
        "storePath": gui.paths.llm_profiles_path.to_string_lossy()
    });
    if secret_store
        .as_object()
        .map(|object| !object.is_empty())
        .unwrap_or(false)
    {
        if let Err(error) = atomic_write_json(&gui.paths.llm_secrets_path, &secret_store) {
            return ApiResponse::error("write_llm_secret_failed", error);
        }
    }
    match atomic_write_json(&gui.paths.llm_profiles_path, &gui.llm_profiles) {
        Ok(()) => ApiResponse::ok(gui.llm_profiles.clone()),
        Err(error) => ApiResponse::error("write_llm_profiles_failed", error),
    }
}

async fn llm_probe(State(state): State<AppState>, Json(body): Json<Value>) -> Json<ApiResponse> {
    let started = now_millis();
    let profile_id = body
        .get("profileId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let profile = {
        let gui = state.gui.lock().expect("gui state lock");
        resolve_llm_profile(&gui, profile_id.as_deref())
    };
    let profile = match profile {
        Ok(profile) => profile,
        Err(error) => {
            return ApiResponse::ok(json!({
                "ok": false,
                "provider": "openaiCompatible",
                "error": error
            }));
        }
    };
    if llm_mock_enabled() {
        return ApiResponse::ok(json!({
            "ok": true,
            "provider": profile.kind,
            "model": profile.model,
            "latencyMs": now_millis().saturating_sub(started)
        }));
    }
    let output = call_llm_profile(
        &profile,
        json!({
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "tools": []
        }),
    )
    .await;
    match output {
        Ok(_) => ApiResponse::ok(json!({
            "ok": true,
            "provider": profile.kind,
            "model": profile.model,
            "latencyMs": now_millis().saturating_sub(started)
        })),
        Err(error) => ApiResponse::ok(json!({
            "ok": false,
            "provider": profile.kind,
            "model": profile.model,
            "latencyMs": now_millis().saturating_sub(started),
            "error": error
        })),
    }
}

async fn llm_chat(State(state): State<AppState>, Json(body): Json<Value>) -> Json<ApiResponse> {
    let profile_id = body
        .get("profileId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let profile = {
        let gui = state.gui.lock().expect("gui state lock");
        resolve_llm_profile(&gui, profile_id.as_deref())
    };
    let profile = match profile {
        Ok(profile) => profile,
        Err(error) => return ApiResponse::error("llm_profile_error", error),
    };
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let request_envelope = json!({
        "messages": messages,
        "tools": body.get("tools").cloned().unwrap_or_else(|| json!([]))
    });
    match call_llm_profile(&profile, request_envelope).await {
        Ok(output) => ApiResponse::ok(llm_output_payload(output)),
        Err(error) => ApiResponse::error("llm_chat_failed", error),
    }
}

async fn runtime_shell() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "os": std::env::consts::OS,
        "preferredShell": "bash",
        "agentUsesUnixCommands": true,
        "problems": []
    }))
}

async fn terminal_capabilities() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "defaultShell": "bash",
        "shells": ["bash"],
        "supportsPty": false,
        "agentUsesUnixCommands": true,
        "shell": {
            "os": std::env::consts::OS,
            "preferredShell": "bash",
            "available": false,
            "command": "bash",
            "args": [],
            "managedBy": "deepcode-kernel",
            "problems": [{
                "code": "terminal_runtime_reserved",
                "message": "Interactive terminal sessions are reserved until Kernel PTY runtime lands."
            }]
        }
    }))
}

async fn terminal_warmup() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "state": "ready",
        "defaultShell": "bash",
        "startedAt": null,
        "completedAt": now_text(),
        "message": "Kernel host is ready; interactive PTY is reserved.",
        "problems": []
    }))
}

async fn terminal_sessions(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({ "sessions": gui.terminals }))
}

async fn terminal_create_session(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = format!("term-{}", now_millis());
    let now = now_text();
    let session = json!({
        "id": id,
        "name": body.get("name").and_then(Value::as_str).unwrap_or("终端 1"),
        "shellKind": body.get("shellKind").and_then(Value::as_str).unwrap_or("bash"),
        "cwd": body.get("cwd").and_then(Value::as_str).unwrap_or("."),
        "status": "running",
        "createdAt": now,
        "updatedAt": now,
        "order": gui.terminals.len()
    });
    gui.terminal_events.insert(
        id.clone(),
        vec![json!({
            "id": format!("evt-{id}-ready"),
            "sessionId": id,
            "sequence": 1,
            "type": "ready",
            "data": "Kernel terminal placeholder ready.",
            "timestamp": now_text()
        })],
    );
    gui.terminals.push(session.clone());
    ApiResponse::ok(session)
}

async fn terminal_input(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let events = gui.terminal_events.entry(session_id.clone()).or_default();
    let sequence = events.len() + 1;
    events.push(json!({
        "id": format!("evt-{session_id}-{sequence}"),
        "sessionId": session_id,
        "sequence": sequence,
        "type": "stdout",
        "data": format!("terminal runtime reserved; received input: {}", body.get("data").and_then(Value::as_str).unwrap_or("")),
        "timestamp": now_text()
    }));
    terminal_session_by_id(&gui, &session_id)
}

async fn terminal_resize(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    terminal_session_by_id(&gui, &session_id)
}

async fn terminal_update(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(session) = gui
        .terminals
        .iter_mut()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
    {
        if let Some(name) = body.get("name").and_then(Value::as_str) {
            session["name"] = json!(name);
        }
        session["updatedAt"] = json!(now_text());
        return ApiResponse::ok(session.clone());
    }
    ApiResponse::error("terminal_not_found", "terminal session not found")
}

async fn terminal_restart(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    terminal_session_by_id(&gui, &session_id)
}

async fn terminal_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let mut deleted = None;
    gui.terminals.retain(|session| {
        if session.get("id").and_then(Value::as_str) == Some(session_id.as_str()) {
            deleted = Some(session.clone());
            false
        } else {
            true
        }
    });
    gui.terminal_events.remove(&session_id);
    deleted
        .map(ApiResponse::ok)
        .unwrap_or_else(|| ApiResponse::error("terminal_not_found", "terminal session not found"))
}

async fn terminal_events(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let events = query
        .get("sessionId")
        .and_then(|session_id| gui.terminal_events.get(session_id))
        .cloned()
        .unwrap_or_default();
    ApiResponse::ok(json!({ "events": events }))
}

async fn agent_sessions_list(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "currentSessionId": gui.current_session_id
    }))
}

async fn agent_session_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = format!("session-{}", now_millis());
    let now = now_text();
    let mode = body
        .get("mode")
        .or_else(|| body.get("initialMode"))
        .and_then(Value::as_str)
        .unwrap_or("plan");
    let session = json!({
        "id": id,
        "title": body.get("title").and_then(Value::as_str).unwrap_or("New Agent Session"),
        "mode": mode,
        "profileId": body.get("profileId").and_then(Value::as_str),
        "workspaceId": body.get("workspaceId").and_then(Value::as_str),
        "workspaceHash": body.get("workspaceHash").and_then(Value::as_str),
        "titleSource": "pending",
        "eventCount": 0,
        "createdAt": now,
        "updatedAt": now
    });
    gui.current_session_id = Some(id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session.clone());
    ApiResponse::ok(json!({ "session": session, "events": [] }))
}

async fn agent_session_current(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let Some(session_id) = gui.current_session_id.as_ref() else {
        return ApiResponse::ok(Value::Null);
    };
    session_result(&gui, session_id)
}

async fn agent_session_activate(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if has_session(&gui, &session_id) {
        gui.current_session_id = Some(session_id.clone());
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

async fn agent_session_rename(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if let Some(title) = body.get("title").and_then(Value::as_str) {
            session["title"] = json!(title);
            session["titleSource"] = json!("user");
        }
        session["updatedAt"] = json!(now_text());
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

async fn agent_session_archive(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if body
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        {
            session["archivedAt"] = json!(now_text());
        } else {
            session
                .as_object_mut()
                .map(|object| object.remove("archivedAt"));
        }
    }
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "currentSessionId": gui.current_session_id
    }))
}

async fn agent_session_append_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let incoming = body
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    gui.session_projection_cache
        .entry(session_id.clone())
        .or_default()
        .extend(incoming);
    update_session_event_count(&mut gui, &session_id);
    session_result(&gui, &session_id)
}

async fn agent_session_send_message(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    {
        let gui = state.gui.lock().expect("gui state lock");
        if !has_session(&gui, &session_id) {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        }
    }

    let request = build_agent_run_request(&body);
    let user_event = agent_event(
        &session_id,
        "user_msg",
        json!({
            "content": request.content,
            "attachments": body.get("attachments").cloned().unwrap_or_else(|| json!([])),
            "channel": "user",
            "visibility": "conversation"
        }),
        &now_text(),
    );
    append_session_projection(&state, &session_id, vec![user_event]);

    if let Err(error) = start_kernel_agent_run(&state, &session_id, request).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
    }

    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

async fn agent_session_cancel(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

async fn agent_session_trace(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    let events = gui
        .trace_events
        .get(&session_id)
        .cloned()
        .unwrap_or_default();
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "trace": {
            "sessionId": session_id,
            "events": events,
            "eventCount": events.len(),
            "updatedAt": now_text()
        }
    }))
}

async fn agent_permission_resolve(
    State(state): State<AppState>,
    Path(permission_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let decision = body
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("reject")
        .to_string();
    let kernel_decision = if decision == "accept" {
        deepcode_kernel_abi::PermissionDecisionKind::Accept
    } else {
        deepcode_kernel_abi::PermissionDecisionKind::Reject
    };
    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::PermissionResolve {
                request_id: rid("agent-permission-resolve"),
                permission_id: permission_id.clone(),
                decision: kernel_decision,
            })
            .unwrap_or_else(|error| {
                vec![KernelEvent::Error {
                    request_id: Some(rid("agent-permission-resolve")),
                    run_id: None,
                    session_id: None,
                    error: KernelErrorEnvelope::from(&error),
                    message_key: None,
                    args: None,
                }]
            })
    };
    let session_id = kernel_events
        .iter()
        .find_map(kernel_event_session_id)
        .or_else(|| {
            state
                .gui
                .lock()
                .expect("gui state lock")
                .current_session_id
                .clone()
        })
        .unwrap_or_else(|| "session-unknown".to_string());
    if let Err(error) = drive_kernel_agent_loop(&state, &session_id, kernel_events).await {
        append_session_projection(
            &state,
            &session_id,
            vec![agent_event(
                &session_id,
                "error",
                json!({
                    "message": error,
                    "channel": "error",
                    "visibility": "conversation"
                }),
                &now_text(),
            )],
        );
    }
    let gui = state.gui.lock().expect("gui state lock");
    if gui
        .sessions
        .iter()
        .any(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
    {
        session_result(&gui, &session_id)
    } else {
        ApiResponse::ok(json!({
            "sessionId": session_id,
            "events": gui
                .session_projection_cache
                .get(&session_id)
                .cloned()
                .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, &session_id))
        }))
    }
}

async fn agent_feedback() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "accepted": true,
        "message": "Feedback recorded by host compatibility layer."
    }))
}

async fn agent_workflow_config_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "config": gui.workflow_config,
        "storePath": gui.paths.workflow_config_path.to_string_lossy(),
        "initialized": true
    }))
}

async fn agent_workflow_config_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let config = body.get("config").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.workflow_config, &config);
    match atomic_write_json(&gui.paths.workflow_config_path, &gui.workflow_config) {
        Ok(()) => ApiResponse::ok(json!({
            "config": gui.workflow_config,
            "storePath": gui.paths.workflow_config_path.to_string_lossy(),
            "initialized": true
        })),
        Err(error) => ApiResponse::error("write_workflow_config_failed", error),
    }
}

async fn agent_parse_actions() -> Json<ApiResponse> {
    ApiResponse::ok(json!({ "actions": [], "errors": [] }))
}

async fn agent_fixture_run() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "parse": { "actions": [], "errors": [] },
        "observations": []
    }))
}

async fn agent_prompt_layers() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "layers": [{
            "id": "builtin-default",
            "kind": "builtin",
            "priority": 100,
            "contentHash": "builtin",
            "title": "Builtin default prompt"
        }]
    }))
}

async fn agent_tools(State(state): State<AppState>) -> Json<ApiResponse> {
    match dispatch_skill(
        &state.runtime,
        KernelCommand::SkillDiscover {
            request_id: rid("skill-discover"),
        },
    ) {
        Ok(output) => {
            let skills = output
                .get("skills")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let tools = skills
                .iter()
                .map(|skill| {
                    json!({
                        "name": skill.get("id").or_else(|| skill.get("name")).cloned().unwrap_or(Value::Null),
                        "description": skill.get("description").cloned().unwrap_or_else(|| json!("Kernel skill")),
                        "inputSchema": skill.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                        "riskLevel": skill.get("riskLevel").cloned().unwrap_or_else(|| json!("low")),
                        "needsApproval": skill.get("requiresApproval").cloned().unwrap_or_else(|| json!(false)),
                        "allowedModes": ["readOnly", "plan", "askBeforeWrite"]
                    })
                })
                .collect::<Vec<_>>();
            ApiResponse::ok(json!({
                "skills": skills,
                "tools": tools
            }))
        }
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

fn build_agent_run_request(body: &Value) -> AgentRunRequest {
    AgentRunRequest {
        content: body
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        workflow: body
            .get("workflow")
            .and_then(Value::as_str)
            .unwrap_or("planFirst")
            .to_string(),
        profile_id: body
            .get("profileId")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace_binding: body
            .get("workspaceBinding")
            .and_then(|value| serde_json::from_value(value.clone()).ok()),
    }
}

async fn start_kernel_agent_run(
    state: &AppState,
    session_id: &str,
    request: AgentRunRequest,
) -> Result<(), String> {
    let needs_workspace = request_mentions_local_workspace(&request.content);
    if needs_workspace {
        if let Err(error) =
            ensure_workspace_binding(&state.runtime, request.workspace_binding.as_ref())
        {
            append_session_projection(
                state,
                session_id,
                vec![assistant_final_event(
                    session_id,
                    &format!(
                        "当前没有可用工作区绑定：{}。请先打开一个文件夹或 .code-workspace 文件，再让 Agent 读取、搜索或修改文件。",
                        error.message
                    ),
                )],
            );
            return Ok(());
        }
    } else if let Some(binding) = request.workspace_binding.as_ref() {
        let _ = ensure_workspace_binding(&state.runtime, Some(binding));
    }

    let Some(binding) =
        effective_workspace_binding(&state.runtime, request.workspace_binding.clone())
    else {
        append_session_projection(
            state,
            session_id,
            vec![assistant_final_event(
                session_id,
                "当前没有可用工作区绑定。请先打开一个文件夹或 .code-workspace 文件，再让 Agent 读取、搜索或修改文件。",
            )],
        );
        return Ok(());
    };

    let kernel_events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: rid("agent-run-start"),
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                input: deepcode_kernel_abi::UserInput {
                    text: request.content.clone(),
                    attachments: Vec::new(),
                },
                workspace_binding: Some(binding),
                profile_ref: request.profile_id.as_ref().map(|id| {
                    deepcode_kernel_abi::ProfileRef {
                        id: id.clone(),
                        kind: Some("llm".to_string()),
                        hash: None,
                    }
                }),
                workflow_ref: Some(deepcode_kernel_abi::WorkflowRef {
                    id: request.workflow.clone(),
                    version: None,
                    hash: None,
                }),
                run_overrides: None,
            })
            .map_err(|error| error.to_string())?
    };
    drive_kernel_agent_loop(state, session_id, kernel_events).await
}

async fn drive_kernel_agent_loop(
    state: &AppState,
    session_id: &str,
    mut kernel_events: Vec<KernelEvent>,
) -> Result<(), String> {
    loop {
        record_kernel_events(state, &kernel_events);
        append_session_projection(
            state,
            session_id,
            kernel_events_to_agent_events(session_id, &kernel_events),
        );
        if kernel_events
            .iter()
            .any(|event| matches!(event, KernelEvent::PermissionRequested { .. }))
        {
            return Ok(());
        }
        let llm_requests = kernel_events
            .iter()
            .filter_map(|event| match event {
                KernelEvent::LlmCallRequested {
                    run_id,
                    session_id,
                    phase,
                    llm_call_id,
                    profile_ref,
                    request_envelope,
                    ..
                } => Some((
                    run_id.clone(),
                    session_id.clone(),
                    phase.clone(),
                    llm_call_id.clone(),
                    profile_ref.clone(),
                    request_envelope.clone(),
                )),
                _ => None,
            })
            .collect::<Vec<_>>();
        if llm_requests.is_empty() {
            return Ok(());
        }

        let mut next_events = Vec::new();
        for (run_id, event_session_id, phase, llm_call_id, profile_ref, request_envelope) in
            llm_requests
        {
            let profile = resolve_kernel_llm_profile(state, profile_ref.as_ref())?;
            append_trace_event(
                state,
                session_id,
                "llm.requested",
                json!({
                    "stage": phase,
                    "llmCallId": llm_call_id,
                    "profileId": profile.id,
                    "model": profile.model,
                    "toolCount": request_envelope
                        .get("tools")
                        .and_then(Value::as_array)
                        .map(|items| items.len())
                        .unwrap_or(0)
                }),
            );
            let output = call_llm_profile(&profile, request_envelope).await?;
            append_trace_event(
                state,
                session_id,
                "llm.completed",
                json!({
                    "stage": phase,
                    "llmCallId": llm_call_id,
                    "profileId": profile.id,
                    "contentBytes": output.content.len(),
                    "toolCallCount": output.tool_calls.len()
                }),
            );
            let response_envelope = llm_output_payload(output);
            let submitted = {
                let mut runtime = state.runtime.lock().expect("kernel runtime lock");
                runtime
                    .dispatch(KernelCommand::LlmResponseSubmit {
                        request_id: rid("llm-response-submit"),
                        run_id,
                        session_id: event_session_id,
                        llm_call_id,
                        response_envelope,
                    })
                    .map_err(|error| error.to_string())?
            };
            next_events.extend(submitted);
        }
        kernel_events = next_events;
    }
}

async fn agent_tool_execute(
    State(state): State<AppState>,
    Json(body): Json<ToolExecuteRequest>,
) -> Json<ApiResponse> {
    if needs_workspace(&body.tool_call.name) {
        if let Err(error) =
            ensure_workspace_binding(&state.runtime, body.workspace_binding.as_ref())
        {
            return ApiResponse::ok(json!({
                "ok": false,
                "error": error.message,
                "code": error.code
            }));
        }
    }
    let session_id = state
        .gui
        .lock()
        .expect("gui state lock")
        .current_session_id
        .clone()
        .unwrap_or_else(|| "tool-session".to_string());
    match invoke_kernel_tool(
        &state,
        &session_id,
        &body.workspace_binding,
        &body.tool_call,
    ) {
        Ok(events) => {
            let pending_permission = events.iter().find_map(|event| match event {
                KernelEvent::PermissionRequested { request, .. } => Some(request.clone()),
                _ => None,
            });
            let output = events.iter().find_map(|event| match event {
                KernelEvent::ToolCompleted { output, .. } => output.clone(),
                _ => None,
            });
            record_kernel_events(&state, &events);
            ApiResponse::ok(json!({
                "ok": pending_permission.is_none(),
                "output": output,
                "pendingPermission": pending_permission.is_some(),
                "permission": pending_permission,
                "events": events
            }))
        }
        Err(error) => ApiResponse::ok(json!({
            "ok": false,
            "error": error,
            "code": "kernel_tool_invoke_failed"
        })),
    }
}

async fn browser_status(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

async fn browser_open(State(state): State<AppState>, Json(body): Json<Value>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:31249/")
        .to_string();
    update_browser_action(&mut gui.browser, "open", "ok");
    gui.browser.current_url = Some(url);
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

async fn browser_reload(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    update_browser_action(&mut gui.browser, "reload", "ok");
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

async fn browser_inspect_mode(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.browser.inspect_state = body
        .get("inspectState")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    update_browser_action(&mut gui.browser, "inspect", "ok");
    ApiResponse::ok(browser_status_payload(&gui.browser))
}

async fn browser_panel_snapshot(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    update_browser_action(&mut gui.browser, "snapshot", "reserved");
    if gui.browser.snapshot.is_none() {
        gui.browser.snapshot = Some(default_panel_snapshot(gui.browser.current_url.as_deref()));
    }
    ApiResponse::ok(json!({
        "snapshot": gui.browser.snapshot,
        "message": "Panel snapshot capture is reserved in packaged Kernel Host; diagnostic snapshot returned."
    }))
}

async fn browser_attach_snapshot(State(state): State<AppState>) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    update_browser_action(&mut gui.browser, "attach", "reserved");
    if gui.browser.snapshot.is_none() {
        gui.browser.snapshot = Some(default_panel_snapshot(gui.browser.current_url.as_deref()));
    }
    gui.browser.attached = true;
    ApiResponse::ok(json!({
        "attached": true,
        "snapshot": gui.browser.snapshot,
        "message": "Panel snapshot attachment is recorded by Host compatibility layer."
    }))
}

async fn api_not_implemented(method: Method, Path(path): Path<String>) -> Json<ApiResponse> {
    ApiResponse::error(
        "api_not_implemented",
        format!("Route {method}:/api/{path} is not implemented by the Rust Kernel Host yet."),
    )
}

fn record_kernel_events(state: &AppState, events: &[KernelEvent]) {
    if events.is_empty() {
        return;
    }
    let mut log = state
        .kernel_events
        .lock()
        .expect("kernel event stream lock");
    log.extend(events.iter().cloned());
    const MAX_KERNEL_EVENT_CACHE: usize = 512;
    if log.len() > MAX_KERNEL_EVENT_CACHE {
        let overflow = log.len() - MAX_KERNEL_EVENT_CACHE;
        log.drain(0..overflow);
    }
}

fn kernel_command_session_id(command: &KernelCommand) -> Option<String> {
    serde_json::to_value(command)
        .ok()
        .and_then(|value| value.get("sessionId").cloned())
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("0")
                .or_else(|| map.get("value"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

fn kernel_event_session_id(event: &KernelEvent) -> Option<String> {
    serde_json::to_value(event)
        .ok()
        .and_then(|value| value.get("sessionId").cloned())
        .and_then(|value| match value {
            Value::String(value) => Some(value),
            Value::Object(map) => map
                .get("0")
                .or_else(|| map.get("value"))
                .and_then(Value::as_str)
                .map(str::to_string),
            _ => None,
        })
}

fn dispatch_workspace(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<Value, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    match events.into_iter().next() {
        Some(KernelEvent::WorkspaceResult {
            ok: true,
            output: Some(output),
            ..
        }) => Ok(output),
        Some(KernelEvent::WorkspaceResult {
            ok: false,
            error: Some(error),
            ..
        }) => Err(error),
        other => Err(KernelErrorEnvelope {
            code: "unexpected_event".to_string(),
            message: format!("expected workspace result, got {other:?}"),
            message_key: None,
            args: None,
        }),
    }
}

fn dispatch_skill(
    runtime: &SharedRuntime,
    command: KernelCommand,
) -> Result<Value, KernelErrorEnvelope> {
    let mut runtime = runtime.lock().expect("kernel runtime lock");
    let events = runtime
        .dispatch(command)
        .map_err(|error| KernelErrorEnvelope::from(&error))?;
    match events.into_iter().next() {
        Some(KernelEvent::SkillResult {
            ok: true,
            output: Some(output),
            ..
        }) => Ok(output),
        Some(KernelEvent::SkillResult {
            ok: false,
            error: Some(error),
            ..
        }) => Err(error),
        other => Err(KernelErrorEnvelope {
            code: "unexpected_event".to_string(),
            message: format!("expected skill result, got {other:?}"),
            message_key: None,
            args: None,
        }),
    }
}

fn append_session_projection(state: &AppState, session_id: &str, events: Vec<Value>) {
    if events.is_empty() {
        return;
    }
    let sessions_dir = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.session_projection_cache
            .entry(session_id.to_string())
            .or_default()
            .extend(events.clone());
        update_session_event_count(&mut gui, session_id);
        gui.paths.sessions_dir.clone()
    };
    if let Err(error) = append_session_projection_jsonl(&sessions_dir, session_id, &events) {
        eprintln!("failed to append session projection: {error}");
    }
}

fn session_projection(state: &AppState, session_id: &str) -> Vec<Value> {
    let (cached, sessions_dir) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.session_projection_cache.get(session_id).cloned(),
            gui.paths.sessions_dir.clone(),
        )
    };
    cached.unwrap_or_else(|| read_session_projection_jsonl(&sessions_dir, session_id))
}

fn append_session_projection_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    events: &[Value],
) -> std::io::Result<()> {
    append_session_jsonl(sessions_dir, session_id, "projection.jsonl", events)
}

fn read_session_projection_jsonl(sessions_dir: &FsPath, session_id: &str) -> Vec<Value> {
    read_session_jsonl(sessions_dir, session_id, "projection.jsonl")
}

fn append_session_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
    entries: &[Value],
) -> std::io::Result<()> {
    use std::io::Write;
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::create_dir_all(&dir)?;
    let path = dir.join(file_name);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    for entry in entries {
        let line = serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_string());
        writeln!(file, "{line}")?;
    }
    Ok(())
}

fn read_session_jsonl(sessions_dir: &FsPath, session_id: &str, file_name: &str) -> Vec<Value> {
    let path = sessions_dir
        .join(safe_path_segment(session_id))
        .join(file_name);
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn safe_path_segment(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn append_trace_event(state: &AppState, session_id: &str, kind: &str, payload: Value) {
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.trace_events
        .entry(session_id.to_string())
        .or_default()
        .push(json!({
            "id": format!("trace-{}", now_millis()),
            "sessionId": session_id,
            "ts": now_text(),
            "kind": kind,
            "source": "runtime",
            "level": if kind == "error" { "error" } else { "info" },
            "summary": payload.get("summary").and_then(Value::as_str).unwrap_or(kind),
            "payload": payload
        }));
}

fn invoke_kernel_tool(
    state: &AppState,
    session_id: &str,
    workspace_binding: &Option<WorkspaceBinding>,
    tool_call: &ToolCallRequest,
) -> Result<Vec<KernelEvent>, String> {
    ensure_kernel_run_for_session(state, session_id, workspace_binding)?;
    let events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::ToolInvoke {
                request_id: rid("kernel-tool-invoke"),
                run_id: None,
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                tool_call_id: tool_call
                    .id
                    .clone()
                    .unwrap_or_else(|| format!("tool-{}", now_millis())),
                tool_name: tool_call.name.clone(),
                arguments: tool_call.arguments.clone(),
                workspace_binding: workspace_binding.clone(),
            })
            .map_err(|error| error.to_string())?
    };
    record_kernel_events(state, &events);
    Ok(events)
}

fn ensure_kernel_run_for_session(
    state: &AppState,
    session_id: &str,
    workspace_binding: &Option<WorkspaceBinding>,
) -> Result<(), String> {
    let has_run = {
        let runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime.snapshot(Some(session_id)).run_id.is_some()
    };
    if has_run {
        return Ok(());
    }
    let binding = effective_workspace_binding(&state.runtime, workspace_binding.clone())
        .ok_or_else(|| "workspace binding is required before invoking a Kernel tool".to_string())?;
    let events = {
        let mut runtime = state.runtime.lock().expect("kernel runtime lock");
        runtime
            .dispatch(KernelCommand::RunStart {
                request_id: rid("kernel-tool-run-start"),
                session_id: Some(deepcode_kernel_abi::SessionId(session_id.to_string())),
                input: deepcode_kernel_abi::UserInput {
                    text: "Kernel tool invocation compatibility run".to_string(),
                    attachments: Vec::new(),
                },
                workspace_binding: Some(binding),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .map_err(|error| error.to_string())?
    };
    record_kernel_events(state, &events);
    Ok(())
}

fn kernel_events_to_agent_events(session_id: &str, events: &[KernelEvent]) -> Vec<Value> {
    events
        .iter()
        .flat_map(|event| kernel_event_to_agent_events(session_id, event))
        .collect()
}

fn kernel_event_to_agent_events(session_id: &str, event: &KernelEvent) -> Vec<Value> {
    match event {
        KernelEvent::MessageAppended {
            channel, content, ..
        } => vec![agent_event(
            session_id,
            "assistant_msg",
            json!({
                "content": content,
                "kind": channel.as_deref().unwrap_or("progress"),
                "channel": channel.as_deref().unwrap_or("progress"),
                "visibility": "conversation",
                "label": if channel.as_deref() == Some("final") { "Agent" } else { "Agent" },
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::LlmCallRequested {
            phase,
            llm_call_id,
            profile_ref,
            ..
        } => vec![agent_event(
            session_id,
            "workflow_stage",
            json!({
                "stage": phase,
                "phase": phase,
                "status": "llm_requested",
                "summary": format!("Kernel requested LLM call {llm_call_id}."),
                "profileId": profile_ref.as_ref().map(|value| value.id.clone()),
                "channel": "task",
                "visibility": "task",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ToolRequested {
            tool_call_id,
            tool_name,
            args_preview,
            ..
        } => vec![agent_event(
            session_id,
            "tool_call",
            json!({
                "id": tool_call_id,
                "name": tool_name,
                "toolName": tool_name,
                "arguments": args_preview,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::ToolCompleted {
            tool_call_id,
            tool_name,
            ok,
            output,
            error,
            ..
        } => vec![agent_event(
            session_id,
            "tool_result",
            json!({
                "callId": tool_call_id,
                "toolName": tool_name,
                "ok": ok,
                "status": if *ok { "ok" } else { "error" },
                "output": output,
                "error": error.as_ref().map(|value| value.message.clone()),
                "code": error.as_ref().map(|value| value.code.clone()),
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::PermissionRequested { request, .. } => vec![agent_event(
            session_id,
            "permission_request",
            json!({
                "id": request.id,
                "toolName": tool_name_for_capability(&request.capability),
                "capability": request.capability,
                "riskLevel": request.risk_level,
                "summary": request.summary,
                "argumentsPreview": request.args_preview,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::PermissionResolved {
            permission_id,
            decision,
            ..
        } => vec![agent_event(
            session_id,
            "permission_result",
            json!({
                "permissionId": permission_id,
                "decision": decision,
                "channel": "tool",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        KernelEvent::WorkflowDecisionMade { decision, .. } => {
            let mut result = vec![agent_event(
                session_id,
                "workflow_decision",
                json!({
                    "decision": decision,
                    "channel": "task",
                    "visibility": "task",
                    "kernelEvent": event
                }),
                &now_text(),
            )];
            if decision.fail_closed
                || matches!(
                    decision.action,
                    deepcode_kernel_abi::WorkflowDecisionAction::Blocked
                )
            {
                result.push(assistant_final_event(
                    session_id,
                    decision
                        .summary
                        .as_deref()
                        .unwrap_or("Kernel 工作流已阻塞，未满足完成条件。"),
                ));
            }
            result
        }
        KernelEvent::Error { error, .. } => vec![agent_event(
            session_id,
            "error",
            json!({
                "message": error.message,
                "code": error.code,
                "channel": "error",
                "visibility": "conversation",
                "kernelEvent": event
            }),
            &now_text(),
        )],
        _ => Vec::new(),
    }
}

fn tool_name_for_capability(capability: &str) -> &str {
    match capability {
        "cap.fs.write" => "fs.write",
        "cap.fs.delete" => "fs.delete",
        "cap.shell.exec" => "shell.exec",
        "cap.skill.executeExternal" => "skill.invoke",
        _ => capability,
    }
}

fn assistant_final_event(session_id: &str, content: &str) -> Value {
    agent_event(
        session_id,
        "assistant_msg",
        json!({
            "content": content,
            "channel": "final",
            "visibility": "conversation",
            "label": "Agent"
        }),
        &now_text(),
    )
}

fn resolve_kernel_llm_profile(
    state: &AppState,
    profile_ref: Option<&deepcode_kernel_abi::ProfileRef>,
) -> Result<ResolvedLlmProfile, String> {
    let gui = state.gui.lock().expect("gui state lock");
    resolve_llm_profile(&gui, profile_ref.map(|value| value.id.as_str()))
}

fn resolve_llm_profile(
    gui: &GuiState,
    profile_id: Option<&str>,
) -> Result<ResolvedLlmProfile, String> {
    let default_id = gui
        .llm_profiles
        .get("defaultProfileId")
        .and_then(Value::as_str);
    let selected_id = profile_id.or(default_id);
    let profiles = gui
        .llm_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| "LLM profiles are missing".to_string())?;
    let profile = selected_id
        .and_then(|id| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(id))
        })
        .or_else(|| {
            profiles.iter().find(|profile| {
                profile
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
        .ok_or_else(|| "No enabled LLM profile is configured".to_string())?;

    if !profile
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Err("Selected LLM profile is disabled".to_string());
    }

    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("profile")
        .to_string();
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openaiCompatible")
        .to_string();
    let secret_store = read_json_file(&gui.paths.llm_secrets_path).unwrap_or_else(|| json!({}));
    let secret_key = profile
        .get("secretRef")
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix("local-secret:").map(str::to_string))
        .unwrap_or_else(|| id.clone());
    let api_key = secret_store
        .get(&secret_key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| std::env::var("DEEPCODE_LLM_API_KEY").ok());

    Ok(ResolvedLlmProfile {
        id: id.clone(),
        name: profile
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string(),
        kind,
        base_url: profile
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: profile
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        max_output_tokens: profile
            .get("maxOutputTokens")
            .or_else(|| profile.get("maxTokens"))
            .and_then(token_limit_u32),
        temperature: profile.get("temperature").and_then(Value::as_f64),
        reasoning_effort: profile
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
        thinking: profile
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string),
        api_key,
    })
}

async fn call_llm_profile(
    profile: &ResolvedLlmProfile,
    request_envelope: Value,
) -> Result<LlmChatOutput, String> {
    let messages = request_envelope
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = request_envelope
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .map(provider_tools_from_values)
        .unwrap_or_default();
    if llm_mock_enabled() {
        let mock_stage_prompt = messages
            .iter()
            .find(|value| value.get("role").and_then(Value::as_str) == Some("system"))
            .and_then(|value| value.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mock_user_prompt = messages
            .iter()
            .rev()
            .find(|value| value.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|value| value.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(mock_llm_output(mock_stage_prompt, mock_user_prompt));
    }
    match profile.kind.as_str() {
        "anthropic" => call_anthropic_profile(profile, messages, tools).await,
        "ollama" => call_ollama_profile(profile, messages, tools).await,
        "openaiCompatible" | "codex" => {
            call_openai_compatible_profile(profile, messages, tools).await
        }
        other => Err(format!("Unsupported LLM provider kind: {other}")),
    }
}

async fn call_openai_compatible_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, String> {
    let api_key = profile
        .api_key
        .as_deref()
        .ok_or_else(|| format!("LLM profile `{}` has no API key", profile.name))?;
    let url = normalize_openai_base_url(profile);
    let mut body = json!({
        "model": profile.model,
        "messages": messages,
        "stream": false
    });
    if let Some(tokens) = profile.max_output_tokens {
        body["max_tokens"] = json!(tokens);
    }
    if should_send_sampling(profile) {
        if let Some(temperature) = profile.temperature {
            body["temperature"] = json!(temperature);
        }
    }
    if let Some(effort) = profile.reasoning_effort.as_ref() {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(thinking) = profile.thinking.as_ref() {
        body["thinking"] = json!({ "type": thinking });
    }
    if is_deepseek_profile(profile) {
        body["user_id"] = json!("deepcode_local");
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": provider_tool_name(&tool.name),
                    "description": tool.description,
                    "parameters": tool.input_schema
                }
            }))
            .collect::<Vec<_>>());
    }
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("LLM request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("LLM response JSON parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), value));
    }
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(parse_openai_message(&choice))
}

async fn call_anthropic_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, String> {
    let api_key = profile
        .api_key
        .as_deref()
        .ok_or_else(|| format!("LLM profile `{}` has no API key", profile.name))?;
    let (system, chat_messages) = split_system_messages(messages);
    let mut body = json!({
        "model": profile.model,
        "messages": chat_messages,
        "max_tokens": profile.max_output_tokens.unwrap_or(4096)
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "name": provider_tool_name(&tool.name),
                "description": tool.description,
                "input_schema": tool.input_schema
            }))
            .collect::<Vec<_>>());
    }
    let response = reqwest::Client::new()
        .post(normalize_anthropic_base_url(profile))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("LLM request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("LLM response JSON parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), value));
    }
    Ok(parse_anthropic_message(&value))
}

async fn call_ollama_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, String> {
    let mut body = json!({
        "model": profile.model,
        "messages": messages,
        "stream": false
    });
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": provider_tool_name(&tool.name),
                    "description": tool.description,
                    "parameters": tool.input_schema
                }
            }))
            .collect::<Vec<_>>());
    }
    let response = reqwest::Client::new()
        .post(normalize_ollama_base_url(profile))
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("LLM request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("LLM response JSON parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), value));
    }
    Ok(parse_openai_message(
        value.get("message").unwrap_or(&Value::Null),
    ))
}

fn parse_openai_message(message: &Value) -> LlmChatOutput {
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let reasoning = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let function = item.get("function")?;
                    let provider_name = function.get("name").and_then(Value::as_str)?;
                    let args = function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|raw| serde_json::from_str(raw).ok())
                        .or_else(|| function.get("arguments").cloned())
                        .unwrap_or_else(|| json!({}));
                    Some(LlmToolCall {
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool-call")
                            .to_string(),
                        name: internal_tool_name(provider_name),
                        arguments: args,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    LlmChatOutput {
        content,
        reasoning,
        tool_calls,
    }
}

fn parse_anthropic_message(value: &Value) -> LlmChatOutput {
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for item in value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    content.push(text.to_string());
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                tool_calls.push(LlmToolCall {
                    id: item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("tool-call")
                        .to_string(),
                    name: internal_tool_name(name),
                    arguments: item.get("input").cloned().unwrap_or_else(|| json!({})),
                });
            }
            _ => {}
        }
    }
    LlmChatOutput {
        content: content.join("\n"),
        reasoning: None,
        tool_calls,
    }
}

fn llm_output_payload(output: LlmChatOutput) -> Value {
    let mut chunks = Vec::new();
    if let Some(reasoning) = output.reasoning.as_ref().filter(|value| !value.is_empty()) {
        chunks.push(json!({ "type": "reasoning_delta", "content": reasoning }));
    }
    if !output.content.is_empty() {
        chunks.push(json!({ "type": "delta", "content": output.content }));
    }
    for call in &output.tool_calls {
        chunks.push(json!({
            "type": "tool_call",
            "toolCall": {
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments
            }
        }));
    }
    chunks.push(json!({ "type": "done" }));
    json!({
        "chunks": chunks,
        "assistantMessage": {
            "role": "assistant",
            "content": output.content,
            "reasoningContent": output.reasoning,
            "toolCalls": output.tool_calls.into_iter().map(|call| json!({
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments
            })).collect::<Vec<_>>()
        }
    })
}

fn provider_tools_from_values(values: Vec<Value>) -> Vec<LlmToolDefinition> {
    values
        .into_iter()
        .filter_map(|value| {
            Some(LlmToolDefinition {
                name: value.get("name").and_then(Value::as_str)?.to_string(),
                description: value
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("DeepCode tool")
                    .to_string(),
                input_schema: value
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" })),
            })
        })
        .collect()
}

fn request_mentions_local_workspace(content: &str) -> bool {
    request_mentions_temp_lifecycle(content)
        || content.contains("文件")
        || content.contains("工作区")
        || content.contains("搜索")
        || content.to_lowercase().contains("workspace")
}

fn request_mentions_temp_lifecycle(content: &str) -> bool {
    let lower = content.to_lowercase();
    content.contains("临时文件")
        || content.contains("读写")
        || content.contains("新建")
        || lower.contains("temporary file")
        || lower.contains("temp file")
}

fn effective_workspace_binding(
    runtime: &SharedRuntime,
    explicit: Option<WorkspaceBinding>,
) -> Option<WorkspaceBinding> {
    if explicit.is_some() {
        return explicit;
    }
    let current = current_workspace_json(runtime).ok()?;
    let workspace = current.get("current")?;
    if workspace.is_null() {
        return None;
    }
    let open_path = workspace
        .get("sourcePath")
        .and_then(Value::as_str)
        .or_else(|| {
            workspace
                .get("folders")
                .and_then(Value::as_array)
                .and_then(|folders| folders.first())
                .and_then(|folder| folder.get("absolutePath"))
                .and_then(Value::as_str)
        })?
        .to_string();
    Some(WorkspaceBinding {
        workspace_id: workspace
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string),
        workspace_hash: None,
        open_path: Some(open_path),
        active_folder_id: Some("wf-0".to_string()),
        folder_hash: None,
    })
}

fn normalize_openai_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn normalize_anthropic_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com")
        .trim_end_matches('/');
    if base.ends_with("/v1/messages") {
        base.to_string()
    } else {
        format!("{base}/v1/messages")
    }
}

fn normalize_ollama_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:11434")
        .trim_end_matches('/');
    if base.ends_with("/api/chat") {
        base.to_string()
    } else {
        format!("{base}/api/chat")
    }
}

fn split_system_messages(messages: Vec<Value>) -> (String, Vec<Value>) {
    let mut system = Vec::new();
    let mut chat = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                system.push(content.to_string());
            }
        } else {
            chat.push(message);
        }
    }
    (system.join("\n\n"), chat)
}

fn provider_tool_name(name: &str) -> String {
    name.replace(
        |ch: char| !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-'),
        "_",
    )
}

fn internal_tool_name(name: &str) -> String {
    match name {
        "fs_read" => "fs.read".to_string(),
        "fs_list" => "fs.list".to_string(),
        "fs_diff" => "fs.diff".to_string(),
        "fs_write" => "fs.write".to_string(),
        "code_search" => "code.search".to_string(),
        "shell_propose" => "shell.propose".to_string(),
        "shell_exec" => "shell.exec".to_string(),
        other => other.to_string(),
    }
}

fn token_limit_u32(value: &Value) -> Option<u32> {
    if let Some(integer) = value.as_u64() {
        return u32::try_from(integer).ok().filter(|value| *value > 0);
    }
    let number = value.as_f64()?;
    if !number.is_finite() || number <= 0.0 || number.fract() != 0.0 {
        return None;
    }
    if number > u32::MAX as f64 {
        return None;
    }
    Some(number as u32)
}

fn is_deepseek_profile(profile: &ResolvedLlmProfile) -> bool {
    profile
        .base_url
        .as_deref()
        .map(|value| value.contains("api.deepseek.com"))
        .unwrap_or(false)
        || profile.model.starts_with("deepseek-")
}

fn should_send_sampling(profile: &ResolvedLlmProfile) -> bool {
    !(is_deepseek_profile(profile) && profile.thinking.as_deref() == Some("enabled"))
}

fn llm_mock_enabled() -> bool {
    std::env::var("DEEPCODE_LLM_MOCK")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

fn mock_llm_output(stage_prompt: &str, user_prompt: &str) -> LlmChatOutput {
    if stage_prompt.contains("复核阶段") {
        let content = if request_mentions_temp_lifecycle(user_prompt) {
            "<final>我是 DeepCode Agent。本轮已根据 Kernel 工具事实完成工作区读取、组件验证、临时文件创建读取与受控清理。</final>"
        } else if request_mentions_local_workspace(user_prompt) {
            "<final>我是 DeepCode Agent。本轮已根据 Kernel 工具事实完成工作区读取与组件验证。</final>"
        } else {
            "<final>我是 DeepCode Agent。本轮已根据 Kernel 结构化事件完成当前任务。</final>"
        };
        return LlmChatOutput {
            content: content.to_string(),
            ..LlmChatOutput::default()
        };
    }
    if stage_prompt.contains("规划阶段") {
        return LlmChatOutput {
            content: "<plan>我会先规划测试目标，再通过 Kernel syscall 验证工作区读取、搜索、临时文件写入、读取和清理，最终只在复核阶段回答身份和汇总结果。</plan>".to_string(),
            ..LlmChatOutput::default()
        };
    }
    if stage_prompt.contains("检查阶段") {
        return LlmChatOutput {
            content: "<observe>计划检查通过：路径使用工作区相对 `_agent_tmp_*`，写入需要权限，清理由 Kernel 隐藏受控能力完成。</observe>".to_string(),
            ..LlmChatOutput::default()
        };
    }
    LlmChatOutput {
        content: "<say>开始执行工具验证。</say>".to_string(),
        ..LlmChatOutput::default()
    }
}

fn ensure_workspace_binding(
    runtime: &SharedRuntime,
    binding: Option<&WorkspaceBinding>,
) -> Result<(), KernelErrorEnvelope> {
    let current = current_workspace_json(runtime)?;
    if current
        .get("current")
        .map(|value| !value.is_null())
        .unwrap_or(false)
    {
        return Ok(());
    }
    let Some(open_path) = binding.and_then(|value| value.open_path.as_ref()) else {
        return Err(KernelErrorEnvelope {
            code: "no_workspace".to_string(),
            message:
                "current workspace is missing and no host workspaceBinding.openPath was provided"
                    .to_string(),
            message_key: None,
            args: None,
        });
    };
    dispatch_workspace(
        runtime,
        KernelCommand::WorkspaceOpen {
            request_id: rid("workspace-restore"),
            path: open_path.clone(),
        },
    )?;
    Ok(())
}

fn current_workspace_json(runtime: &SharedRuntime) -> Result<Value, KernelErrorEnvelope> {
    dispatch_workspace(
        runtime,
        KernelCommand::WorkspaceCurrent {
            request_id: rid("workspace-current"),
        },
    )
}

fn needs_workspace(tool_name: &str) -> bool {
    matches!(
        tool_name,
        "fs.list" | "fs.read" | "fs.write" | "fs.diff" | "fs.delete" | "code.search"
    )
}

fn distribution_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

fn user_config_root() -> PathBuf {
    if let Some(path) = std::env::var_os("DEEPCODE_CONFIG_DIR") {
        return PathBuf::from(path);
    }
    if cfg!(windows) {
        if let Some(path) = std::env::var_os("APPDATA") {
            return PathBuf::from(path).join("DeepCode");
        }
    } else if let Some(path) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(path).join("deepcode");
    }
    home_dir()
        .map(|path| {
            if cfg!(windows) {
                path.join("AppData").join("Roaming").join("DeepCode")
            } else {
                path.join(".config").join("deepcode")
            }
        })
        .unwrap_or_else(|| distribution_root().join(".deepcode-user"))
}

struct DriveLocation {
    display: String,
    path: PathBuf,
}

fn platform_id() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        other => other,
    }
}

fn drive_locations() -> Vec<DriveLocation> {
    if !cfg!(windows) {
        return Vec::new();
    }
    ('A'..='Z')
        .filter_map(|letter| {
            let display = format!("{letter}:\\");
            let path = PathBuf::from(&display);
            path.exists().then_some(DriveLocation { display, path })
        })
        .collect()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn normalize_workspace_file_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("workspace file name is required".to_string());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed == "." || trimmed == ".." {
        return Err("workspace file name must not contain path separators".to_string());
    }
    let mut file_name = trimmed.to_string();
    if !file_name.ends_with(".code-workspace") {
        file_name.push_str(".code-workspace");
    }
    Ok(file_name)
}

fn workspace_file_name_from_label(label: &str) -> String {
    let sanitized = label
        .chars()
        .map(|ch| {
            if matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                ch
            }
        })
        .collect::<String>();
    normalize_workspace_file_name(&sanitized)
        .unwrap_or_else(|_| "DeepCode.code-workspace".to_string())
}

fn sorted_dir_entries(path: &FsPath) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(compare_dir_entries);
    Ok(entries)
}

fn compare_dir_entries(left: &fs::DirEntry, right: &fs::DirEntry) -> Ordering {
    let left_name = left.file_name().to_string_lossy().to_string();
    let right_name = right.file_name().to_string_lossy().to_string();
    let left_is_dir = left.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    let right_is_dir = right.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
    (
        if left_is_dir { 0_u8 } else { 1_u8 },
        if left_name.starts_with('.') {
            1_u8
        } else {
            0_u8
        },
        left_name.to_lowercase(),
        left_name,
    )
        .cmp(&(
            if right_is_dir { 0_u8 } else { 1_u8 },
            if right_name.starts_with('.') {
                1_u8
            } else {
                0_u8
            },
            right_name.to_lowercase(),
            right_name,
        ))
}

fn read_json_file(path: &PathBuf) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn atomic_write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&tmp, content).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|error| format!("rename {}: {error}", path.display()))
}

fn merge_object(target: &mut Value, patch: &Value) {
    let Some(target_object) = target.as_object_mut() else {
        return;
    };
    let Some(patch_object) = patch.as_object() else {
        return;
    };
    for (key, value) in patch_object {
        if value.is_null() {
            target_object.remove(key);
        } else {
            target_object.insert(key.clone(), value.clone());
        }
    }
}

fn default_user_settings() -> Value {
    json!({
        "editor.tabSize": 4,
        "editor.insertSpaces": true,
        "editor.wordWrap": "off",
        "editor.fontSize": 14,
        "editor.fontFamily": "Consolas, 'Courier New', monospace",
        "editor.renderWhitespace": "none",
        "files.autoSave": "afterDelay",
        "files.autoSaveDelay": 1000,
        "files.hotExit": true,
        "files.encoding": "utf8",
        "files.eol": "\n",
        "keyboard.enableBasicShortcuts": true,
        "explorer.confirmDelete": false,
        "workbench.colorTheme": "vs-dark",
        "workbench.language": "zh-CN",
        "workbench.styleTokenOverrides": "{}",
        "terminal.integrated.defaultProfile.windows": "wsl",
        "terminal.integrated.prewarm": "afterStartup",
        "terminal.integrated.spawnTimeoutMs": 8000,
        "agent.defaultMode": "plan",
        "agent.defaultWorkflow": "planFirst",
        "agent.permissions.allowFileRead": true,
        "agent.permissions.allowFileWrite": true,
        "agent.permissions.allowCodeSearch": true,
        "agent.permissions.allowShellPropose": true,
        "agent.permissions.allowShellExec": true,
        "agent.shell.autoExecuteCommands": false,
        "skills.pythonPath": "python",
        "skills.autoLoad": true,
        "skills.mounts": "[]",
        "prompt.defaultProfileId": "default-agent",
        "prompt.profiles": "[{\"id\":\"default-agent\",\"name\":\"Default Agent\",\"description\":\"Default coding assistant profile\",\"systemPrompt\":\"You are DeepCode Agent. Work inside the current workspace, explain important risks, and ask for approval before writing files.\",\"enabled\":true}]",
        "ruler.enabled": true,
        "ruler.rules": "[{\"id\":\"default-safety\",\"name\":\"Default Safety Boundary\",\"source\":\"system\",\"priority\":100,\"path\":\"<builtin>/default-safety.md\",\"content\":\"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.\",\"enabled\":true}]"
    })
}

fn default_llm_profiles() -> Value {
    json!({
        "profiles": [
            {
                "id": "deepseek-v4-flash-openai",
                "name": "DeepSeek V4 Flash",
                "kind": "openaiCompatible",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-v4-flash",
                "contextWindowTokens": 1000000,
                "maxOutputTokens": 384000,
                "temperature": 0.2,
                "reasoningEffort": "high",
                "thinking": "enabled",
                "enabled": true
            },
            {
                "id": "deepseek-v4-pro-openai",
                "name": "DeepSeek V4 Pro",
                "kind": "openaiCompatible",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-v4-pro",
                "contextWindowTokens": 1000000,
                "maxOutputTokens": 384000,
                "temperature": 0.2,
                "reasoningEffort": "max",
                "thinking": "enabled",
                "enabled": true
            }
        ],
        "defaultProfileId": "deepseek-v4-pro-openai",
        "storePath": null
    })
}

fn default_workflow_config() -> Value {
    json!({
        "plan": {},
        "check": {},
        "complete": {},
        "review": {}
    })
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn now_text() -> String {
    now_millis().to_string()
}

fn has_session(gui: &GuiState, session_id: &str) -> bool {
    gui.sessions
        .iter()
        .any(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

fn session_mut<'a>(gui: &'a mut GuiState, session_id: &str) -> Option<&'a mut Value> {
    gui.sessions
        .iter_mut()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

fn update_session_event_count(gui: &mut GuiState, session_id: &str) {
    let count = gui
        .session_projection_cache
        .get(session_id)
        .map(Vec::len)
        .unwrap_or_default();
    if let Some(session) = session_mut(gui, session_id) {
        session["eventCount"] = json!(count);
        session["updatedAt"] = json!(now_text());
    }
}

fn session_result(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    let Some(session) = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    let events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id));
    ApiResponse::ok(json!({
        "session": session,
        "events": events
    }))
}

fn agent_event(session_id: &str, kind: &str, payload: Value, ts: &str) -> Value {
    json!({
        "id": format!("evt-{}-{}", kind, now_millis()),
        "sessionId": session_id,
        "ts": ts,
        "kind": kind,
        "payload": payload
    })
}

fn terminal_session_by_id(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    gui.terminals
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .cloned()
        .map(ApiResponse::ok)
        .unwrap_or_else(|| ApiResponse::error("terminal_not_found", "terminal session not found"))
}

fn update_browser_action(browser: &mut BrowserState, action: &str, result: &str) {
    browser.last_action = Some(action.to_string());
    browser.last_action_at = Some(now_text());
    browser.last_action_result = Some(result.to_string());
}

fn browser_status_payload(browser: &BrowserState) -> Value {
    json!({
        "status": if browser.current_url.is_some() { "running" } else { "idle" },
        "inspectState": browser.inspect_state,
        "currentUrl": browser.current_url,
        "message": "Packaged browser preview bridge is available; real DOM capture remains reserved.",
        "snapshot": browser.snapshot,
        "lastAction": browser.last_action,
        "lastActionAt": browser.last_action_at,
        "capabilities": {
            "status": "available",
            "openTargetRecording": "available",
            "reloadRecording": "available",
            "inspectModeRecording": "available",
            "domCapture": "reserved",
            "agentAttachment": "reserved"
        },
        "diagnostics": {
            "currentUrl": browser.current_url,
            "runtimeStatus": if browser.current_url.is_some() { "running" } else { "idle" },
            "inspectState": browser.inspect_state,
            "hasSnapshot": browser.snapshot.is_some(),
            "attached": browser.attached,
            "lastAction": browser.last_action,
            "lastActionAt": browser.last_action_at,
            "lastActionResult": browser.last_action_result
        }
    })
}

fn default_panel_snapshot(current_url: Option<&str>) -> Value {
    json!({
        "id": format!("snapshot-{}", now_millis()),
        "url": current_url.unwrap_or("http://127.0.0.1:31249/"),
        "capturedAt": now_text(),
        "selector": "body",
        "panelKind": "browser-preview",
        "panelTitle": "Packaged DeepCode preview",
        "textContent": "DOM capture is reserved; this diagnostic snapshot proves the GUI Host API is wired.",
        "sourceHints": ["userspace/gui"],
        "relatedFiles": ["userspace/gui/src/components/internal-browser/InternalBrowserPanel.tsx"]
    })
}

fn rid(value: &str) -> RequestId {
    RequestId(value.to_string())
}
