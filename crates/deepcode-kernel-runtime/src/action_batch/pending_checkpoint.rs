use super::summary::safe_work_unit_segment;
use super::*;
use deepcode_kernel_abi::{
    PendingOperationCheckpoint, PendingOperationCheckpointItem,
    PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION,
};
use deepcode_kernel_tools::KernelExecutionContractV3;

pub(super) struct PendingCheckpointRequest<'a> {
    pub(super) run_id: &'a str,
    pub(super) permission_id: &'a str,
    pub(super) permission_bundle_id: Option<&'a str>,
    pub(super) contract_id: Option<&'a str>,
    pub(super) request_id: &'a str,
    pub(super) plan_id: &'a str,
    pub(super) operation_ids: &'a [String],
    pub(super) work_unit_ids: &'a [String],
}

pub(super) fn pending_operation_checkpoint(
    state: &RuntimeState,
    request: PendingCheckpointRequest<'_>,
) -> KernelResult<PendingOperationCheckpoint> {
    let contract_id = request
        .contract_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(
                "permission checkpoint requires an accepted execution contract".to_string(),
            )
        })?;
    let contract_value = state
        .execution_contracts_by_run
        .get(request.run_id)
        .and_then(|contracts| contracts.get(contract_id))
        .cloned()
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "execution contract {contract_id} is unavailable for permission checkpoint"
            ))
        })?;
    let contract: KernelExecutionContractV3 =
        serde_json::from_value(contract_value).map_err(|error| {
            KernelError::InvalidCommand(format!(
                "decode execution contract {contract_id} for permission checkpoint: {error}"
            ))
        })?;
    let items = request
        .operation_ids
        .iter()
        .zip(request.work_unit_ids.iter())
        .map(|(operation_id, work_unit_id)| {
            let operation = contract
                .operations
                .iter()
                .find(|operation| operation.id == *operation_id)
                .ok_or_else(|| {
                    KernelError::InvalidCommand(format!(
                        "execution contract {contract_id} does not contain operation {operation_id}"
                    ))
                })?;
            Ok(PendingOperationCheckpointItem {
                operation_id: operation_id.clone(),
                work_unit_id: work_unit_id.clone(),
                tool_call_id: format!(
                    "{}-{}",
                    work_unit_id,
                    safe_work_unit_segment(&operation.tool_id)
                ),
                tool_id: operation.tool_id.clone(),
                args_hash: operation.args_hash.clone(),
                read_set: operation.read_set.clone(),
                write_set: operation.write_set.clone(),
            })
        })
        .collect::<KernelResult<Vec<_>>>()?;
    Ok(PendingOperationCheckpoint {
        schema_version: PENDING_OPERATION_CHECKPOINT_SCHEMA_VERSION.to_string(),
        permission_id: request.permission_id.to_string(),
        permission_bundle_id: request.permission_bundle_id.map(str::to_string),
        contract_id: contract_id.to_string(),
        contract_hash: contract.contract_hash,
        request_id: request.request_id.to_string(),
        plan_id: request.plan_id.to_string(),
        items,
    })
}
