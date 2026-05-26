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

#[derive(Debug, Clone, Default)]
pub struct KernelContext {
    pub active_session_id: Option<String>,
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
            KernelCommand::RunStart { request_id, .. } => {
                self.not_implemented(request_id, "run.start")
            }
            KernelCommand::PermissionResolve { request_id, .. } => {
                self.not_implemented(request_id, "permission.resolve")
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
