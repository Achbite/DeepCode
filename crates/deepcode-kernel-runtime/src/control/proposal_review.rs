use super::*;

pub(super) struct ProposalReviewOutcome {
    pub(super) report: ProposalReviewReportV3,
    pub(super) network_targets: Vec<NetworkTargetReview>,
}

pub(super) struct NetworkTargetReview {
    pub(super) operation_id: String,
    pub(super) target: crate::network_policy::ReviewedHttpTarget,
}

pub(super) fn proposal_action_bundle_review_report(
    proposal: &ProposalEnvelope,
    tool_config: &crate::executors::KernelExecutorConfig,
    workspace_execution_context_available: bool,
) -> ProposalReviewOutcome {
    let content_bytes = action_bundle_content_bytes(&proposal.payload);
    if content_bytes > ARTIFACT_DRAFT_MAX_TOTAL_UTF8_BYTES {
        return ProposalReviewOutcome {
            report: denied_proposal_report(
                proposal,
                format!(
                "artifact_draft_budget_exceeded: actionBundle content uses {content_bytes} bytes; maximum is {ARTIFACT_DRAFT_MAX_TOTAL_UTF8_BYTES}"
            ),
            ),
            network_targets: Vec::new(),
        };
    }
    let compiler = OperationCompiler::default();
    let operations = match compiler.compile_batch(&proposal.payload) {
        Ok(operations) => operations,
        Err(error) => {
            return ProposalReviewOutcome {
                report: denied_proposal_report(proposal, error.to_string()),
                network_targets: Vec::new(),
            };
        }
    };
    let mut permission_modes = std::collections::BTreeMap::new();
    let mut network_targets = Vec::new();
    for operation in &operations {
        let PlannedOperationKind::Network(network) = &operation.operation else {
            continue;
        };
        let target_url = network_target_url(tool_config, network);
        let target = match crate::network_policy::review_http_target(&target_url) {
            Ok(target) => target,
            Err(error) => {
                return ProposalReviewOutcome {
                    report: denied_proposal_report(proposal, error.to_string()),
                    network_targets: Vec::new(),
                };
            }
        };
        permission_modes.insert(
            operation.id.clone(),
            if target.private {
                tool_config.private_web_read_permission
            } else {
                tool_config.web_read_permission
            },
        );
        network_targets.push(NetworkTargetReview {
            operation_id: operation.id.clone(),
            target,
        });
    }
    let report = match compiler.review_action_bundle_with_permission_modes(
        &proposal.proposal_id,
        &proposal.payload,
        &permission_modes,
    ) {
        Ok(mut report) => {
            let registry = KernelToolRegistry::default();
            let requires_workspace = report
                .execution_contract
                .operations
                .iter()
                .any(|operation| registry.needs_workspace(&operation.tool_id).unwrap_or(true));
            if requires_workspace && !workspace_execution_context_available {
                report.status = "denied".to_string();
                report.diagnostics.push(
                    "workspace_binding_required: workspace tools require a run-bound workspace or an explicit user attachment"
                        .to_string(),
                );
                report.execution_contract.status = "denied".to_string();
                report.execution_contract.permission_bundles.clear();
                report.execution_contract.interventions.clear();
                report.execution_contract.cleanup_policy = "none".to_string();
                report.execution_contract.expires_after = "immediate".to_string();
            }
            report
        }
        Err(error) => denied_proposal_report(proposal, error.to_string()),
    };
    ProposalReviewOutcome {
        report,
        network_targets,
    }
}

fn network_target_url(
    config: &crate::executors::KernelExecutorConfig,
    operation: &deepcode_kernel_tools::NetworkOperation,
) -> String {
    match operation.kind {
        deepcode_kernel_tools::NetworkOperationKind::Fetch => {
            operation.url.clone().unwrap_or_default()
        }
        deepcode_kernel_tools::NetworkOperationKind::Search => config
            .web_search_endpoint_template
            .replace("{query}", "kernel-review")
            .replace("{limit}", "1"),
    }
}

fn action_bundle_content_bytes(payload: &Value) -> u64 {
    payload
        .get("contentBlocks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|block| block.get("contentLines").and_then(Value::as_array))
        .fold(0u64, |total, lines| {
            let line_bytes = lines
                .iter()
                .filter_map(Value::as_str)
                .fold(0u64, |bytes, line| bytes.saturating_add(line.len() as u64));
            total
                .saturating_add(line_bytes)
                .saturating_add(lines.len().saturating_sub(1) as u64)
        })
}

fn denied_proposal_report(
    proposal: &ProposalEnvelope,
    diagnostic: String,
) -> ProposalReviewReportV3 {
    ProposalReviewReportV3 {
        proposal_id: proposal.proposal_id.clone(),
        status: "denied".to_string(),
        required_permissions: Vec::new(),
        diagnostics: vec![diagnostic],
        execution_contract: deepcode_kernel_tools::KernelExecutionContractV3 {
            id: format!("contract-rejected-{}", proposal.proposal_id),
            proposal_id: proposal.proposal_id.clone(),
            authorization_contract_id: None,
            status: "denied".to_string(),
            catalog_version: deepcode_kernel_tools::TOOL_REGISTRY_VERSION.to_string(),
            catalog_hash: KernelToolRegistry::default().snapshot().catalog_hash,
            operation_set_hash: String::new(),
            contract_hash: String::new(),
            operations: Vec::new(),
            permission_bundles: Vec::new(),
            interventions: Vec::new(),
            cleanup_policy: "none".to_string(),
            expires_after: "immediate".to_string(),
        },
    }
}

pub(crate) fn web_permission_mode_for_tool_args(
    config: &crate::executors::KernelExecutorConfig,
    tool_name: &str,
    arguments: &Value,
) -> Option<ToolPermissionMode> {
    let target = match tool_name {
        "web.fetch" => arguments
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string),
        "web.search" => Some(
            config
                .web_search_endpoint_template
                .replace("{query}", "kernel-review")
                .replace("{limit}", "1"),
        ),
        _ => return None,
    };
    Some(
        target
            .as_deref()
            .and_then(|target| crate::network_policy::review_http_target(target).ok())
            .map(|target| {
                if target.private {
                    config.private_web_read_permission
                } else {
                    config.web_read_permission
                }
            })
            .unwrap_or(ToolPermissionMode::Deny),
    )
}
