// user_settings.rs
//
// 用户设置 Rust 实现（阶段 4 / S4-4）
//
// 与 server 端 [userSettingsService.ts](../../server/src/services/userSettingsService.ts) 行为对齐：
//   - 持久化路径：config/user/<user>/settings/user-settings.json；
//     Linux/macOS 基于 XDG_CONFIG_HOME 或 $HOME/.config；Windows 基于 %APPDATA%
//   - 仅保存"用户实际写入"的 key，从默认值派生的 key 不进入 overrides
//   - PATCH 中显式 null = 恢复默认（从 overrides 中移除该 key）
//   - 原子写：tmp + rename，防止半写损坏
//
// schema 定义：与 protocol/userSettings.ts 同构；DEFAULT_USER_SETTINGS 在 Rust 侧也定义一份。

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

// ---- DTO（与 protocol 对齐）----

/// GET 返回结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetUserSettingsResult {
    pub settings: BTreeMap<String, JsonValue>,
    pub overridden_keys: Vec<String>,
    pub store_path: String,
}

/// PATCH 返回结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchUserSettingsResult {
    pub settings: BTreeMap<String, JsonValue>,
    pub changed_keys: Vec<String>,
}

// ---- 默认值常量 ----

/// 默认设置；与 protocol/userSettings.ts DEFAULT_USER_SETTINGS 同构。
fn build_default_settings() -> BTreeMap<String, JsonValue> {
    let mut m = BTreeMap::new();

    m.insert("editor.tabSize".into(), JsonValue::from(4));
    m.insert("editor.insertSpaces".into(), JsonValue::from(true));
    m.insert("editor.wordWrap".into(), JsonValue::from("off"));
    m.insert("editor.fontSize".into(), JsonValue::from(14));
    m.insert(
        "editor.fontFamily".into(),
        JsonValue::from("Consolas, 'Courier New', monospace"),
    );
    m.insert("editor.renderWhitespace".into(), JsonValue::from("none"));
    m.insert("editor.tabCompletion".into(), JsonValue::from("on"));
    m.insert("editor.accessibilitySupport".into(), JsonValue::from("off"));
    m.insert(
        "editor.unicodeHighlight.invisibleCharacters".into(),
        JsonValue::from(false),
    );

    m.insert("files.autoSave".into(), JsonValue::from("afterDelay"));
    m.insert("files.autoSaveDelay".into(), JsonValue::from(1000));
    m.insert("files.hotExit".into(), JsonValue::from(true));
    m.insert("files.encoding".into(), JsonValue::from("utf8"));
    m.insert("files.eol".into(), JsonValue::from("\n"));

    m.insert(
        "keyboard.enableBasicShortcuts".into(),
        JsonValue::from(true),
    );
    m.insert("explorer.confirmDelete".into(), JsonValue::from(false));

    m.insert("workbench.colorTheme".into(), JsonValue::from("vs-dark"));
    m.insert("workbench.language".into(), JsonValue::from("zh-CN"));
    m.insert(
        "workbench.styleTokenOverrides".into(),
        JsonValue::from("{}"),
    );

    m.insert(
        "terminal.integrated.defaultProfile.windows".into(),
        JsonValue::from("wsl"),
    );
    m.insert(
        "terminal.integrated.prewarm".into(),
        JsonValue::from("afterStartup"),
    );
    m.insert(
        "terminal.integrated.spawnTimeoutMs".into(),
        JsonValue::from(8000),
    );

    m.insert("agent.defaultMode".into(), JsonValue::from("plan"));
    m.insert("agent.defaultWorkflow".into(), JsonValue::from("planFirst"));
    m.insert(
        "agent.permissions.allowFileRead".into(),
        JsonValue::from(true),
    );
    m.insert(
        "agent.permissions.allowFileWrite".into(),
        JsonValue::from(true),
    );
    m.insert(
        "agent.permissions.allowCodeSearch".into(),
        JsonValue::from(true),
    );
    m.insert(
        "agent.permissions.allowShellPropose".into(),
        JsonValue::from(true),
    );
    m.insert(
        "agent.permissions.allowShellExec".into(),
        JsonValue::from(true),
    );
    m.insert(
        "agent.shell.autoExecuteCommands".into(),
        JsonValue::from(false),
    );
    m.insert(
        "agent.shell.commandBlacklist".into(),
        JsonValue::from(
            "rm -rf, del /f, format, shutdown, reboot, git reset --hard, git clean -fd",
        ),
    );

    m.insert("skills.pythonPath".into(), JsonValue::from("python"));
    m.insert("skills.autoLoad".into(), JsonValue::from(true));
    m.insert("skills.mounts".into(), JsonValue::from("[]"));
    m.insert(
        "prompt.defaultProfileId".into(),
        JsonValue::from("default-agent"),
    );
    m.insert(
        "prompt.profiles".into(),
        JsonValue::from("[{\"id\":\"default-agent\",\"name\":\"Default Agent\",\"description\":\"Default coding assistant profile\",\"systemPrompt\":\"You are DeepCode Agent. Work inside the current workspace, explain important risks, and ask for approval before writing files.\",\"enabled\":true}]"),
    );
    m.insert("ruler.enabled".into(), JsonValue::from(true));
    m.insert(
        "ruler.rules".into(),
        JsonValue::from("[{\"id\":\"default-safety\",\"name\":\"Default Safety Boundary\",\"source\":\"system\",\"priority\":100,\"path\":\"<builtin>/default-safety.md\",\"content\":\"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.\",\"enabled\":true}]"),
    );
    m
}

