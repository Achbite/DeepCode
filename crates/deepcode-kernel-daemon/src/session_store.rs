#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use std::collections::BTreeSet;

const ARCHIVE_DEBUG_STREAMS: &[&str] = &[
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
];

#[derive(Default)]
struct ProjectionSummary {
    event_count: usize,
    first_timestamp: Option<String>,
    last_timestamp: Option<String>,
    first_user_content: Option<String>,
}

pub(crate) fn restore_session_index(paths: &HostPaths) -> Vec<Value> {
    let mut sessions_by_id: HashMap<String, Value> = HashMap::new();

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
            create_agent_session_value(
                &session_id,
                &created_at,
                "New Agent Session",
                "plan",
                None,
                None,
                None,
            )
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
    sessions.sort_by(|left, right| session_sort_key(right).cmp(&session_sort_key(left)));
    sessions
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
    Json(body): Json<Value>,
) -> Json<ApiResponse> {
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

fn read_archived_session_metadata(archive_root: &FsPath) -> Vec<Value> {
    let Ok(workspaces) = fs::read_dir(archive_root) else {
        return Vec::new();
    };
    let mut sessions = Vec::new();
    for workspace in workspaces.filter_map(Result::ok) {
        let Ok(session_dirs) = fs::read_dir(workspace.path()) else {
            continue;
        };
        for session_dir in session_dirs.filter_map(Result::ok) {
            let manifest_path = session_dir.path().join("session").join("manifest.json");
            let Some(manifest) = read_json_file(&manifest_path) else {
                continue;
            };
            let mut session = manifest
                .get("session")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            let session_id = session
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(ToOwned::to_owned)
                .or_else(|| {
                    manifest
                        .get("sessionId")
                        .and_then(Value::as_str)
                        .filter(|id| !id.trim().is_empty())
                        .map(ToOwned::to_owned)
                });
            let Some(session_id) = session_id else {
                continue;
            };
            session["id"] = json!(session_id);
            if session
                .get("workspaceScopeKey")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .is_empty()
            {
                if let Some(scope) = manifest.get("workspaceScopeKey").and_then(Value::as_str) {
                    session["workspaceScopeKey"] = json!(scope);
                }
            }
            sessions.push(session);
        }
    }
    sessions
}

fn projection_session_ids(sessions_dir: &FsPath) -> Vec<String> {
    let Ok(entries) = fs::read_dir(sessions_dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            if !path.join("projection.jsonl").is_file() {
                return None;
            }
            entry.file_name().to_str().map(ToOwned::to_owned)
        })
        .collect()
}

fn normalize_restored_session(session: &mut Value, session_id: &str, sessions_dir: &FsPath) {
    let summary = summarize_session_projection(sessions_dir, session_id);
    let fallback_created_at = timestamp_from_session_id(session_id).unwrap_or_else(now_text);
    let created_at = string_field(session, "createdAt")
        .or(summary.first_timestamp.clone())
        .unwrap_or(fallback_created_at);
    let updated_at = summary
        .last_timestamp
        .clone()
        .or_else(|| string_field(session, "updatedAt"))
        .unwrap_or_else(|| created_at.clone());

    session["id"] = json!(session_id);
    session["createdAt"] = json!(created_at);
    session["updatedAt"] = json!(updated_at);
    session["eventCount"] = json!(summary.event_count);

    if session
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        session["mode"] = json!("plan");
    }
    if !session.get("profileId").is_some() {
        session["profileId"] = Value::Null;
    }
    if !session.get("workspaceId").is_some() {
        session["workspaceId"] = Value::Null;
    }
    if !session.get("workspaceHash").is_some() {
        session["workspaceHash"] = Value::Null;
    }

    let mut title = string_field(session, "title").unwrap_or_default();
    let title_source =
        string_field(session, "titleSource").unwrap_or_else(|| "pending".to_string());
    if is_default_session_title(&title) {
        if let Some(user_content) = summary.first_user_content.as_deref() {
            if let Some(compact) = compact_agent_session_title(user_content) {
                title = compact;
                session["titleSource"] = json!("auto");
            }
        }
    }
    if title.trim().is_empty() {
        title = "New Agent Session".to_string();
    }
    session["title"] = json!(title);
    if session
        .get("titleSource")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        session["titleSource"] = json!(title_source);
    }
    if session
        .get("workspaceScopeKey")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        session["workspaceScopeKey"] = json!(scope_key_from_parts(
            session.get("workspaceId").and_then(Value::as_str),
            session.get("workspaceHash").and_then(Value::as_str),
        ));
    }
}

fn summarize_session_projection(sessions_dir: &FsPath, session_id: &str) -> ProjectionSummary {
    use std::io::BufRead as _;

    let path = sessions_dir
        .join(safe_path_segment(session_id))
        .join("projection.jsonl");
    let Ok(file) = fs::File::open(path) else {
        return ProjectionSummary::default();
    };
    let mut summary = ProjectionSummary::default();
    let reader = std::io::BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let Ok(event) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        summary.event_count += 1;
        let timestamp = event_timestamp(&event);
        if !timestamp.is_empty() {
            if summary.first_timestamp.is_none() {
                summary.first_timestamp = Some(timestamp.clone());
            }
            summary.last_timestamp = Some(timestamp);
        }
        if summary.first_user_content.is_none()
            && event.get("kind").and_then(Value::as_str) == Some("user_msg")
        {
            summary.first_user_content = event
                .get("payload")
                .and_then(|payload| payload.get("content"))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
    }
    summary
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|item| !item.trim().is_empty())
        .map(ToOwned::to_owned)
}

fn is_default_session_title(title: &str) -> bool {
    let normalized = title.trim();
    normalized.is_empty() || normalized == "New Agent Session" || normalized == "新 Agent 会话"
}

