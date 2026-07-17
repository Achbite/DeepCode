use super::*;

use super::targets::*;

pub(super) struct CompiledWorkspaceAction {
    pub(super) tool_name: String,
    pub(super) arguments: Value,
    pub(super) workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub(crate) struct NormalizedWorkspacePath {
    pub(crate) relative_path: String,
    pub(crate) workspace_root: Option<PathBuf>,
    pub(crate) root_source: Option<&'static str>,
    pub(crate) stripped_prefixes: Vec<String>,
    pub(crate) duplicate_root_path_detected: bool,
    pub(crate) original_path: String,
}

pub(super) fn operation_kind_name(operation: &PlannedOperation) -> &'static str {
    operation.operation_kind.wire_name()
}

pub(super) fn canonical_tool_id(operation: &PlannedOperation) -> &str {
    &operation.tool_id
}

pub(super) fn compile_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    contract_id: Option<&str>,
) -> KernelResult<CompiledWorkspaceAction> {
    match &operation.operation {
        PlannedOperationKind::Workspace(workspace) => {
            compile_workspace_operation(runtime, record, operation, workspace)
        }
        PlannedOperationKind::Git(git) => compile_git_operation(runtime, record, operation, git),
        PlannedOperationKind::Network(network) => {
            compile_network_operation(runtime, record, operation, network, contract_id)
        }
        PlannedOperationKind::Process(_)
        | PlannedOperationKind::Browser(_)
        | PlannedOperationKind::Provider(_) => Err(KernelError::PermissionDenied(format!(
            "operation is blocked by Kernel policy: {}",
            operation.capability
        ))),
    }
}

pub(super) fn validate_compiled_operation(
    operation: &PlannedOperation,
    compiled: CompiledWorkspaceAction,
) -> KernelResult<CompiledWorkspaceAction> {
    if compiled.tool_name != operation.tool_id {
        return Err(KernelError::InvalidCommand(format!(
            "compiled operation mismatch: action {} kind {} expected {} but got {}",
            operation.id,
            operation_kind_name(operation),
            operation.tool_id,
            compiled.tool_name
        )));
    }
    if let PlannedOperationKind::Workspace(workspace) = &operation.operation {
        let expected_tool = canonical_tool_id(operation);
        match workspace.kind {
            WorkspaceOperationKind::Search => {
                if compiled
                    .arguments
                    .get("query")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                {
                    return Err(KernelError::InvalidCommand(format!(
                        "{} action {} requires non-empty query",
                        expected_tool, operation.id
                    )));
                }
            }
            WorkspaceOperationKind::Glob => {
                if compiled
                    .arguments
                    .get("pattern")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                {
                    return Err(KernelError::InvalidCommand(format!(
                        "{} action {} requires non-empty pattern",
                        expected_tool, operation.id
                    )));
                }
            }
            WorkspaceOperationKind::Read
            | WorkspaceOperationKind::List
            | WorkspaceOperationKind::Diff
            | WorkspaceOperationKind::Write
            | WorkspaceOperationKind::Create
            | WorkspaceOperationKind::Patch
            | WorkspaceOperationKind::Delete
            | WorkspaceOperationKind::Rename
            | WorkspaceOperationKind::DocumentRead
            | WorkspaceOperationKind::EnsureDirectory => {
                if compiled
                    .arguments
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_none()
                {
                    return Err(KernelError::InvalidCommand(format!(
                        "{} action {} requires non-empty path; operation={}",
                        expected_tool,
                        operation.id,
                        operation_compile_debug_json(operation, workspace)
                    )));
                }
            }
        }
    }
    Ok(compiled)
}

pub(super) fn compiled_tool_summary(
    operation_kind: ToolOperationKind,
    compiled: &CompiledWorkspaceAction,
) -> CompiledToolSummary {
    CompiledToolSummary {
        tool_id: compiled.tool_name.clone(),
        operation_kind,
        path: compiled
            .arguments
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string),
        target_kind: compiled
            .arguments
            .get("targetKind")
            .and_then(Value::as_str)
            .and_then(|kind| match kind {
                "file" => Some(deepcode_kernel_abi::ToolTargetKind::File),
                "directory" => Some(deepcode_kernel_abi::ToolTargetKind::Directory),
                _ => None,
            }),
        recursive: compiled.arguments.get("recursive").and_then(Value::as_bool),
        query: compiled
            .arguments
            .get("query")
            .and_then(Value::as_str)
            .map(str::to_string),
        args_preview: redact_tool_arguments(operation_kind, &compiled.arguments),
    }
}

