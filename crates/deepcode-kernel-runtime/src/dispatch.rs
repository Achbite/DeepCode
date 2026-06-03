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
            KernelCommand::RunStart {
                request_id,
                session_id,
                input,
                workspace_binding,
                profile_ref,
                workflow_ref,
                run_overrides,
            } => self.run_start(
                request_id,
                session_id,
                input.text,
                workspace_binding,
                profile_ref,
                workflow_ref.map(|value| value.id),
                run_overrides,
            ),
            KernelCommand::LlmResponseSubmit {
                request_id,
                run_id,
                session_id,
                llm_call_id,
                response_envelope,
            } => self.llm_response_submit(
                request_id,
                run_id,
                session_id,
                llm_call_id,
                response_envelope,
            ),
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
            KernelCommand::WorkspaceList {
                request_id,
                folder_id,
                path,
                depth,
            } => self.workspace_list(request_id, folder_id, path, depth),
            KernelCommand::WorkspaceRead {
                request_id,
                folder_id,
                path,
            } => self.workspace_read(request_id, folder_id, path),
            KernelCommand::WorkspaceWrite {
                request_id,
                folder_id,
                path,
                content,
                create,
            } => self.workspace_write(request_id, folder_id, path, content, create),
            KernelCommand::WorkspaceCreate {
                request_id,
                folder_id,
                path,
                content,
            } => self.workspace_create(request_id, folder_id, path, content),
            KernelCommand::WorkspaceCreateFolder {
                request_id,
                folder_id,
                path,
            } => self.workspace_create_folder(request_id, folder_id, path),
            KernelCommand::WorkspaceRename {
                request_id,
                folder_id,
                old_path,
                new_path,
            } => self.workspace_rename(request_id, folder_id, old_path, new_path),
            KernelCommand::WorkspaceDelete {
                request_id,
                folder_id,
                path,
            } => self.workspace_delete(request_id, folder_id, path),
            KernelCommand::WorkspaceSearch {
                request_id,
                folder_id,
                query,
                include,
                is_regex,
            } => self.workspace_search(request_id, folder_id, query, include, is_regex),
            KernelCommand::ToolInvoke {
                request_id,
                run_id,
                session_id,
                tool_call_id,
                tool_name,
                arguments,
                workspace_binding,
            } => self.tool_invoke(
                request_id,
                run_id,
                session_id,
                tool_call_id,
                tool_name,
                arguments,
                workspace_binding,
            ),
            KernelCommand::SkillDiscover { request_id } => self.skill_discover(request_id),
            KernelCommand::SkillInvoke {
                request_id,
                run_id,
                session_id,
                skill_id,
                input,
            } => self.skill_invoke(request_id, run_id, session_id, skill_id, input),
            KernelCommand::ContextAttachReference {
                request_id,
                source_path,
                import_copy,
            } => self.context_attach_reference(request_id, source_path, import_copy),
            KernelCommand::ContextListReferences { request_id } => {
                self.context_list_references(request_id)
            }
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
            KernelCommand::PlanAccept {
                request_id,
                run_id,
                plan_id,
            } => self.plan_accept(request_id, run_id, plan_id, false),
            KernelCommand::PlanReject {
                request_id,
                run_id,
                plan_id,
                reason,
            } => self.plan_reject(request_id, run_id, plan_id, reason),
            KernelCommand::PlanRevise {
                request_id,
                run_id,
                plan_id,
                guidance,
            } => self.plan_revise(request_id, run_id, plan_id, guidance),
            KernelCommand::PlanContractSubmit { request_id, .. } => {
                self.not_implemented(request_id, "plan.contract_submit")
            }
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
