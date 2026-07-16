use crate::{
    BrowserOperation, BrowserOperationKind, ContentBlock, FileTargetRef, GitOperationKind,
    KernelToolRegistry, NetworkOperation, NetworkOperationKind, OperationCompileError,
    OperationExecutionMode, PlannedOperation, PlannedOperationKind, ProcessOperation,
    ProviderOperation, WorkspaceOperation, WorkspaceOperationKind,
};
use serde_json::Value;
use std::collections::BTreeSet;

pub(crate) fn get_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(crate) fn get_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(crate) fn get_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| strings_from_array(items))
}

pub(crate) fn strings_from_array(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

pub(crate) fn workspace_kind_for_tool(
    tool_id: &str,
) -> Result<WorkspaceOperationKind, OperationCompileError> {
    match tool_id {
        "fs.read" => Ok(WorkspaceOperationKind::Read),
        "fs.list" => Ok(WorkspaceOperationKind::List),
        "fs.glob" => Ok(WorkspaceOperationKind::Glob),
        "code.grep" => Ok(WorkspaceOperationKind::Search),
        "fs.diff" => Ok(WorkspaceOperationKind::Diff),
        "fs.create" => Ok(WorkspaceOperationKind::Create),
        "fs.write" => Ok(WorkspaceOperationKind::Write),
        "fs.edit" => Ok(WorkspaceOperationKind::Patch),
        "fs.rename" => Ok(WorkspaceOperationKind::Rename),
        "fs.delete" => Ok(WorkspaceOperationKind::Delete),
        "document.read" => Ok(WorkspaceOperationKind::DocumentRead),
        other => Err(OperationCompileError::UnsupportedToolId {
            tool_id: other.to_string(),
        }),
    }
}

pub(crate) fn block_allows_empty_content(block: &ContentBlock) -> bool {
    block.allow_empty_content && block.operation.as_deref() == Some("createEmpty")
}

pub(crate) fn git_kind_for_tool(tool_id: &str) -> Result<GitOperationKind, OperationCompileError> {
    match tool_id {
        "git.status" => Ok(GitOperationKind::Status),
        "git.diff" => Ok(GitOperationKind::Diff),
        "git.stage" => Ok(GitOperationKind::Stage),
        "git.unstage" => Ok(GitOperationKind::Unstage),
        "git.commit" => Ok(GitOperationKind::Commit),
        "git.push" => Ok(GitOperationKind::Push),
        other => Err(OperationCompileError::UnsupportedToolId {
            tool_id: other.to_string(),
        }),
    }
}

pub(crate) fn operation_execution_mode(
    registry: &KernelToolRegistry,
    tool_id: &str,
    kind: WorkspaceOperationKind,
) -> Result<OperationExecutionMode, OperationCompileError> {
    let registered_tool_id = registry.tool_for_workspace_kind(kind).ok_or_else(|| {
        OperationCompileError::UnsupportedToolId {
            tool_id: tool_id.to_string(),
        }
    })?;
    if registered_tool_id != tool_id {
        return Err(OperationCompileError::UnsupportedToolId {
            tool_id: tool_id.to_string(),
        });
    }
    registry
        .get(registered_tool_id)
        .map(|descriptor| descriptor.execution_mode)
        .ok_or_else(|| OperationCompileError::UnsupportedToolId {
            tool_id: tool_id.to_string(),
        })
}

pub(crate) fn conflict_keys_for_action(read_set: &[String], write_set: &[String]) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for key in write_set.iter().chain(read_set.iter()) {
        keys.insert(key.clone());
    }
    keys.into_iter().collect()
}

pub(crate) fn internal_ensure_directory_operation(
    registry: &KernelToolRegistry,
    id: String,
    path: String,
) -> PlannedOperation {
    let descriptor = registry
        .get("fs.ensure_directory")
        .expect("fs.ensure_directory is a Kernel internal registration");
    PlannedOperation {
        id,
        title: format!("Ensure parent directory {path}"),
        depends_on: Vec::new(),
        capability: descriptor.capability.to_string(),
        permission_labels: Vec::new(),
        target_ref: Some(FileTargetRef::from_path(path.clone())),
        read_set: Vec::new(),
        write_set: vec![path.clone()],
        conflict_keys: vec![path.clone()],
        execution_mode: descriptor.execution_mode,
        operation: PlannedOperationKind::Workspace(Box::new(WorkspaceOperation {
            kind: WorkspaceOperationKind::EnsureDirectory,
            target_path: Some(path),
            target_kind: Some("directory".to_string()),
            recursive: false,
            content_block_id: None,
            replacement_block_id: None,
            content: None,
            patch_spec: None,
            allow_empty_content: false,
            temporary: false,
            executable: false,
            query: None,
            pattern: None,
            depth: None,
            include_hidden: false,
            include: Vec::new(),
            exclude: Vec::new(),
            strategy: None,
            context_lines: None,
            max_results: None,
            rename_to: None,
            start_line: None,
            end_line: None,
            start_page: None,
            end_page: None,
        })),
    }
}