pub(super) fn operation_compile_debug_json(
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> String {
    serde_json::to_string(&serde_json::json!({
        "actionId": &operation.id,
        "kind": operation_kind_name(operation),
        "capability": &operation.capability,
        "targetRef": &operation.target_ref,
        "workspaceTargetPath": &workspace.target_path,
        "writeSet": &operation.write_set,
        "readSet": &operation.read_set,
        "conflictKeys": &operation.conflict_keys
    }))
    .unwrap_or_else(|_| "<operation-debug-unavailable>".to_string())
}

pub(super) fn compile_workspace_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    match workspace.kind {
        WorkspaceOperationKind::Write | WorkspaceOperationKind::Create => {
            workspace_write_from_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Patch => {
            workspace_patch_from_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Read => {
            workspace_path_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::List => {
            workspace_path_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Glob => {
            workspace_glob_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Diff => {
            workspace_path_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Delete => {
            workspace_delete_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Search => {
            workspace_search_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Rename => {
            workspace_rename_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::DocumentRead => {
            workspace_path_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::EnsureDirectory => {
            workspace_path_tool_operation(runtime, record, operation, workspace)
        }
    }
}

pub(super) fn compile_git_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    git: &GitOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let workspace_root = git_workspace_root(runtime, record);
    match git.kind {
        GitOperationKind::Status => Ok(CompiledWorkspaceAction {
            tool_name: operation.tool_id.clone(),
            arguments: serde_json::json!({}),
            workspace_root,
        }),
        GitOperationKind::Diff => {
            let mut arguments = serde_json::json!({ "staged": git.staged });
            if let Some(path) = git.paths.first() {
                arguments["path"] = Value::String(git_relative_path(runtime, record, path)?);
            }
            Ok(CompiledWorkspaceAction {
                tool_name: operation.tool_id.clone(),
                arguments,
                workspace_root,
            })
        }
        GitOperationKind::Stage => Ok(CompiledWorkspaceAction {
            tool_name: operation.tool_id.clone(),
            arguments: git_paths_arguments_from_operation(runtime, record, operation, git)?,
            workspace_root,
        }),
        GitOperationKind::Unstage => Ok(CompiledWorkspaceAction {
            tool_name: operation.tool_id.clone(),
            arguments: git_paths_arguments_from_operation(runtime, record, operation, git)?,
            workspace_root,
        }),
        GitOperationKind::Commit => {
            let message = git
                .message
                .as_ref()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "git.commit action requires args.message".to_string(),
                    )
                })?;
            Ok(CompiledWorkspaceAction {
                tool_name: operation.tool_id.clone(),
                arguments: serde_json::json!({ "message": message }),
                workspace_root,
            })
        }
        GitOperationKind::Push => {
            let remote = git
                .remote
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("origin");
            let mut arguments = serde_json::json!({ "remote": remote });
            if let Some(branch) = git
                .branch
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                arguments["branch"] = Value::String(branch.to_string());
            }
            Ok(CompiledWorkspaceAction {
                tool_name: operation.tool_id.clone(),
                arguments,
                workspace_root,
            })
        }
    }
}

pub(super) fn workspace_write_from_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let content = workspace.content.clone().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "{} action {} requires canonical content",
            canonical_tool_id(operation),
            operation.id
        ))
    })?;
    if content.is_empty() && !workspace.allow_empty_content {
        return Err(KernelError::InvalidCommand(format!(
            "{} action {} has empty content; use allowEmptyContent to make this explicit",
            canonical_tool_id(operation),
            operation.id
        )));
    }
    let raw_path = workspace
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "{} action {} requires args.path",
                canonical_tool_id(operation),
                operation.id
            ))
        })?;
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    match workspace.kind {
        WorkspaceOperationKind::Create | WorkspaceOperationKind::Write => {}
        _ => {
            return Err(KernelError::InvalidCommand(format!(
                "{} cannot be compiled as a content write",
                operation_kind_name(operation)
            )))
        }
    }
    Ok(CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "content": content,
            "temporary": workspace.temporary,
            "executable": workspace.executable,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

pub(super) fn workspace_patch_from_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let replacement = workspace.content.clone().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "fs.edit action {} requires canonical replacement content",
            operation.id
        ))
    })?;
    if replacement.is_empty() && !workspace.allow_empty_content {
        return Err(KernelError::InvalidCommand(format!(
            "fs.edit action {} has empty replacement; use allowEmptyContent to make this explicit",
            operation.id
        )));
    }
    let raw_path = workspace
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "fs.edit action {} requires args.path",
                operation.id
            ))
        })?;
    let patch_spec = workspace.patch_spec.clone().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "fs.edit action {} requires patchSpec",
            operation.id
        ))
    })?;
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "patchSpec": patch_spec,
            "replacement": replacement,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

pub(super) fn workspace_path_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let raw_path = workspace
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(".");
    let normalized = workspace_relative_read_path(runtime, record, raw_path)?;
    let mut arguments = serde_json::json!({
        "path": normalized.relative_path,
        "pathNormalization": path_normalization_json(&normalized)
    });
    if let Some(content) = workspace.content.as_ref() {
        arguments["proposedContent"] = Value::String(content.clone());
    }
    if let Some(start_line) = workspace.start_line {
        arguments["startLine"] = Value::from(start_line);
    }
    if let Some(end_line) = workspace.end_line {
        arguments["endLine"] = Value::from(end_line);
    }
    if let Some(start_page) = workspace.start_page {
        arguments["startPage"] = Value::from(start_page);
    }
    if let Some(end_page) = workspace.end_page {
        arguments["endPage"] = Value::from(end_page);
    }
    if let Some(depth) = workspace.depth {
        arguments["depth"] = Value::from(depth);
    }
    if workspace.include_hidden {
        arguments["includeHidden"] = Value::Bool(true);
    }
    Ok(CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments,
        workspace_root: normalized.workspace_root,
    })
}

