use crate::prelude::*;
use crate::*;

pub(crate) const ARCHIVE_DEBUG_STREAMS: &[&str] = &[
    "parser-results.jsonl",
    "trace-events.jsonl",
    "llm-exchanges.jsonl",
    "context-assemblies.jsonl",
    "agent-plan-parts.jsonl",
    "action-bundle-drafts.jsonl",
    "draft-task-queues.jsonl",
    "plan-review-reports.jsonl",
    "resource-packets.jsonl",
    "review-packets.jsonl",
    "permission-tool-facts.jsonl",
    "llm-provider-errors.jsonl",
    "wire-ledger.jsonl",
    "cache-telemetry.jsonl",
];

#[derive(Default)]
pub(crate) struct ProjectionSummary {
    pub(crate) event_count: usize,
    pub(crate) first_timestamp: Option<String>,
    pub(crate) last_timestamp: Option<String>,
    pub(crate) first_user_content: Option<String>,
}

pub(crate) fn restore_session_index(paths: &HostPaths) -> Vec<Value> {
    let mut sessions_by_id: HashMap<String, Value> = HashMap::new();

    if let Some(indexed) = read_json_file(&paths.sessions_index_path)
        .and_then(|value| value.get("sessions").and_then(Value::as_array).cloned())
    {
        for session in indexed {
            if let Some(session_id) = session
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(ToOwned::to_owned)
            {
                sessions_by_id.insert(session_id, session);
            }
        }
    }

    for session in read_archived_session_metadata(&paths.conversation_archives_dir) {
        let Some(session_id) = session
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
            .map(ToOwned::to_owned)
        else {
            continue;
        };
        sessions_by_id
            .entry(session_id)
            .and_modify(|existing| {
                if session_sort_key(&session) > session_sort_key(existing) {
                    *existing = session.clone();
                }
            })
            .or_insert(session);
    }

    for session_id in projection_session_ids(&paths.sessions_dir) {
        sessions_by_id.entry(session_id.clone()).or_insert_with(|| {
            let created_at = timestamp_from_session_id(&session_id).unwrap_or_else(now_text);
            let mut restored = create_agent_session_value(
                &session_id,
                &created_at,
                "New Agent Session",
                "plan",
                None,
                None,
                None,
            );
            if let Some(object) = restored.as_object_mut() {
                object.remove("agentProtocolVersion");
                object.remove("toolCatalogVersion");
            }
            restored
        });
    }

    let session_ids = sessions_by_id.keys().cloned().collect::<Vec<_>>();
    for session_id in session_ids {
        if let Some(session) = sessions_by_id.get_mut(&session_id) {
            normalize_restored_session(session, &session_id, &paths.sessions_dir);
        }
    }

    let mut sessions = sessions_by_id
        .into_values()
        .filter(|session| session.get("id").and_then(Value::as_str).is_some())
        .collect::<Vec<_>>();
    sessions.sort_by_key(|session| std::cmp::Reverse(session_sort_key(session)));
    sessions
}

pub(crate) fn persist_session_index(gui: &GuiState) -> Result<(), String> {
    atomic_write_json(
        &gui.paths.sessions_index_path,
        &json!({
            "schemaVersion": "deepcode.agent.sessions.v1",
            "sessions": gui.sessions
        }),
    )
}

pub(crate) fn restored_current_session_ids_by_scope(sessions: &[Value]) -> HashMap<String, String> {
    let mut current = HashMap::new();
    for session in sessions {
        if is_archived_session(session) {
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

pub(crate) async fn session_store_index(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "storeRoot": gui.paths.sessions_dir.to_string_lossy(),
        "conversationArchiveRoot": gui.paths.conversation_archives_dir.to_string_lossy()
    }))
}

