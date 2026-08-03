use crate::prelude::*;
use crate::*;
use std::sync::OnceLock;

pub(crate) fn settings_transition_gate_v2() -> &'static tokio::sync::RwLock<()> {
    static GATE: OnceLock<tokio::sync::RwLock<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::RwLock::new(()))
}

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
    let _transition = settings_transition_gate_v2().write().await;
    let patches = body.get("patches").cloned().unwrap_or_else(|| json!({}));
    if let Err(message) = validate_permission_setting_patch(&patches) {
        return ApiResponse::error("invalid_permission_setting", message);
    }
    let (
        old_settings,
        old_hash,
        next_settings,
        new_hash,
        changed_keys,
        settings_path,
        secrets_path,
    ) = {
        let gui = state.gui.lock().expect("gui state lock");
        let old_settings = gui.user_settings.clone();
        let old_hash = match config_value_hash(&gui.user_settings) {
            Ok(hash) => hash,
            Err(error) => {
                return ApiResponse::error("config_digest_failed", error.message);
            }
        };
        let mut next_settings = gui.user_settings.clone();
        merge_object(&mut next_settings, &patches);
        if let Err(message) = validate_permission_settings(&next_settings) {
            return ApiResponse::error("invalid_permission_setting", message);
        }
        let new_hash = match config_value_hash(&next_settings) {
            Ok(hash) => hash,
            Err(error) => {
                return ApiResponse::error("config_digest_failed", error.message);
            }
        };
        let changed_keys = patches
            .as_object()
            .map(|object| object.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let settings_path = gui.paths.settings_path.clone();
        (
            old_settings,
            old_hash,
            next_settings,
            new_hash,
            changed_keys,
            settings_path,
            gui.paths.llm_secrets_path.clone(),
        )
    };

    let kernel_transition = changed_keys
        .iter()
        .any(|key| kernel_setting_requires_fresh_run_v2(key));
    let executor_transition = changed_keys
        .iter()
        .any(|key| executor_setting_changed_v2(key));
    let retired_runs = if kernel_transition {
        match retire_all_active_kernel_runs_v2(&state).await {
            Ok(retired) => retired,
            Err((retired, failures)) => {
                let transition = json!({
                    "status": "failedBeforeApply",
                    "kernelTransition": true,
                    "executorTransition": executor_transition,
                    "retiredRuns": retired,
                    "retirementFailures": failures
                });
                let config_audit = record_config_modified_audit(
                    &state,
                    "userSettings",
                    &changed_keys,
                    &settings_path,
                    &old_hash,
                    &new_hash,
                    "settings_api.user_settings_patch",
                    transition.clone(),
                );
                return ApiResponse::error_with_data(
                    "settings_transition_failed_before_apply",
                    "Kernel-affecting Settings were not changed because active Runs could not all be retired",
                    json!({
                        "transition": transition,
                        "configAudit": config_audit
                    }),
                );
            }
        }
    } else {
        Vec::new()
    };

    let previous_executor = executor_transition
        .then(|| runtime_tool_configuration_for_settings(&old_settings, &secrets_path));
    if executor_transition {
        let (tool_config, secret_provider) =
            runtime_tool_configuration_for_settings(&next_settings, &secrets_path);
        if let Err(error) = state
            .kernel_v2
            .service()
            .replace_executor_runtime_host(tool_config, Arc::new(secret_provider))
        {
            let transition = json!({
                "status": "failedBeforeApply",
                "kernelTransition": true,
                "executorTransition": true,
                "retiredRuns": retired_runs,
                "kernelError": format!("{error:?}")
            });
            let config_audit = record_config_modified_audit(
                &state,
                "userSettings",
                &changed_keys,
                &settings_path,
                &old_hash,
                &new_hash,
                "settings_api.user_settings_patch",
                transition.clone(),
            );
            return ApiResponse::error_with_data(
                "settings_executor_transition_failed",
                "Kernel executor configuration could not be replaced; Settings were not changed",
                json!({
                    "transition": transition,
                    "configAudit": config_audit
                }),
            );
        }
    }
    if let Err(error) = atomic_write_json(&settings_path, &next_settings) {
        let rollback = previous_executor.map(|(tool_config, secret_provider)| {
            state
                .kernel_v2
                .service()
                .replace_executor_runtime_host(tool_config, Arc::new(secret_provider))
        });
        let rollback_closed = rollback.as_ref().is_none_or(Result::is_ok);
        let transition = json!({
            "status": if rollback_closed { "failedBeforeApply" } else { "indeterminate" },
            "kernelTransition": kernel_transition,
            "executorTransition": executor_transition,
            "retiredRuns": retired_runs,
            "executorRollbackClosed": rollback_closed,
            "writeError": error
        });
        let config_audit = record_config_modified_audit(
            &state,
            "userSettings",
            &changed_keys,
            &settings_path,
            &old_hash,
            &new_hash,
            "settings_api.user_settings_patch",
            transition.clone(),
        );
        return ApiResponse::error_with_data(
            if rollback_closed {
                "write_settings_failed"
            } else {
                "settings_transition_indeterminate"
            },
            "Settings persistence failed after the Kernel transition was prepared",
            json!({
                "transition": transition,
                "configAudit": config_audit
            }),
        );
    }
    let settings = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.user_settings = next_settings;
        gui.user_settings.clone()
    };
    let transition = json!({
        "status": "applied",
        "kernelTransition": kernel_transition,
        "executorTransition": executor_transition,
        "retiredRuns": retired_runs
    });
    let config_audit = record_config_modified_audit(
        &state,
        "userSettings",
        &changed_keys,
        &settings_path,
        &old_hash,
        &new_hash,
        "settings_api.user_settings_patch",
        transition.clone(),
    );
    ApiResponse::ok(json!({
        "settings": settings,
        "changedKeys": changed_keys,
        "retiredRuns": retired_runs,
        "transition": transition,
        "configAudit": config_audit
    }))
}

