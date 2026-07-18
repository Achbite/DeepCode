use super::*;
use deepcode_kernel_abi::{
    PendingOperationCheckpoint, PermissionRequestedFact, PermissionResolutionFact,
    PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION,
};
use deepcode_kernel_tools::{KernelExecutionContract, KernelExecutionOperation};

impl DeepCodeKernelRuntime {
    pub(crate) fn restore_execution_contracts_from_ledger(
        &mut self,
        run_id: &str,
    ) -> KernelResult<()> {
        if self.state.execution_contracts_by_run.contains_key(run_id) {
            return Ok(());
        }
        let events = self.ledger.list_by_run(run_id)?;
        let mut contracts = std::collections::BTreeMap::new();
        for event in events
            .iter()
            .filter(|event| event.kind == "proposal.reviewed")
        {
            let Some(value) = event
                .payload
                .get("report")
                .and_then(|report| report.get("executionContract"))
            else {
                return Err(KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "batch.restore",
                    message: "proposal.reviewed is missing executionContract".to_string(),
                    details: serde_json::json!({ "runId": run_id }),
                });
            };
            let contract: KernelExecutionContract =
                serde_json::from_value(value.clone()).map_err(|error| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "batch.restore",
                    message: format!("decode execution contract: {error}"),
                    details: serde_json::json!({ "runId": run_id }),
                })?;
            contracts.insert(contract.id.clone(), contract);
        }
        if !contracts.is_empty() {
            self.state
                .execution_contracts_by_run
                .insert(run_id.to_string(), contracts);
        }
        Ok(())
    }

    pub(crate) fn restore_batch_checkpoint_from_ledger(
        &mut self,
        run_id: &str,
    ) -> KernelResult<()> {
        if self.state.batch_checkpoints_by_run.contains_key(run_id) {
            return Ok(());
        }
        let events = self.ledger.list_by_run(run_id)?;
        let Some(checkpoint_event) = events
            .iter()
            .rev()
            .find(|event| event.kind == "batch.runtime_checkpoint")
        else {
            return Ok(());
        };
        let checkpoint_sequence = required_ledger_sequence(checkpoint_event, "batch.restore")?;
        for event in events
            .iter()
            .filter(|event| event.kind == "batch.review_ready")
        {
            if required_ledger_sequence(event, "batch.restore")? > checkpoint_sequence {
                return Ok(());
            }
        }
        let required_string = |field: &str| {
            checkpoint_event
                .payload
                .get(field)
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "batch.restore",
                    message: format!("batch checkpoint is missing {field}"),
                    details: serde_json::json!({ "runId": run_id, "field": field }),
                })
        };
        let contract_id = required_string("contractId")?;
        let plan_id = required_string("planId")?;
        let request_id = required_string("requestId")?;
        let session_id =
            checkpoint_event
                .session_id
                .clone()
                .ok_or_else(|| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "batch.restore",
                    message: "batch checkpoint is missing sessionId".to_string(),
                    details: serde_json::json!({ "runId": run_id }),
                })?;
        let contract = execution_contract_from_ledger(&events, &contract_id)?;
        let operation_values = checkpoint_event
            .payload
            .get("operations")
            .and_then(Value::as_array)
            .ok_or_else(|| KernelError::Structured {
                code: "run_recovery_schema_invalid",
                stage: "batch.restore",
                message: "batch checkpoint is missing operations".to_string(),
                details: serde_json::json!({ "runId": run_id }),
            })?;
        let mut operations = Vec::with_capacity(operation_values.len());
        for value in operation_values {
            let operation_id = value
                .get("operationId")
                .and_then(Value::as_str)
                .ok_or_else(|| recovery_field_error(run_id, "operationId"))?;
            let work_unit_id = value
                .get("workUnitId")
                .and_then(Value::as_str)
                .ok_or_else(|| recovery_field_error(run_id, "workUnitId"))?;
            let contract_operation = contract
                .operations
                .iter()
                .find(|operation| operation.id == operation_id)
                .ok_or_else(|| KernelError::Structured {
                    code: "run_recovery_schema_invalid",
                    stage: "batch.restore",
                    message: "batch checkpoint operation is absent from its contract".to_string(),
                    details: serde_json::json!({
                        "runId": run_id,
                        "contractId": contract_id,
                        "operationId": operation_id,
                    }),
                })?;
            let mut arguments =
                restore_operation_arguments(&events, &contract_id, contract_operation)?;
            crate::action_batch::attach_kernel_context_to_arguments(
                &mut arguments,
                &plan_id,
                &contract_id,
                work_unit_id,
                operation_id,
                contract_operation.operation_kind.wire_name(),
            );
            operations.push(BatchOperationRuntime {
                operation_id: operation_id.to_string(),
                depends_on: contract_operation.depends_on.clone(),
                work_unit_id: work_unit_id.to_string(),
                tool_call_id: format!(
                    "{work_unit_id}-{}",
                    crate::action_batch::safe_work_unit_segment(&contract_operation.tool_id)
                ),
                tool_id: contract_operation.tool_id.clone(),
                operation_kind: contract_operation.operation_kind,
                arguments,
                read_set: contract_operation.read_set.clone(),
                write_set: contract_operation.write_set.clone(),
                state: decode_batch_operation_state(
                    value
                        .get("state")
                        .and_then(Value::as_str)
                        .ok_or_else(|| recovery_field_error(run_id, "state"))?,
                )?,
                permission_id: value
                    .get("permissionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
        let permission_decisions = serde_json::from_value(
            checkpoint_event
                .payload
                .get("permissionDecisions")
                .cloned()
                .ok_or_else(|| recovery_field_error(run_id, "permissionDecisions"))?,
        )
        .map_err(|error| KernelError::Structured {
            code: "run_recovery_schema_invalid",
            stage: "batch.restore",
            message: format!("decode permission decisions: {error}"),
            details: serde_json::json!({ "runId": run_id }),
        })?;
        let scheduler_revision = checkpoint_event
            .payload
            .get("schedulerRevision")
            .and_then(Value::as_u64)
            .ok_or_else(|| recovery_field_error(run_id, "schedulerRevision"))?;
        self.state.batch_checkpoints_by_run.insert(
            run_id.to_string(),
            BatchRuntimeCheckpoint {
                request_id,
                session_id,
                plan_id,
                contract_id,
                operations,
                permission_decisions,
                scheduler_revision,
            },
        );
        Ok(())
    }

    pub(crate) fn pending_permission_for_run(
        &self,
        run_id: &str,
    ) -> KernelResult<Option<deepcode_kernel_abi::PermissionRequestEnvelope>> {
        if let Some((permission_id, pending)) = self
            .state
            .pending_tools
            .iter()
            .find(|(_, pending)| pending.run_id == run_id)
        {
            return Ok(Some(permission_envelope_from_pending(
                self,
                permission_id,
                pending,
            )?));
        }
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = resolved_permission_ids(&events)?;
        let Some((_, fact)) = latest_pending_permission_fact(&events, &resolved)? else {
            return Ok(None);
        };
        let tool_id = fact.request.tool_id.as_deref().ok_or_else(|| {
            KernelError::PendingPermissionUnavailable(
                "pending permission fact has no toolId".to_string(),
            )
        })?;
        self.capability_for_tool(tool_id)?;
        self.risk_for_tool(tool_id)?;
        Ok(Some(fact.request))
    }

    pub(crate) fn ensure_permission_restored(&mut self, permission_id: &str) -> KernelResult<()> {
        if self.state.pending_tools.contains_key(permission_id) {
            return Ok(());
        }
        let events = self.ledger.list_all()?;
        let already_resolved = resolved_permission_ids(&events)?.contains(permission_id);
        if already_resolved {
            return Ok(());
        }
        let requested = events
            .iter()
            .rev()
            .filter(|event| event.kind == "permission.requested")
            .map(|event| Ok((event, decode_permission_request(event)?)))
            .collect::<KernelResult<Vec<_>>>()?
            .into_iter()
            .find(|(_, fact)| fact.request.id == permission_id);
        let Some((requested, requested_fact)) = requested else {
            return Ok(());
        };
        let Some(run_id) = requested.run_id.clone() else {
            return Ok(());
        };
        let Some(session_id) = requested.session_id.clone() else {
            return Ok(());
        };
        self.ensure_session_restored(&session_id)?;
        let restored = pending_tool_from_fact(&run_id, &events, requested, requested_fact)?;
        self.state
            .pending_tools
            .insert(permission_id.to_string(), restored);
        Ok(())
    }

    pub(crate) fn pending_tools_from_ledger(
        &self,
        run_id: &str,
    ) -> KernelResult<Vec<(String, PendingKernelTool)>> {
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = resolved_permission_ids(&events)?;
        events
            .iter()
            .filter(|event| event.kind == "permission.requested")
            .map(|event| Ok((event, decode_permission_request(event)?)))
            .collect::<KernelResult<Vec<_>>>()?
            .into_iter()
            .filter(|(_, fact)| !resolved.contains(&fact.request.id))
            .map(|(event, fact)| {
                let permission_id = fact.request.id.clone();
                pending_tool_from_fact(run_id, &events, event, fact)
                    .map(|pending| (permission_id, pending))
            })
            .collect()
    }
}

fn pending_tool_from_fact(
    run_id: &str,
    events: &[LedgerEvent],
    requested: &LedgerEvent,
    requested_fact: PermissionRequestedFact,
) -> KernelResult<PendingKernelTool> {
    let checkpoint: PendingOperationCheckpoint = requested_fact.checkpoint;
    if checkpoint.schema_version != PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION {
        return Err(KernelError::PendingPermissionUnavailable(format!(
            "unsupported pending operation checkpoint schema {}",
            checkpoint.schema_version
        )));
    }
    let contract = execution_contract_from_ledger(events, &checkpoint.contract_id)?;
    if contract.contract_hash != checkpoint.contract_hash {
        return Err(KernelError::PendingPermissionUnavailable(
            "pending operation checkpoint contract hash mismatch".to_string(),
        ));
    }
    let mut group_items = Vec::with_capacity(checkpoint.items.len());
    for checkpoint_item in &checkpoint.items {
        let operation = contract
            .operations
            .iter()
            .find(|operation| operation.id == checkpoint_item.operation_id)
            .ok_or_else(|| {
                KernelError::PendingPermissionUnavailable(format!(
                    "execution contract {} no longer contains operation {}",
                    checkpoint.contract_id, checkpoint_item.operation_id
                ))
            })?;
        if operation.tool_id != checkpoint_item.tool_id
            || operation.args_hash != checkpoint_item.args_hash
            || operation.read_set != checkpoint_item.read_set
            || operation.write_set != checkpoint_item.write_set
        {
            return Err(KernelError::PendingPermissionUnavailable(format!(
                "pending operation checkpoint does not match operation {}",
                checkpoint_item.operation_id
            )));
        }
        let mut arguments =
            restore_operation_arguments(events, &checkpoint.contract_id, operation)?;
        crate::action_batch::attach_kernel_context_to_arguments(
            &mut arguments,
            &checkpoint.plan_id,
            &checkpoint.contract_id,
            &checkpoint_item.work_unit_id,
            &checkpoint_item.operation_id,
            operation.operation_kind.wire_name(),
        );
        group_items.push(PendingKernelToolItem {
            tool_call_id: checkpoint_item.tool_call_id.clone(),
            tool_id: operation.tool_id.clone(),
            arguments,
            work_unit_id: Some(checkpoint_item.work_unit_id.clone()),
            action_id: Some(checkpoint_item.operation_id.clone()),
            plan_id: Some(checkpoint.plan_id.clone()),
            operation_kind: operation.operation_kind,
            read_set: operation.read_set.clone(),
            write_set: operation.write_set.clone(),
        });
    }
    let first = group_items.first().cloned().ok_or_else(|| {
        KernelError::PendingPermissionUnavailable(
            "pending operation checkpoint contains no operations".to_string(),
        )
    })?;
    Ok(PendingKernelTool {
        run_id: run_id.to_string(),
        session_id: requested.session_id.clone().ok_or_else(|| {
            KernelError::PendingPermissionUnavailable(
                "pending permission is missing sessionId".to_string(),
            )
        })?,
        tool_id: first.tool_id.clone(),
        arguments: first.arguments.clone(),
        permission_bundle_id: checkpoint.permission_bundle_id,
        contract_id: Some(checkpoint.contract_id),
        affected_operation_ids: checkpoint
            .items
            .iter()
            .map(|item| item.operation_id.clone())
            .collect(),
        work_unit_ids: checkpoint
            .items
            .iter()
            .map(|item| item.work_unit_id.clone())
            .collect(),
        work_unit_id: first.work_unit_id.clone(),
        action_id: first.action_id.clone(),
        plan_id: first.plan_id.clone(),
        operation_kind: first.operation_kind,
        read_set: first.read_set.clone(),
        write_set: first.write_set.clone(),
        group_items,
    })
}

fn resolved_permission_ids(
    events: &[LedgerEvent],
) -> KernelResult<std::collections::BTreeSet<String>> {
    events
        .iter()
        .filter(|event| event.kind == "permission.resolved")
        .map(|event| {
            serde_json::from_value::<PermissionResolutionFact>(event.payload.clone())
                .map(|fact| fact.permission_id)
                .map_err(|error| {
                    KernelError::PendingPermissionUnavailable(format!(
                        "decode permission resolution fact: {error}"
                    ))
                })
        })
        .collect()
}

fn latest_pending_permission_fact<'a>(
    events: &'a [LedgerEvent],
    resolved: &std::collections::BTreeSet<String>,
) -> KernelResult<Option<(&'a LedgerEvent, PermissionRequestedFact)>> {
    for event in events
        .iter()
        .rev()
        .filter(|event| event.kind == "permission.requested")
    {
        let fact = decode_permission_request(event)?;
        if !resolved.contains(&fact.request.id) {
            return Ok(Some((event, fact)));
        }
    }
    Ok(None)
}

fn decode_permission_request(event: &LedgerEvent) -> KernelResult<PermissionRequestedFact> {
    serde_json::from_value(event.payload.clone()).map_err(|error| {
        KernelError::PendingPermissionUnavailable(format!(
            "decode permission request fact: {error}"
        ))
    })
}

fn execution_contract_from_ledger(
    events: &[LedgerEvent],
    contract_id: &str,
) -> KernelResult<KernelExecutionContract> {
    events
        .iter()
        .rev()
        .filter(|event| event.kind == "proposal.reviewed")
        .filter_map(|event| {
            event
                .payload
                .get("report")
                .and_then(|report| report.get("executionContract"))
        })
        .find(|contract| contract.get("id").and_then(Value::as_str) == Some(contract_id))
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| {
            KernelError::PendingPermissionUnavailable(format!(
                "decode accepted execution contract {contract_id}: {error}"
            ))
        })?
        .ok_or_else(|| {
            KernelError::PendingPermissionUnavailable(format!(
                "accepted execution contract {contract_id} is unavailable in the ledger"
            ))
        })
}

