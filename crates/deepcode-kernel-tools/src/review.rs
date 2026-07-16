use crate::catalog::fnv1a64_hex;
use crate::{
    CleanupContract, KernelToolRegistry, OperationCompileError, OperationCompiler,
    OperationExecutionMode, PlannedOperation, PlannedOperationKind, ToolFamily, ToolPermissionMode,
    ToolRiskLevel,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionOperationV3 {
    pub id: String,
    pub title: String,
    pub tool_id: String,
    pub args: Value,
    pub args_hash: String,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: OperationExecutionMode,
    pub cleanup: CleanupContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionBundleV3 {
    pub id: String,
    pub capability: String,
    pub permission_mode: ToolPermissionMode,
    pub risk: ToolRiskLevel,
    pub resource_kind: String,
    pub operation_ids: Vec<String>,
    pub tool_ids: Vec<String>,
    pub targets: Vec<String>,
    pub expires_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateInterventionV3 {
    pub id: String,
    pub intervention_kind: String,
    pub status: String,
    pub permission_bundle_id: Option<String>,
    pub affected_operation_ids: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionContractV3 {
    pub id: String,
    pub proposal_id: String,
    #[serde(default)]
    pub authorization_contract_id: Option<String>,
    pub status: String,
    pub catalog_version: String,
    pub catalog_hash: String,
    pub operation_set_hash: String,
    pub contract_hash: String,
    pub operations: Vec<KernelExecutionOperationV3>,
    pub permission_bundles: Vec<PermissionBundleV3>,
    pub interventions: Vec<GateInterventionV3>,
    pub cleanup_policy: String,
    pub expires_after: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalReviewReportV3 {
    pub proposal_id: String,
    pub status: String,
    pub required_permissions: Vec<String>,
    pub diagnostics: Vec<String>,
    pub execution_contract: KernelExecutionContractV3,
}

impl OperationCompiler {
    pub fn review_action_bundle(
        &self,
        proposal_id: &str,
        payload: &Value,
    ) -> Result<ProposalReviewReportV3, OperationCompileError> {
        self.review_action_bundle_with_permission_modes(proposal_id, payload, &BTreeMap::new())
    }

    pub fn review_action_bundle_with_permission_modes(
        &self,
        proposal_id: &str,
        payload: &Value,
        permission_modes: &BTreeMap<String, ToolPermissionMode>,
    ) -> Result<ProposalReviewReportV3, OperationCompileError> {
        let operations = self.compile_batch(payload)?;
        let snapshot = self.registry().snapshot();
        let execution_operations = operations
            .iter()
            .map(|operation| execution_operation_v3(self.registry(), operation))
            .collect::<Result<Vec<_>, _>>()?;
        let permission_bundles =
            permission_bundles_v3(self.registry(), &operations, permission_modes)?;
        let interventions = permission_bundles
            .iter()
            .filter(|bundle| bundle.permission_mode != ToolPermissionMode::Allow)
            .map(|bundle| GateInterventionV3 {
                id: format!("gate-{}", bundle.id),
                intervention_kind: if bundle.permission_mode == ToolPermissionMode::Deny {
                    "policy".to_string()
                } else {
                    "permission".to_string()
                },
                status: "pending".to_string(),
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
            "autoAccepted"
        } else {
            "awaitingUserApproval"
        };
        let required_permissions = permission_bundles
            .iter()
            .filter(|bundle| bundle.permission_mode != ToolPermissionMode::Allow)
            .map(|bundle| bundle.capability.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        Ok(ProposalReviewReportV3 {
            proposal_id: proposal_id.to_string(),
            status: status.to_string(),
            required_permissions,
            diagnostics: Vec::new(),
            execution_contract: KernelExecutionContractV3 {
                id: contract_id,
                proposal_id: proposal_id.to_string(),
                authorization_contract_id: None,
                status: status.to_string(),
                catalog_version: snapshot.catalog_version.to_string(),
                catalog_hash: snapshot.catalog_hash,
                operation_set_hash,
                contract_hash,
                operations: execution_operations,
                permission_bundles,
                interventions,
                cleanup_policy: "cleanupContractPerOperation".to_string(),
                expires_after: "reviewGateOrRunTerminal".to_string(),
            },
        })
    }
}

fn execution_operation_v3(
    registry: &KernelToolRegistry,
    operation: &PlannedOperation,
) -> Result<KernelExecutionOperationV3, OperationCompileError> {
    let tool_id = operation
        .tool_id(registry)
        .ok_or_else(|| OperationCompileError::UnsupportedToolId {
            tool_id: operation.capability.clone(),
        })?
        .to_string();
    let args = normalized_args_for_operation(operation);
    let args_hash = fnv1a64_hex(&serde_json::to_string(&args).unwrap_or_default());
    let mut cleanup = registry
        .template(&tool_id)
        .ok_or_else(|| OperationCompileError::UnsupportedToolId {
            tool_id: tool_id.clone(),
        })?
        .cleanup;
    if matches!(
        &operation.operation,
        PlannedOperationKind::Workspace(workspace) if workspace.temporary
    ) {
        cleanup = CleanupContract {
            lease_policy: "batchTemporaryFile".to_string(),
            terminate_process_tree: false,
            remove_scratch: true,
            revoke_broker_grant: false,
            deadline_ms: 5_000,
            failure_policy: "blockReviewAcceptance".to_string(),
        };
    }
    Ok(KernelExecutionOperationV3 {
        id: operation.id.clone(),
        title: operation.title.clone(),
        tool_id,
        args,
        args_hash,
        read_set: operation.read_set.clone(),
        write_set: operation.write_set.clone(),
        conflict_keys: operation.conflict_keys.clone(),
        execution_mode: operation.execution_mode,
        cleanup,
    })
}

fn permission_bundles_v3(
    registry: &KernelToolRegistry,
    operations: &[PlannedOperation],
    permission_modes: &BTreeMap<String, ToolPermissionMode>,
) -> Result<Vec<PermissionBundleV3>, OperationCompileError> {
    let mut grouped = BTreeMap::<String, PermissionBundleV3>::new();
    for operation in operations {
        let tool_id = operation.tool_id(registry).ok_or_else(|| {
            OperationCompileError::UnsupportedToolId {
                tool_id: operation.capability.clone(),
            }
        })?;
        let template =
            registry
                .template(tool_id)
                .ok_or_else(|| OperationCompileError::UnsupportedToolId {
                    tool_id: tool_id.to_string(),
                })?;
        let permission_mode = permission_modes
            .get(&operation.id)
            .copied()
            .unwrap_or(template.permission.mode);
        let key = if template.permission.bundle_key == "none" {
            format!("allow-{tool_id}")
        } else {
            template.permission.bundle_key.to_string()
        };
        let bundle = grouped
            .entry(key.clone())
            .or_insert_with(|| PermissionBundleV3 {
                id: format!("permission-{key}"),
                capability: template.permission.capability.to_string(),
                permission_mode,
                risk: template.permission.risk,
                resource_kind: permission_resource_kind(template.family).to_string(),
                operation_ids: Vec::new(),
                tool_ids: Vec::new(),
                targets: Vec::new(),
                expires_after: template.permission.grant_lifetime.to_string(),
            });
        bundle.permission_mode = stricter_permission_mode(bundle.permission_mode, permission_mode);
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

fn stricter_permission_mode(
    left: ToolPermissionMode,
    right: ToolPermissionMode,
) -> ToolPermissionMode {
    use ToolPermissionMode::{Allow, Ask, Deny};
    match (left, right) {
        (Deny, _) | (_, Deny) => Deny,
        (Ask, _) | (_, Ask) => Ask,
        (Allow, Allow) => Allow,
    }
}

fn permission_resource_kind(family: ToolFamily) -> &'static str {
    match family {
        ToolFamily::Workspace | ToolFamily::Document => "workspacePath",
        ToolFamily::Git => "gitWorkspace",
        ToolFamily::Process => "process",
        ToolFamily::Network => "networkTarget",
        ToolFamily::Browser => "browserState",
        ToolFamily::Provider => "providerProfile",
    }
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
