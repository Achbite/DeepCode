use deepcode_kernel_abi::{
    HostStatus, KernelCommand, KernelError, KernelEvent, KernelResult, RequestId,
};

pub trait KernelModule {
    fn module_id(&self) -> &'static str;
}

pub trait HostAdapter {
    fn emit(&mut self, event: KernelEvent) -> KernelResult<()>;
}

pub trait KernelRuntime {
    fn runtime_id(&self) -> &'static str;
}

pub trait KernelClient {
    fn dispatch(&mut self, command: KernelCommand) -> KernelResult<Vec<KernelEvent>>;
}

#[derive(Debug, Clone, Default)]
pub struct KernelContext {
    pub active_session_id: Option<String>,
    pub active_run_id: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Kernel {
    context: KernelContext,
}

impl Kernel {
    pub fn new(context: KernelContext) -> Self {
        Self { context }
    }

    pub fn context(&self) -> &KernelContext {
        &self.context
    }

    pub fn handle_command(&mut self, command: KernelCommand) -> KernelResult<Vec<KernelEvent>> {
        match command {
            KernelCommand::HealthCheck { request_id } => Ok(vec![KernelEvent::HostStatus {
                request_id: Some(request_id),
                status: HostStatus::Ready,
                detail: Some("kernel facade ready".to_string()),
                message_key: Some("kernel.host.ready".to_string()),
                args: None,
            }]),
            KernelCommand::SnapshotGet { request_id, .. } => {
                self.not_implemented(request_id, "snapshot.get")
            }
            KernelCommand::ConfigGet { request_id } => {
                self.not_implemented(request_id, "config.get")
            }
            KernelCommand::ConfigPatch { request_id, .. } => {
                self.not_implemented(request_id, "config.patch")
            }
            KernelCommand::RunStart {
                request_id,
                workspace_binding,
                ..
            } => {
                if workspace_binding.is_none() {
                    return Err(KernelError::MissingWorkspaceBinding);
                }
                self.not_implemented(request_id, "run.start")
            }
            KernelCommand::LlmResponseSubmit { request_id, .. } => {
                self.not_implemented(request_id, "llm.response_submit")
            }
            KernelCommand::RunCancel { request_id, .. } => {
                self.not_implemented(request_id, "run.cancel")
            }
            KernelCommand::RunResume { request_id, .. } => {
                self.not_implemented(request_id, "run.resume")
            }
            KernelCommand::WorkspaceOpen { request_id, .. } => {
                self.not_implemented(request_id, "workspace.open")
            }
            KernelCommand::WorkspaceCurrent { request_id } => {
                self.not_implemented(request_id, "workspace.current")
            }
            KernelCommand::WorkspaceList { request_id, .. } => {
                self.not_implemented(request_id, "workspace.list")
            }
            KernelCommand::WorkspaceRead { request_id, .. } => {
                self.not_implemented(request_id, "workspace.read")
            }
            KernelCommand::WorkspaceWrite { request_id, .. } => {
                self.not_implemented(request_id, "workspace.write")
            }
            KernelCommand::WorkspaceCreate { request_id, .. } => {
                self.not_implemented(request_id, "workspace.create")
            }
            KernelCommand::WorkspaceCreateFolder { request_id, .. } => {
                self.not_implemented(request_id, "workspace.create_folder")
            }
            KernelCommand::WorkspaceRename { request_id, .. } => {
                self.not_implemented(request_id, "workspace.rename")
            }
            KernelCommand::WorkspaceDelete { request_id, .. } => {
                self.not_implemented(request_id, "workspace.delete")
            }
            KernelCommand::WorkspaceSearch { request_id, .. } => {
                self.not_implemented(request_id, "workspace.search")
            }
            KernelCommand::ToolInvoke { request_id, .. } => {
                self.not_implemented(request_id, "tool.invoke")
            }
            KernelCommand::SkillDiscover { request_id } => {
                self.not_implemented(request_id, "skill.discover")
            }
            KernelCommand::SkillInvoke { request_id, .. } => {
                self.not_implemented(request_id, "skill.invoke")
            }
            KernelCommand::ContextAttachReference { request_id, .. } => {
                self.not_implemented(request_id, "context.attach_reference")
            }
            KernelCommand::ContextListReferences { request_id } => {
                self.not_implemented(request_id, "context.list_references")
            }
            KernelCommand::WorkflowObserve { request_id, .. } => {
                self.not_implemented(request_id, "workflow.observe")
            }
            KernelCommand::PermissionResolve { request_id, .. } => {
                self.not_implemented(request_id, "permission.resolve")
            }
            KernelCommand::PlanAccept { request_id, .. } => {
                self.not_implemented(request_id, "plan.accept")
            }
            KernelCommand::PlanReject { request_id, .. } => {
                self.not_implemented(request_id, "plan.reject")
            }
            KernelCommand::PlanRevise { request_id, .. } => {
                self.not_implemented(request_id, "plan.revise")
            }
            KernelCommand::PlanContractSubmit { request_id, .. } => {
                self.not_implemented(request_id, "plan.contract_submit")
            }
            KernelCommand::SkillTrustApprove { request_id, .. } => {
                self.not_implemented(request_id, "skill.trust_approve")
            }
            KernelCommand::PermissionGrantTemporary { request_id, .. } => {
                self.not_implemented(request_id, "permission.grant_temporary")
            }
        }
    }

