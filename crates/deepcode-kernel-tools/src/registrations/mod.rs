mod builder;
mod schema;

use self::builder::build_tool_contract;
use self::schema::provider_schema_for_operation;
use crate::{
    authority_descriptor_v4, AuthorityToolDescriptorV4, KernelExecutorBinding, KernelToolContract,
    OperationExecutionMode, ToolFamily, ToolOperationKind, ToolPermissionMode, ToolRiskLevel,
};
use deepcode_kernel_abi::{
    ToolAvailabilityV2, ToolDescriptorV2, ToolEffectClassV2, ToolEffectScopeV2, ToolIdV2,
    ToolInputSchemaV2, ToolRiskV2,
};

#[derive(Debug, Clone)]
pub struct KernelToolRegistration {
    pub contract: KernelToolContract,
    pub descriptor_v2: ToolDescriptorV2,
    pub executor_binding: Option<KernelExecutorBinding>,
    pub(crate) authority_v4: Option<AuthorityToolDescriptorV4>,
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
        registered_tool(
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
            execution(
                "kernel.disabled.fs.rename",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(true, false),
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
                "kernel.disabled.git.status",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(true, true),
        ),
        registered_tool(
            identity("git.diff", ToolOperationKind::GitDiff, ToolFamily::Git),
            permission("git.read", ToolRiskLevel::Low, ToolPermissionMode::Allow),
            execution(
                "kernel.disabled.git.diff",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(true, true),
        ),
        registered_tool(
            identity("git.stage", ToolOperationKind::GitStage, ToolFamily::Git),
            permission("git.write", ToolRiskLevel::High, ToolPermissionMode::Ask),
            execution(
                "kernel.disabled.git.stage",
                None,
                OperationExecutionMode::Blocked,
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
                "kernel.disabled.git.unstage",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(true, false),
        ),
        registered_tool(
            identity("git.commit", ToolOperationKind::GitCommit, ToolFamily::Git),
            permission("git.write", ToolRiskLevel::High, ToolPermissionMode::Ask),
            execution(
                "kernel.disabled.git.commit",
                None,
                OperationExecutionMode::Blocked,
            ),
            resources(true, false),
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
    let contract = build_tool_contract(identity, permission, execution, resources);
    let descriptor_v2 = descriptor_v2(&contract, executor_binding.is_some())
        .unwrap_or_else(|error| panic!("invalid built-in tool `{}`: {error}", identity.tool_id));
    KernelToolRegistration {
        contract,
        descriptor_v2,
        executor_binding,
        authority_v4: authority_descriptor_v4(identity.tool_id),
    }
}

fn descriptor_v2(
    contract: &KernelToolContract,
    has_executor: bool,
) -> Result<ToolDescriptorV2, deepcode_kernel_abi::v2::V2ValidationError> {
    ToolDescriptorV2::materialize(
        ToolIdV2::parse(contract.tool_id)?,
        tool_description_v2(contract.tool_id).to_owned(),
        ToolInputSchemaV2::new(contract.input.schema.clone())?,
        tool_prompt_v2(contract.tool_id).to_owned(),
        if contract.execution.execution_mode == OperationExecutionMode::Execute && has_executor {
            ToolAvailabilityV2::Ready
        } else {
            ToolAvailabilityV2::Disabled
        },
        if contract.resource.read_only {
            ToolEffectClassV2::Read
        } else {
            ToolEffectClassV2::Mutation
        },
        effect_scope_v2(contract.operation_kind),
        match contract.permission.risk {
            ToolRiskLevel::Low => ToolRiskV2::Low,
            ToolRiskLevel::Medium => ToolRiskV2::Medium,
            ToolRiskLevel::High => ToolRiskV2::High,
            ToolRiskLevel::Critical => ToolRiskV2::Critical,
        },
    )
}

fn effect_scope_v2(operation_kind: ToolOperationKind) -> ToolEffectScopeV2 {
    match operation_kind {
        ToolOperationKind::GitStatus | ToolOperationKind::GitDiff => {
            ToolEffectScopeV2::RepositoryRead
        }
        ToolOperationKind::GitStage | ToolOperationKind::GitUnstage => {
            ToolEffectScopeV2::RepositoryIndexWrite
        }
        ToolOperationKind::GitCommit | ToolOperationKind::GitPush => {
            ToolEffectScopeV2::RepositoryHistoryWrite
        }
        ToolOperationKind::WebSearch | ToolOperationKind::WebFetch => {
            ToolEffectScopeV2::NetworkRead
        }
        _ if operation_kind.is_workspace_mutation() => ToolEffectScopeV2::WorkspaceWrite,
        _ => ToolEffectScopeV2::WorkspaceRead,
    }
}

fn tool_description_v2(tool_id: &str) -> &'static str {
    match tool_id {
        "code.grep" => "Search workspace text with a bounded literal or regular expression query.",
        "document.read" => "Read bounded text from a supported workspace document.",
        "fs.create" => "Create a new workspace file without overwriting an existing target.",
        "fs.delete" => "Delete one explicitly scoped workspace file or directory tree.",
        "fs.diff" => "Preview the textual difference for proposed workspace file content.",
        "fs.edit" => "Apply a preconditioned edit to an existing workspace file.",
        "fs.ensure_directory" => "Ensure that an explicitly scoped workspace directory exists.",
        "fs.glob" => "Find workspace paths matching a bounded glob pattern.",
        "fs.list" => "List a bounded workspace directory tree.",
        "fs.read" => "Read bounded text from a workspace file.",
        "fs.rename" => "Rename one workspace path to a new non-existing destination.",
        "fs.write" => "Replace the content of an existing workspace file.",
        "git.commit" => "Create a repository commit from the staged index.",
        "git.diff" => "Read repository differences for the repository or selected paths.",
        "git.stage" => "Stage explicitly scoped workspace paths in the repository index.",
        "git.status" => "Read the repository working tree and index status.",
        "git.unstage" => "Remove explicitly scoped paths from the repository index.",
        "web.fetch" => "Fetch bounded public HTTP or HTTPS text.",
        "web.search" => "Search the public web with a bounded result count.",
        _ => "Execute a Kernel-registered tool.",
    }
}

fn tool_prompt_v2(tool_id: &str) -> &'static str {
    match tool_id {
        "fs.create" | "fs.write" | "fs.edit" | "fs.delete" | "fs.ensure_directory" => {
            "Use only for an accepted PlanAction and provide workspace-relative targets."
        }
        "fs.rename" | "git.commit" | "git.stage" | "git.unstage" => {
            "This registration is disabled and must not be emitted as a provider tool call."
        }
        "git.status" | "git.diff" => {
            "This registration is disabled and must not be emitted as a provider tool call."
        }
        "web.search" | "web.fetch" => {
            "Use only when network access is in Settings and the active authority scope."
        }
        _ => "Provide only the arguments defined by this schema; paths are workspace-relative.",
    }
}
