use super::*;

pub(super) fn validate_operations_against_execution_contract(
    state: &RuntimeState,
    run_id: &str,
    batch: &Value,
    operations: &[PlannedOperation],
) -> KernelResult<()> {
    let contract_id = batch
        .get("contractId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KernelError::InvalidCommand(
                "ActionBatchSubmit requires accepted Kernel execution contractId".to_string(),
            )
        })?;
    let contract = state
        .execution_contracts_by_run
        .get(run_id)
        .and_then(|contracts| contracts.get(contract_id))
        .ok_or_else(|| {
            KernelError::InvalidCommand(format!(
                "action batch references unknown Kernel execution contract {contract_id}"
            ))
        })?;
    let contract_status = contract
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let execution_admitted = contract_status == "authorizedByPlan"
        || (contract_status == "awaitingUserApproval"
            && awaiting_contract_has_active_plan_lease(state, run_id, contract));
    if !execution_admitted {
        return Err(KernelError::PermissionDenied(format!(
            "Kernel execution contract {contract_id} cannot enter execution admission: {contract_status}"
        )));
    }
    let catalog_version = contract
        .get("catalogVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if catalog_version != deepcode_kernel_tools::TOOL_REGISTRY_VERSION {
        return Err(KernelError::InvalidCommand(format!(
            "Kernel execution contract catalog version mismatch: {catalog_version}"
        )));
    }
    let contract_hash = contract
        .get("contractHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let submitted_contract_hash = batch
        .get("contractHash")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if contract_hash.is_empty() || submitted_contract_hash != contract_hash {
        return Err(KernelError::InvalidCommand(
            "ActionBatchSubmit contractHash does not match accepted Kernel contract".to_string(),
        ));
    }
    let contract_operations = contract
        .get("operations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if contract_operations.len() != operations.len() {
        return Err(KernelError::InvalidCommand(format!(
            "ActionBatchSubmit operation count {} does not match contract count {}",
            operations.len(),
            contract_operations.len()
        )));
    }
    let registry = KernelToolRegistry::new();
    let compiler = OperationCompiler::new(registry.clone());
    for operation in operations {
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
        let contract_tool_id = contract_operation
            .get("toolId")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !contract_tool_id.is_empty() {
            let operation_tool_id = operation
                .tool_id(&registry)
                .unwrap_or(operation.capability.as_str());
            if contract_tool_id != operation_tool_id {
                return Err(KernelError::InvalidCommand(format!(
                    "action {} toolId {} does not match Kernel execution contract toolId {}",
                    operation.id, operation_tool_id, contract_tool_id
                )));
            }
        }
        if !contract_capability.is_empty() && contract_capability != operation.capability {
            return Err(KernelError::InvalidCommand(format!(
                "action {} capability {} does not match Kernel execution contract capability {}",
                operation.id, operation.capability, contract_capability
            )));
        }
        if contract_operation.get("args") != Some(&compiler.normalized_args(operation)) {
            return Err(KernelError::InvalidCommand(format!(
                "action {} normalized args do not match Kernel execution contract",
                operation.id
            )));
        }
        for (field, actual) in [
            ("readSet", &operation.read_set),
            ("writeSet", &operation.write_set),
            ("conflictKeys", &operation.conflict_keys),
        ] {
            let expected = contract_operation
                .get(field)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if expected != *actual {
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
    contract: &Value,
) -> bool {
    let Some(authorization_contract_id) = contract
        .get("authorizationContractId")
        .and_then(Value::as_str)
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
            resource.metadata.get("leaseKind").and_then(Value::as_str) == Some("planAuthorization")
                && resource
                    .metadata
                    .get("lease")
                    .and_then(|lease| lease.get("authorizationContractId"))
                    .and_then(Value::as_str)
                    == Some(authorization_contract_id)
        });
    plan_contract_accepted && plan_lease_active
}

pub(super) fn batch_contract_id(batch: &Value) -> Option<String> {
    batch
        .get("contractId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn permission_bundle_id_for_operation(
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
    let capability = capability_for_tool(tool_name).ok()?;
    contract
        .get("permissionBundles")
        .and_then(Value::as_array)?
        .iter()
        .find(|bundle| {
            let matches_operation = bundle
                .get("operationIds")
                .and_then(Value::as_array)
                .map(|items| items.iter().any(|item| item.as_str() == Some(operation_id)))
                .unwrap_or(false);
            let matches_capability = bundle
                .get("capability")
                .and_then(Value::as_str)
                .map(|value| value == capability)
                .unwrap_or(false);
            matches_operation || matches_capability
        })
        .and_then(|bundle| bundle.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
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
        .get("permissionBundles")
        .and_then(Value::as_array)?
        .iter()
        .find(|bundle| bundle.get("id").and_then(Value::as_str) == Some(bundle_id))?
        .get("operationIds")
        .and_then(Value::as_array)?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}