fn timestamp_from_session_id(session_id: &str) -> Option<String> {
    session_id
        .strip_prefix("session-")
        .filter(|value| value.chars().all(|ch| ch.is_ascii_digit()))
        .map(ToOwned::to_owned)
}

fn session_sort_key(session: &Value) -> String {
    string_field(session, "updatedAt")
        .or_else(|| string_field(session, "createdAt"))
        .or_else(|| {
            session
                .get("id")
                .and_then(Value::as_str)
                .and_then(timestamp_from_session_id)
        })
        .unwrap_or_default()
}

pub(crate) fn safe_path_segment(input: &str) -> String {
    input
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

pub(crate) fn append_conversation_archive_projection(
    archive_root: &FsPath,
    session_id: &str,
    session: Option<&Value>,
    events: &[Value],
) -> std::io::Result<()> {
    append_conversation_archive_entries(
        archive_root,
        session_id,
        session,
        "projection.jsonl",
        "projection-events.jsonl",
        events,
    )
}

pub(crate) fn append_conversation_archive_transcript(
    archive_root: &FsPath,
    session_id: &str,
    session: Option<&Value>,
    entries: &[Value],
) -> std::io::Result<()> {
    append_conversation_archive_entries(
        archive_root,
        session_id,
        session,
        "transcript.jsonl",
        "transcript-events.jsonl",
        entries,
    )
}

fn append_conversation_archive_entries(
    archive_root: &FsPath,
    session_id: &str,
    session: Option<&Value>,
    file_name: &str,
    debug_file_name: &str,
    entries: &[Value],
) -> std::io::Result<()> {
    let mut groups: HashMap<String, Vec<Value>> = HashMap::new();
    for entry in entries {
        let run_id = extract_run_id(entry).unwrap_or_else(|| "session".to_string());
        groups
            .entry(run_id)
            .or_default()
            .push(redact_archive_value(entry.clone()));
    }

    for (run_id, grouped_entries) in groups {
        let archive_dir = conversation_archive_dir(archive_root, session_id, session, &run_id);
        fs::create_dir_all(archive_dir.join("debug"))?;
        fs::create_dir_all(archive_dir.join("exports"))?;
        append_jsonl_file(&archive_dir.join(file_name), &grouped_entries)?;
        append_jsonl_file(
            &archive_dir.join("debug").join(debug_file_name),
            &grouped_entries,
        )?;
        append_classified_debug_entries(&archive_dir, &grouped_entries)?;
        refresh_conversation_archive(archive_root, &archive_dir, session_id, session, &run_id)?;
    }
    refresh_session_chronological_archive(archive_root, session_id, session)?;
    Ok(())
}

fn refresh_conversation_archive(
    archive_root: &FsPath,
    archive_dir: &FsPath,
    session_id: &str,
    session: Option<&Value>,
    run_id: &str,
) -> std::io::Result<()> {
    let projection = read_jsonl_file(&archive_dir.join("projection.jsonl"));
    let transcript = read_jsonl_file(&archive_dir.join("transcript.jsonl"));
    ensure_debug_stream_files(archive_dir)?;
    let context_assemblies =
        read_jsonl_file(&archive_dir.join("debug").join("context-assemblies.jsonl"));
    let created_at = read_json_file(&archive_dir.join("manifest.json"))
        .and_then(|manifest| {
            manifest
                .get("createdAt")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(now_text);
    atomic_write_text_file(
        &archive_dir.join("exports").join("complete.md"),
        &conversation_complete_markdown(session_id, run_id, &projection, &transcript),
    )?;
    atomic_write_json_file(
        &archive_dir.join("exports").join("debug.json"),
        &json!({
            "schemaVersion": "conversation-debug-export.v1",
            "sessionId": session_id,
            "workspaceScopeKey": workspace_scope_key(session),
            "runId": run_id,
            "archivePath": archive_dir.to_string_lossy(),
            "archiveRoot": archive_root.to_string_lossy(),
            "generatedAt": now_text(),
            "projection": projection,
            "transcript": transcript,
            "contextAssemblies": context_assemblies
        }),
    )?;
    atomic_write_text_file(
        &archive_dir.join("exports").join("context-assemblies.md"),
        &conversation_context_assemblies_markdown(session_id, run_id, &context_assemblies),
    )?;
    let manifest = json!({
        "schemaVersion": "conversation-archive.v1",
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session),
        "runId": run_id,
        "archivePath": archive_dir.to_string_lossy(),
        "createdAt": created_at,
        "updatedAt": now_text(),
        "session": redact_archive_value(session.cloned().unwrap_or_else(|| json!({}))),
        "files": archive_file_entries(archive_dir)
    });
    atomic_write_json_file(&archive_dir.join("manifest.json"), &manifest)?;
    Ok(())
}

fn refresh_session_chronological_archive(
    archive_root: &FsPath,
    session_id: &str,
    session: Option<&Value>,
) -> std::io::Result<()> {
    let archive_dir = conversation_archive_dir(archive_root, session_id, session, "session");
    fs::create_dir_all(archive_dir.join("exports"))?;
    fs::create_dir_all(archive_dir.join("debug"))?;
    let entries = collect_chronological_archive_entries(archive_root, session_id);
    let created_at = read_json_file(&archive_dir.join("manifest.json"))
        .and_then(|manifest| {
            manifest
                .get("createdAt")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(now_text);
    atomic_write_text_file(
        &archive_dir.join("exports").join("chronological.md"),
        &conversation_chronological_markdown(session_id, &entries),
    )?;
    atomic_write_json_file(
        &archive_dir.join("exports").join("chronological-debug.json"),
        &json!({
            "schemaVersion": "conversation-chronological-debug-export.v1",
            "sessionId": session_id,
            "workspaceScopeKey": workspace_scope_key(session),
            "runId": "session",
            "archivePath": archive_dir.to_string_lossy(),
            "archiveRoot": archive_root.to_string_lossy(),
            "generatedAt": now_text(),
            "entries": entries
        }),
    )?;
    let manifest = json!({
        "schemaVersion": "conversation-archive.v1",
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session),
        "runId": "session",
        "archivePath": archive_dir.to_string_lossy(),
        "createdAt": created_at,
        "updatedAt": now_text(),
        "session": redact_archive_value(session.cloned().unwrap_or_else(|| json!({}))),
        "files": archive_file_entries(&archive_dir)
    });
    atomic_write_json_file(&archive_dir.join("manifest.json"), &manifest)?;
    Ok(())
}

fn append_classified_debug_entries(archive_dir: &FsPath, entries: &[Value]) -> std::io::Result<()> {
    let mut streams: HashMap<&'static str, Vec<Value>> = HashMap::new();
    for entry in entries {
        for stream in debug_streams_for_entry(entry) {
            streams.entry(stream).or_default().push(entry.clone());
        }
    }
    for (stream, entries) in streams {
        append_jsonl_file(&archive_dir.join("debug").join(stream), &entries)?;
    }
    Ok(())
}

fn ensure_debug_stream_files(archive_dir: &FsPath) -> std::io::Result<()> {
    let debug_dir = archive_dir.join("debug");
    fs::create_dir_all(&debug_dir)?;
    for stream in ARCHIVE_DEBUG_STREAMS {
        let path = debug_dir.join(stream);
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
    }
    Ok(())
}

fn debug_streams_for_entry(entry: &Value) -> Vec<&'static str> {
    let mut streams = Vec::new();
    if archive_contains_key(entry, &["tracekind"]) {
        push_unique_stream(&mut streams, "trace-events.jsonl");
    }
    if archive_contains_key(
        entry,
        &[
            "llmcallid",
            "requestenvelope",
            "responseenvelope",
            "parserrepairrequest",
        ],
    ) {
        push_unique_stream(&mut streams, "llm-exchanges.jsonl");
    }
    if archive_contains_key(
        entry,
        &[
            "contextassembly",
            "contextassemblyid",
            "stableprefixhash",
            "dynamicsuffixhash",
        ],
    ) {
        push_unique_stream(&mut streams, "context-assemblies.jsonl");
    }
    if archive_contains_key(entry, &["parserresult", "parsererror"]) {
        push_unique_stream(&mut streams, "parser-results.jsonl");
    }
    if archive_contains_key(entry, &["agentplanparts"]) {
        push_unique_stream(&mut streams, "agent-plan-parts.jsonl");
    }
    if archive_contains_key(entry, &["actionbundledraft"]) {
        push_unique_stream(&mut streams, "action-bundle-drafts.jsonl");
    }
    if archive_contains_key(entry, &["drafttaskqueue"]) {
        push_unique_stream(&mut streams, "draft-task-queues.jsonl");
    }
    if archive_contains_key(entry, &["planreviewreport"]) {
        push_unique_stream(&mut streams, "plan-review-reports.jsonl");
    }
    if archive_contains_key(entry, &["resourcepacket"]) {
        push_unique_stream(&mut streams, "resource-packets.jsonl");
    }
    if archive_contains_key(entry, &["reviewpacket"]) {
        push_unique_stream(&mut streams, "review-packets.jsonl");
    }
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if kind.contains("permission")
        || kind.contains("tool_")
        || archive_contains_key(entry, &["permissiondecision", "toolresult", "toolfacts"])
    {
        push_unique_stream(&mut streams, "permission-tool-facts.jsonl");
    }
    if kind == "error"
        && archive_contains_key(
            entry,
            &[
                "providererror",
                "llmproviderdiagnostic",
                "expectedschema",
                "bodypreview",
            ],
        )
    {
        push_unique_stream(&mut streams, "llm-provider-errors.jsonl");
    }
    streams
}

fn push_unique_stream(streams: &mut Vec<&'static str>, stream: &'static str) {
    if !streams.contains(&stream) {
        streams.push(stream);
    }
}

fn archive_contains_key(value: &Value, needles: &[&str]) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, value)| {
            let normalized = key.to_ascii_lowercase().replace('_', "").replace('-', "");
            needles.iter().any(|needle| normalized.contains(needle))
                || archive_contains_key(value, needles)
        }),
        Value::Array(items) => items.iter().any(|item| archive_contains_key(item, needles)),
        _ => false,
    }
}

