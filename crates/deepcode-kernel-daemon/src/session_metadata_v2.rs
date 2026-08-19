use crate::prelude::*;
use crate::*;
use std::collections::HashSet;

const AGENT_SESSION_INDEX_SCHEMA_V2: &str = "deepcode.agent.sessions.v2";

const SESSION_METADATA_REQUIRED_FIELDS: &[&str] = &[
    "id",
    "sessionSchemaVersion",
    "historySchema",
    "kernelAbiVersion",
    "title",
    "profileId",
    "workspaceId",
    "workspaceHash",
    "workspaceScopeKey",
    "titleSource",
    "eventCount",
    "createdAt",
    "updatedAt",
];

const SESSION_METADATA_OPTIONAL_FIELDS: &[&str] = &[
    "projectId",
    "workspaceBinding",
    "archivedAt",
    "deletion",
    "firstInputAdmission",
];

const WORKSPACE_BINDING_FIELDS: &[&str] = &[
    "workspaceId",
    "workspaceHash",
    "openPath",
    "activeFolderId",
    "folderHash",
    "workspaceBindingRef",
    "workspaceBindingIdentity",
];

pub(crate) fn restore_session_index(paths: &HostPaths) -> Result<Vec<Value>, String> {
    if !paths.sessions_index_path.exists() {
        return Ok(Vec::new());
    }
    let document = read_json_file(&paths.sessions_index_path).ok_or_else(|| {
        "UnsupportedHistorySchema: Session metadata is unreadable or is not valid JSON".to_string()
    })?;
    let mut sessions = validate_session_index_document(&document)?.clone();
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(
            session
                .get("updatedAt")
                .and_then(Value::as_str)
                .expect("validated current Session metadata updatedAt")
                .to_owned(),
        )
    });
    Ok(sessions)
}

pub(crate) fn persist_session_index(gui: &GuiState) -> Result<(), String> {
    if let Some(error) = gui.session_metadata_error.as_deref() {
        return Err(error.to_string());
    }
    persist_session_index_values(&gui.paths.sessions_index_path, &gui.sessions)
}

pub(crate) fn session_metadata_unavailable_response(state: &AppState) -> Option<Json<ApiResponse>> {
    let gui = state.gui.lock().expect("gui state lock");
    gui.session_metadata_error
        .as_deref()
        .map(|message| ApiResponse::error("unsupported_history_schema", message.to_string()))
}

pub(crate) fn persist_session_index_values(
    path: &PathBuf,
    sessions: &[Value],
) -> Result<(), String> {
    let document = json!({
        "schemaVersion": AGENT_SESSION_INDEX_SCHEMA_V2,
        "sessions": sessions
    });
    validate_session_index_document(&document)?;
    crate::host_v2_storage::atomic_write_private_json(path, &document)
        .map_err(|error| format!("{}: {}", error.code, error.message))
}

fn validate_session_index_document(document: &Value) -> Result<&Vec<Value>, String> {
    let root = exact_object(
        document,
        &["schemaVersion", "sessions"],
        &[],
        "Session metadata root",
    )?;
    if root.get("schemaVersion").and_then(Value::as_str) != Some(AGENT_SESSION_INDEX_SCHEMA_V2) {
        return Err(unsupported_history(format!(
            "expected Session metadata schema {AGENT_SESSION_INDEX_SCHEMA_V2}"
        )));
    }
    let sessions = root
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| unsupported_history("Session metadata sessions must be an array"))?;
    let mut session_ids = HashSet::with_capacity(sessions.len());
    for session in sessions {
        let id = validate_session_metadata_entry(session)?;
        if !session_ids.insert(id.to_string()) {
            return Err(unsupported_history(
                "Session metadata contains a duplicate Session id",
            ));
        }
    }
    Ok(sessions)
}