fn kernel_setting_requires_fresh_run_v2(key: &str) -> bool {
    matches!(
        key,
        "agent.permissions.workspaceRead"
            | "agent.permissions.workspaceWrite"
            | "agent.permissions.gitWrite"
            | "agent.permissions.webRead"
            | "agent.permissions.privateWebRead"
            | "agent.permissions.autoApprovePlans"
            | "agent.web.search.endpointTemplate"
            | "agent.web.search.authHeaderName"
            | "agent.web.search.authSecretRef"
    )
}

fn executor_setting_changed_v2(key: &str) -> bool {
    matches!(
        key,
        "agent.web.search.endpointTemplate"
            | "agent.web.search.authHeaderName"
            | "agent.web.search.authSecretRef"
    )
}

async fn retire_all_active_kernel_runs_v2(
    state: &AppState,
) -> Result<Vec<String>, (Vec<String>, Vec<String>)> {
    let active_runs = match state.host_services.active_runs_v2.active_run_records() {
        Ok(records) => records,
        Err(error) => return Err((Vec::new(), vec![format!("active-run-scan:{}", error.code)])),
    };
    let mut retired = Vec::new();
    let mut failures = Vec::new();
    for active in active_runs {
        match state
            .kernel_session_v2
            .retire_run(&active.session_id, &active.host_run_id, &active.run_id)
            .await
        {
            Ok(_) => retired.push(active.host_run_id),
            Err(error) => failures.push(format!("{}:{}", active.host_run_id, error.code)),
        }
    }
    if failures.is_empty() {
        Ok(retired)
    } else {
        Err((retired, failures))
    }
}

fn validate_permission_setting_patch(patches: &Value) -> Result<(), String> {
    let Some(patches) = patches.as_object() else {
        return Err("settings patches must be an object".to_string());
    };
    for key in [
        "agent.permissions.workspaceRead",
        "agent.permissions.workspaceWrite",
        "agent.permissions.gitWrite",
        "agent.permissions.webRead",
        "agent.permissions.privateWebRead",
    ] {
        let Some(value) = patches.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        if !matches!(value.as_str(), Some("allow" | "ask" | "deny")) {
            return Err(format!("{key} must be exactly allow, ask, deny, or null"));
        }
    }
    if patches
        .get("agent.permissions.autoApprovePlans")
        .is_some_and(|value| !value.is_null() && !value.is_boolean())
    {
        return Err("agent.permissions.autoApprovePlans must be a boolean or null".to_string());
    }
    Ok(())
}

fn validate_permission_settings(settings: &Value) -> Result<(), String> {
    let Some(settings) = settings.as_object() else {
        return Err("settings must be an object".to_string());
    };
    for key in [
        "agent.permissions.workspaceRead",
        "agent.permissions.workspaceWrite",
        "agent.permissions.gitWrite",
        "agent.permissions.webRead",
        "agent.permissions.privateWebRead",
    ] {
        let Some(value) = settings.get(key) else {
            continue;
        };
        if !matches!(value.as_str(), Some("allow" | "ask" | "deny")) {
            return Err(format!("{key} must be exactly allow, ask, or deny"));
        }
    }
    if settings
        .get("agent.permissions.autoApprovePlans")
        .is_some_and(|value| !value.is_boolean())
    {
        return Err("agent.permissions.autoApprovePlans must be a boolean".to_string());
    }
    Ok(())
}

fn mask_unavailable_llm_profile_revisions(
    state: &AppState,
    profiles: &mut Value,
    assumed_available_profile_ids: &std::collections::HashSet<String>,
) -> Result<(), (String, String)> {
    let Some(profile_items) = profiles.get_mut("profiles").and_then(Value::as_array_mut) else {
        return Err((
            "invalid_llm_profiles".to_string(),
            "The LLM Profile store does not contain a profiles array".to_string(),
        ));
    };
    for profile in profile_items {
        if profile.get("enabled").and_then(Value::as_bool) != Some(true)
            || !profile_reasoning_transport_is_compatible(profile)
        {
            continue;
        }
        let Some(profile_id) = profile.get("id").and_then(Value::as_str) else {
            return Err((
                "invalid_llm_profile".to_string(),
                "An enabled LLM Profile has no identity".to_string(),
            ));
        };
        if assumed_available_profile_ids.contains(profile_id.trim()) {
            continue;
        }
        let profile_revision = config_value_hash(profile)
            .map_err(|error| ("config_digest_failed".to_string(), error.message))?;
        match state
            .provider_trace_v1
            .profile_revision_is_unavailable(profile_id, &profile_revision)
        {
            Ok(false) => {}
            Ok(true) => profile["enabled"] = Value::Bool(false),
            Err(error) => {
                return Err((
                    error.code.to_string(),
                    "Provider Profile availability could not be verified".to_string(),
                ))
            }
        }
    }
    profiles["defaultProfileId"] = preferred_enabled_llm_profile_id(profiles)
        .map(Value::String)
        .unwrap_or(Value::Null);
    Ok(())
}

pub(crate) async fn llm_profiles_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let _transition = settings_transition_gate_v2().read().await;
    let (mut profiles, store_path) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.llm_profiles.clone(),
            gui.paths.llm_profiles_path.to_string_lossy().to_string(),
        )
    };
    if let Err((code, message)) = mask_unavailable_llm_profile_revisions(
        &state,
        &mut profiles,
        &std::collections::HashSet::new(),
    ) {
        return ApiResponse::error(code, message);
    }
    if let Some(object) = profiles.as_object_mut() {
        object.insert("storePath".to_string(), Value::String(store_path));
    }
    ApiResponse::ok(profiles)
}

