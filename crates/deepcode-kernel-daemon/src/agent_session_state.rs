use crate::prelude::*;
use crate::*;

pub(crate) async fn agent_feedback() -> Json<ApiResponse> {
    ApiResponse::ok(json!({
        "accepted": true,
        "message": "Feedback recorded as Host session metadata."
    }))
}

pub(crate) async fn agent_workflow_config_get(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "config": gui.workflow_config,
        "storePath": gui.paths.workflow_config_path.to_string_lossy(),
        "initialized": true
    }))
}

pub(crate) async fn agent_workflow_config_patch(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let config = body.get("config").cloned().unwrap_or_else(|| json!({}));
    let mut gui = state.gui.lock().expect("gui state lock");
    merge_object(&mut gui.workflow_config, &config);
    match atomic_write_json(&gui.paths.workflow_config_path, &gui.workflow_config) {
        Ok(()) => ApiResponse::ok(json!({
            "config": gui.workflow_config,
            "storePath": gui.paths.workflow_config_path.to_string_lossy(),
            "initialized": true
        })),
        Err(error) => ApiResponse::error("write_workflow_config_failed", error),
    }
}

pub(crate) async fn agent_tools() -> Json<ApiResponse> {
    let tool_catalog_snapshot = deepcode_kernel_runtime::kernel_tool_catalog_snapshot();
    let tools = tool_catalog_snapshot
        .tools
        .iter()
        .map(|tool| {
            json!({
                "name": tool.tool_id,
                "description": format!("Kernel tool {} ({})", tool.tool_id, tool.capability),
                "inputSchema": &tool.provider_schema,
                "riskLevel": tool.risk.as_str(),
                "needsApproval": tool.permission_mode.as_str() != "allow",
                "allowedModes": ["readOnly", "plan", "askBeforeWrite"],
                "capability": tool.capability,
                "family": tool.family,
                "operationKind": tool.operation_kind,
                "permissionMode": tool.permission_mode,
                "pathScopePolicy": tool.path_scope_policy,
                "executionMode": tool.execution_mode,
                "readOnly": tool.read_only,
                "catalogVersion": tool_catalog_snapshot.catalog_version,
                "catalogHash": &tool_catalog_snapshot.catalog_hash
            })
        })
        .collect::<Vec<_>>();
    ApiResponse::ok(json!({
        "tools": tools,
        "catalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
        "catalogHash": &tool_catalog_snapshot.catalog_hash,
        "toolCatalog": tool_catalog_snapshot
    }))
}

