use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_sessions_list(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
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
    let mut gui = state.gui.lock().expect("gui state lock");
    let id = format!("session-{}", now_millis());
    let now = now_text();
    let mode = body
        .get("mode")
        .or_else(|| body.get("initialMode"))
        .and_then(Value::as_str)
        .unwrap_or("plan");
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
    let default_profile_id = preferred_enabled_llm_profile_id(&gui.llm_profiles);
    let mut session = create_agent_session_value(
        &id,
        &now,
        body.get("title")
            .and_then(Value::as_str)
            .unwrap_or("New Agent Session"),
        mode,
        default_profile_id.as_deref(),
        workspace_id,
        workspace_hash,
    );
    if let Some(project_id) = project_id {
        session["projectId"] = json!(project_id);
        session["workspaceBinding"] = project_binding.clone().unwrap_or(Value::Null);
    }
    let scope_key = session_scope_key(&session);
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(scope_key, id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.session_timeline_cache.remove(&id);
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session.clone());
    if let Err(error) = persist_session_index(&gui) {
        return ApiResponse::error("agent_session_persist_failed", error);
    }
    ApiResponse::ok(json!({ "session": session, "events": [] }))
}

pub(crate) async fn agent_session_current(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionScopeQuery>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
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
    let mut gui = state.gui.lock().expect("gui state lock");
    if has_session(&gui, &session_id) {
        if let Some(scope_key) = session_by_id(&gui, &session_id).map(session_scope_key) {
            gui.current_session_ids_by_scope
                .insert(scope_key, session_id.clone());
        }
        gui.current_session_id = Some(session_id.clone());
        refresh_pending_session_titles(&mut gui);
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) async fn agent_session_rename(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    if !has_session(&gui, &session_id) {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    }
    let requested_profile_id = body
        .as_object()
        .filter(|object| object.contains_key("profileId"))
        .map(|_| body.get("profileId").cloned().unwrap_or(Value::Null));
    let resolved_profile_id = if let Some(requested_profile_id) = requested_profile_id {
        let run_locked = state
            .session_runs
            .lock()
            .expect("session run state lock")
            .values()
            .any(|run| {
                run.session_id == session_id
                    && matches!(run.status.as_str(), "running" | "cancelling")
            });
        if run_locked || session_has_pending_interaction(&gui, &session_id) {
            return ApiResponse::error(
                "agent_session_profile_locked",
                "session Profile is locked while a run or user interaction is active",
            );
        }
        let profile_id = if requested_profile_id.is_null() {
            preferred_enabled_llm_profile_id(&gui.llm_profiles)
        } else if let Some(profile_id) = requested_profile_id
            .as_str()
            .map(str::trim)
            .filter(|profile_id| !profile_id.is_empty())
        {
            if !llm_profile_is_enabled(&gui.llm_profiles, profile_id) {
                return ApiResponse::error(
                    "llm_profile_unavailable",
                    "selected LLM Profile does not exist or is disabled",
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
        if let Err(error) = persist_session_index(&gui) {
            return ApiResponse::error("agent_session_persist_failed", error);
        }
        return session_result(&gui, &session_id);
    }
    ApiResponse::error("agent_session_not_found", "agent session not found")
}

pub(crate) fn session_has_pending_interaction(gui: &GuiState, session_id: &str) -> bool {
    let cached = gui.session_timeline_cache.get(session_id).cloned();
    let timeline = cached.or_else(|| {
        read_json_file(
            &gui.paths
                .sessions_dir
                .join(safe_path_segment(session_id))
                .join("timeline.json"),
        )
    });
    timeline
        .as_ref()
        .and_then(|timeline| timeline.get("interactionProjection"))
        .and_then(|projection| projection.get("pending"))
        .is_some_and(Value::is_object)
}

pub(crate) async fn agent_session_delete(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let safe_session_id = safe_path_segment(&session_id);
    let (
        sessions_dir,
        archive_root,
        memory_root,
        delete_scope_key,
        response_scope_key,
        response_current_id,
        response_sessions,
    ) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        let Some(position) = gui.sessions.iter().position(|session| {
            session.get("id").and_then(Value::as_str) == Some(session_id.as_str())
        }) else {
            return ApiResponse::error("agent_session_not_found", "agent session not found");
        };

        let scope_key = session_scope_key(&gui.sessions[position]);
        gui.sessions.remove(position);
        gui.session_projection_cache.remove(&session_id);
        gui.session_timeline_cache.remove(&session_id);
        gui.trace_events.remove(&session_id);
        gui.current_session_ids_by_scope
            .retain(|_, current_id| current_id != &session_id);
        if gui.current_session_id.as_deref() == Some(session_id.as_str()) {
            gui.current_session_id = gui
                .sessions
                .iter()
                .find(|session| !is_archived_session(session))
                .and_then(|session| session.get("id").and_then(Value::as_str))
                .map(ToOwned::to_owned);
        }
        let response_current_id = current_agent_session_id_for_scope(&mut gui, &scope_key);
        let response_sessions = scoped_sessions(&gui, &scope_key, false);
        if let Err(error) = persist_session_index(&gui) {
            return ApiResponse::error("agent_session_persist_failed", error);
        }
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            gui.paths.memory_archives_dir.clone(),
            scope_key.clone(),
            scope_key,
            response_current_id,
            response_sessions,
        )
    };

    remove_session_storage_dir(&sessions_dir, &safe_session_id);
    remove_conversation_archive_dirs(&archive_root, &safe_session_id);
    let memory_cleanup = remove_session_memory_archive(
        &memory_root,
        &delete_scope_key,
        &safe_session_id,
        &session_id,
    );

    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key,
        "memoryCleanup": memory_cleanup
    }))
}