pub(super) fn workspace_glob_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let pattern = workspace
        .pattern
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("fs.glob action requires pattern".to_string())
        })?;
    let raw_path = workspace.target_path.as_deref().unwrap_or(".");
    let normalized = workspace_relative_read_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "pattern": pattern,
            "maxResults": workspace.max_results,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

pub(super) fn workspace_rename_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let source = workspace
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("fs.rename action {} requires path", operation.id))
        })?;
    let destination = workspace
        .rename_to
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "fs.rename action {} requires destinationPath",
                operation.id
            ))
        })?;
    let source = workspace_relative_write_path(runtime, record, source)?;
    let destination = workspace_relative_write_path(runtime, record, destination)?;
    Ok(CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments: serde_json::json!({
            "path": source.relative_path,
            "destinationPath": destination.relative_path,
            "pathNormalization": path_normalization_json(&source)
        }),
        workspace_root: source.workspace_root,
    })
}

pub(super) fn workspace_delete_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let raw_path = workspace
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "fs.delete action {} requires args.path; operation={}",
                operation.id,
                operation_compile_debug_json(operation, workspace)
            ))
        })?;
    if raw_path == "." || raw_path == "./" {
        return Err(KernelError::InvalidCommand(
            "fs.delete cannot remove workspace root".to_string(),
        ));
    }
    if raw_path.contains('*') {
        return Err(KernelError::InvalidCommand(
            "fs.delete target must be a concrete path".to_string(),
        ));
    }
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    if normalized.relative_path.trim().is_empty()
        || normalized.relative_path == "."
        || normalized.relative_path == "./"
    {
        return Err(KernelError::InvalidCommand(
            "fs.delete cannot remove workspace root".to_string(),
        ));
    }
    let explicit_target_kind = workspace
        .target_kind
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_kind = match explicit_target_kind {
        Some("directory") => "directory",
        Some("file") => "file",
        _ => "file",
    };
    if target_kind == "directory" && !workspace.recursive {
        return Err(KernelError::InvalidCommand(
            "fs.delete directory target requires recursive=true".to_string(),
        ));
    }
    let recursive = workspace.recursive;
    let action = CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "targetKind": target_kind,
            "recursive": recursive,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    };
    if action
        .arguments
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return Err(KernelError::InvalidCommand(format!(
            "fs.delete compile lost target path for action {} despite canonical operation={}",
            operation.id,
            operation_compile_debug_json(operation, workspace)
        )));
    }
    Ok(action)
}

pub(super) fn workspace_search_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let query = workspace
        .query
        .as_deref()
        .or(workspace.target_path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("code.grep action requires query".to_string())
        })?;
    let raw_path = workspace.target_path.as_deref().unwrap_or(".");
    let normalized = workspace_relative_read_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: operation.tool_id.clone(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "query": query,
            "include": &workspace.include,
            "exclude": &workspace.exclude,
            "strategy": workspace.strategy.as_deref().unwrap_or("literal"),
            "contextLines": workspace.context_lines,
            "maxResults": workspace.max_results
        }),
        workspace_root: normalized.workspace_root,
    })
}

pub(super) fn compile_network_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    network: &deepcode_kernel_tools::NetworkOperation,
    contract_id: Option<&str>,
) -> KernelResult<CompiledWorkspaceAction> {
    let contract_id = contract_id.ok_or_else(|| {
        KernelError::PermissionDenied("network operation requires an accepted contract".to_string())
    })?;
    let reviewed_target =
        runtime.reviewed_http_target_for_operation(&record.run_id, contract_id, &operation.id)?;
    match network.kind {
        deepcode_kernel_tools::NetworkOperationKind::Search => {
            let query = network
                .query
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::InvalidCommand(format!(
                        "web.search action {} requires query",
                        operation.id
                    ))
                })?;
            Ok(CompiledWorkspaceAction {
                tool_name: operation.tool_id.clone(),
                arguments: serde_json::json!({
                    "query": query,
                    "limit": network.limit,
                    "kernelReviewedTarget": reviewed_target
                }),
                workspace_root: None,
            })
        }
        deepcode_kernel_tools::NetworkOperationKind::Fetch => {
            let url = network
                .url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::InvalidCommand(format!(
                        "web.fetch action {} requires url",
                        operation.id
                    ))
                })?;
            Ok(CompiledWorkspaceAction {
                tool_name: operation.tool_id.clone(),
                arguments: serde_json::json!({
                    "url": url,
                    "maxBytes": network.max_bytes,
                    "kernelReviewedTarget": reviewed_target
                }),
                workspace_root: None,
            })
        }
    }
}
