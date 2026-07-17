mod builder;
mod schema;

use self::builder::build_tool_contract;
use self::schema::provider_schema_for_operation;
use crate::{
    KernelExecutorBinding, KernelToolContract, OperationExecutionMode, ToolFamily,
    ToolOperationKind, ToolPermissionMode, ToolRiskLevel,
};

#[derive(Debug, Clone)]
pub struct KernelToolRegistration {
    pub contract: KernelToolContract,
    pub executor_binding: Option<KernelExecutorBinding>,
}

#[derive(Clone, Copy)]
struct RegistrationIdentity {
    tool_id: &'static str,
    operation_kind: ToolOperationKind,
    family: ToolFamily,
}

#[derive(Clone, Copy)]
struct RegistrationPermission {
    capability: &'static str,
    risk: ToolRiskLevel,
    mode: ToolPermissionMode,
}

#[derive(Clone, Copy)]
struct RegistrationExecution {
    executor_ref: &'static str,
    executor_binding: Option<KernelExecutorBinding>,
    mode: OperationExecutionMode,
}

#[derive(Clone, Copy)]
struct RegistrationResources {
    needs_workspace: bool,
    read_only: bool,
}

const fn identity(
    tool_id: &'static str,
    operation_kind: ToolOperationKind,
    family: ToolFamily,
) -> RegistrationIdentity {
    RegistrationIdentity {
        tool_id,
        operation_kind,
        family,
    }
}

const fn permission(
    capability: &'static str,
    risk: ToolRiskLevel,
    mode: ToolPermissionMode,
) -> RegistrationPermission {
    RegistrationPermission {
        capability,
        risk,
        mode,
    }
}

const fn execution(
    executor_ref: &'static str,
    executor_binding: Option<KernelExecutorBinding>,
    mode: OperationExecutionMode,
) -> RegistrationExecution {
    RegistrationExecution {
        executor_ref,
        executor_binding,
        mode,
    }
}

const fn resources(needs_workspace: bool, read_only: bool) -> RegistrationResources {
    RegistrationResources {
        needs_workspace,
        read_only,
    }
}

impl KernelToolRegistration {
    pub fn tool_id(&self) -> &'static str {
        self.contract.tool_id
    }

    pub fn capability(&self) -> &'static str {
        self.contract.permission.capability
    }

    pub fn operation_kind(&self) -> ToolOperationKind {
        self.contract.operation_kind
    }

    pub fn risk(&self) -> ToolRiskLevel {
        self.contract.permission.risk
    }

    pub fn permission_mode(&self) -> ToolPermissionMode {
        self.contract.permission.mode
    }

    pub fn execution_mode(&self) -> OperationExecutionMode {
        self.contract.execution.execution_mode
    }

    pub fn needs_workspace(&self) -> bool {
        self.contract.resource.needs_workspace
    }

    pub fn read_only(&self) -> bool {
        self.contract.resource.read_only
    }
}