pub(crate) async fn llm_profiles_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let _transition = settings_transition_gate_v2().write().await;
    let mut gui = state.gui.lock().expect("gui state lock");
    let mut profiles = body.get("profiles").cloned().unwrap_or_else(|| json!([]));
    let Some(profile_items) = profiles.as_array() else {
        return ApiResponse::error("invalid_llm_profiles", "profiles must be an array");
    };
    let mut profile_ids = std::collections::HashSet::new();
    for profile in profile_items {
        let Some(profile_id) = profile
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|profile_id| !profile_id.is_empty())
        else {
            return ApiResponse::error(
                "invalid_llm_profile",
                "every LLM Profile must have a non-empty id",
            );
        };
        if !profile_ids.insert(profile_id.to_string()) {
            return ApiResponse::error(
                "duplicate_llm_profile",
                format!("LLM Profile id `{profile_id}` is duplicated"),
            );
        }
        if !profile_reasoning_transport_is_compatible(profile) {
            return ApiResponse::error(
                "invalid_llm_profile_reasoning_transport",
                format!("LLM Profile `{profile_id}` requires a kind-compatible reasoningTransport"),
            );
        }
        if profile.get("enabled").and_then(Value::as_bool) == Some(true)
            && profile.get("thinking").and_then(Value::as_str) != Some("enabled")
        {
            return ApiResponse::error(
                "invalid_llm_profile_thinking",
                format!(
                    "Enabled LLM Profile `{profile_id}` requires plaintext thinking to be enabled"
                ),
            );
        }
    }
    let reenable_profile_ids = match body.get("reenableProfileIds") {
        None => std::collections::HashSet::new(),
        Some(Value::Array(profile_ids_to_reenable)) => {
            let mut requested = std::collections::HashSet::new();
            for profile_id in profile_ids_to_reenable {
                let Some(profile_id) = profile_id
                    .as_str()
                    .map(str::trim)
                    .filter(|profile_id| !profile_id.is_empty())
                else {
                    return ApiResponse::error(
                        "invalid_llm_profile_reenable_ids",
                        "reenableProfileIds must contain only non-empty Profile ids",
                    );
                };
                if !requested.insert(profile_id.to_string()) {
                    return ApiResponse::error(
                        "duplicate_llm_profile_reenable_id",
                        format!("LLM Profile re-enable id `{profile_id}` is duplicated"),
                    );
                }
                if !profile_ids.contains(profile_id) {
                    return ApiResponse::error(
                        "unknown_llm_profile_reenable_id",
                        format!(
                            "LLM Profile re-enable id `{profile_id}` is not present in profiles"
                        ),
                    );
                }
            }
            requested
        }
        Some(_) => {
            return ApiResponse::error(
                "invalid_llm_profile_reenable_ids",
                "reenableProfileIds must be an array when provided",
            )
        }
    };
    let secrets = body.get("secrets").cloned().unwrap_or_else(|| json!({}));
    let Some(secret_items) = secrets.as_object() else {
        return ApiResponse::error("invalid_llm_secrets", "secrets must be an object");
    };
    let secrets_path = gui.paths.llm_secrets_path.clone();
    let old_secret_store = match read_json_file(&secrets_path) {
        Some(value) => value,
        None if secrets_path.exists() => {
            return ApiResponse::error(
                "llm_secret_store_unreadable",
                "The existing LLM secret store could not be decoded; it was not overwritten",
            )
        }
        None => json!({}),
    };
    let mut secret_store = old_secret_store.clone();
    if let (Some(profile_items), Some(secret_items), Some(secret_object)) = (
        profiles.as_array_mut(),
        Some(secret_items),
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
    let requested_default_profile_id = body
        .get("defaultProfileId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|profile_id| !profile_id.is_empty());
    let mut next_profiles = json!({
        "profiles": profiles,
        "defaultProfileId": requested_default_profile_id,
        "storePath": gui.paths.llm_profiles_path.to_string_lossy()
    });
    next_profiles["defaultProfileId"] = preferred_enabled_llm_profile_id(&next_profiles)
        .map(Value::String)
        .unwrap_or(Value::Null);

    let mut active_profile_ids = {
        let runs = state.session_runs.lock().expect("session run state lock");
        runs.values()
            .filter(|run| {
                matches!(run.status.as_str(), "running" | "cancelling")
                    || (run.status == "waiting"
                        && session_has_pending_interaction(&state, &run.session_id))
            })
            .filter_map(|run| run.profile_id.clone())
            .collect::<std::collections::HashSet<_>>()
    };
    for session in &gui.sessions {
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        if !session_has_pending_interaction(&state, session_id) {
            continue;
        }
        if let Some(profile_id) = session.get("profileId").and_then(Value::as_str) {
            active_profile_ids.insert(profile_id.to_string());
        }
    }
    for profile_id in &active_profile_ids {
        let current = profile_value_by_id(&gui.llm_profiles, profile_id);
        let next = profile_value_by_id(&next_profiles, profile_id);
        let secret_changed = secrets
            .get(profile_id)
            .and_then(Value::as_str)
            .is_some_and(|secret| !secret.trim().is_empty());
        if current != next || secret_changed {
            return ApiResponse::error(
                "llm_profile_locked",
                format!(
                    "LLM Profile `{profile_id}` is locked by an active session run or pending interaction"
                ),
            );
        }
    }

    let old_profiles = gui.llm_profiles.clone();
    let old_sessions = gui.sessions.clone();
    let old_secret_hash = match config_value_hash(&old_secret_store) {
        Ok(hash) => hash,
        Err(error) => return ApiResponse::error("config_digest_failed", error.message),
    };
    let old_hash = match config_value_hash(&json!({
        "profiles": &old_profiles,
        "secretStoreDigest": old_secret_hash
    })) {
        Ok(hash) => hash,
        Err(error) => return ApiResponse::error("config_digest_failed", error.message),
    };
    let new_secret_hash = match config_value_hash(&secret_store) {
        Ok(hash) => hash,
        Err(error) => return ApiResponse::error("config_digest_failed", error.message),
    };
    let new_hash = match config_value_hash(&json!({
        "profiles": &next_profiles,
        "secretStoreDigest": new_secret_hash
    })) {
        Ok(hash) => hash,
        Err(error) => return ApiResponse::error("config_digest_failed", error.message),
    };
    let mut reenabled_profile_revisions = Vec::new();
    for profile in next_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|profile| {
            profile
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|profile_id| reenable_profile_ids.contains(profile_id.trim()))
        })
    {
        let Some(profile_id) = profile.get("id").and_then(Value::as_str) else {
            continue;
        };
        let profile_revision = match config_value_hash(profile) {
            Ok(revision) => revision,
            Err(error) => return ApiResponse::error("config_digest_failed", error.message),
        };
        match state
            .provider_trace_v1
            .profile_revision_is_unavailable(profile_id, &profile_revision)
        {
            Ok(false) => {}
            Ok(true) => {
                reenabled_profile_revisions.push((profile_id.to_string(), profile_revision))
            }
            Err(error) => {
                return ApiResponse::error(
                    error.code,
                    "Provider Profile availability could not be verified before applying the configuration",
                )
            }
        }
    }
    let mut effective_next_profiles = next_profiles.clone();
    if let Err((code, message)) = mask_unavailable_llm_profile_revisions(
        &state,
        &mut effective_next_profiles,
        &reenable_profile_ids,
    ) {
        return ApiResponse::error(code, message);
    }
    let preferred_profile_id = preferred_enabled_llm_profile_id(&effective_next_profiles);
    let mut next_sessions = old_sessions.clone();
    let mut profile_migrations = Vec::new();
    if let Some(preferred_profile_id) = preferred_profile_id.as_deref() {
        for session in &mut next_sessions {
            let current_profile_id = session
                .get("profileId")
                .and_then(Value::as_str)
                .map(str::to_string);
            if current_profile_id.as_deref().is_some_and(|profile_id| {
                llm_profile_is_enabled(&effective_next_profiles, profile_id)
            }) {
                continue;
            }
            let Some(session_id) = session
                .get("id")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            session["profileId"] = json!(preferred_profile_id);
            session["updatedAt"] = json!(now_text());
            let mut migration = json!({
                "sessionId": session_id,
                "toProfileId": preferred_profile_id
            });
            if let Some(current_profile_id) = current_profile_id {
                migration["fromProfileId"] = json!(current_profile_id);
            }
            profile_migrations.push(migration);
        }
    }

    let secrets_changed = secret_store != old_secret_store;
    let web_secret_key = gui
        .user_settings
        .get("agent.web.search.authSecretRef")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.strip_prefix("local-secret:").unwrap_or(value));
    let executor_transition = web_secret_key.is_some_and(|key| {
        secret_items
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|secret| !secret.trim().is_empty())
    });
    if executor_transition {
        let active_runs = match state.host_services.active_runs_v2.active_run_records() {
            Ok(records) => records,
            Err(error) => {
                return ApiResponse::error(
                    "llm_executor_active_run_scan_failed",
                    format!(
                        "Active Run discovery failed before the executor Secret changed: {}",
                        error.message
                    ),
                )
            }
        };
        if !active_runs.is_empty() {
            return ApiResponse::error_with_data(
                "llm_executor_secret_locked",
                "The web.search executor Secret is locked while Kernel Runs are active",
                json!({
                    "transition": {
                        "status": "failedBeforeApply",
                        "executorTransition": true,
                        "activeHostRunIds": active_runs
                            .iter()
                            .map(|run| run.host_run_id.clone())
                            .collect::<Vec<_>>()
                    }
                }),
            );
        }
    }

    let profiles_path = gui.paths.llm_profiles_path.clone();
    let sessions_index_path = gui.paths.sessions_index_path.clone();
    let mut changed_keys = vec!["profiles".to_string(), "defaultProfileId".to_string()];
    if secrets_changed {
        changed_keys.push("secrets".to_string());
    }
    let mut previous_executor = executor_transition
        .then(|| runtime_tool_configuration_from_values(&gui.user_settings, &old_secret_store));
    if executor_transition {
        let (tool_config, secret_provider) =
            runtime_tool_configuration_from_values(&gui.user_settings, &secret_store);
        if let Err(error) = state
            .kernel_v2
            .service()
            .replace_executor_runtime_host(tool_config, Arc::new(secret_provider))
        {
            let transition = json!({
                "status": "failedBeforeApply",
                "executorTransition": true,
                "kernelError": format!("{error:?}")
            });
            let config_audit = record_config_modified_audit(
                &state,
                "llmProfiles",
                &changed_keys,
                &profiles_path,
                &old_hash,
                &new_hash,
                "settings_api.llm_profiles_patch",
                transition.clone(),
            );
            return ApiResponse::error_with_data(
                "llm_executor_transition_failed",
                "The Kernel executor Secret binding could not be replaced",
                json!({
                    "transition": transition,
                    "configAudit": config_audit
                }),
            );
        }
    }

    let mut secret_written = false;
    if secrets_changed {
        if let Err(error) = atomic_write_json(&secrets_path, &secret_store) {
            let executor_rollback_closed =
                rollback_executor_runtime_v2(&state, &mut previous_executor);
            let transition = json!({
                "status": if executor_rollback_closed { "failedBeforeApply" } else { "indeterminate" },
                "executorTransition": executor_transition,
                "executorRollbackClosed": executor_rollback_closed,
                "writeError": error
            });
            let config_audit = record_config_modified_audit(
                &state,
                "llmProfiles",
                &changed_keys,
                &profiles_path,
                &old_hash,
                &new_hash,
                "settings_api.llm_profiles_patch",
                transition.clone(),
            );
            return ApiResponse::error_with_data(
                "write_llm_secret_failed",
                "The LLM Secret store was not changed",
                json!({
                    "transition": transition,
                    "configAudit": config_audit
                }),
            );
        }
        secret_written = true;
    }
    if let Err(error) = atomic_write_json(&profiles_path, &next_profiles) {
        let mut rollback_errors = Vec::new();
        if secret_written {
            if let Err(rollback_error) = atomic_write_json(&secrets_path, &old_secret_store) {
                rollback_errors.push(format!("secretStore:{rollback_error}"));
            }
        }
        if !rollback_executor_runtime_v2(&state, &mut previous_executor) {
            rollback_errors.push("executorRuntime:rollback_failed".to_string());
        }
        let transition = json!({
            "status": if rollback_errors.is_empty() { "failedBeforeApply" } else { "indeterminate" },
            "executorTransition": executor_transition,
            "writeError": error,
            "rollbackErrors": rollback_errors
        });
        let config_audit = record_config_modified_audit(
            &state,
            "llmProfiles",
            &changed_keys,
            &profiles_path,
            &old_hash,
            &new_hash,
            "settings_api.llm_profiles_patch",
            transition.clone(),
        );
        return ApiResponse::error_with_data(
            "write_llm_profiles_failed",
            "The LLM Profile store could not be changed",
            json!({
                "transition": transition,
                "configAudit": config_audit
            }),
        );
    }
    if !profile_migrations.is_empty() {
        if let Err(error) = crate::session_metadata_v2::persist_session_index_values(
            &sessions_index_path,
            &next_sessions,
        ) {
            let mut rollback_errors = Vec::new();
            if let Err(rollback_error) = atomic_write_json(&profiles_path, &old_profiles) {
                rollback_errors.push(format!("profiles:{rollback_error}"));
            }
            if secret_written {
                if let Err(rollback_error) = atomic_write_json(&secrets_path, &old_secret_store) {
                    rollback_errors.push(format!("secretStore:{rollback_error}"));
                }
            }
            if !rollback_executor_runtime_v2(&state, &mut previous_executor) {
                rollback_errors.push("executorRuntime:rollback_failed".to_string());
            }
            let transition = json!({
                "status": if rollback_errors.is_empty() { "failedBeforeApply" } else { "indeterminate" },
                "executorTransition": executor_transition,
                "writeError": error,
                "rollbackErrors": rollback_errors
            });
            let config_audit = record_config_modified_audit(
                &state,
                "llmProfiles",
                &changed_keys,
                &profiles_path,
                &old_hash,
                &new_hash,
                "settings_api.llm_profiles_patch",
                transition.clone(),
            );
            return ApiResponse::error_with_data(
                "agent_session_persist_failed",
                "Profile migration could not be persisted; the configuration change was rolled back",
                json!({
                    "transition": transition,
                    "configAudit": config_audit
                }),
            );
        }
    }

    gui.llm_profiles = next_profiles.clone();
    gui.sessions = next_sessions;
    drop(gui);
    for (profile_id, profile_revision) in &reenabled_profile_revisions {
        if let Err(error) = state
            .provider_trace_v1
            .mark_profile_revision_available(profile_id, profile_revision)
        {
            return ApiResponse::error_with_data(
                "provider_profile_reenable_record_failed",
                "LLM Profile configuration was saved, but its explicit availability record could not be persisted",
                json!({
                    "profileId": profile_id,
                    "profileRevision": profile_revision,
                    "recordError": error.code,
                }),
            );
        }
    }
    let transition = json!({
        "status": "applied",
        "executorTransition": executor_transition,
        "secretsChanged": secrets_changed
    });
    let config_audit = record_config_modified_audit(
        &state,
        "llmProfiles",
        &changed_keys,
        &profiles_path,
        &old_hash,
        &new_hash,
        "settings_api.llm_profiles_patch",
        transition.clone(),
    );
    let mut output = next_profiles;
    if let Err((code, message)) = mask_unavailable_llm_profile_revisions(
        &state,
        &mut output,
        &std::collections::HashSet::new(),
    ) {
        return ApiResponse::error(code, message);
    }
    if let Some(object) = output.as_object_mut() {
        object.insert("configAudit".to_string(), config_audit);
        object.insert(
            "profileMigrations".to_string(),
            Value::Array(profile_migrations),
        );
        object.insert("transition".to_string(), transition);
    }
    ApiResponse::ok(output)
}