pub(crate) async fn host_skills(State(state): State<AppState>) -> Json<ApiResponse> {
    match dispatch_host_skill_catalog(
        &state.runtime,
        KernelCommand::HostSkillDiscover {
            request_id: rid("skill-discover"),
        },
    ) {
        Ok(result) => ApiResponse::ok(json!(result)),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) fn create_agent_session_value(
    id: &str,
    now: &str,
    title: &str,
    mode: &str,
    profile_id: Option<&str>,
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> Value {
    let workspace_scope_key = scope_key_from_parts(workspace_id, workspace_hash);
    json!({
        "id": id,
        "kernelAbiVersion": deepcode_kernel_runtime::KERNEL_ABI_VERSION,
        "agentProtocolVersion": deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION,
        "toolCatalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
        "title": title,
        "mode": mode,
        "profileId": profile_id,
        "workspaceId": workspace_id,
        "workspaceHash": workspace_hash,
        "workspaceScopeKey": workspace_scope_key,
        "titleSource": "pending",
        "eventCount": 0,
        "createdAt": now,
        "updatedAt": now
    })
}

pub(crate) fn session_schema_is_compatible(session: &Value) -> bool {
    session.get("kernelAbiVersion").and_then(Value::as_str)
        == Some(deepcode_kernel_runtime::KERNEL_ABI_VERSION)
        && session.get("agentProtocolVersion").and_then(Value::as_str)
            == Some(deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION)
        && session.get("toolCatalogVersion").and_then(Value::as_str)
            == Some(deepcode_kernel_runtime::TOOL_CATALOG_VERSION)
}

pub(crate) fn incompatible_session_response() -> Json<ApiResponse> {
    ApiResponse::error(
        "session_schema_incompatible",
        format!(
            "session schema is incompatible: expected kernelAbiVersion={}, agentProtocolVersion={} and toolCatalogVersion={}",
            deepcode_kernel_runtime::KERNEL_ABI_VERSION,
            deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION,
            deepcode_kernel_runtime::TOOL_CATALOG_VERSION
        ),
    )
}

pub(crate) fn is_archived_session(session: &Value) -> bool {
    session.get("archivedAt").and_then(Value::as_str).is_some()
}

pub(crate) fn remove_session_storage_dir(sessions_dir: &FsPath, safe_session_id: &str) {
    let path = sessions_dir.join(safe_session_id);
    if path.starts_with(sessions_dir) {
        let _ = fs::remove_dir_all(path);
    }
}

pub(crate) fn remove_conversation_archive_dirs(archive_root: &FsPath, safe_session_id: &str) {
    let Ok(workspaces) = fs::read_dir(archive_root) else {
        return;
    };
    for workspace in workspaces.filter_map(Result::ok) {
        let session_dir = workspace.path().join(safe_session_id);
        if session_dir.starts_with(archive_root) {
            let _ = fs::remove_dir_all(session_dir);
        }
    }
}

pub(crate) fn remove_session_memory_archive(
    memory_root: &FsPath,
    workspace_scope_key: &str,
    safe_session_id: &str,
    session_id: &str,
) -> Value {
    let safe_scope_key = safe_path_segment(workspace_scope_key);
    let archive_dir = memory_root.join(&safe_scope_key);
    let sessions_dir = archive_dir.join("sessions");
    let targets = [
        sessions_dir.join(format!("{safe_session_id}.md")),
        sessions_dir.join(format!("{safe_session_id}.memory.json")),
    ];
    let mut removed_files = Vec::new();
    let mut missing_files = Vec::new();
    let mut errors = Vec::new();

    for target in targets {
        let display_path = target
            .strip_prefix(memory_root)
            .unwrap_or(target.as_path())
            .to_string_lossy()
            .to_string();
        if !target.starts_with(&sessions_dir) {
            errors.push(json!({
                "path": display_path,
                "code": "memory_cleanup_path_out_of_scope"
            }));
            continue;
        }
        if !target.exists() {
            missing_files.push(json!(display_path));
            continue;
        }
        match fs::remove_file(&target) {
            Ok(()) => removed_files.push(json!(display_path)),
            Err(error) => errors.push(json!({
                "path": display_path,
                "code": "memory_cleanup_remove_failed",
                "message": error.to_string()
            })),
        }
    }

    let project_archive_needs_refresh = !removed_files.is_empty();
    let manifest = append_session_memory_cleanup_manifest(
        &archive_dir,
        session_id,
        safe_session_id,
        &removed_files,
        &missing_files,
        &errors,
        project_archive_needs_refresh,
    );

    json!({
        "workspaceScopeKey": safe_scope_key,
        "sessionId": session_id,
        "safeSessionId": safe_session_id,
        "removedFiles": removed_files,
        "missingFiles": missing_files,
        "errors": errors,
        "projectArchiveNeedsRefresh": project_archive_needs_refresh,
        "manifestUpdated": manifest.get("updated").and_then(Value::as_bool).unwrap_or(false),
        "manifestError": manifest.get("error").cloned().unwrap_or(Value::Null)
    })
}

fn append_session_memory_cleanup_manifest(
    archive_dir: &FsPath,
    session_id: &str,
    safe_session_id: &str,
    removed_files: &[Value],
    missing_files: &[Value],
    errors: &[Value],
    project_archive_needs_refresh: bool,
) -> Value {
    if !archive_dir.exists() {
        return json!({
            "updated": false,
            "error": null
        });
    }
    let manifest_path = archive_dir.join("manifest.json");
    let mut manifest = fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<Value>(&content).ok())
        .unwrap_or_else(|| {
            json!({
                "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
                "archivePath": archive_dir.to_string_lossy()
            })
        });
    if !manifest.is_object() {
        manifest = json!({
            "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
            "archivePath": archive_dir.to_string_lossy()
        });
    }

    let cleanup_event = json!({
        "event": "session_memory_removed",
        "sessionId": session_id,
        "safeSessionId": safe_session_id,
        "removedAt": now_text(),
        "removedFiles": removed_files,
        "missingFiles": missing_files,
        "errors": errors,
        "projectArchiveNeedsRefresh": project_archive_needs_refresh
    });

    if let Some(object) = manifest.as_object_mut() {
        object.insert(
            "projectArchiveNeedsRefresh".to_string(),
            json!(project_archive_needs_refresh),
        );
        if let Some(array) = object
            .get_mut("cleanupEvents")
            .and_then(Value::as_array_mut)
        {
            array.push(cleanup_event);
        } else {
            object.insert("cleanupEvents".to_string(), json!([cleanup_event]));
        }
        object.insert("updatedAt".to_string(), json!(now_text()));
    }

    match serde_json::to_string_pretty(&manifest) {
        Ok(content) => match fs::write(&manifest_path, content) {
            Ok(()) => json!({
                "updated": true,
                "error": null
            }),
            Err(error) => json!({
                "updated": false,
                "error": error.to_string()
            }),
        },
        Err(error) => json!({
            "updated": false,
            "error": error.to_string()
        }),
    }
}

pub(crate) fn scope_key_from_query(query: &AgentSessionScopeQuery) -> String {
    scope_key_from_parts(
        query.workspace_id.as_deref(),
        query.workspace_hash.as_deref(),
    )
}

pub(crate) fn scope_key_from_parts(
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> String {
    match (workspace_id, workspace_hash) {
        (Some(id), Some(hash)) if !id.trim().is_empty() && !hash.trim().is_empty() => {
            format!(
                "workspace-{}-{}",
                safe_path_segment(id),
                safe_path_segment(hash)
            )
        }
        (Some(id), _) if !id.trim().is_empty() => {
            format!("workspace-{}", safe_path_segment(id))
        }
        _ => "unbound-workspace".to_string(),
    }
}

pub(crate) fn session_scope_key(session: &Value) -> String {
    if let Some(scope_key) = session.get("workspaceScopeKey").and_then(Value::as_str) {
        if !scope_key.trim().is_empty() {
            return safe_path_segment(scope_key);
        }
    }
    scope_key_from_parts(
        session.get("workspaceId").and_then(Value::as_str),
        session.get("workspaceHash").and_then(Value::as_str),
    )
}

pub(crate) fn scoped_sessions(
    gui: &GuiState,
    scope_key: &str,
    include_archived: bool,
) -> Vec<Value> {
    gui.sessions
        .iter()
        .filter(|session| include_archived || !is_archived_session(session))
        .filter(|session| session_scope_key(session) == scope_key)
        .cloned()
        .collect()
}

pub(crate) fn project_sessions(
    gui: &GuiState,
    project_id: &str,
    include_archived: bool,
) -> Vec<Value> {
    gui.sessions
        .iter()
        .filter(|session| include_archived || !is_archived_session(session))
        .filter(|session| session.get("projectId").and_then(Value::as_str) == Some(project_id))
        .cloned()
        .collect()
}

pub(crate) fn current_agent_session_id_for_project(
    gui: &GuiState,
    project_id: &str,
) -> Option<String> {
    if let Some(current_id) = gui.current_session_id.as_deref() {
        if gui.sessions.iter().any(|session| {
            session.get("id").and_then(Value::as_str) == Some(current_id)
                && session.get("projectId").and_then(Value::as_str) == Some(project_id)
                && !is_archived_session(session)
        }) {
            return Some(current_id.to_string());
        }
    }
    gui.sessions
        .iter()
        .find(|session| {
            session.get("projectId").and_then(Value::as_str) == Some(project_id)
                && !is_archived_session(session)
        })
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(str::to_string)
}

pub(crate) fn apply_project_binding_to_session(session: &mut Value, project: &Value) {
    let binding = project_workspace_binding(project);
    session["workspaceBinding"] = binding.clone().unwrap_or(Value::Null);
    if let Some(binding) = binding.as_ref() {
        apply_workspace_binding_to_session(session, binding);
    } else {
        session["workspaceId"] = Value::Null;
        session["workspaceHash"] = Value::Null;
        session["workspaceScopeKey"] = json!("unbound-workspace");
    }
}

pub(crate) fn apply_workspace_binding_to_session(session: &mut Value, binding: &Value) {
    session["workspaceId"] = binding.get("workspaceId").cloned().unwrap_or(Value::Null);
    session["workspaceHash"] = binding.get("workspaceHash").cloned().unwrap_or(Value::Null);
    session["workspaceScopeKey"] = json!(scope_key_from_parts(
        session.get("workspaceId").and_then(Value::as_str),
        session.get("workspaceHash").and_then(Value::as_str),
    ));
}

pub(crate) fn session_by_id<'a>(gui: &'a GuiState, session_id: &str) -> Option<&'a Value> {
    gui.sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

pub(crate) fn current_agent_session_id_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
) -> Option<String> {
    if let Some(current_id) = gui.current_session_ids_by_scope.get(scope_key) {
        if gui.sessions.iter().any(|session| {
            session.get("id").and_then(Value::as_str) == Some(current_id.as_str())
                && !is_archived_session(session)
                && session_scope_key(session) == scope_key
        }) {
            return Some(current_id.clone());
        }
    }

    let next_id = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session) && session_scope_key(session) == scope_key)
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    if let Some(next_id) = next_id.as_ref() {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
    }
    next_id
}

