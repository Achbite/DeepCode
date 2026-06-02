#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) fn kernel_ledger_path() -> Option<PathBuf> {
    if std::env::var("DEEPCODE_LEDGER_BACKEND")
        .map(|value| value.eq_ignore_ascii_case("memory"))
        .unwrap_or(false)
    {
        return None;
    }
    Some(
        std::env::var_os("DEEPCODE_LEDGER_PATH")
            .map(PathBuf::from)
            .unwrap_or_else(|| user_config_root().join("kernel").join("ledger.ndjson")),
    )
}

pub(crate) fn localhost_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE])
}

pub(crate) fn distribution_root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 解析布尔型 env 变量；与 Tauri shell main.rs 中同名实现保持一致。
/// 接受 "1" / "true" / "yes" / "on"（不区分大小写）作为 truthy。
pub(crate) fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let normalized = value.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

pub(crate) fn user_config_root() -> PathBuf {
    if let Some(path) = std::env::var_os("DEEPCODE_CONFIG_DIR") {
        return PathBuf::from(path);
    }
    // 阶段 7/8 review 决策（B-α 精化）：DEEPCODE_PORTABLE=1 时启用便携模式，
    // 让打包发布版（bin/<platform>/DeepCode.exe）的可写配置写到 exe 同目录的
    // config/user/local/，而不是 %APPDATA%/DeepCode 或 ~/.config/deepcode。
    // 注意：bin/<platform>/config/global/ 仍是只读分发资源（prompts/ruler/skills），
    // 不应作为可写路径；secrets/settings 始终走 user/local/ 子目录。
    if env_truthy("DEEPCODE_PORTABLE") {
        return distribution_root()
            .join("config")
            .join("user")
            .join("local");
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

pub(crate) struct DriveLocation {
    pub(crate) display: String,
    pub(crate) path: PathBuf,
}

pub(crate) fn platform_id() -> &'static str {
    match std::env::consts::OS {
        "windows" => "win32",
        other => other,
    }
}

pub(crate) fn drive_locations() -> Vec<DriveLocation> {
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

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

pub(crate) fn normalize_workspace_file_name(name: &str) -> Result<String, String> {
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

pub(crate) fn workspace_file_name_from_label(label: &str) -> String {
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

pub(crate) fn sorted_dir_entries(path: &FsPath) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(compare_dir_entries);
    Ok(entries)
}

pub(crate) fn compare_dir_entries(left: &fs::DirEntry, right: &fs::DirEntry) -> Ordering {
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

pub(crate) fn read_json_file(path: &PathBuf) -> Option<Value> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

pub(crate) fn atomic_write_json(path: &PathBuf, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&tmp, content).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|error| format!("rename {}: {error}", path.display()))
}

pub(crate) fn merge_object(target: &mut Value, patch: &Value) {
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

pub(crate) fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn now_text() -> String {
    now_millis().to_string()
}

pub(crate) fn terminal_session_by_id(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    gui.terminals
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .cloned()
        .map(ApiResponse::ok)
        .unwrap_or_else(|| ApiResponse::error("terminal_not_found", "terminal session not found"))
}

pub(crate) fn update_browser_action(browser: &mut BrowserState, action: &str, result: &str) {
    browser.last_action = Some(action.to_string());
    browser.last_action_at = Some(now_text());
    browser.last_action_result = Some(result.to_string());
}

pub(crate) fn rid(value: &str) -> RequestId {
    RequestId(value.to_string())
}
