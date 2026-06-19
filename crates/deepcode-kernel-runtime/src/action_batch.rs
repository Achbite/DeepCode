use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn action_batch_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        batch: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let run_id_text = run_id.0.clone();
        let record = self.record_by_run(&run_id_text)?.clone();
        let session_id_text = session_id
            .map(|value| value.0)
            .unwrap_or_else(|| record.session_id.clone());
        let batch_summary = summarize_action_batch(&batch);
        let accepted_sequence = self.ledger.next_sequence(&run_id_text)?;
        self.append_ledger(
            &run_id_text,
            &session_id_text,
            "action_batch.accepted",
            accepted_sequence,
            serde_json::json!({
                "summary": "Action batch accepted for Kernel execution.",
                "batch": &batch_summary
            }),
        )?;

        let mut events = vec![KernelEvent::ActionBatchAccepted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id_text.clone()),
            session_id: Some(SessionId(session_id_text.clone())),
            batch: batch_summary,
            sequence: Some(accepted_sequence),
        }];

        let compiler = OperationCompiler::default();
        let plan_id = batch
            .get("planId")
            .or_else(|| {
                compiler
                    .action_bundle_value(&batch)
                    .and_then(|bundle| bundle.get("id"))
            })
            .and_then(Value::as_str)
            .unwrap_or("action-batch")
            .to_string();
        let mut has_pending_permission = false;

        let operations = match compiler.compile_batch(&batch) {
            Ok(operations) => operations,
            Err(OperationCompileError::EmptyActions) => {
                let work_unit_id = format!("work-unit-{}-empty", safe_work_unit_segment(&plan_id));
                events.push(self.work_unit_blocked_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    "action batch has no actions",
                )?);
                return Ok(events);
            }
            Err(error) => {
                let work_unit_id =
                    format!("work-unit-{}-compile", safe_work_unit_segment(&plan_id));
                events.push(self.work_unit_failed_envelope_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    KernelErrorEnvelope {
                        code: "operation_compile_failed".to_string(),
                        message: error.to_string(),
                        message_key: None,
                        args: None,
                    },
                )?);
                return Ok(events);
            }
        };

        if operations.is_empty() {
            let work_unit_id = format!("work-unit-{}-empty", safe_work_unit_segment(&plan_id));
            events.push(self.work_unit_blocked_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                &work_unit_id,
                "action batch has no actions",
            )?);
            return Ok(events);
        }

        let work_unit_graph = WorkUnitGraph::from_operations(&operations);
        let graph_sequence = self.ledger.next_sequence(&run_id_text)?;
        self.append_ledger(
            &run_id_text,
            &session_id_text,
            "work_unit.graph",
            graph_sequence,
            serde_json::json!({
                "summary": "Kernel compiled action batch into a WorkUnitGraph.",
                "planId": &plan_id,
                "workUnitGraph": &work_unit_graph
            }),
        )?;

        for operation in operations.iter() {
            let action_id = operation.id.clone();
            let work_unit_id = format!(
                "work-unit-{}-{}",
                safe_work_unit_segment(&plan_id),
                safe_work_unit_segment(&action_id)
            );
            let capability = operation.capability.as_str();
            let kind = operation_kind_name(operation);
            let work_unit = serde_json::json!({
                "id": &work_unit_id,
                "planId": &plan_id,
                "actionId": &action_id,
                "title": &operation.title,
                "capability": capability,
                "kind": kind,
                "readSet": &operation.read_set,
                "writeSet": &operation.write_set,
                "conflictKeys": &operation.conflict_keys,
                "executionMode": operation.execution_mode,
                "status": "queued"
            });
            events.push(self.work_unit_queued_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                work_unit,
            )?);
            events.push(self.work_unit_started_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                &work_unit_id,
            )?);

            if operation.execution_mode != OperationExecutionMode::Execute {
                events.push(self.work_unit_blocked_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    &format!(
                        "capability is not executable in the current Kernel policy slice: {capability}"
                    ),
                )?);
                continue;
            }

            let mut compiled = match compile_operation(self, &record, operation) {
                Ok(compiled) => compiled,
                Err(error) => {
                    events.push(self.work_unit_failed_event(
                        &request_id,
                        &run_id_text,
                        &session_id_text,
                        &work_unit_id,
                        &error,
                    )?);
                    continue;
                }
            };
            attach_kernel_context_to_arguments(
                &mut compiled.arguments,
                &plan_id,
                &work_unit_id,
                &action_id,
                kind,
            );

            if let Some(root) = compiled.workspace_root.as_ref() {
                let mut workspace_events = self.workspace_open(
                    RequestId(format!(
                        "action-batch-workspace-{}",
                        safe_work_unit_segment(&work_unit_id)
                    )),
                    root.to_string_lossy().to_string(),
                )?;
                events.append(&mut workspace_events);
            }

            let tool_call_id = format!(
                "{work_unit_id}-{}",
                safe_work_unit_segment(&compiled.tool_name)
            );
            if self.effective_permission_action_for_tool(
                &run_id_text,
                &compiled.tool_name,
                &compiled.arguments,
            )? == PermissionAction::Ask
            {
                has_pending_permission = true;
                let request_sequence = self.ledger.next_sequence(&run_id_text)?;
                let requested = KernelEvent::ToolRequested {
                    run_id: Some(RunId(run_id_text.clone())),
                    session_id: Some(SessionId(session_id_text.clone())),
                    turn_id: None,
                    tool_call_id: tool_call_id.clone(),
                    tool_name: compiled.tool_name.clone(),
                    args_preview: redact_tool_arguments(&compiled.tool_name, &compiled.arguments),
                    sequence: Some(request_sequence),
                };
                self.append_ledger(
                    &run_id_text,
                    &session_id_text,
                    "tool.requested",
                    request_sequence,
                    serde_json::json!({
                        "summary": format!("Tool requested: {}", compiled.tool_name),
                        "toolCallId": &tool_call_id,
                        "toolName": &compiled.tool_name,
                        "argsPreview": redact_tool_arguments(&compiled.tool_name, &compiled.arguments)
                    }),
                )?;
                events.push(requested);

                let permission_id = tool_call_id.clone();
                self.state.pending_tools.insert(
                    permission_id.clone(),
                    PendingKernelTool {
                        run_id: run_id_text.clone(),
                        session_id: session_id_text.clone(),
                        tool_name: compiled.tool_name.clone(),
                        arguments: compiled.arguments.clone(),
                        request_id: Some(request_id.0.clone()),
                        work_unit_id: Some(work_unit_id.clone()),
                        action_id: Some(action_id.clone()),
                        plan_id: Some(plan_id.clone()),
                        operation_kind: Some(kind.to_string()),
                        read_set: operation.read_set.clone(),
                        write_set: operation.write_set.clone(),
                    },
                );
                let permission_sequence = self.ledger.next_sequence(&run_id_text)?;
                let permission = KernelEvent::PermissionRequested {
                    run_id: Some(RunId(run_id_text.clone())),
                    session_id: SessionId(session_id_text.clone()),
                    request: deepcode_kernel_abi::PermissionRequestEnvelope {
                        id: permission_id.clone(),
                        capability: capability_for_tool(&compiled.tool_name).to_string(),
                        risk_level: risk_for_tool(&compiled.tool_name).to_string(),
                        summary: format!(
                            "Allow {} to access workspace resources?",
                            compiled.tool_name
                        ),
                        args_preview: redact_tool_arguments(
                            &compiled.tool_name,
                            &compiled.arguments,
                        ),
                    },
                    sequence: Some(permission_sequence),
                };
                {
                    let record = self.record_by_run_mut(&run_id_text)?;
                    let permission_phase = record.phase.as_str().to_string();
                    record
                        .decision_state
                        .apply_event(&permission, &permission_phase);
                }
                self.append_ledger(
                    &run_id_text,
                    &session_id_text,
                    "permission.requested",
                    permission_sequence,
                    serde_json::json!({
                        "summary": format!("Permission requested for {}.", compiled.tool_name),
                        "permissionId": &permission_id,
                        "toolCallId": &tool_call_id,
                        "toolName": &compiled.tool_name,
                        "capability": capability_for_tool(&compiled.tool_name),
                        "riskLevel": risk_for_tool(&compiled.tool_name),
                        "requestId": &request_id.0,
                        "workUnitId": &work_unit_id,
                        "actionId": &action_id,
                        "planId": &plan_id,
                        "operationKind": kind,
                        "readSet": &operation.read_set,
                        "writeSet": &operation.write_set,
                        "argsPreview": redact_tool_arguments(&compiled.tool_name, &compiled.arguments),
                        "argumentsRef": {
                            "storage": "runtime.pendingTools",
                            "permissionId": &permission_id,
                            "redaction": "raw arguments are kept in memory only and are not persisted to permission ledger"
                        }
                    }),
                )?;
                events.push(permission);
                continue;
            }

            let tool_event = self.execute_bound_tool(
                &run_id_text,
                &session_id_text,
                tool_call_id,
                compiled.tool_name,
                compiled.arguments,
            )?;
            let tool_ok = matches!(&tool_event, KernelEvent::ToolCompleted { ok: true, .. });
            let tool_error = match &tool_event {
                KernelEvent::ToolCompleted {
                    error: Some(error), ..
                } => Some(error.clone()),
                _ => None,
            };
            let tool_output = match &tool_event {
                KernelEvent::ToolCompleted { output, .. } => output.clone(),
                _ => None,
            };
            events.push(tool_event);
            if tool_ok {
                events.push(self.work_unit_completed_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    tool_output,
                )?);
            } else {
                let error = tool_error.unwrap_or_else(|| KernelErrorEnvelope {
                    code: "workspace_write_failed".to_string(),
                    message: "workspace.write did not produce a successful tool result".to_string(),
                    message_key: None,
                    args: None,
                });
                events.push(self.work_unit_failed_envelope_event(
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    &work_unit_id,
                    error,
                )?);
            }
        }

        if !has_pending_permission {
            events.push(self.enter_phase_event(
                &run_id_text,
                &session_id_text,
                WorkflowPhase::Review,
            )?);
        }
        Ok(events)
    }

    fn work_unit_queued_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit: Value,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.queued",
            sequence,
            serde_json::json!({
                "summary": "Work unit queued.",
                "workUnit": &work_unit
            }),
        )?;
        Ok(KernelEvent::WorkUnitQueued {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit,
            sequence: Some(sequence),
        })
    }

    fn work_unit_started_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.started",
            sequence,
            serde_json::json!({
                "summary": "Work unit started.",
                "workUnitId": work_unit_id
            }),
        )?;
        Ok(KernelEvent::WorkUnitStarted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            sequence: Some(sequence),
        })
    }

    pub(crate) fn work_unit_completed_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        output: Option<Value>,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.completed",
            sequence,
            serde_json::json!({
                "summary": "Work unit completed.",
                "workUnitId": work_unit_id,
                "output": output
            }),
        )?;
        Ok(KernelEvent::WorkUnitCompleted {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            output,
            sequence: Some(sequence),
        })
    }

    fn work_unit_failed_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        error: &KernelError,
    ) -> KernelResult<KernelEvent> {
        self.work_unit_failed_envelope_event(
            request_id,
            run_id,
            session_id,
            work_unit_id,
            KernelErrorEnvelope::from(error),
        )
    }

    pub(crate) fn work_unit_failed_envelope_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        error: KernelErrorEnvelope,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.failed",
            sequence,
            serde_json::json!({
                "summary": "Work unit failed.",
                "workUnitId": work_unit_id,
                "error": &error
            }),
        )?;
        Ok(KernelEvent::WorkUnitFailed {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            error,
            sequence: Some(sequence),
        })
    }

    pub(crate) fn work_unit_blocked_event(
        &mut self,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        work_unit_id: &str,
        reason: &str,
    ) -> KernelResult<KernelEvent> {
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "work_unit.blocked",
            sequence,
            serde_json::json!({
                "summary": "Work unit blocked.",
                "workUnitId": work_unit_id,
                "reason": reason
            }),
        )?;
        Ok(KernelEvent::WorkUnitBlocked {
            request_id: Some(request_id.clone()),
            run_id: RunId(run_id.to_string()),
            session_id: Some(SessionId(session_id.to_string())),
            work_unit_id: work_unit_id.to_string(),
            reason: reason.to_string(),
            sequence: Some(sequence),
        })
    }
}