// ---- 持久化路径 ----

fn resolve_store_path() -> PathBuf {
    fn user_id() -> String {
        std::env::var("DEEPCODE_USER_ID")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| "local".into())
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .collect()
    }

    let user_config = |base: PathBuf| {
        base.join("config")
            .join("user")
            .join(user_id())
            .join("settings")
    };

    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").ok().unwrap_or_else(|| {
            // fallback: %USERPROFILE%/AppData/Roaming
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
            format!("{}/AppData/Roaming", home)
        });
        user_config(PathBuf::from(appdata).join("DeepCode")).join("user-settings.json")
    } else {
        let xdg = std::env::var("XDG_CONFIG_HOME").ok();
        let base = match xdg {
            Some(v) if !v.is_empty() => PathBuf::from(v),
            _ => {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                PathBuf::from(home).join(".config")
            }
        };
        user_config(base.join("deepcode")).join("user-settings.json")
    }
}

// ---- 状态 ----

/// 用户覆盖集合；仅持有用户写过的 key
struct State {
    overrides: BTreeMap<String, JsonValue>,
    loaded: bool,
    store_path: PathBuf,
}

impl State {
    fn new() -> Self {
        State {
            overrides: BTreeMap::new(),
            loaded: false,
            store_path: resolve_store_path(),
        }
    }
}

// 进程级单例；首次访问时加载文件
static STATE: Mutex<Option<State>> = Mutex::new(None);

fn with_state<F, R>(f: F) -> R
where
    F: FnOnce(&mut State) -> R,
{
    let mut guard = STATE.lock().expect("user_settings state lock poisoned");
    if guard.is_none() {
        let mut s = State::new();
        load_into(&mut s);
        *guard = Some(s);
    }
    f(guard.as_mut().expect("just initialized"))
}

fn load_into(s: &mut State) {
    if s.loaded {
        return;
    }
    match fs::read_to_string(&s.store_path) {
        Ok(raw) => match serde_json::from_str::<JsonValue>(&raw) {
            Ok(JsonValue::Object(map)) => {
                let mut safe = BTreeMap::new();
                for (k, v) in map.into_iter() {
                    if matches_supported_value(&v) {
                        safe.insert(k, v);
                    }
                }
                s.overrides = safe;
            }
            Ok(_) => {
                // JSON 顶层不是 object：忽略
                s.overrides = BTreeMap::new();
            }
            Err(_e) => {
                // 解析失败：降级为空覆盖；不阻塞 Tauri 启动
                s.overrides = BTreeMap::new();
            }
        },
        Err(_e) => {
            // 文件不存在 / 权限问题：保持空覆盖
            s.overrides = BTreeMap::new();
        }
    }
    s.loaded = true;
}

fn matches_supported_value(v: &JsonValue) -> bool {
    matches!(
        v,
        JsonValue::String(_) | JsonValue::Number(_) | JsonValue::Bool(_) | JsonValue::Null
    )
}

// ---- 合并 ----

fn merge_with_defaults(overrides: &BTreeMap<String, JsonValue>) -> BTreeMap<String, JsonValue> {
    let mut merged = build_default_settings();
    for (k, v) in overrides.iter() {
        merged.insert(k.clone(), v.clone());
    }
    merged
}

// ---- 原子写 ----

fn persist_overrides(s: &State) -> Result<(), String> {
    let dir = s
        .store_path
        .parent()
        .ok_or_else(|| "持久化路径无父目录".to_string())?;
    fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {}", e))?;

    let tmp = s
        .store_path
        .with_extension(format!("json.{}.tmp", std::process::id()));
    let json =
        serde_json::to_string_pretty(&s.overrides).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {}", e))?;
    fs::rename(&tmp, &s.store_path).map_err(|e| format!("rename 失败: {}", e))?;
    Ok(())
}

// ---- public API ----

pub fn get_user_settings() -> GetUserSettingsResult {
    with_state(|s| {
        let merged = merge_with_defaults(&s.overrides);
        let overridden_keys: Vec<String> = s.overrides.keys().cloned().collect();
        let store_path = s.store_path.to_string_lossy().replace('\\', "/");
        GetUserSettingsResult {
            settings: merged,
            overridden_keys,
            store_path,
        }
    })
}

pub fn patch_user_settings(
    patches: BTreeMap<String, JsonValue>,
) -> Result<PatchUserSettingsResult, String> {
    with_state(|s| {
        let before = merge_with_defaults(&s.overrides);
        let mut changed_keys: Vec<String> = Vec::new();

        for (k, v) in patches.into_iter() {
            if v.is_null() {
                if s.overrides.remove(&k).is_some() {
                    changed_keys.push(k);
                }
                continue;
            }
            if !matches_supported_value(&v) {
                continue;
            }
            let prev = s.overrides.get(&k);
            if prev != Some(&v) {
                s.overrides.insert(k, v);
            }
        }

        let after = merge_with_defaults(&s.overrides);
        for (k, v) in after.iter() {
            if before.get(k) != Some(v) && !changed_keys.contains(k) {
                changed_keys.push(k.clone());
            }
        }

        if !changed_keys.is_empty() {
            persist_overrides(s)?;
        }

        Ok(PatchUserSettingsResult {
            settings: after,
            changed_keys,
        })
    })
}
