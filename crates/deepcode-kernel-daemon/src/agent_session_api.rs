use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_sessions_list(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Err(error) = refresh_pending_session_titles(&mut gui) {
        return ApiResponse::error(error.code, error.message);
    }
    let include_archived = query.include_archived.unwrap_or(false);
    let scope_key = scope_key_from_query(&query);
    let sessions = if query.include_all_scopes.unwrap_or(false) {
        gui.sessions
            .iter()
            .filter(|session| include_archived || !is_archived_session(session))
            .cloned()
            .collect()
    } else if let Some(project_id) = query.project_id.as_deref() {
        project_sessions(&gui, project_id, include_archived)
    } else {
        scoped_sessions(&gui, &scope_key, include_archived)
    };
    let current_session_id = query
        .project_id
        .as_deref()
        .and_then(|project_id| current_agent_session_id_for_project(&gui, project_id))
        .or_else(|| current_agent_session_id_for_scope(&mut gui, &scope_key));
    ApiResponse::ok(json!({
        "sessions": sessions,
        "currentSessionId": current_session_id,
        "workspaceScopeKey": scope_key
    }))
}

pub(crate) async fn agent_session_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = match allocate_agent_session_id(&gui) {
        Ok(id) => id,
        Err(error) => return ApiResponse::error("agent_session_identity_unavailable", error),
    };
    let now = now_text();
    let project_id = body
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let project = match project_id {
        Some(project_id) => match project_by_id(&gui, project_id) {
            Some(project) => Some(project.clone()),
            None => {
                return ApiResponse::error("agent_project_not_found", "agent project not found")
            }
        },
        None => None,
    };
    let project_binding = project.as_ref().and_then(project_workspace_binding);
    let workspace_id = if project.is_some() {
        project_binding
            .as_ref()
            .and_then(|binding| binding.get("workspaceId"))
            .and_then(Value::as_str)
    } else {
        body.get("workspaceId").and_then(Value::as_str)
    };
    let workspace_hash = if project.is_some() {
        project_binding
            .as_ref()
            .and_then(|binding| binding.get("workspaceHash"))
            .and_then(Value::as_str)
    } else {
        body.get("workspaceHash").and_then(Value::as_str)
    };
    let default_profile_id = match preferred_effective_llm_profile_id(&state, &gui.llm_profiles) {
        Ok(profile_id) => profile_id,
        Err(error) => {
            return ApiResponse::error(
                error.code,
                "Provider Profile availability could not be verified for Session creation",
            )
        }
    };
    let mut session = create_agent_session_value(
        &id,
        &now,
        body.get("title")
            .and_then(Value::as_str)
            .unwrap_or("New Agent Session"),
        default_profile_id.as_deref(),
        workspace_id,
        workspace_hash,
    );
    if let Some(project_id) = project_id {
        session["projectId"] = json!(project_id);
        session["workspaceBinding"] = project_binding.clone().unwrap_or(Value::Null);
    }
    let scope_key = session_scope_key(&session);
    let previous_current_session_id = gui.current_session_id.clone();
    let previous_scope_session_id = gui.current_session_ids_by_scope.get(&scope_key).cloned();
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(scope_key.clone(), id.clone());
    gui.sessions.insert(0, session.clone());
    if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
        gui.sessions
            .retain(|candidate| candidate.get("id").and_then(Value::as_str) != Some(id.as_str()));
        gui.current_session_id = previous_current_session_id;
        if let Some(previous_scope_session_id) = previous_scope_session_id {
            gui.current_session_ids_by_scope
                .insert(scope_key, previous_scope_session_id);
        } else {
            gui.current_session_ids_by_scope.remove(&scope_key);
        }
        return ApiResponse::error("agent_session_persist_failed", error);
    }
    session_result(&gui, &id)
}

