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
        if record.lifecycle_state == RuntimeLifecycleState::Terminating {
            return Err(KernelError::Structured {
                code: "run_cleanup_pending",
                stage: "action_batch.admission",
                message: "action batch cannot start while Kernel cleanup is pending".to_string(),
                details: serde_json::json!({ "runId": run_id_text }),
            });
        }
        if record.lifecycle_state == RuntimeLifecycleState::Terminal {
            return Err(KernelError::Structured {
                code: "run_terminal",
                stage: "action_batch.admission",
                message: "action batch cannot start after the run reached terminal state"
                    .to_string(),
                details: serde_json::json!({ "runId": run_id_text }),
            });
        }
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

        let mut batch_operations = Vec::with_capacity(operations.len());
        let mut permission_groups = std::collections::BTreeMap::<String, Vec<usize>>::new();
        let mut permission_bundle_ids = std::collections::BTreeMap::<String, Option<String>>::new();

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
                batch_operations.push(BatchOperationRuntime {
                    operation_id: action_id,
                    depends_on: operation.depends_on.clone(),
                    work_unit_id,
                    tool_call_id: String::new(),
                    tool_id: operation.tool_id.clone(),
                    operation_kind: operation.operation_kind,
                    arguments: Value::Null,
                    read_set: operation.read_set.clone(),
                    write_set: operation.write_set.clone(),
                    state: BatchOperationState::Blocked,
                    permission_id: None,
                });
                continue;
            }

            let mut compiled = compiled
                .take()
                .expect("executable work unit compiles during batch preflight");
            attach_kernel_context_to_arguments(
                &mut compiled.arguments,
                &plan_id,
                contract_id.as_deref().unwrap_or_default(),
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
                safe_work_unit_segment(&compiled.tool_id)
            );
            let permission_action = self.effective_permission_action_for_tool(
                &run_id_text,
                &compiled.tool_id,
                &compiled.arguments,
            )?;
            if permission_action == PermissionAction::Deny {
                for scheduled in scheduler.operations() {
                    let scheduled_work_unit_id = format!(
                        "work-unit-{}-{}",
                        safe_work_unit_segment(&plan_id),
                        safe_work_unit_segment(&scheduled.id)
                    );
                    if scheduled.id == action_id {
                        events.push(self.work_unit_failed_envelope_event(
                            &request_id,
                            &run_id_text,
                            &session_id_text,
                            &scheduled_work_unit_id,
                            KernelErrorEnvelope {
                                code: "batch_permission_preflight_denied".to_string(),
                                message: format!("{} is denied by Kernel policy", compiled.tool_id),
                                message_key: None,
                                args: None,
                            },
                        )?);
                    } else {
                        events.push(self.work_unit_blocked_event(
                            &request_id,
                            &run_id_text,
                            &session_id_text,
                            &scheduled_work_unit_id,
                            "batch permission preflight failed before execution",
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

            let operation_index = batch_operations.len();
            let permission_bundle_id = contract_id.as_deref().and_then(|contract_id| {
                permission_bundle_id_for_operation(
                    &self.state,
                    &run_id_text,
                    contract_id,
                    &action_id,
                )
            });
            let permission_id = (permission_action == PermissionAction::Ask).then(|| {
                let group_identity = permission_bundle_id.as_deref().unwrap_or(&action_id);
                resource_instance_id(
                    "permission",
                    &[
                        &run_id_text,
                        contract_id.as_deref().unwrap_or_default(),
                        group_identity,
                    ],
                )
            });
            batch_operations.push(BatchOperationRuntime {
                operation_id: action_id.clone(),
                depends_on: operation.depends_on.clone(),
                work_unit_id: work_unit_id.clone(),
                tool_call_id,
                tool_id: compiled.tool_id,
                operation_kind: operation.operation_kind,
                arguments: compiled.arguments,
                read_set: operation.read_set.clone(),
                write_set: operation.write_set.clone(),
                state: if permission_id.is_some() {
                    BatchOperationState::AwaitingPermission
                } else {
                    BatchOperationState::Ready
                },
                permission_id: permission_id.clone(),
            });
            if let Some(permission_id) = permission_id {
                permission_groups
                    .entry(permission_id.clone())
                    .or_default()
                    .push(operation_index);
                permission_bundle_ids
                    .entry(permission_id)
                    .or_insert(permission_bundle_id);
            }
        }

        self.state.batch_checkpoints_by_run.insert(
            run_id_text.clone(),
            BatchRuntimeCheckpoint {
                request_id: request_id.0.clone(),
                session_id: session_id_text.clone(),
                plan_id: plan_id.clone(),
                contract_id: contract_id.clone().unwrap_or_default(),
                operations: batch_operations,
                permission_decisions: std::collections::BTreeMap::new(),
                scheduler_revision: 1,
            },
        );
        self.persist_batch_checkpoint(&run_id_text)?;

        for (permission_id, indexes) in permission_groups {
            self.register_batch_permission_request(
                &mut events,
                &request_id,
                &run_id_text,
                &session_id_text,
                &plan_id,
                contract_id.as_deref(),
                &permission_id,
                permission_bundle_ids
                    .get(&permission_id)
                    .and_then(|value| value.as_deref()),
                &indexes,
            )?;
        }
        if self.has_pending_permission_for_run(&run_id_text) {
            if let Some(event) = self.transition_runtime_lifecycle(
                Some(request_id),
                &run_id_text,
                &session_id_text,
                RuntimeLifecycleState::AwaitingPermission,
                "batchPermissionGate",
            )? {
                events.push(event);
            }
        } else {
            events.extend(self.resume_batch_checkpoint(&run_id_text)?);
        }
        Ok(events)
    }

    fn register_batch_permission_request(
        &mut self,
        events: &mut Vec<KernelEvent>,
        request_id: &RequestId,
        run_id: &str,
        session_id: &str,
        plan_id: &str,
        contract_id: Option<&str>,
        permission_id: &str,
        permission_bundle_id: Option<&str>,
        operation_indexes: &[usize],
    ) -> KernelResult<()> {
        let checkpoint = self
            .state
            .batch_checkpoints_by_run
            .get(run_id)
            .cloned()
            .ok_or_else(|| {
                KernelError::InvalidCommand("batch checkpoint is unavailable".to_string())
            })?;
        let operations = operation_indexes
            .iter()
            .map(|index| {
                checkpoint.operations.get(*index).cloned().ok_or_else(|| {
                    KernelError::InvalidCommand("permission operation index is invalid".to_string())
                })
            })
            .collect::<KernelResult<Vec<_>>>()?;
        let affected_operation_ids = operations
            .iter()
            .map(|operation| operation.operation_id.clone())
            .collect::<Vec<_>>();
        let work_unit_ids = operations
            .iter()
            .map(|operation| operation.work_unit_id.clone())
            .collect::<Vec<_>>();
        let pending_checkpoint = pending_operation_checkpoint(
            &self.state,
            PendingCheckpointRequest {
                run_id,
                permission_id,
                permission_bundle_id,
                contract_id,
                request_id: &request_id.0,
                plan_id,
                operation_ids: &affected_operation_ids,
                work_unit_ids: &work_unit_ids,
            },
        )?;
        let group_items = operations
            .iter()
            .map(|operation| PendingKernelToolItem {
                tool_call_id: operation.tool_call_id.clone(),
                tool_id: operation.tool_id.clone(),
                arguments: operation.arguments.clone(),
                work_unit_id: Some(operation.work_unit_id.clone()),
                action_id: Some(operation.operation_id.clone()),
                plan_id: Some(plan_id.to_string()),
                operation_kind: operation.operation_kind,
                read_set: operation.read_set.clone(),
                write_set: operation.write_set.clone(),
            })
            .collect::<Vec<_>>();
        let first = group_items.first().cloned().ok_or_else(|| {
            KernelError::InvalidCommand("permission group contains no operations".to_string())
        })?;
        let pending = PendingKernelTool {
            run_id: run_id.to_string(),
            session_id: session_id.to_string(),
            tool_id: first.tool_id.clone(),
            arguments: first.arguments.clone(),
            permission_bundle_id: permission_bundle_id.map(str::to_string),
            contract_id: contract_id.map(str::to_string),
            affected_operation_ids: affected_operation_ids.clone(),
            work_unit_ids: work_unit_ids.clone(),
            work_unit_id: first.work_unit_id.clone(),
            action_id: first.action_id.clone(),
            plan_id: Some(plan_id.to_string()),
            operation_kind: first.operation_kind,
            read_set: first.read_set.clone(),
            write_set: first.write_set.clone(),
            group_items,
        };

        for item in &pending.group_items {
            let fact = ToolRequestFact {
                tool_call_id: item.tool_call_id.clone(),
                tool_id: item.tool_id.clone(),
                operation_kind: item.operation_kind,
                args_preview: redact_tool_arguments(item.operation_kind, &item.arguments),
            };
            let sequence = self.ledger.next_sequence(run_id)?;
            self.append_ledger(
                run_id,
                session_id,
                "tool.requested",
                sequence,
                serde_json::to_value(&fact).map_err(|error| {
                    KernelError::InvalidCommand(format!("encode tool request fact: {error}"))
                })?,
            )?;
            events.push(KernelEvent::ToolRequested {
                run_id: Some(RunId(run_id.to_string())),
                session_id: Some(SessionId(session_id.to_string())),
                turn_id: None,
                fact,
                sequence: Some(sequence),
            });
        }

        let permission_request = deepcode_kernel_abi::PermissionRequestEnvelope {
            id: permission_id.to_string(),
            request_kind: permission_request_kind(&self.state, run_id, contract_id),
            permission_bundle_id: permission_bundle_id.map(str::to_string),
            contract_id: contract_id.map(str::to_string),
            affected_operation_ids,
            work_unit_ids,
            tool_id: Some(pending.tool_id.clone()),
            capability: self.capability_for_tool(&pending.tool_id)?.to_string(),
            risk_level: self.risk_for_tool(&pending.tool_id)?,
            summary: format!(
                "Allow {} to access the declared resources?",
                pending.tool_id
            ),
            args_preview: redact_tool_arguments(pending.operation_kind, &pending.arguments),
        };
        let permission_sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            session_id,
            "permission.requested",
            permission_sequence,
            serde_json::to_value(deepcode_kernel_abi::PermissionRequestedFact {
                request: permission_request.clone(),
                checkpoint: pending_checkpoint,
            })
            .map_err(|error| {
                KernelError::InvalidCommand(format!("encode permission request fact: {error}"))
            })?,
        )?;
        self.state
            .pending_tools
            .insert(permission_id.to_string(), pending);
        events.push(KernelEvent::PermissionRequested {
            run_id: Some(RunId(run_id.to_string())),
            session_id: SessionId(session_id.to_string()),
            request: permission_request,
            sequence: Some(permission_sequence),
        });
        Ok(())
    }

    pub(crate) fn persist_batch_checkpoint(&self, run_id: &str) -> KernelResult<()> {
        let checkpoint = self
            .state
            .batch_checkpoints_by_run
            .get(run_id)
            .ok_or_else(|| {
                KernelError::InvalidCommand("batch checkpoint is unavailable".to_string())
            })?;
        let sequence = self.ledger.next_sequence(run_id)?;
        self.append_ledger(
            run_id,
            &checkpoint.session_id,
            "batch.runtime_checkpoint",
            sequence,
            batch_checkpoint_payload(checkpoint),
        )
    }

    pub(crate) fn resume_batch_checkpoint(
        &mut self,
        run_id: &str,
    ) -> KernelResult<Vec<KernelEvent>> {
        let checkpoint = self
            .state
            .batch_checkpoints_by_run
            .get(run_id)
            .cloned()
            .ok_or_else(|| {
                KernelError::InvalidCommand("batch checkpoint is unavailable".to_string())
            })?;
        if checkpoint.operations.iter().any(|operation| {
            operation.state == BatchOperationState::AwaitingPermission
                && operation
                    .permission_id
                    .as_ref()
                    .is_some_and(|permission_id| {
                        !checkpoint.permission_decisions.contains_key(permission_id)
                    })
        }) {
            return Ok(Vec::new());
        }
        let request_id = RequestId(checkpoint.request_id.clone());
        let session_id = checkpoint.session_id.clone();
        let mut events = Vec::new();
        if let Some(event) = self.transition_runtime_lifecycle(
            Some(request_id.clone()),
            run_id,
            &session_id,
            RuntimeLifecycleState::Executing,
            "batchPermissionGateResolved",
        )? {
            events.push(event);
        }

        loop {
            let snapshot = self
                .state
                .batch_checkpoints_by_run
                .get(run_id)
                .cloned()
                .ok_or_else(|| {
                    KernelError::InvalidCommand("batch checkpoint disappeared".to_string())
                })?;
            let mut progressed = false;
            for index in 0..snapshot.operations.len() {
                let operation = snapshot.operations[index].clone();
                if matches!(
                    operation.state,
                    BatchOperationState::Completed
                        | BatchOperationState::Failed
                        | BatchOperationState::Blocked
                ) {
                    continue;
                }
                if operation.state == BatchOperationState::AwaitingPermission {
                    let decision = operation
                        .permission_id
                        .as_ref()
                        .and_then(|permission_id| snapshot.permission_decisions.get(permission_id));
                    match decision {
                        Some(deepcode_kernel_abi::PermissionDecisionKind::Accept) => {
                            self.set_batch_operation_state(
                                run_id,
                                index,
                                BatchOperationState::Ready,
                            )?;
                            progressed = true;
                            continue;
                        }
                        Some(deepcode_kernel_abi::PermissionDecisionKind::Reject) => {
                            self.set_batch_operation_state(
                                run_id,
                                index,
                                BatchOperationState::Blocked,
                            )?;
                            events.push(self.work_unit_blocked_event(
                                &request_id,
                                run_id,
                                &session_id,
                                &operation.work_unit_id,
                                "permission rejected by user",
                            )?);
                            progressed = true;
                            continue;
                        }
                        None => continue,
                    }
                }

                let current = self
                    .state
                    .batch_checkpoints_by_run
                    .get(run_id)
                    .and_then(|value| value.operations.get(index))
                    .cloned()
                    .ok_or_else(|| {
                        KernelError::InvalidCommand("batch operation disappeared".to_string())
                    })?;
                if current.state != BatchOperationState::Ready {
                    continue;
                }
                let dependency_states = current
                    .depends_on
                    .iter()
                    .filter_map(|dependency_id| {
                        snapshot
                            .operations
                            .iter()
                            .find(|candidate| candidate.operation_id == *dependency_id)
                            .map(|candidate| candidate.state)
                    })
                    .collect::<Vec<_>>();
                if dependency_states.iter().any(|state| {
                    matches!(
                        state,
                        BatchOperationState::Failed | BatchOperationState::Blocked
                    )
                }) {
                    self.set_batch_operation_state(run_id, index, BatchOperationState::Blocked)?;
                    events.push(self.work_unit_blocked_event(
                        &request_id,
                        run_id,
                        &session_id,
                        &current.work_unit_id,
                        "dependency_unsatisfied",
                    )?);
                    progressed = true;
                    continue;
                }
                if !dependency_states
                    .iter()
                    .all(|state| *state == BatchOperationState::Completed)
                {
                    continue;
                }

                self.set_batch_operation_state(run_id, index, BatchOperationState::Started)?;
                events.push(self.work_unit_started_event(
                    &request_id,
                    run_id,
                    &session_id,
                    &current.work_unit_id,
                )?);
                let tool_id = current.tool_id.clone();
                let tool_events = self.execute_bound_tool(
                    run_id,
                    &session_id,
                    current.tool_call_id,
                    current.tool_id,
                    current.operation_kind,
                    current.arguments,
                )?;
                let completion = tool_events.iter().find_map(|event| match event {
                    KernelEvent::ToolCompleted { fact, .. } => Some(fact.clone()),
                    _ => None,
                });
                let indeterminate = tool_events.iter().find_map(|event| match event {
                    KernelEvent::ToolOutcomeIndeterminate { fact, .. } => Some(fact.clone()),
                    _ => None,
                });
                events.extend(tool_events);
                let (ok, output, error) = if let Some(fact) = completion {
                    (fact.ok, fact.output, fact.error)
                } else if let Some(fact) = indeterminate {
                    (
                        false,
                        None,
                        Some(KernelErrorEnvelope {
                            code: "tool_outcome_indeterminate".to_string(),
                            message: fact.reason,
                            message_key: None,
                            args: None,
                        }),
                    )
                } else {
                    return Err(KernelError::Structured {
                        code: "tool_terminal_fact_missing",
                        stage: "tool.execute",
                        message: "tool execution produced no completion or indeterminate fact"
                            .to_string(),
                        details: serde_json::json!({
                            "runId": run_id,
                            "workUnitId": current.work_unit_id,
                            "toolId": tool_id,
                        }),
                    });
                };
                if ok {
                    self.set_batch_operation_state(run_id, index, BatchOperationState::Completed)?;
                    events.push(self.work_unit_completed_event(
                        &request_id,
                        run_id,
                        &session_id,
                        &current.work_unit_id,
                        output,
                    )?);
                } else {
                    self.set_batch_operation_state(run_id, index, BatchOperationState::Failed)?;
                    events.push(self.work_unit_failed_envelope_event(
                        &request_id,
                        run_id,
                        &session_id,
                        &current.work_unit_id,
                        error.unwrap_or_else(|| KernelErrorEnvelope {
                            code: format!("{}_failed", tool_id.replace('.', "_")),
                            message: format!("{tool_id} did not produce a successful tool result"),
                            message_key: None,
                            args: None,
                        }),
                    )?);
                }
                progressed = true;
                break;
            }
            if !progressed {
                break;
            }
        }

        let terminal = self
            .state
            .batch_checkpoints_by_run
            .get(run_id)
            .is_some_and(|value| {
                value.operations.iter().all(|operation| {
                    matches!(
                        operation.state,
                        BatchOperationState::Completed
                            | BatchOperationState::Failed
                            | BatchOperationState::Blocked
                    )
                })
            });
        if terminal {
            let contract_id = self
                .state
                .batch_checkpoints_by_run
                .get(run_id)
                .map(|value| value.contract_id.clone())
                .unwrap_or_default();
            self.append_batch_review_ready_events(
                &mut events,
                &request_id,
                run_id,
                &session_id,
                &contract_id,
            )?;
        }
        Ok(events)
    }

    fn set_batch_operation_state(
        &mut self,
        run_id: &str,
        index: usize,
        state: BatchOperationState,
    ) -> KernelResult<()> {
        let checkpoint = self
            .state
            .batch_checkpoints_by_run
            .get_mut(run_id)
            .ok_or_else(|| {
                KernelError::InvalidCommand("batch checkpoint is unavailable".to_string())
            })?;
        let operation = checkpoint.operations.get_mut(index).ok_or_else(|| {
            KernelError::InvalidCommand("batch operation index is invalid".to_string())
        })?;
        operation.state = state;
        checkpoint.scheduler_revision += 1;
        self.persist_batch_checkpoint(run_id)
    }
}

fn batch_operation_state_name(state: BatchOperationState) -> &'static str {
    match state {
        BatchOperationState::AwaitingPermission => "awaitingPermission",
        BatchOperationState::Ready => "ready",
        BatchOperationState::Started => "started",
        BatchOperationState::Completed => "completed",
        BatchOperationState::Failed => "failed",
        BatchOperationState::Blocked => "blocked",
    }
}

pub(crate) fn batch_checkpoint_payload(checkpoint: &BatchRuntimeCheckpoint) -> Value {
    serde_json::json!({
        "summary": "Kernel persisted the serial batch scheduler checkpoint.",
        "contractId": checkpoint.contract_id,
        "planId": checkpoint.plan_id,
        "requestId": checkpoint.request_id,
        "schedulerRevision": checkpoint.scheduler_revision,
        "permissionDecisions": checkpoint.permission_decisions,
        "operations": checkpoint.operations.iter().map(|operation| serde_json::json!({
            "operationId": operation.operation_id,
            "workUnitId": operation.work_unit_id,
            "toolId": operation.tool_id,
            "dependsOn": operation.depends_on,
            "state": batch_operation_state_name(operation.state),
            "permissionId": operation.permission_id,
        })).collect::<Vec<_>>()
    })
}