pub(crate) async fn session_store_archive_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let (archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    let archives = read_conversation_archive_manifests(&archive_root, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "conversationArchiveRoot": archive_root.to_string_lossy(),
        "defaultWorkspaceScopeKey": workspace_scope_key(session.as_ref()),
        "archives": archives
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveFileQuery {
    pub(crate) run_id: Option<String>,
    pub(crate) path: String,
}

pub(crate) async fn session_store_archive_file_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Query(query): Query<ArchiveFileQuery>,
) -> Json<ApiResponse> {
    let (archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    let Some(manifest) =
        select_archive_manifest(&archive_root, &session_id, query.run_id.as_deref())
    else {
        return ApiResponse::error(
            "conversation_archive_not_found",
            "conversation archive not found",
        );
    };
    let Some(archive_path) = manifest.get("archivePath").and_then(Value::as_str) else {
        return ApiResponse::error(
            "conversation_archive_invalid",
            "conversation archive manifest missing archivePath",
        );
    };
    let archive_dir = PathBuf::from(archive_path);
    if !archive_dir.starts_with(&archive_root) {
        return ApiResponse::error(
            "conversation_archive_invalid",
            "conversation archive path is outside archive root",
        );
    }
    let Some(relative_path) = safe_archive_relative_path(&query.path) else {
        return ApiResponse::error(
            "invalid_archive_path",
            "archive file path must be relative and safe",
        );
    };
    let file_path = archive_dir.join(&relative_path);
    if !file_path.starts_with(&archive_dir) {
        return ApiResponse::error(
            "invalid_archive_path",
            "archive file path escapes archive directory",
        );
    }
    let Ok(content) = fs::read_to_string(&file_path) else {
        return ApiResponse::error(
            "archive_file_not_found",
            "archive file not found or not readable as UTF-8",
        );
    };
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session.as_ref()),
        "runId": manifest.get("runId").cloned().unwrap_or(Value::Null),
        "path": relative_path.to_string_lossy(),
        "content": content
    }))
}

pub(crate) async fn session_store_memory_archive_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let (memory_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.memory_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    let archive_dir = memory_archive_dir(&memory_root, session.as_ref());
    let session_archive_dir = archive_dir.join("sessions");
    let safe_session = safe_path_segment(&session_id);
    let project_markdown_path = archive_dir.join("project.md");
    let project_sidecar_path = archive_dir.join("project.memory.json");
    let session_markdown_path = session_archive_dir.join(format!("{safe_session}.md"));
    let session_sidecar_path = session_archive_dir.join(format!("{safe_session}.memory.json"));
    let manifest_path = archive_dir.join("manifest.json");
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session.as_ref()),
        "memoryArchiveRoot": memory_root.to_string_lossy(),
        "archivePath": archive_dir.to_string_lossy(),
        "exists": project_markdown_path.exists() || session_markdown_path.exists(),
        "projectMarkdown": read_optional_text_file(&project_markdown_path),
        "sessionMarkdown": read_optional_text_file(&session_markdown_path),
        "projectSidecar": read_json_file(&project_sidecar_path),
        "sessionSidecar": read_json_file(&session_sidecar_path),
        "manifest": read_json_file(&manifest_path),
        "files": {
            "projectMarkdown": project_markdown_path.to_string_lossy(),
            "projectSidecar": project_sidecar_path.to_string_lossy(),
            "sessionMarkdown": session_markdown_path.to_string_lossy(),
            "sessionSidecar": session_sidecar_path.to_string_lossy(),
            "manifest": manifest_path.to_string_lossy()
        }
    }))
}

pub(crate) async fn session_store_memory_archive_post(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/memory/archive",
                rejection,
            )
        }
    };
    let (memory_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.memory_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    match write_session_memory_archive(&memory_root, &session_id, session.as_ref(), &body) {
        Ok(result) => ApiResponse::ok(result),
        Err(error) => ApiResponse::error("write_memory_archive_failed", error.to_string()),
    }
}

pub(crate) async fn session_store_projection_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let entries = session_projection(&state, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries,
        "events": entries
    }))
}

