use super::*;
use crate::resources::remove_registered_temp_file;

struct ToolResourceEffect<'a> {
    run_id: &'a str,
    session_id: &'a str,
    operation_kind: ToolOperationKind,
    arguments: &'a Value,
}

struct PendingTempArtifactGuard<'a> {
    runtime: &'a DeepCodeKernelRuntime,
    run_id: String,
    session_id: String,
    resource_id: String,
    committed: bool,
}

impl PendingTempArtifactGuard<'_> {
    fn commit(mut self) {
        self.committed = true;
    }

    fn rollback(&mut self) -> KernelResult<()> {
        if self.committed {
            return Ok(());
        }
        self.committed = true;
        self.runtime.cleanup_failed_managed_temp_resource(
            &self.run_id,
            &self.session_id,
            &self.resource_id,
        )
    }
}

impl Drop for PendingTempArtifactGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.rollback();
        }
    }
}

impl DeepCodeKernelRuntime {
    pub(crate) fn execute_bound_tool(
        &self,
        run_id: &str,
        session_id: &str,
        tool_call_id: String,
        tool_name: String,
        operation_kind: ToolOperationKind,
        arguments: Value,
    ) -> KernelResult<KernelEvent> {
        let registered_kind = self
            .tool_registry
            .get(&tool_name)
            .map(KernelToolRegistration::operation_kind)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!("unknown Kernel tool {tool_name}"))
            })?;
        if registered_kind != operation_kind {
            return Err(KernelError::InvalidCommand(format!(
                "Kernel tool {tool_name} operation kind mismatch: expected {}, got {}",
                registered_kind.wire_name(),
                operation_kind.wire_name()
            )));
        }
        let (mut pending_temp, mut result) = match self
            .register_managed_temp_resource_before_execution(
                run_id,
                session_id,
                &tool_call_id,
                &tool_name,
                operation_kind,
                &arguments,
            ) {
            Ok(pending_temp) => {
                let result = self
                    .execute_kernel_tool(run_id, &tool_name, &arguments)
                    .and_then(|mut output| {
                        self.attach_workspace_tool_diagnostics(
                            run_id,
                            operation_kind,
                            &arguments,
                            &mut output,
                        )?;
                        attach_agent_generated_artifact_metadata(
                            run_id,
                            session_id,
                            &tool_call_id,
                            operation_kind,
                            &arguments,
                            &mut output,
                        );
                        self.record_kernel_resource_effects(ToolResourceEffect {
                            run_id,
                            session_id,
                            operation_kind,
                            arguments: &arguments,
                        })?;
                        Ok(output)
                    });
                (pending_temp, result)
            }
            Err(error) => (None, Err(error)),
        };
        if result.is_ok() {
            if let Some(guard) = pending_temp.take() {
                guard.commit();
            }
        } else if let Some(mut guard) = pending_temp.take() {
            if let Err(cleanup_error) = guard.rollback() {
                let original_error = result
                    .as_ref()
                    .err()
                    .map(ToString::to_string)
                    .unwrap_or_else(|| "tool execution failed".to_string());
                result = Err(KernelError::Structured {
                        code: "temporary_resource_cleanup_failed",
                        stage: "tool.execute.cleanup",
                        message: format!(
                            "tool execution failed and its managed temporary resource could not be cleaned: {cleanup_error}"
                        ),
                        details: serde_json::json!({
                            "toolId": tool_name,
                            "toolCallId": tool_call_id,
                            "resourceId": guard.resource_id,
                            "executionError": original_error,
                            "cleanupError": cleanup_error.to_string(),
                        }),
                    });
            }
        }
        let sequence = self.ledger.next_sequence(run_id)?;
        let completion_fact = ToolCompletionFact {
            tool_call_id: tool_call_id.clone(),
            tool_id: tool_name.clone(),
            operation_kind,
            ok: result.is_ok(),
            output: result.as_ref().ok().cloned(),
            error: result.as_ref().err().map(Into::into),
        };
        let event = KernelEvent::ToolCompleted {
            run_id: Some(RunId(run_id.to_string())),
            session_id: Some(SessionId(session_id.to_string())),
            turn_id: None,
            fact: completion_fact.clone(),
            sequence: Some(sequence),
        };
        self.append_ledger(
            run_id,
            session_id,
            "tool.completed",
            sequence,
            serde_json::to_value(&completion_fact).map_err(|error| {
                KernelError::InvalidCommand(format!("encode tool completion fact: {error}"))
            })?,
        )?;
        if let Ok(output) = result.as_ref() {
            self.record_change_operation_for_tool(
                run_id,
                session_id,
                &tool_call_id,
                &tool_name,
                &arguments,
            )?;
            self.record_validation_for_tool(run_id, session_id, &tool_call_id, &tool_name, output)?;
        }
        Ok(event)
    }

    fn register_managed_temp_resource_before_execution(
        &self,
        run_id: &str,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        operation_kind: ToolOperationKind,
        arguments: &Value,
    ) -> KernelResult<Option<PendingTempArtifactGuard<'_>>> {
        if !is_managed_temp_file(arguments) {
            return Ok(None);
        }
        let path = arguments
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| {
                KernelError::InvalidCommand(
                    "managed temporary file operation requires path".to_string(),
                )
            })?;
        if operation_kind == ToolOperationKind::FsWrite {
            let logical_key = run_temp_logical_key(run_id, path);
            if self
                .state
                .resource_manager
                .active_by_logical_key(&logical_key)
                .is_empty()
            {
                return Err(KernelError::Structured {
                    code: "temporary_resource_unavailable",
                    stage: "tool.execute.admission",
                    message: "fs.write temporary=true requires an active temporary artifact lease"
                        .to_string(),
                    details: serde_json::json!({
                        "toolId": tool_name,
                        "path": path,
                        "runId": run_id,
                    }),
                });
            }
            return Ok(None);
        }
        if operation_kind != ToolOperationKind::FsCreate {
            return Ok(None);
        }
        let absolute_path = self
            .tool_workspace_root(run_id, tool_name, arguments)?
            .map(PathBuf::from)
            .ok_or_else(|| {
                KernelError::InvalidCommand(
                    "managed temporary file operation requires a workspace root".to_string(),
                )
            })
            .and_then(|root| WorkspaceBoundary::new(root).resolve_mutation(path))?;
        let resource_id = resource_instance_id("agent-temp", &[run_id, tool_call_id, path]);
        self.acquire_resource_batch(
            run_id,
            session_id,
            &format!("Kernel registered workflow temp resource before execution: {path}"),
            vec![KernelResource::active(
                KernelResourceIdentity::new(
                    resource_id.clone(),
                    run_temp_logical_key(run_id, path),
                    format!("agent-temp:{run_id}:{tool_call_id}:{path}"),
                ),
                KernelResourceKind::TempArtifact,
                KernelResourceOwner::agent_run(Some(session_id.to_string()), run_id.to_string()),
                KernelResourceScope::Run,
                KernelResourceCleanupPolicy::OnBatchReviewReady,
                KernelResourceMetadata::TempArtifact {
                    path: path.to_string(),
                    absolute_path: Some(absolute_path.to_string_lossy().into_owned()),
                    source_tool: tool_name.to_string(),
                    tool_call_id: tool_call_id.to_string(),
                },
            )],
        )?;
        Ok(Some(PendingTempArtifactGuard {
            runtime: self,
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            resource_id,
            committed: false,
        }))
    }

    fn cleanup_failed_managed_temp_resource(
        &self,
        run_id: &str,
        session_id: &str,
        resource_id: &str,
    ) -> KernelResult<()> {
        let resource = self
            .state
            .resource_manager
            .get(resource_id)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "managed temporary resource {resource_id} is unavailable"
                ))
            })?;
        if let Err(error) = remove_registered_temp_file(&resource) {
            let sequence = self.ledger.next_sequence(run_id)?;
            self.append_ledger(
                run_id,
                session_id,
                "resource.cleanup_failed",
                sequence,
                serde_json::json!({
                    "summary": "Kernel failed to roll back an uncommitted temporary resource.",
                    "resourceId": &resource.resource_id,
                    "kind": &resource.kind,
                    "reason": "toolExecutionFailed",
                    "error": error.to_string()
                }),
            )?;
            return Err(error);
        }
        let sequence = self.ledger.next_sequence(run_id)?;
        self.state
            .resource_manager
            .release(resource_id, |released_resource| {
                self.append_ledger(
                    run_id,
                    session_id,
                    "resource.released",
                    sequence,
                    serde_json::json!({
                        "summary": "Kernel released a failed managed temporary resource.",
                        "resourceId": released_resource.resource_id,
                        "resource": released_resource,
                        "released": true,
                        "error": null
                    }),
                )
            })?;
        Ok(())
    }

    fn record_kernel_resource_effects(&self, effect: ToolResourceEffect<'_>) -> KernelResult<()> {
        let ToolResourceEffect {
            run_id,
            session_id,
            operation_kind,
            arguments,
        } = effect;
        let Some(path) = arguments.get("path").and_then(Value::as_str) else {
            return Ok(());
        };
        if !is_managed_temp_file(arguments) {
            return Ok(());
        }

        if operation_kind == ToolOperationKind::FsDelete {
            let logical_key = run_temp_logical_key(run_id, path);
            for resource in self
                .state
                .resource_manager
                .active_by_logical_key(&logical_key)
            {
                let sequence = self.ledger.next_sequence(run_id)?;
                self.state.resource_manager.release(
                    &resource.resource_id,
                    |released_resource| {
                        self.append_ledger(
                            run_id,
                            session_id,
                            "resource.released",
                            sequence,
                            serde_json::json!({
                                "summary": format!("Kernel released workflow temp resource: {path}"),
                                "resourceId": released_resource.resource_id,
                                "resource": released_resource,
                                "released": true,
                                "error": null
                            }),
                        )
                    },
                )?;
            }
        }
        Ok(())
    }

    pub(crate) fn execute_kernel_tool(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<Value> {
        let workspace_root = self.tool_workspace_root(run_id, tool_name, arguments)?;
        let result = self.tool_executors.invoke(
            tool_name,
            executors::KernelToolInvocation {
                id: format!("tool-{tool_name}"),
                tool_id: tool_name.to_string(),
                input: arguments.clone(),
            },
            executors::KernelToolExecutionContext { workspace_root },
        )?;
        Ok(result.output)
    }

    pub(crate) fn execute_host_projection_operation(
        &self,
        operation_kind: ToolOperationKind,
        arguments: Value,
    ) -> KernelResult<Value> {
        let descriptor = self
            .tool_registry
            .get_by_operation_kind(operation_kind)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "unknown Kernel operation kind {}",
                    operation_kind.wire_name()
                ))
            })?;
        let tool_id = descriptor.tool_id();
        if !descriptor.read_only() || descriptor.execution_mode() != OperationExecutionMode::Execute
        {
            return Err(KernelError::PermissionDenied(format!(
                "Host inspection may only use executable read-only tools; {tool_id} is not eligible"
            )));
        }
        let workspace_root = self
            .current_workspace()
            .map(|workspace| workspace.root.to_string_lossy().to_string())?;
        let result = self.tool_executors.invoke(
            tool_id,
            executors::KernelToolInvocation {
                id: format!("host-projection-{tool_id}"),
                tool_id: tool_id.to_string(),
                input: arguments,
            },
            executors::KernelToolExecutionContext {
                workspace_root: Some(workspace_root),
            },
        )?;
        Ok(result.output)
    }

    fn tool_workspace_root(
        &self,
        run_id: &str,
        tool_name: &str,
        arguments: &Value,
    ) -> KernelResult<Option<String>> {
        if let Some(root) = arguments
            .get("kernelExecutionRoot")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            if !self
                .tool_registry
                .needs_workspace(tool_name)
                .unwrap_or(true)
            {
                return Err(KernelError::PermissionDenied(
                    "kernelExecutionRoot is only allowed for Kernel-compiled workspace tools"
                        .to_string(),
                ));
            }
            if arguments.get("kernelContext").is_none() {
                return Err(KernelError::PermissionDenied(
                    "kernelExecutionRoot requires Kernel actionBatch context".to_string(),
                ));
            }
            let root_path = PathBuf::from(root);
            if !root_path.is_dir() {
                return Err(KernelError::InvalidCommand(format!(
                    "kernelExecutionRoot is not a directory: {root}"
                )));
            }
            return Ok(Some(root.to_string()));
        }
        if let Some(root) = arguments
            .get("attachmentRoot")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            self.validate_attachment_tool_root(run_id, tool_name, root, arguments)?;
            return Ok(Some(root.to_string()));
        }
        Ok(self
            .record_by_run(run_id)?
            .workspace_binding
            .open_path
            .clone())
    }

    fn validate_attachment_tool_root(
        &self,
        run_id: &str,
        tool_name: &str,
        root: &str,
        arguments: &Value,
    ) -> KernelResult<()> {
        let template = self.tool_registry.contract(tool_name).ok_or_else(|| {
            KernelError::PermissionDenied(format!("unknown Kernel tool {tool_name}"))
        })?;
        if !template.resource.needs_workspace || !template.resource.read_only {
            return Err(KernelError::PermissionDenied(
                "attachmentRoot is only allowed for read-only workspace tools".to_string(),
            ));
        }
        let record = self.record_by_run(run_id)?;
        let root = PathBuf::from(root)
            .canonicalize()
            .map_err(|error| KernelError::InvalidCommand(format!("attachmentRoot: {error}")))?;
        let relative = arguments
            .get("path")
            .or_else(|| arguments.get("include"))
            .and_then(Value::as_str)
            .unwrap_or(".");
        let target = WorkspaceBoundary::new(&root).resolve_read(relative)?;
        let allowed = record
            .attachments
            .iter()
            .any(|attachment| explicit_attachment_allows_target(attachment, &root, &target));
        if !allowed {
            return Err(KernelError::PermissionDenied(
                "attachmentRoot must match an explicit user attachment".to_string(),
            ));
        }
        Ok(())
    }

    fn attach_workspace_tool_diagnostics(
        &self,
        run_id: &str,
        operation_kind: ToolOperationKind,
        arguments: &Value,
        output: &mut Value,
    ) -> KernelResult<()> {
        if !operation_kind.has_workspace_path() {
            return Ok(());
        }
        let diagnostic_root = arguments
            .get("kernelExecutionRoot")
            .and_then(Value::as_str)
            .map(PathBuf::from)
            .or_else(|| {
                arguments
                    .get("attachmentRoot")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
            })
            .or_else(|| {
                self.record_by_run(run_id)
                    .ok()
                    .and_then(|record| record.workspace_binding.open_path)
                    .map(PathBuf::from)
            });
        let Some(diagnostic_root) = diagnostic_root else {
            return Ok(());
        };
        if let Some(object) = output.as_object_mut() {
            object.insert(
                "workspaceRoot".to_string(),
                Value::String(diagnostic_root.to_string_lossy().to_string()),
            );
            if let Some(path) = arguments.get("path").and_then(Value::as_str) {
                let boundary = WorkspaceBoundary::new(&diagnostic_root);
                let target = if operation_kind.is_workspace_mutation() {
                    boundary.resolve_mutation(path)
                } else {
                    boundary.resolve_read(path)
                };
                if let Ok(target) = target {
                    object.insert(
                        "absolutePath".to_string(),
                        Value::String(target.to_string_lossy().to_string()),
                    );
                    if operation_kind == ToolOperationKind::FsWrite {
                        let expected = arguments
                            .get("content")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        let actual = fs::read(&target).map_err(|error| {
                            KernelError::Other(format!("read back {path}: {error}"))
                        })?;
                        let expected_hash = deepcode_kernel_tools::hash_bytes(expected.as_bytes());
                        let actual_hash = deepcode_kernel_tools::hash_bytes(&actual);
                        object.insert(
                            "validation".to_string(),
                            serde_json::json!({
                                "kind": "readBack",
                                "passed": actual == expected.as_bytes(),
                                "path": path,
                                "contentBytes": actual.len(),
                                "contentHash": actual_hash,
                                "expectedContentBytes": expected.len(),
                                "expectedContentHash": expected_hash
                            }),
                        );
                    } else if operation_kind == ToolOperationKind::FsEdit {
                        let old_hash = object
                            .get("oldContentHash")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let new_hash = object
                            .get("newContentHash")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let changed_ranges =
                            object.get("changedRanges").cloned().unwrap_or(Value::Null);
                        object.insert(
                            "validation".to_string(),
                            serde_json::json!({
                                "kind": "patchReadBack",
                                "passed": target.is_file(),
                                "path": path,
                                "oldContentHash": old_hash,
                                "newContentHash": new_hash,
                                "changedRanges": changed_ranges
                            }),
                        );
                    } else if operation_kind == ToolOperationKind::FsDelete {
                        object.insert(
                            "validation".to_string(),
                            serde_json::json!({
                                "kind": "deleteVerified",
                                "passed": !target.exists(),
                                "path": path,
                                "exists": target.exists()
                            }),
                        );
                    }
                }
            }
        }
        Ok(())
    }
}
fn attach_agent_generated_artifact_metadata(
    run_id: &str,
    session_id: &str,
    tool_call_id: &str,
    operation_kind: ToolOperationKind,
    arguments: &Value,
    output: &mut Value,
) {
    if !matches!(
        operation_kind,
        ToolOperationKind::FsCreate
            | ToolOperationKind::FsWrite
            | ToolOperationKind::FsEdit
            | ToolOperationKind::FsRename
            | ToolOperationKind::FsDelete
    ) {
        return;
    }
    let Some(object) = output.as_object_mut() else {
        return;
    };
    object.insert(
        "operationOrigin".to_string(),
        Value::String("agentRequested".to_string()),
    );
    if operation_kind == ToolOperationKind::FsCreate {
        object.insert(
            "artifactOrigin".to_string(),
            Value::String("agentGenerated".to_string()),
        );
    }
    if arguments
        .get("temporary")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        object.insert("temporary".to_string(), Value::Bool(true));
    }
    object.insert("runId".to_string(), Value::String(run_id.to_string()));
    object.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    object.insert(
        "toolCallId".to_string(),
        Value::String(tool_call_id.to_string()),
    );
    if let Some(context) = arguments.get("kernelContext") {
        object.insert("kernelContext".to_string(), context.clone());
        if let Some(plan_id) = context.get("planId").and_then(Value::as_str) {
            object.insert("planId".to_string(), Value::String(plan_id.to_string()));
        }
        if let Some(work_unit_id) = context.get("workUnitId").and_then(Value::as_str) {
            object.insert(
                "workUnitId".to_string(),
                Value::String(work_unit_id.to_string()),
            );
        }
        if let Some(action_id) = context.get("actionId").and_then(Value::as_str) {
            object.insert("actionId".to_string(), Value::String(action_id.to_string()));
        }
        if let Some(operation_kind) = context.get("operationKind").and_then(Value::as_str) {
            object.insert(
                "operation".to_string(),
                Value::String(operation_kind.to_string()),
            );
        }
    }
    if let Some(path_normalization) = arguments.get("pathNormalization") {
        object.insert("pathNormalization".to_string(), path_normalization.clone());
        if let Some(normalized) = path_normalization
            .get("normalizedTargetPath")
            .and_then(Value::as_str)
        {
            object.insert(
                "normalizedTargetPath".to_string(),
                Value::String(normalized.to_string()),
            );
        }
        if let Some(duplicate) = path_normalization
            .get("duplicateRootPathDetected")
            .and_then(Value::as_bool)
        {
            object.insert(
                "duplicateRootPathDetected".to_string(),
                Value::Bool(duplicate),
            );
        }
    }
    if operation_kind == ToolOperationKind::FsWrite {
        let validation = object.get("validation").and_then(Value::as_object).cloned();
        if let Some(validation) = validation {
            if let Some(hash) = validation.get("contentHash").and_then(Value::as_str) {
                object.insert("contentHash".to_string(), Value::String(hash.to_string()));
            }
            if let Some(bytes) = validation.get("contentBytes").and_then(Value::as_u64) {
                object.insert(
                    "contentBytes".to_string(),
                    Value::Number(serde_json::Number::from(bytes)),
                );
            }
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PermissionAction {
    Allow,
    Ask,
    Deny,
}

impl DeepCodeKernelRuntime {
    pub(crate) fn permission_action_for_kernel_tool(&self, tool_id: &str) -> PermissionAction {
        match self.tool_registry.permission_mode_for_tool(tool_id) {
            Some(ToolPermissionMode::Allow) => PermissionAction::Allow,
            Some(ToolPermissionMode::Ask) => PermissionAction::Ask,
            Some(ToolPermissionMode::Deny) | None => PermissionAction::Deny,
        }
    }
}

fn explicit_attachment_allows_target(attachment: &Value, root: &Path, target: &Path) -> bool {
    let source = attachment
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(source, "userSelected" | "contextMenu" | "mention") {
        return false;
    }
    let Some(absolute_path) = attachment
        .get("absolutePath")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let Ok(attachment_path) = PathBuf::from(absolute_path).canonicalize() else {
        return false;
    };
    let kind = attachment
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("file");
    if kind == "directory" {
        root == attachment_path && target.starts_with(&attachment_path)
    } else {
        attachment_path
            .parent()
            .map(|parent| parent == root && target == attachment_path)
            .unwrap_or(false)
    }
}

impl DeepCodeKernelRuntime {
    pub(crate) fn capability_for_tool(&self, tool_id: &str) -> KernelResult<&'static str> {
        self.tool_registry
            .capability_for_tool(tool_id)
            .ok_or_else(|| {
                KernelError::InvalidCommand(format!(
                    "Kernel ToolCatalog does not register toolId {tool_id}"
                ))
            })
    }

    pub(crate) fn risk_for_tool(
        &self,
        tool_id: &str,
    ) -> KernelResult<deepcode_kernel_tools::ToolRiskLevel> {
        self.tool_registry.risk_for_tool(tool_id).ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "Kernel ToolCatalog does not register toolId {tool_id}"
            ))
        })
    }
}

