// commands.rs
//
// Tauri 命令模块
//
// 当前阶段说明：
//   - DeepCode 主链路（文件读写、工作区管理、心跳）仍由 Node 后端通过 HTTP/WS 提供；
//   - 这里的命令只覆盖"必须 Native 才能完成的能力"和"为后续 LLM/Skill 接入预留的空操作接口"；
//   - 所有 Stub 命令一律返回 NotImplemented 错误，避免误以为已生效。

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use thiserror::Error;

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

// ---- 应用信息 ----

/// 返回当前应用版本号；与 tauri.conf.json 的 version 字段一致。
#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// ---- 工作区路径选择 ----

/// 弹出原生 dialog 让用户选择目录或 .code-workspace 文件。
///
/// 返回值是用户选择的绝对路径（POSIX 风格），调用方应再调用 Node 后端的
/// POST /api/workspaces/open 完成实际打开。
///
/// 当前阶段：实现"目录选择"路径；.code-workspace 文件选择由前端 UI 通过 prompt
/// 输入路径完成，dialog 仅作为可选体验提升。
#[tauri::command]
pub async fn pick_workspace_path(app: AppHandle) -> Result<String, CommandError> {
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

// ---- LLM 空操作 Stub ----

#[derive(Debug, Deserialize)]
pub struct LlmInvokePayload {
    /// 模型 profile 名（前端 Prompt Profiles 选择项），当前阶段忽略
    pub profile: String,
    /// 用户消息
    pub prompt: String,
    /// 可选的上下文片段
    pub context_snippets: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct LlmInvokeResult {
    pub status: String,
}

/// LLM 调用空操作 stub。
///
/// 该命令是"前端 -> 系统级 LLM 适配层"的契约占位，当前阶段不连接任何真实模型；
/// 任何调用都会立即返回 NotImplemented 错误，提醒上层尚未接入。
#[tauri::command]
pub fn llm_invoke_stub(_payload: LlmInvokePayload) -> Result<LlmInvokeResult, CommandError> {
    Err(CommandError::NotImplemented(
        "llm_invoke 接口尚未接入；当前为骨架阶段".into(),
    ))
}

// ---- Skill 空操作 Stub ----

#[derive(Debug, Deserialize)]
pub struct SkillInvokePayload {
    /// Skill 名称
    pub skill_name: String,
    /// 调用参数（任意 JSON）
    pub args: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct SkillInvokeResult {
    pub status: String,
}

/// Skill 调用空操作 stub。
///
/// 与 llm_invoke_stub 相同逻辑：仅作为前端 -> Skill Runtime 的契约占位。
#[tauri::command]
pub fn skill_invoke_stub(_payload: SkillInvokePayload) -> Result<SkillInvokeResult, CommandError> {
    Err(CommandError::NotImplemented(
        "skill_invoke 接口尚未接入；当前为骨架阶段".into(),
    ))
}
