use crate::prelude::*;
use crate::*;

pub(crate) async fn workspace_sandbox_setup(State(state): State<AppState>) -> Json<ApiResponse> {
    #[cfg(windows)]
    {
        let result = tokio::task::spawn_blocking(
            deepcode_kernel_runtime::workspace_sandbox::windows::request_setup,
        )
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return ApiResponse::error("workspace_sandbox_setup_failed", error),
            Err(error) => {
                return ApiResponse::error("workspace_sandbox_setup_failed", error.to_string())
            }
        }
        let revision = state.gui.lock().expect("gui state lock").user_settings
            ["agent.environmentRevision"]
            .as_u64()
            .unwrap_or(0)
            + 1;
        user_settings_patch(
            State(state),
            Json(json!({"patches":{"agent.environmentRevision": revision}})),
        )
        .await
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        ApiResponse::error(
            "workspace_sandbox_setup_not_applicable",
            "Windows sandbox initialization is available on Windows hosts.",
        )
    }
}

fn setting_activates_at_next_run(key: &str) -> bool {
    key.starts_with("skills.")
        || key.starts_with("mcp.")
        || key.starts_with("plugins.")
        || key.starts_with("agent.web.search.")
        || key.starts_with("agent.documents.")
        || key == "agent.systemPrompt"
        || key.starts_with("agent.permissions.")
        || key.starts_with("agent.windows.")
        || key == "agent.environmentRevision"
        || key == "agent.projectEnvironments"
}

pub(crate) async fn user_settings_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let runtime_settings = match state.local_agent.active_runtime_settings() {
        Ok(settings) => settings,
        Err(error) => {
            return ApiResponse::error("active_runtime_settings_unavailable", error);
        }
    };
    let gui = state.gui.lock().expect("gui state lock");
    let environment = match crate::session_environment::prepare(&gui.user_settings, None, false) {
        Ok(value) => value,
        Err(message) => return ApiResponse::error("session_environment_invalid", message),
    };
    ApiResponse::ok(json!({
        "environment": environment,
        "settings": gui.user_settings,
        "runtimeSettings": runtime_settings,
        "overriddenKeys": [],
        "storePath": gui.paths.settings_path.to_string_lossy()
    }))
}

pub(crate) async fn user_settings_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let _runtime_transition = match state.local_agent.runtime_transition() {
        Ok(transition) => transition,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let patches = body.get("patches").cloned().unwrap_or_else(|| json!({}));
    let Some(patch_object) = patches.as_object() else {
        return ApiResponse::error("invalid_user_settings", "设置补丁必须是 JSON 对象。");
    };
    let (next_settings, settings_path) = {
        let gui = state.gui.lock().expect("gui state lock");
        let mut next = gui.user_settings.clone();
        merge_object(&mut next, &patches);
        (next, gui.paths.settings_path.clone())
    };
    if let Err(message) = validate_agent_runtime_settings(&next_settings) {
        return ApiResponse::error("invalid_agent_runtime_settings", message);
    }
    let changed_keys = patch_object.keys().cloned().collect::<Vec<_>>();
    let has_next_run_activation = changed_keys
        .iter()
        .any(|key| setting_activates_at_next_run(key));
    let immediate_patch = Value::Object(
        patch_object
            .iter()
            .filter(|(key, _)| !setting_activates_at_next_run(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    );
    if let Err(error) = atomic_write_json(&settings_path, &next_settings) {
        return ApiResponse::error("write_settings_failed", error);
    }
    if !immediate_patch
        .as_object()
        .is_some_and(serde_json::Map::is_empty)
    {
        if let Err(error) = state
            .local_agent
            .apply_immediate_runtime_settings(&immediate_patch)
        {
            return ApiResponse::error("active_runtime_settings_update_failed", error);
        }
    }
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.user_settings = next_settings.clone();
    }
    ApiResponse::ok(json!({
        "settings": next_settings,
        "changedKeys": changed_keys,
        "activation": if has_next_run_activation { "nextRun" } else { "immediate" }
    }))
}

pub(crate) async fn llm_profiles_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    gui.llm_profiles
        .settings_response(&gui.paths.llm_profiles_path)
}

