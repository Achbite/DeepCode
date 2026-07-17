use super::*;

pub(super) fn empty_workspace_binding() -> WorkspaceBinding {
    WorkspaceBinding {
        workspace_id: None,
        workspace_hash: None,
        open_path: None,
        active_folder_id: None,
        folder_hash: None,
    }
}

impl DeepCodeKernelRuntime {
    pub(super) fn state_contract_for_record(
        &self,
        record: &RuntimeRunRecord,
    ) -> KernelStateContract {
        let tool_catalog_snapshot = kernel_tool_catalog_snapshot_ref();
        let capability_projection = tool_catalog_snapshot
            .tools
            .iter()
            .map(|tool| tool.tool_id.to_string())
            .collect();
        KernelStateContract {
            kernel_abi_version: KERNEL_ABI_VERSION.to_string(),
            run_id: RunId(record.run_id.clone()),
            state_id: record.lifecycle_state.as_str().to_string(),
            state_kind: "driverRequest".to_string(),
            allowed_inputs: vec!["proposalSubmit".to_string(), "resourceResolve".to_string()],
            allowed_proposals: vec![
                "answer".to_string(),
                "resourceRequest".to_string(),
                "decisionRequest".to_string(),
                "actionBundle".to_string(),
                "diagnostic".to_string(),
            ],
            proposal_schema_refs: vec!["deepcode.agent.protocol.v4".to_string()],
            required_user_decision: None,
            capability_projection,
            tool_catalog_ref: Some(TOOL_CATALOG_VERSION.to_string()),
            tool_catalog_hash: Some(tool_catalog_snapshot.catalog_hash.clone()),
            tool_catalog_snapshot: Some(tool_catalog_snapshot),
            draft_admission_policy: DraftAdmissionPolicy {
                max_total_utf8_bytes: ARTIFACT_DRAFT_MAX_TOTAL_UTF8_BYTES,
            },
            transition_predicates: vec![
                "proposal must match allowed proposals".to_string(),
                "side effects require Kernel permission gates".to_string(),
            ],
            fail_closed_rules: vec![
                "unknown proposal schema is rejected".to_string(),
                "Session cannot advance Kernel state directly".to_string(),
            ],
        }
    }

    pub(super) fn driver_request_for_contract(
        &self,
        contract: &KernelStateContract,
        session_id: Option<SessionId>,
        kind: DriverRequestKind,
        reason: &str,
    ) -> DriverRequest {
        DriverRequest {
            id: format!(
                "driver-{}-{}",
                contract.run_id.0,
                driver_request_kind_name(&kind)
            ),
            run_id: contract.run_id.clone(),
            session_id,
            kind,
            reason: reason.to_string(),
            state_contract: contract.clone(),
        }
    }
}
