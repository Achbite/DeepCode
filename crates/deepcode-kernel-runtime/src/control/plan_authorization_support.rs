use super::*;
use deepcode_kernel_abi::KernelPlanAuthorizationOperation;
use std::collections::{BTreeMap, BTreeSet};

pub(super) fn plan_authorization_dependency_diagnostics(
    operations: &[KernelPlanAuthorizationOperation],
) -> Vec<String> {
    let mut diagnostics = Vec::new();
    let operation_ids = operations
        .iter()
        .map(|operation| operation.id.clone())
        .collect::<BTreeSet<_>>();
    if operation_ids.len() != operations.len() {
        diagnostics.push(
            "plan_authorization_dependency_invalid: operation IDs must be unique".to_string(),
        );
    }
    for operation in operations {
        for dependency in &operation.depends_on {
            if !operation_ids.contains(dependency) {
                diagnostics.push(format!(
                    "plan_authorization_dependency_invalid: operation {} references unavailable dependency {}",
                    operation.id, dependency
                ));
            }
        }
    }

    let dependencies = operations
        .iter()
        .map(|operation| (operation.id.clone(), operation.depends_on.clone()))
        .collect::<BTreeMap<_, _>>();
    for operation in operations {
        if operation_depends_on(&dependencies, &operation.id, &operation.id) {
            diagnostics.push(format!(
                "plan_authorization_dependency_invalid: operation dependency cycle includes {}",
                operation.id
            ));
        }
    }
    for (left_index, left) in operations.iter().enumerate() {
        for right in operations.iter().skip(left_index + 1) {
            if !operations_conflict(left, right) {
                continue;
            }
            let ordered = operation_depends_on(&dependencies, &left.id, &right.id)
                || operation_depends_on(&dependencies, &right.id, &left.id);
            if !ordered {
                diagnostics.push(format!(
                    "unordered_operation_conflict: operations {} and {} share mutation conflict keys without an explicit task dependency",
                    left.id, right.id
                ));
            }
        }
    }
    diagnostics
}

fn operations_conflict(
    left: &KernelPlanAuthorizationOperation,
    right: &KernelPlanAuthorizationOperation,
) -> bool {
    if left.write_set.is_empty() && right.write_set.is_empty() {
        return false;
    }
    let left_keys = left.conflict_keys.iter().collect::<BTreeSet<_>>();
    right
        .conflict_keys
        .iter()
        .any(|key| left_keys.contains(key))
}

fn operation_depends_on(
    dependencies: &BTreeMap<String, Vec<String>>,
    operation_id: &str,
    expected_ancestor: &str,
) -> bool {
    let mut pending = dependencies.get(operation_id).cloned().unwrap_or_default();
    let mut visited = BTreeSet::new();
    while let Some(candidate) = pending.pop() {
        if candidate == expected_ancestor {
            return true;
        }
        if !visited.insert(candidate.clone()) {
            continue;
        }
        if let Some(next) = dependencies.get(&candidate) {
            pending.extend(next.iter().cloned());
        }
    }
    false
}

pub(super) fn authorized_operation_matches(
    contract: &KernelPlanAuthorizationContract,
    operation: &deepcode_kernel_tools::KernelExecutionOperation,
) -> bool {
    let actual_targets = operation
        .read_set
        .iter()
        .chain(operation.write_set.iter())
        .filter(|value| !value.trim().is_empty())
        .map(|value| normalized_scope(value))
        .collect::<BTreeSet<_>>();
    contract.operations.iter().any(|authorized| {
        if authorized.tool_id != operation.tool_id {
            return false;
        }
        let authorized_targets = authorized
            .targets
            .iter()
            .map(|value| normalized_scope(value))
            .collect::<BTreeSet<_>>();
        if !actual_targets.is_subset(&authorized_targets)
            || (actual_targets.is_empty() && !authorized_targets.is_empty())
        {
            return false;
        }
        if !fixed_authorization_args_match(&authorized.fixed_args, &operation.args) {
            return false;
        }
        if operation.operation_kind == ToolOperationKind::FsDelete {
            let actual_target_kind = match operation.args.get("targetKind").and_then(Value::as_str)
            {
                Some("directory") => ToolTargetKind::Directory,
                Some("file") | None => ToolTargetKind::File,
                Some(_) => return false,
            };
            let actual_recursive = operation
                .args
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            return authorized.target_kind == Some(actual_target_kind)
                && authorized.recursive.unwrap_or(false) == actual_recursive;
        }
        true
    })
}

