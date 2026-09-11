use super::file_changes::{capture_side, change_fact, delete_tree};
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
        let mut output = deepcode_kernel_tools::text_range::read_text_range(
            &target,
            invocation
                .input
                .get("startLine")
                .and_then(Value::as_u64)
                .unwrap_or(1),
            invocation.input.get("startByte").and_then(Value::as_u64),
            invocation
                .input
                .get("maxLines")
                .and_then(Value::as_u64)
                .unwrap_or(2000) as usize,
            invocation
                .input
                .get("maxBytes")
                .and_then(Value::as_u64)
                .unwrap_or(262144) as usize,
        )
        .map_err(KernelError::InvalidCommand)?;
        output["workspaceId"] = serde_json::json!(workspace_id(&context)?);
        output["path"] = serde_json::json!(normalize_relative_path(&path));
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
        let content_changed = !existed || !file_matches_content(&target, content.as_bytes())?;
        let before = capture_side(&target, &context, 0, "before");
        let attributes = if existed {
            atomic_write_text(&target, &content)?;
            executable.map_or(Ok(()), |value| set_executable_state(&target, value))
        } else {
            atomic_create_text(&target, &content, executable.unwrap_or(false))?;
            Ok(())
        };
        let after = capture_side(&target, &context, 0, "after");
        let changes = if content_changed {
            vec![change_fact(&context, &path, before, after)?]
        } else {
            Vec::new()
        };
        let mode = attributes.and_then(|()| file_mode(&target));
        Ok(finish_file_mutation(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "fileChanges": changes,
                "created": !existed,
                "saved": true,
                "sizeBytes": content.len(),
                "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes())
            }),
            mode,
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
        let before = capture_side(&target, &context, 0, "before");
        atomic_write_text(&target, &patch.updated)?;
        let after = capture_side(&target, &context, 0, "after");
        let changes = if original == patch.updated {
            Vec::new()
        } else {
            vec![change_fact(&context, &path, before, after)?]
        };
        let mode = file_mode(&target);
        Ok(finish_file_mutation(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "fileChanges": changes,
                "patched": true,
                "oldContentHash": deepcode_kernel_tools::hash_bytes(original.as_bytes()),
                "newContentHash": deepcode_kernel_tools::hash_bytes(patch.updated.as_bytes()),
                "oldContentBytes": original.len(),
                "newContentBytes": patch.updated.len(),
                "changedRanges": patch.changed_ranges,
                "editCount": edits.as_array().map_or(0, Vec::len)
            }),
            mode,
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
            let mut changes = Vec::new();
            let result = delete_tree(&target, &path, &context, &mut changes);
            let output = serde_json::json!({ "workspaceId": workspace_id(&context)?, "path": normalize_relative_path(&path),
                "deleted": result.is_ok(), "kind": "directoryTree", "fileChanges": changes });
            return Ok(match result {
                Ok(()) => ok(invocation.id, output),
                Err(error) => KernelToolExecutionResult {
                    invocation_id: invocation.id,
                    outcome: KernelToolExecutionOutcome::Failed,
                    output,
                    error: Some(KernelToolExecutionFailure {
                        code: "file_delete_failed".into(),
                        message: error.to_string(),
                    }),
                },
            });
        }
        if target_kind == "directoryTree" {
            return Err(KernelError::PermissionDenied(
                "fs.delete targetKind=directoryTree requires an existing directory target"
                    .to_string(),
            ));
        }
        let before = capture_side(&target, &context, 0, "before");
        fs::remove_file(&target)
            .map_err(|error| KernelError::Other(format!("delete {path}: {error}")))?;
        Ok(ok(
            invocation.id,
            serde_json::json!({
                "workspaceId": workspace_id(&context)?,
                "path": normalize_relative_path(&path),
                "fileChanges": [change_fact(&context, &path, before, serde_json::json!({ "exists": false }))?],
                "deleted": true,
                "kind": "file"
            }),
        ))
    }
}

fn file_matches_content(target: &Path, content: &[u8]) -> KernelResult<bool> {
    let mut file = fs::File::open(target).map_err(|error| KernelError::Other(error.to_string()))?;
    if file
        .metadata()
        .map_err(|error| KernelError::Other(error.to_string()))?
        .len()
        != content.len() as u64
    {
        return Ok(false);
    }
    let mut buffer = [0_u8; 8192];
    for part in content.chunks(buffer.len()) {
        file.read_exact(&mut buffer[..part.len()])
            .map_err(|error| KernelError::Other(error.to_string()))?;
        if &buffer[..part.len()] != part {
            return Ok(false);
        }
    }
    Ok(true)
}

// Once content has changed, preserve the change facts even if a later attribute
// operation fails. The failed outcome remains distinct from the saved content.
fn finish_file_mutation(
    invocation_id: String,
    mut output: Value,
    mode: KernelResult<Option<u32>>,
) -> KernelToolExecutionResult {
    match mode {
        Ok(mode) => {
            output["mode"] = serde_json::json!(mode);
            output["executable"] = serde_json::json!(mode.is_some_and(|value| value & 0o111 != 0));
            ok(invocation_id, output)
        }
        Err(error) => KernelToolExecutionResult {
            invocation_id,
            outcome: KernelToolExecutionOutcome::Failed,
            output,
            error: Some(KernelToolExecutionFailure {
                code: "file_attributes_failed".into(),
                message: error.to_string(),
            }),
        },
    }
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