struct CompiledWorkspaceAction {
    tool_name: String,
    arguments: Value,
    workspace_root: Option<PathBuf>,
}

#[derive(Debug, Clone)]
struct NormalizedWorkspacePath {
    relative_path: String,
    workspace_root: Option<PathBuf>,
    root_source: Option<&'static str>,
    stripped_prefixes: Vec<String>,
    duplicate_root_path_detected: bool,
    original_path: String,
}

fn operation_kind_name(operation: &PlannedOperation) -> &'static str {
    match &operation.operation {
        PlannedOperationKind::Workspace(WorkspaceOperation { kind, .. }) => match kind {
            WorkspaceOperationKind::Read => "read",
            WorkspaceOperationKind::List => "list",
            WorkspaceOperationKind::Search => "search",
            WorkspaceOperationKind::Diff => "diff",
            WorkspaceOperationKind::Write => "write",
            WorkspaceOperationKind::Create => "create",
            WorkspaceOperationKind::Patch => "patch",
            WorkspaceOperationKind::Delete => "delete",
            WorkspaceOperationKind::Rename => "rename",
        },
        PlannedOperationKind::Git(GitOperation { kind, .. }) => match kind {
            GitOperationKind::Status => "status",
            GitOperationKind::Diff => "diff",
            GitOperationKind::Stage => "stage",
            GitOperationKind::Unstage => "unstage",
            GitOperationKind::Commit => "commit",
            GitOperationKind::Push => "push",
        },
        PlannedOperationKind::Process(_) => "exec",
        PlannedOperationKind::Network(_) => "egress",
        PlannedOperationKind::Browser(_) => "control",
        PlannedOperationKind::Provider(_) => "egress",
    }
}

