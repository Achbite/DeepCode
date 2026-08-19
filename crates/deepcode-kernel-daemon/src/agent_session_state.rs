use crate::prelude::*;
use crate::*;

pub(crate) const AGENT_SESSION_SCHEMA_V2: &str = "deepcode.agent.session.v2";
pub(crate) const SESSION_KERNEL_HISTORY_SCHEMA_V3: &str = "deepcode.session.kernel-persistence.v4";
pub(crate) const AGENT_CONVERSATION_TARGET_SCHEMA_V1: &str = "deepcode.host.conversation-target.v1";
pub(crate) const AGENT_PROJECT_CONVERSATION_TARGET_SCHEMA_V1: &str =
    "deepcode.host.project-conversation-target.v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentConversationTargetV1 {
    pub(crate) schema_version: String,
    pub(crate) target_id: String,
    pub(crate) target_revision: String,
    pub(crate) session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) project_id: Option<String>,
    pub(crate) workspace_scope_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_binding_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_binding_identity: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AgentProjectConversationTargetV1 {
    pub(crate) schema_version: String,
    pub(crate) target_id: String,
    pub(crate) target_revision: String,
    pub(crate) project_id: String,
    pub(crate) workspace_scope_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_binding_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) workspace_binding_identity: Option<String>,
}