fn rollback_executor_runtime_v2(
    state: &AppState,
    previous: &mut Option<(
        deepcode_kernel_runtime::executors::KernelExecutorConfig,
        DaemonSecretProvider,
    )>,
) -> bool {
    let Some((tool_config, secret_provider)) = previous.take() else {
        return true;
    };
    state
        .kernel_v2
        .service()
        .replace_executor_runtime_host(tool_config, Arc::new(secret_provider))
        .is_ok()
}

fn profile_value_by_id<'a>(config: &'a Value, profile_id: &str) -> Option<&'a Value> {
    config
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        })
}

fn record_config_modified_audit(
    state: &AppState,
    config_kind: &str,
    changed_keys: &[String],
    store_path: &FsPath,
    old_hash: &str,
    new_hash: &str,
    source: &str,
    transition: Value,
) -> Value {
    match state.host_services.audit.record_config_change(
        config_kind,
        changed_keys,
        store_path,
        old_hash,
        new_hash,
        source,
        transition.clone(),
    ) {
        Ok(value) => value,
        Err(error) => json!({
            "schemaVersion": "deepcode.host.config-audit-error.v2",
            "configKind": config_kind,
            "changedKeys": changed_keys,
            "storePath": store_path.to_string_lossy(),
            "oldHash": old_hash,
            "newHash": new_hash,
            "source": source,
            "transition": transition,
            "message": "配置转换结果已返回，但 Host 审计记录写入失败。",
            "auditError": {
                "code": error.code,
                "message": error.message
            }
        }),
    }
}

