use super::*;

pub(super) struct FsReadExecutor;
pub(super) struct FsWriteExecutor;
pub(super) struct FsEditExecutor;
pub(super) struct FsDeleteExecutor;

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
        let max_lines = invocation
            .input
            .get("maxLines")
            .and_then(Value::as_u64)
            .unwrap_or(2_000) as usize;
        let max_bytes = invocation
            .input
            .get("maxBytes")
            .and_then(Value::as_u64)
            .unwrap_or(262_144) as usize;
        if start_line == 0
            || max_lines == 0
            || max_lines > 5_000
            || !(1_024..=1_048_576).contains(&max_bytes)
        {
            return Err(KernelError::InvalidCommand(
                "fs.read requires startLine >= 1, 1 <= maxLines <= 5000, and 1024 <= maxBytes <= 1048576"
                    .to_string(),
            ));
        }
        let lines = full_content.split_inclusive('\n').collect::<Vec<_>>();
        if !lines.is_empty() && start_line > lines.len() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.read startLine {start_line} is beyond end of file at line {}",
                lines.len()
            )));
        }
        let start = start_line.saturating_sub(1).min(lines.len());
        let requested_end = start.saturating_add(max_lines).min(lines.len());
        let selected = lines[start..requested_end].concat();
        let (content, byte_truncated) = truncate_utf8_bytes(&selected, max_bytes);
        let returned_line_breaks = content.bytes().filter(|byte| *byte == b'\n').count();
        let returned_lines =
            returned_line_breaks + usize::from(!content.is_empty() && !content.ends_with('\n'));
        let end_line = start.saturating_add(returned_lines);
        let truncated = requested_end < lines.len() || byte_truncated;
        let mut output = serde_json::json!({
            "workspaceId": workspace_id(&context)?,
            "path": normalize_relative_path(&path),
            "content": content,
            "sizeBytes": content.len(),
            "fileSizeBytes": full_content.len(),
            "startLine": start_line,
            "endLine": end_line,
            "maxLines": max_lines,
            "maxBytes": max_bytes,
            "truncated": truncated,
            "byteTruncated": byte_truncated,
            "contentHash": deepcode_kernel_tools::hash_bytes(full_content.as_bytes()),
            "binary": false,
            "fileClassification": read.classification
        });
        if truncated && !byte_truncated {
            output["nextStartLine"] = serde_json::json!(requested_end + 1);
        }
        Ok(ok(invocation.id, output))
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
        let existed = target.exists();
        if existed && !target.is_file() {
            return Err(KernelError::InvalidCommand(format!(
                "fs.write target exists and is not a file: {path}"
            )));
        }
        let parent = target.parent().ok_or_else(|| {
            KernelError::InvalidCommand(format!("fs.write target has no parent: {path}"))
        })?;
        fs::create_dir_all(parent)
            .map_err(|error| KernelError::Other(format!("create fs.write parent: {error}")))?;
        let content = get_string_allow_empty(&invocation.input, "content").unwrap_or_default();
        let executable = invocation.input.get("executable").and_then(Value::as_bool);
        if existed {
            atomic_write_text(&target, &content)?;
            if let Some(executable) = executable {
                set_executable_state(&target, executable)?;
            }
        } else {
            atomic_create_text(&target, &content, executable.unwrap_or(false))?;
        }
        let mode = file_mode(&target)?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "created": !existed,
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
        let edits = invocation
            .input
            .get("edits")
            .ok_or_else(|| KernelError::InvalidCommand("fs.edit requires edits".to_string()))?;
        let patch = apply_exact_text_edits(&original, edits)?;
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
                "editCount": edits.as_array().map_or(0, Vec::len),
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
        let target_kind = get_string(&invocation.input, "targetKind").ok_or_else(|| {
            KernelError::InvalidCommand(
                "fs.delete requires targetKind=file or directoryTree".to_string(),
            )
        })?;
        let target_kind = match target_kind.trim() {
            "file" => "file",
            "directoryTree" => "directoryTree",
            _ => {
                return Err(KernelError::InvalidCommand(
                    "fs.delete requires targetKind=file or directoryTree".to_string(),
                ))
            }
        };
        let target = prepared_workspace_target(&context)?;
        if target.is_dir() {
            if target_kind != "directoryTree" {
                return Err(KernelError::PermissionDenied(
                    "fs.delete directory target requires targetKind=directoryTree".to_string(),
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
                    "kind": "directoryTree"
                }),
            ));
        }
        if target_kind == "directoryTree" {
            return Err(KernelError::PermissionDenied(
                "fs.delete targetKind=directoryTree requires an existing directory target"
                    .to_string(),
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

fn truncate_utf8_bytes(value: &str, max_bytes: usize) -> (String, bool) {
    if value.len() <= max_bytes {
        return (value.to_string(), false);
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    (value[..end].to_string(), true)
}

fn set_executable_state(_target: &Path, executable: bool) -> KernelResult<()> {
    #[cfg(unix)]
    {
        let metadata = fs::metadata(_target)
            .map_err(|error| KernelError::Other(format!("inspect fs.write mode: {error}")))?;
        let current = metadata.permissions().mode();
        let mode = if executable {
            current | 0o111
        } else {
            current & !0o111
        };
        fs::set_permissions(_target, fs::Permissions::from_mode(mode))
            .map_err(|error| KernelError::Other(format!("set fs.write mode: {error}")))?;
        Ok(())
    }
    #[cfg(not(unix))]
    {
        if executable {
            Err(KernelError::Structured {
                code: "unsupported_file_attribute",
                stage: "tool.execute",
                message: "fs.write executable=true is not supported on this platform".to_string(),
                details: serde_json::json!({
                    "toolId": "fs.write",
                    "attribute": "executable",
                    "platform": std::env::consts::OS,
                }),
            })
        } else {
            Ok(())
        }
    }
}
