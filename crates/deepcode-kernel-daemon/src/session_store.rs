#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

pub(crate) async fn session_store_index(State(state): State<AppState>) -> Json<ApiResponse> {
    let gui = state.gui.lock().expect("gui state lock");
    ApiResponse::ok(json!({
        "sessions": gui.sessions,
        "storeRoot": gui.paths.sessions_dir.to_string_lossy()
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
    let entry = body.get("entry").cloned().unwrap_or(body);
    let sessions_dir = state
        .gui
        .lock()
        .expect("gui state lock")
        .paths
        .sessions_dir
        .clone();
    match append_session_jsonl(&sessions_dir, &session_id, "transcript.jsonl", &[entry]) {
        Ok(()) => {
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
    let sessions_dir = {
        let mut gui = state.gui.lock().expect("gui state lock");
        gui.session_projection_cache
            .entry(session_id.to_string())
            .or_default()
            .extend(events.clone());
        update_session_event_count(&mut gui, session_id);
        gui.paths.sessions_dir.clone()
    };
    if let Err(error) = append_session_projection_jsonl(&sessions_dir, session_id, &events) {
        eprintln!("failed to append session projection: {error}");
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