pub(crate) async fn session_store_projection_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
    let entries = body
        .get("entries")
        .or_else(|| body.get("events"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    append_session_projection(&state, &session_id, entries);
    let stored = session_projection(&state, &session_id);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "appended": body
            .get("entries")
            .or_else(|| body.get("events"))
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default(),
        "entryCount": stored.len(),
        "entries": stored,
        "events": stored
    }))
}

pub(crate) async fn session_store_transcript_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let entries = read_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl");
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries
    }))
}

pub(crate) async fn session_store_transcript_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/transcript",
                rejection,
            )
        }
    };
    let entry = body.get("entry").cloned().unwrap_or_else(|| body.clone());
    let (sessions_dir, archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, &session_id),
        )
    };
    match append_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl", &[entry]) {
        Ok(()) => {
            if let Err(error) = append_conversation_archive_transcript(
                &archive_root,
                &session_id,
                session.as_ref(),
                &[body.get("entry").cloned().unwrap_or(body.clone())],
            ) {
                eprintln!("failed to append conversation archive transcript: {error}");
            }
            let entries = read_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl");
            ApiResponse::ok(json!({
                "sessionId": session_id,
                "entryCount": entries.len(),
                "entries": entries
            }))
        }
        Err(error) => ApiResponse::error("write_session_transcript_failed", error.to_string()),
    }
}

pub(crate) async fn session_store_wire_ledger_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    session_observability_stream_get(&state, &session_id, "wire-ledger.jsonl")
}

pub(crate) async fn session_store_wire_ledger_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    session_observability_stream_append(&state, &session_id, body, "wire-ledger.jsonl", true)
}

pub(crate) async fn session_store_cache_telemetry_get(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<ApiResponse> {
    session_observability_stream_get(&state, &session_id, "cache-telemetry.jsonl")
}

pub(crate) async fn session_store_cache_telemetry_append(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    body: Result<Json<Value>, JsonRejection>,
) -> Json<ApiResponse> {
    session_observability_stream_append(&state, &session_id, body, "cache-telemetry.jsonl", false)
}

fn session_observability_stream_get(
    state: &AppState,
    session_id: &str,
    file_name: &str,
) -> Json<ApiResponse> {
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    let entries = read_session_jsonl(&sessions_dir, session_id, file_name);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "entries": entries
    }))
}

fn session_observability_stream_append(
    state: &AppState,
    session_id: &str,
    body: Result<Json<Value>, JsonRejection>,
    file_name: &str,
    reject_reasoning: bool,
) -> Json<ApiResponse> {
    let Json(body) = match body {
        Ok(body) => body,
        Err(rejection) => {
            return json_body_rejection_response(
                "/api/session-store/:session_id/observability",
                rejection,
            )
        }
    };
    let entries = body
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![body.get("entry").cloned().unwrap_or(body.clone())]);
    if reject_reasoning && entries.iter().any(is_hidden_reasoning_wire_record) {
        return ApiResponse::error(
            "wire_ledger_reasoning_forbidden",
            "hidden reasoning cannot be persisted in the wire ledger",
        );
    }
    let sanitized = entries
        .into_iter()
        .map(strip_hidden_reasoning_fields)
        .map(redact_archive_value)
        .collect::<Vec<_>>();
    let (sessions_dir, archive_root, session) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, session_id),
        )
    };
    if let Err(error) = append_session_jsonl(&sessions_dir, session_id, file_name, &sanitized) {
        return ApiResponse::error("write_session_observability_failed", error.to_string());
    }
    if let Err(error) = append_conversation_archive_entries(
        &archive_root,
        session_id,
        session.as_ref(),
        file_name,
        file_name,
        &sanitized,
    ) {
        eprintln!("failed to append conversation archive {file_name}: {error}");
    }
    let stored = read_session_jsonl(&sessions_dir, session_id, file_name);
    ApiResponse::ok(json!({
        "sessionId": session_id,
        "appended": sanitized.len(),
        "entryCount": stored.len(),
        "entries": stored
    }))
}