fn fixed_authorization_args_match(fixed_args: &Value, actual: &Value) -> bool {
    let Some(fixed_args) = fixed_args.as_object() else {
        return false;
    };
    let Some(actual) = actual.as_object() else {
        return false;
    };
    fixed_args
        .iter()
        .all(|(field, expected)| actual.get(field) == Some(expected))
}

pub(super) fn exact_grants_from_execution_contract(
    contract: &deepcode_kernel_tools::KernelExecutionContract,
    authorization_contract_id: &str,
) -> Vec<TemporaryGrantEnvelope> {
    contract
        .permission_bundles
        .iter()
        .flat_map(|bundle| {
            let targets = if bundle.targets.is_empty() {
                vec![None]
            } else {
                bundle.targets.iter().cloned().map(Some).collect()
            };
            targets
                .into_iter()
                .map(|resource_path| {
                    let grant_identity = serde_json::json!({
                        "authorizationContractId": authorization_contract_id,
                        "executionContractId": contract.id,
                        "executionContractHash": contract.contract_hash,
                        "permissionBundleId": bundle.id,
                        "resourcePath": resource_path,
                    });
                    TemporaryGrantEnvelope {
                    id: format!("plan-authorized-{}", compact_hash(&grant_identity.to_string())),
                    contract_id: contract.id.clone(),
                    operation_ids: bundle.operation_ids.clone(),
                    capability: bundle.capability.clone(),
                    resource_kind: bundle.resource_kind,
                    resource_path,
                    expires_after_sequence: None,
                    reason: Some(format!(
                        "Derived from accepted plan authorization contract {authorization_contract_id}"
                    )),
                }
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

pub(super) fn execution_contract_hash(
    contract: &deepcode_kernel_tools::KernelExecutionContract,
) -> String {
    let mut payload = contract.clone();
    payload.contract_hash.clear();
    deepcode_kernel_tools::hash_bytes(
        serde_json::to_string(&payload)
            .unwrap_or_default()
            .as_bytes(),
    )
}

pub(super) fn normalized_scope(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_end_matches('/')
        .to_string()
}

pub(super) fn workspace_binding_hashes(binding: &WorkspaceBinding) -> BTreeSet<&str> {
    [
        binding.workspace_hash.as_deref(),
        binding.folder_hash.as_deref(),
        binding.workspace_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    .filter(|value| !value.trim().is_empty())
    .collect()
}

pub(super) fn preferred_workspace_binding_hash(binding: &WorkspaceBinding) -> Option<&str> {
    binding
        .workspace_hash
        .as_deref()
        .or(binding.folder_hash.as_deref())
        .or(binding.workspace_id.as_deref())
        .filter(|value| !value.trim().is_empty())
}

pub(super) fn plan_authorization_session_id(
    record: &RuntimeRunRecord,
    submitted: Option<SessionId>,
) -> KernelResult<String> {
    if submitted
        .as_ref()
        .is_some_and(|session_id| session_id.0 != record.session_id)
    {
        return Err(KernelError::PermissionDenied(
            "plan authorization sessionId does not match the current run".to_string(),
        ));
    }
    Ok(record.session_id.clone())
}

pub(super) fn validate_plan_target(
    tool_id: &str,
    path: &str,
    metadata: Option<&fs::Metadata>,
    constraints: &deepcode_kernel_tools::ToolUsageConstraints,
    read_only: bool,
    planned_to_exist: bool,
) -> KernelResult<()> {
    if path.trim().is_empty() || (path == "." && !read_only) {
        return Err(KernelError::InvalidCommand(format!(
            "{tool_id} requires a concrete target inside the run-bound workspace"
        )));
    }
    if metadata.is_some_and(|value| value.file_type().is_symlink()) && !read_only {
        return Err(KernelError::PermissionDenied(format!(
            "{tool_id} mutation target cannot be a symbolic link: {path}"
        )));
    }
    match constraints.target_existence {
        deepcode_kernel_tools::TargetExistence::MustExist
            if metadata.is_none() && !planned_to_exist =>
        {
            Err(KernelError::InvalidCommand(format!(
                "{tool_id} target does not exist: {path}"
            )))
        }
        deepcode_kernel_tools::TargetExistence::MustNotExist if metadata.is_some() => Err(
            KernelError::InvalidCommand(format!("{tool_id} target already exists: {path}")),
        ),
        _ => {
            if let Some(metadata) = metadata {
                let kind = if metadata.is_dir() {
                    deepcode_kernel_tools::ToolTargetKind::Directory
                } else {
                    deepcode_kernel_tools::ToolTargetKind::File
                };
                if !constraints.target_kinds.is_empty() && !constraints.target_kinds.contains(&kind)
                {
                    return Err(KernelError::InvalidCommand(format!(
                        "{tool_id} target kind {} is not allowed for {path}",
                        kind.wire_name()
                    )));
                }
            }
            Ok(())
        }
    }
}

pub(super) fn validate_rename_plan_target(
    path: &str,
    target_index: usize,
    metadata: Option<&fs::Metadata>,
    constraints: &deepcode_kernel_tools::ToolUsageConstraints,
) -> KernelResult<()> {
    match target_index {
        0 if constraints.source_existence
            == Some(deepcode_kernel_tools::TargetExistence::MustExist)
            && metadata.is_none() =>
        {
            Err(KernelError::InvalidCommand(format!(
                "fs.rename source does not exist: {path}"
            )))
        }
        1 if constraints.destination_existence
            == Some(deepcode_kernel_tools::TargetExistence::MustNotExist)
            && metadata.is_some() =>
        {
            Err(KernelError::InvalidCommand(format!(
                "fs.rename destination already exists: {path}"
            )))
        }
        0 => validate_target_kind("fs.rename", path, metadata, constraints),
        1 => Ok(()),
        _ => Err(KernelError::InvalidCommand(
            "fs.rename accepts exactly one source and one destination".to_string(),
        )),
    }
}

fn validate_target_kind(
    tool_id: &str,
    path: &str,
    metadata: Option<&fs::Metadata>,
    constraints: &deepcode_kernel_tools::ToolUsageConstraints,
) -> KernelResult<()> {
    let Some(metadata) = metadata else {
        return Ok(());
    };
    let kind = if metadata.is_dir() {
        deepcode_kernel_tools::ToolTargetKind::Directory
    } else {
        deepcode_kernel_tools::ToolTargetKind::File
    };
    if !constraints.target_kinds.is_empty() && !constraints.target_kinds.contains(&kind) {
        return Err(KernelError::InvalidCommand(format!(
            "{tool_id} target kind {} is not allowed for {path}",
            kind.wire_name()
        )));
    }
    Ok(())
}

pub(super) fn replace_operation_targets(
    values: &[String],
    raw_targets: &[String],
    normalized_targets: &[String],
) -> Vec<String> {
    values
        .iter()
        .map(|value| {
            raw_targets
                .iter()
                .position(|target| target == value)
                .and_then(|index| normalized_targets.get(index))
                .cloned()
                .unwrap_or_else(|| value.clone())
        })
        .collect()
}

pub(super) fn compact_hash(value: &str) -> String {
    deepcode_kernel_tools::hash_bytes(value.as_bytes())
        .trim_start_matches("sha256:")
        .chars()
        .take(20)
        .collect()
}