fn config_value_hash(value: &Value) -> Result<String, crate::host_v2_storage::HostV2StorageError> {
    crate::host_v2_storage::stable_json_sha256(value)
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
    let output = probe_llm_profile_native_stream(&profile).await;
    match output {
        Ok(output) => ApiResponse::ok(json!({
            "ok": output.reasoning_present && output.response_present,
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

pub(crate) async fn llm_chat(
    State(_state): State<AppState>,
    _headers: axum::http::HeaderMap,
    _body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    ApiResponse::error(
        "provider_nonstream_route_removed",
        "Provider turns must use /api/llm/chat/stream",
    )
}

struct AuthorizedLlmChatProfile {
    profile: ResolvedLlmProfile,
    profile_revision: String,
}

fn authorize_llm_chat_transport(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    requested_profile_id: Option<&str>,
) -> Result<AuthorizedLlmChatProfile, Json<ApiResponse>> {
    let required_header = |name: &'static str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ApiResponse::error(
                    "provider_transport_authority_required",
                    format!("Session Provider transport requires {name}"),
                )
            })
    };
    let session_id = required_header("x-deepcode-session-id")?;
    let run_id = required_header("x-deepcode-run-id")?;
    let capability = required_header("x-deepcode-run-capability").and_then(|value| {
        deepcode_kernel_abi::RunCapabilityV2::new(value.to_string()).map_err(|_| {
            ApiResponse::error(
                "provider_transport_authority_invalid",
                "Session Provider transport Run capability is invalid",
            )
        })
    })?;
    state
        .host_services
        .active_runs_v2
        .authorize_session_run_transport(session_id, run_id, &capability)
        .map_err(|_| {
            ApiResponse::error(
                "provider_transport_authority_invalid",
                "Session Provider transport is not bound to the active Run",
            )
        })?;
    let active = state
        .host_services
        .active_runs_v2
        .resolve_session_active_run(session_id)
        .map_err(|_| {
            ApiResponse::error(
                "provider_transport_authority_invalid",
                "Session Provider transport active Run is unavailable",
            )
        })?
        .filter(|active| active.run_id == run_id)
        .ok_or_else(|| {
            ApiResponse::error(
                "provider_transport_authority_invalid",
                "Session Provider transport Run identity is stale",
            )
        })?;
    let bootstrap = state
        .host_services
        .kernel_operations_v2
        .get_bootstrap(session_id, &active.host_run_id)
        .map_err(|_| {
            ApiResponse::error(
                "provider_transport_authority_invalid",
                "Session Provider transport bootstrap is unavailable",
            )
        })?;
    if Some(bootstrap.provider_profile.provider_profile_id.as_str()) != requested_profile_id {
        return Err(ApiResponse::error(
            "provider_profile_identity_invalid",
            "Session Provider transport cannot change the Run-bound Provider profile",
        ));
    }
    let authorized_profile = {
        let gui = state.gui.lock().expect("gui state lock");
        let profile_id = bootstrap.provider_profile.provider_profile_id.as_str();
        let profile_value =
            profile_value_by_id(&gui.llm_profiles, profile_id).ok_or_else(|| {
                ApiResponse::error(
                    "provider_profile_revision_stale",
                    "Run-bound Provider profile is no longer available",
                )
            })?;
        let profile_revision =
            crate::host_v2_storage::stable_json_sha256(profile_value).map_err(|_| {
                ApiResponse::error(
                    "provider_profile_revision_stale",
                    "Run-bound Provider profile revision cannot be verified",
                )
            })?;
        if profile_revision != bootstrap.provider_profile.provider_profile_revision_digest {
            return Err(ApiResponse::error(
                "provider_profile_revision_stale",
                "Run-bound Provider profile changed after immutable bootstrap",
            ));
        }
        let profile = resolve_llm_profile(&gui, Some(profile_id)).map_err(|_| {
            ApiResponse::error(
                "provider_profile_revision_stale",
                "Run-bound Provider profile is no longer available",
            )
        })?;
        if profile.id != profile_id {
            return Err(ApiResponse::error(
                "provider_profile_identity_invalid",
                "Run-bound Provider profile resolution changed identity",
            ));
        }
        AuthorizedLlmChatProfile {
            profile,
            profile_revision,
        }
    };
    Ok(authorized_profile)
}

pub(crate) async fn llm_chat_stream(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    body: Result<Json<Value>, JsonRejection>,
) -> Response {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            let message = if rejection.status() == StatusCode::PAYLOAD_TOO_LARGE {
                "Provider stream request exceeded the local HTTP body limit."
            } else {
                "Provider stream request body is invalid JSON."
            };
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
    let request_id = match llm_request_id(&body) {
        Ok(request_id) => request_id,
        Err(message) => {
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "error": "provider_request_identity_invalid",
                "message": message,
            }));
        }
    };
    let profile_id = body
        .get("profileId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(session_id) = headers
        .get("x-deepcode-session-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
    else {
        return llm_stream_error_response(json!({
            "type": "provider_error",
            "requestId": request_id,
            "error": "provider_transport_authority_required",
            "message": "Session Provider transport requires x-deepcode-session-id",
        }));
    };
    let session_io_guard = session_private_io_lock(&session_id).read_owned().await;
    {
        let gui = state.gui.lock().expect("gui state lock");
        if let Err(response) = verified_selectable_session(&gui, &session_id) {
            let payload = response.0;
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "requestId": request_id,
                "error": payload.error.unwrap_or_else(|| "agent_session_unavailable".to_string()),
                "message": payload.message.unwrap_or_else(|| "Session is unavailable for Provider transport.".to_string()),
            }));
        }
    }
    let authorized_profile = match authorize_llm_chat_transport(
        &state,
        &headers,
        profile_id.as_deref(),
    ) {
        Ok(profile) => profile,
        Err(response) => {
            let payload = response.0;
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "requestId": request_id,
                "error": payload.error.unwrap_or_else(|| "provider_transport_authority_invalid".to_string()),
                "message": payload.message.unwrap_or_else(|| "Provider transport authority is invalid".to_string()),
            }));
        }
    };
    let profile = authorized_profile.profile;
    let profile_revision = authorized_profile.profile_revision;
    if let Err(message) = validate_provider_identity_expectation(&profile, &body) {
        return llm_stream_error_response(json!({
            "type": "provider_error",
            "requestId": request_id,
            "error": "provider_profile_identity_invalid",
            "message": message,
        }));
    }
    let (trace_identity, dispatch_authority) = match provider_trace_identity_from_request(
        &state,
        &headers,
        &body,
        &profile,
        &profile_revision,
        &request_id,
    ) {
        Ok(identity) => identity,
        Err((code, message)) => {
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "requestId": request_id,
                "error": code,
                "message": message,
            }));
        }
    };
    match state.provider_trace_v1.profile_revision_is_unavailable(
        &trace_identity.profile_id,
        &trace_identity.profile_revision,
    ) {
        Ok(false) => {}
        Ok(true) => {
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "requestId": request_id,
                "error": "llm_profile_revision_unavailable",
                "message": "Selected Provider Profile revision is unavailable until explicitly re-enabled or revised.",
            }));
        }
        Err(error) => {
            return llm_stream_error_response(json!({
                "type": "provider_error",
                "requestId": request_id,
                "error": error.code,
                "message": "Provider Profile availability could not be verified.",
            }));
        }
    }
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
    llm_stream_response(
        profile,
        request_envelope,
        request_id,
        ProviderStreamTraceContextV1 {
            store: state.provider_trace_v1.clone(),
            identity: trace_identity,
            dispatch_authority,
        },
        session_io_guard,
    )
}