pub(super) fn restore_operation_arguments(
    events: &[LedgerEvent],
    contract_id: &str,
    operation: &KernelExecutionOperation,
) -> KernelResult<Value> {
    let mut arguments = operation.args.clone();
    if let Some(block_id) = operation.args.get("contentBlockId").and_then(Value::as_str) {
        let content = restore_artifact_block(
            events,
            block_id,
            operation.args.get("contentHash").and_then(Value::as_str),
        )?;
        if let Some(object) = arguments.as_object_mut() {
            object.insert("content".to_string(), Value::String(content));
        }
    }
    if let Some(block_id) = operation
        .args
        .get("replacementBlockId")
        .and_then(Value::as_str)
    {
        let replacement = restore_artifact_block(
            events,
            block_id,
            operation.args.get("contentHash").and_then(Value::as_str),
        )?;
        if let Some(object) = arguments.as_object_mut() {
            object.insert("replacement".to_string(), Value::String(replacement));
        }
    }
    if matches!(
        operation.operation_kind,
        ToolOperationKind::WebSearch | ToolOperationKind::WebFetch
    ) {
        let reviewed_target = events
            .iter()
            .rev()
            .find(|event| {
                event.kind == "network.target_reviewed"
                    && event.payload.get("contractId").and_then(Value::as_str) == Some(contract_id)
                    && event.payload.get("operationId").and_then(Value::as_str)
                        == Some(operation.id.as_str())
            })
            .and_then(|event| event.payload.get("target"))
            .cloned()
            .ok_or_else(|| {
                KernelError::PendingPermissionUnavailable(format!(
                    "Kernel-reviewed network target is unavailable for operation {}",
                    operation.id
                ))
            })?;
        if let Some(object) = arguments.as_object_mut() {
            object.insert("kernelReviewedTarget".to_string(), reviewed_target);
        }
    }
    Ok(arguments)
}