fn collect_chronological_archive_entries(archive_root: &FsPath, session_id: &str) -> Vec<Value> {
    let manifests = read_conversation_archive_manifests(archive_root, session_id);
    let mut entries = Vec::new();
    let mut order = 0_u64;
    for manifest in manifests {
        let run_id = manifest
            .get("runId")
            .and_then(Value::as_str)
            .unwrap_or("run")
            .to_string();
        let Some(archive_path) = manifest.get("archivePath").and_then(Value::as_str) else {
            continue;
        };
        let archive_dir = PathBuf::from(archive_path);
        for entry in read_jsonl_file(&archive_dir.join("projection.jsonl")) {
            entries.push(chronological_entry("projection", &run_id, order, entry));
            order += 1;
        }
        for entry in read_jsonl_file(&archive_dir.join("transcript.jsonl")) {
            entries.push(chronological_entry("transcript", &run_id, order, entry));
            order += 1;
        }
    }
    entries.sort_by(|left, right| {
        chronological_timestamp(left)
            .cmp(&chronological_timestamp(right))
            .then_with(|| {
                left.get("order")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    .cmp(&right.get("order").and_then(Value::as_u64).unwrap_or(0))
            })
    });
    entries
}

fn chronological_entry(source: &str, run_id: &str, order: u64, entry: Value) -> Value {
    json!({
        "source": source,
        "runId": run_id,
        "timestamp": event_timestamp(&entry),
        "order": order,
        "entry": entry
    })
}