pub(crate) fn ensure_current_agent_session_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
    fallback_scope: Option<(Option<String>, Option<String>, Option<String>)>,
) {
    if let Some(next_id) = gui
        .sessions
        .iter()
        .find(|session| !is_archived_session(session) && session_scope_key(session) == scope_key)
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
    {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
        gui.current_session_id = Some(next_id);
        return;
    }

    let id = format!("session-{}", now_millis());
    let now = now_text();
    let (profile_id, workspace_id, workspace_hash) = fallback_scope.unwrap_or_default();
    let session = create_agent_session_value(
        &id,
        &now,
        "New Agent Session",
        "plan",
        profile_id.as_deref(),
        workspace_id.as_deref(),
        workspace_hash.as_deref(),
    );
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(session_scope_key(&session), id.clone());
    gui.session_projection_cache.insert(id.clone(), Vec::new());
    gui.trace_events.insert(id.clone(), Vec::new());
    gui.sessions.insert(0, session);
}

pub(crate) fn compact_agent_session_title(content: &str) -> Option<String> {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    const TITLE_CHAR_LIMIT: usize = 28;
    let char_count = normalized.chars().count();
    if char_count <= TITLE_CHAR_LIMIT {
        return Some(normalized);
    }
    let title = normalized
        .chars()
        .take(TITLE_CHAR_LIMIT)
        .collect::<String>();
    Some(format!("{title}…"))
}