fn provider_trace_identity_from_request(
    state: &AppState,
    headers: &axum::http::HeaderMap,
    body: &Value,
    profile: &ResolvedLlmProfile,
    profile_revision: &str,
    request_id: &str,
) -> Result<(ProviderTraceIdentityV1, ProviderStreamDispatchAuthorityV1), (String, String)> {
    let header = |name: &'static str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                (
                    "provider_trace_identity_missing".to_string(),
                    format!("Provider trace identity requires {name}"),
                )
            })
    };
    let session_id = header("x-deepcode-session-id")?.to_string();
    let run_id = header("x-deepcode-run-id")?.to_string();
    let capability =
        deepcode_kernel_abi::RunCapabilityV2::new(header("x-deepcode-run-capability")?.to_string())
            .map_err(|_| {
                (
                    "provider_trace_identity_invalid".to_string(),
                    "Provider trace Run capability is invalid".to_string(),
                )
            })?;
    let admission = state
        .host_services
        .session_kernel_v2
        .provider_turn_admission(&session_id, &run_id, &capability, request_id)
        .map_err(|error| (error.code.to_string(), error.message))?;
    let trace = body
        .get("providerOptions")
        .and_then(|value| value.get("deepcode"))
        .and_then(|value| value.get("sessionKernelV2"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            (
                "provider_trace_identity_missing".to_string(),
                "Provider request is missing Session trace identity".to_string(),
            )
        })?;
    let submitted_user_turn_id = trace
        .get("userTurnId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            (
                "provider_trace_user_turn_invalid".to_string(),
                "Provider trace userTurnId must be non-empty".to_string(),
            )
        })?;
    let submitted_control_epoch = trace
        .get("controlEpoch")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            (
                "provider_trace_control_epoch_invalid".to_string(),
                "Provider trace controlEpoch must be a positive integer".to_string(),
            )
        })?;
    let submitted_purpose = trace
        .get("purpose")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            (
                "provider_trace_purpose_invalid".to_string(),
                "Provider trace purpose must be non-empty".to_string(),
            )
        })?;
    let current_input = provider_current_input_context(body)?;
    let current_input_digest = crate::host_v2_storage::canonical_sha256(&current_input)
        .map_err(|error| (error.code.to_string(), error.message))?;
    let current_input_record = current_input
        .get("currentInput")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            (
                "provider_trace_context_invalid".to_string(),
                "Provider current-input context is invalid".to_string(),
            )
        })?;
    let context_purpose = current_input
        .get("purpose")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                "provider_trace_purpose_invalid".to_string(),
                "Provider current-input context has no turn purpose".to_string(),
            )
        })?;
    let target_kind = current_input
        .get("target")
        .and_then(|value| value.get("kind"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            (
                "provider_trace_context_invalid".to_string(),
                "Provider current-input context has no target kind".to_string(),
            )
        })?;
    if current_input_digest != admission.current_input_digest
        || current_input.get("providerTurnId").and_then(Value::as_str)
            != Some(admission.provider_turn_id.as_str())
        || current_input.get("runId").and_then(Value::as_str) != Some(run_id.as_str())
        || current_input.get("controlEpoch").and_then(Value::as_u64)
            != Some(admission.control_epoch)
        || current_input_record.get("inputId").and_then(Value::as_str)
            != Some(admission.current_input_id.as_str())
        || submitted_user_turn_id != admission.current_input_id
        || submitted_control_epoch != admission.control_epoch
        || submitted_purpose != context_purpose
        || admission.provider_profile_id != profile.id
        || admission.provider_profile_revision != profile_revision
    {
        return Err((
            "provider_trace_identity_mismatch".to_string(),
            "Provider trace identity does not match the durable Session turn admission".to_string(),
        ));
    }
    let purpose = match context_purpose {
        "primary" => ProviderTracePurposeV1::Primary,
        "continuation" => ProviderTracePurposeV1::Continuation,
        "finalAnswer" => ProviderTracePurposeV1::FinalAnswer,
        _ => {
            return Err((
                "provider_trace_purpose_invalid".to_string(),
                "Provider trace purpose is unsupported".to_string(),
            ))
        }
    };
    if matches!(purpose, ProviderTracePurposeV1::FinalAnswer) != (target_kind == "finalAnswer") {
        return Err((
            "provider_trace_purpose_invalid".to_string(),
            "Provider finalAnswer purpose does not match the durable turn target".to_string(),
        ));
    }
    if matches!(purpose, ProviderTracePurposeV1::FinalAnswer)
        && body
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| !tools.is_empty())
    {
        return Err((
            "provider_final_answer_tools_forbidden".to_string(),
            "A finalAnswer Provider request cannot expose tools".to_string(),
        ));
    }
    let identity = ProviderTraceIdentityV1 {
        session_id,
        run_id,
        user_turn_id: admission.current_input_id.clone(),
        provider_turn_id: request_id.to_string(),
        provider_kind: profile.kind.clone(),
        model: profile.model.clone(),
        profile_id: profile.id.clone(),
        profile_revision: profile_revision.to_string(),
        control_epoch: admission.control_epoch,
        purpose,
    };
    Ok((
        identity,
        ProviderStreamDispatchAuthorityV1 {
            session_store: state.host_services.session_kernel_v2.clone(),
            run_capability: capability,
            admission,
        },
    ))
}

