// workspace.rs
//
// 工作区管理逻辑
//
// 维护当前活动工作区的 folders、name、source 等状态，
// 供 commands.rs 调用，避免 command 函数堆实现细节。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

// ---- DTO：与 protocol DTO 字段同构 ----

/// 工作区来源类型
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceSourceKind {
    Directory,
    CodeWorkspace,
    Fallback,
}

/// 工作区中的单个根文件夹
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolderSpec {
    pub id: String,
    pub name: String,
    pub absolute_path: String,
    pub original_path: String,
    pub is_absolute: bool,
}

/// 不支持但保留的字段
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsupportedField {
    pub key: String,
    pub kind: String,
}

/// 当前活动工作区完整描述
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSpec {
    pub id: String,
    pub name: String,
    pub source: WorkspaceSourceKind,
    pub source_path: Option<String>,
    pub folders: Vec<WorkspaceFolderSpec>,
    pub settings: serde_json::Value,
    pub unsupported_fields: Vec<UnsupportedField>,
    pub opened_at: String,
}

/// GET /api/workspaces/current 成功响应 data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub current: WorkspaceSpec,
    pub fallback_used: bool,
    pub last_error: Option<String>,
}

/// POST /api/workspaces/open 成功响应 data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceResult {
    pub workspace: WorkspaceSpec,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceFileResult {
    pub workspace_file_path: String,
    pub workspace: WorkspaceSpec,
    pub created: bool,
    pub overwritten: bool,
}

/// PATCH /api/workspaces/current/settings 成功响应 data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchWorkspaceSettingsResult {
    pub settings: serde_json::Value,
}

// ---- 工作区管理器 ----

/// 工作区管理器（Tauri managed state）
pub struct WorkspaceManager {
    inner: Mutex<WorkspaceManagerInner>,
}

struct WorkspaceManagerInner {
    /// 当前活动工作区；首次 open_workspace 之前为 None
    current: Option<WorkspaceSpec>,
    /// 打开计数器，用于生成 id
    next_id: u32,
}

