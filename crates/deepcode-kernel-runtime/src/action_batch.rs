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

        if let Err(error) = validate_operations_against_execution_contract(
            &self.state,
            &run_id_text,
            &batch,
            &operations,
        ) {
            let work_unit_id = format!("work-unit-{}-contract", safe_work_unit_segment(&plan_id));
            events.push(self.work_unit_failed_envelope_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                &work_unit_id,
                KernelErrorEnvelope {
                    code: "execution_contract_mismatch".to_string(),
                    message: error.to_string(),
                    message_key: None,
                    args: None,
                },
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
            let mut compiled_result = if operation.execution_mode == OperationExecutionMode::Execute
            {
                match compile_operation(self, &record, operation)
                    .and_then(|compiled| validate_compiled_operation(operation, compiled))
                {
                    Ok(compiled) => Some(Ok(compiled)),
                    Err(error) => Some(Err(error)),
                }
            } else {
                None
            };
            let compiled_tool = compiled_result
                .as_ref()
                .and_then(|result| result.as_ref().ok())
                .map(compiled_tool_summary);
            let compile_error = compiled_result
                .as_ref()
                .and_then(|result| result.as_ref().err())
                .map(|error| KernelErrorEnvelope::from(error));
            let mut work_unit = serde_json::json!({
                "id": &work_unit_id,
                "planId": &plan_id,
                "actionId": &action_id,
                "title": &operation.title,
                "capability": capability,
                "kind": kind,
                "targetRef": &operation.target_ref,
                "readSet": &operation.read_set,
                "writeSet": &operation.write_set,
                "conflictKeys": &operation.conflict_keys,
                "executionMode": operation.execution_mode,
                "status": "queued"
            });
            if matches!(
                &operation.operation,
                PlannedOperationKind::Workspace(WorkspaceOperation {
                    kind: WorkspaceOperationKind::Delete,
                    ..
                })
            ) {
                if let Some(object) = work_unit.as_object_mut() {
                    object.insert(
                        "deleteSet".to_string(),
                        serde_json::json!(&operation.write_set),
                    );
                }
            }
            if let Some(compiled_tool) = compiled_tool {
                if let Some(object) = work_unit.as_object_mut() {
                    object.insert("compiledTool".to_string(), compiled_tool);
                }
            }
            if let Some(compile_error) = compile_error {
                if let Some(object) = work_unit.as_object_mut() {
                    object.insert("compileError".to_string(), serde_json::json!(compile_error));
                }
            }
            events.push(self.work_unit_queued_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                work_unit,
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

            let mut compiled = match compiled_result
                .take()
                .expect("execute work unit compiles before it is queued")
            {
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
            events.push(self.work_unit_started_event(
                &request_id,
                &run_id_text,
                &session_id_text,
                &work_unit_id,
            )?);
            attach_kernel_context_to_arguments(
                &mut compiled.arguments,
                &plan_id,
                &work_unit_id,
                &action_id,
                kind,
            );

            if let Some(root) = compiled.workspace_root.as_ref() {
                if !root.is_dir() {
                    events.push(self.work_unit_failed_event(
                        &request_id,
                        &run_id_text,
                        &session_id_text,
                        &work_unit_id,
                        &KernelError::InvalidCommand(format!(
                            "kernel execution root is not a directory: {}",
                            root.to_string_lossy()
                        )),
                    )?);
                    continue;
                }
                if let Some(object) = compiled.arguments.as_object_mut() {
                    object.insert(
                        "kernelExecutionRoot".to_string(),
                        Value::String(root.to_string_lossy().to_string()),
                    );
                }
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

            let executed_tool_name = compiled.tool_name.clone();
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
                    code: format!("{}_failed", executed_tool_name.replace('.', "_")),
                    message: format!(
                        "{executed_tool_name} did not produce a successful tool result"
                    ),
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

fn fs_tool_name_for_workspace_operation(operation: &PlannedOperation) -> &'static str {
    match &operation.operation {
        PlannedOperationKind::Workspace(WorkspaceOperation { kind, .. }) => match kind {
            WorkspaceOperationKind::Patch => "fs.patch",
            WorkspaceOperationKind::Delete => "fs.delete",
            WorkspaceOperationKind::Search => "code.search",
            WorkspaceOperationKind::Read => "fs.read",
            WorkspaceOperationKind::List => "fs.list",
            WorkspaceOperationKind::Diff => "fs.diff",
            WorkspaceOperationKind::Write | WorkspaceOperationKind::Create => "fs.write",
            WorkspaceOperationKind::Rename => "fs.rename",
        },
        _ => operation_kind_name(operation),
    }
}

fn compile_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    match &operation.operation {
        PlannedOperationKind::Workspace(workspace) => {
            compile_workspace_operation(runtime, record, operation, workspace)
        }
        PlannedOperationKind::Git(git) => compile_git_operation(runtime, record, operation, git),
        PlannedOperationKind::Process(_)
        | PlannedOperationKind::Network(_)
        | PlannedOperationKind::Browser(_)
        | PlannedOperationKind::Provider(_) => Err(KernelError::PermissionDenied(format!(
            "operation is blocked by Kernel policy: {}",
            operation.capability
        ))),
    }
}

fn validate_compiled_operation(
    operation: &PlannedOperation,
    compiled: CompiledWorkspaceAction,
) -> KernelResult<CompiledWorkspaceAction> {
    if let PlannedOperationKind::Workspace(workspace) = &operation.operation {
        let expected_tool = fs_tool_name_for_workspace_operation(operation);
        if compiled.tool_name != expected_tool {
            return Err(KernelError::InvalidCommand(format!(
                "compiled workspace operation mismatch: action {} kind {} expected {} but got {}",
                operation.id,
                operation_kind_name(operation),
                expected_tool,
                compiled.tool_name
            )));
        }
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
            WorkspaceOperationKind::Read
            | WorkspaceOperationKind::List
            | WorkspaceOperationKind::Diff
            | WorkspaceOperationKind::Write
            | WorkspaceOperationKind::Create
            | WorkspaceOperationKind::Patch
            | WorkspaceOperationKind::Delete
            | WorkspaceOperationKind::Rename => {
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

fn compiled_tool_summary(compiled: &CompiledWorkspaceAction) -> Value {
    serde_json::json!({
        "toolName": &compiled.tool_name,
        "path": compiled.arguments.get("path").and_then(Value::as_str),
        "targetKind": compiled.arguments.get("targetKind").and_then(Value::as_str),
        "recursive": compiled.arguments.get("recursive").and_then(Value::as_bool),
        "query": compiled.arguments.get("query").and_then(Value::as_str),
        "argsPreview": redact_tool_arguments(&compiled.tool_name, &compiled.arguments)
    })
}

fn validate_operations_against_execution_contract(
    state: &RuntimeState,
    run_id: &str,
    batch: &Value,
    operations: &[PlannedOperation],
) -> KernelResult<()> {
    let Some(contract_id) = batch
        .get("contractId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let contract = state
        .execution_contracts_by_run
        .get(run_id)
        .and_then(|contracts| contracts.get(contract_id))
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "action batch references unknown Kernel execution contract {contract_id}"
            ))
        })?;
    let contract_operations = contract
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if contract_operations.is_empty() {
        return Ok(());
    }
    for operation in operations {
        if !matches!(
            operation.capability.as_str(),
            "fs.write" | "fs.patch" | "fs.delete"
        ) {
            continue;
        }
        let Some(contract_operation) = contract_operations.iter().find(|item| {
            item.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id == operation.id)
        }) else {
            return Err(KernelError::InvalidCommand(format!(
                "action {} is not listed in Kernel execution contract {contract_id}",
                operation.id
            )));
        };
        let contract_capability = contract_operation
            .get("capability")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if contract_capability != operation.capability {
            return Err(KernelError::InvalidCommand(format!(
                "action {} capability {} does not match Kernel execution contract capability {}",
                operation.id, operation.capability, contract_capability
            )));
        }
        let contract_target = contract_operation
            .get("targetPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let targets = if operation.write_set.is_empty() {
            &operation.read_set
        } else {
            &operation.write_set
        };
        if !targets
            .iter()
            .any(|target| contract_paths_match(target, contract_target))
        {
            return Err(KernelError::InvalidCommand(format!(
                "action {} target {:?} is outside Kernel execution contract target {}",
                operation.id, targets, contract_target
            )));
        }
    }
    Ok(())
}

fn contract_paths_match(left: &str, right: &str) -> bool {
    normalize_contract_path(left) == normalize_contract_path(right)
}

fn normalize_contract_path(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/");
    while let Some(stripped) = normalized.strip_prefix("./") {
        normalized = stripped.to_string();
    }
    normalized.trim_end_matches('/').to_string()
}

fn operation_compile_debug_json(
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

fn compile_workspace_operation(
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
            workspace_path_tool_operation(runtime, record, workspace, "fs.read")
        }
        WorkspaceOperationKind::List => {
            workspace_path_tool_operation(runtime, record, workspace, "fs.list")
        }
        WorkspaceOperationKind::Diff => {
            workspace_path_tool_operation(runtime, record, workspace, "fs.diff")
        }
        WorkspaceOperationKind::Delete => {
            workspace_delete_tool_operation(runtime, record, operation, workspace)
        }
        WorkspaceOperationKind::Search => workspace_search_tool_operation(workspace),
        WorkspaceOperationKind::Rename => Err(KernelError::NotImplemented("fs.rename.work_unit")),
    }
}

fn compile_git_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    git: &GitOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let workspace_root = git_workspace_root(runtime, record);
    match git.kind {
        GitOperationKind::Status => Ok(CompiledWorkspaceAction {
            tool_name: "git.status".to_string(),
            arguments: serde_json::json!({}),
            workspace_root,
        }),
        GitOperationKind::Diff => {
            let mut arguments = serde_json::json!({ "staged": git.staged });
            if let Some(path) = git.paths.first() {
                arguments["path"] = Value::String(git_relative_path(runtime, record, path)?);
            }
            Ok(CompiledWorkspaceAction {
                tool_name: "git.diff".to_string(),
                arguments,
                workspace_root,
            })
        }
        GitOperationKind::Stage => Ok(CompiledWorkspaceAction {
            tool_name: "git.stage".to_string(),
            arguments: git_paths_arguments_from_operation(runtime, record, operation, git)?,
            workspace_root,
        }),
        GitOperationKind::Unstage => Ok(CompiledWorkspaceAction {
            tool_name: "git.unstage".to_string(),
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
                        "git.commit action requires toolArgs.message".to_string(),
                    )
                })?;
            Ok(CompiledWorkspaceAction {
                tool_name: "git.commit".to_string(),
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
                tool_name: "git.push".to_string(),
                arguments,
                workspace_root,
            })
        }
    }
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

