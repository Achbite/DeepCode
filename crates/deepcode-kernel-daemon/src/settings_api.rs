#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

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
    let old_hash = config_value_hash(&gui.user_settings);
    merge_object(&mut gui.user_settings, &patches);
    let new_hash = config_value_hash(&gui.user_settings);
    let changed_keys = patches
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    match atomic_write_json(&gui.paths.settings_path, &gui.user_settings) {
        Ok(()) => {
            let store_path = gui.paths.settings_path.to_string_lossy().to_string();
            drop(gui);
            let config_audit = record_config_modified_audit(
                &state,
                "userSettings",
                changed_keys.clone(),
                Some(store_path),
                Some(old_hash),
                Some(new_hash),
                "settings_api.user_settings_patch",
            );
            let gui = state.gui.lock().expect("gui state lock");
            ApiResponse::ok(json!({
                "settings": gui.user_settings,
                "changedKeys": changed_keys,
                "configAudit": config_audit
            }))
        }
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
    let old_hash = config_value_hash(&gui.llm_profiles);
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
        Ok(()) => {
            let new_hash = config_value_hash(&gui.llm_profiles);
            let mut changed_keys = vec!["profiles".to_string(), "defaultProfileId".to_string()];
            if secrets
                .as_object()
                .map(|object| !object.is_empty())
                .unwrap_or(false)
            {
                changed_keys.push("secrets".to_string());
            }
            let store_path = gui.paths.llm_profiles_path.to_string_lossy().to_string();
            let output = gui.llm_profiles.clone();
            drop(gui);
            let config_audit = record_config_modified_audit(
                &state,
                "llmProfiles",
                changed_keys,
                Some(store_path),
                Some(old_hash),
                Some(new_hash),
                "settings_api.llm_profiles_patch",
            );
            let mut output = output;
            if let Some(object) = output.as_object_mut() {
                object.insert("configAudit".to_string(), config_audit);
            }
            ApiResponse::ok(output)
        }
        Err(error) => ApiResponse::error("write_llm_profiles_failed", error),
    }
}

fn record_config_modified_audit(
    state: &AppState,
    config_kind: &str,
    changed_keys: Vec<String>,
    store_path: Option<String>,
    old_hash: Option<String>,
    new_hash: Option<String>,
    source: &str,
) -> Value {
    match state
        .runtime
        .lock()
        .expect("runtime state lock")
        .config_modified_audit(
            config_kind,
            changed_keys.clone(),
            store_path.clone(),
            old_hash.clone(),
            new_hash.clone(),
            source,
        ) {
        Ok(value) => value,
        Err(error) => json!({
            "configKind": config_kind,
            "changedKeys": changed_keys,
            "storePath": store_path,
            "oldHash": old_hash,
            "newHash": new_hash,
            "source": source,
            "message": "配置文件已修改，但写入 Kernel 审计记录失败。",
            "auditError": error.to_string()
        }),
    }
}

fn config_value_hash(value: &Value) -> String {
    let mut hasher = DefaultHasher::new();
    serde_json::to_string(value)
        .unwrap_or_default()
        .hash(&mut hasher);
    format!("{:016x}", hasher.finish())
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
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => return json_body_rejection_response("/api/llm/chat", rejection),
    };
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
    let mut request_envelope = json!({
        "messages": messages,
        "tools": body.get("tools").cloned().unwrap_or_else(|| json!([]))
    });
    if let Some(response_format) = body
        .get("responseFormat")
        .or_else(|| body.get("response_format"))
    {
        request_envelope["responseFormat"] = response_format.clone();
    }
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

pub(crate) async fn llm_chat_stream(
    State(state): State<AppState>,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            let (_, message) = json_body_rejection_error("/api/llm/chat/stream", &rejection);
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "error": "http_body_rejected",
                "message": message,
                "route": "/api/llm/chat/stream",
                "status": rejection.status().as_u16(),
                "bodyLimitBytes": LARGE_JSON_BODY_LIMIT_BYTES,
                "suggestion": "Compact provider traces and avoid archiving raw streaming chunks or full provider payload arrays."
            }));
        }
    };
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
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "error": error,
            }));
        }
    };
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut request_envelope = json!({
        "messages": messages,
        "tools": body.get("tools").cloned().unwrap_or_else(|| json!([]))
    });
    if let Some(response_format) = body
        .get("responseFormat")
        .or_else(|| body.get("response_format"))
    {
        request_envelope["responseFormat"] = response_format.clone();
    }
    llm_stream_response(profile, request_envelope)
}

fn llm_stream_error_response(data: Value) -> Response {
    let body = format!(
        "event: provider_error\ndata: {}\n\n",
        serde_json::to_string(&data)
            .unwrap_or_else(|_| "{\"type\":\"provider_error\"}".to_string())
    );
    (
        [
            (header::CONTENT_TYPE, "text/event-stream; charset=utf-8"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

pub(crate) fn default_user_settings() -> Value {
    let mut settings = json!({
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
        "agent.requirementConfirmationMode": "auto",
        "agent.reviewContinuationMode": "auto",
        "agent.permissions.allowFileRead": true,
        "agent.permissions.allowFileWrite": true,
        "agent.permissions.allowCodeSearch": true,
        "agent.permissions.allowShellPropose": true,
        "agent.permissions.allowShellExec": true,
        "agent.permissions.processExec": "ask",
        "agent.permissions.networkEgress": "ask",
        "agent.permissions.gitWrite": "ask",
        "agent.permissions.browserControl": "ask",
        "agent.permissions.providerEgress": "ask",
        "agent.shell.autoExecuteCommands": false,
        "skills.pythonPath": "python",
        "skills.autoLoad": true,
        "skills.mounts": "[]",
        "mcp.autoLoad": false,
        "mcp.servers": "[]",
        "ruler.enabled": true,
        "ruler.rules": "[{\"id\":\"default-safety\",\"name\":\"Default Safety Boundary\",\"source\":\"system\",\"priority\":100,\"path\":\"<builtin>/default-safety.md\",\"content\":\"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.\",\"enabled\":true}]"
    });
    merge_object(
        &mut settings,
        &json!({
            "agent.permissions.gitPush": "ask",
            "agent.git.commitMessageMode": "generate",
            "agent.integrations.github.enabled": false,
            "agent.integrations.github.repoUrl": "",
            "agent.integrations.github.authSecretRef": "",
            "agent.integrations.github.defaultRemote": "origin",
            "agent.integrations.github.pushPolicy": "manual"
        }),
    );
    settings["agent.interventionLevel"] = json!("medium");
    settings
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