fn validate_session_metadata_entry(session: &Value) -> Result<&str, String> {
    let entry = exact_object(
        session,
        SESSION_METADATA_REQUIRED_FIELDS,
        SESSION_METADATA_OPTIONAL_FIELDS,
        "Session metadata entry",
    )?;
    let id = required_string(entry, "id", "Session metadata entry")?;
    if crate::host_v2_storage::validate_safe_session_identity(id).is_err() {
        return Err(unsupported_history(
            "Session metadata id must be a non-empty path-safe identity",
        ));
    }
    if !session_schema_is_current(session) {
        return Err(unsupported_history(format!(
            "Session metadata entry {id} does not use the current Session, history, and Kernel ABI discriminators"
        )));
    }
    required_string(entry, "title", "Session metadata entry")?;
    required_nullable_string(entry, "profileId", "Session metadata entry")?;
    required_nullable_string(entry, "workspaceId", "Session metadata entry")?;
    required_nullable_string(entry, "workspaceHash", "Session metadata entry")?;
    required_string(entry, "workspaceScopeKey", "Session metadata entry")?;
    match required_string(entry, "titleSource", "Session metadata entry")? {
        "pending" | "auto" | "user" => {}
        _ => {
            return Err(unsupported_history(
                "Session metadata titleSource must use the current closed set",
            ))
        }
    }
    if entry.get("eventCount").and_then(Value::as_u64).is_none() {
        return Err(unsupported_history(
            "Session metadata eventCount must be an unsigned integer",
        ));
    }
    required_string(entry, "createdAt", "Session metadata entry")?;
    required_string(entry, "updatedAt", "Session metadata entry")?;

    if let Some(project_id) = entry.get("projectId") {
        nullable_string(project_id, "Session metadata projectId")?;
    }
    if let Some(archived_at) = entry.get("archivedAt") {
        if archived_at.as_str().is_none() {
            return Err(unsupported_history(
                "Session metadata archivedAt must be a string",
            ));
        }
    }
    if let Some(binding) = entry.get("workspaceBinding") {
        validate_workspace_binding(binding)?;
    }
    if let Some(deletion) = entry.get("deletion") {
        validate_deletion_state(deletion)?;
    }
    if let Some(admission) = entry.get("firstInputAdmission") {
        validate_first_input_admission(admission)?;
    }
    Ok(id)
}

fn validate_first_input_admission(admission: &Value) -> Result<(), String> {
    let schema = admission
        .get("schemaVersion")
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported_history("Session firstInputAdmission has no schemaVersion"))?;
    let admission = match schema {
        "deepcode.host.project-session-admission.v1" => {
            let admission = exact_object(
                admission,
                &[
                    "schemaVersion",
                    "projectId",
                    "callerRequestId",
                    "requestDigest",
                    "status",
                    "createdAt",
                    "updatedAt",
                ],
                &[],
                "Session firstInputAdmission",
            )?;
            required_string(admission, "projectId", "Session firstInputAdmission")?;
            admission
        }
        "deepcode.host.conversation-draft-admission.v1" => {
            let admission = exact_object(
                admission,
                &[
                    "schemaVersion",
                    "targetKind",
                    "projectId",
                    "callerRequestId",
                    "requestDigest",
                    "status",
                    "createdAt",
                    "updatedAt",
                ],
                &[],
                "Session firstInputAdmission",
            )?;
            match required_string(admission, "targetKind", "Session firstInputAdmission")? {
                "public" if admission.get("projectId").is_some_and(Value::is_null) => {}
                "project" => {
                    required_string(admission, "projectId", "Session firstInputAdmission")?;
                }
                _ => {
                    return Err(unsupported_history(
                        "Session firstInputAdmission targetKind and projectId do not match",
                    ))
                }
            }
            admission
        }
        _ => {
            return Err(unsupported_history(
                "Session firstInputAdmission uses an unsupported schema",
            ))
        }
    };
    required_string(admission, "callerRequestId", "Session firstInputAdmission")?;
    let request_digest =
        required_string(admission, "requestDigest", "Session firstInputAdmission")?;
    crate::host_v2_storage::validate_sha256_digest(request_digest, "requestDigest")
        .map_err(|error| unsupported_history(error.message))?;
    match required_string(admission, "status", "Session firstInputAdmission")? {
        "pending" | "admitted" => {}
        _ => {
            return Err(unsupported_history(
                "Session firstInputAdmission status must use the current closed set",
            ))
        }
    }
    required_string(admission, "createdAt", "Session firstInputAdmission")?;
    required_string(admission, "updatedAt", "Session firstInputAdmission")?;
    Ok(())
}

