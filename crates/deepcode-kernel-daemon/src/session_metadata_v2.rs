use crate::prelude::*;
use crate::*;
use std::collections::HashSet;

const AGENT_SESSION_INDEX_SCHEMA_V2: &str = "deepcode.agent.sessions.v2";

pub(crate) fn restore_session_index(paths: &HostPaths) -> Result<Vec<Value>, String> {
    if !paths.sessions_index_path.exists() {
        return Ok(Vec::new());
    }
    let document = read_json_file(&paths.sessions_index_path).ok_or_else(|| {
        "UnsupportedHistorySchema: Session metadata is unreadable or is not valid JSON".to_string()
    })?;
    if document.get("schemaVersion").and_then(Value::as_str) != Some(AGENT_SESSION_INDEX_SCHEMA_V2)
    {
        return Err(format!(
            "UnsupportedHistorySchema: expected Session metadata schema {}",
            AGENT_SESSION_INDEX_SCHEMA_V2
        ));
    }
    let sessions = document
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| {
            "UnsupportedHistorySchema: Session metadata sessions must be an array".to_string()
        })?;
    let mut session_ids = HashSet::with_capacity(sessions.len());
    for session in &sessions {
        let id = session.get("id").and_then(Value::as_str).ok_or_else(|| {
            "UnsupportedHistorySchema: every Session metadata entry must have a string id"
                .to_string()
        })?;
        if crate::host_v2_storage::validate_safe_session_identity(id).is_err() {
            return Err(
                "UnsupportedHistorySchema: Session metadata id must be a non-empty path-safe identity"
                    .to_string(),
            );
        }
        if !session_ids.insert(id.to_string()) {
            return Err(
                "UnsupportedHistorySchema: Session metadata contains a duplicate Session id"
                    .to_string(),
            );
        }
        if let Some(deletion) = session.get("deletion") {
            let status = deletion
                .as_object()
                .and_then(|value| value.get("status"))
                .and_then(Value::as_str);
            if !matches!(status, Some("pending" | "failed")) {
                return Err(
                    "UnsupportedHistorySchema: Session deletion state is invalid".to_string(),
                );
            }
        }
    }
    let mut sessions = sessions;
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(
            session
                .get("updatedAt")
                .or_else(|| session.get("createdAt"))
                .and_then(Value::as_str)
                .unwrap_or_default()
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
    crate::host_v2_storage::atomic_write_private_json(
        path,
        &json!({
            "schemaVersion": AGENT_SESSION_INDEX_SCHEMA_V2,
            "sessions": sessions
        }),
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))
}

pub(crate) fn restored_current_session_ids_by_scope(sessions: &[Value]) -> HashMap<String, String> {
    let mut current = HashMap::new();
    for session in sessions {
        if !session_is_selectable(session) {
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
