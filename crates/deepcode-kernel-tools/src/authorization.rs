use crate::{
    input_validation::validate_schema, KernelToolRegistry, OperationExecutionMode, PlanTargetMode,
    ToolFamily, ToolPermissionMode, ToolRiskLevel,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanTaskIntent {
    pub task_id: String,
    pub tool_id: String,
    pub targets: Vec<String>,
    pub depends_on: Vec<String>,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAuthorizationOperationDraft {
    pub id: String,
    pub source_task_id: String,
    pub tool_id: String,
    pub targets: Vec<String>,
    pub depends_on: Vec<String>,
    pub fixed_args: Value,
    pub args_template: Value,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: OperationExecutionMode,
    pub internal: bool,
    pub parent_operation_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAuthorizationPermissionBundleDraft {
    pub id: String,
    pub capability: String,
    pub permission_mode: ToolPermissionMode,
    pub risk: ToolRiskLevel,
    pub resource_kind: String,
    pub operation_ids: Vec<String>,
    pub tool_ids: Vec<String>,
    pub targets: Vec<String>,
    pub expires_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanAuthorizationDiagnostic {
    pub hard_deny: bool,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlanAuthorizationDraft {
    pub operations: Vec<PlanAuthorizationOperationDraft>,
    pub permission_bundles: Vec<PlanAuthorizationPermissionBundleDraft>,
    pub diagnostics: Vec<PlanAuthorizationDiagnostic>,
}

pub fn derive_plan_authorization(
    registry: &KernelToolRegistry,
    tasks: &[PlanTaskIntent],
) -> PlanAuthorizationDraft {
    let mut operations = Vec::new();
    let mut diagnostics = Vec::new();
    let mut ensured_directories = BTreeMap::<String, String>::new();
    let mut task_positions = BTreeMap::<String, usize>::new();
    let mut duplicate_task_ids = BTreeSet::<String>::new();
    let mut task_operation_ids = BTreeMap::<String, Vec<String>>::new();

    for (index, task) in tasks.iter().enumerate() {
        if task.task_id.trim().is_empty() {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: false,
                message: "task intent contains an empty taskId".to_string(),
            });
            continue;
        }
        if task_positions.insert(task.task_id.clone(), index).is_some() {
            duplicate_task_ids.insert(task.task_id.clone());
        }
    }
    for task_id in &duplicate_task_ids {
        diagnostics.push(PlanAuthorizationDiagnostic {
            hard_deny: false,
            message: format!("task intent contains duplicate taskId {task_id}"),
        });
    }

    for (task_index, task) in tasks.iter().enumerate() {
        if task.task_id.trim().is_empty() || duplicate_task_ids.contains(&task.task_id) {
            continue;
        }
        let mut dependency_invalid = false;
        let mut dependency_operation_ids = Vec::new();
        for dependency_task_id in &task.depends_on {
            let Some(dependency_index) = task_positions.get(dependency_task_id).copied() else {
                diagnostics.push(PlanAuthorizationDiagnostic {
                    hard_deny: false,
                    message: format!(
                        "plan_authorization_dependency_invalid: task {} references unknown dependency {}",
                        task.task_id, dependency_task_id
                    ),
                });
                dependency_invalid = true;
                continue;
            };
            if duplicate_task_ids.contains(dependency_task_id) || dependency_index >= task_index {
                diagnostics.push(PlanAuthorizationDiagnostic {
                    hard_deny: false,
                    message: format!(
                        "plan_authorization_dependency_invalid: task {} dependency {} must reference a unique earlier task",
                        task.task_id, dependency_task_id
                    ),
                });
                dependency_invalid = true;
                continue;
            }
            if let Some(operation_ids) = task_operation_ids.get(dependency_task_id) {
                dependency_operation_ids.extend(operation_ids.iter().cloned());
            }
        }
        if dependency_invalid {
            continue;
        }
        dependency_operation_ids = dependency_operation_ids
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let Some(template) = registry.template(&task.tool_id) else {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: true,
                message: format!(
                    "toolId {} is not registered in Kernel ToolCatalog",
                    task.tool_id
                ),
            });
            continue;
        };
        if let Err(error) = validate_schema(
            &task.args,
            &template.input.planning_schema,
            &format!("taskIntent.tasks[{task_index}].args"),
        ) {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: false,
                message: format!("plan_args_invalid: {error}"),
            });
            continue;
        }
        if let Some(diagnostic) =
            platform_plan_args_diagnostic(&task.tool_id, &task.args, std::env::consts::OS)
        {
            diagnostics.push(diagnostic);
            continue;
        }
        if template.execution.execution_mode == OperationExecutionMode::Blocked {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: true,
                message: format!(
                    "toolId {} is blocked by its Kernel ToolContract",
                    task.tool_id
                ),
            });
        } else if !template.provider_visible {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: true,
                message: format!(
                    "toolId {} is internal and cannot be requested by an Agent task",
                    task.tool_id
                ),
            });
            continue;
        }
        if task.targets.is_empty()
            && target_is_required(&task.tool_id, template.resource.needs_workspace)
        {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: false,
                message: format!(
                    "task {} toolId {} requires an explicit target",
                    task.task_id, task.tool_id
                ),
            });
            continue;
        }
        if task.tool_id == "fs.rename" && task.targets.len() != 2 {
            diagnostics.push(PlanAuthorizationDiagnostic {
                hard_deny: false,
                message: format!(
                    "task {} fs.rename requires source and destination targets",
                    task.task_id
                ),
            });
            continue;
        }

        let task_operations = expand_task_operations(task, template.resource.plan_target_mode);
        let mut emitted_operation_ids = Vec::new();
        for (operation_id, targets) in task_operations {
            let mut operation_dependencies = dependency_operation_ids.clone();
            if task.tool_id == "fs.create" {
                for target in &targets {
                    let Some(parent) = normalized_parent(target) else {
                        continue;
                    };
                    let ensure_id = ensured_directories
                        .entry(parent.clone())
                        .or_insert_with(|| format!("plan-ensure-dir-{}", stable_segment(&parent)))
                        .clone();
                    operation_dependencies.push(ensure_id.clone());
                    if operations
                        .iter()
                        .any(|operation: &PlanAuthorizationOperationDraft| {
                            operation.id == ensure_id
                        })
                    {
                        continue;
                    }
                    operations.push(operation_draft(
                        registry,
                        OperationDraftInput {
                            id: ensure_id,
                            source_task_id: task.task_id.clone(),
                            tool_id: "fs.ensure_directory",
                            targets: vec![parent],
                            depends_on: dependency_operation_ids.clone(),
                            plan_args: serde_json::json!({}),
                            internal: true,
                            parent_operation_id: Some(operation_id.clone()),
                        },
                    ));
                }
            }
            operation_dependencies = operation_dependencies
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            operations.push(operation_draft(
                registry,
                OperationDraftInput {
                    id: operation_id.clone(),
                    source_task_id: task.task_id.clone(),
                    tool_id: &task.tool_id,
                    targets,
                    depends_on: operation_dependencies,
                    plan_args: task.args.clone(),
                    internal: false,
                    parent_operation_id: None,
                },
            ));
            emitted_operation_ids.push(operation_id);
        }
        task_operation_ids.insert(task.task_id.clone(), emitted_operation_ids);
    }

    let permission_bundles = permission_bundles(registry, &operations);
    PlanAuthorizationDraft {
        operations,
        permission_bundles,
        diagnostics,
    }
}