pub(crate) fn redact_tool_arguments(operation_kind: ToolOperationKind, arguments: &Value) -> Value {
    match operation_kind {
        ToolOperationKind::FsWrite | ToolOperationKind::FsDiff => {
            let content = arguments
                .get("content")
                .or_else(|| arguments.get("newContent"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "path": arguments.get("path").cloned().unwrap_or(Value::Null),
                "contentBytes": content.len(),
                "contentHash": deepcode_kernel_tools::hash_bytes(content.as_bytes())
            })
        }
        ToolOperationKind::FsEdit => {
            let content = arguments
                .get("replacement")
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "path": arguments.get("path").cloned().unwrap_or(Value::Null),
                "replacementBytes": content.len(),
                "replacementHash": deepcode_kernel_tools::hash_bytes(content.as_bytes()),
                "patchSpec": arguments.get("patchSpec").cloned().unwrap_or(Value::Null)
            })
        }
        ToolOperationKind::BrowserType => {
            let text = arguments
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default();
            serde_json::json!({
                "selector": arguments.get("selector").cloned().unwrap_or(Value::Null),
                "textPreview": limit_preview(text, 80),
                "textBytes": text.len(),
                "textHash": deepcode_kernel_tools::hash_bytes(text.as_bytes())
            })
        }
        _ => arguments.clone(),
    }
}

fn limit_preview(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    format!("{}…", value.chars().take(max_chars).collect::<String>())
}

fn run_temp_logical_key(run_id: &str, path: &str) -> String {
    format!("agent-temp:{run_id}:{}", path.replace('\\', "/"))
}

fn is_managed_temp_file(arguments: &Value) -> bool {
    arguments
        .get("temporary")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

pub(crate) fn get_string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}
