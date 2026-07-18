use crate::catalog::fnv1a64_hex;
use crate::{
    KernelToolRegistry, OperationCompileError, OperationCompiler, PermissionBundleKey,
    PlannedOperation, PlannedOperationKind, ToolPermissionMode,
};
use deepcode_kernel_abi::{
    CleanupContract, CleanupFailurePolicy, CleanupLeasePolicy, ContractCleanupPolicy,
    ContractExpiry, KernelActionProposal, KernelExecutionContract, KernelExecutionContractStatus,
    KernelExecutionOperation, KernelGateIntervention, KernelGateInterventionKind,
    KernelGateInterventionStatus, KernelPermissionBundle, KernelProposalReviewReport,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

impl OperationCompiler<'_> {
    pub fn review_action_bundle(
        &self,
        proposal_id: &str,
        proposal: &KernelActionProposal,
    ) -> Result<KernelProposalReviewReport, OperationCompileError> {
        self.review_action_bundle_with_permission_modes(proposal_id, proposal, &BTreeMap::new())
    }

    pub fn review_action_bundle_with_permission_modes(
        &self,
        proposal_id: &str,
        proposal: &KernelActionProposal,
        permission_modes: &BTreeMap<String, ToolPermissionMode>,
    ) -> Result<KernelProposalReviewReport, OperationCompileError> {
        let operations = self.compile_proposal(proposal)?;
        let snapshot = self.registry().snapshot();
        let execution_operations = operations
            .iter()
            .map(|operation| execution_operation(self.registry(), operation))
            .collect::<Result<Vec<_>, _>>()?;
        let permission_bundles =
            permission_bundles(self.registry(), &operations, permission_modes)?;
        let interventions = permission_bundles
            .iter()
            .filter(|bundle| bundle.permission_mode != ToolPermissionMode::Allow)
            .map(|bundle| KernelGateIntervention {
                id: format!("gate-{}", bundle.id),
                intervention_kind: if bundle.permission_mode == ToolPermissionMode::Deny {
                    KernelGateInterventionKind::Policy
                } else {
                    KernelGateInterventionKind::Permission
                },
                status: KernelGateInterventionStatus::Pending,
                permission_bundle_id: Some(bundle.id.clone()),
                affected_operation_ids: bundle.operation_ids.clone(),
                summary: format!(
                    "Kernel gate requires {:?} for {} operation(s).",
                    bundle.permission_mode,
                    bundle.operation_ids.len()
                ),
            })
            .collect::<Vec<_>>();
        let operation_set_hash =
            fnv1a64_hex(&serde_json::to_string(&execution_operations).unwrap_or_default());
        let contract_id = format!("contract-{}", fnv1a64_hex(proposal_id));
        let contract_hash_payload = serde_json::json!({
            "id": contract_id,
            "proposalId": proposal_id,
            "catalogVersion": snapshot.catalog_version,
            "catalogHash": snapshot.catalog_hash,
            "operationSetHash": operation_set_hash,
            "permissionBundles": permission_bundles,
        });
        let contract_hash =
            fnv1a64_hex(&serde_json::to_string(&contract_hash_payload).unwrap_or_default());
        let status = if interventions.is_empty() {
            KernelExecutionContractStatus::AutoAccepted
        } else {
            KernelExecutionContractStatus::AwaitingUserApproval
        };
        let required_permissions = permission_bundles
            .iter()
            .filter(|bundle| bundle.permission_mode != ToolPermissionMode::Allow)
            .map(|bundle| bundle.capability.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        Ok(KernelProposalReviewReport {
            proposal_id: proposal_id.to_string(),
            status,
            required_permissions,
            diagnostics: Vec::new(),
            execution_contract: KernelExecutionContract {
                id: contract_id,
                proposal_id: proposal_id.to_string(),
                authorization_contract_id: None,
                status,
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                operation_set_hash,
                contract_hash,
                operations: execution_operations,
                permission_bundles,
                interventions,
                cleanup_policy: ContractCleanupPolicy::PerOperationCleanupContract,
                expires_after: ContractExpiry::ReviewGateOrRunTerminal,
            },
        })
    }
}

fn execution_operation(
    registry: &KernelToolRegistry,
    operation: &PlannedOperation,
) -> Result<KernelExecutionOperation, OperationCompileError> {
    let tool_id = operation.tool_id.clone();
    let args = normalized_args_for_operation(operation);
    let args_hash = fnv1a64_hex(&serde_json::to_string(&args).unwrap_or_default());
    let mut cleanup = registry
        .contract(&tool_id)
        .ok_or_else(|| OperationCompileError::UnsupportedToolId {
            tool_id: tool_id.clone(),
        })?
        .cleanup;
    if matches!(
        &operation.operation,
        PlannedOperationKind::Workspace(workspace) if workspace.temporary
    ) {
        cleanup = CleanupContract {
            lease_policy: CleanupLeasePolicy::BatchTemporaryFile,
            terminate_process_tree: false,
            remove_scratch: true,
            revoke_broker_grant: false,
            deadline_ms: 5_000,
            failure_policy: CleanupFailurePolicy::BlockReviewAcceptance,
        };
    }
    Ok(KernelExecutionOperation {
        id: operation.id.clone(),
        title: operation.title.clone(),
        depends_on: operation.depends_on.clone(),
        tool_id,
        operation_kind: operation.operation_kind,
        args,
        args_hash,
        read_set: operation.read_set.clone(),
        write_set: operation.write_set.clone(),
        conflict_keys: operation.conflict_keys.clone(),
        execution_mode: operation.execution_mode,
        cleanup,
    })
}

fn permission_bundles(
    registry: &KernelToolRegistry,
    operations: &[PlannedOperation],
    permission_modes: &BTreeMap<String, ToolPermissionMode>,
) -> Result<Vec<KernelPermissionBundle>, OperationCompileError> {
    let mut grouped = BTreeMap::<String, KernelPermissionBundle>::new();
    for operation in operations {
        let tool_id = operation.tool_id.as_str();
        let template =
            registry
                .contract(tool_id)
                .ok_or_else(|| OperationCompileError::UnsupportedToolId {
                    tool_id: tool_id.to_string(),
                })?;
        let permission_mode = permission_modes
            .get(&operation.id)
            .copied()
            .unwrap_or(template.permission.mode);
        let key = match template.permission.bundle_key {
            PermissionBundleKey::None => format!("allow-{tool_id}"),
            key => key.wire_name().to_string(),
        };
        let bundle = grouped
            .entry(key.clone())
            .or_insert_with(|| KernelPermissionBundle {
                id: format!("permission-{key}"),
                capability: template.permission.capability.to_string(),
                permission_mode,
                risk: template.permission.risk,
                resource_kind: template.family.permission_resource_kind(),
                operation_ids: Vec::new(),
                tool_ids: Vec::new(),
                targets: Vec::new(),
                expires_after: template.permission.grant_lifetime,
            });
        bundle.permission_mode = bundle.permission_mode.stricter(permission_mode);
        bundle.operation_ids.push(operation.id.clone());
        if !bundle.tool_ids.iter().any(|value| value == tool_id) {
            bundle.tool_ids.push(tool_id.to_string());
        }
        for target in operation.read_set.iter().chain(operation.write_set.iter()) {
            if !bundle.targets.contains(target) {
                bundle.targets.push(target.clone());
            }
        }
    }
    Ok(grouped.into_values().collect())
}

pub(crate) fn normalized_args_for_operation(operation: &PlannedOperation) -> Value {
    match &operation.operation {
        PlannedOperationKind::Workspace(workspace) => serde_json::json!({
            "path": workspace.target_path,
            "targetKind": workspace.target_kind,
            "recursive": workspace.recursive,
            "contentBlockId": workspace.content_block_id,
            "replacementBlockId": workspace.replacement_block_id,
            "contentHash": workspace.content.as_deref().map(fnv1a64_hex),
            "temporary": workspace.temporary,
            "executable": workspace.executable,
            "patchSpec": workspace.patch_spec,
            "query": workspace.query,
            "pattern": workspace.pattern,
            "depth": workspace.depth,
            "includeHidden": workspace.include_hidden,
            "include": workspace.include,
            "exclude": workspace.exclude,
            "strategy": workspace.strategy,
            "contextLines": workspace.context_lines,
            "maxResults": workspace.max_results,
            "destinationPath": workspace.rename_to,
            "startLine": workspace.start_line,
            "endLine": workspace.end_line,
            "startPage": workspace.start_page,
            "endPage": workspace.end_page,
        }),
        PlannedOperationKind::Git(git) => serde_json::json!({
            "paths": git.paths,
            "message": git.message,
            "staged": git.staged,
            "remote": git.remote,
            "branch": git.branch,
        }),
        PlannedOperationKind::Process(process) => {
            serde_json::to_value(process).unwrap_or(Value::Null)
        }
        PlannedOperationKind::Network(network) => {
            serde_json::to_value(network).unwrap_or(Value::Null)
        }
        PlannedOperationKind::Browser(browser) => {
            serde_json::to_value(browser).unwrap_or(Value::Null)
        }
        PlannedOperationKind::Provider(provider) => {
            serde_json::to_value(provider).unwrap_or(Value::Null)
        }
    }
}