pub(crate) async fn llm_profiles_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let _runtime_transition = match state.local_agent.runtime_transition() {
        Ok(transition) => transition,
        Err(error) => return ApiResponse::error("runtime_transition_lock_failed", error),
    };
    let Some(body_object) = body.as_object() else {
        return ApiResponse::error(
            "invalid_llm_profiles_request",
            "LLM Profile 更新必须是 JSON 对象。",
        );
    };
    const REQUEST_FIELDS: &[&str] = &[
        "profiles",
        "profile",
        "removeProfileId",
        "defaultProfileId",
        "secrets",
    ];
    if body_object
        .keys()
        .any(|field| !REQUEST_FIELDS.contains(&field.as_str()))
    {
        return ApiResponse::error(
            "invalid_llm_profiles_request",
            "LLM Profile 更新包含未知字段。",
        );
    }
    if !["profiles", "profile", "removeProfileId"]
        .iter()
        .any(|field| body_object.contains_key(*field))
    {
        let Some(profile_id) = body
            .get("defaultProfileId")
            .and_then(Value::as_str)
            .filter(|_| !body_object.contains_key("secrets"))
        else {
            return ApiResponse::error(
                "invalid_llm_profiles_request",
                "仅选择默认模型时需要 defaultProfileId，不能同时修改 secrets。",
            );
        };
        let mut gui = state.gui.lock().expect("gui state lock");
        let path = gui.paths.llm_profiles_path.clone();
        if let Err(error) = gui.llm_profiles.select_default(&path, profile_id) {
            return ApiResponse::error("select_default_llm_profile_failed", error);
        }
        return gui.llm_profiles.settings_response(&path);
    }
    let body = {
        let gui = state.gui.lock().expect("gui state lock");
        match expand_profile_edit(&gui.llm_profiles, body) {
            Ok(body) => body,
            Err(error) => return ApiResponse::error("invalid_llm_profiles_request", error),
        }
    };
    let Some(profile_items) = body.get("profiles").and_then(Value::as_array) else {
        return ApiResponse::error("invalid_llm_profiles", "profiles 必须是数组。");
    };
    let mut profiles = Value::Array(profile_items.clone());
    let mut profile_ids = std::collections::HashSet::new();
    for profile in profile_items {
        let Some(profile_id) = profile
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.trim() == *value)
        else {
            return ApiResponse::error("invalid_llm_profile", "每个 LLM Profile 都必须有非空 id。");
        };
        if !profile_ids.insert(profile_id.to_string()) {
            return ApiResponse::error(
                "duplicate_llm_profile",
                format!("LLM Profile id 重复：{profile_id}"),
            );
        }
        if let Err(error) = validate_llm_profile(profile) {
            return ApiResponse::error(
                "invalid_llm_profile_schema",
                format!("LLM Profile {profile_id}: {error}"),
            );
        }
    }

    let requested_default = match body.get("defaultProfileId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) if !id.is_empty() && id.trim() == id => Some(id.as_str()),
        _ => {
            return ApiResponse::error(
                "invalid_default_llm_profile",
                "defaultProfileId 必须是非空模型 ID 或 null。",
            )
        }
    };
    if let Some(default_id) = requested_default {
        let enabled = profile_items.iter().any(|profile| {
            profile.get("id").and_then(Value::as_str) == Some(default_id)
                && llm_profile_value_is_enabled(profile)
        });
        if !enabled {
            return ApiResponse::error(
                "invalid_default_llm_profile",
                "defaultProfileId 必须指向一个已启用的 Profile。",
            );
        }
    }

    let submitted_secrets = body.get("secrets").cloned().unwrap_or_else(|| json!({}));
    let Some(submitted_secrets) = submitted_secrets.as_object() else {
        return ApiResponse::error("invalid_llm_secrets", "secrets 必须是 JSON 对象。");
    };
    if submitted_secrets.iter().any(|(profile_id, value)| {
        !profile_ids.contains(profile_id)
            || !(value.is_null()
                || value
                    .as_str()
                    .is_some_and(|secret| !secret.trim().is_empty()))
    }) {
        return ApiResponse::error(
            "invalid_llm_secrets",
            "secrets 只能把已提交的 Profile id 映射到非空字符串或 null。",
        );
    }

    let (profiles_path, secrets_path, old_secret_store) = {
        let gui = state.gui.lock().expect("gui state lock");
        let old_secret_store = match read_optional_json_file(&gui.paths.llm_secrets_path) {
            Ok(Some(value)) if llm_secret_store_is_current(&value) => value,
            Ok(Some(_)) => {
                return ApiResponse::error(
                    "llm_secret_store_invalid",
                    "本地 LLM secret 文件不是当前字符串映射格式。",
                )
            }
            Err(error) => return ApiResponse::error("llm_secret_store_unreadable", error),
            Ok(None) => json!({}),
        };
        (
            gui.paths.llm_profiles_path.clone(),
            gui.paths.llm_secrets_path.clone(),
            old_secret_store,
        )
    };
    let mut next_secret_store = old_secret_store.clone();
    let secret_object = next_secret_store
        .as_object_mut()
        .expect("validated local secret object");
    secret_object.retain(|profile_id, _| profile_ids.contains(profile_id));
    let profile_array = profiles.as_array_mut().expect("cloned profile array");
    for profile in profile_array {
        let profile_id = profile
            .get("id")
            .and_then(Value::as_str)
            .expect("validated profile id")
            .to_string();
        match submitted_secrets.get(&profile_id) {
            Some(Value::String(secret)) => {
                secret_object.insert(profile_id.clone(), json!(secret));
                profile["secretRef"] = json!(format!("local-secret:{profile_id}"));
            }
            Some(Value::Null) => {
                secret_object.remove(&profile_id);
                if let Some(profile) = profile.as_object_mut() {
                    profile.remove("secretRef");
                }
            }
            _ => {}
        }
    }

    let mut next_profiles = json!({
        "profiles": profiles,
        "defaultProfileId": requested_default
    });
    if let Err(error) = validate_llm_profile_store(&next_profiles) {
        return ApiResponse::error("invalid_llm_profile_store_schema", error);
    }
    if let Err(error) = atomic_write_json(&secrets_path, &next_secret_store) {
        return ApiResponse::error("write_llm_secrets_failed", error);
    }
    if let Err(error) = atomic_write_json(&profiles_path, &next_profiles) {
        let rollback_error = atomic_write_json(&secrets_path, &old_secret_store).err();
        let message = rollback_error
            .map(|rollback| format!("{error}；secret 回滚失败：{rollback}"))
            .unwrap_or(error);
        return ApiResponse::error("write_llm_profiles_failed", message);
    }
    {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.llm_profiles = LlmProfileStore::Ready(next_profiles.clone());
    }
    next_profiles["storePath"] = json!(profiles_path.to_string_lossy());
    ApiResponse::ok(next_profiles)
}

