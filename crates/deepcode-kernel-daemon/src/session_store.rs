#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

const ARCHIVE_DEBUG_STREAMS: &[&str] = &[
    "parser-results.jsonl",
    "agent-plan-parts.jsonl",
    "action-bundle-drafts.jsonl",
    "draft-task-queues.jsonl",
    "plan-review-reports.jsonl",
    "resource-packets.jsonl",
    "review-packets.jsonl",
    "permission-tool-facts.jsonl",
];

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
    let (sessions_dir, archive_root, session) = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.session_projection_cache
            .entry(session_id.to_string())
            .or_default()
            .extend(events.clone());
        update_session_event_count(&mut gui, session_id);
        (
            gui.paths.sessions_dir.clone(),
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
            "transcript": transcript
        }),
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

fn session_metadata(sessions: &[Value], session_id: &str) -> Option<Value> {
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
            "channel": "prompt",
            "runId": "run/1",
            "content": "完整请求",
            "authorization": "Bearer abc"
        });

        append_conversation_archive_projection(&root, session_id, Some(&session), &[projection])
            .expect("projection archive append");
        append_conversation_archive_transcript(&root, session_id, Some(&session), &[transcript])
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
        assert!(archive_dir.join("exports").join("complete.md").exists());
        assert!(archive_dir.join("exports").join("debug.json").exists());

        let projection_content =
            fs::read_to_string(archive_dir.join("projection.jsonl")).expect("projection jsonl");
        let transcript_content =
            fs::read_to_string(archive_dir.join("transcript.jsonl")).expect("transcript jsonl");
        assert!(projection_content.contains("[redacted]"));
        assert!(!projection_content.contains("plain-secret-token"));
        assert!(transcript_content.contains("[redacted]"));
        assert!(!transcript_content.contains("Bearer abc"));

        let manifests = read_conversation_archive_manifests(&root, session_id);
        assert_eq!(manifests.len(), 1);
        let files = manifests[0]
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
}