fn compile_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    match &operation.operation {
        PlannedOperationKind::Workspace(workspace) => {
            let (action, code_blocks) = workspace_operation_to_legacy_action(operation, workspace);
            compile_workspace_action(
                runtime,
                record,
                &action,
                &code_blocks,
                &operation.capability,
                operation_kind_name(operation),
            )
        }
        PlannedOperationKind::Git(git) => {
            let action = git_operation_to_legacy_action(git);
            compile_git_action(
                runtime,
                record,
                &action,
                &operation.capability,
                operation_kind_name(operation),
            )
        }
        PlannedOperationKind::Process(_)
        | PlannedOperationKind::Network(_)
        | PlannedOperationKind::Browser(_)
        | PlannedOperationKind::Provider(_) => Err(KernelError::PermissionDenied(format!(
            "operation is blocked by Kernel policy: {}",
            operation.capability
        ))),
    }
}

fn workspace_operation_to_legacy_action(
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> (Value, std::collections::BTreeMap<String, Value>) {
    let mut action = serde_json::json!({
        "id": &operation.id,
        "title": &operation.title,
        "capability": &operation.capability,
        "kind": operation_kind_name(operation),
        "resourceScope": workspace
            .target_path
            .as_ref()
            .map(|path| serde_json::json!([path]))
            .unwrap_or_else(|| serde_json::json!([]))
    });
    if let Some(path) = workspace.target_path.as_ref() {
        action["targetPath"] = Value::String(path.clone());
    }
    if let Some(query) = workspace.query.as_ref() {
        action["query"] = Value::String(query.clone());
    }
    if let Some(patch_spec) = workspace.patch_spec.as_ref() {
        action["patchSpec"] = patch_spec.clone();
    }
    if let Some(replacement_block_id) = workspace.replacement_block_id.as_ref() {
        action["replacementBlockId"] = Value::String(replacement_block_id.clone());
    }
    let mut code_blocks = std::collections::BTreeMap::new();
    if let (Some(source_block_id), Some(content)) = (
        workspace.source_block_id.as_ref(),
        workspace.content.as_ref(),
    ) {
        action["sourceBlockId"] = Value::String(source_block_id.clone());
        code_blocks.insert(
            source_block_id.clone(),
            serde_json::json!({
                "id": source_block_id,
                "path": workspace.target_path.clone(),
                "targetPath": workspace.target_path.clone(),
                "content": content
            }),
        );
    }
    if let (Some(replacement_block_id), Some(content)) = (
        workspace.replacement_block_id.as_ref(),
        workspace.content.as_ref(),
    ) {
        code_blocks.insert(
            replacement_block_id.clone(),
            serde_json::json!({
                "id": replacement_block_id,
                "path": workspace.target_path.clone(),
                "targetPath": workspace.target_path.clone(),
                "content": content
            }),
        );
    }
    (action, code_blocks)
}

fn git_operation_to_legacy_action(git: &GitOperation) -> Value {
    let mut action = serde_json::json!({
        "toolArgs": {
            "paths": &git.paths,
            "staged": git.staged
        }
    });
    if let Some(path) = git.paths.first() {
        action["path"] = Value::String(path.clone());
        action["targetPath"] = Value::String(path.clone());
    }
    if let Some(message) = git.message.as_ref() {
        action["message"] = Value::String(message.clone());
        action["toolArgs"]["message"] = Value::String(message.clone());
    }
    if let Some(remote) = git.remote.as_ref() {
        action["remote"] = Value::String(remote.clone());
        action["toolArgs"]["remote"] = Value::String(remote.clone());
    }
    if let Some(branch) = git.branch.as_ref() {
        action["branch"] = Value::String(branch.clone());
        action["toolArgs"]["branch"] = Value::String(branch.clone());
    }
    action
}

fn action_bundle_value(batch: &Value) -> Option<&Value> {
    batch.get("actionBundle").or_else(|| {
        if batch.get("actions").is_some() {
            Some(batch)
        } else {
            None
        }
    })
}

fn compile_workspace_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    code_blocks: &std::collections::BTreeMap<String, Value>,
    capability: &str,
    kind: &str,
) -> KernelResult<CompiledWorkspaceAction> {
    if !capability.starts_with("workspace.") {
        return Err(KernelError::InvalidCommand(format!(
            "unsupported action capability: {capability}"
        )));
    }
    match kind {
        "write" | "create" => workspace_write_from_action(runtime, record, action, code_blocks),
        "patch" => workspace_patch_from_action(runtime, record, action, code_blocks),
        "read" => workspace_path_tool_action(runtime, record, action, "fs.read"),
        "list" => workspace_path_tool_action(runtime, record, action, "fs.list"),
        "diff" => workspace_path_tool_action(runtime, record, action, "fs.diff"),
        "delete" => workspace_delete_tool_action(runtime, record, action),
        "search" => workspace_search_tool_action(action),
        "rename" => Err(KernelError::NotImplemented("workspace.rename.work_unit")),
        other => Err(KernelError::InvalidCommand(format!(
            "unsupported workspace action kind: {other}"
        ))),
    }
}

