use super::*;
use deepcode_kernel_abi::{
    PendingOperationCheckpoint, PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION,
};
use deepcode_kernel_tools::{KernelExecutionContractV3, KernelExecutionOperationV3};

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
                permission_id,
                pending,
            )?));
        }
        let events = self.ledger.list_by_run(run_id)?;
        let resolved = events
            .iter()
            .filter(|event| event.kind == "permission.resolved")
            .filter_map(|event| event.payload.get("permissionId").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();
        let Some(event) = events.iter().rev().find(|event| {
            event.kind == "permission.requested"
                && event
                    .payload
                    .get("permissionId")
                    .and_then(Value::as_str)
                    .map(|id| !resolved.contains(id))
                    .unwrap_or(false)
        }) else {
            return Ok(None);
        };
        let required = |field: &str| {
            event
                .payload
                .get(field)
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    KernelError::PendingPermissionUnavailable(format!(
                        "pending permission ledger event is missing {field}"
                    ))
                })
        };
        let permission_id = required("permissionId")?;
        let tool_name = required("toolName")?;
        let capability = required("capability")?;
        let risk_level = required("riskLevel")?;
        capability_for_tool(tool_name)?;
        risk_for_tool(tool_name)?;
        Ok(Some(deepcode_kernel_abi::PermissionRequestEnvelope {
            id: permission_id.to_string(),
            permission_bundle_id: event
                .payload
                .get("permissionBundleId")
                .and_then(Value::as_str)
                .map(str::to_string),
            contract_id: event
                .payload
                .get("contractId")
                .and_then(Value::as_str)
                .map(str::to_string),
            affected_operation_ids: event
                .payload
                .get("affectedOperationIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            work_unit_ids: event
                .payload
                .get("workUnitIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect(),
            tool_id: Some(tool_name.to_string()),
            capability: capability.to_string(),
            risk_level: risk_level.to_string(),
            summary: event
                .payload
                .get("summary")
                .and_then(Value::as_str)
                .unwrap_or("Permission requested by Kernel.")
                .to_string(),
            args_preview: event
                .payload
                .get("argsPreview")
                .cloned()
                .unwrap_or(Value::Null),
        }))
    }

    pub(crate) fn ensure_permission_restored(&mut self, permission_id: &str) -> KernelResult<()> {
        if self.state.pending_tools.contains_key(permission_id) {
            return Ok(());
        }
        let events = self.ledger.list_all()?;
        let already_resolved = events.iter().any(|event| {
            event.kind == "permission.resolved"
                && event.payload.get("permissionId").and_then(Value::as_str) == Some(permission_id)
        });
        if already_resolved {
            return Ok(());
        }
        let Some(requested) = events.iter().rev().find(|event| {
            event.kind == "permission.requested"
                && event.payload.get("permissionId").and_then(Value::as_str) == Some(permission_id)
        }) else {
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
        let resolved = events
            .iter()
            .filter(|event| event.kind == "permission.resolved")
            .filter_map(|event| event.payload.get("permissionId").and_then(Value::as_str))
            .collect::<std::collections::BTreeSet<_>>();
        let Some(requested) = events.iter().rev().find(|event| {
            event.kind == "permission.requested"
                && event
                    .payload
                    .get("permissionId")
                    .and_then(Value::as_str)
                    .map(|id| !resolved.contains(id))
                    .unwrap_or(false)
        }) else {
            return Ok(None);
        };
        let checkpoint: PendingOperationCheckpoint =
            serde_json::from_value(requested.payload.get("checkpoint").cloned().ok_or_else(
                || {
                    KernelError::PendingPermissionUnavailable(
                        "pending permission has no typed operation checkpoint".to_string(),
                    )
                },
            )?)
            .map_err(|error| {
                KernelError::PendingPermissionUnavailable(format!(
                    "decode pending operation checkpoint: {error}"
                ))
            })?;
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
                operation_kind_for_tool(&operation.tool_id),
            );
            group_items.push(PendingKernelToolItem {
                tool_call_id: checkpoint_item.tool_call_id.clone(),
                tool_name: operation.tool_id.clone(),
                arguments,
                request_id: Some(checkpoint.request_id.clone()),
                work_unit_id: Some(checkpoint_item.work_unit_id.clone()),
                action_id: Some(checkpoint_item.operation_id.clone()),
                plan_id: Some(checkpoint.plan_id.clone()),
                operation_kind: Some(operation_kind_for_tool(&operation.tool_id).to_string()),
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
                operation_kind: first.operation_kind.clone(),
                read_set: first.read_set.clone(),
                write_set: first.write_set.clone(),
                group_items,
            },
        )))
    }
}

fn execution_contract_from_ledger(
    events: &[LedgerEvent],
    contract_id: &str,
) -> KernelResult<KernelExecutionContractV3> {
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
    operation: &KernelExecutionOperationV3,
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
    if operation.tool_id == "web.search" || operation.tool_id == "web.fetch" {
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

fn operation_kind_for_tool(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.read" => "read",
        "fs.list" => "list",
        "fs.glob" => "glob",
        "code.grep" => "search",
        "fs.diff" => "diff",
        "fs.create" => "create",
        "fs.write" => "write",
        "fs.edit" => "edit",
        "fs.rename" => "rename",
        "fs.delete" => "delete",
        "fs.ensure_directory" => "ensureDirectory",
        "document.read" => "documentRead",
        tool if tool.starts_with("git.") => "git",
        tool if tool.starts_with("web.") => "network",
        "process.exec" => "exec",
        tool if tool.starts_with("browser.") => "browser",
        "provider.call" => "provider",
        _ => "tool",
    }
}