fn chronological_timestamp(entry: &Value) -> String {
    entry
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn event_timestamp(entry: &Value) -> String {
    entry
        .get("ts")
        .and_then(Value::as_str)
        .or_else(|| {
            entry
                .get("payload")
                .and_then(|payload| payload.get("ts"))
                .and_then(Value::as_str)
        })
        .or_else(|| entry.get("createdAt").and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn read_conversation_archive_manifests(archive_root: &FsPath, session_id: &str) -> Vec<Value> {
    let safe_session = safe_path_segment(session_id);
    let Ok(workspaces) = fs::read_dir(archive_root) else {
        return Vec::new();
    };
    let mut manifests = Vec::new();
    for workspace in workspaces.filter_map(Result::ok) {
        let session_dir = workspace.path().join(&safe_session);
        let Ok(runs) = fs::read_dir(session_dir) else {
            continue;
        };
        for run in runs.filter_map(Result::ok) {
            let manifest_path = run.path().join("manifest.json");
            if let Some(manifest) = read_json_file(&manifest_path) {
                manifests.push(manifest);
            }
        }
    }
    manifests.sort_by(|left, right| {
        left.get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
            .reverse()
    });
    manifests
}

fn select_archive_manifest(
    archive_root: &FsPath,
    session_id: &str,
    run_id: Option<&str>,
) -> Option<Value> {
    let mut manifests = read_conversation_archive_manifests(archive_root, session_id);
    manifests.sort_by(|left, right| {
        right
            .get("updatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                left.get("updatedAt")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    if let Some(run_id) = run_id {
        manifests
            .into_iter()
            .find(|manifest| manifest.get("runId").and_then(Value::as_str) == Some(run_id))
    } else {
        manifests.into_iter().next()
    }
}

fn safe_archive_relative_path(path: &str) -> Option<PathBuf> {
    if path.trim().is_empty() || path.starts_with('/') || path.starts_with('\\') {
        return None;
    }
    let candidate = PathBuf::from(path);
    if candidate.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(candidate)
}

pub(crate) fn session_metadata(sessions: &[Value], session_id: &str) -> Option<Value> {
    sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .cloned()
}

fn conversation_archive_dir(
    archive_root: &FsPath,
    session_id: &str,
    session: Option<&Value>,
    run_id: &str,
) -> PathBuf {
    archive_root
        .join(workspace_scope_key(session))
        .join(safe_path_segment(session_id))
        .join(safe_path_segment(run_id))
}

fn workspace_scope_key(session: Option<&Value>) -> String {
    let Some(session) = session else {
        return "unbound-workspace".to_string();
    };
    if let Some(scope) = session.get("workspaceScopeKey").and_then(Value::as_str) {
        return safe_path_segment(scope);
    }
    let workspace_id = session.get("workspaceId").and_then(Value::as_str);
    let workspace_hash = session.get("workspaceHash").and_then(Value::as_str);
    match (workspace_id, workspace_hash) {
        (Some(id), Some(hash)) => format!(
            "workspace-{}-{}",
            safe_path_segment(id),
            safe_path_segment(hash)
        ),
        (Some(id), None) => format!("workspace-{}", safe_path_segment(id)),
        _ => "unbound-workspace".to_string(),
    }
}

fn extract_run_id(value: &Value) -> Option<String> {
    string_at(value, &["runId"])
        .or_else(|| string_at(value, &["payload", "runId"]))
        .or_else(|| string_at(value, &["payload", "kernelEvent", "runId"]))
        .or_else(|| string_at(value, &["kernelEvent", "runId"]))
        .map(ToOwned::to_owned)
}

fn string_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str()
}

fn append_jsonl_file(path: &FsPath, entries: &[Value]) -> std::io::Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent)?;
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

fn atomic_write_json_file(path: &FsPath, value: &Value) -> std::io::Result<()> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error.to_string()))?;
    atomic_write_text_file(path, &content)
}

fn atomic_write_text_file(path: &FsPath, content: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content)?;
    fs::rename(&tmp, path)
}

fn read_jsonl_file(path: &FsPath) -> Vec<Value> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn archive_file_entries(archive_dir: &FsPath) -> Vec<Value> {
    let mut entries = Vec::new();
    collect_archive_file_entries(archive_dir, archive_dir, &mut entries);
    entries.sort_by(|left, right| {
        left.get("path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .cmp(
                right
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            )
    });
    entries
}

