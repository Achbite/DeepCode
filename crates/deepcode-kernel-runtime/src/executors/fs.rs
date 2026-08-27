use super::*;

pub(super) struct FsListExecutor;
pub(super) struct FsReadExecutor;
pub(super) struct FsDiffExecutor;
pub(super) struct FsCreateExecutor;
pub(super) struct FsWriteExecutor;
pub(super) struct FsEditExecutor;
pub(super) struct FsDeleteExecutor;
pub(super) struct FsEnsureDirectoryExecutor;

impl KernelToolExecutor for FsListExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let root = workspace_root(&context)?;
        let relative = get_string(&invocation.input, "path").unwrap_or_else(|| ".".to_string());
        let target = prepared_workspace_target(&context)?;
        let depth = invocation
            .input
            .get("depth")
            .and_then(Value::as_u64)
            .unwrap_or(2)
            .clamp(1, 16) as u32;
        let include_hidden = invocation
            .input
            .get("includeHidden")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&relative),
                "nodes": list_nodes(&target, &root, depth, include_hidden)?
            }),
        ))
    }
}

impl KernelToolExecutor for FsReadExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = prepared_workspace_target(&context)?;
        if !target.is_file() {
            return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
        }
        let read = read_text_file_for_llm(&target).map_err(|skip| {
            KernelError::InvalidCommand(format!(
                "unsupported_file_content: {} ({})",
                skip.message, skip.reason
            ))
        })?;
        let full_content = read.content;
        let start_line = invocation
            .input
            .get("startLine")
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize;
        let end_line = invocation
            .input
            .get("endLine")
            .and_then(Value::as_u64)
            .map(|value| value as usize);
        if start_line == 0 || end_line.is_some_and(|end| end < start_line) {
            return Err(KernelError::InvalidCommand(
                "fs.read requires 1-based startLine <= endLine".to_string(),
            ));
        }
        let lines = full_content.lines().collect::<Vec<_>>();
        let content = if start_line == 1 && end_line.is_none() {
            full_content.clone()
        } else {
            let start = start_line.saturating_sub(1).min(lines.len());
            let end = end_line.unwrap_or(lines.len()).min(lines.len());
            lines[start..end].join("\n")
        };
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "content": content,
                "sizeBytes": content.len(),
                "fileSizeBytes": full_content.len(),
                "startLine": start_line,
                "endLine": end_line.unwrap_or(lines.len()),
                "contentHash": deepcode_kernel_tools::hash_bytes(full_content.as_bytes()),
                "binary": false,
                "fileClassification": read.classification
            }),
        ))
    }
}

impl KernelToolExecutor for FsCreateExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = prepared_workspace_target(&context)?;
        if target.exists() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.create target already exists: {path}"
            )));
        }
        let parent = target.parent().ok_or_else(|| {
            KernelError::InvalidCommand(format!("fs.create target has no parent: {path}"))
        })?;
        if !parent.is_dir() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.create parent directory does not exist: {}",
                parent.display()
            )));
        }
        let content = get_string_allow_empty(&invocation.input, "content").unwrap_or_default();
        let executable = invocation
            .input
            .get("executable")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        atomic_create_text(&target, &content, executable)?;
        let mode = file_mode(&target)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "created": true,
                "sizeBytes": content.len(),
                "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes()),
                "mode": mode,
                "executable": mode.is_some_and(|value| value & 0o111 != 0)
            }),
        ))
    }
}

impl KernelToolExecutor for FsWriteExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = prepared_workspace_target(&context)?;
        if !target.is_file() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.write requires an existing file: {path}"
            )));
        }
        let content = get_string_allow_empty(&invocation.input, "content").unwrap_or_default();
        atomic_write_text(&target, &content)?;
        let mode = file_mode(&target)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "saved": true,
                "sizeBytes": content.len(),
                "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes()),
                "mode": mode,
                "executable": mode.is_some_and(|value| value & 0o111 != 0)
            }),
        ))
    }
}