fn platform_plan_args_diagnostic(
    tool_id: &str,
    args: &Value,
    platform: &str,
) -> Option<PlanAuthorizationDiagnostic> {
    (platform == "windows"
        && tool_id == "fs.create"
        && args
            .get("executable")
            .and_then(Value::as_bool)
            .unwrap_or(false))
    .then(|| PlanAuthorizationDiagnostic {
        hard_deny: false,
        message:
            "unsupported_file_attribute: fs.create executable=true is not supported on native Windows"
                .to_string(),
    })
}

fn expand_task_operations(
    task: &PlanTaskIntent,
    target_mode: PlanTargetMode,
) -> Vec<(String, Vec<String>)> {
    match target_mode {
        PlanTargetMode::PerTarget => task
            .targets
            .iter()
            .enumerate()
            .map(|(index, target)| {
                (
                    format!("plan-op-{}-{}", task.task_id, index + 1),
                    vec![target.clone()],
                )
            })
            .collect(),
        PlanTargetMode::SourceDestination | PlanTargetMode::Aggregate => {
            vec![(format!("plan-op-{}", task.task_id), task.targets.clone())]
        }
    }
}

struct OperationDraftInput<'a> {
    id: String,
    source_task_id: String,
    tool_id: &'a str,
    targets: Vec<String>,
    depends_on: Vec<String>,
    plan_args: Value,
    internal: bool,
    parent_operation_id: Option<String>,
}

