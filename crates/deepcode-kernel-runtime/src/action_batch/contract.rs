use super::*;
use deepcode_kernel_abi::{KernelActionBatch, PermissionRequestKind};

pub(super) fn validate_operations_against_execution_contract(
    registry: &KernelToolRegistry,
    state: &RuntimeState,
    run_id: &str,
    batch: &KernelActionBatch,
    operations: &[PlannedOperation],
) -> KernelResult<()> {
    let contract_id = batch.contract_id.trim();
    if contract_id.is_empty() {
        return Err(KernelError::InvalidCommand(
            "ActionBatchSubmit requires accepted Kernel execution contractId".to_string(),
        ));
    }
    let contract = state
        .execution_contracts_by_run
        .get(run_id)
        .and_then(|contracts| contracts.get(contract_id))
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "action batch references unknown Kernel execution contract {contract_id}"
            ))
        })?;
    let execution_admitted = contract.status == KernelExecutionContractStatus::AuthorizedByPlan
        || (contract.status == KernelExecutionContractStatus::AwaitingUserApproval
            && awaiting_contract_has_active_plan_lease(state, run_id, contract));
    if !execution_admitted {
        return Err(KernelError::PermissionDenied(format!(
            "Kernel execution contract {contract_id} cannot enter execution admission: {}",
            contract.status.as_str()
        )));
    }
    if contract.catalog_version != deepcode_kernel_tools::TOOL_REGISTRY_VERSION {
        return Err(KernelError::InvalidCommand(format!(
            "Kernel execution contract catalog version mismatch: {}",
            contract.catalog_version
        )));
    }
    let contract_hash = contract.contract_hash.as_str();
    let submitted_contract_hash = batch.contract_hash.trim();
    if contract_hash.is_empty() || submitted_contract_hash != contract_hash {
        return Err(KernelError::InvalidCommand(
            "ActionBatchSubmit contractHash does not match accepted Kernel contract".to_string(),
        ));
    }
    let contract_operations = &contract.operations;
    if contract_operations.len() != operations.len() {
        return Err(KernelError::InvalidCommand(format!(
            "ActionBatchSubmit operation count {} does not match contract count {}",
            operations.len(),
            contract_operations.len()
        )));
    }
    let compiler = OperationCompiler::new(registry);
    for operation in operations {
        let Some(contract_operation) = contract_operations
            .iter()
            .find(|item| item.id == operation.id)
        else {
            return Err(KernelError::InvalidCommand(format!(
                "action {} is not listed in Kernel execution contract {contract_id}",
                operation.id
            )));
        };
        if contract_operation.tool_id != operation.tool_id {
            return Err(KernelError::InvalidCommand(format!(
                "action {} toolId {} does not match Kernel execution contract toolId {}",
                operation.id, operation.tool_id, contract_operation.tool_id
            )));
        }
        if contract_operation.operation_kind != operation.operation_kind {
            return Err(KernelError::InvalidCommand(format!(
                "action {} operation kind does not match Kernel execution contract",
                operation.id
            )));
        }
        if contract_operation.args != compiler.normalized_args(operation) {
            return Err(KernelError::InvalidCommand(format!(
                "action {} normalized args do not match Kernel execution contract",
                operation.id
            )));
        }
        for (field, expected, actual) in [
            ("readSet", &contract_operation.read_set, &operation.read_set),
            (
                "writeSet",
                &contract_operation.write_set,
                &operation.write_set,
            ),
            (
                "conflictKeys",
                &contract_operation.conflict_keys,
                &operation.conflict_keys,
            ),
        ] {
            if expected != actual {
                return Err(KernelError::InvalidCommand(format!(
                    "action {} {field} does not match Kernel execution contract",
                    operation.id
                )));
            }
        }
    }
    Ok(())
}

fn awaiting_contract_has_active_plan_lease(
    state: &RuntimeState,
    run_id: &str,
    contract: &KernelExecutionContract,
) -> bool {
    let Some(authorization_contract_id) = contract
        .authorization_contract_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };
    let plan_contract_accepted = state
        .plan_authorization_contracts_by_run
        .get(run_id)
        .and_then(|contracts| contracts.get(authorization_contract_id))
        .is_some_and(|contract| contract.status == PlanAuthorizationStatus::Accepted);
    let owner = KernelResourceOwner::agent_run(None::<String>, run_id.to_string());
    let plan_lease_active = state
        .resource_manager
        .active_by_owner(&owner)
        .into_iter()
        .filter(|resource| resource.kind == KernelResourceKind::PermissionGrant)
        .any(|resource| {
            matches!(
                resource.metadata,
                KernelResourceMetadata::PlanAuthorizationGrant { lease }
                    if lease.authorization_contract_id == authorization_contract_id
            )
        });
    plan_contract_accepted && plan_lease_active
}

pub(super) fn permission_bundle_id_for_operation(
    registry: &KernelToolRegistry,
    state: &RuntimeState,
    run_id: &str,
    contract_id: &str,
    operation_id: &str,
    tool_name: &str,
) -> Option<String> {
    let contract = state
        .execution_contracts_by_run
        .get(run_id)
        .and_then(|contracts| contracts.get(contract_id))?;
    let capability = registry.capability_for_tool(tool_name)?;
    contract
        .permission_bundles
        .iter()
        .find(|bundle| {
            let matches_operation = bundle.operation_ids.iter().any(|item| item == operation_id);
            let matches_capability = bundle.capability == capability;
            matches_operation || matches_capability
        })
        .map(|bundle| bundle.id.clone())
}

pub(super) fn permission_bundle_operation_ids(
    state: &RuntimeState,
    run_id: &str,
    contract_id: Option<&str>,
    bundle_id: &str,
) -> Option<Vec<String>> {
    let contract_id = contract_id?;
    let contract = state
        .execution_contracts_by_run
        .get(run_id)
        .and_then(|contracts| contracts.get(contract_id))?;
    let ids = contract
        .permission_bundles
        .iter()
        .find(|bundle| bundle.id == bundle_id)?
        .operation_ids
        .clone();
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

pub(super) fn permission_request_kind(
    state: &RuntimeState,
    run_id: &str,
    contract_id: Option<&str>,
) -> PermissionRequestKind {
    let has_accepted_plan_authorization = contract_id
        .and_then(|contract_id| {
            state
                .execution_contracts_by_run
                .get(run_id)
                .and_then(|contracts| contracts.get(contract_id))
        })
        .and_then(|contract| contract.authorization_contract_id.as_deref())
        .is_some_and(|authorization_contract_id| {
            state
                .plan_authorization_contracts_by_run
                .get(run_id)
                .and_then(|contracts| contracts.get(authorization_contract_id))
                .is_some_and(|contract| contract.status == PlanAuthorizationStatus::Accepted)
        });
    if has_accepted_plan_authorization {
        PermissionRequestKind::ScopeExpansion
    } else {
        PermissionRequestKind::RuntimePermission
    }
}
