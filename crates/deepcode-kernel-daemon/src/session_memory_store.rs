use crate::prelude::*;
use crate::*;

pub(crate) fn session_metadata(sessions: &[Value], session_id: &str) -> Option<Value> {
    sessions
        .iter()
        .find(|session| session.get("id").and_then(Value::as_str) == Some(session_id))
        .cloned()
}

pub(crate) fn conversation_archive_dir(
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

pub(crate) fn memory_archive_dir(memory_root: &FsPath, session: Option<&Value>) -> PathBuf {
    memory_root.join(workspace_scope_key(session))
}

pub(crate) fn workspace_scope_key(session: Option<&Value>) -> String {
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

pub(crate) fn write_session_memory_archive(
    memory_root: &FsPath,
    session_id: &str,
    session: Option<&Value>,
    body: &Value,
) -> std::io::Result<Value> {
    let snapshot = body.get("snapshot").unwrap_or(body);
    let metadata = snapshot.get("metadata").unwrap_or(snapshot);
    let project_markdown = metadata
        .get("projectMarkdownPreview")
        .or_else(|| body.get("projectMarkdown"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "projectMarkdownPreview is required",
            )
        })?;
    let session_markdown = metadata
        .get("sessionMarkdownPreview")
        .or_else(|| body.get("sessionMarkdown"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "sessionMarkdownPreview is required",
            )
        })?;
    let descriptor = metadata
        .get("archiveDescriptor")
        .cloned()
        .or_else(|| {
            metadata
                .get("archiveSidecar")
                .and_then(|sidecar| sidecar.get("descriptor"))
                .cloned()
        })
        .unwrap_or_else(|| json!({}));
    let sidecar = metadata
        .get("archiveSidecar")
        .cloned()
        .or_else(|| body.get("archiveSidecar").cloned())
        .unwrap_or_else(|| json!({}));

    let archive_dir = memory_archive_dir(memory_root, session);
    let session_archive_dir = archive_dir.join("sessions");
    let safe_session = safe_path_segment(session_id);
    let project_markdown_path = archive_dir.join("project.md");
    let project_sidecar_path = archive_dir.join("project.memory.json");
    let session_markdown_path = session_archive_dir.join(format!("{safe_session}.md"));
    let session_sidecar_path = session_archive_dir.join(format!("{safe_session}.memory.json"));
    let manifest_path = archive_dir.join("manifest.json");

    let project_sidecar = scoped_memory_sidecar(&sidecar, "project");
    let session_sidecar = scoped_memory_sidecar(&sidecar, "session");
    atomic_write_text_file(&project_markdown_path, project_markdown)?;
    atomic_write_json_file(&project_sidecar_path, &project_sidecar)?;
    atomic_write_text_file(&session_markdown_path, session_markdown)?;
    atomic_write_json_file(&session_sidecar_path, &session_sidecar)?;

    let manifest = json!({
        "schemaVersion": "deepcode.session.memory-archive-manifest.v1",
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session),
        "archivePath": archive_dir.to_string_lossy(),
        "generatedAt": now_text(),
        "descriptor": descriptor,
        "files": {
            "projectMarkdown": project_markdown_path.to_string_lossy(),
            "projectSidecar": project_sidecar_path.to_string_lossy(),
            "sessionMarkdown": session_markdown_path.to_string_lossy(),
            "sessionSidecar": session_sidecar_path.to_string_lossy()
        }
    });
    atomic_write_json_file(&manifest_path, &manifest)?;

    Ok(json!({
        "sessionId": session_id,
        "workspaceScopeKey": workspace_scope_key(session),
        "memoryArchiveRoot": memory_root.to_string_lossy(),
        "archivePath": archive_dir.to_string_lossy(),
        "manifest": manifest,
        "files": {
            "projectMarkdown": project_markdown_path.to_string_lossy(),
            "projectSidecar": project_sidecar_path.to_string_lossy(),
            "sessionMarkdown": session_markdown_path.to_string_lossy(),
            "sessionSidecar": session_sidecar_path.to_string_lossy(),
            "manifest": manifest_path.to_string_lossy()
        }
    }))
}

fn scoped_memory_sidecar(sidecar: &Value, scope: &str) -> Value {
    let mut value = sidecar.clone();
    if let Value::Object(object) = &mut value {
        object.insert("memoryScope".to_string(), json!(scope));
    }
    value
}

pub(crate) fn extract_run_id(value: &Value) -> Option<String> {
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
