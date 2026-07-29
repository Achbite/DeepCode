use crate::prelude::*;
use crate::*;

pub(crate) const AGENT_SESSION_SCHEMA_V2: &str = "deepcode.agent.session.v2";
pub(crate) const SESSION_KERNEL_HISTORY_SCHEMA_V2: &str = "deepcode.session.kernel-persistence.v2";

pub(crate) async fn host_skills(State(state): State<AppState>) -> Json<ApiResponse> {
    match state.host_services.skill_admin.discover() {
        Ok(result) => ApiResponse::ok(json!(result)),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}

pub(crate) fn create_agent_session_value(
    id: &str,
    now: &str,
    title: &str,
    profile_id: Option<&str>,
    workspace_id: Option<&str>,
    workspace_hash: Option<&str>,
) -> Value {
    let workspace_scope_key = scope_key_from_parts(workspace_id, workspace_hash);
    json!({
        "id": id,
        "sessionSchemaVersion": AGENT_SESSION_SCHEMA_V2,
        "historySchema": SESSION_KERNEL_HISTORY_SCHEMA_V2,
        "kernelAbiVersion": deepcode_kernel_abi::KERNEL_ABI_V2_VERSION,
        "title": title,
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
    session.get("sessionSchemaVersion").and_then(Value::as_str) == Some(AGENT_SESSION_SCHEMA_V2)
        && session.get("historySchema").and_then(Value::as_str)
            == Some(SESSION_KERNEL_HISTORY_SCHEMA_V2)
        && session.get("kernelAbiVersion").and_then(Value::as_str)
            == Some(deepcode_kernel_abi::KERNEL_ABI_V2_VERSION)
}

pub(crate) fn incompatible_session_response() -> Json<ApiResponse> {
    ApiResponse::error(
        "unsupported_history_schema",
        format!(
            "session history is unsupported: expected sessionSchemaVersion={}, historySchema={} and kernelAbiVersion={}",
            AGENT_SESSION_SCHEMA_V2,
            SESSION_KERNEL_HISTORY_SCHEMA_V2,
            deepcode_kernel_abi::KERNEL_ABI_V2_VERSION
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
) -> Result<(), String> {
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
        return Ok(());
    }

    let id = format!("session-{}", now_millis());
    let now = now_text();
    let (profile_id, workspace_id, workspace_hash) = fallback_scope.unwrap_or_default();
    let session = create_agent_session_value(
        &id,
        &now,
        "New Agent Session",
        profile_id.as_deref(),
        workspace_id.as_deref(),
        workspace_hash.as_deref(),
    );
    let new_session_storage_dir = gui.paths.sessions_dir.join(safe_path_segment(&id));
    if new_session_storage_dir.exists() {
        return Err(
            "generated replacement Session identity already has private storage".to_string(),
        );
    }
    gui.current_session_id = Some(id.clone());
    gui.current_session_ids_by_scope
        .insert(session_scope_key(&session), id.clone());
    gui.sessions.insert(0, session);
    Ok(())
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
        let events = read_session_kernel_v2_public_agent_events(&sessions_dir, &session_id)
            .unwrap_or_default();
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
    let events =
        match read_session_kernel_v2_public_agent_events(&gui.paths.sessions_dir, session_id) {
            Ok(events) => events,
            Err(error) => {
                return ApiResponse::error(
                    error.code,
                    format!(
                        "Session v2 public projection is unavailable: {}",
                        error.message
                    ),
                )
            }
        };
    ApiResponse::ok(json!({
        "session": session,
        "events": events
    }))
}