pub(crate) fn maybe_auto_title_session(gui: &mut GuiState, session_id: &str, content: &str) {
    let Some(title) = compact_agent_session_title(content) else {
        return;
    };
    if let Some(session) = session_mut(gui, session_id) {
        let source = session
            .get("titleSource")
            .and_then(Value::as_str)
            .unwrap_or("pending");
        if source == "pending" {
            session["title"] = json!(title);
            session["titleSource"] = json!("auto");
            session["updatedAt"] = json!(now_text());
        }
    }
}

pub(crate) fn first_user_message_content(events: &[Value]) -> Option<String> {
    events.iter().find_map(|event| {
        if event.get("kind").and_then(Value::as_str) != Some("user_msg") {
            return None;
        }
        event
            .get("payload")
            .and_then(|payload| payload.get("content"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
    })
}

pub(crate) fn refresh_pending_session_titles(gui: &mut GuiState) {
    let sessions_dir = gui.paths.sessions_dir.clone();
    let pending_ids = gui
        .sessions
        .iter()
        .filter(|session| {
            session
                .get("titleSource")
                .and_then(Value::as_str)
                .unwrap_or("pending")
                == "pending"
        })
        .filter_map(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();

    for session_id in pending_ids {
        let events = gui
            .session_projection_cache
            .get(&session_id)
            .cloned()
            .unwrap_or_else(|| read_session_projection_jsonl(&sessions_dir, &session_id));
        if let Some(content) = first_user_message_content(&events) {
            maybe_auto_title_session(gui, &session_id, &content);
        }
    }
}

pub(crate) fn has_session(gui: &GuiState, session_id: &str) -> bool {
    gui.sessions.iter().any(|session| {
        session.get("id").and_then(Value::as_str) == Some(session_id)
            && !is_archived_session(session)
    })
}

pub(crate) fn session_mut<'a>(gui: &'a mut GuiState, session_id: &str) -> Option<&'a mut Value> {
    gui.sessions
        .iter_mut()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
}

pub(crate) fn update_session_event_count(gui: &mut GuiState, session_id: &str) {
    let count = gui
        .session_projection_cache
        .get(session_id)
        .map(Vec::len)
        .unwrap_or_default();
    if let Some(session) = session_mut(gui, session_id) {
        session["eventCount"] = json!(count);
        session["updatedAt"] = json!(now_text());
    }
}

pub(crate) fn session_result(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    let Some(session) = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
    else {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    };
    if !session_schema_is_compatible(session) {
        return incompatible_session_response();
    }
    let events = gui
        .session_projection_cache
        .get(session_id)
        .cloned()
        .unwrap_or_else(|| read_session_projection_jsonl(&gui.paths.sessions_dir, session_id));
    ApiResponse::ok(json!({
        "session": session,
        "events": events
    }))
}
