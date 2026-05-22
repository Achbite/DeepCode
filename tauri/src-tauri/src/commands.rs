// commands.rs
//
// Tauri 鍛戒护妯″潡
//
// 褰撳墠闃舵璇存槑锛?//   - 宸ヤ綔鍖虹鐞嗐€佹枃浠剁郴缁熻鍐欏凡鐢?Rust command 鎵挎帴锛?//   - LLM / Skill 浠嶄负绌烘搷浣?stub锛屽緟鍚庣画闃舵鎺ュ叆锛?//   - 鎵€鏈?command 杩斿洖缁撴瀯涓?protocol DTO 瀛楁鍚屾瀯锛屾柟渚垮墠绔?adapter 澶嶇敤銆?
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use thiserror::Error;

use crate::agent;
use crate::fs;
use crate::llm_profiles;
use crate::terminal;
use crate::user_settings;
use crate::workspace;

// ---- 閿欒妯″瀷 ----


#[derive(Debug, Error, Serialize)]
pub enum CommandError {
    /// 鍛戒护灏氭湭瀹炵幇锛堢敤浜?LLM / Skill 绛夌┖鎿嶄綔 stub锛?
#[error("not_implemented: {0}")]
    NotImplemented(String),
    /// 鐢ㄦ埛鍦ㄥ師鐢熷璇濇涓彇娑堥€夋嫨

#[error("user_cancelled")]
    UserCancelled,
    /// 閫氱敤閿欒

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

// ---- 杩愯鏃剁姸鎬?----

/// 杩愯鏃剁姸鎬佷俊鎭?
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
}

/// 杩斿洖褰撳墠杩愯鏃剁姸鎬侊細绫诲瀷銆佺増鏈€佸钩鍙般€佹灦鏋勩€?///
/// 骞冲彴涓庢灦鏋勪娇鐢?`std::env::consts` 杩愯鏈熷父閲忥紝鑰岄潪缂栬瘧鏈?`env!("TARGET")`锛?/// 鍚庤€呭湪 proc macro 闃舵涓嶅彲鐢紙Cargo 鍙湪 build script 闃舵璁剧疆 TARGET锛夈€?
#[tauri::command]
pub fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    RuntimeStatus {
        runtime: "tauri".into(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    }
}

// ---- 宸ヤ綔鍖?----