pub(crate) async fn agent_session_current(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    if let Err(error) = refresh_pending_session_titles(&mut gui) {
        return ApiResponse::error(error.code, error.message);
    }
    let scope_key = scope_key_from_query(&query);
    let session_id = query
        .project_id
        .as_deref()
        .and_then(|project_id| current_agent_session_id_for_project(&gui, project_id))
        .or_else(|| current_agent_session_id_for_scope(&mut gui, &scope_key));
    let Some(session_id) = session_id else {
        return ApiResponse::ok(Value::Null);
    };
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_activate(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    if has_session(&gui, &session_id) {
        let readable = session_result(&gui, &session_id);
        if !readable.0.ok {
            return readable;
        }
        if let Some(scope_key) = session_by_id(&gui, &session_id).map(session_scope_key) {
            gui.current_session_ids_by_scope
                .insert(scope_key, session_id.clone());
        }
        gui.current_session_id = Some(session_id.clone());
        if let Err(error) = refresh_pending_session_titles(&mut gui) {
            return ApiResponse::error(error.code, error.message);
        }
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) async fn agent_session_rename(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    if !has_session(&gui, &session_id) {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    }
    let requested_profile_id = body
        .as_object()
        .filter(|object| object.contains_key("profileId"))
        .map(|_| body.get("profileId").cloned().unwrap_or(Value::Null));
    let resolved_profile_id = if let Some(requested_profile_id) = requested_profile_id {
        let in_memory_run_locked = state
            .session_runs
            .lock()
            .expect("session run state lock")
            .values()
            .any(|run| {
                run.session_id == session_id
                    && !matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
            });
        let durable_run_locked = match state
            .host_services
            .active_runs_v2
            .resolve_session_active_run(&session_id)
        {
            Ok(active) => active.is_some(),
            Err(error) => return ApiResponse::error(error.code, error.message),
        };
        if in_memory_run_locked || durable_run_locked {
            return ApiResponse::error(
                "agent_session_profile_locked",
                "session Profile is locked while a Run is active",
            );
        }
        let profile_id = if requested_profile_id.is_null() {
            match preferred_effective_llm_profile_id(&state, &gui.llm_profiles) {
                Ok(profile_id) => profile_id,
                Err(error) => {
                    return ApiResponse::error(
                        error.code,
                        "Provider Profile availability could not be verified for Session selection",
                    )
                }
            }
        } else if let Some(profile_id) = requested_profile_id
            .as_str()
            .map(str::trim)
            .filter(|profile_id| !profile_id.is_empty())
        {
            let profile_available =
                match effective_llm_profile_is_enabled(&state, &gui.llm_profiles, profile_id) {
                    Ok(available) => available,
                    Err(error) => return ApiResponse::error(
                        error.code,
                        "Provider Profile availability could not be verified for Session selection",
                    ),
                };
            if !profile_available {
                return ApiResponse::error(
                    "llm_profile_unavailable",
                    "selected LLM Profile does not exist, is disabled, or its revision is unavailable",
                );
            }
            Some(profile_id.to_string())
        } else {
            return ApiResponse::error(
                "invalid_agent_session_profile",
                "profileId must be a non-empty string or null",
            );
        };
        let Some(profile_id) = profile_id else {
            return ApiResponse::error(
                "llm_profile_unavailable",
                "no enabled LLM Profile is available for this session",
            );
        };
        Some(profile_id)
    } else {
        None
    };
    let requested_project_id = body.get("projectId").cloned();
    let requested_project = requested_project_id
        .as_ref()
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|project_id| {
            project_by_id(&gui, project_id)
                .cloned()
                .ok_or(("agent_project_not_found", "agent project not found"))
        })
        .transpose();
    let requested_project = match requested_project {
        Ok(project) => project,
        Err((code, message)) => return ApiResponse::error(code, message),
    };
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if let Some(title) = body.get("title").and_then(Value::as_str) {
            session["title"] = json!(title);
            session["titleSource"] = json!("user");
        }
        if requested_project_id.is_some() {
            if requested_project_id.as_ref().is_some_and(Value::is_null) {
                session["projectId"] = Value::Null;
                session["workspaceId"] = Value::Null;
                session["workspaceHash"] = Value::Null;
                session["workspaceScopeKey"] = json!("unbound-workspace");
            } else if let Some(project) = requested_project.as_ref() {
                session["projectId"] = project.get("id").cloned().unwrap_or(Value::Null);
                apply_project_binding_to_session(session, project);
            }
        }
        if let Some(profile_id) = resolved_profile_id {
            session["profileId"] = json!(profile_id);
        }
        session["updatedAt"] = json!(now_text());
        if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
            return ApiResponse::error("agent_session_persist_failed", error);
        }
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

fn session_deletion_failure_response(
    state: &AppState,
    session_id: &str,
    failure_code: &str,
    failure_message: &str,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let Some(position) = gui
        .sessions
        .iter()
        .position(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    mark_session_deletion_failed(
        &mut gui.sessions[position],
        &now_text(),
        failure_code,
        failure_message,
    );
    let failed_session = gui.sessions[position].clone();
    match crate::session_metadata_v2::persist_session_index(&gui) {
        Ok(()) => ApiResponse::error_with_data(
            failure_code,
            failure_message,
            json!({
                "session": failed_session,
                "deletionRetryable": true
            }),
        ),
        Err(persist_error) => ApiResponse::error_with_data(
            "agent_session_deletion_failure_persist_failed",
            format!(
                "{failure_message}; additionally failed to persist the retryable Session deletion state: {persist_error}"
            ),
            json!({
                "session": failed_session,
                "deletionRetryable": true,
                "deletionFailure": {
                    "code": failure_code,
                    "message": failure_message
                },
                "persistenceFailure": persist_error
            }),
        ),
    }
}

pub(crate) async fn agent_session_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    if session_id.is_empty() || safe_path_segment(&session_id) != session_id {
        return ApiResponse::error(
            "agent_session_identity_invalid",
            "Session deletion requires a non-empty canonical path-safe Session id",
        );
    }
    let run_admission_lock = session_run_admission_lock(&session_id);
    let _run_admission_guard = run_admission_lock.lock_owned().await;
    let safe_session_id = safe_path_segment(&session_id);
    let (sessions_dir, response_scope_key) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let Some(position) = gui.sessions.iter().position(|session| {
            session.get("id").and_then(Value::as_str) == Some(session_id.as_str())
        }) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };
        let previous_session = gui.sessions[position].clone();
        let scope_key = session_scope_key(&previous_session);
        mark_session_deletion_pending(&mut gui.sessions[position], &now_text());
        if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
            gui.sessions[position] = previous_session;
            return ApiResponse::error(
                "agent_session_deletion_pending_persist_failed",
                format!(
                    "Session deletion did not start because its pending state could not be persisted: {error}"
                ),
            );
        }
        gui.current_session_ids_by_scope
            .retain(|_, current_id| current_id != &session_id);
        if gui.current_session_id.as_deref() == Some(session_id.as_str()) {
            gui.current_session_id = gui
                .sessions
                .iter()
                .find(|session| session_is_selectable(session))
                .and_then(|session| session.get("id").and_then(Value::as_str))
                .map(ToOwned::to_owned);
        }
        (gui.paths.sessions_dir.clone(), scope_key)
    };

    if let Err(error) = retire_agent_kernel_run_v2(
        &state,
        &session_id,
        None,
        "cancelled",
        "Session deletion retired the active Kernel–Session v2 Run.",
    )
    .await
    {
        return session_deletion_failure_response(&state, &session_id, &error.code, &error.message);
    }
    let session_io_lock = session_private_io_lock(&session_id);
    let _session_io_guard = session_io_lock.write_owned().await;
    if let Err(error) = state
        .kernel_session_v2
        .verify_session_retired_for_deletion(&session_id)
        .await
    {
        return session_deletion_failure_response(&state, &session_id, error.code, &error.message);
    }
    if let Err(error) = remove_session_storage_dir(&sessions_dir, &safe_session_id) {
        return session_deletion_failure_response(
            &state,
            &session_id,
            "agent_session_storage_delete_failed",
            &format!("Session private storage could not be removed: {error}"),
        );
    }

    let (response_current_id, response_sessions) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let Some(position) = gui.sessions.iter().position(|session| {
            session.get("id").and_then(Value::as_str) == Some(session_id.as_str())
        }) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };
        let mut remaining_sessions = gui.sessions.clone();
        remaining_sessions.remove(position);
        if let Err(error) = crate::session_metadata_v2::persist_session_index_values(
            &gui.paths.sessions_index_path,
            &remaining_sessions,
        ) {
            mark_session_deletion_failed(
                &mut gui.sessions[position],
                &now_text(),
                "agent_session_index_finalize_failed",
                &error,
            );
            let failed_session = gui.sessions[position].clone();
            return match crate::session_metadata_v2::persist_session_index(&gui) {
                Ok(()) => ApiResponse::error_with_data(
                    "agent_session_index_finalize_failed",
                    format!(
                        "Session private storage was removed, but the Session index could not be finalized: {error}"
                    ),
                    json!({
                        "session": failed_session,
                        "deletionRetryable": true,
                        "storageRemoved": true
                    }),
                ),
                Err(failed_state_error) => ApiResponse::error_with_data(
                    "agent_session_index_finalize_failed",
                    format!(
                        "Session private storage was removed, but neither index finalization nor the retryable failure state could be persisted: {error}; failure state: {failed_state_error}"
                    ),
                    json!({
                        "session": failed_session,
                        "deletionRetryable": true,
                        "storageRemoved": true,
                        "persistenceFailure": failed_state_error
                    }),
                ),
            };
        }
        gui.sessions = remaining_sessions;
        gui.current_session_ids_by_scope
            .retain(|_, current_id| current_id != &session_id);
        if gui.current_session_id.as_deref() == Some(session_id.as_str()) {
            gui.current_session_id = gui
                .sessions
                .iter()
                .find(|session| session_is_selectable(session))
                .and_then(|session| session.get("id").and_then(Value::as_str))
                .map(ToOwned::to_owned);
        }
        (
            current_agent_session_id_for_scope(&mut gui, &response_scope_key),
            scoped_sessions(&gui, &response_scope_key, false),
        )
    };

    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
}

