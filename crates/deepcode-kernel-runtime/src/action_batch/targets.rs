use super::compiler::{operation_kind_name, NormalizedWorkspacePath};
use super::*;

pub(super) fn git_paths_arguments_from_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    git: &GitOperation,
) -> KernelResult<Value> {
    if git.paths.is_empty() {
        return Err(KernelError::InvalidCommand(format!(
            "git {} action {} requires at least one path",
            operation_kind_name(operation),
            operation.id
        )));
    }
    let paths = git
        .paths
        .iter()
        .map(|path| git_relative_path(runtime, record, path))
        .collect::<KernelResult<Vec<_>>>()?;
    Ok(serde_json::json!({ "paths": paths }))
}

pub(super) fn git_workspace_root(
    _runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
) -> Option<PathBuf> {
    if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
        return Some(PathBuf::from(open_path));
    }
    let roots = record
        .attachments
        .iter()
        .filter(|attachment| attachment.get("kind").and_then(Value::as_str) == Some("directory"))
        .filter_map(explicit_attachment_root)
        .collect::<Vec<_>>();
    if roots.len() == 1 {
        roots.into_iter().next()
    } else {
        None
    }
}

pub(super) fn git_relative_path(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<String> {
    if raw_path.trim() == "." {
        return Ok(".".to_string());
    }
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(normalized.relative_path)
}

pub(crate) fn workspace_relative_read_path(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<NormalizedWorkspacePath> {
    let raw_path = raw_path.trim();
    if raw_path == "." || raw_path == "./" {
        return Ok(NormalizedWorkspacePath {
            relative_path: ".".to_string(),
            workspace_root: git_workspace_root(runtime, record),
            root_source: Some("workspace"),
            stripped_prefixes: Vec::new(),
            duplicate_root_path_detected: false,
            original_path: raw_path.to_string(),
        });
    }
    workspace_relative_write_path(runtime, record, raw_path).map_err(|error| match error {
        KernelError::InvalidCommand(message) => {
            KernelError::InvalidCommand(message.replace("Kernel mutation", "workspace read"))
        }
        KernelError::PermissionDenied(message) => {
            KernelError::PermissionDenied(message.replace("Kernel mutation", "workspace read"))
        }
        other => other,
    })
}

pub(crate) fn workspace_relative_write_path(
    _runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<NormalizedWorkspacePath> {
    let raw_path = raw_path.trim();
    let path = Path::new(raw_path);
    if path.is_absolute() {
        return Err(KernelError::InvalidCommand(
            "Agent tool targets must use a root-relative path; absolute paths are not accepted"
                .to_string(),
        ));
    }
    if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
        return Ok(NormalizedWorkspacePath {
            relative_path: normalize_write_relative_path(raw_path)?,
            workspace_root: Some(PathBuf::from(open_path)),
            root_source: Some("workspaceBinding"),
            stripped_prefixes: Vec::new(),
            duplicate_root_path_detected: false,
            original_path: raw_path.to_string(),
        });
    }
    if let Some((root, normalized)) = single_directory_attachment_write_target(record, raw_path)? {
        return Ok(NormalizedWorkspacePath {
            workspace_root: Some(root),
            root_source: Some("attachment"),
            ..normalized
        });
    }
    if has_explicit_attachment_roots(record) {
        return relative_file_attachment_write_target(record, raw_path);
    }
    Ok(NormalizedWorkspacePath {
        relative_path: normalize_write_relative_path(raw_path)?,
        workspace_root: None,
        root_source: None,
        stripped_prefixes: Vec::new(),
        duplicate_root_path_detected: false,
        original_path: raw_path.to_string(),
    })
}

pub(super) fn strip_root(target: &Path, root: &Path) -> Option<String> {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    if !target.starts_with(&root) {
        return None;
    }
    let relative = target.strip_prefix(root).ok()?;
    let value = relative.to_string_lossy().replace('\\', "/");
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

pub(super) fn has_explicit_attachment_roots(record: &RuntimeRunRecord) -> bool {
    record
        .attachments
        .iter()
        .any(|attachment| explicit_attachment_root(attachment).is_some())
}

pub(super) fn single_directory_attachment_write_target(
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<Option<(PathBuf, NormalizedWorkspacePath)>> {
    let mut roots = Vec::new();
    for (index, attachment) in record
        .attachments
        .iter()
        .enumerate()
        .filter(|(_, attachment)| {
            attachment.get("kind").and_then(Value::as_str) == Some("directory")
        })
    {
        let Some(root) = explicit_attachment_root(attachment) else {
            continue;
        };
        roots.push((root, attachment_prefix_candidates(attachment, index)?));
    }
    if roots.len() == 1 {
        let (root, prefixes) = roots.into_iter().next().expect("single root");
        return Ok(Some((
            root,
            normalize_attachment_relative_write_path(raw_path, &prefixes)?,
        )));
    }
    if roots.is_empty() {
        Ok(None)
    } else {
        Err(KernelError::InvalidCommand(
            "Kernel mutation has a relative path but multiple attachment roots are available"
                .to_string(),
        ))
    }
}

pub(super) fn relative_file_attachment_write_target(
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<NormalizedWorkspacePath> {
    let normalized = normalize_write_relative_path(raw_path)?;
    for (index, attachment) in record
        .attachments
        .iter()
        .enumerate()
        .filter(|(_, attachment)| attachment.get("kind").and_then(Value::as_str) == Some("file"))
    {
        let Some(root) = explicit_attachment_root(attachment) else {
            continue;
        };
        let Some(write_root) = root.parent().map(Path::to_path_buf) else {
            continue;
        };
        let Some(relative) = strip_root(&root, &write_root) else {
            continue;
        };
        let mut candidates = attachment_prefix_candidates(attachment, index)?;
        candidates.push(relative.clone());
        if candidates.iter().any(|candidate| candidate == &normalized) {
            return Ok(NormalizedWorkspacePath {
                relative_path: relative,
                workspace_root: Some(write_root),
                root_source: Some("attachment"),
                stripped_prefixes: Vec::new(),
                duplicate_root_path_detected: false,
                original_path: raw_path.to_string(),
            });
        }
    }
    Err(KernelError::PermissionDenied(format!(
        "Kernel mutation target is outside workspace binding and explicit attachments: {raw_path}"
    )))
}

pub(super) fn normalize_attachment_relative_write_path(
    raw_path: &str,
    prefixes: &[String],
) -> KernelResult<NormalizedWorkspacePath> {
    let mut normalized = normalize_write_relative_path(raw_path)?;
    let mut stripped_prefixes = Vec::new();
    for _ in 0..4 {
        let mut changed = false;
        for prefix in prefixes {
            if prefix.trim().is_empty() {
                continue;
            }
            if normalized == *prefix {
                stripped_prefixes.push(prefix.clone());
                return Err(KernelError::InvalidCommand(
                    "Kernel mutation target resolves to an attachment directory, not a file"
                        .to_string(),
                ));
            }
            if let Some(relative) = normalized.strip_prefix(&format!("{prefix}/")) {
                stripped_prefixes.push(prefix.clone());
                normalized = normalize_write_relative_path(relative)?;
                changed = true;
                break;
            }
        }
        if !changed {
            break;
        }
    }
    if normalized.is_empty() || normalized == "." {
        return Err(KernelError::InvalidCommand(
            "Kernel mutation target resolves to an attachment directory, not a file".to_string(),
        ));
    }
    Ok(NormalizedWorkspacePath {
        relative_path: normalized,
        workspace_root: None,
        root_source: Some("attachment"),
        duplicate_root_path_detected: stripped_prefixes.len() > 1,
        stripped_prefixes,
        original_path: raw_path.to_string(),
    })
}

pub(super) fn attachment_prefix_candidates(
    attachment: &Value,
    index: usize,
) -> KernelResult<Vec<String>> {
    let mut prefixes = Vec::new();
    if let Some(root_id) = attachment.get("rootId").and_then(Value::as_str) {
        push_attachment_prefix(&mut prefixes, root_id)?;
    }
    if let Some(path) = attachment.get("path").and_then(Value::as_str) {
        push_attachment_prefix(&mut prefixes, path)?;
        if let Some(base) = path_basename(path) {
            push_attachment_prefix(&mut prefixes, &base)?;
        }
        push_attachment_prefix(
            &mut prefixes,
            &manifest_like_attachment_id(index, path, "attachment"),
        )?;
        push_attachment_prefix(
            &mut prefixes,
            &manifest_like_attachment_id(index, path, "recent-attachment"),
        )?;
    }
    if let Some(absolute_path) = attachment.get("absolutePath").and_then(Value::as_str) {
        push_attachment_prefix(&mut prefixes, absolute_path)?;
        if let Some(base) = path_basename(absolute_path) {
            push_attachment_prefix(&mut prefixes, &base)?;
        }
    }
    Ok(prefixes)
}

pub(super) fn push_attachment_prefix(prefixes: &mut Vec<String>, value: &str) -> KernelResult<()> {
    let trimmed = value.trim().replace('\\', "/");
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(());
    }
    match normalize_write_relative_path(value) {
        Ok(normalized) => push_normalized_prefix(prefixes, &normalized),
        Err(KernelError::Structured {
            code: "mutation_target_absolute",
            ..
        }) => Ok(()),
        Err(error) => Err(error),
    }
}

pub(super) fn push_normalized_prefix(prefixes: &mut Vec<String>, value: &str) -> KernelResult<()> {
    let normalized = normalize_write_relative_path(value)?;
    if normalized == "." || prefixes.iter().any(|item| item == &normalized) {
        return Ok(());
    }
    prefixes.push(normalized);
    Ok(())
}

pub(super) fn manifest_like_attachment_id(index: usize, path: &str, prefix: &str) -> String {
    let base = path
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-' | '/') {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .chars()
        .take(96)
        .collect::<String>();
    format!(
        "{prefix}-{index}-{}",
        if base.is_empty() { "resource" } else { &base }
    )
}

pub(super) fn path_basename(path: &str) -> Option<String> {
    let normalized = path
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    normalized
        .split('/')
        .next_back()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

pub(super) fn path_normalization_json(path: &NormalizedWorkspacePath) -> Value {
    serde_json::json!({
        "originalPath": path.original_path,
        "normalizedTargetPath": path.relative_path,
        "rootSource": path.root_source,
        "strippedPathPrefixes": path.stripped_prefixes,
        "duplicateRootPathDetected": path.duplicate_root_path_detected
    })
}

pub(crate) fn attach_kernel_context_to_arguments(
    arguments: &mut Value,
    plan_id: &str,
    work_unit_id: &str,
    action_id: &str,
    operation_kind: &str,
) {
    if let Some(object) = arguments.as_object_mut() {
        object.insert(
            "kernelContext".to_string(),
            serde_json::json!({
                "planId": plan_id,
                "workUnitId": work_unit_id,
                "actionId": action_id,
                "operationKind": operation_kind
            }),
        );
    }
}

pub(super) fn normalize_write_relative_path(raw_path: &str) -> KernelResult<String> {
    let normalized = raw_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(KernelError::Structured {
            code: "mutation_target_empty",
            stage: "admission",
            message: "Kernel mutation target path is empty".to_string(),
            details: serde_json::json!({ "classification": "invalid_mutation_target" }),
        });
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err(absolute_mutation_target(raw_path));
    }

    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                let value = value.to_string_lossy();
                if !value.is_empty() {
                    parts.push(value.to_string());
                }
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                return Err(KernelError::PermissionDenied(format!(
                    "Kernel mutation target cannot contain parent traversal: {raw_path}"
                )));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(absolute_mutation_target(raw_path));
            }
        }
    }
    if parts.is_empty() {
        return Err(KernelError::Structured {
            code: "mutation_target_empty",
            stage: "admission",
            message: "Kernel mutation target path is empty".to_string(),
            details: serde_json::json!({ "classification": "invalid_mutation_target" }),
        });
    }
    Ok(parts.join("/"))
}

fn absolute_mutation_target(raw_path: &str) -> KernelError {
    KernelError::Structured {
        code: "mutation_target_absolute",
        stage: "admission",
        message: format!("Kernel mutation target must be relative: {raw_path}"),
        details: serde_json::json!({ "classification": "invalid_mutation_target" }),
    }
}

pub(crate) fn explicit_attachment_root(attachment: &Value) -> Option<PathBuf> {
    let source = attachment
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(source, "userSelected" | "contextMenu" | "mention") {
        return None;
    }
    attachment
        .get("absolutePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|path| PathBuf::from(path).canonicalize().ok())
}
