use super::*;
use deepcode_kernel_abi::{
    PendingOperationCheckpoint, PermissionRequestedFact, PermissionResolutionFact,
    PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION,
};
use deepcode_kernel_tools::{KernelExecutionContract, KernelExecutionOperation};

impl DeepCodeKernelRuntime {
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
        let Some((requested, _)) = requested else {
            return Ok(());
        };
        let Some(run_id) = requested.run_id.clone() else {
            return Ok(());
        };
        let Some(session_id) = requested.session_id.clone() else {
            return Ok(());
        };
        self.ensure_session_restored(&session_id)?;
        if let Some((restored_id, pending)) = self.pending_tool_from_ledger(&run_id)? {
            if restored_id == permission_id {
                self.state.pending_tools.insert(restored_id, pending);
            }
        }
        Ok(())
    }

    pub(crate) fn pending_tool_from_ledger(
        &self,
        run_id: &str,
    ) -> KernelResult<Option<(String, PendingKernelTool)>> {
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = resolved_permission_ids(&events)?;
        let Some((requested, requested_fact)) = latest_pending_permission_fact(&events, &resolved)?
        else {
            return Ok(None);
        };
        let checkpoint: PendingOperationCheckpoint = requested_fact.checkpoint;
        if checkpoint.schema_version != PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION {
            return Err(KernelError::PendingPermissionUnavailable(format!(
                "unsupported pending operation checkpoint schema {}",
                checkpoint.schema_version
            )));
        }
        let contract = execution_contract_from_ledger(&events, &checkpoint.contract_id)?;
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
                restore_operation_arguments(&events, &checkpoint.contract_id, operation)?;
            crate::action_batch::attach_kernel_context_to_arguments(
                &mut arguments,
                &checkpoint.plan_id,
                &checkpoint_item.work_unit_id,
                &checkpoint_item.operation_id,
                operation.operation_kind.wire_name(),
            );
            group_items.push(PendingKernelToolItem {
                tool_call_id: checkpoint_item.tool_call_id.clone(),
                tool_name: operation.tool_id.clone(),
                arguments,
                request_id: Some(checkpoint.request_id.clone()),
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
        Ok(Some((
            checkpoint.permission_id.clone(),
            PendingKernelTool {
                run_id: run_id.to_string(),
                session_id: requested.session_id.clone().ok_or_else(|| {
                    KernelError::PendingPermissionUnavailable(
                        "pending permission is missing sessionId".to_string(),
                    )
                })?,
                tool_name: first.tool_name.clone(),
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
                request_id: first.request_id.clone(),
                work_unit_id: first.work_unit_id.clone(),
                action_id: first.action_id.clone(),
                plan_id: first.plan_id.clone(),
                operation_kind: first.operation_kind,
                read_set: first.read_set.clone(),
                write_set: first.write_set.clone(),
                group_items,
            },
        )))
    }
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

fn restore_operation_arguments(
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
        let Some(draft_id) = completed.payload.get("draftId").and_then(Value::as_str) else {
            continue;
        };
        let completed_sequence = completed.sequence.unwrap_or(u64::MAX);
        let lines = events
            .iter()
            .filter(|event| {
                event.kind == "draft.chunk"
                    && event.sequence.unwrap_or_default() <= completed_sequence
                    && event.payload.get("draftId").and_then(Value::as_str) == Some(draft_id)
                    && event
                        .payload
                        .get("frame")
                        .and_then(|frame| frame.get("slotId"))
                        .and_then(Value::as_str)
                        .is_some_and(|value| value == slot_id || value == block_id)
            })
            .flat_map(|event| {
                event
                    .payload
                    .get("frame")
                    .and_then(|frame| frame.get("contentLines"))
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
            })
            .collect::<Vec<_>>();
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
