// commands.rs
//
// Tauri 命令模块
//
// 当前阶段说明：
//   - 工作区管理、文件系统读写已由 Rust command 承接；
//   - LLM / Skill 仍为空操作 stub，待后续阶段接入；
//   - 所有 command 返回结构与 protocol DTO 字段同构，方便前端 adapter 复用。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use thiserror::Error;

use crate::fs;
use crate::user_settings;
use crate::workspace;

// ---- 错误模型 ----

#[derive(Debug, Error, Serialize)]
pub enum CommandError {
    /// 命令尚未实现（用于 LLM / Skill 等空操作 stub）
    #[error("not_implemented: {0}")]
    NotImplemented(String),
    /// 用户在原生对话框中取消选择
    #[error("user_cancelled")]
    UserCancelled,
    /// 通用错误
    #[error("{0}")]
    Other(String),
}

impl From<String> for CommandError {
    fn from(s: String) -> Self {
        CommandError::Other(s)
    }
}

// ---- 运行时状态 ----

/// 运行时状态信息
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub runtime: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
}

/// 返回当前运行时状态：类型、版本、平台、架构。
///
/// 平台与架构使用 `std::env::consts` 运行期常量，而非编译期 `env!("TARGET")`；
/// 后者在 proc macro 阶段不可用（Cargo 只在 build script 阶段设置 TARGET）。
#[tauri::command]
pub fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    RuntimeStatus {
        runtime: "tauri".into(),
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
    }
}

// ---- 工作区 ----

/// 获取当前活动工作区状态
#[tauri::command]
pub fn get_current_workspace(
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> workspace::WorkspaceState {
    state.get_current()
}

/// 打开工作区（目录或 .code-workspace 文件）
#[tauri::command]
pub fn open_workspace(
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::OpenWorkspaceResult, CommandError> {
    state
        .open_workspace(&path)
        .map_err(CommandError::Other)
}

/// 合并当前工作区 DeepCode 命名空间设置（内存态）
#[tauri::command]
pub fn patch_workspace_settings(
    settings: serde_json::Value,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<workspace::PatchWorkspaceSettingsResult, CommandError> {
    state
        .patch_workspace_settings(settings)
        .map_err(CommandError::Other)
}

// ---- 文件系统浏览（用于 Open Workspace 对话框）----

/// 获取初始位置（Home / Drives）
#[tauri::command]
pub fn get_initial_locations() -> fs::InitialLocations {
    fs::get_initial_locations()
}

/// 浏览指定绝对路径下的子项
#[tauri::command]
pub fn browse_path(path: String) -> Result<fs::BrowsePathResult, CommandError> {
    fs::browse_path(&path).map_err(CommandError::Other)
}

// ---- 文件 ----

/// 列活动 folder 的目录树
#[tauri::command]
pub fn list_file_tree(
    folder_id: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<Vec<fs::FileTreeNode>, CommandError> {
    let folder_root = state
        .get_folder_abs_path(&folder_id)
        .ok_or_else(|| CommandError::Other(format!("folderId 不存在: {}", folder_id)))?;
    fs::build_file_tree(&folder_root, &folder_id).map_err(CommandError::Other)
}

/// 读取工作区内文本文件
#[tauri::command]
pub fn read_text_file(
    folder_id: String,
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::FileReadResult, CommandError> {
    let folder_root = state
        .get_folder_abs_path(&folder_id)
        .ok_or_else(|| CommandError::Other(format!("folderId 不存在: {}", folder_id)))?;
    fs::read_text_file(&folder_root, &folder_id, &path).map_err(CommandError::Other)
}

/// 写入工作区内文本文件
#[tauri::command]
pub fn write_text_file(
    folder_id: String,
    path: String,
    content: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::FileWriteResult, CommandError> {
    let folder_root = state
        .get_folder_abs_path(&folder_id)
        .ok_or_else(|| CommandError::Other(format!("folderId 不存在: {}", folder_id)))?;
    fs::write_text_file(&folder_root, &folder_id, &path, &content).map_err(CommandError::Other)
}

/// 新建文件（阶段 4 / S4-1）
#[tauri::command]
pub fn create_file(
    folder_id: String,
    path: String,
    content: Option<String>,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::FileWriteResult, CommandError> {
    let folder_root = state
        .get_folder_abs_path(&folder_id)
        .ok_or_else(|| CommandError::Other(format!("folderId 不存在: {}", folder_id)))?;
    let initial = content.unwrap_or_default();
    fs::create_file(&folder_root, &folder_id, &path, &initial).map_err(CommandError::Other)
}

/// 新建目录（阶段 4 / S4-1）
#[tauri::command]
pub fn create_folder(
    folder_id: String,
    path: String,
    state: tauri::State<'_, workspace::WorkspaceManager>,
) -> Result<fs::CreateFolderResult, CommandError> {
    let folder_root = state
        .get_folder_abs_path(&folder_id)
        .ok_or_else(|| CommandError::Other(format!("folderId 不存在: {}", folder_id)))?;
    fs::create_folder(&folder_root, &folder_id, &path).map_err(CommandError::Other)
}

// ---- 原生对话框 ----

/// 弹出原生 dialog 让用户选择目录
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

/// 弹出原生 dialog 让用户选择 .code-workspace 文件
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

// ---- LLM 空操作 Stub ----
//
// stub 阶段 payload 仅用于冻结前后端契约，字段本身不被读取；后续阶段接入真实 LLM 后才会使用。
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

/// LLM 调用空操作 stub
#[tauri::command]
pub fn llm_invoke_stub(_payload: LlmInvokePayload) -> Result<LlmInvokeResult, CommandError> {
    Err(CommandError::NotImplemented(
        "llm_invoke 接口尚未接入；当前为骨架阶段".into(),
    ))
}

// ---- Skill 空操作 Stub ----
//
// 同 LLM stub：兑现前不被读取，仅用于冻结 schema。
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

/// Skill 调用空操作 stub
#[tauri::command]
pub fn skill_invoke_stub(_payload: SkillInvokePayload) -> Result<SkillInvokeResult, CommandError> {
    Err(CommandError::NotImplemented(
        "skill_invoke 接口尚未接入；当前为骨架阶段".into(),
    ))
}

// ---- 用户设置（阶段 4 / S4-4）----

/// 获取当前用户设置（默认值 + 用户覆盖）
#[tauri::command]
pub fn get_user_settings() -> user_settings::GetUserSettingsResult {
    user_settings::get_user_settings()
}

/// 浅合并用户设置；patches 中显式 null = 恢复默认值
#[tauri::command]
pub fn patch_user_settings(
    patches: std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<user_settings::PatchUserSettingsResult, CommandError> {
    user_settings::patch_user_settings(patches).map_err(CommandError::Other)
}