fn workspace_write_from_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let content = workspace.content.clone().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "{} action {} requires canonical content",
            fs_tool_name_for_workspace_operation(operation),
            operation.id
        ))
    })?;
    if content.is_empty() && !workspace.allow_empty_content {
        return Err(KernelError::InvalidCommand(format!(
            "{} action {} has empty content; use allowEmptyContent to make this explicit",
            fs_tool_name_for_workspace_operation(operation),
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
                "{} action {} requires targetPath or resourceScope",
                fs_tool_name_for_workspace_operation(operation),
                operation.id
            ))
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

fn workspace_patch_from_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let replacement = workspace.content.clone().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "fs.patch action {} requires canonical replacement content",
            operation.id
        ))
    })?;
    if replacement.is_empty() && !workspace.allow_empty_content {
        return Err(KernelError::InvalidCommand(format!(
            "fs.patch action {} has empty replacement; use allowEmptyContent to make this explicit",
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
                "fs.patch action {} requires targetPath or resourceScope",
                operation.id
            ))
        })?;
    let patch_spec = workspace.patch_spec.clone().ok_or_else(|| {
        KernelError::InvalidCommand(format!(
            "fs.patch action {} requires patchSpec",
            operation.id
        ))
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

fn workspace_path_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    workspace: &WorkspaceOperation,
    tool_name: &str,
) -> KernelResult<CompiledWorkspaceAction> {
    let raw_path = workspace
        .target_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
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

fn workspace_delete_tool_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let canonical_target = operation
        .target_ref
        .as_ref()
        .map(|target| target.raw_path());
    let raw_path = canonical_target
        .as_deref()
        .into_iter()
        .chain(operation.write_set.iter().map(String::as_str))
        .chain(workspace.target_path.as_deref())
        .map(str::trim)
        .find(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "fs.delete action {} requires targetRef, targetPath, or resourceScope; operation={}",
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
    let normalized = match workspace_relative_write_path(runtime, record, raw_path) {
        Ok(normalized) => normalized,
        Err(KernelError::InvalidCommand(message))
            if message.contains("fs.write target resolves to an attachment directory") =>
        {
            return Err(KernelError::InvalidCommand(
                "fs.delete cannot remove workspace root".to_string(),
            ));
        }
        Err(KernelError::InvalidCommand(message)) => {
            return Err(KernelError::InvalidCommand(
                message.replace("fs.write", "fs.delete"),
            ));
        }
        Err(KernelError::PermissionDenied(message))
            if message.contains("fs.write target is outside") =>
        {
            return Err(KernelError::PermissionDenied(
                message.replace("fs.write", "fs.delete"),
            ));
        }
        Err(KernelError::PermissionDenied(message)) => {
            return Err(KernelError::PermissionDenied(
                message.replace("fs.write", "fs.delete"),
            ));
        }
        Err(error) => return Err(error),
    };
    if normalized.relative_path.trim().is_empty()
        || normalized.relative_path == "."
        || normalized.relative_path == "./"
    {
        return Err(KernelError::InvalidCommand(
            "fs.delete cannot remove workspace root".to_string(),
        ));
    }
    let explicit_target_kind = workspace
        .target_resource_kind
        .as_deref()
        .or(workspace.target_kind.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let target_kind = match explicit_target_kind {
        Some("directory") | Some("dir") => "directory",
        Some("file") => "file",
        _ if raw_path.trim().ends_with('/') => "directory",
        _ => "file",
    };
    let recursive =
        workspace.recursive || (target_kind == "directory" && raw_path.trim().ends_with('/'));
    let action = CompiledWorkspaceAction {
        tool_name: "fs.delete".to_string(),
        arguments: serde_json::json!({
            "path": normalized.relative_path,
            "targetKind": target_kind,
            "targetResourceKind": target_kind,
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

fn workspace_search_tool_operation(
    workspace: &WorkspaceOperation,
) -> KernelResult<CompiledWorkspaceAction> {
    let query = workspace
        .query
        .as_deref()
        .or(workspace.target_path.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand("code.search action requires query".to_string())
        })?;
    Ok(CompiledWorkspaceAction {
        tool_name: "code.search".to_string(),
        arguments: serde_json::json!({
            "query": query,
            "include": &workspace.include,
            "contextLines": workspace.context_lines,
            "maxResults": workspace.max_results
        }),
        workspace_root: None,
    })
}

fn git_paths_arguments_from_operation(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    operation: &PlannedOperation,
    git: &GitOperation,
) -> KernelResult<Value> {
    if git.paths.is_empty() {
        return Err(KernelError::InvalidCommand(format!(
            "git {} action {} requires at least one path",
            operation_kind_name(operation),
            operation.id
        )));
    }
    let paths = git
        .paths
        .iter()
        .map(|path| git_relative_path(runtime, record, path))
        .collect::<KernelResult<Vec<_>>>()?;
    Ok(serde_json::json!({ "paths": paths }))
}

fn git_workspace_root(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
) -> Option<PathBuf> {
    if let Some(open_path) = record.workspace_binding.open_path.as_ref() {
        return Some(PathBuf::from(open_path));
    }
    if let Some(root) = runtime
        .state
        .current_workspace
        .as_ref()
        .map(|workspace| workspace.root.clone())
    {
        return Some(root);
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
    if has_explicit_attachment_roots(record)
        && !has_external_file_target_grant(runtime, record, &target)
    {
        return Err(KernelError::PermissionDenied(format!(
            "fs.write target is outside workspace binding and explicit attachments: {raw_path}"
        )));
    }
    external_absolute_file_write_target(&target, raw_path)
}

fn has_external_file_target_grant(
    runtime: &DeepCodeKernelRuntime,
    record: &RuntimeRunRecord,
    target: &Path,
) -> bool {
    let target = target
        .canonicalize()
        .unwrap_or_else(|_| target.to_path_buf());
    runtime
        .state
        .temporary_grants_by_run
        .get(&record.run_id)
        .map(|grants| {
            grants.iter().any(|grant| {
                if grant.resource_kind != "externalFile" {
                    return false;
                }
                let Some(resource_path) = grant.resource_path.as_ref() else {
                    return false;
                };
                let grant_path = PathBuf::from(resource_path);
                let grant_path = grant_path.canonicalize().unwrap_or(grant_path);
                target == grant_path
            })
        })
        .unwrap_or(false)
}

fn external_absolute_file_write_target(
    target: &Path,
    raw_path: &str,
) -> KernelResult<NormalizedWorkspacePath> {
    if target == Path::new("/") {
        return Err(KernelError::InvalidCommand(
            "fs.write target must be a concrete file path, not a filesystem root".to_string(),
        ));
    }
    let file_name = target
        .file_name()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(
                "fs.write target must be a concrete file path, not a directory".to_string(),
            )
        })?;
    if file_name == "." || file_name == ".." {
        return Err(KernelError::InvalidCommand(
            "fs.write target must be a concrete file path".to_string(),
        ));
    }
    let parent = target.parent().ok_or_else(|| {
        KernelError::InvalidCommand("fs.write absolute target has no parent directory".to_string())
    })?;
    let root = parent
        .canonicalize()
        .unwrap_or_else(|_| parent.to_path_buf());
    Ok(NormalizedWorkspacePath {
        relative_path: file_name,
        workspace_root: Some(root.clone()),
        root_source: Some("absolutePath"),
        stripped_prefixes: vec![root.to_string_lossy().to_string()],
        duplicate_root_path_detected: false,
        original_path: raw_path.to_string(),
    })
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
                "fs.write target resolves to an attachment directory, not a file".to_string(),
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
            "fs.write has a relative path but multiple attachment roots are available".to_string(),
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
        "fs.write target is outside workspace binding and explicit attachments: {raw_path}"
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
                    "fs.write target resolves to an attachment directory, not a file".to_string(),
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
            "fs.write target resolves to an attachment directory, not a file".to_string(),
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
    let trimmed = value.trim().replace('\\', "/");
    let trimmed = trimmed.trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(());
    }
    match normalize_write_relative_path(value) {
        Ok(normalized) => push_normalized_prefix(prefixes, &normalized),
        Err(KernelError::InvalidCommand(message))
            if message.starts_with("fs.write target must be relative:") =>
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
            "fs.write target path is empty".to_string(),
        ));
    }
    let path = Path::new(&normalized);
    if path.is_absolute() {
        return Err(KernelError::InvalidCommand(format!(
            "fs.write target must be relative: {raw_path}"
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
                    "fs.write target cannot contain parent traversal: {raw_path}"
                )));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(KernelError::InvalidCommand(format!(
                    "fs.write target must be relative: {raw_path}"
                )));
            }
        }
    }
    if parts.is_empty() {
        return Err(KernelError::InvalidCommand(
            "fs.write target path is empty".to_string(),
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
        "targetPath": action.get("targetPath").and_then(Value::as_str),
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

#[cfg(test)]
mod action_batch_internal_tests {
    use super::*;
    use deepcode_kernel_tools::FileTargetRef;

    fn runtime_record_for_compile_test() -> (DeepCodeKernelRuntime, RuntimeRunRecord, PathBuf) {
        let temp = std::env::temp_dir().join(format!(
            "deepcode-action-batch-compile-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).expect("create temp workspace");
        fs::write(temp.join("generic-delete-target.txt"), "delete me\n")
            .expect("write delete target");
        let mut runtime = DeepCodeKernelRuntime::new();
        runtime
            .dispatch(KernelCommand::WorkspaceOpen {
                request_id: RequestId("req-workspace-open".to_string()),
                path: temp.to_string_lossy().to_string(),
            })
            .expect("workspace opens");
        runtime
            .dispatch(KernelCommand::RunCreate {
                request_id: RequestId("req-run-create".to_string()),
                session_id: Some(SessionId("session-generic".to_string())),
                input: UserInput {
                    text: "Delete a generic file.".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(WorkspaceBinding {
                    workspace_id: None,
                    workspace_hash: None,
                    open_path: Some(temp.to_string_lossy().to_string()),
                    active_folder_id: None,
                    folder_hash: None,
                }),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .expect("runCreate succeeds");
        let record = runtime
            .record_by_run("run-1")
            .expect("run record exists")
            .clone();
        (runtime, record, temp)
    }

    #[test]
    fn delete_compile_uses_write_set_when_target_path_is_empty() {
        let (runtime, record, temp) = runtime_record_for_compile_test();
        let workspace = WorkspaceOperation {
            kind: WorkspaceOperationKind::Delete,
            target_path: Some(String::new()),
            target_kind: None,
            target_resource_kind: None,
            recursive: false,
            source_block_id: None,
            replacement_block_id: None,
            content: None,
            patch_spec: None,
            allow_empty_content: false,
            query: None,
            include: Vec::new(),
            context_lines: None,
            max_results: None,
            rename_to: None,
        };
        let operation = PlannedOperation {
            id: "delete-generic-target".to_string(),
            title: "Delete generic target".to_string(),
            capability: "fs.delete".to_string(),
            permission_labels: vec!["fs.delete".to_string()],
            target_ref: Some(FileTargetRef::from_legacy_path("generic-delete-target.txt")),
            read_set: Vec::new(),
            write_set: vec!["generic-delete-target.txt".to_string()],
            conflict_keys: vec!["generic-delete-target.txt".to_string()],
            execution_mode: OperationExecutionMode::Execute,
            operation: PlannedOperationKind::Workspace(workspace.clone()),
        };

        let compiled = workspace_delete_tool_operation(&runtime, &record, &operation, &workspace)
            .expect("delete compiles from writeSet when targetPath is empty");

        assert_eq!(compiled.tool_name, "fs.delete");
        assert_eq!(
            compiled.arguments.get("path").and_then(Value::as_str),
            Some("generic-delete-target.txt")
        );
        let _ = fs::remove_dir_all(temp);
    }

    #[test]
    fn delete_compile_uses_absolute_write_set_as_external_file_root() {
        let (runtime, record, temp) = runtime_record_for_compile_test();
        let external_dir = std::env::temp_dir().join(format!(
            "deepcode-action-batch-external-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&external_dir);
        fs::create_dir_all(&external_dir).expect("create external temp root");
        let external_file = external_dir.join("external-delete-target.txt");
        fs::write(&external_file, "delete me\n").expect("write external delete target");
        let workspace = WorkspaceOperation {
            kind: WorkspaceOperationKind::Delete,
            target_path: None,
            target_kind: None,
            target_resource_kind: None,
            recursive: false,
            source_block_id: None,
            replacement_block_id: None,
            content: None,
            patch_spec: None,
            allow_empty_content: false,
            query: None,
            include: Vec::new(),
            context_lines: None,
            max_results: None,
            rename_to: None,
        };
        let operation = PlannedOperation {
            id: "delete-external-target".to_string(),
            title: "Delete external target".to_string(),
            capability: "fs.delete".to_string(),
            permission_labels: vec!["fs.delete".to_string()],
            target_ref: Some(FileTargetRef::from_legacy_path(
                external_file.to_string_lossy().to_string(),
            )),
            read_set: Vec::new(),
            write_set: vec![external_file.to_string_lossy().to_string()],
            conflict_keys: vec![external_file.to_string_lossy().to_string()],
            execution_mode: OperationExecutionMode::Execute,
            operation: PlannedOperationKind::Workspace(workspace.clone()),
        };

        let compiled = workspace_delete_tool_operation(&runtime, &record, &operation, &workspace)
            .expect("delete compiles absolute writeSet into an external file root");

        assert_eq!(compiled.tool_name, "fs.delete");
        assert_eq!(
            compiled.arguments.get("path").and_then(Value::as_str),
            Some("external-delete-target.txt")
        );
        assert_eq!(compiled.workspace_root, Some(external_dir.clone()));
        assert_eq!(
            compiled
                .arguments
                .get("pathNormalization")
                .and_then(|value| value.get("rootSource"))
                .and_then(Value::as_str),
            Some("absolutePath")
        );
        let _ = fs::remove_dir_all(temp);
        let _ = fs::remove_dir_all(external_dir);
    }
}