fn validate_workspace_binding(binding: &Value) -> Result<(), String> {
    if binding.is_null() {
        return Ok(());
    }
    let binding = exact_object(
        binding,
        WORKSPACE_BINDING_FIELDS,
        &[],
        "Session workspaceBinding",
    )?;
    for field in WORKSPACE_BINDING_FIELDS {
        required_string(binding, field, "Session workspaceBinding")?;
    }
    Ok(())
}

fn validate_deletion_state(deletion: &Value) -> Result<(), String> {
    let status = deletion
        .as_object()
        .and_then(|value| value.get("status"))
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported_history("Session deletion state must have a string status"))?;
    let deletion = match status {
        "pending" => exact_object(
            deletion,
            &["status", "requestedAt", "lastAttemptAt", "attempt"],
            &[],
            "pending Session deletion state",
        )?,
        "failed" => exact_object(
            deletion,
            &[
                "status",
                "requestedAt",
                "lastAttemptAt",
                "failedAt",
                "attempt",
                "error",
            ],
            &[],
            "failed Session deletion state",
        )?,
        _ => {
            return Err(unsupported_history(
                "Session deletion status must use the current closed set",
            ))
        }
    };
    required_string(deletion, "requestedAt", "Session deletion state")?;
    required_string(deletion, "lastAttemptAt", "Session deletion state")?;
    if deletion
        .get("attempt")
        .and_then(Value::as_u64)
        .is_none_or(|attempt| attempt == 0)
    {
        return Err(unsupported_history(
            "Session deletion attempt must be a positive unsigned integer",
        ));
    }
    if status == "failed" {
        required_string(deletion, "failedAt", "failed Session deletion state")?;
        let error = exact_object(
            deletion
                .get("error")
                .expect("validated failed Session deletion error field"),
            &["code", "message"],
            &[],
            "failed Session deletion error",
        )?;
        required_string(error, "code", "failed Session deletion error")?;
        required_string(error, "message", "failed Session deletion error")?;
    }
    Ok(())
}

fn exact_object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    let object = value
        .as_object()
        .ok_or_else(|| unsupported_history(format!("{label} must be an object")))?;
    if let Some(field) = required.iter().find(|field| !object.contains_key(**field)) {
        return Err(unsupported_history(format!(
            "{label} is missing required field {field}"
        )));
    }
    if let Some(field) = object
        .keys()
        .find(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
    {
        return Err(unsupported_history(format!(
            "{label} contains unknown field {field}"
        )));
    }
    Ok(object)
}

fn required_string<'a>(
    object: &'a serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<&'a str, String> {
    object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| unsupported_history(format!("{label} field {field} must be a string")))
}

fn required_nullable_string(
    object: &serde_json::Map<String, Value>,
    field: &str,
    label: &str,
) -> Result<(), String> {
    let value = object
        .get(field)
        .expect("exact current Session metadata required field");
    nullable_string(value, &format!("{label} field {field}"))
}

fn nullable_string(value: &Value, label: &str) -> Result<(), String> {
    if value.is_null() || value.is_string() {
        Ok(())
    } else {
        Err(unsupported_history(format!(
            "{label} must be a string or null"
        )))
    }
}

fn unsupported_history(message: impl std::fmt::Display) -> String {
    format!("UnsupportedHistorySchema: {message}")
}

pub(crate) fn restored_current_session_ids_by_scope(sessions: &[Value]) -> HashMap<String, String> {
    let mut current = HashMap::new();
    for session in sessions {
        if !session_is_publicly_selectable(session) {
            continue;
        }
        let Some(session_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        current
            .entry(session_scope_key(session))
            .or_insert_with(|| session_id.to_string());
    }
    current
}

pub(crate) fn trusted_private_storage_origin(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };
    if origin == "deepcode-gui://localhost" {
        return true;
    }
    let Some(origin_authority) = origin.strip_prefix("http://") else {
        return false;
    };
    let Some(request_authority) = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin_authority == request_authority && is_loopback_authority(origin_authority)
}

fn is_loopback_authority(authority: &str) -> bool {
    authority == "localhost"
        || authority.starts_with("localhost:")
        || authority == "127.0.0.1"
        || authority.starts_with("127.0.0.1:")
        || authority == "[::1]"
        || authority.starts_with("[::1]:")
}