fn compile_git_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    capability: &str,
    kind: &str,
) -> KernelResult<CompiledWorkspaceAction> {
    let args = action.get("toolArgs").and_then(Value::as_object);
    let workspace_root = git_workspace_root(runtime, record);
    match (capability, kind) {
        ("git.read", "status") | ("git.read", "read") => Ok(CompiledWorkspaceAction {
            tool_name: "git.status".to_string(),
            arguments: serde_json::json!({}),
            workspace_root,
        }),
        ("git.read", "diff") => {
            let path = git_optional_path_from_action(action);
            let staged = args
                .and_then(|object| object.get("staged"))
                .or_else(|| action.get("staged"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut arguments = serde_json::json!({ "staged": staged });
            if let Some(path) = path {
                let normalized = git_relative_path(runtime, record, &path)?;
                arguments["path"] = Value::String(normalized);
            }
            Ok(CompiledWorkspaceAction {
                tool_name: "git.diff".to_string(),
                arguments,
                workspace_root,
            })
        }
        ("git.write", "stage") => Ok(CompiledWorkspaceAction {
            tool_name: "git.stage".to_string(),
            arguments: git_paths_arguments(runtime, record, action)?,
            workspace_root,
        }),
        ("git.write", "unstage") => Ok(CompiledWorkspaceAction {
            tool_name: "git.unstage".to_string(),
            arguments: git_paths_arguments(runtime, record, action)?,
            workspace_root,
        }),
        ("git.write", "commit") => {
            let message = args
                .and_then(|object| object.get("message"))
                .or_else(|| action.get("message"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    KernelError::InvalidCommand(
                        "git.commit action requires toolArgs.message".to_string(),
                    )
                })?;
            Ok(CompiledWorkspaceAction {
                tool_name: "git.commit".to_string(),
                arguments: serde_json::json!({ "message": message }),
                workspace_root,
            })
        }
        ("git.push", "push") | ("git.write", "push") => {
            let remote = args
                .and_then(|object| object.get("remote"))
                .or_else(|| action.get("remote"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("origin");
            let branch = args
                .and_then(|object| object.get("branch"))
                .or_else(|| action.get("branch"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let mut arguments = serde_json::json!({ "remote": remote });
            if let Some(branch) = branch {
                arguments["branch"] = Value::String(branch.to_string());
            }
            Ok(CompiledWorkspaceAction {
                tool_name: "git.push".to_string(),
                arguments,
                workspace_root,
            })
        }
        ("git.read", other) => Err(KernelError::InvalidCommand(format!(
            "unsupported git.read action kind: {other}"
        ))),
        ("git.write", other) => Err(KernelError::InvalidCommand(format!(
            "unsupported git.write action kind: {other}"
        ))),
        ("git.push", other) => Err(KernelError::InvalidCommand(format!(
            "unsupported git.push action kind: {other}"
        ))),
        _ => Err(KernelError::InvalidCommand(format!(
            "unsupported git action capability: {capability}"
        ))),
    }
}

fn git_workspace_root(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
) -> Option<PathBuf> {
    if let Some(root) = runtime
        .state
        .current_workspace
        .as_ref()
        .map(|workspace| workspace.root.clone())
    {
        return Some(root);
    }
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

fn git_optional_path_from_action(action: &Value) -> Option<String> {
    let args = action.get("toolArgs").and_then(Value::as_object);
    args.and_then(|object| object.get("path"))
        .or_else(|| action.get("path"))
        .or_else(|| action.get("targetPath"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "workspace")
        .map(str::to_string)
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .find(|value| !value.is_empty() && *value != "workspace" && !value.contains('*'))
                .map(str::to_string)
        })
}

fn git_paths_arguments(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
) -> KernelResult<Value> {
    let args = action.get("toolArgs").and_then(Value::as_object);
    let raw_paths = args
        .and_then(|object| object.get("paths"))
        .or_else(|| action.get("paths"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .or_else(|| {
            args.and_then(|object| object.get("path"))
                .or_else(|| action.get("path"))
                .or_else(|| action.get("targetPath"))
                .and_then(Value::as_str)
                .map(|path| vec![path.to_string()])
        })
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .filter(|value| !value.trim().is_empty() && *value != "workspace")
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
        })
        .unwrap_or_default();
    if raw_paths.is_empty() {
        return Err(KernelError::InvalidCommand(
            "git stage/unstage action requires toolArgs.path, toolArgs.paths, targetPath, or resourceScope".to_string(),
        ));
    }
    let paths = raw_paths
        .into_iter()
        .map(|path| git_relative_path(runtime, record, &path))
        .collect::<KernelResult<Vec<_>>>()?;
    Ok(serde_json::json!({ "paths": paths }))
}

fn git_relative_path(
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

fn workspace_write_from_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    code_blocks: &std::collections::BTreeMap<String, Value>,
) -> KernelResult<CompiledWorkspaceAction> {
    let source_block_id = action
        .get("sourceBlockId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("workspace.write action requires sourceBlockId".to_string())
        })?;
    let block = code_blocks.get(source_block_id).ok_or_else(|| {
        KernelError::InvalidCommand(format!("codeBlock {source_block_id} was not provided"))
    })?;
    let content = block
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("codeBlock {source_block_id} has no content"))
        })?
        .to_string();
    if content.is_empty() && !block_explicitly_allows_empty_content(block) {
        return Err(KernelError::InvalidCommand(format!(
            "codeBlock {source_block_id} has empty content; use allowEmptyContent with createEmpty to make this explicit"
        )));
    }
    let raw_path = block
        .get("path")
        .or_else(|| block.get("targetPath"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("targetPath")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("codeBlock {source_block_id} has no write path"))
        })?;
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: "fs.write".to_string(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "content": content,
            "create": true,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

fn workspace_patch_from_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    code_blocks: &std::collections::BTreeMap<String, Value>,
) -> KernelResult<CompiledWorkspaceAction> {
    let replacement_block_id = action
        .get("replacementBlockId")
        .or_else(|| action.get("sourceBlockId"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(
                "workspace.patch action requires replacementBlockId or sourceBlockId".to_string(),
            )
        })?;
    let block = code_blocks.get(replacement_block_id).ok_or_else(|| {
        KernelError::InvalidCommand(format!("codeBlock {replacement_block_id} was not provided"))
    })?;
    let replacement = block
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!("codeBlock {replacement_block_id} has no content"))
        })?
        .to_string();
    if replacement.is_empty() && !block_explicitly_allows_empty_content(block) {
        return Err(KernelError::InvalidCommand(format!(
            "codeBlock {replacement_block_id} has empty content; use allowEmptyContent with a patch operation to make this explicit"
        )));
    }
    let raw_path = action
        .get("targetPath")
        .or_else(|| action.get("path"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            block
                .get("path")
                .or_else(|| block.get("targetPath"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "codeBlock {replacement_block_id} has no patch target path"
            ))
        })?;
    let patch_spec = action.get("patchSpec").cloned().ok_or_else(|| {
        KernelError::InvalidCommand("workspace.patch action requires patchSpec".to_string())
    })?;
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: "fs.patch".to_string(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "patchSpec": patch_spec,
            "replacement": replacement,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

fn block_explicitly_allows_empty_content(block: &Value) -> bool {
    let operation = block
        .get("operation")
        .and_then(Value::as_str)
        .unwrap_or_default();
    block
        .get("allowEmptyContent")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && matches!(
            operation,
            "createEmpty" | "patch" | "replaceBlock" | "insertBefore" | "insertAfter"
        )
}

fn workspace_path_tool_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
    tool_name: &str,
) -> KernelResult<CompiledWorkspaceAction> {
    let raw_path = action
        .get("targetPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or(".");
    let normalized = workspace_relative_write_path(runtime, record, raw_path)?;
    Ok(CompiledWorkspaceAction {
        tool_name: tool_name.to_string(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

fn workspace_delete_tool_action(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    action: &Value,
) -> KernelResult<CompiledWorkspaceAction> {
    let raw_path = action
        .get("targetPath")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand(
                "workspace.delete action requires targetPath or resourceScope".to_string(),
            )
        })?;
    let trimmed = raw_path.trim();
    if trimmed == "." || trimmed == "./" {
        return Err(KernelError::InvalidCommand(
            "workspace.delete cannot remove workspace root".to_string(),
        ));
    }
    if trimmed.contains('*') {
        return Err(KernelError::InvalidCommand(
            "workspace.delete target must be a concrete path".to_string(),
        ));
    }
    let normalized = match workspace_relative_write_path(runtime, record, trimmed) {
        Ok(normalized) => normalized,
        Err(KernelError::InvalidCommand(message))
            if message.contains("workspace.write target resolves to an attachment directory") =>
        {
            return Err(KernelError::InvalidCommand(
                "workspace.delete cannot remove workspace root".to_string(),
            ));
        }
        Err(KernelError::PermissionDenied(message))
            if message.contains("workspace.write target is outside") =>
        {
            return Err(KernelError::PermissionDenied(
                message.replace("workspace.write", "workspace.delete"),
            ));
        }
        Err(error) => return Err(error),
    };
    if normalized.relative_path.trim().is_empty()
        || normalized.relative_path == "."
        || normalized.relative_path == "./"
    {
        return Err(KernelError::InvalidCommand(
            "workspace.delete cannot remove workspace root".to_string(),
        ));
    }
    Ok(CompiledWorkspaceAction {
        tool_name: "fs.delete".to_string(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "pathNormalization": path_normalization_json(&normalized)
        }),
        workspace_root: normalized.workspace_root,
    })
}

fn workspace_search_tool_action(action: &Value) -> KernelResult<CompiledWorkspaceAction> {
    let query = action
        .get("query")
        .or_else(|| action.get("targetPath"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            action
                .get("resourceScope")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
        })
        .ok_or_else(|| {
            KernelError::InvalidCommand("workspace.search action requires query".to_string())
        })?;
    Ok(CompiledWorkspaceAction {
        tool_name: "code.search".to_string(),
        arguments: serde_json::json!({
            "query": query,
            "include": action.get("include").cloned().unwrap_or(Value::Null),
            "contextLines": action.get("contextLines").cloned().unwrap_or(Value::Null),
            "maxResults": action.get("maxResults").cloned().unwrap_or(Value::Null)
        }),
        workspace_root: None,
    })
}

fn workspace_relative_write_path(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    raw_path: &str,
) -> KernelResult<NormalizedWorkspacePath> {
    let raw_path = raw_path.trim();
    let path = Path::new(raw_path);
    if !path.is_absolute() {
        if let Some((root, normalized)) =
            single_directory_attachment_write_target(record, raw_path)?
        {
            return Ok(NormalizedWorkspacePath {
                workspace_root: Some(root),
                root_source: Some("attachment"),
                ..normalized
            });
        }
        if has_explicit_attachment_roots(record) {
            return relative_file_attachment_write_target(record, raw_path);
        }
        if runtime.state.current_workspace.is_none() {
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
        }
        return Ok(NormalizedWorkspacePath {
            relative_path: normalize_write_relative_path(raw_path)?,
            workspace_root: None,
            root_source: None,
            stripped_prefixes: Vec::new(),
            duplicate_root_path_detected: false,
            original_path: raw_path.to_string(),
        });
    }

    let target = path.components().collect::<PathBuf>();
    if let Some((root, relative)) = attachment_root_for_target(record, &target)? {
        return Ok(NormalizedWorkspacePath {
            relative_path: relative,
            workspace_root: Some(root.clone()),
            root_source: Some("attachment"),
            stripped_prefixes: vec![root.to_string_lossy().to_string()],
            duplicate_root_path_detected: false,
            original_path: raw_path.to_string(),
        });
    }
    if has_explicit_attachment_roots(record) {
        return Err(KernelError::PermissionDenied(format!(
            "workspace.write target is outside workspace binding and explicit attachments: {raw_path}"
        )));
    }
    if let Some(root) = runtime
        .state
        .current_workspace
        .as_ref()
        .map(|workspace| workspace.root.clone())
    {
        if let Some(relative) = strip_root(&target, &root) {
            return Ok(NormalizedWorkspacePath {
                relative_path: relative,
                workspace_root: None,
                root_source: Some("workspace"),
                stripped_prefixes: vec![root.to_string_lossy().to_string()],
                duplicate_root_path_detected: false,
                original_path: raw_path.to_string(),
            });
        }
    }
    if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
        let root = PathBuf::from(open_path)
            .canonicalize()
            .unwrap_or_else(|_| PathBuf::from(open_path));
        if let Some(relative) = strip_root(&target, &root) {
            return Ok(NormalizedWorkspacePath {
                relative_path: relative,
                workspace_root: Some(root.clone()),
                root_source: Some("workspaceBinding"),
                stripped_prefixes: vec![root.to_string_lossy().to_string()],
                duplicate_root_path_detected: false,
                original_path: raw_path.to_string(),
            });
        }
    }
    Err(KernelError::PermissionDenied(format!(
        "workspace.write target is outside workspace binding and explicit attachments: {raw_path}"
    )))
}

fn strip_root(target: &Path, root: &Path) -> Option<String> {
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

fn attachment_root_for_target(
    record: &RuntimeRunRecord,
    target: &Path,
) -> KernelResult<Option<(PathBuf, String)>> {
    for attachment in &record.attachments {
        let Some(root) = explicit_attachment_root(attachment) else {
            continue;
        };
        let kind = attachment
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("file");
        if kind == "directory" && target == root {
            return Err(KernelError::InvalidCommand(
                "workspace.write target resolves to an attachment directory, not a file"
                    .to_string(),
            ));
        }
        let allowed = if kind == "directory" {
            target.starts_with(&root)
        } else {
            target == root
        };
        if allowed {
            let write_root = if kind == "directory" {
                root
            } else {
                root.parent().map(Path::to_path_buf).ok_or_else(|| {
                    KernelError::InvalidCommand("file attachment has no parent".to_string())
                })?
            };
            if let Some(relative) = strip_root(target, &write_root) {
                return Ok(Some((write_root, relative)));
            }
        }
    }
    Ok(None)
}

fn has_explicit_attachment_roots(record: &RuntimeRunRecord) -> bool {
    record
        .attachments
        .iter()
        .any(|attachment| explicit_attachment_root(attachment).is_some())
}

fn single_directory_attachment_write_target(
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
            "workspace.write has a relative path but multiple attachment roots are available"
                .to_string(),
        ))
    }
}