/// 鑾峰彇褰撳墠娲诲姩宸ヤ綔鍖虹姸鎬?
#[tauri::command]
pub fn get_current_workspace(
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> workspace::WorkspaceState {
    state.get_current()
}

/// 鎵撳紑宸ヤ綔鍖猴紙鐩綍鎴?.code-workspace 鏂囦欢锛?
#[tauri::command]
pub fn open_workspace(
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::OpenWorkspaceResult, CommandError> {
    state
        .open_workspace(&path)
        .map_err(CommandError::Other)
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

/// 鍚堝苟褰撳墠宸ヤ綔鍖?DeepCode 鍛藉悕绌洪棿璁剧疆锛堝唴瀛樻€侊級

#[tauri::command]
pub fn patch_workspace_settings(
    settings: serde_json::Value,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::PatchWorkspaceSettingsResult, CommandError> {
    state
        .patch_workspace_settings(settings)
        .map_err(CommandError::Other)
}

// ---- 鏂囦欢绯荤粺娴忚锛堢敤浜?Open Workspace 瀵硅瘽妗嗭級----

/// 鑾峰彇鍒濆浣嶇疆锛圚ome / Drives锛?
#[tauri::command]
pub fn get_initial_locations() -> fs::InitialLocations {
    fs::get_initial_locations()
}

/// 娴忚鎸囧畾缁濆璺緞涓嬬殑瀛愰」

#[tauri::command]
pub fn browse_path(path: String) -> Result<fs::BrowsePathResult, CommandError> {
    fs::browse_path(&path).map_err(CommandError::Other)
}

// ---- 鏂囦欢 ----

/// 鍒楁椿鍔?folder 鐨勭洰褰曟爲

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

/// 璇诲彇宸ヤ綔鍖哄唴鏂囨湰鏂囦欢

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

/// 鍐欏叆宸ヤ綔鍖哄唴鏂囨湰鏂囦欢

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
    fs::write_text_file(&folder.absolute_path, &folder.id, &path, &content).map_err(CommandError::Other)
}

/// 鏂板缓鏂囦欢锛堥樁娈?4 / S4-1锛?
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

/// 鏂板缓鐩綍锛堥樁娈?4 / S4-1锛?
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

/// 閲嶅懡鍚嶆枃浠舵垨鐩綍

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

// ---- 鍘熺敓瀵硅瘽妗?----

/// 寮瑰嚭鍘熺敓 dialog 璁╃敤鎴烽€夋嫨鐩綍

#[tauri::command]
pub async fn pick_workspace_directory(app: AppHandle) -> Result<String, CommandError> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |folder| {
        let path = folder.and_then(|p| p.into_path().ok()).map(|p| {
            p.to_string_lossy().replace('\\', "/")
        });
        let _ = tx.send(path);
    });

    let result = rx.recv().map_err(|e| CommandError::Other(e.to_string()))?;
    match result {
        Some(path) => Ok(path),
        None => Err(CommandError::UserCancelled),
    }
}

/// 寮瑰嚭鍘熺敓 dialog 璁╃敤鎴烽€夋嫨 .code-workspace 鏂囦欢

#[tauri::command]
pub async fn pick_workspace_file(app: AppHandle) -> Result<String, CommandError> {
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel::<Option<String>>();
    app.dialog()
        .file()
        .add_filter("VSCode Workspace", &["code-workspace"])
        .pick_file(move |file| {
            let path = file.and_then(|p| p.into_path().ok()).map(|p| {
                p.to_string_lossy().replace('\\', "/")
            });
            let _ = tx.send(path);
        });

    let result = rx.recv().map_err(|e| CommandError::Other(e.to_string()))?;
    match result {
        Some(path) => Ok(path),
        None => Err(CommandError::UserCancelled),
    }
}

// ---- LLM 绌烘搷浣?Stub ----
//
// stub 闃舵 payload 浠呯敤浜庡喕缁撳墠鍚庣濂戠害锛屽瓧娈垫湰韬笉琚鍙栵紱鍚庣画闃舵鎺ュ叆鐪熷疄 LLM 鍚庢墠浼氫娇鐢ㄣ€?#[allow(dead_code)]

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct LlmInvokePayload {
    pub profile: String,
    pub prompt: String,
    pub context_snippets: Option<Vec<String>>,
}


#[derive(Debug, Serialize)]
pub struct LlmInvokeResult {
    pub status: String,
}

/// LLM 璋冪敤绌烘搷浣?stub

#[tauri::command]
pub fn llm_invoke_stub(_payload: LlmInvokePayload) -> Result<LlmInvokeResult, CommandError> {
    Err(CommandError::NotImplemented(
        "llm_invoke 鎺ュ彛灏氭湭鎺ュ叆锛涘綋鍓嶄负楠ㄦ灦闃舵".into(),
    ))
}

// ---- Skill 绌烘搷浣?Stub ----
//
// 鍚?LLM stub锛氬厬鐜板墠涓嶈璇诲彇锛屼粎鐢ㄤ簬鍐荤粨 schema銆?#[allow(dead_code)]

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct SkillInvokePayload {
    pub skill_name: String,
    pub args: serde_json::Value,
}


#[derive(Debug, Serialize)]
pub struct SkillInvokeResult {
    pub status: String,
}

/// Skill 璋冪敤绌烘搷浣?stub

#[tauri::command]
pub fn skill_invoke_stub(_payload: SkillInvokePayload) -> Result<SkillInvokeResult, CommandError> {
    Err(CommandError::NotImplemented(
        "skill_invoke 鎺ュ彛灏氭湭鎺ュ叆锛涘綋鍓嶄负楠ㄦ灦闃舵".into(),
    ))
}

// ---- 鐢ㄦ埛璁剧疆锛堥樁娈?4 / S4-4锛?---

/// 鑾峰彇褰撳墠鐢ㄦ埛璁剧疆锛堥粯璁ゅ€?+ 鐢ㄦ埛瑕嗙洊锛?
#[tauri::command]
pub fn get_user_settings() -> user_settings::GetUserSettingsResult {
    user_settings::get_user_settings()
}

/// 娴呭悎骞剁敤鎴疯缃紱patches 涓樉寮?null = 鎭㈠榛樿鍊?
#[tauri::command]
pub fn patch_user_settings(
    patches: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<user_settings::PatchUserSettingsResult, CommandError> {
    user_settings::patch_user_settings(patches).map_err(CommandError::Other)
}

// ---- 闃舵 6 Tauri 妗ユ帴鍗犱綅 ----
//
// Web/Node 妯″紡宸茬粡鎺ュ叆鐪熷疄瀹炵幇銆傛闈㈠３鍏堟敞鍐屽悓鍚?command锛岄伩鍏嶅墠绔湪 Tauri
// 妯″紡涓嬮亣鍒?unknown command锛涘悗缁啀鎶?secret store銆丩LM adapter銆乻ession JSONL
// 绉绘鍒?Rust 渚с€?
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
    state.restart_session(&session_id).map_err(CommandError::from)
}


#[tauri::command]
pub fn delete_terminal_session(
    session_id: String,
    state: tauri::State<'_, terminal::TerminalManager>,
) -> Result<terminal::TerminalSession, CommandError> {
    state.delete_session(&session_id).map_err(CommandError::from)
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
pub struct LlmProfilesResult {
    pub profiles: Vec<serde_json::Value>,
    pub default_profile_id: Option<String>,
    pub store_path: Option<String>,
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

#[allow(dead_code)]
pub fn get_llm_profiles_stub() -> LlmProfilesResult {
    LlmProfilesResult {
        profiles: vec![
            serde_json::json!({
                "id": "deepseek-v4-flash-openai",
                "name": "DeepSeek V4 Flash",
                "kind": "openaiCompatible",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-v4-flash",
                "maxTokens": 4096,
                "temperature": 0.2,
                "reasoningEffort": "medium",
                "thinking": "enabled",
                "enabled": true
            }),
            serde_json::json!({
                "id": "deepseek-v4-pro-openai",
                "name": "DeepSeek V4 Pro",
                "kind": "openaiCompatible",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-v4-pro",
                "maxTokens": 4096,
                "temperature": 0.2,
                "reasoningEffort": "high",
                "thinking": "enabled",
                "enabled": true
            }),
        ],
        default_profile_id: Some("deepseek-v4-flash-openai".into()),
        store_path: None,
    }
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
    agent_state: tauri::State<'_, agent::AgentManager>,
) -> Option<agent::AgentSessionResult> {
    agent_state.current_session()
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
pub fn submit_agent_feedback(request: serde_json::Value) -> serde_json::Value {
    let body = request.get("request").unwrap_or(&request);
    serde_json::json!({
        "accepted": body.get("eventId").is_some() && body.get("rating").is_some(),
        "message": "Agent feedback command is reserved for future model-quality data collection."
    })
}

fn browser_runtime_stub(message: &str, inspect_state: &str, current_url: Option<String>) -> serde_json::Value {
    serde_json::json!({
        "status": "idle",
        "inspectState": inspect_state,
        "currentUrl": current_url,
        "message": message,
        "snapshot": null
    })
}


#[tauri::command]
pub fn get_browser_runtime_status() -> serde_json::Value {
    browser_runtime_stub(
        "Internal browser runtime is a skeleton only. Real preview loading, DOM capture, and Agent attachment are reserved for a later stage.",
        "off",
        None,
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
        Some(url) => format!("Preview target recorded: {url}. Real loading is not implemented yet."),
        None => "Preview target is empty. Real loading is not implemented yet.".to_string(),
    };
    browser_runtime_stub(&message, "off", current_url)
}


#[tauri::command]
pub fn reload_browser_preview() -> serde_json::Value {
    browser_runtime_stub(
        "Reload requested. Real browser reload is not implemented yet.",
        "off",
        None,
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
    let message = format!("Inspect mode set to {inspect_state}. DOM selection is not implemented yet.");
    browser_runtime_stub(&message, inspect_state, None)
}


#[tauri::command]
pub fn get_selected_panel_snapshot() -> serde_json::Value {
    serde_json::json!({
        "snapshot": null,
        "message": "No panel snapshot is available yet. DOM capture is reserved for a later stage."
    })
}


#[tauri::command]
pub fn attach_panel_snapshot_to_agent() -> serde_json::Value {
    serde_json::json!({
        "attached": false,
        "snapshot": null,
        "message": "Panel snapshot attachment is reserved for a later stage."
    })
}


#[tauri::command]
pub fn window_close_ask_status(_app_handle: tauri::AppHandle) -> Result<bool, String> {
    // 閫氳繃 emit 鍚戝墠绔闂姸鎬侊紝姝ゅ嚱鏁颁粎鐢ㄤ簬鏍囪鎺ュ彛瀛樺湪
    // 瀹為檯閫昏緫鍓嶇鑷澶勭悊
    Ok(false)
}
