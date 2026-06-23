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
                workflow_ref,
                run_overrides,
            } => self.run_create(
                request_id,
                session_id,
                input,
                workspace_binding,
                profile_ref,
                workflow_ref,
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
            KernelCommand::UserDecisionSubmit {
                request_id,
                run_id,
                session_id,
                decision,
            } => self.user_decision_submit(request_id, run_id, session_id, decision),
            KernelCommand::ResourceResolve {
                request_id,
                run_id,
                session_id,
                request,
            } => self.resource_resolve(request_id, run_id, session_id, request),
            KernelCommand::ArtifactRegister {
                request_id,
                run_id,
                session_id,
                artifact,
            } => self.artifact_register(request_id, run_id, session_id, artifact),
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
            KernelCommand::ConfigGet { request_id } => {
                self.not_implemented(request_id, "config.get")
            }
            KernelCommand::ConfigPatch { request_id, .. } => {
                self.not_implemented(request_id, "config.patch")
            }
            KernelCommand::RunCancel { request_id, .. } => {
                self.not_implemented(request_id, "run.cancel")
            }
            KernelCommand::RunResume {
                request_id,
                session_id,
            } => self.run_resume(request_id, session_id),
            KernelCommand::WorkspaceOpen { request_id, path } => {
                self.workspace_open(request_id, path)
            }
            KernelCommand::WorkspaceCurrent { request_id } => self.workspace_current(request_id),
            KernelCommand::HostResourceQuery { request_id, query } => {
                self.host_resource_query(request_id, query)
            }
            KernelCommand::SkillDiscover { request_id } => self.skill_discover(request_id),
            KernelCommand::SkillInvoke {
                request_id,
                run_id,
                session_id,
                skill_id,
                input,
            } => self.skill_invoke(request_id, run_id, session_id, skill_id, input),
            KernelCommand::WorkflowObserve {
                request_id,
                run_id,
                session_id,
                event,
            } => self.workflow_observe(request_id, run_id, session_id, *event),
            KernelCommand::PermissionResolve {
                request_id,
                permission_id,
                decision,
            } => self.permission_resolve(request_id, permission_id, decision),
            KernelCommand::SkillTrustApprove {
                request_id,
                skill_id,
                decision,
            } => self.skill_trust_approve(request_id, skill_id, decision),
            KernelCommand::McpRiskAcknowledgmentSubmit {
                request_id,
                connector_id,
                binding_id,
                acknowledgment,
            } => self.mcp_risk_acknowledgment_submit(
                request_id,
                connector_id,
                binding_id,
                acknowledgment,
            ),
            KernelCommand::AuditVerify { request_id, scope } => {
                self.audit_verify(request_id, scope)
            }
            KernelCommand::AuditQuery { request_id, .. } => {
                self.not_implemented(request_id, "audit.query")
            }
            KernelCommand::PermissionGrantTemporary {
                request_id,
                run_id,
                grant,
            } => self.permission_grant_temporary(request_id, run_id, grant),
        }
    }
}
