// commands.rs
//
// Tauri command bridge.
//
// Keep this file as a thin command registration and forwarding layer. Workspace,
// file, terminal, LLM profile, and Agent behavior should live in their own
// modules so Web and Tauri can share the same front-end runtime contract.
use serde::Serialize;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use thiserror::Error;

use crate::agent;
use crate::fs;
use crate::llm_profiles;
use crate::terminal;
use crate::user_settings;
use crate::workspace;

// ---- Error model ----

#[derive(Debug, Error, Serialize)]
pub enum CommandError {
    /// User cancelled a native dialog.
    #[error("user_cancelled")]
    UserCancelled,
    /// General command error.
    #[error("{0}")]
    Other(String),
}

impl From<String> for CommandError {
    fn from(s: String) -> Self {
        CommandError::Other(s)
    }
}

impl From<terminal::TerminalError> for CommandError {
    fn from(err: terminal::TerminalError) -> Self {
        CommandError::Other(err.to_string())
    }
}

// ---- Runtime status ----

/// Runtime status returned to the front-end adapter.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
}

/// Returns the current Tauri runtime, version, platform, and architecture.
#[tauri::command]
pub fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    RuntimeStatus {
        runtime: "tauri".into(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    }
}

// ---- Workspace ----

/// Returns the current active workspace state.
#[tauri::command]
pub fn get_current_workspace(
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> workspace::WorkspaceState {
    state.get_current()
}

/// Opens a directory or `.code-workspace` file.
#[tauri::command]
pub fn open_workspace(
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::OpenWorkspaceResult, CommandError> {
    state.open_workspace(&path).map_err(CommandError::Other)
}

#[tauri::command]
pub fn save_workspace_file(
    folder_id: Option<String>,
    file_name: Option<String>,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::SaveWorkspaceFileResult, CommandError> {
    state
        .save_workspace_file(folder_id, file_name)
        .map_err(CommandError::Other)
}

/// Patches the current workspace-scoped DeepCode settings.

#[tauri::command]
pub fn patch_workspace_settings(
    settings: serde_json::Value,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::PatchWorkspaceSettingsResult, CommandError> {
    state
        .patch_workspace_settings(settings)
        .map_err(CommandError::Other)
}

// ---- File system browsing for Open Workspace dialog ----

/// Returns initial browse locations such as home and drives.
#[tauri::command]
pub fn get_initial_locations() -> fs::InitialLocations {
    fs::get_initial_locations()
}

/// Lists children under an absolute path.

#[tauri::command]
pub fn browse_path(path: String) -> Result<fs::BrowsePathResult, CommandError> {
    fs::browse_path(&path).map_err(CommandError::Other)
}

// ---- Files ----

/// Lists the active folder file tree.

#[tauri::command]
pub fn list_file_tree(
    folder_id: Option<String>,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<Vec<fs::FileTreeNode>, CommandError> {
    let folder = state
        .resolve_folder(folder_id.as_deref())
        .map_err(CommandError::Other)?;
    fs::build_file_tree(&folder.absolute_path, &folder.id).map_err(CommandError::Other)
}

/// Reads a text file inside the workspace.

#[tauri::command]
pub fn read_text_file(
    folder_id: Option<String>,
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::FileReadResult, CommandError> {
    let folder = state
        .resolve_folder(folder_id.as_deref())
        .map_err(CommandError::Other)?;
    fs::read_text_file(&folder.absolute_path, &folder.id, &path).map_err(CommandError::Other)
}

/// Writes a text file inside the workspace.

#[tauri::command]
pub fn write_text_file(
    folder_id: Option<String>,
    path: String,
    content: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::FileWriteResult, CommandError> {
    let folder = state
        .resolve_folder(folder_id.as_deref())
        .map_err(CommandError::Other)?;
    fs::write_text_file(&folder.absolute_path, &folder.id, &path, &content)
        .map_err(CommandError::Other)
}

/// Creates a file inside the workspace.
#[tauri::command]
pub fn create_file(
    folder_id: Option<String>,
    path: String,
    content: Option<String>,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::FileWriteResult, CommandError> {
    let folder = state
        .resolve_folder(folder_id.as_deref())
        .map_err(CommandError::Other)?;
    let initial = content.unwrap_or_default();
    fs::create_file(&folder.absolute_path, &folder.id, &path, &initial).map_err(CommandError::Other)
}

/// Creates a folder inside the workspace.
#[tauri::command]
pub fn create_folder(
    folder_id: Option<String>,
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::CreateFolderResult, CommandError> {
    let folder = state
        .resolve_folder(folder_id.as_deref())
        .map_err(CommandError::Other)?;
    fs::create_folder(&folder.absolute_path, &folder.id, &path).map_err(CommandError::Other)
}

/// Renames a file or folder inside the workspace.

#[tauri::command]
pub fn rename_entry(
    folder_id: Option<String>,
    old_path: String,
    new_path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::RenameEntryResult, CommandError> {
    let folder = state
        .resolve_folder(folder_id.as_deref())
        .map_err(CommandError::Other)?;
    fs::rename_entry(&folder.absolute_path, &folder.id, &old_path, &new_path)
        .map_err(CommandError::Other)
}

// ---- Native dialogs ----

/// Opens a native dialog for selecting a directory.

#[tauri::command]
pub async fn pick_workspace_directory(app: AppHandle) -> Result<String, CommandError> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |folder| {
        let path = folder
            .and_then(|p| p.into_path().ok())
            .map(|p| p.to_string_lossy().replace('\\', "/"));
        let _ = tx.send(path);
    });

    let result = rx.recv().map_err(|e| CommandError::Other(e.to_string()))?;
    match result {
        Some(path) => Ok(path),
        None => Err(CommandError::UserCancelled),
    }
}

/// Opens a native dialog for selecting a `.code-workspace` file.

#[tauri::command]
pub async fn pick_workspace_file(app: AppHandle) -> Result<String, CommandError> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Option<String>>();
    app.dialog()
        .file()
        .add_filter("VSCode Workspace", &["code-workspace"])
        .pick_file(move |file| {
            let path = file
                .and_then(|p| p.into_path().ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"));
            let _ = tx.send(path);
        });

    let result = rx.recv().map_err(|e| CommandError::Other(e.to_string()))?;
    match result {
        Some(path) => Ok(path),
        None => Err(CommandError::UserCancelled),
    }
}

// ---- User settings ----

/// Returns merged user settings.
#[tauri::command]
pub fn get_user_settings() -> user_settings::GetUserSettingsResult {
    user_settings::get_user_settings()
}

/// Patches user settings; explicit null values reset keys to defaults.
#[tauri::command]
pub fn patch_user_settings(
    patches: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<user_settings::PatchUserSettingsResult, CommandError> {
    user_settings::patch_user_settings(patches).map_err(CommandError::Other)
}

// ---- Terminal ----

#[tauri::command]
pub fn get_terminal_capabilities(
    state: tauri::State<'_, terminal::TerminalManager>,
) -> terminal::TerminalCapability {
    state.capabilities()
}

#[tauri::command]
pub fn get_terminal_warmup_status(
    state: tauri::State<'_, terminal::TerminalManager>,
) -> terminal::TerminalWarmupStatus {
    state.warmup_status()
}

#[tauri::command]
pub fn warmup_terminal_runtime(
    state: tauri::State<'_, terminal::TerminalManager>,
) -> terminal::TerminalWarmupStatus {
    state.warmup()
}

#[tauri::command]
pub fn list_terminal_sessions(
    state: tauri::State<'_, terminal::TerminalManager>,
) -> terminal::TerminalSessionsResult {
    state.list_sessions()
}

#[tauri::command]
pub fn create_terminal_session(
    request: terminal::CreateTerminalSessionRequest,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state.create_session(request).map_err(CommandError::from)
}

#[tauri::command]
pub fn send_terminal_input(
    session_id: String,
    request: terminal::TerminalInputRequest,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state
        .send_input(&session_id, request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn resize_terminal_session(
    session_id: String,
    request: terminal::TerminalResizeRequest,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state
        .resize_session(&session_id, request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn update_terminal_session(
    session_id: String,
    request: terminal::UpdateTerminalSessionRequest,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state
        .update_session(&session_id, request)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn restart_terminal_session(
    session_id: String,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state
        .restart_session(&session_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn delete_terminal_session(
    session_id: String,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state
        .delete_session(&session_id)
        .map_err(CommandError::from)
}

#[tauri::command]
pub fn get_terminal_events(
    session_id: Option<String>,
    after: Option<u64>,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> terminal::TerminalEventsResult {
    state.get_events(session_id.as_deref(), after)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionResult {
    pub session: serde_json::Value,
    pub events: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeSearchResult {
    pub matches: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListToolsResult {
    pub tools: Vec<serde_json::Value>,
}

#[tauri::command]
pub fn get_llm_profiles() -> llm_profiles::LlmProfilesResult {
    return llm_profiles::get_profiles();
}

#[tauri::command]
pub fn patch_llm_profiles(
    request: serde_json::Value,
) -> Result<llm_profiles::LlmProfilesResult, CommandError> {
    llm_profiles::patch_profiles(request).map_err(CommandError::Other)
}

#[tauri::command]
pub async fn probe_llm_profile(
    request: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    llm_profiles::probe_profile(request)
        .await
        .map_err(CommandError::Other)
}

#[tauri::command]
pub async fn llm_chat(request: serde_json::Value) -> Result<serde_json::Value, CommandError> {
    llm_profiles::chat(request)
        .await
        .map_err(CommandError::Other)
}
#[tauri::command]
pub fn get_agent_workflow_config() -> serde_json::Value {
    agent::get_workflow_config()
}

#[tauri::command]
pub fn patch_agent_workflow_config(
    request: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    agent::patch_workflow_config(request).map_err(CommandError::Other)
}

#[tauri::command]
pub fn code_search(
    request: serde_json::Value,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> serde_json::Value {
    agent::code_search(request, &state)
}

#[tauri::command]
pub fn create_agent_session(
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> agent::AgentSessionResult {
    agent_state.create_session(request)
}

#[tauri::command]
pub fn get_current_agent_session(
    request: Option<serde_json::Value>,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Option<agent::AgentSessionResult> {
    agent_state.current_session(request.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub fn list_agent_sessions(
    request: Option<serde_json::Value>,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> serde_json::Value {
    agent_state.list_sessions(request.unwrap_or_else(|| serde_json::json!({})))
}

#[tauri::command]
pub fn activate_agent_session(
    session_id: String,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Result<agent::AgentSessionResult, CommandError> {
    agent_state
        .activate_session(&session_id)
        .map_err(CommandError::Other)
}

#[tauri::command]
pub fn rename_agent_session(
    session_id: String,
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Result<agent::AgentSessionResult, CommandError> {
    agent_state
        .rename_session(&session_id, request)
        .map_err(CommandError::Other)
}

#[tauri::command]
pub fn archive_agent_session(
    session_id: String,
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Result<serde_json::Value, CommandError> {
    agent_state
        .archive_session(&session_id, request)
        .map_err(CommandError::Other)
}

#[tauri::command]
pub fn append_agent_events(
    session_id: String,
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Result<agent::AgentSessionResult, CommandError> {
    agent_state
        .append_events(&session_id, request)
        .map_err(CommandError::Other)
}

#[tauri::command]
pub fn get_agent_event_snapshot(
    session_id: String,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Result<serde_json::Value, CommandError> {
    agent_state
        .get_event_snapshot(&session_id)
        .map_err(CommandError::Other)
}

#[tauri::command]
pub fn ack_agent_event(event_id: String) -> serde_json::Value {
    serde_json::json!({
        "accepted": true,
        "eventId": event_id
    })
}

#[tauri::command]
pub fn list_agent_tools(mode: Option<String>) -> ListToolsResult {
    ListToolsResult {
        tools: agent::list_tools(mode)
            .as_array()
            .cloned()
            .unwrap_or_default(),
    }
}

#[tauri::command]
pub fn evaluate_agent_permission(
    request: serde_json::Value,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<serde_json::Value, CommandError> {
    Ok(agent::evaluate_permission(request, &state))
}

#[tauri::command]
pub fn execute_agent_tool(
    request: serde_json::Value,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<serde_json::Value, CommandError> {
    Ok(agent::execute_tool(request, &state))
}

#[tauri::command]
pub async fn send_agent_message(
    session_id: String,
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
    workspace_state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<agent::AgentSessionResult, CommandError> {
    agent_state
        .send_message(&session_id, request, &workspace_state)
        .await
        .map_err(CommandError::Other)
}

#[tauri::command]
pub fn resolve_agent_permission(
    permission_id: String,
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
    workspace_state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<agent::AgentSessionResult, CommandError> {
    agent_state
        .resolve_permission(&permission_id, request, &workspace_state)
        .map_err(CommandError::Other)
}

// Window management

#[tauri::command]
pub fn submit_agent_feedback(
    request: serde_json::Value,
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> serde_json::Value {
    agent_state.append_feedback_trace(request)
}

#[derive(Default)]
struct BrowserRuntimeStubState {
    current_url: Option<String>,
    inspect_state: String,
    last_action: Option<String>,
    last_action_at: Option<String>,
    last_action_result: Option<String>,
    attached: bool,
}

static BROWSER_RUNTIME_STUB_STATE: OnceLock<Mutex<BrowserRuntimeStubState>> = OnceLock::new();

fn browser_runtime_state() -> &'static Mutex<BrowserRuntimeStubState> {
    BROWSER_RUNTIME_STUB_STATE.get_or_init(|| {
        Mutex::new(BrowserRuntimeStubState {
            inspect_state: "off".to_string(),
            ..BrowserRuntimeStubState::default()
        })
    })
}

fn browser_action_time() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn record_browser_action(state: &mut BrowserRuntimeStubState, action: &str, result: &str) {
    state.last_action = Some(action.to_string());
    state.last_action_at = Some(browser_action_time());
    state.last_action_result = Some(result.to_string());
}

fn browser_runtime_stub(message: &str, state: &BrowserRuntimeStubState) -> serde_json::Value {
    serde_json::json!({
        "status": "idle",
        "inspectState": state.inspect_state.clone(),
        "currentUrl": state.current_url.clone(),
        "message": message,
        "snapshot": null,
        "lastAction": state.last_action.clone(),
        "lastActionAt": state.last_action_at.clone(),
        "capabilities": {
            "status": "available",
            "openTargetRecording": "available",
            "reloadRecording": "available",
            "inspectModeRecording": "available",
            "domCapture": "reserved",
            "agentAttachment": "reserved"
        },
        "diagnostics": {
            "currentUrl": state.current_url.clone(),
            "runtimeStatus": "idle",
            "inspectState": state.inspect_state.clone(),
            "hasSnapshot": false,
            "attached": state.attached,
            "lastAction": state.last_action.clone(),
            "lastActionAt": state.last_action_at.clone(),
            "lastActionResult": state.last_action_result.clone()
        }
    })
}

#[tauri::command]
pub fn get_browser_runtime_status() -> serde_json::Value {
    let state = browser_runtime_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    browser_runtime_stub(
        "Internal browser runtime is a skeleton only. Real preview loading, DOM capture, and Agent attachment are reserved for a later stage.",
        &state,
    )
}

#[tauri::command]
pub fn open_browser_preview(request: serde_json::Value) -> serde_json::Value {
    let body = request.get("request").unwrap_or(&request);
    let current_url = body
        .get("url")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let message = match &current_url {
        Some(url) => {
            format!("Preview target recorded: {url}. Real loading is not implemented yet.")
        }
        None => "Preview target is empty. Real loading is not implemented yet.".to_string(),
    };
    let mut state = browser_runtime_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    state.current_url = current_url;
    state.inspect_state = "off".to_string();
    let result = if state.current_url.is_some() {
        "ok"
    } else {
        "unavailable"
    };
    record_browser_action(&mut state, "open", result);
    browser_runtime_stub(&message, &state)
}

#[tauri::command]
pub fn reload_browser_preview() -> serde_json::Value {
    let mut state = browser_runtime_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    record_browser_action(&mut state, "reload", "ok");
    browser_runtime_stub(
        "Reload requested. Real browser reload is not implemented yet.",
        &state,
    )
}

#[tauri::command]
pub fn set_browser_inspect_mode(request: serde_json::Value) -> serde_json::Value {
    let body = request.get("request").unwrap_or(&request);
    let inspect_state = body
        .get("inspectState")
        .and_then(|value| value.as_str())
        .filter(|value| matches!(*value, "off" | "selecting" | "selected"))
        .unwrap_or("off");
    let message =
        format!("Inspect mode set to {inspect_state}. DOM selection is not implemented yet.");
    let mut state = browser_runtime_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    state.inspect_state = inspect_state.to_string();
    record_browser_action(&mut state, "inspect", "ok");
    browser_runtime_stub(&message, &state)
}

#[tauri::command]
pub fn get_selected_panel_snapshot() -> serde_json::Value {
    let mut state = browser_runtime_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    record_browser_action(&mut state, "snapshot", "reserved");
    serde_json::json!({
        "snapshot": null,
        "message": "No panel snapshot is available yet. DOM capture is reserved for a later stage."
    })
}

#[tauri::command]
pub fn attach_panel_snapshot_to_agent() -> serde_json::Value {
    let mut state = browser_runtime_state()
        .lock()
        .unwrap_or_else(|err| err.into_inner());
    state.attached = false;
    record_browser_action(&mut state, "attach", "reserved");
    serde_json::json!({
        "attached": false,
        "snapshot": null,
        "message": "Panel snapshot attachment is reserved for a later stage."
    })
}

#[tauri::command]
pub fn window_close_ask_status(_app_handle: tauri::AppHandle) -> Result<bool, String> {
    // The front-end owns the close confirmation flow. This command only keeps a
    // stable Tauri contract for window-close status checks.
    Ok(false)
}