    fn not_implemented(
        &self,
        _request_id: RequestId,
        operation: &'static str,
    ) -> KernelResult<Vec<KernelEvent>> {
        Err(KernelError::NotImplemented(operation))
    }
}

#[derive(Debug, Clone)]
pub struct InProcessKernelClient {
    kernel: Kernel,
}

impl InProcessKernelClient {
    pub fn new(kernel: Kernel) -> Self {
        Self { kernel }
    }

    pub fn kernel(&self) -> &Kernel {
        &self.kernel
    }
}

impl KernelClient for InProcessKernelClient {
    fn dispatch(&mut self, command: KernelCommand) -> KernelResult<Vec<KernelEvent>> {
        self.kernel.handle_command(command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_abi::{SessionId, UserInput, WorkspaceBinding};

    #[test]
    fn health_check_returns_ready_event() {
        let mut kernel = Kernel::new(KernelContext::default());
        let events = kernel
            .handle_command(KernelCommand::HealthCheck {
                request_id: RequestId("req-1".to_string()),
            })
            .expect("health check should be implemented");

        assert!(matches!(
            events.first(),
            Some(KernelEvent::HostStatus {
                status: HostStatus::Ready,
                ..
            })
        ));
    }

    #[test]
    fn unimplemented_commands_fail_closed() {
        let mut kernel = Kernel::new(KernelContext::default());
        let error = kernel
            .handle_command(KernelCommand::ConfigGet {
                request_id: RequestId("req-2".to_string()),
            })
            .expect_err("config is intentionally not implemented in stage 0");

        assert!(matches!(error, KernelError::NotImplemented("config.get")));
    }

    #[test]
    fn run_start_without_workspace_binding_fails_closed() {
        let mut kernel = Kernel::new(KernelContext::default());
        let error = kernel
            .handle_command(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "start".to_string(),
                    attachments: vec![],
                },
                workspace_binding: None,
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .expect_err("run.start must not proceed without host workspace binding");

        assert!(matches!(error, KernelError::MissingWorkspaceBinding));
    }

    #[test]
    fn run_start_with_binding_remains_not_implemented() {
        let mut kernel = Kernel::new(KernelContext::default());
        let error = kernel
            .handle_command(KernelCommand::RunStart {
                request_id: RequestId("req-run".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                input: UserInput {
                    text: "start".to_string(),
                    attachments: vec![],
                },
                workspace_binding: Some(WorkspaceBinding {
                    workspace_id: Some("ws-1".to_string()),
                    workspace_hash: Some("hash-1".to_string()),
                    open_path: Some("/workspace".to_string()),
                    active_folder_id: Some("wf-0".to_string()),
                    folder_hash: None,
                }),
                profile_ref: None,
                workflow_ref: None,
                run_overrides: None,
            })
            .expect_err("stage 1 does not execute the real agent runtime");

        assert!(matches!(error, KernelError::NotImplemented("run.start")));
    }

    #[test]
    fn in_process_kernel_client_dispatches_to_facade() {
        let kernel = Kernel::new(KernelContext::default());
        let mut client = InProcessKernelClient::new(kernel);
        let events = client
            .dispatch(KernelCommand::HealthCheck {
                request_id: RequestId("req-client".to_string()),
            })
            .expect("health check should pass through client facade");

        assert!(matches!(
            events.first(),
            Some(KernelEvent::HostStatus {
                status: HostStatus::Ready,
                ..
            })
        ));
    }
}