impl WorkspaceManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(WorkspaceManagerInner {
                current: None,
                next_id: 1,
            }),
        }
    }

    /// 获取当前工作区状态；若未打开则初始化 fallback，保证后续文件操作能解析 wf-0
    pub fn get_current(&self) -> WorkspaceState {
        let mut inner = self.inner.lock().unwrap();
        if let Some(ws) = &inner.current {
            return WorkspaceState {
                current: ws.clone(),
                fallback_used: matches!(ws.source, WorkspaceSourceKind::Fallback),
                last_error: None,
            };
        }

        // 返回 fallback 工作区：当前工作目录，同时写入 current 作为事实源
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let folder_name = cwd
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".into());
        let abs = to_posix(&cwd);
        let fallback = WorkspaceSpec {
            id: "fallback".into(),
            name: folder_name,
            source: WorkspaceSourceKind::Fallback,
            source_path: None,
            folders: vec![WorkspaceFolderSpec {
                id: "wf-0".into(),
                name: abs.split('/').last().unwrap_or("workspace").into(),
                absolute_path: abs.clone(),
                original_path: abs,
                is_absolute: true,
            }],
            settings: serde_json::json!({}),
            unsupported_fields: vec![],
            opened_at: chrono_now_iso(),
        };
        inner.current = Some(fallback.clone());
        WorkspaceState {
            current: fallback,
            fallback_used: true,
            last_error: None,
        }
    }

    /// 打开工作区（目录或 .code-workspace 文件）
    pub fn open_workspace(&self, path: &str) -> Result<OpenWorkspaceResult, String> {
        let p = PathBuf::from(path);
        if !p.exists() {
            return Err(format!("路径不存在: {}", path));
        }

        let abs = p
            .canonicalize()
            .map_err(|e| format!("路径规范化失败: {}", e))?;
        let abs_posix = to_posix(&abs);

        let (source, name, folders, source_path, settings, unsupported) =
            if abs.is_dir() {
                // 目录模式
                let dir_name = abs
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "workspace".into());
                (
                    WorkspaceSourceKind::Directory,
                    dir_name,
                    vec![WorkspaceFolderSpec {
                        id: "wf-0".into(),
                        name: abs
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_else(|| "workspace".into()),
                        absolute_path: abs_posix.clone(),
                        original_path: abs_posix,
                        is_absolute: true,
                    }],
                    None::<String>,
                    serde_json::json!({}),
                    vec![] as Vec<UnsupportedField>,
                )
            } else if is_code_workspace_file(&abs) {
                // .code-workspace 文件模式
                let content = std::fs::read_to_string(&abs)
                    .map_err(|e| format!("读取 .code-workspace 失败: {}", e))?;
                let ws_json: serde_json::Value = serde_json::from_str(&content)
                    .map_err(|e| format!("解析 .code-workspace JSON 失败: {}", e))?;

                let file_name = abs
                    .file_stem()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "workspace".into());

                let folders_val = ws_json.get("folders").and_then(|v| v.as_array());
                let parent = abs.parent().unwrap_or(Path::new("."));

                let mut folder_specs = Vec::new();
                if let Some(arr) = folders_val {
                    for (i, item) in arr.iter().enumerate() {
                        let raw_path = item
                            .get("path")
                            .and_then(|v| v.as_str())
                            .unwrap_or(".");
                        let resolved = if Path::new(raw_path).is_absolute() {
                            PathBuf::from(raw_path)
                        } else {
                            parent.join(raw_path)
                        };
                        let canonical = match resolved.canonicalize() {
                            Ok(c) => c,
                            Err(_) => resolved.clone(),
                        };
                        let folder_name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .map(String::from)
                            .unwrap_or_else(|| {
                                canonical
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| format!("folder-{}", i))
                            });
                        folder_specs.push(WorkspaceFolderSpec {
                            id: format!("wf-{}", i),
                            name: folder_name,
                            absolute_path: to_posix(&canonical),
                            original_path: raw_path.into(),
                            is_absolute: Path::new(raw_path).is_absolute(),
                        });
                    }
                }

                if folder_specs.is_empty() {
                    folder_specs.push(WorkspaceFolderSpec {
                        id: "wf-0".into(),
                        name: file_name.clone(),
                        absolute_path: to_posix(parent),
                        original_path: ".".into(),
                        is_absolute: false,
                    });
                }

                // 提取 deepcode. 前缀的 settings
                let settings_obj = ws_json
                    .get("settings")
                    .and_then(|v| v.as_object())
                    .map(|obj| {
                        let mut dc = serde_json::Map::new();
                        for (k, v) in obj {
                            if k.starts_with("deepcode.") {
                                dc.insert(k.clone(), v.clone());
                            }
                        }
                        serde_json::Value::Object(dc)
                    })
                    .unwrap_or(serde_json::json!({}));

                // 识别不支持的字段
                let known_keys = ["folders", "settings"];
                let unsupported: Vec<UnsupportedField> = ws_json
                    .as_object()
                    .map(|obj| {
                        obj.iter()
                            .filter(|(k, _)| !known_keys.contains(&k.as_str()))
                            .map(|(k, v)| UnsupportedField {
                                key: k.clone(),
                                kind: match v {
                                    serde_json::Value::Object(_) => "object".into(),
                                    serde_json::Value::Array(_) => "array".into(),
                                    serde_json::Value::String(_) => "string".into(),
                                    serde_json::Value::Number(_) => "number".into(),
                                    serde_json::Value::Bool(_) => "boolean".into(),
                                    serde_json::Value::Null => "null".into(),
                                },
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                (
                    WorkspaceSourceKind::CodeWorkspace,
                    file_name,
                    folder_specs,
                    Some(abs_posix),
                    settings_obj,
                    unsupported,
                )
            } else {
                return Err(format!(
                    "路径既不是目录也不是 .code-workspace 文件: {}",
                    path
                ));
            };

        let mut inner = self.inner.lock().unwrap();
        let id = format!("ws-{}", inner.next_id);
        inner.next_id += 1;

        let ws = WorkspaceSpec {
            id,
            name,
            source,
            source_path,
            folders,
            settings,
            unsupported_fields: unsupported,
            opened_at: chrono_now_iso(),
        };

        inner.current = Some(ws.clone());

        Ok(OpenWorkspaceResult { workspace: ws })
    }

    pub fn save_workspace_file(
        &self,
        folder_id: Option<String>,
        file_name: Option<String>,
    ) -> Result<SaveWorkspaceFileResult, String> {
        let (current, target_folder) = {
            let inner = self.inner.lock().unwrap();
            let ws = inner
                .current
                .as_ref()
                .ok_or_else(|| "工作区尚未初始化，请先调用 get_current_workspace".to_string())?
                .clone();
            let folder = match folder_id.as_deref() {
                Some(id) => ws
                    .folders
                    .iter()
                    .find(|f| f.id == id)
                    .cloned()
                    .ok_or_else(|| format!("未知 folderId: {}", id))?,
                None => ws
                    .folders
                    .first()
                    .cloned()
                    .ok_or_else(|| "当前工作区没有 folder".to_string())?,
            };
            (ws, folder)
        };

        let root = PathBuf::from(&target_folder.absolute_path);
        if !root.is_dir() {
            return Err(format!(
                "目标 folder 不存在或不是目录: {}",
                target_folder.absolute_path
            ));
        }

        let workspace_file_name =
            sanitize_workspace_file_name(file_name.as_deref().unwrap_or(&current.name));
        let workspace_file = root.join(workspace_file_name);
        if workspace_file.parent() != Some(root.as_path()) {
            return Err("workspace 文件只能保存到当前 folder 根目录".into());
        }

        let folders: Vec<serde_json::Value> = current
            .folders
            .iter()
            .map(|folder| {
                let path = workspace_folder_path_for_file(&root, folder, &target_folder.id);
                serde_json::json!({
                    "path": path,
                    "name": folder.name,
                })
            })
            .collect();
        let payload = serde_json::json!({
            "folders": folders,
            "settings": current.settings,
        });

        let existed = workspace_file.exists();
        let content = serde_json::to_string_pretty(&payload)
            .map_err(|e| format!("序列化 workspace 文件失败: {}", e))?;
        std::fs::write(&workspace_file, format!("{}\n", content))
            .map_err(|e| format!("写入 workspace 文件失败: {}", e))?;

        let workspace_file_path = to_posix(&workspace_file);
        let opened = self.open_workspace(&workspace_file_path)?;
        Ok(SaveWorkspaceFileResult {
            workspace_file_path,
            workspace: opened.workspace,
            created: !existed,
            overwritten: existed,
        })
    }

    /// 合并 DeepCode 命名空间设置（Tauri 内存态，与 Node server 行为对齐）
    pub fn patch_workspace_settings(
        &self,
        settings: serde_json::Value,
    ) -> Result<PatchWorkspaceSettingsResult, String> {
        let mut inner = self.inner.lock().unwrap();
        let ws = inner
            .current
            .as_mut()
            .ok_or_else(|| "工作区尚未初始化，请先调用 get_current_workspace".to_string())?;
        let patch_obj = settings
            .as_object()
            .ok_or_else(|| "settings 必须是对象".to_string())?;

        let mut next = match ws.settings.as_object() {
            Some(obj) => obj.clone(),
            None => serde_json::Map::new(),
        };
        let mut rejected: Vec<String> = Vec::new();
        for (key, value) in patch_obj {
            if !key.starts_with("deepcode.") {
                rejected.push(key.clone());
                continue;
            }
            next.insert(key.clone(), value.clone());
        }
        if !rejected.is_empty() {
            return Err(format!(
                "仅允许 'deepcode.' 前缀的设置键；被拒绝: {}",
                rejected.join(", ")
            ));
        }

        ws.settings = serde_json::Value::Object(next.clone());
        Ok(PatchWorkspaceSettingsResult {
            settings: serde_json::Value::Object(next),
        })
    }

    /// 按 folderId 获取 folder 的绝对路径
    pub fn get_folder_abs_path(&self, folder_id: &str) -> Option<String> {
        let inner = self.inner.lock().unwrap();
        inner.current.as_ref().and_then(|ws| {
            ws.folders
                .iter()
                .find(|f| f.id == folder_id)
                .map(|f| f.absolute_path.clone())
        })
    }
}

// ---- helper ----

/// 路径转 POSIX 风格字符串
fn to_posix(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

/// 判断是否为 .code-workspace 文件
fn is_code_workspace_file(p: &Path) -> bool {
    p.file_name()
        .map(|name| {
            name.to_string_lossy()
                .to_lowercase()
                .ends_with(".code-workspace")
        })
        .unwrap_or(false)
}

fn sanitize_workspace_file_name(input: &str) -> String {
    let trimmed = input.trim();
    let raw = if trimmed.is_empty() {
        "workspace.code-workspace".to_string()
    } else if trimmed.to_lowercase().ends_with(".code-workspace") {
        trimmed.to_string()
    } else {
        format!("{}.code-workspace", trimmed)
    };
    let sanitized: String = raw
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
            ch => ch,
        })
        .collect();
    if sanitized == ".code-workspace" {
        "workspace.code-workspace".into()
    } else {
        sanitized
    }
}

fn workspace_folder_path_for_file(
    workspace_file_dir: &Path,
    folder: &WorkspaceFolderSpec,
    target_folder_id: &str,
) -> String {
    if folder.id == target_folder_id {
        return ".".into();
    }
    let folder_abs = PathBuf::from(&folder.absolute_path);
    match folder_abs.strip_prefix(workspace_file_dir) {
        Ok(relative) if relative.as_os_str().is_empty() => ".".into(),
        Ok(relative) => to_posix(relative),
        Err(_) => folder.absolute_path.clone(),
    }
}

/// 当前时间 ISO 8601 格式（UTC）
fn chrono_now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}