fn relative_file_attachment_write_target(
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
        "workspace.write target is outside workspace binding and explicit attachments: {raw_path}"
    )))
}

fn normalize_attachment_relative_write_path(
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
                    "workspace.write target resolves to an attachment directory, not a file"
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
            "workspace.write target resolves to an attachment directory, not a file".to_string(),
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

fn attachment_prefix_candidates(attachment: &Value, index: usize) -> KernelResult<Vec<String>> {
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

fn push_attachment_prefix(prefixes: &mut Vec<String>, value: &str) -> KernelResult<()> {
    match normalize_write_relative_path(value) {
        Ok(normalized) => push_normalized_prefix(prefixes, &normalized),
        Err(KernelError::InvalidCommand(message))
            if message.starts_with("workspace.write target must be relative:") =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn push_normalized_prefix(prefixes: &mut Vec<String>, value: &str) -> KernelResult<()> {
    let normalized = normalize_write_relative_path(value)?;
    if normalized == "." || prefixes.iter().any(|item| item == &normalized) {
        return Ok(());
    }
    prefixes.push(normalized);
    Ok(())
}

fn manifest_like_attachment_id(index: usize, path: &str, prefix: &str) -> String {
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

fn path_basename(path: &str) -> Option<String> {
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

fn path_normalization_json(path: &NormalizedWorkspacePath) -> Value {
    serde_json::json!({
        "originalPath": path.original_path,
        "normalizedTargetPath": path.relative_path,
        "rootSource": path.root_source,
        "strippedPathPrefixes": path.stripped_prefixes,
        "duplicateRootPathDetected": path.duplicate_root_path_detected
    })
}

fn attach_kernel_context_to_arguments(
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

fn normalize_write_relative_path(raw_path: &str) -> KernelResult<String> {
    let normalized = raw_path.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Err(KernelError::InvalidCommand(
            "workspace.write target path is empty".to_string(),
        ));
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err(KernelError::InvalidCommand(format!(
            "workspace.write target must be relative: {raw_path}"
        )));
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
                    "workspace.write target cannot contain parent traversal: {raw_path}"
                )));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(KernelError::InvalidCommand(format!(
                    "workspace.write target must be relative: {raw_path}"
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(KernelError::InvalidCommand(
            "workspace.write target path is empty".to_string(),
        ));
    }
    Ok(parts.join("/"))
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

fn summarize_action_batch(batch: &Value) -> Value {
    let action_bundle = action_bundle_value(batch);
    let actions = action_bundle
        .and_then(|bundle| bundle.get("actions"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let code_blocks = batch
        .get("codeBlocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    serde_json::json!({
        "planId": batch.get("planId").and_then(Value::as_str),
        "actionBundleId": action_bundle.and_then(|bundle| bundle.get("id")).and_then(Value::as_str),
        "goal": action_bundle.and_then(|bundle| bundle.get("goal")).and_then(Value::as_str),
        "actionCount": actions.len(),
        "actions": actions.iter().map(summarize_action).collect::<Vec<_>>(),
        "codeBlocks": code_blocks.iter().map(summarize_code_block).collect::<Vec<_>>()
    })
}

fn summarize_action(action: &Value) -> Value {
    serde_json::json!({
        "id": action.get("id").and_then(Value::as_str),
        "title": action.get("title").and_then(Value::as_str),
        "capability": action.get("capability").and_then(Value::as_str),
        "kind": action.get("kind").and_then(Value::as_str),
        "resourceScope": action.get("resourceScope").cloned().unwrap_or_else(|| serde_json::json!([])),
        "sourceBlockId": action.get("sourceBlockId").and_then(Value::as_str),
        "toolArgs": action.get("toolArgs").cloned().unwrap_or(Value::Null)
    })
}

fn summarize_code_block(block: &Value) -> Value {
    let content = block
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    serde_json::json!({
        "id": block.get("id").and_then(Value::as_str),
        "path": block.get("path").and_then(Value::as_str),
        "language": block.get("language").and_then(Value::as_str),
        "contentBytes": content.len(),
        "contentHash": deepcode_kernel_skills::hash::hash_bytes(content.as_bytes())
    })
}

fn safe_work_unit_segment(value: &str) -> String {
    let mut out = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(80).collect::<String>()
}
