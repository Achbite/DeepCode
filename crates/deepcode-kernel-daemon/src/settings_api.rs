#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) async fn user_settings_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "settings": gui.user_settings,
        "overriddenKeys": [],
        "storePath": gui.paths.settings_path.to_string_lossy()
    }))
}

pub(crate) async fn user_settings_patch(
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

pub(crate) async fn llm_profiles_get(State(state): State<AppState>) -> Json<ApiResponse> {
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

pub(crate) async fn llm_profiles_patch(
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

pub(crate) async fn llm_probe(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
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
            "error": error.to_string(),
            "providerError": error
        })),
    }
}

pub(crate) async fn llm_chat(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
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
        Err(error) => Json(ApiResponse {
            ok: false,
            data: Some(json!({ "providerError": error })),
            error: Some("llm_chat_failed".to_string()),
            message: Some(error.to_string()),
        }),
    }
}

pub(crate) fn default_user_settings() -> Value {
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
        "mcp.autoLoad": false,
        "mcp.servers": "[]",
        "ruler.enabled": true,
        "ruler.rules": "[{\"id\":\"default-safety\",\"name\":\"Default Safety Boundary\",\"source\":\"system\",\"priority\":100,\"path\":\"<builtin>/default-safety.md\",\"content\":\"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.\",\"enabled\":true}]"
    })
}

pub(crate) fn default_llm_profiles() -> Value {
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

pub(crate) fn default_workflow_config() -> Value {
    json!({
        "plan": {},
        "check": {},
        "complete": {},
        "review": {}
    })
}