fn collect_archive_file_entries(root: &FsPath, current: &FsPath, entries: &mut Vec<Value>) {
    let Ok(children) = fs::read_dir(current) else {
        return;
    };
    for child in children.filter_map(Result::ok) {
        let path = child.path();
        if path.is_dir() {
            collect_archive_file_entries(root, &path, entries);
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let relative = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(json!({
            "path": relative,
            "sizeBytes": metadata.len()
        }));
    }
}

fn conversation_complete_markdown(
    session_id: &str,
    run_id: &str,
    projection: &[Value],
    transcript: &[Value],
) -> String {
    let mut lines = vec![
        format!("# DeepCode Conversation Archive"),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Run: `{run_id}`"),
        format!("- Generated: `{}`", now_text()),
        String::new(),
        "## Projection".to_string(),
    ];
    if projection.is_empty() {
        lines.push("- 无 projection events。".to_string());
    } else {
        for event in projection {
            lines.push(projection_event_markdown(event));
        }
    }
    if !transcript.is_empty() {
        lines.push(String::new());
        lines.push("## Transcript".to_string());
        for entry in transcript {
            lines.push(transcript_entry_markdown(entry));
        }
    }
    lines.join("\n")
}

fn conversation_chronological_markdown(session_id: &str, entries: &[Value]) -> String {
    let mut lines = vec![
        "# DeepCode Chronological Conversation".to_string(),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Archive generated: `{}`", now_text()),
        String::new(),
    ];
    if entries.is_empty() {
        lines.push("- No archived conversation entries.".to_string());
        return lines.join("\n");
    }
    for item in entries {
        let source = item
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("entry");
        let run_id = item.get("runId").and_then(Value::as_str).unwrap_or("run");
        let timestamp = item
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let entry = item.get("entry").unwrap_or(&Value::Null);
        let heading = if source == "projection" {
            format!(
                "Projection / {} / {}",
                archive_projection_entry_title(entry),
                run_id
            )
        } else {
            let role = entry.get("role").and_then(Value::as_str).unwrap_or("entry");
            let channel = entry
                .get("channel")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            format!("Transcript / {role} / {channel} / {run_id}")
        };
        let suffix = if timestamp.is_empty() {
            String::new()
        } else {
            format!(" · {timestamp}")
        };
        lines.push(format!("## {heading}{suffix}"));
        lines.push(String::new());
        lines.push(archive_record_text(entry));
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn conversation_context_assemblies_markdown(
    session_id: &str,
    run_id: &str,
    entries: &[Value],
) -> String {
    let mut lines = vec![
        "# DeepCode Context Assemblies".to_string(),
        String::new(),
        format!("- Session: `{session_id}`"),
        format!("- Run: `{run_id}`"),
        format!("- Export generated: `{}`", now_text()),
        String::new(),
        "This export is for prompt assembly and cache-hit analysis. Cache telemetry never decides PlanReview, PermissionGate, execution, ReviewGate, or accepted state.".to_string(),
        String::new(),
    ];
    if entries.is_empty() {
        lines.push("- No context assembly records.".to_string());
        return lines.join("\n");
    }
    for (index, entry) in entries.iter().enumerate() {
        let empty_assembly = Value::Null;
        let stage = entry
            .get("payload")
            .and_then(|payload| payload.get("stage"))
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let assembly = entry
            .get("payload")
            .and_then(|payload| payload.get("payload"))
            .and_then(|payload| payload.get("contextAssembly"))
            .unwrap_or(&empty_assembly);
        let assembly_id = assembly
            .get("contextAssemblyId")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        lines.push(format!("## {}. `{}` · `{}`", index + 1, stage, assembly_id));
        lines.push(String::new());
        lines.push(format!(
            "- stablePrefixHash: `{}`",
            assembly
                .get("stablePrefixHash")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
        lines.push(format!(
            "- dynamicSuffixHash: `{}`",
            assembly
                .get("dynamicSuffixHash")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
        lines.push(format!(
            "- cacheHash: `{}`",
            assembly
                .get("cacheHash")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        ));
        lines.push(String::new());
        if let Some(segments) = assembly.get("segments").and_then(Value::as_array) {
            lines.push("| Segment | Cache class | Prefix | Audit | Hash | Chars |".to_string());
            lines.push("| --- | --- | --- | --- | --- | ---: |".to_string());
            for segment in segments {
                let name = segment
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("segment");
                let cache_class = segment
                    .get("cacheClass")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let prefix = segment
                    .get("stablePrefix")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let audit = segment
                    .get("auditOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let hash = segment
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let chars = segment
                    .get("charLength")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                lines.push(format!(
                    "| `{name}` | `{cache_class}` | `{prefix}` | `{audit}` | `{hash}` | {chars} |"
                ));
            }
        } else {
            lines.push("```json".to_string());
            lines.push(
                serde_json::to_string_pretty(&redact_archive_value(assembly.clone()))
                    .unwrap_or_else(|_| "{}".to_string()),
            );
            lines.push("```".to_string());
        }
        lines.push(String::new());
        lines.push(format!(
            "- resourceFullTextCharCount: `{}`",
            assembly
                .get("resourceFullTextCharCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ));
        lines.push(format!(
            "- resourceSummaryCharCount: `{}`",
            assembly
                .get("resourceSummaryCharCount")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        ));
        if let Some(blocks) = assembly.get("resourceBlocks").and_then(Value::as_array) {
            lines.push(String::new());
            lines.push("| Resource block | Retention | Status | Hash | Chars | Volatile stripped |".to_string());
            lines.push("| --- | --- | --- | --- | ---: | --- |".to_string());
            for block in blocks {
                let block_key = block
                    .get("blockKey")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let display_ref = block
                    .get("displayRef")
                    .and_then(Value::as_str)
                    .unwrap_or("resource");
                let retention = block
                    .get("retention")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let status = block
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let content_hash = block
                    .get("contentHash")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                let chars = block
                    .get("charLength")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                let stripped = block
                    .get("volatileFieldStripped")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                lines.push(format!(
                    "| `{display_ref}`<br>`{block_key}` | `{retention}` | `{status}` | `{content_hash}` | {chars} | `{stripped}` |"
                ));
            }
        }
        lines.push(String::new());
    }
    lines.join("\n").trim_end().to_string()
}

fn archive_projection_entry_title(entry: &Value) -> &'static str {
    let payload = entry.get("payload").unwrap_or(&Value::Null);
    if payload.get("traceKind").and_then(Value::as_str).is_some()
        || payload.get("visibility").and_then(Value::as_str) == Some("trace")
    {
        return "Trace";
    }
    let kind = entry.get("kind").and_then(Value::as_str).unwrap_or("event");
    if kind == "assistant_msg"
        && matches!(
            payload.get("channel").and_then(Value::as_str),
            Some("reasoning" | "thinking" | "trace")
        )
    {
        return "Thinking";
    }
    archive_projection_title(kind)
}

fn archive_projection_title(kind: &str) -> &'static str {
    match kind {
        "user_msg" => "User",
        "assistant_msg" => "Agent",
        "workflow_stage" => "Workflow Stage",
        "workflow_decision" => "Workflow Decision",
        "plan_card" => "Plan",
        "plan_review" => "Plan Review",
        "resource_request" => "Resource Request",
        "tool_call" => "Tool Call",
        "tool_result" => "Tool Result",
        "permission_request" => "Permission Request",
        "permission_result" => "Permission Result",
        "error" => "Error",
        "trace" => "Trace",
        _ => "Event",
    }
}

fn archive_record_text(entry: &Value) -> String {
    entry
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(Value::as_str)
        .or_else(|| entry.get("content").and_then(Value::as_str))
        .or_else(|| {
            entry
                .get("payload")
                .and_then(|payload| payload.get("summary"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            format!(
                "```json\n{}\n```",
                serde_json::to_string_pretty(&redact_archive_value(entry.clone()))
                    .unwrap_or_else(|_| "{}".to_string())
            )
        })
}

fn projection_event_markdown(event: &Value) -> String {
    let kind = event.get("kind").and_then(Value::as_str).unwrap_or("event");
    let title = match kind {
        "user_msg" => "用户",
        "assistant_msg" => "Agent",
        "tool_call" => "工具调用",
        "tool_result" => "工具结果",
        "permission_request" => "权限请求",
        "permission_result" => "权限结果",
        "trace" => "推理摘要",
        _ => kind,
    };
    let content = event
        .get("payload")
        .and_then(|payload| payload.get("content"))
        .and_then(Value::as_str)
        .or_else(|| {
            event
                .get("payload")
                .and_then(|payload| payload.get("summary"))
                .and_then(Value::as_str)
        })
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(&redact_archive_value(event.clone()))
                .unwrap_or_else(|_| "{}".to_string())
        });
    format!("\n### {title}\n\n{content}\n")
}

fn transcript_entry_markdown(entry: &Value) -> String {
    let role = entry.get("role").and_then(Value::as_str).unwrap_or("entry");
    let channel = entry
        .get("channel")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let content = entry
        .get("content")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(&redact_archive_value(entry.clone()))
                .unwrap_or_else(|_| "{}".to_string())
        });
    format!("\n### {role} / {channel}\n\n{content}\n")
}

fn redact_archive_value(value: Value) -> Value {
    match value {
        Value::Object(object) => {
            let mut redacted = serde_json::Map::new();
            for (key, value) in object {
                if is_sensitive_archive_key(&key) {
                    redacted.insert(key, Value::String("[redacted]".to_string()));
                } else {
                    redacted.insert(key, redact_archive_value(value));
                }
            }
            Value::Object(redacted)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(redact_archive_value).collect()),
        other => other,
    }
}

fn is_sensitive_archive_key(key: &str) -> bool {
    let normalized = key.to_ascii_lowercase();
    [
        "secret",
        "apikey",
        "api_key",
        "authorization",
        "password",
        "bearer",
        "credential",
        "cookie",
        "token",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive_test_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("deepcode-{label}-{}", now_millis()))
    }

    #[test]
    fn conversation_archive_projection_and_transcript_create_exports() {
        let root = archive_test_root("conversation-archive");
        let session_id = "session/test";
        let session = json!({
            "id": session_id,
            "workspaceId": "wf/0",
            "workspaceHash": "hash:1"
        });
        let projection = json!({
            "kind": "user_msg",
            "payload": {
                "content": "测试归档",
                "kernelEvent": { "runId": "run/1" },
                "actionBundleDraft": { "version": "1" },
                "apiToken": "plain-secret-token"
            }
        });
        let transcript = json!({
            "role": "user",
            "channel": "user",
            "runId": "run/1",
            "content": "完整请求",
            "authorization": "Bearer abc"
        });
        let context_trace = json!({
            "type": "metadata",
            "role": "assistant",
            "channel": "trace",
            "runId": "run/1",
            "kind": "provider_trace",
            "payload": {
                "stage": "provider_call.request",
                "runId": "run/1",
                "payload": {
                    "contextAssembly": {
                        "schemaVersion": "deepcode.session.context-assembly.v2",
                        "contextAssemblyId": "context-generic",
                        "stablePrefixHash": "hash-stable",
                        "dynamicSuffixHash": "hash-dynamic",
                        "cacheHash": "hash-cache",
                        "resourceFullTextCharCount": 0,
                        "resourceSummaryCharCount": 42,
                        "segments": [{
                            "name": "protocolContract",
                            "cacheClass": "globalStable",
                            "stablePrefix": true,
                            "auditOnly": false,
                            "contentHash": "hash-segment",
                            "charLength": 42
                        }],
                        "resourceBlocks": [{
                            "blockKey": "resource-block-generic",
                            "displayRef": "generic/file.txt",
                            "retention": "summary",
                            "status": "resolved",
                            "contentHash": "hash-resource",
                            "charLength": 128,
                            "volatileFieldStripped": true
                        }]
                    }
                }
            }
        });
        let provider_error = json!({
            "kind": "error",
            "payload": {
                "summary": "ProviderJsonDecodeFailed:\n  provider = openaiCompatible\n  status = 200\n  content_type = text/html\n  is_stream = false\n  body_preview = <html>bad gateway</html>\n  expected_schema = openai.chat.completion.v1: choices[0].message",
                "runId": "run/1",
                "providerError": {
                    "reason": "ProviderJsonDecodeFailed",
                    "provider": "openaiCompatible",
                    "status": 200,
                    "contentType": "text/html",
                    "isStream": false,
                    "bodyPreview": "<html>bad gateway</html>",
                    "expectedSchema": "openai.chat.completion.v1: choices[0].message"
                }
            }
        });
        let reasoning = json!({
            "kind": "assistant_msg",
            "payload": {
                "channel": "reasoning",
                "content": "内部推理摘要",
                "runId": "run/1"
            }
        });
        let llm_trace = json!({
            "kind": "llm.requested",
            "payload": {
                "traceKind": "llm.requested",
                "visibility": "trace",
                "runId": "run/1",
                "llmCallId": "llm-run-1",
                "requestEnvelope": {
                    "messages": [
                        {
                            "role": "user",
                            "content": "读取上下文"
                        }
                    ]
                }
            }
        });

        append_conversation_archive_projection(&root, session_id, Some(&session), &[projection])
            .expect("projection archive append");
        append_conversation_archive_projection(
            &root,
            session_id,
            Some(&session),
            &[provider_error, reasoning, llm_trace],
        )
        .expect("provider error projection archive append");
        append_conversation_archive_transcript(
            &root,
            session_id,
            Some(&session),
            &[transcript, context_trace],
        )
        .expect("transcript archive append");

        let archive_dir = root
            .join("workspace-wf_0-hash_1")
            .join("session_test")
            .join("run_1");
        assert!(archive_dir.join("manifest.json").exists());
        assert!(archive_dir.join("projection.jsonl").exists());
        assert!(archive_dir.join("transcript.jsonl").exists());
        assert!(archive_dir
            .join("debug")
            .join("projection-events.jsonl")
            .exists());
        assert!(archive_dir
            .join("debug")
            .join("transcript-events.jsonl")
            .exists());
        assert!(archive_dir
            .join("debug")
            .join("action-bundle-drafts.jsonl")
            .exists());
        assert!(archive_dir
            .join("debug")
            .join("llm-provider-errors.jsonl")
            .exists());
        assert!(archive_dir
            .join("debug")
            .join("trace-events.jsonl")
            .exists());
        assert!(archive_dir
            .join("debug")
            .join("llm-exchanges.jsonl")
            .exists());
        assert!(archive_dir
            .join("debug")
            .join("context-assemblies.jsonl")
            .exists());
        assert!(archive_dir.join("exports").join("complete.md").exists());
        assert!(archive_dir.join("exports").join("debug.json").exists());
        assert!(archive_dir
            .join("exports")
            .join("context-assemblies.md")
            .exists());
        let session_archive_dir = root
            .join("workspace-wf_0-hash_1")
            .join("session_test")
            .join("session");
        assert!(session_archive_dir
            .join("exports")
            .join("chronological.md")
            .exists());
        assert!(session_archive_dir
            .join("exports")
            .join("chronological-debug.json")
            .exists());

        let projection_content =
            fs::read_to_string(archive_dir.join("projection.jsonl")).expect("projection jsonl");
        let transcript_content =
            fs::read_to_string(archive_dir.join("transcript.jsonl")).expect("transcript jsonl");
        assert!(projection_content.contains("[redacted]"));
        assert!(!projection_content.contains("plain-secret-token"));
        assert!(transcript_content.contains("[redacted]"));
        assert!(!transcript_content.contains("Bearer abc"));

        let manifests = read_conversation_archive_manifests(&root, session_id);
        assert_eq!(manifests.len(), 2);
        let run_manifest = manifests
            .iter()
            .find(|manifest| manifest.get("runId").and_then(Value::as_str) == Some("run/1"))
            .expect("run archive manifest");
        let files = run_manifest
            .get("files")
            .and_then(Value::as_array)
            .expect("manifest files");
        assert!(files
            .iter()
            .any(|file| { file.get("path").and_then(Value::as_str) == Some("projection.jsonl") }));
        assert!(files.iter().any(|file| {
            file.get("path").and_then(Value::as_str) == Some("exports/complete.md")
        }));
        assert!(files.iter().any(|file| {
            file.get("path").and_then(Value::as_str) == Some("debug/action-bundle-drafts.jsonl")
        }));
        assert!(files.iter().any(|file| {
            file.get("path").and_then(Value::as_str) == Some("debug/llm-provider-errors.jsonl")
        }));
        assert!(files.iter().any(|file| {
            file.get("path").and_then(Value::as_str) == Some("debug/context-assemblies.jsonl")
        }));
        let context_export =
            fs::read_to_string(archive_dir.join("exports").join("context-assemblies.md"))
                .expect("context assemblies markdown");
        assert!(context_export.contains("context-generic"));
        assert!(context_export.contains("globalStable"));
        assert!(context_export.contains("resource-block-generic"));
        assert!(context_export.contains("resourceSummaryCharCount"));
        let chronological =
            fs::read_to_string(session_archive_dir.join("exports").join("chronological.md"))
                .expect("chronological markdown");
        assert!(chronological.contains("DeepCode Chronological Conversation"));
        assert!(chronological.contains("测试归档"));
        assert!(chronological.contains("完整请求"));
        assert!(chronological.contains("ProviderJsonDecodeFailed:"));
        assert!(chronological.contains("expected_schema = openai.chat.completion.v1"));
        assert!(chronological.contains("Projection / Thinking / run/1"));
        assert!(chronological.contains("Projection / Trace / run/1"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn conversation_archive_uses_unbound_workspace_without_session_metadata() {
        let root = archive_test_root("conversation-unbound");
        append_conversation_archive_projection(
            &root,
            "session without metadata",
            None,
            &[json!({
                "kind": "assistant_msg",
                "payload": { "content": "hello", "runId": "run alpha" }
            })],
        )
        .expect("projection archive append");

        let archive_dir = root
            .join("unbound-workspace")
            .join("session_without_metadata")
            .join("run_alpha");
        assert!(archive_dir.join("manifest.json").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn restore_session_index_uses_archive_manifest_and_projection_fallback() {
        let root = archive_test_root("session-restore");
        let sessions_dir = root.join("sessions");
        let archive_root = root.join("conversation-archives");
        let paths = HostPaths {
            settings_path: root.join("settings.json"),
            llm_profiles_path: root.join("profiles.json"),
            llm_secrets_path: root.join("secrets.json"),
            workflow_config_path: root.join("workflow.json"),
            sessions_dir: sessions_dir.clone(),
            conversation_archives_dir: archive_root.clone(),
        };

        let archived_session_id = "session-12345";
        let archived_session = create_agent_session_value(
            archived_session_id,
            "12345",
            "New Agent Session",
            "plan",
            None,
            Some("ws/1"),
            Some("hash/1"),
        );
        let archived_user = json!({
            "id": "evt-user-1",
            "sessionId": archived_session_id,
            "ts": "12346",
            "kind": "user_msg",
            "payload": { "content": "恢复历史对话标题", "runId": "run-1" }
        });
        let archived_answer = json!({
            "id": "evt-assistant-1",
            "sessionId": archived_session_id,
            "ts": "12347",
            "kind": "assistant_msg",
            "payload": { "content": "ok", "runId": "run-1" }
        });
        append_session_projection_jsonl(
            &sessions_dir,
            archived_session_id,
            &[archived_user.clone(), archived_answer],
        )
        .expect("archived projection jsonl");
        append_conversation_archive_projection(
            &archive_root,
            archived_session_id,
            Some(&archived_session),
            &[archived_user],
        )
        .expect("archived conversation manifest");

        let fallback_session_id = "session-99999";
        append_session_projection_jsonl(
            &sessions_dir,
            fallback_session_id,
            &[json!({
                "id": "evt-user-2",
                "sessionId": fallback_session_id,
                "ts": "99999",
                "kind": "user_msg",
                "payload": { "content": "只有 projection 的会话" }
            })],
        )
        .expect("fallback projection jsonl");

        let restored = restore_session_index(&paths);
        assert_eq!(restored.len(), 2);
        let archived = restored
            .iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(archived_session_id))
            .expect("archived session restored");
        assert_eq!(archived.get("eventCount").and_then(Value::as_u64), Some(2));
        assert_eq!(
            archived.get("title").and_then(Value::as_str),
            Some("恢复历史对话标题")
        );
        assert_eq!(
            archived.get("workspaceScopeKey").and_then(Value::as_str),
            Some("workspace-ws_1-hash_1")
        );

        let fallback = restored
            .iter()
            .find(|session| session.get("id").and_then(Value::as_str) == Some(fallback_session_id))
            .expect("projection-only session restored");
        assert_eq!(fallback.get("eventCount").and_then(Value::as_u64), Some(1));
        assert_eq!(
            fallback.get("title").and_then(Value::as_str),
            Some("只有 projection 的会话")
        );
        assert_eq!(
            fallback.get("workspaceScopeKey").and_then(Value::as_str),
            Some("unbound-workspace")
        );

        let current_by_scope = restored_current_session_ids_by_scope(&restored);
        assert_eq!(
            current_by_scope
                .get("workspace-ws_1-hash_1")
                .map(String::as_str),
            Some(archived_session_id)
        );
        assert_eq!(
            current_by_scope
                .get("unbound-workspace")
                .map(String::as_str),
            Some(fallback_session_id)
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn append_session_projection_hydrates_restored_history_before_append() {
        let root = archive_test_root("projection-hydrate");
        let sessions_dir = root.join("sessions");
        let archive_root = root.join("conversation-archives");
        let session_id = "session-123456";
        let paths = HostPaths {
            settings_path: root.join("settings.json"),
            llm_profiles_path: root.join("profiles.json"),
            llm_secrets_path: root.join("secrets.json"),
            workflow_config_path: root.join("workflow.json"),
            sessions_dir: sessions_dir.clone(),
            conversation_archives_dir: archive_root,
        };
        let historical_event = json!({
            "id": "evt-history",
            "sessionId": session_id,
            "ts": "1",
            "kind": "user_msg",
            "payload": { "content": "历史问题" }
        });
        let appended_event = json!({
            "id": "evt-next",
            "sessionId": session_id,
            "ts": "2",
            "kind": "user_msg",
            "payload": { "content": "继续追问" }
        });
        append_session_projection_jsonl(&sessions_dir, session_id, &[historical_event.clone()])
            .expect("historical projection");

        let session = create_agent_session_value(
            session_id,
            "1",
            "历史问题",
            "plan",
            None,
            Some("ws"),
            Some("hash"),
        );
        let state = AppState {
            runtime: Arc::new(Mutex::new(DeepCodeKernelRuntime::new())),
            gui: Arc::new(Mutex::new(GuiState {
                paths,
                user_settings: json!({}),
                llm_profiles: json!({}),
                workflow_config: json!({}),
                sessions: vec![session],
                current_session_id: Some(session_id.to_string()),
                current_session_ids_by_scope: HashMap::new(),
                session_projection_cache: HashMap::new(),
                trace_events: HashMap::new(),
                browser: BrowserState::default(),
            })),
            terminal_runtime: Arc::new(Mutex::new(crate::terminal_api::TerminalRuntime::new())),
            kernel_events: Arc::new(Mutex::new(Vec::new())),
            session_runs: Arc::new(Mutex::new(HashMap::new())),
            session_run_deltas: Arc::new(Mutex::new(HashMap::new())),
        };

        append_session_projection(&state, session_id, vec![appended_event.clone()]);
        let stored = session_projection(&state, session_id);
        assert_eq!(stored.len(), 2);
        assert_eq!(stored[0], historical_event);
        assert_eq!(stored[1], appended_event);
        let event_count = state
            .gui
            .lock()
            .expect("gui lock")
            .sessions
            .first()
            .and_then(|session| session.get("eventCount"))
            .and_then(Value::as_u64);
        assert_eq!(event_count, Some(2));

        let _ = fs::remove_dir_all(root);
    }
}