pub(crate) async fn agent_session_archive(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let run_admission_lock = session_run_admission_lock(&session_id);
    let _run_admission_guard = run_admission_lock.lock_owned().await;
    let should_archive = body
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    {
        let gui = state.gui.lock().expect("gui state lock");
        let Some(session) = gui
            .sessions
            .iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
        else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };
        if !session_schema_is_current(session) {
            return unsupported_session_schema_response();
        }
        if session_is_deletion_tombstone(session) {
            return ApiResponse::error(
                "agent_session_deletion_in_progress",
                "Session deletion is pending or failed and must be retried before archival",
            );
        }
    }
    if should_archive {
        if let Err(error) = retire_agent_kernel_run_v2(
            &state,
            &session_id,
            None,
            "cancelled",
            "Session archival retired the active Kernel–Session v2 Run.",
        )
        .await
        {
            return ApiResponse::error(error.code, error.message);
        }
    }
    let session_io_lock = session_private_io_lock(&session_id);
    let _session_io_guard = session_io_lock.write_owned().await;
    if should_archive {
        if let Err(error) = state
            .kernel_session_v2
            .verify_session_retired_for_deletion(&session_id)
            .await
        {
            return ApiResponse::error(error.code, error.message);
        }
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    let archived_scope_key = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
        .map(session_scope_key);
    let was_global_current = gui.current_session_id.as_deref() == Some(session_id.as_str());
    let was_scoped_current = archived_scope_key
        .as_ref()
        .and_then(|scope| gui.current_session_ids_by_scope.get(scope))
        .map(|current| current == &session_id)
        .unwrap_or(false);
    let replacement_profile_id = if should_archive && (was_global_current || was_scoped_current) {
        let previous_profile_id = gui
            .sessions
            .iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id.as_str()))
            .and_then(|session| session.get("profileId"))
            .and_then(Value::as_str);
        let previous_available = match previous_profile_id {
            Some(profile_id) => {
                match effective_llm_profile_is_enabled(&state, &gui.llm_profiles, profile_id) {
                    Ok(available) => available,
                    Err(error) => {
                        return ApiResponse::error(
                            error.code,
                            "Provider Profile availability could not be verified for replacement Session creation",
                        )
                    }
                }
            }
            None => false,
        };
        if previous_available {
            previous_profile_id.map(ToOwned::to_owned)
        } else {
            match preferred_effective_llm_profile_id(&state, &gui.llm_profiles) {
                Ok(profile_id) => profile_id,
                Err(error) => {
                    return ApiResponse::error(
                        error.code,
                        "Provider Profile availability could not be verified for replacement Session creation",
                    )
                }
            }
        }
    } else {
        None
    };
    let mut replacement_scope: Option<(Option<String>, Option<String>, Option<String>)> = None;
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if should_archive {
            if was_global_current || was_scoped_current {
                replacement_scope = Some((
                    replacement_profile_id.clone(),
                    session
                        .get("workspaceId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    session
                        .get("workspaceHash")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                ));
            }
            session["archivedAt"] = json!(now_text());
        } else {
            session
                .as_object_mut()
                .map(|object| object.remove("archivedAt"));
        }
    }
    if should_archive {
        if let Some(scope_key) = archived_scope_key.as_ref() {
            gui.current_session_ids_by_scope.remove(scope_key);
        }
        if was_global_current || was_scoped_current {
            if let Err(error) = ensure_current_agent_session_for_scope(
                &mut gui,
                archived_scope_key.as_deref().unwrap_or("unbound-workspace"),
                replacement_scope,
            ) {
                return ApiResponse::error("agent_session_replacement_failed", error);
            }
        }
    }
    let response_scope_key = archived_scope_key.unwrap_or_else(|| scope_key_from_parts(None, None));
    let response_current_id = current_agent_session_id_for_scope(&mut gui, &response_scope_key);
    let response_sessions = scoped_sessions(&gui, &response_scope_key, false);
    if let Err(error) = crate::session_metadata_v2::persist_session_index(&gui) {
        return ApiResponse::error("agent_session_persist_failed", error);
    }
    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
}

pub(crate) async fn agent_session_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    if let Some(response) =
        crate::session_metadata_v2::session_metadata_unavailable_response(&state)
    {
        return response;
    }
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}