pub(crate) fn append_session_projection(state: &AppState, session_id: &str, events: Vec<Value>) {
    if events.is_empty() {
        return;
    }
    let (sessions_dir, needs_cache_hydration) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.paths.sessions_dir.clone(),
            !gui.session_projection_cache.contains_key(session_id),
        )
    };
    let existing_events = if needs_cache_hydration {
        read_session_projection_jsonl(&sessions_dir, session_id)
    } else {
        Vec::new()
    };
    let (archive_root, session) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.session_projection_cache
            .entry(session_id.to_string())
            .or_insert_with(|| existing_events)
            .extend(events.clone());
        update_session_event_count(&mut gui, session_id);
        if let Err(error) = persist_session_index(&gui) {
            eprintln!("failed to persist agent session index: {error}");
        }
        (
            gui.paths.conversation_archives_dir.clone(),
            session_metadata(&gui.sessions, session_id),
        )
    };
    if let Err(error) = append_session_projection_jsonl(&sessions_dir, session_id, &events) {
        eprintln!("failed to append session projection: {error}");
    }
    if let Err(error) =
        append_conversation_archive_projection(&archive_root, session_id, session.as_ref(), &events)
    {
        eprintln!("failed to append conversation archive projection: {error}");
    }
}

pub(crate) fn session_projection(state: &AppState, session_id: &str) -> Vec<Value> {
    let (cached, sessions_dir) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.session_projection_cache.get(session_id).cloned(),
            gui.paths.sessions_dir.clone(),
        )
    };
    cached.unwrap_or_else(|| read_session_projection_jsonl(&sessions_dir, session_id))
}

pub(crate) fn store_session_timeline(
    state: &AppState,
    session_id: &str,
    timeline: Value,
) -> std::io::Result<()> {
    let sessions_dir = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.session_timeline_cache
            .insert(session_id.to_string(), timeline.clone());
        gui.paths.sessions_dir.clone()
    };
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::create_dir_all(&dir)?;
    atomic_write_json_file(&dir.join("timeline.json"), &timeline)
}

pub(crate) fn session_timeline(state: &AppState, session_id: &str) -> Option<Value> {
    let (cached, sessions_dir) = {
        let gui = state.gui.lock().expect("gui state lock");
        (
            gui.session_timeline_cache.get(session_id).cloned(),
            gui.paths.sessions_dir.clone(),
        )
    };
    let timeline = cached.or_else(|| {
        read_json_file(
            &sessions_dir
                .join(safe_path_segment(session_id))
                .join("timeline.json"),
        )
    })?;
    let mut gui = state.gui.lock().expect("gui state lock");
    gui.session_timeline_cache
        .insert(session_id.to_string(), timeline.clone());
    Some(timeline)
}

pub(crate) fn append_session_projection_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    events: &[Value],
) -> std::io::Result<()> {
    append_session_jsonl(sessions_dir, session_id, "projection.jsonl", events)
}

pub(crate) fn read_session_projection_jsonl(sessions_dir: &FsPath, session_id: &str) -> Vec<Value> {
    read_session_jsonl(sessions_dir, session_id, "projection.jsonl")
}

pub(crate) fn append_session_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
    entries: &[Value],
) -> std::io::Result<()> {
    use std::io::Write;
    let dir = sessions_dir.join(safe_path_segment(session_id));
    fs::create_dir_all(&dir)?;
    let path = dir.join(file_name);
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    for entry in entries {
        let line = serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_string());
        writeln!(file, "{line}")?;
    }
    Ok(())
}

pub(crate) fn read_session_jsonl(
    sessions_dir: &FsPath,
    session_id: &str,
    file_name: &str,
) -> Vec<Value> {
    let path = sessions_dir
        .join(safe_path_segment(session_id))
        .join(file_name);
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

#[cfg(test)]
#[path = "session_store_tests.rs"]
mod tests;