fn decode_batch_operation_state(value: &str) -> KernelResult<BatchOperationState> {
    match value {
        "awaitingPermission" => Ok(BatchOperationState::AwaitingPermission),
        "ready" => Ok(BatchOperationState::Ready),
        "started" => Ok(BatchOperationState::Started),
        "completed" => Ok(BatchOperationState::Completed),
        "failed" => Ok(BatchOperationState::Failed),
        "blocked" => Ok(BatchOperationState::Blocked),
        _ => Err(KernelError::Structured {
            code: "run_recovery_schema_invalid",
            stage: "batch.restore",
            message: format!("unknown batch operation state {value}"),
            details: serde_json::json!({ "state": value }),
        }),
    }
}

fn recovery_field_error(run_id: &str, field: &str) -> KernelError {
    KernelError::Structured {
        code: "run_recovery_schema_invalid",
        stage: "batch.restore",
        message: format!("batch checkpoint is missing {field}"),
        details: serde_json::json!({ "runId": run_id, "field": field }),
    }
}

fn restore_artifact_block(
    events: &[LedgerEvent],
    block_id: &str,
    expected_hash: Option<&str>,
) -> KernelResult<String> {
    let slot_id = block_id.strip_prefix("block-").unwrap_or(block_id);
    for completed in events
        .iter()
        .rev()
        .filter(|event| event.kind == "draft.batch_completed")
    {
        let draft_id = completed
            .payload
            .get("draftId")
            .and_then(Value::as_str)
            .ok_or_else(|| recovery_draft_error(block_id, "completed draft is missing draftId"))?;
        let completed_sequence = required_ledger_sequence(completed, "draft.restore")?;
        let mut lines = Vec::new();
        for event in events.iter().filter(|event| event.kind == "draft.chunk") {
            let event_draft_id = event
                .payload
                .get("draftId")
                .and_then(Value::as_str)
                .ok_or_else(|| recovery_draft_error(block_id, "draft chunk is missing draftId"))?;
            if event_draft_id != draft_id
                || required_ledger_sequence(event, "draft.restore")? > completed_sequence
            {
                continue;
            }
            let frame = event
                .payload
                .get("frame")
                .ok_or_else(|| recovery_draft_error(block_id, "draft chunk is missing frame"))?;
            let event_slot_id = frame
                .get("slotId")
                .and_then(Value::as_str)
                .ok_or_else(|| recovery_draft_error(block_id, "draft chunk is missing slotId"))?;
            if event_slot_id != slot_id && event_slot_id != block_id {
                continue;
            }
            let content_lines = frame
                .get("contentLines")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    recovery_draft_error(block_id, "draft chunk is missing contentLines")
                })?;
            for line in content_lines {
                lines.push(line.as_str().ok_or_else(|| {
                    recovery_draft_error(block_id, "draft contentLines must contain strings")
                })?);
            }
        }
        if lines.is_empty() {
            continue;
        }
        let content = lines.join("\n");
        if expected_hash.is_some_and(|hash| deepcode_kernel_tools::fnv1a64_hex(&content) != hash) {
            return Err(KernelError::PendingPermissionUnavailable(format!(
                "DraftLedger content hash does not match execution contract block {block_id}"
            )));
        }
        return Ok(content);
    }
    Err(KernelError::PendingPermissionUnavailable(format!(
        "DraftLedger content is unavailable for execution block {block_id}"
    )))
}

fn required_ledger_sequence(event: &LedgerEvent, stage: &'static str) -> KernelResult<u64> {
    event.sequence.ok_or_else(|| KernelError::Structured {
        code: "run_recovery_schema_invalid",
        stage,
        message: format!("{} ledger event is missing sequence", event.kind),
        details: serde_json::json!({
            "eventId": event.id,
            "eventKind": event.kind,
        }),
    })
}

fn recovery_draft_error(block_id: &str, message: &str) -> KernelError {
    KernelError::Structured {
        code: "run_recovery_schema_invalid",
        stage: "draft.restore",
        message: message.to_string(),
        details: serde_json::json!({ "blockId": block_id }),
    }
}