fn provider_current_input_context(body: &Value) -> Result<Value, (String, String)> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            (
                "provider_trace_context_invalid".to_string(),
                "Provider request has no message array".to_string(),
            )
        })?;
    let mut matches = messages.iter().filter_map(|message| {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        let content = message.get("content").and_then(Value::as_str)?;
        let value = serde_json::from_str::<Value>(content).ok()?;
        (value.get("schemaVersion").and_then(Value::as_str)
            == Some("deepcode.session.provider-current-input.v2"))
        .then_some(value)
    });
    let current_input = matches.next().ok_or_else(|| {
        (
            "provider_trace_context_invalid".to_string(),
            "Provider request has no exact current-input context".to_string(),
        )
    })?;
    if matches.next().is_some() {
        return Err((
            "provider_trace_context_invalid".to_string(),
            "Provider request has multiple current-input contexts".to_string(),
        ));
    }
    Ok(current_input)
}

fn llm_request_id(body: &Value) -> Result<String, String> {
    body.get("requestId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "requestId must be a non-empty string".to_string())
}

fn llm_stream_error_response(data: Value) -> Response {
    let request_id = data
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let code = data
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("provider_stream_failed");
    let body = provider_public_error_event(request_id, code, "");
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
    });
    merge_object(
        &mut settings,
        &json!({
        "agent.permissions.workspaceRead": "allow",
        "agent.permissions.autoApprovePlans": false,
        "agent.permissions.workspaceWrite": "ask",
        "agent.permissions.gitWrite": "ask",
        "agent.permissions.webRead": "deny",
        "agent.permissions.privateWebRead": "deny",
        "agent.web.search.endpointTemplate": "",
        "agent.web.search.authHeaderName": "Authorization",
        "agent.web.search.authSecretRef": "",
        "skills.pythonPath": "python",
        "skills.autoLoad": true,
        "skills.mounts": "[]",
        "mcp.autoLoad": false,
        "mcp.servers": "[]",
        "ruler.enabled": true,
        "ruler.rules": "[{\"id\":\"default-safety\",\"name\":\"Default Safety Boundary\",\"source\":\"system\",\"priority\":100,\"path\":\"<builtin>/default-safety.md\",\"content\":\"Default to plan mode. Read before write. Show diff before saving files. Never run destructive commands without explicit approval.\",\"enabled\":true}]"
        }),
    );
    merge_object(
        &mut settings,
        &json!({
            "gui.colorTheme": "light",
            "gui.accentColor": "blue",
            "gui.timelineDensity": "normal",
            "gui.typewriterAnimation": true,
            "gui.collapseCompletedThinking": true
        }),
    );
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
                "reasoningTransport": "openaiPlaintext",
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
                "reasoningTransport": "openaiPlaintext",
                "enabled": true
            }
        ],
        "defaultProfileId": "deepseek-v4-pro-openai",
        "storePath": null
    })
}