pub(crate) fn agent_project_conversation_target_v1(
    project: &Value,
) -> Result<AgentProjectConversationTargetV1, crate::host_v2_storage::HostV2StorageError> {
    let project_id = project
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::host_v2_storage::HostV2StorageError::invalid(
                "agent_project_conversation_target_invalid",
                "Project metadata has no canonical Project identity",
            )
        })?;
    let workspace_binding = project_workspace_binding(project);
    let workspace_id = workspace_binding
        .as_ref()
        .and_then(|binding| binding.get("workspaceId"))
        .and_then(Value::as_str);
    let workspace_hash = workspace_binding
        .as_ref()
        .and_then(|binding| binding.get("workspaceHash"))
        .and_then(Value::as_str);
    let workspace_scope_key = scope_key_from_parts(workspace_id, workspace_hash);
    let workspace_binding_ref = workspace_binding
        .as_ref()
        .and_then(|binding| binding.get("workspaceBindingRef"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let workspace_binding_identity = workspace_binding
        .as_ref()
        .and_then(|binding| binding.get("workspaceBindingIdentity"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let target_id = format!("project-conversation-{project_id}");
    let revision_material = json!({
        "schemaVersion": AGENT_PROJECT_CONVERSATION_TARGET_SCHEMA_V1,
        "targetId": target_id,
        "projectId": project_id,
        "kind": project.get("kind").and_then(Value::as_str),
        "rootStatus": project.get("rootStatus").and_then(Value::as_str),
        "workspaceScopeKey": workspace_scope_key,
        "workspaceBindingRef": workspace_binding_ref,
        "workspaceBindingIdentity": workspace_binding_identity,
    });
    let target_revision = crate::host_v2_storage::canonical_sha256(&revision_material)?;
    Ok(AgentProjectConversationTargetV1 {
        schema_version: AGENT_PROJECT_CONVERSATION_TARGET_SCHEMA_V1.to_string(),
        target_id,
        target_revision,
        project_id: project_id.to_string(),
        workspace_scope_key,
        workspace_binding_ref,
        workspace_binding_identity,
    })
}

pub(crate) fn public_agent_project_value(
    project: &Value,
) -> Result<Value, crate::host_v2_storage::HostV2StorageError> {
    let mut public = project.clone();
    public["conversationTarget"] =
        serde_json::to_value(agent_project_conversation_target_v1(project)?).map_err(|error| {
            crate::host_v2_storage::HostV2StorageError::invalid(
                "agent_project_conversation_target_invalid",
                format!("encode canonical Project conversationTarget: {error}"),
            )
        })?;
    Ok(public)
}

pub(crate) fn public_agent_project_values(
    projects: impl IntoIterator<Item = Value>,
) -> Result<Vec<Value>, crate::host_v2_storage::HostV2StorageError> {
    projects
        .into_iter()
        .map(|project| public_agent_project_value(&project))
        .collect()
}

pub(crate) fn agent_conversation_target_v1(
    session: &Value,
) -> Result<AgentConversationTargetV1, crate::host_v2_storage::HostV2StorageError> {
    let session_id = session
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            crate::host_v2_storage::HostV2StorageError::invalid(
                "agent_conversation_target_invalid",
                "Session metadata has no canonical Session identity",
            )
        })?;
    let project_id = session
        .get("projectId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let workspace_scope_key = session_scope_key(session);
    let workspace_binding_ref = session
        .pointer("/workspaceBinding/workspaceBindingRef")
        .and_then(Value::as_str)
        .map(str::to_string);
    let workspace_binding_identity = session
        .pointer("/workspaceBinding/workspaceBindingIdentity")
        .and_then(Value::as_str)
        .map(str::to_string);
    let target_id = format!("conversation-{session_id}");
    let revision_material = json!({
        "schemaVersion": AGENT_CONVERSATION_TARGET_SCHEMA_V1,
        "targetId": target_id,
        "sessionId": session_id,
        "projectId": project_id,
        "workspaceScopeKey": workspace_scope_key,
        "workspaceBindingRef": workspace_binding_ref,
        "workspaceBindingIdentity": workspace_binding_identity,
    });
    let target_revision = crate::host_v2_storage::canonical_sha256(&revision_material)?;
    Ok(AgentConversationTargetV1 {
        schema_version: AGENT_CONVERSATION_TARGET_SCHEMA_V1.to_string(),
        target_id,
        target_revision,
        session_id: session_id.to_string(),
        project_id,
        workspace_scope_key,
        workspace_binding_ref,
        workspace_binding_identity,
    })
}

pub(crate) fn require_agent_conversation_target_v1(
    session: &Value,
    supplied: Option<&AgentConversationTargetV1>,
) -> Result<AgentConversationTargetV1, crate::host_v2_storage::HostV2StorageError> {
    let supplied = supplied.ok_or_else(|| {
        crate::host_v2_storage::HostV2StorageError::invalid(
            "agent_conversation_target_required",
            "Every Run mutation requires the exact daemon-issued conversationTarget",
        )
    })?;
    let expected = agent_conversation_target_v1(session)?;
    if supplied != &expected {
        return Err(crate::host_v2_storage::HostV2StorageError::invalid(
            "agent_conversation_target_stale",
            "The submitted conversationTarget no longer identifies the exact Session ownership and workspace binding",
        ));
    }
    Ok(expected)
}

pub(crate) fn public_agent_session_value(
    session: &Value,
) -> Result<Value, crate::host_v2_storage::HostV2StorageError> {
    let mut public = session.clone();
    public
        .as_object_mut()
        .ok_or_else(|| {
            crate::host_v2_storage::HostV2StorageError::invalid(
                "agent_session_invalid",
                "Session metadata is not an object",
            )
        })?
        .remove("firstInputAdmission");
    public["conversationTarget"] = serde_json::to_value(agent_conversation_target_v1(session)?)
        .map_err(|error| {
            crate::host_v2_storage::HostV2StorageError::invalid(
                "agent_conversation_target_invalid",
                format!("encode canonical conversationTarget: {error}"),
            )
        })?;
    Ok(public)
}

pub(crate) fn public_agent_session_values(
    sessions: impl IntoIterator<Item = Value>,
) -> Result<Vec<Value>, crate::host_v2_storage::HostV2StorageError> {
    sessions
        .into_iter()
        .map(|session| public_agent_session_value(&session))
        .collect()
}

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
        "historySchema": SESSION_KERNEL_HISTORY_SCHEMA_V3,
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

pub(crate) fn session_schema_is_current(session: &Value) -> bool {
    session.get("sessionSchemaVersion").and_then(Value::as_str) == Some(AGENT_SESSION_SCHEMA_V2)
        && session.get("historySchema").and_then(Value::as_str)
            == Some(SESSION_KERNEL_HISTORY_SCHEMA_V3)
        && session.get("kernelAbiVersion").and_then(Value::as_str)
            == Some(deepcode_kernel_abi::KERNEL_ABI_V2_VERSION)
}

pub(crate) fn unsupported_session_schema_response() -> Json<ApiResponse> {
    ApiResponse::error(
        "unsupported_history_schema",
        format!(
            "session history is unsupported: expected sessionSchemaVersion={}, historySchema={} and kernelAbiVersion={}",
            AGENT_SESSION_SCHEMA_V2,
            SESSION_KERNEL_HISTORY_SCHEMA_V3,
            deepcode_kernel_abi::KERNEL_ABI_V2_VERSION
        ),
    )
}

pub(crate) fn is_archived_session(session: &Value) -> bool {
    session.get("archivedAt").and_then(Value::as_str).is_some()
}

pub(crate) fn session_deletion_status(session: &Value) -> Option<&str> {
    session
        .get("deletion")
        .and_then(|deletion| deletion.get("status"))
        .and_then(Value::as_str)
}

pub(crate) fn session_is_deletion_tombstone(session: &Value) -> bool {
    matches!(session_deletion_status(session), Some("pending" | "failed"))
}

pub(crate) fn session_is_verified_selectable(session: &Value) -> bool {
    session_schema_is_current(session)
        && !is_archived_session(session)
        && session.get("deletion").is_none()
}

pub(crate) fn session_is_publicly_visible(session: &Value) -> bool {
    !session_is_deletion_tombstone(session)
        && session
            .get("firstInputAdmission")
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .is_none_or(|status| status == "admitted")
}

pub(crate) fn session_is_publicly_selectable(session: &Value) -> bool {
    session_is_verified_selectable(session) && session_is_publicly_visible(session)
}

pub(crate) fn agent_project_binding_transition_lock() -> std::sync::Arc<tokio::sync::Mutex<()>> {
    use std::sync::{Arc, OnceLock};

    static LOCK: OnceLock<Arc<tokio::sync::Mutex<()>>> = OnceLock::new();
    LOCK.get_or_init(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

pub(crate) fn session_has_active_run(
    state: &AppState,
    session_id: &str,
) -> Result<bool, crate::host_v2_storage::HostV2StorageError> {
    let in_memory_active = state
        .session_runs
        .lock()
        .expect("session run state lock")
        .values()
        .any(|run| {
            run.session_id == session_id
                && !matches!(run.status.as_str(), "completed" | "failed" | "cancelled")
        });
    if in_memory_active {
        return Ok(true);
    }
    state
        .host_services
        .active_runs_v2
        .resolve_session_run_slot(session_id)
        .map(|active| active.is_some())
}

pub(crate) fn allocate_agent_session_id(gui: &GuiState) -> Result<String, String> {
    for _ in 0..8 {
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy)
            .map_err(|error| format!("generate Session identity entropy: {error}"))?;
        let mut suffix = String::with_capacity(entropy.len() * 2);
        for byte in entropy {
            use std::fmt::Write as _;
            write!(&mut suffix, "{byte:02x}")
                .map_err(|error| format!("encode Session identity entropy: {error}"))?;
        }
        let id = format!("session-{}-{suffix}", now_millis());
        let metadata_conflict = gui
            .sessions
            .iter()
            .any(|session| session.get("id").and_then(Value::as_str) == Some(id.as_str()));
        let storage_conflict = gui.paths.sessions_dir.join(&id).exists();
        if !metadata_conflict && !storage_conflict {
            return Ok(id);
        }
    }
    Err("could not allocate a unique Session identity".to_string())
}

pub(crate) fn session_private_io_lock(session_id: &str) -> std::sync::Arc<tokio::sync::RwLock<()>> {
    use std::sync::{Arc, Mutex, OnceLock, Weak};

    static LOCKS: OnceLock<Mutex<HashMap<String, Weak<tokio::sync::RwLock<()>>>>> = OnceLock::new();
    let locks = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("Session private I/O lock registry");
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(session_id).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::RwLock::new(()));
    locks.insert(session_id.to_string(), Arc::downgrade(&lock));
    lock
}

pub(crate) fn mark_session_deletion_pending(session: &mut Value, attempted_at: &str) {
    let requested_at = session
        .get("deletion")
        .and_then(|deletion| deletion.get("requestedAt"))
        .and_then(Value::as_str)
        .unwrap_or(attempted_at)
        .to_string();
    let attempt = session
        .get("deletion")
        .and_then(|deletion| deletion.get("attempt"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    session["deletion"] = json!({
        "status": "pending",
        "requestedAt": requested_at,
        "lastAttemptAt": attempted_at,
        "attempt": attempt
    });
    session["updatedAt"] = json!(attempted_at);
}

pub(crate) fn mark_session_deletion_failed(
    session: &mut Value,
    failed_at: &str,
    code: &str,
    message: &str,
) {
    let requested_at = session
        .get("deletion")
        .and_then(|deletion| deletion.get("requestedAt"))
        .and_then(Value::as_str)
        .unwrap_or(failed_at)
        .to_string();
    let last_attempt_at = session
        .get("deletion")
        .and_then(|deletion| deletion.get("lastAttemptAt"))
        .and_then(Value::as_str)
        .unwrap_or(failed_at)
        .to_string();
    let attempt = session
        .get("deletion")
        .and_then(|deletion| deletion.get("attempt"))
        .and_then(Value::as_u64)
        .unwrap_or(1);
    session["deletion"] = json!({
        "status": "failed",
        "requestedAt": requested_at,
        "lastAttemptAt": last_attempt_at,
        "failedAt": failed_at,
        "attempt": attempt,
        "error": {
            "code": code,
            "message": message
        }
    });
    session["updatedAt"] = json!(failed_at);
}

pub(crate) fn remove_session_storage_dir(
    sessions_dir: &FsPath,
    safe_session_id: &str,
) -> Result<(), String> {
    let path = sessions_dir.join(safe_session_id);
    if !path.starts_with(sessions_dir) {
        return Err("resolved Session storage path escaped the Session root".to_string());
    }
    match fs::remove_dir_all(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    if sessions_dir.exists() {
        crate::host_v2_storage::sync_directory(sessions_dir)
            .map_err(|error| format!("{}: {}", error.code, error.message))?;
    }
    Ok(())
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
        .filter(|session| session_is_publicly_visible(session))
        .filter(|session| session.get("projectId").and_then(Value::as_str).is_none())
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
        .filter(|session| session_is_publicly_visible(session))
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
                && session_is_publicly_selectable(session)
        }) {
            return Some(current_id.to_string());
        }
    }
    gui.sessions
        .iter()
        .find(|session| {
            session.get("projectId").and_then(Value::as_str) == Some(project_id)
                && session_is_publicly_selectable(session)
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
    verified_selectable_session(gui, session_id).ok()
}

pub(crate) fn verified_selectable_session<'a>(
    gui: &'a GuiState,
    session_id: &str,
) -> Result<&'a Value, Json<ApiResponse>> {
    let session = gui
        .sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .ok_or_else(|| ApiResponse::error("agent_session_not_found", "agent session not found"))?;
    if !session_schema_is_current(session) {
        return Err(unsupported_session_schema_response());
    }
    if session.get("deletion").is_some() {
        return Err(if session_is_deletion_tombstone(session) {
            ApiResponse::error(
                "agent_session_deletion_in_progress",
                "Session deletion is pending or failed and must be retried before use",
            )
        } else {
            unsupported_session_schema_response()
        });
    }
    if is_archived_session(session) {
        return Err(ApiResponse::error(
            "agent_session_archived",
            "Archived Session cannot admit Run or projection activity",
        ));
    }
    Ok(session)
}

pub(crate) fn current_agent_session_id_for_scope(
    gui: &mut GuiState,
    scope_key: &str,
) -> Option<String> {
    if let Some(current_id) = gui.current_session_ids_by_scope.get(scope_key) {
        if gui.sessions.iter().any(|session| {
            session.get("id").and_then(Value::as_str) == Some(current_id.as_str())
                && session_is_publicly_selectable(session)
                && session.get("projectId").and_then(Value::as_str).is_none()
                && session_scope_key(session) == scope_key
        }) {
            return Some(current_id.clone());
        }
    }

    let next_id = gui
        .sessions
        .iter()
        .find(|session| {
            session_is_publicly_selectable(session)
                && session_scope_key(session) == scope_key
                && session.get("projectId").and_then(Value::as_str).is_none()
        })
        .and_then(|session| session.get("id").and_then(Value::as_str))
        .map(ToOwned::to_owned);
    if let Some(next_id) = next_id.as_ref() {
        gui.current_session_ids_by_scope
            .insert(scope_key.to_string(), next_id.clone());
    }
    next_id
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

pub(crate) fn refresh_pending_session_titles(
    gui: &mut GuiState,
) -> Result<(), crate::host_v2_storage::HostV2StorageError> {
    let sessions_dir = gui.paths.sessions_dir.clone();
    let pending_ids = gui
        .sessions
        .iter()
        .filter(|session| {
            if session_is_deletion_tombstone(session) {
                return false;
            }
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
        let events = read_session_kernel_v2_public_agent_events(&sessions_dir, &session_id)?;
        if let Some(content) = first_user_message_content(&events) {
            maybe_auto_title_session(gui, &session_id, &content);
        }
    }
    Ok(())
}

pub(crate) fn has_session(gui: &GuiState, session_id: &str) -> bool {
    verified_selectable_session(gui, session_id).is_ok()
}

pub(crate) fn session_mut<'a>(gui: &'a mut GuiState, session_id: &str) -> Option<&'a mut Value> {
    gui.sessions.iter_mut().find(|session| {
        session.get("id").and_then(Value::as_str) == Some(session_id)
            && !session_is_deletion_tombstone(session)
    })
}

pub(crate) fn session_result(gui: &GuiState, session_id: &str) -> Json<ApiResponse> {
    let session = match verified_selectable_session(gui, session_id) {
        Ok(session) => session,
        Err(response) => return response,
    };
    if !session_is_publicly_visible(session) {
        return ApiResponse::error("agent_session_not_found", "agent session not found");
    }
    match public_agent_session_value(session) {
        Ok(session) => ApiResponse::ok(json!({ "session": session })),
        Err(error) => ApiResponse::error(error.code, error.message),
    }
}