pub(crate) fn external_process_operation(
    registry: &KernelToolRegistry,
    action: &Value,
    id: String,
    title: String,
    tool_id: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let args = action.get("args").unwrap_or(&Value::Null);
    let argv = args
        .get("argv")
        .and_then(Value::as_array)
        .map(|items| strings_from_array(items))
        .unwrap_or_default();
    PlannedOperation {
        id,
        title,
        depends_on: Vec::new(),
        capability,
        permission_labels,
        target_ref: None,
        read_set: Vec::new(),
        write_set: vec!["process".to_string()],
        conflict_keys: vec!["process".to_string()],
        execution_mode: execution_mode_for_tool(registry, &tool_id),
        operation: PlannedOperationKind::Process(ProcessOperation {
            cwd: get_string(args, &["cwd"]),
            argv,
            timeout_ms: args.get("timeoutMs").and_then(Value::as_u64),
            env_policy: get_string(args, &["envPolicy"]),
        }),
    }
}

pub(crate) fn external_network_operation(
    registry: &KernelToolRegistry,
    action: &Value,
    id: String,
    title: String,
    tool_id: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let args = action.get("args").unwrap_or(&Value::Null);
    let kind = match tool_id.as_str() {
        "web.fetch" => NetworkOperationKind::Fetch,
        _ => NetworkOperationKind::Search,
    };
    let target = match kind {
        NetworkOperationKind::Fetch => get_string(args, &["url"]),
        NetworkOperationKind::Search => get_string(args, &["query"]),
    };
    let read_set = target
        .as_ref()
        .map(|value| vec![format!("network:{value}")])
        .unwrap_or_default();
    PlannedOperation {
        id,
        title,
        depends_on: Vec::new(),
        capability,
        permission_labels,
        target_ref: None,
        conflict_keys: conflict_keys_for_action(&read_set, &[]),
        read_set,
        write_set: Vec::new(),
        execution_mode: execution_mode_for_tool(registry, &tool_id),
        operation: PlannedOperationKind::Network(NetworkOperation {
            kind,
            url: get_string(args, &["url"]),
            query: get_string(args, &["query"]),
            limit: args.get("limit").and_then(Value::as_u64),
            max_bytes: args.get("maxBytes").and_then(Value::as_u64),
        }),
    }
}

pub(crate) fn external_browser_operation(
    registry: &KernelToolRegistry,
    action: &Value,
    id: String,
    title: String,
    tool_id: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let args = action.get("args").unwrap_or(&Value::Null);
    let kind = match tool_id.as_str() {
        "browser.reload" => BrowserOperationKind::Reload,
        "browser.snapshot" => BrowserOperationKind::Snapshot,
        "browser.inspect" => BrowserOperationKind::Inspect,
        "browser.click" => BrowserOperationKind::Click,
        "browser.type" => BrowserOperationKind::Type,
        "browser.scroll" => BrowserOperationKind::Scroll,
        _ => BrowserOperationKind::Open,
    };
    PlannedOperation {
        id,
        title,
        depends_on: Vec::new(),
        capability,
        permission_labels,
        target_ref: None,
        read_set: Vec::new(),
        write_set: vec!["browser.control".to_string()],
        conflict_keys: vec!["browser.control".to_string()],
        execution_mode: execution_mode_for_tool(registry, &tool_id),
        operation: PlannedOperationKind::Browser(BrowserOperation {
            kind,
            url: get_string(args, &["url"]),
            selector: get_string(args, &["selector"]),
            inspect_state: get_string(args, &["inspectState"]),
            text: get_string(args, &["text"]),
            delta_y: args.get("deltaY").and_then(Value::as_i64),
        }),
    }
}

pub(crate) fn external_provider_operation(
    registry: &KernelToolRegistry,
    action: &Value,
    id: String,
    title: String,
    tool_id: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let args = action.get("args").unwrap_or(&Value::Null);
    PlannedOperation {
        id,
        title,
        depends_on: Vec::new(),
        capability,
        permission_labels,
        target_ref: None,
        read_set: Vec::new(),
        write_set: vec!["provider.egress".to_string()],
        conflict_keys: vec!["provider.egress".to_string()],
        execution_mode: execution_mode_for_tool(registry, &tool_id),
        operation: PlannedOperationKind::Provider(ProviderOperation {
            profile_ref: get_string(args, &["profileRef"]),
            budget_ref: get_string(args, &["budgetRef"]),
        }),
    }
}

pub(crate) fn execution_mode_for_tool(
    registry: &KernelToolRegistry,
    tool_id: &str,
) -> OperationExecutionMode {
    registry
        .get(tool_id)
        .map(|descriptor| descriptor.execution_mode)
        .unwrap_or(OperationExecutionMode::Blocked)
}
