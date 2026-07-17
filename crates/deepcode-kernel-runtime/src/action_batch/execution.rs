use super::compiler::*;
use super::contract::*;
use super::pending_checkpoint::{pending_operation_checkpoint, PendingCheckpointRequest};
use super::preflight::prepare_action_batch;
use super::summary::*;
use super::targets::*;
use super::*;
use deepcode_kernel_abi::KernelActionBatch;
impl DeepCodeKernelRuntime {
    pub(crate) fn action_batch_submit(
        &mut self,
        request_id: RequestId,
        run_id: RunId,
        session_id: Option<SessionId>,
        batch: KernelActionBatch,
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
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id.clone()),
            &run_id_text,
            &session_id_text,
            RuntimeLifecycleState::Executing,
            "actionBatchAccepted",
        )? {
            events.push(event);
        }

        let plan_id = batch.plan_id.clone();
        let contract_id = Some(batch.contract_id.clone());
        let mut has_pending_permission = false;
        let mut permission_group_ids = std::collections::BTreeMap::<String, String>::new();

        let operations = match OperationCompiler::new(self.tool_registry).compile_batch(&batch) {
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
                self.append_batch_review_ready_events(
                    &mut events,
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    contract_id.as_deref().unwrap_or_default(),
                )?;
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
                self.append_batch_review_ready_events(
                    &mut events,
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    contract_id.as_deref().unwrap_or_default(),
                )?;
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
            self.append_batch_review_ready_events(
                &mut events,
                &request_id,
                &run_id_text,
                &session_id_text,
                contract_id.as_deref().unwrap_or_default(),
            )?;
            return Ok(events);
        }

        if let Err(error) = validate_operations_against_execution_contract(
            self.tool_registry,
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
            self.append_batch_review_ready_events(
                &mut events,
                &request_id,
                &run_id_text,
                &session_id_text,
                contract_id.as_deref().unwrap_or_default(),
            )?;
            return Ok(events);
        }

        let scheduler = crate::scheduler::SerialWorkUnitScheduler::build(&operations)?;
        let mut prepared_operations = match prepare_action_batch(
            self,
            &record,
            scheduler.operations(),
            contract_id.as_deref(),
        ) {
            Ok(prepared) => prepared,
            Err(failure) => {
                for operation in scheduler.operations() {
                    let work_unit_id = format!(
                        "work-unit-{}-{}",
                        safe_work_unit_segment(&plan_id),
                        safe_work_unit_segment(&operation.id)
                    );
                    if operation.id == failure.operation_id {
                        events.push(self.work_unit_failed_envelope_event(
                            &request_id,
                            &run_id_text,
                            &session_id_text,
                            &work_unit_id,
                            KernelErrorEnvelope {
                                code: "mutation_batch_preflight_failed".to_string(),
                                message: failure.error.to_string(),
                                message_key: None,
                                args: None,
                            },
                        )?);
                    } else {
                        events.push(self.work_unit_blocked_event(
                            &request_id,
                            &run_id_text,
                            &session_id_text,
                            &work_unit_id,
                            &format!(
                                "batch mutation preflight failed before execution at operation {}",
                                failure.operation_id
                            ),
                        )?);
                    }
                }
                self.append_batch_review_ready_events(
                    &mut events,
                    &request_id,
                    &run_id_text,
                    &session_id_text,
                    contract_id.as_deref().unwrap_or_default(),
                )?;
                return Ok(events);
            }
        };
        let work_unit_graph = scheduler.graph.clone();
        let graph_sequence = self.ledger.next_sequence(&run_id_text)?;
        self.append_ledger(
            &run_id_text,
            &session_id_text,
            "work_unit.graph",
            graph_sequence,
            serde_json::json!({
                "summary": "Kernel compiled action batch into a WorkUnitGraph.",
                "planId": &plan_id,
                "scheduler": {
                    "mode": "serial"
                },
                "workUnitGraph": &work_unit_graph
            }),
        )?;

        for operation in scheduler.operations() {
            let action_id = operation.id.clone();
            let work_unit_id = format!(
                "work-unit-{}-{}",
                safe_work_unit_segment(&plan_id),
                safe_work_unit_segment(&action_id)
            );
            let capability = operation.capability.as_str();
            let kind = operation_kind_name(operation);
            let prepared = prepared_operations
                .remove(&action_id)
                .expect("preflight prepares every scheduled operation");
            let mut compiled = prepared.compiled;
            let compiled_tool = compiled
                .as_ref()
                .map(|compiled| compiled_tool_summary(operation.operation_kind, compiled));
            let work_unit = WorkUnitDescriptor {
                id: work_unit_id.clone(),
                plan_id: plan_id.clone(),
                action_id: action_id.clone(),
                title: operation.title.clone(),
                tool_id: operation.tool_id.clone(),
                operation_kind: operation.operation_kind,
                capability: capability.to_string(),
                target_ref: operation.target_ref.clone(),
                read_set: operation.read_set.clone(),
                write_set: operation.write_set.clone(),
                conflict_keys: operation.conflict_keys.clone(),
                execution_mode: operation.execution_mode,
                status: WorkUnitStatus::Queued,
                compiled_tool,
            };
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

            let mut compiled = compiled
                .take()
                .expect("executable work unit compiles during batch preflight");
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
                    fact: ToolRequestFact {
                        tool_call_id: tool_call_id.clone(),
                        tool_id: compiled.tool_name.clone(),
                        operation_kind: operation.operation_kind,
                        args_preview: redact_tool_arguments(
                            operation.operation_kind,
                            &compiled.arguments,
                        ),
                    },
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
                        "argsPreview": redact_tool_arguments(
                            operation.operation_kind,
                            &compiled.arguments
                        )
                    }),
                )?;
                events.push(requested);

                let permission_id = tool_call_id.clone();
                let permission_bundle_id = contract_id.as_deref().and_then(|contract_id| {
                    permission_bundle_id_for_operation(
                        self.tool_registry,
                        &self.state,
                        &run_id_text,
                        contract_id,
                        &action_id,
                        &compiled.tool_name,
                    )
                });
                let affected_operation_ids = permission_bundle_id
                    .as_deref()
                    .and_then(|bundle_id| {
                        permission_bundle_operation_ids(
                            &self.state,
                            &run_id_text,
                            contract_id.as_deref(),
                            bundle_id,
                        )
                    })
                    .unwrap_or_else(|| vec![action_id.clone()]);
                let work_unit_ids = affected_operation_ids
                    .iter()
                    .map(|operation_id| {
                        format!(
                            "work-unit-{}-{}",
                            safe_work_unit_segment(&plan_id),
                            safe_work_unit_segment(operation_id)
                        )
                    })
                    .collect::<Vec<_>>();
                let checkpoint = pending_operation_checkpoint(
                    &self.state,
                    PendingCheckpointRequest {
                        run_id: &run_id_text,
                        permission_id: &permission_id,
                        permission_bundle_id: permission_bundle_id.as_deref(),
                        contract_id: contract_id.as_deref(),
                        request_id: &request_id.0,
                        plan_id: &plan_id,
                        operation_ids: &affected_operation_ids,
                        work_unit_ids: &work_unit_ids,
                    },
                )?;
                let pending_item = PendingKernelToolItem {
                    tool_call_id: tool_call_id.clone(),
                    tool_name: compiled.tool_name.clone(),
                    arguments: compiled.arguments.clone(),
                    request_id: Some(request_id.0.clone()),
                    work_unit_id: Some(work_unit_id.clone()),
                    action_id: Some(action_id.clone()),
                    plan_id: Some(plan_id.clone()),
                    operation_kind: operation.operation_kind,
                    read_set: operation.read_set.clone(),
                    write_set: operation.write_set.clone(),
                };
                let permission_group_key = permission_bundle_id
                    .as_deref()
                    .map(|bundle_id| format!("bundle:{bundle_id}"))
                    .unwrap_or_else(|| format!("tool-call:{tool_call_id}"));
                if let Some(existing_permission_id) =
                    permission_group_ids.get(&permission_group_key)
                {
                    if let Some(pending) = self.state.pending_tools.get_mut(existing_permission_id)
                    {
                        pending.group_items.push(pending_item);
                    }
                    continue;
                }
                permission_group_ids.insert(permission_group_key, permission_id.clone());
                self.state.pending_tools.insert(
                    permission_id.clone(),
                    PendingKernelTool {
                        run_id: run_id_text.clone(),
                        session_id: session_id_text.clone(),
                        tool_name: compiled.tool_name.clone(),
                        arguments: compiled.arguments.clone(),
                        permission_bundle_id: permission_bundle_id.clone(),
                        contract_id: contract_id.clone(),
                        affected_operation_ids: affected_operation_ids.clone(),
                        work_unit_ids: work_unit_ids.clone(),
                        request_id: Some(request_id.0.clone()),
                        work_unit_id: Some(work_unit_id.clone()),
                        action_id: Some(action_id.clone()),
                        plan_id: Some(plan_id.clone()),
                        operation_kind: operation.operation_kind,
                        read_set: operation.read_set.clone(),
                        write_set: operation.write_set.clone(),
                        group_items: vec![pending_item],
                    },
                );
                let permission_sequence = self.ledger.next_sequence(&run_id_text)?;
                let tool_capability = self.capability_for_tool(&compiled.tool_name)?;
                let tool_risk = self.risk_for_tool(&compiled.tool_name)?;
                let permission_request = deepcode_kernel_abi::PermissionRequestEnvelope {
                    id: permission_id.clone(),
                    request_kind: permission_request_kind(
                        &self.state,
                        &run_id_text,
                        contract_id.as_deref(),
                    ),
                    permission_bundle_id: permission_bundle_id.clone(),
                    contract_id: contract_id.clone(),
                    affected_operation_ids: affected_operation_ids.clone(),
                    work_unit_ids: work_unit_ids.clone(),
                    tool_id: Some(compiled.tool_name.clone()),
                    capability: tool_capability.to_string(),
                    risk_level: tool_risk,
                    summary: format!(
                        "Allow {} to access workspace resources?",
                        compiled.tool_name
                    ),
                    args_preview: redact_tool_arguments(
                        operation.operation_kind,
                        &compiled.arguments,
                    ),
                };
                let permission = KernelEvent::PermissionRequested {
                    run_id: Some(RunId(run_id_text.clone())),
                    session_id: SessionId(session_id_text.clone()),
                    request: permission_request.clone(),
                    sequence: Some(permission_sequence),
                };
                self.append_ledger(
                    &run_id_text,
                    &session_id_text,
                    "permission.requested",
                    permission_sequence,
                    serde_json::to_value(deepcode_kernel_abi::PermissionRequestedFact {
                        request: permission_request,
                        checkpoint,
                    })
                    .map_err(|error| {
                        KernelError::InvalidCommand(format!(
                            "encode permission request fact: {error}"
                        ))
                    })?,
                )?;
                events.push(permission);
                if let Some(event) = self.transition_runtime_lifecycle(
                    Some(request_id.clone()),
                    &run_id_text,
                    &session_id_text,
                    RuntimeLifecycleState::AwaitingPermission,
                    "permissionRequested",
                )? {
                    events.push(event);
                }
                continue;
            }

            let executed_tool_name = compiled.tool_name.clone();
            let tool_event = self.execute_bound_tool(
                &run_id_text,
                &session_id_text,
                tool_call_id,
                compiled.tool_name,
                operation.operation_kind,
                compiled.arguments,
            )?;
            let tool_ok = matches!(
                &tool_event,
                KernelEvent::ToolCompleted { fact, .. } if fact.ok
            );
            let tool_error = match &tool_event {
                KernelEvent::ToolCompleted { fact, .. } => fact.error.clone(),
                _ => None,
            };
            let tool_output = match &tool_event {
                KernelEvent::ToolCompleted { fact, .. } => fact.output.clone(),
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
            self.append_batch_review_ready_events(
                &mut events,
                &request_id,
                &run_id_text,
                &session_id_text,
                contract_id.as_deref().unwrap_or_default(),
            )?;
        }
        Ok(events)
    }
}