impl KernelToolExecutor for FsEditExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = prepared_workspace_target(&context)?;
        if !target.is_file() {
            return Err(KernelError::InvalidCommand(format!("{path} is not a file")));
        }
        let original = read_text_file_for_llm(&target)
            .map_err(|skip| {
                KernelError::InvalidCommand(format!(
                    "unsupported_file_content: {} ({})",
                    skip.message, skip.reason
                ))
            })?
            .content;
        let replacement = get_string(&invocation.input, "replacement").unwrap_or_default();
        let patch_spec = invocation
            .input
            .get("patchSpec")
            .ok_or_else(|| KernelError::InvalidCommand("fs.edit requires patchSpec".to_string()))?;
        let patch = apply_text_patch(&original, &replacement, patch_spec)?;
        atomic_write_text(&target, &patch.updated)?;
        let mode = file_mode(&target)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "patched": true,
                "oldContentHash": deepcode_kernel_tools::hash_bytes(original.as_bytes()),
                "newContentHash": deepcode_kernel_tools::hash_bytes(patch.updated.as_bytes()),
                "oldContentBytes": original.len(),
                "newContentBytes": patch.updated.len(),
                "changedRanges": patch.changed_ranges,
                "matchKind": patch.match_kind,
                "mode": mode,
                "executable": mode.is_some_and(|value| value & 0o111 != 0)
            }),
        ))
    }
}

impl KernelToolExecutor for FsDeleteExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target_kind =
            get_string(&invocation.input, "targetKind").unwrap_or_else(|| "file".to_string());
        let target_kind = match target_kind.trim() {
            "directory" => "directory",
            _ => "file",
        };
        let recursive = invocation
            .input
            .get("recursive")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        let target = prepared_workspace_target(&context)?;
        if target.is_dir() {
            if target_kind != "directory" {
                return Err(KernelError::PermissionDenied(
                    "fs.delete directory target requires targetKind=directory".to_string(),
                ));
            }
            if !recursive {
                return Err(KernelError::PermissionDenied(
                    "fs.delete directory target requires recursive=true".to_string(),
                ));
            }
            fs::remove_dir_all(&target)
                .map_err(|error| KernelError::Other(format!("delete directory {path}: {error}")))?;
            return Ok(ok(
                invocation.id,
                serde_json::json!({
                    "workspaceId": workspace_id(&context)?,
                    "path": normalize_relative_path(&path),
                    "deleted": true,
                    "kind": "directory",
                    "recursive": recursive
                }),
            ));
        }
        if target_kind == "directory" {
            return Err(KernelError::PermissionDenied(
                "fs.delete targetKind=directory requires an existing directory target".to_string(),
            ));
        }
        fs::remove_file(&target)
            .map_err(|error| KernelError::Other(format!("delete {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "deleted": true,
                "kind": "file"
            }),
        ))
    }
}

impl KernelToolExecutor for FsEnsureDirectoryExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = required_string(&invocation.input, "path")?;
        let target = prepared_workspace_target(&context)?;
        if target.exists() && !target.is_dir() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.ensure_directory target exists and is not a directory: {path}"
            )));
        }
        fs::create_dir_all(&target)
            .map_err(|error| KernelError::Other(format!("create directory {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "ensured": true
            }),
        ))
    }
}

impl KernelToolExecutor for FsDiffExecutor {
    fn invoke(
        &self,
        invocation: KernelToolInvocation,
        context: KernelToolExecutionContext,
    ) -> KernelResult<KernelToolExecutionResult> {
        let path = get_string(&invocation.input, "path").unwrap_or_default();
        let target = prepared_workspace_target(&context)?;
        let old_content = read_text_file_for_llm(&target)
            .map_err(|skip| {
                KernelError::InvalidCommand(format!(
                    "unsupported_file_content: {} ({})",
                    skip.message, skip.reason
                ))
            })?
            .content;
        let new_content =
            get_string_allow_empty(&invocation.input, "proposedContent").ok_or_else(|| {
                KernelError::InvalidCommand("fs.diff requires proposedContent".to_string())
            })?;
        let changed_ranges = changed_line_ranges(&old_content, &new_content);
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": path,
                "diff": unified_diff(&path, &old_content, &new_content),
                "changedRanges": changed_ranges,
                "oldContentHash": deepcode_kernel_tools::hash_bytes(old_content.as_bytes()),
                "newContentHash": deepcode_kernel_tools::hash_bytes(new_content.as_bytes())
            }),
        ))
    }
}
