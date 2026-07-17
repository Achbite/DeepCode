use crate::prelude::*;

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

pub(crate) fn rid(value: &str) -> RequestId {
    RequestId(value.to_string())
}