pub(crate) fn builtin_tool_registrations() -> Vec<KernelToolRegistration> {
    vec![
        workspace_tool(
            identity("fs.read", ToolOperationKind::FsRead, ToolFamily::Workspace),
            permission(
                "workspace.read",
                ToolRiskLevel::Low,
                ToolPermissionMode::Allow,
            ),
            resources(true, true),
            KernelExecutorBinding::FsRead,
        ),
        workspace_tool(
            identity("fs.list", ToolOperationKind::FsList, ToolFamily::Workspace),
            permission(
                "workspace.read",
                ToolRiskLevel::Low,
                ToolPermissionMode::Allow,
            ),
            resources(true, true),
            KernelExecutorBinding::FsList,
        ),
        workspace_tool(
            identity("fs.glob", ToolOperationKind::FsGlob, ToolFamily::Workspace),
            permission(
                "workspace.read",
                ToolRiskLevel::Low,
                ToolPermissionMode::Allow,
            ),
            resources(true, true),
            KernelExecutorBinding::FsGlob,
        ),
        workspace_tool(
            identity("fs.diff", ToolOperationKind::FsDiff, ToolFamily::Workspace),
            permission(
                "workspace.read",
                ToolRiskLevel::Low,
                ToolPermissionMode::Allow,
            ),
            resources(true, true),
            KernelExecutorBinding::FsDiff,
        ),
        workspace_tool(
            identity(
                "code.grep",
                ToolOperationKind::CodeGrep,
                ToolFamily::Workspace,
            ),
            permission(
                "workspace.read",
                ToolRiskLevel::Low,
                ToolPermissionMode::Allow,
            ),
            resources(true, true),
            KernelExecutorBinding::CodeGrep,
        ),
        workspace_tool(
            identity(
                "fs.create",
                ToolOperationKind::FsCreate,
                ToolFamily::Workspace,
            ),
            permission(
                "workspace.write",
                ToolRiskLevel::Medium,
                ToolPermissionMode::Ask,
            ),
            resources(true, false),
            KernelExecutorBinding::FsCreate,
        ),
        workspace_tool(
            identity(
                "fs.write",
                ToolOperationKind::FsWrite,
                ToolFamily::Workspace,
            ),
            permission(
                "workspace.write",
                ToolRiskLevel::Medium,
                ToolPermissionMode::Ask,
            ),
            resources(true, false),
            KernelExecutorBinding::FsWrite,
        ),
        workspace_tool(
            identity("fs.edit", ToolOperationKind::FsEdit, ToolFamily::Workspace),
            permission(
                "workspace.write",
                ToolRiskLevel::Medium,
                ToolPermissionMode::Ask,
            ),
            resources(true, false),
            KernelExecutorBinding::FsEdit,
        ),
        workspace_tool(
            identity(
                "fs.rename",
                ToolOperationKind::FsRename,
                ToolFamily::Workspace,
            ),
            permission(
                "workspace.write",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            resources(true, false),
            KernelExecutorBinding::FsRename,
        ),
        workspace_tool(
            identity(
                "fs.delete",
                ToolOperationKind::FsDelete,
                ToolFamily::Workspace,
            ),
            permission(
                "workspace.write",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            resources(true, false),
            KernelExecutorBinding::FsDelete,
        ),
        workspace_tool(
            identity(
                "fs.ensure_directory",
                ToolOperationKind::FsEnsureDirectory,
                ToolFamily::Workspace,
            ),
            permission(
                "workspace.write",
                ToolRiskLevel::Medium,
                ToolPermissionMode::Ask,
            ),
            resources(true, false),
            KernelExecutorBinding::FsEnsureDirectory,
        ),
        registered_tool(
            identity(
                "document.read",
                ToolOperationKind::DocumentRead,
                ToolFamily::Document,
            ),
            permission(
                "workspace.read",
                ToolRiskLevel::Low,
                ToolPermissionMode::Allow,
            ),
            execution(
                "kernel.document.read",
                Some(KernelExecutorBinding::DocumentRead),
                OperationExecutionMode::Execute,
            ),
            resources(true, true),
        ),
        registered_tool(
            identity("git.status", ToolOperationKind::GitStatus, ToolFamily::Git),
            permission("git.read", ToolRiskLevel::Low, ToolPermissionMode::Allow),
            execution(
                "kernel.cli.git.status",
                Some(KernelExecutorBinding::GitStatus),
                OperationExecutionMode::Execute,
            ),
            resources(true, true),
        ),
        registered_tool(
            identity("git.diff", ToolOperationKind::GitDiff, ToolFamily::Git),
            permission("git.read", ToolRiskLevel::Low, ToolPermissionMode::Allow),
            execution(
                "kernel.cli.git.diff",
                Some(KernelExecutorBinding::GitDiff),
                OperationExecutionMode::Execute,
            ),
            resources(true, true),
        ),
        registered_tool(
            identity("git.stage", ToolOperationKind::GitStage, ToolFamily::Git),
            permission("git.write", ToolRiskLevel::High, ToolPermissionMode::Ask),
            execution(
                "kernel.cli.git.stage",
                Some(KernelExecutorBinding::GitStage),
                OperationExecutionMode::Execute,
            ),
            resources(true, false),
        ),
        registered_tool(
            identity(
                "git.unstage",
                ToolOperationKind::GitUnstage,
                ToolFamily::Git,
            ),
            permission("git.write", ToolRiskLevel::High, ToolPermissionMode::Ask),
            execution(
                "kernel.cli.git.unstage",
                Some(KernelExecutorBinding::GitUnstage),
                OperationExecutionMode::Execute,
            ),
            resources(true, false),
        ),
        registered_tool(
            identity("git.commit", ToolOperationKind::GitCommit, ToolFamily::Git),
            permission("git.write", ToolRiskLevel::High, ToolPermissionMode::Ask),
            execution(
                "kernel.cli.git.commit",
                Some(KernelExecutorBinding::GitCommit),
                OperationExecutionMode::Execute,
            ),
            resources(true, false),
        ),
        registered_tool(
            identity("git.push", ToolOperationKind::GitPush, ToolFamily::Git),
            permission("git.push", ToolRiskLevel::Critical, ToolPermissionMode::Ask),
            execution(
                "kernel.blocked.git.push",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(true, false),
        ),
        registered_tool(
            identity(
                "process.exec",
                ToolOperationKind::ProcessExec,
                ToolFamily::Process,
            ),
            permission("process.exec", ToolRiskLevel::High, ToolPermissionMode::Ask),
            execution(
                "kernel.blocked.process.exec",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, false),
        ),
        registered_tool(
            identity(
                "web.search",
                ToolOperationKind::WebSearch,
                ToolFamily::Network,
            ),
            permission(
                "network.egress",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.http.web.search",
                Some(KernelExecutorBinding::WebSearch),
                OperationExecutionMode::Execute,
            ),
            resources(false, true),
        ),
        registered_tool(
            identity(
                "web.fetch",
                ToolOperationKind::WebFetch,
                ToolFamily::Network,
            ),
            permission(
                "network.egress",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.http.web.fetch",
                Some(KernelExecutorBinding::WebFetch),
                OperationExecutionMode::Execute,
            ),
            resources(false, true),
        ),
        registered_tool(
            identity(
                "browser.open",
                ToolOperationKind::BrowserOpen,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.open",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, false),
        ),
        registered_tool(
            identity(
                "browser.reload",
                ToolOperationKind::BrowserReload,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.reload",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, false),
        ),
        registered_tool(
            identity(
                "browser.snapshot",
                ToolOperationKind::BrowserSnapshot,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.snapshot",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, true),
        ),
        registered_tool(
            identity(
                "browser.inspect",
                ToolOperationKind::BrowserInspect,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.inspect",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, true),
        ),
        registered_tool(
            identity(
                "browser.click",
                ToolOperationKind::BrowserClick,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.click",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, false),
        ),
        registered_tool(
            identity(
                "browser.type",
                ToolOperationKind::BrowserType,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.type",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, false),
        ),
        registered_tool(
            identity(
                "browser.scroll",
                ToolOperationKind::BrowserScroll,
                ToolFamily::Browser,
            ),
            permission(
                "browser.control",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.browser.scroll",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, false),
        ),
        registered_tool(
            identity(
                "provider.call",
                ToolOperationKind::ProviderCall,
                ToolFamily::Provider,
            ),
            permission(
                "provider.egress",
                ToolRiskLevel::High,
                ToolPermissionMode::Ask,
            ),
            execution(
                "kernel.blocked.provider.call",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(false, true),
        ),
    ]
}

fn workspace_tool(
    identity: RegistrationIdentity,
    permission: RegistrationPermission,
    resources: RegistrationResources,
    executor_binding: KernelExecutorBinding,
) -> KernelToolRegistration {
    registered_tool(
        identity,
        permission,
        execution(
            "kernel.builtin.workspace",
            Some(executor_binding),
            OperationExecutionMode::Execute,
        ),
        resources,
    )
}

fn registered_tool(
    identity: RegistrationIdentity,
    permission: RegistrationPermission,
    execution: RegistrationExecution,
    resources: RegistrationResources,
) -> KernelToolRegistration {
    let executor_binding = execution.executor_binding;
    KernelToolRegistration {
        contract: build_tool_contract(identity, permission, execution, resources),
        executor_binding,
    }
}