pub(crate) async fn llm_probe(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let started = now_millis();
    let profile_id = body.get("profileId").and_then(Value::as_str);
    let profile = {
        let gui = state.gui.lock().expect("gui state lock");
        resolve_llm_profile(&gui, profile_id)
    };
    let profile = match profile {
        Ok(profile) => profile,
        Err(error) => {
            return ApiResponse::ok(json!({
                "ok": false,
                "provider": "openaiCompatible",
                "error": error
            }))
        }
    };
    match probe_llm_profile_stream(&state.local_agent.provider_transport.client, &profile).await {
        Ok(output) => ApiResponse::ok(json!({
            "ok": output.response_present,
            "provider": profile.kind,
            "model": profile.model,
            "latencyMs": now_millis().saturating_sub(started),
            "reasoningPresent": output.reasoning_present,
            "responsePresent": output.response_present,
            "nativeCompletion": {
                "providerKind": output.provider_kind,
                "terminalSignal": output.terminal_signal,
                "finishReason": output.finish_reason
            }
        })),
        Err(error) => {
            let mut result = json!({
                "ok": false,
                "provider": profile.kind,
                "model": profile.model,
                "latencyMs": now_millis().saturating_sub(started),
                "error": error.safe_message(),
                "errorCode": error.code
            });
            if let Some(http_status) = error.http_status {
                result["httpStatus"] = json!(http_status);
            }
            ApiResponse::ok(result)
        }
    }
}

