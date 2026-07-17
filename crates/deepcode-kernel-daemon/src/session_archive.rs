use crate::prelude::*;
use crate::*;

pub(crate) fn read_archived_session_metadata(archive_root: &FsPath) -> Vec<Value> {
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

pub(crate) fn projection_session_ids(sessions_dir: &FsPath) -> Vec<String> {
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

pub(crate) fn normalize_restored_session(
    session: &mut Value,
    session_id: &str,
    sessions_dir: &FsPath,
) {
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
    session["schemaCompatible"] = json!(session_schema_is_compatible(session));
    if !session_schema_is_compatible(session) {
        session["schemaError"] = json!("session_schema_incompatible");
    }

    if session
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        session["mode"] = json!("plan");
    }
    if session.get("profileId").is_none() {
        session["profileId"] = Value::Null;
    }
    if session.get("workspaceId").is_none() {
        session["workspaceId"] = Value::Null;
    }
    if session.get("workspaceHash").is_none() {
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

pub(crate) fn timestamp_from_session_id(session_id: &str) -> Option<String> {
    session_id
        .strip_prefix("session-")
        .filter(|value| value.chars().all(|ch| ch.is_ascii_digit()))
        .map(ToOwned::to_owned)
}

pub(crate) fn session_sort_key(session: &Value) -> String {
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

pub(crate) fn append_conversation_archive_entries(
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
        "kernelAbiVersion": deepcode_kernel_runtime::KERNEL_ABI_VERSION,
        "agentProtocolVersion": deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION,
        "toolCatalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
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
        "kernelAbiVersion": deepcode_kernel_runtime::KERNEL_ABI_VERSION,
        "agentProtocolVersion": deepcode_kernel_runtime::AGENT_PROTOCOL_VERSION,
        "toolCatalogVersion": deepcode_kernel_runtime::TOOL_CATALOG_VERSION,
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
            let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
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

pub(crate) fn read_conversation_archive_manifests(
    archive_root: &FsPath,
    session_id: &str,
) -> Vec<Value> {
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

pub(crate) fn select_archive_manifest(
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

pub(crate) fn safe_archive_relative_path(path: &str) -> Option<PathBuf> {
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
