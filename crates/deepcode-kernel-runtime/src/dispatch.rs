use super::*;

impl DeepCodeKernelRuntime {
    pub fn dispatch(&mut self, command: KernelCommand) -> KernelResult<Vec<KernelEvent>> {
        match command {
            KernelCommand::HealthCheck { request_id } => Ok(vec![KernelEvent::HostStatus {
                request_id: Some(request_id),
                status: HostStatus::Ready,
                detail: Some("headless kernel runtime ready".to_string()),
                message_key: Some("kernel.host.ready".to_string()),
                args: None,
            }]),
            KernelCommand::RunCreate {
                request_id,
                session_id,
                input,
                workspace_binding,
                profile_ref,
                run_overrides,
            } => self.run_create(
                request_id,
                session_id,
                input,
                workspace_binding,
                profile_ref,
                run_overrides,
            ),
            KernelCommand::StateContractGet {
                request_id,
                run_id,
                session_id,
            } => self.state_contract_get(request_id, run_id, session_id),
            KernelCommand::ProposalSubmit {
                request_id,
                run_id,
                session_id,
                proposal,
            } => self.proposal_submit(request_id, run_id, session_id, proposal),
            KernelCommand::PlanAuthorizationSubmit {
                request_id,
                run_id,
                session_id,
                intent,
            } => self.plan_authorization_submit(request_id, run_id, session_id, intent),
            KernelCommand::PlanAuthorizationDecisionSubmit {
                request_id,
                run_id,
                session_id,
                decision,
            } => self.plan_authorization_decision_submit(request_id, run_id, session_id, decision),
            KernelCommand::ResourceResolve {
                request_id,
                run_id,
                session_id,
                request,
            } => self.resource_resolve(request_id, run_id, session_id, request),
            KernelCommand::DraftLedgerSubmit {
                request_id,
                run_id,
                session_id,
                frame,
            } => self.draft_ledger_submit(request_id, run_id, session_id, frame),
            KernelCommand::ActionBatchSubmit {
                request_id,
                run_id,
                session_id,
                batch,
            } => self.action_batch_submit(request_id, run_id, session_id, batch),
            KernelCommand::ReviewFactsGet {
                request_id,
                run_id,
                session_id,
            } => self.review_facts_get(request_id, run_id, session_id),
            KernelCommand::ReviewGateEvaluate {
                request_id,
                run_id,
                session_id,
                decision,
            } => self.review_gate_evaluate(request_id, run_id, session_id, decision),
            KernelCommand::SnapshotGet {
                request_id,
                session_id,
            } => self.snapshot_get(request_id, session_id),
            KernelCommand::RunCancel { request_id, run_id } => self.run_cancel(request_id, run_id),
            KernelCommand::RunResume {
                request_id,
                session_id,
            } => self.run_resume(request_id, session_id),
            KernelCommand::HostWorkspaceBindingResolve { request_id, path } => {
                self.host_workspace_binding_resolve(request_id, path)
            }
            KernelCommand::HostWorkspaceOpen { request_id, path } => {
                self.host_workspace_open(request_id, path)
            }
            KernelCommand::HostWorkspaceCurrent { request_id } => {
                self.host_workspace_current(request_id)
            }
            KernelCommand::HostWorkspaceSave {
                request_id,
                file_name,
            } => self.host_workspace_save(request_id, file_name),
            KernelCommand::HostResourceQuery { request_id, query } => {
                self.host_resource_query(request_id, query)
            }
            KernelCommand::HostSkillDiscover { request_id } => self.host_skill_discover(request_id),
            KernelCommand::PermissionResolve {
                request_id,
                permission_id,
                decision,
            } => self.permission_resolve(request_id, permission_id, decision),
            KernelCommand::HostSkillTrustDecisionSubmit {
                request_id,
                skill_id,
                decision,
            } => self.host_skill_trust_decision_submit(request_id, skill_id, decision),
            KernelCommand::HostMcpRiskDecisionSubmit {
                request_id,
                connector_id,
                binding_id,
                decision,
            } => self.host_mcp_risk_decision_submit(request_id, connector_id, binding_id, decision),
            KernelCommand::AuditVerify { request_id, scope } => {
                self.audit_verify(request_id, scope)
            }
            KernelCommand::AuditQuery { request_id, filter } => {
                self.audit_query(request_id, filter)
            }
        }
    }
}