pub(crate) async fn agent_session_archive(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let mut gui = state.gui.lock().expect("gui state lock");
    let should_archive = body
        .get("archived")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let archived_scope_key = session_by_id(&gui, &session_id).map(session_scope_key);
    let was_global_current = gui.current_session_id.as_deref() == Some(session_id.as_str());
    let was_scoped_current = archived_scope_key
        .as_ref()
        .and_then(|scope| gui.current_session_ids_by_scope.get(scope))
        .map(|current| current == &session_id)
        .unwrap_or(false);
    let mut replacement_scope: Option<(Option<String>, Option<String>, Option<String>)> = None;
    if let Some(session) = session_mut(&mut gui, &session_id) {
        if should_archive {
            if was_global_current || was_scoped_current {
                replacement_scope = Some((
                    session
                        .get("profileId")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
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
            ensure_current_agent_session_for_scope(
                &mut gui,
                archived_scope_key.as_deref().unwrap_or("unbound-workspace"),
                replacement_scope,
            );
        }
    }
    let response_scope_key = archived_scope_key.unwrap_or_else(|| scope_key_from_parts(None, None));
    let response_current_id = current_agent_session_id_for_scope(&mut gui, &response_scope_key);
    let response_sessions = scoped_sessions(&gui, &response_scope_key, false);
    if let Err(error) = persist_session_index(&gui) {
        return ApiResponse::error("agent_session_persist_failed", error);
    }
    ApiResponse::ok(json!({
        "sessions": response_sessions,
        "currentSessionId": response_current_id,
        "workspaceScopeKey": response_scope_key
    }))
}

pub(crate) async fn agent_session_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    session_result(&gui, &session_id)
}

pub(crate) async fn agent_session_append_events(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let incoming = body
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    append_session_projection(&state, &session_id, incoming);
    if let Some(timeline) = body.get("timeline").cloned() {
        if let Err(error) = store_session_timeline(&state, &session_id, timeline) {
            return ApiResponse::error("write_session_timeline_failed", error.to_string());
        }
    }
    let mut gui = state.gui.lock().expect("gui state lock");
    refresh_pending_session_titles(&mut gui);
    session_result(&gui, &session_id)
}