pub(crate) fn default_user_settings() -> Value {
    json!({
        "workbench.language": "zh-CN",
        "workbench.styleTokenOverrides": "{}",
        "workbench.uiPlugins": "[]",
        "agent.systemPrompt": "",
        "agent.responseLanguage": "auto",
        "agent.windows.shell": "auto",
        "agent.windows.gitBashPath": "",
        "agent.environmentRevision": 0,
        "agent.projectEnvironments": "{}",
        "agent.permissions.workspaceMutation": "plan",
        "agent.permissions.engineeringDecisions": "ask",
        "agent.permissions.networkRead": "allow",
        "agent.permissions.external": "ask",
        "agent.web.search.endpointTemplate": "",
        "agent.web.search.authHeaderName": "Authorization",
        "agent.web.search.authSecretRef": "",
        "agent.documents.pythonPath": "",
        "skills.autoLoad": true,
        "skills.mounts": "[]",
        "mcp.autoLoad": false,
        "mcp.servers": "[]",
        "plugins.sources": "[]",
        "plugins.disabled": "[]",
        "gui.colorTheme": "light",
        "gui.accentColor": "blue",
        "gui.navigationDensity": "comfortable",
        "gui.showContextRail": true,
        "gui.showReasoning": false
    })
}

pub(crate) fn validate_agent_runtime_settings(settings: &Value) -> Result<(), String> {
    if settings
        .get("agent.documents.pythonPath")
        .is_some_and(|value| !value.is_string())
    {
        return Err("agent.documents.pythonPath 必须是字符串。".into());
    }
    crate::session_environment::response_language_setting(settings)?;
    crate::session_environment::validate_settings(settings)?;
    if let Some(object) = settings.as_object() {
        for key in object
            .keys()
            .filter(|key| key.starts_with("agent.permissions."))
        {
            if !matches!(
                key.as_str(),
                "agent.permissions.workspaceMutation"
                    | "agent.permissions.engineeringDecisions"
                    | "agent.permissions.networkRead"
                    | "agent.permissions.external"
            ) {
                return Err(format!("{key} 不是当前 Agent Runtime 权限设置。"));
            }
        }
    }
    if let Some(prompt) = settings.get("agent.systemPrompt") {
        let prompt = prompt
            .as_str()
            .ok_or_else(|| "agent.systemPrompt 必须是字符串。".to_string())?;
        if prompt.len() > 64 * 1024 {
            return Err("agent.systemPrompt 超过 65536 字节上限。".to_string());
        }
    }
    for key in [
        "agent.permissions.networkRead",
        "agent.permissions.external",
    ] {
        if let Some(value) = settings.get(key) {
            let Some(value) = value.as_str() else {
                return Err(format!("{key} 必须是 allow、ask 或 deny。"));
            };
            if !matches!(value, "allow" | "ask" | "deny") {
                return Err(format!("{key} 必须是 allow、ask 或 deny。"));
            }
        }
    }
    if let Some(value) = settings.get("agent.permissions.workspaceMutation") {
        if !matches!(value.as_str(), Some("plan" | "allow")) {
            return Err("agent.permissions.workspaceMutation 必须是 plan 或 allow。".to_string());
        }
    }
    if let Some(value) = settings.get("agent.permissions.engineeringDecisions") {
        if !matches!(value.as_str(), Some("ask" | "delegate")) {
            return Err(
                "agent.permissions.engineeringDecisions 必须是 ask 或 delegate。".to_string(),
            );
        }
    }
    for key in [
        "agent.web.search.endpointTemplate",
        "agent.web.search.authHeaderName",
        "agent.web.search.authSecretRef",
    ] {
        if settings.get(key).is_some_and(|value| !value.is_string()) {
            return Err(format!("{key} 必须是字符串。"));
        }
    }
    Ok(())
}