fn operation_draft(
    registry: &KernelToolRegistry,
    input: OperationDraftInput<'_>,
) -> PlanAuthorizationOperationDraft {
    let OperationDraftInput {
        id,
        source_task_id,
        tool_id,
        targets,
        depends_on,
        plan_args,
        internal,
        parent_operation_id,
    } = input;
    let template = registry
        .template(tool_id)
        .expect("plan authorization operations use registered tools");
    let read_set = if template.resource.read_set_source != "none" {
        targets.clone()
    } else {
        Vec::new()
    };
    let write_set = if template.resource.write_set_source == "none" {
        Vec::new()
    } else {
        targets.clone()
    };
    let conflict_keys = read_set
        .iter()
        .chain(write_set.iter())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    PlanAuthorizationOperationDraft {
        id,
        source_task_id,
        tool_id: tool_id.to_string(),
        depends_on,
        fixed_args: canonical_plan_args(tool_id, &plan_args),
        args_template: args_template(tool_id, &targets, &plan_args),
        targets,
        read_set,
        write_set,
        conflict_keys,
        execution_mode: template.execution.execution_mode,
        internal,
        parent_operation_id,
    }
}

fn canonical_plan_args(tool_id: &str, plan_args: &Value) -> Value {
    if tool_id == "fs.create" {
        return serde_json::json!({
            "executable": plan_args
                .get("executable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    plan_args.clone()
}

fn permission_bundles(
    registry: &KernelToolRegistry,
    operations: &[PlanAuthorizationOperationDraft],
) -> Vec<PlanAuthorizationPermissionBundleDraft> {
    let mut grouped = BTreeMap::<String, PlanAuthorizationPermissionBundleDraft>::new();
    for operation in operations {
        let Some(template) = registry.template(&operation.tool_id) else {
            continue;
        };
        let key = if template.permission.bundle_key == "none" {
            format!("allow-{}", operation.tool_id)
        } else {
            template.permission.bundle_key.to_string()
        };
        let bundle =
            grouped
                .entry(key.clone())
                .or_insert_with(|| PlanAuthorizationPermissionBundleDraft {
                    id: format!("plan-permission-{key}"),
                    capability: template.permission.capability.to_string(),
                    permission_mode: template.permission.mode,
                    risk: template.permission.risk,
                    resource_kind: permission_resource_kind(template.family).to_string(),
                    operation_ids: Vec::new(),
                    tool_ids: Vec::new(),
                    targets: Vec::new(),
                    expires_after: "planReviewOrRunTerminal".to_string(),
                });
        bundle.permission_mode =
            stricter_permission_mode(bundle.permission_mode, template.permission.mode);
        bundle.risk = higher_risk(bundle.risk, template.permission.risk);
        bundle.operation_ids.push(operation.id.clone());
        if !bundle.tool_ids.contains(&operation.tool_id) {
            bundle.tool_ids.push(operation.tool_id.clone());
        }
        for target in &operation.targets {
            if !bundle.targets.contains(target) {
                bundle.targets.push(target.clone());
            }
        }
    }
    grouped.into_values().collect()
}

fn args_template(tool_id: &str, targets: &[String], plan_args: &Value) -> Value {
    let path = targets.first().cloned();
    match tool_id {
        "fs.create" => serde_json::json!({
            "path": path,
            "contentBlockId": "executionTime",
            "executable": plan_args
                .get("executable")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }),
        "fs.write" => serde_json::json!({
            "path": path,
            "contentBlockId": "executionTime",
        }),
        "fs.edit" => serde_json::json!({
            "path": path,
            "replacementBlockId": "executionTime",
            "patchSpec": "executionTime",
        }),
        "fs.rename" => serde_json::json!({
            "path": targets.first(),
            "destinationPath": targets.get(1),
        }),
        "fs.delete" => serde_json::json!({
            "path": path,
            "targetKind": "kernelResolved",
            "recursive": "kernelResolved",
        }),
        "fs.ensure_directory" => serde_json::json!({
            "path": path,
            "targetKind": "directory",
        }),
        _ => serde_json::json!({ "targets": targets }),
    }
}

fn target_is_required(tool_id: &str, needs_workspace: bool) -> bool {
    needs_workspace && !matches!(tool_id, "git.status" | "git.diff")
}

fn normalized_parent(target: &str) -> Option<String> {
    let normalized = target.trim().replace('\\', "/");
    let parent = Path::new(&normalized)
        .parent()?
        .to_string_lossy()
        .replace('\\', "/");
    (!parent.is_empty() && parent != ".").then_some(parent)
}

fn stable_segment(value: &str) -> String {
    crate::hash_bytes(value.as_bytes())
        .trim_start_matches("sha256:")
        .chars()
        .take(16)
        .collect()
}

fn permission_resource_kind(family: ToolFamily) -> &'static str {
    match family {
        ToolFamily::Workspace | ToolFamily::Document => "workspacePath",
        ToolFamily::Git => "gitWorkspace",
        ToolFamily::Process => "process",
        ToolFamily::Network => "networkTarget",
        ToolFamily::Browser => "browserState",
        ToolFamily::Provider => "providerProfile",
    }
}

fn stricter_permission_mode(
    left: ToolPermissionMode,
    right: ToolPermissionMode,
) -> ToolPermissionMode {
    use ToolPermissionMode::{Allow, Ask, Deny};
    match (left, right) {
        (Deny, _) | (_, Deny) => Deny,
        (Ask, _) | (_, Ask) => Ask,
        (Allow, Allow) => Allow,
    }
}

fn higher_risk(left: ToolRiskLevel, right: ToolRiskLevel) -> ToolRiskLevel {
    fn rank(value: ToolRiskLevel) -> u8 {
        match value {
            ToolRiskLevel::Low => 0,
            ToolRiskLevel::Medium => 1,
            ToolRiskLevel::High => 2,
            ToolRiskLevel::Critical => 3,
        }
    }
    if rank(left) >= rank(right) {
        left
    } else {
        right
    }
}

#[cfg(test)]
mod platform_tests {
    use super::*;

    #[test]
    fn native_windows_rejects_executable_create_during_plan_admission() {
        let diagnostic = platform_plan_args_diagnostic(
            "fs.create",
            &serde_json::json!({ "executable": true }),
            "windows",
        )
        .expect("native Windows must reject POSIX executable mode");
        assert!(diagnostic
            .message
            .starts_with("unsupported_file_attribute:"));
        assert!(platform_plan_args_diagnostic(
            "fs.create",
            &serde_json::json!({ "executable": false }),
            "windows",
        )
        .is_none());
    }
}
