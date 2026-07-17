use super::compiler::{compile_operation, validate_compiled_operation, CompiledWorkspaceAction};
use super::*;
use deepcode_kernel_policy::WorkspaceBoundary;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub(super) struct PreparedOperation {
    pub(super) compiled: Option<CompiledWorkspaceAction>,
}

pub(super) struct BatchPreflightFailure {
    pub(super) operation_id: String,
    pub(super) error: KernelError,
}

pub(super) fn prepare_action_batch<'a>(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operations: impl IntoIterator<Item = &'a PlannedOperation>,
    contract_id: Option<&str>,
) -> Result<BTreeMap<String, PreparedOperation>, BatchPreflightFailure> {
    let operations = operations.into_iter().collect::<Vec<_>>();
    let mut prepared = BTreeMap::new();

    for operation in &operations {
        let compiled = if operation.execution_mode == OperationExecutionMode::Execute {
            Some(
                compile_operation(runtime, record, operation, contract_id)
                    .and_then(|compiled| validate_compiled_operation(operation, compiled))
                    .map_err(|error| BatchPreflightFailure {
                        operation_id: operation.id.clone(),
                        error,
                    })?,
            )
        } else {
            None
        };
        prepared.insert(operation.id.clone(), PreparedOperation { compiled });
    }

    let mut mutation_state = MutationPreflightState::default();
    for operation in operations {
        let Some(compiled) = prepared
            .get(&operation.id)
            .and_then(|item| item.compiled.as_ref())
        else {
            continue;
        };
        if operation.operation_kind.is_workspace_mutation() {
            validate_mutation(operation.operation_kind, compiled, &mut mutation_state).map_err(
                |error| BatchPreflightFailure {
                    operation_id: operation.id.clone(),
                    error,
                },
            )?;
            match runtime
                .effective_permission_action_for_tool(
                    &record.run_id,
                    &compiled.tool_name,
                    &compiled.arguments,
                )
                .map_err(|error| BatchPreflightFailure {
                    operation_id: operation.id.clone(),
                    error,
                })? {
                PermissionAction::Allow | PermissionAction::Ask => {}
                PermissionAction::Deny => {
                    return Err(BatchPreflightFailure {
                        operation_id: operation.id.clone(),
                        error: KernelError::PermissionDenied(format!(
                            "{} mutation is denied by Kernel policy",
                            compiled.tool_name
                        )),
                    });
                }
            }
        }
    }

    Ok(prepared)
}

fn validate_mutation(
    operation_kind: ToolOperationKind,
    compiled: &CompiledWorkspaceAction,
    state: &mut MutationPreflightState,
) -> KernelResult<()> {
    let root = compiled.workspace_root.as_ref().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "{} mutation requires a run-bound workspace root",
            compiled.tool_name
        ))
    })?;
    if !root.is_dir() {
        return Err(KernelError::InvalidCommand(format!(
            "kernel execution root is not a directory: {}",
            root.display()
        )));
    }
    let path = required_argument(&compiled.arguments, "path", &compiled.tool_name)?;
    let target = WorkspaceBoundary::new(root).resolve_mutation(path)?;
    let target_state = state.resolve(&target)?;

    match operation_kind {
        ToolOperationKind::FsCreate => {
            if target_state != MutationTargetState::Absent {
                return Err(KernelError::InvalidCommand(format!(
                    "fs.create target already exists: {path}"
                )));
            }
            state.validate_parent_directory(path, &target, "fs.create")?;
            state.set(target, MutationTargetState::File);
        }
        ToolOperationKind::FsWrite | ToolOperationKind::FsEdit => {
            if target_state != MutationTargetState::File {
                return Err(KernelError::InvalidCommand(format!(
                    "{} requires a file target: {path}",
                    compiled.tool_name
                )));
            }
        }
        ToolOperationKind::FsRename => {
            if target_state == MutationTargetState::Absent {
                return Err(KernelError::InvalidCommand(format!(
                    "fs.rename source does not exist: {path}"
                )));
            }
            let destination =
                required_argument(&compiled.arguments, "destinationPath", &compiled.tool_name)?;
            let destination_path = WorkspaceBoundary::new(root).resolve_mutation(destination)?;
            if state.resolve(&destination_path)? != MutationTargetState::Absent {
                return Err(KernelError::InvalidCommand(format!(
                    "fs.rename destination already exists: {destination}"
                )));
            }
            state.validate_parent_directory(destination, &destination_path, "fs.rename")?;
            state.set(target, MutationTargetState::Absent);
            state.set(destination_path, target_state);
        }
        ToolOperationKind::FsDelete => {
            let actual_kind = match target_state {
                MutationTargetState::File => "file",
                MutationTargetState::Directory => "directory",
                MutationTargetState::Absent => {
                    return Err(KernelError::InvalidCommand(format!(
                        "fs.delete target does not exist: {path}"
                    )));
                }
            };
            let target_kind =
                required_argument(&compiled.arguments, "targetKind", &compiled.tool_name)?;
            if target_kind != actual_kind {
                return Err(KernelError::PermissionDenied(format!(
                    "fs.delete targetKind={target_kind} does not match {actual_kind} target: {path}"
                )));
            }
            let recursive = compiled
                .arguments
                .get("recursive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if actual_kind == "directory" && !recursive {
                return Err(KernelError::PermissionDenied(
                    "fs.delete directory target requires recursive=true".to_string(),
                ));
            }
            state.set(target, MutationTargetState::Absent);
        }
        ToolOperationKind::FsEnsureDirectory => {
            if target_state == MutationTargetState::File {
                return Err(KernelError::InvalidCommand(format!(
                    "fs.ensure_directory target exists and is not a directory: {path}"
                )));
            }
            state.set(target, MutationTargetState::Directory);
        }
        _ => {
            return Err(KernelError::InvalidCommand(format!(
                "{} is not a workspace mutation",
                compiled.tool_name
            )));
        }
    }
    Ok(())
}

fn required_argument<'a>(
    arguments: &'a Value,
    field: &str,
    tool_name: &str,
) -> KernelResult<&'a str> {
    arguments
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| KernelError::InvalidCommand(format!("{tool_name} requires args.{field}")))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MutationTargetState {
    Absent,
    File,
    Directory,
}

#[derive(Default)]
struct MutationPreflightState {
    targets: BTreeMap<PathBuf, MutationTargetState>,
}

impl MutationPreflightState {
    fn resolve(&mut self, path: &Path) -> KernelResult<MutationTargetState> {
        if let Some(state) = self.targets.get(path) {
            return Ok(*state);
        }
        let state = match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.is_file() => MutationTargetState::File,
            Ok(metadata) if metadata.is_dir() => MutationTargetState::Directory,
            Ok(_) => {
                return Err(KernelError::InvalidCommand(format!(
                    "workspace mutation target is neither a regular file nor a directory: {}",
                    path.display()
                )));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                MutationTargetState::Absent
            }
            Err(error) => {
                return Err(KernelError::Other(format!(
                    "inspect mutation target {}: {error}",
                    path.display()
                )));
            }
        };
        self.targets.insert(path.to_path_buf(), state);
        Ok(state)
    }

    fn set(&mut self, path: PathBuf, state: MutationTargetState) {
        self.targets.insert(path, state);
    }

    fn validate_parent_directory(
        &mut self,
        relative_path: &str,
        target: &Path,
        tool_name: &str,
    ) -> KernelResult<()> {
        let parent = target.parent().ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "{tool_name} target has no parent: {relative_path}"
            ))
        })?;
        if self.resolve(parent)? == MutationTargetState::Directory {
            return Ok(());
        }
        Err(KernelError::InvalidCommand(format!(
            "{tool_name} parent directory does not exist: {}",
            parent.display()
        )))
    }
}
