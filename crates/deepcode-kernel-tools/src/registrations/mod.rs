mod schema;

use self::schema::provider_schema_for_tool;
use crate::invocation_adapter::canonicalize_invocation;
use crate::invocation_types::{KernelCanonicalInvocation, KernelToolKind};
use deepcode_kernel_abi::{
    ToolAvailabilityV2, ToolDescriptorV2, ToolEffectClassV2, ToolEffectScopeV2, ToolIdV2,
    ToolInputSchemaV2, ToolRiskV2,
};
use serde_json::Value;

pub(crate) type KernelInvocationCanonicalizer =
    fn(Value) -> Result<KernelCanonicalInvocation, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelExecutorBinding {
    FsRead,
    FsList,
    FsGlob,
    FsDiff,
    FsCreate,
    FsWrite,
    FsEdit,
    FsDelete,
    FsEnsureDirectory,
    CodeGrep,
    DocumentRead,
    WebSearch,
    WebFetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelExecutionAdapter {
    Standard,
    DocumentRead,
    WebFetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KernelAdmissionMetadata {
    pub settings_capability: &'static str,
    pub needs_workspace: bool,
    pub requires_plan_action: bool,
    pub default_deadline_ms: u32,
    pub maximum_deadline_ms: u32,
    pub maximum_output_bytes: u32,
    pub cancellation_before_effect_only: bool,
    pub idempotent: bool,
    pub requires_target_revalidation: bool,
    pub execution_adapter: KernelExecutionAdapter,
}

#[derive(Debug, Clone)]
pub(crate) struct KernelToolRegistration {
    pub(crate) descriptor_v2: ToolDescriptorV2,
    pub(crate) executor_binding: Option<KernelExecutorBinding>,
    pub(crate) canonicalize_invocation: KernelInvocationCanonicalizer,
    pub(crate) admission_v2: KernelAdmissionMetadata,
    tool_id: &'static str,
    private_tool_kind: KernelToolKind,
}

impl KernelToolRegistration {
    pub(crate) fn tool_id(&self) -> &'static str {
        self.tool_id
    }

    pub(crate) fn private_tool_kind(&self) -> KernelToolKind {
        self.private_tool_kind
    }
}

#[derive(Clone, Copy)]
struct ToolSpec {
    tool: KernelToolKind,
    availability: ToolAvailabilityV2,
    executor_binding: Option<KernelExecutorBinding>,
    settings_capability: &'static str,
    needs_workspace: bool,
    effect_class: ToolEffectClassV2,
    effect_scope: ToolEffectScopeV2,
    risk: ToolRiskV2,
}

const fn ready(
    tool: KernelToolKind,
    executor_binding: KernelExecutorBinding,
    settings_capability: &'static str,
    needs_workspace: bool,
    effect_class: ToolEffectClassV2,
    effect_scope: ToolEffectScopeV2,
    risk: ToolRiskV2,
) -> ToolSpec {
    ToolSpec {
        tool,
        availability: ToolAvailabilityV2::Ready,
        executor_binding: Some(executor_binding),
        settings_capability,
        needs_workspace,
        effect_class,
        effect_scope,
        risk,
    }
}

const fn disabled(
    tool: KernelToolKind,
    settings_capability: &'static str,
    needs_workspace: bool,
    effect_class: ToolEffectClassV2,
    effect_scope: ToolEffectScopeV2,
    risk: ToolRiskV2,
) -> ToolSpec {
    ToolSpec {
        tool,
        availability: ToolAvailabilityV2::Disabled,
        executor_binding: None,
        settings_capability,
        needs_workspace,
        effect_class,
        effect_scope,
        risk,
    }
}

pub(crate) fn builtin_tool_registrations() -> Vec<KernelToolRegistration> {
    use KernelExecutorBinding as Executor;
    use KernelToolKind as Tool;
    use ToolEffectClassV2::{Mutation, Read};
    use ToolEffectScopeV2::{
        NetworkRead, RepositoryHistoryWrite, RepositoryIndexWrite, RepositoryRead, WorkspaceRead,
        WorkspaceWrite,
    };
    use ToolRiskV2::{High, Low, Medium};

    [
        ready(
            Tool::FsRead,
            Executor::FsRead,
            "workspace.read",
            true,
            Read,
            WorkspaceRead,
            Low,
        ),
        ready(
            Tool::FsList,
            Executor::FsList,
            "workspace.read",
            true,
            Read,
            WorkspaceRead,
            Low,
        ),
        ready(
            Tool::FsGlob,
            Executor::FsGlob,
            "workspace.read",
            true,
            Read,
            WorkspaceRead,
            Low,
        ),
        ready(
            Tool::FsDiff,
            Executor::FsDiff,
            "workspace.read",
            true,
            Read,
            WorkspaceRead,
            Low,
        ),
        ready(
            Tool::CodeGrep,
            Executor::CodeGrep,
            "workspace.read",
            true,
            Read,
            WorkspaceRead,
            Low,
        ),
        ready(
            Tool::FsCreate,
            Executor::FsCreate,
            "workspace.write",
            true,
            Mutation,
            WorkspaceWrite,
            Medium,
        ),
        ready(
            Tool::FsWrite,
            Executor::FsWrite,
            "workspace.write",
            true,
            Mutation,
            WorkspaceWrite,
            Medium,
        ),
        ready(
            Tool::FsEdit,
            Executor::FsEdit,
            "workspace.write",
            true,
            Mutation,
            WorkspaceWrite,
            Medium,
        ),
        disabled(
            Tool::FsRename,
            "workspace.write",
            true,
            Mutation,
            WorkspaceWrite,
            High,
        ),
        ready(
            Tool::FsDelete,
            Executor::FsDelete,
            "workspace.write",
            true,
            Mutation,
            WorkspaceWrite,
            High,
        ),
        ready(
            Tool::FsEnsureDirectory,
            Executor::FsEnsureDirectory,
            "workspace.write",
            true,
            Mutation,
            WorkspaceWrite,
            Medium,
        ),
        ready(
            Tool::DocumentRead,
            Executor::DocumentRead,
            "workspace.read",
            true,
            Read,
            WorkspaceRead,
            Low,
        ),
        disabled(Tool::GitStatus, "git.read", true, Read, RepositoryRead, Low),
        disabled(Tool::GitDiff, "git.read", true, Read, RepositoryRead, Low),
        disabled(
            Tool::GitStage,
            "git.write",
            true,
            Mutation,
            RepositoryIndexWrite,
            High,
        ),
        disabled(
            Tool::GitUnstage,
            "git.write",
            true,
            Mutation,
            RepositoryIndexWrite,
            High,
        ),
        disabled(
            Tool::GitCommit,
            "git.write",
            true,
            Mutation,
            RepositoryHistoryWrite,
            High,
        ),
        ready(
            Tool::WebSearch,
            Executor::WebSearch,
            "network.egress",
            false,
            Read,
            NetworkRead,
            High,
        ),
        ready(
            Tool::WebFetch,
            Executor::WebFetch,
            "network.egress",
            false,
            Read,
            NetworkRead,
            High,
        ),
    ]
    .into_iter()
    .map(register_tool)
    .collect()
}

fn register_tool(spec: ToolSpec) -> KernelToolRegistration {
    let tool_id = spec.tool.as_str();
    let descriptor_v2 = ToolDescriptorV2::materialize(
        ToolIdV2::parse(tool_id)
            .unwrap_or_else(|error| panic!("invalid built-in tool id `{tool_id}`: {error}")),
        tool_description_v2(spec.tool).to_owned(),
        ToolInputSchemaV2::new(provider_schema_for_tool(spec.tool))
            .unwrap_or_else(|error| panic!("invalid schema for `{tool_id}`: {error}")),
        tool_prompt_v2(spec.tool).to_owned(),
        spec.availability,
        spec.effect_class,
        spec.effect_scope,
        spec.risk,
    )
    .unwrap_or_else(|error| panic!("invalid built-in tool `{tool_id}`: {error}"));
    KernelToolRegistration {
        descriptor_v2,
        executor_binding: spec.executor_binding,
        canonicalize_invocation: canonicalizer_for(spec.tool),
        admission_v2: kernel_internal_admission_metadata(spec),
        tool_id,
        private_tool_kind: spec.tool,
    }
}

macro_rules! invocation_canonicalizer {
    ($name:ident, $tool:expr) => {
        fn $name(arguments: Value) -> Result<KernelCanonicalInvocation, String> {
            canonicalize_invocation($tool, arguments).map_err(|error| error.to_string())
        }
    };
}

invocation_canonicalizer!(canonicalize_fs_read, KernelToolKind::FsRead);
invocation_canonicalizer!(canonicalize_fs_list, KernelToolKind::FsList);
invocation_canonicalizer!(canonicalize_fs_glob, KernelToolKind::FsGlob);
invocation_canonicalizer!(canonicalize_fs_diff, KernelToolKind::FsDiff);
invocation_canonicalizer!(canonicalize_code_grep, KernelToolKind::CodeGrep);
invocation_canonicalizer!(canonicalize_fs_create, KernelToolKind::FsCreate);
invocation_canonicalizer!(canonicalize_fs_write, KernelToolKind::FsWrite);
invocation_canonicalizer!(canonicalize_fs_edit, KernelToolKind::FsEdit);
invocation_canonicalizer!(canonicalize_fs_rename, KernelToolKind::FsRename);
invocation_canonicalizer!(canonicalize_fs_delete, KernelToolKind::FsDelete);
invocation_canonicalizer!(
    canonicalize_fs_ensure_directory,
    KernelToolKind::FsEnsureDirectory
);
invocation_canonicalizer!(canonicalize_document_read, KernelToolKind::DocumentRead);
invocation_canonicalizer!(canonicalize_git_status, KernelToolKind::GitStatus);
invocation_canonicalizer!(canonicalize_git_diff, KernelToolKind::GitDiff);
invocation_canonicalizer!(canonicalize_git_stage, KernelToolKind::GitStage);
invocation_canonicalizer!(canonicalize_git_unstage, KernelToolKind::GitUnstage);
invocation_canonicalizer!(canonicalize_git_commit, KernelToolKind::GitCommit);
invocation_canonicalizer!(canonicalize_web_search, KernelToolKind::WebSearch);
invocation_canonicalizer!(canonicalize_web_fetch, KernelToolKind::WebFetch);

fn canonicalizer_for(tool: KernelToolKind) -> KernelInvocationCanonicalizer {
    match tool {
        KernelToolKind::FsRead => canonicalize_fs_read,
        KernelToolKind::FsList => canonicalize_fs_list,
        KernelToolKind::FsGlob => canonicalize_fs_glob,
        KernelToolKind::FsDiff => canonicalize_fs_diff,
        KernelToolKind::CodeGrep => canonicalize_code_grep,
        KernelToolKind::FsCreate => canonicalize_fs_create,
        KernelToolKind::FsWrite => canonicalize_fs_write,
        KernelToolKind::FsEdit => canonicalize_fs_edit,
        KernelToolKind::FsRename => canonicalize_fs_rename,
        KernelToolKind::FsDelete => canonicalize_fs_delete,
        KernelToolKind::FsEnsureDirectory => canonicalize_fs_ensure_directory,
        KernelToolKind::DocumentRead => canonicalize_document_read,
        KernelToolKind::GitStatus => canonicalize_git_status,
        KernelToolKind::GitDiff => canonicalize_git_diff,
        KernelToolKind::GitStage => canonicalize_git_stage,
        KernelToolKind::GitUnstage => canonicalize_git_unstage,
        KernelToolKind::GitCommit => canonicalize_git_commit,
        KernelToolKind::WebSearch => canonicalize_web_search,
        KernelToolKind::WebFetch => canonicalize_web_fetch,
    }
}

fn kernel_internal_admission_metadata(spec: ToolSpec) -> KernelAdmissionMetadata {
    let (default_deadline_ms, maximum_deadline_ms, maximum_output_bytes) = match spec.tool {
        KernelToolKind::GitStatus
        | KernelToolKind::GitDiff
        | KernelToolKind::GitStage
        | KernelToolKind::GitUnstage
        | KernelToolKind::GitCommit => (30_000, 120_000, 65_536),
        KernelToolKind::WebSearch | KernelToolKind::WebFetch => (15_000, 60_000, 262_144),
        _ => (10_000, 30_000, 4_194_304),
    };
    let execution_adapter = match spec.tool {
        KernelToolKind::DocumentRead => KernelExecutionAdapter::DocumentRead,
        KernelToolKind::WebFetch => KernelExecutionAdapter::WebFetch,
        _ => KernelExecutionAdapter::Standard,
    };
    KernelAdmissionMetadata {
        settings_capability: spec.settings_capability,
        needs_workspace: spec.needs_workspace,
        requires_plan_action: spec.effect_class == ToolEffectClassV2::Mutation
            || spec.effect_scope == ToolEffectScopeV2::NetworkRead,
        default_deadline_ms,
        maximum_deadline_ms,
        maximum_output_bytes,
        cancellation_before_effect_only: true,
        idempotent: spec.effect_class == ToolEffectClassV2::Read,
        requires_target_revalidation: true,
        execution_adapter,
    }
}

fn tool_description_v2(tool: KernelToolKind) -> &'static str {
    match tool {
        KernelToolKind::CodeGrep => {
            "Search workspace text with a bounded literal or regular expression query."
        }
        KernelToolKind::DocumentRead => "Read bounded text from a supported workspace document.",
        KernelToolKind::FsCreate => {
            "Create a new workspace file without overwriting an existing target."
        }
        KernelToolKind::FsDelete => {
            "Delete one explicitly scoped workspace file or directory tree."
        }
        KernelToolKind::FsDiff => {
            "Preview the textual difference for proposed workspace file content."
        }
        KernelToolKind::FsEdit => "Apply a preconditioned edit to an existing workspace file.",
        KernelToolKind::FsEnsureDirectory => {
            "Ensure that an explicitly scoped workspace directory exists."
        }
        KernelToolKind::FsGlob => "Find workspace paths matching a bounded glob pattern.",
        KernelToolKind::FsList => "List a bounded workspace directory tree.",
        KernelToolKind::FsRead => "Read bounded text from a workspace file.",
        KernelToolKind::FsRename => "Rename one workspace path to a new non-existing destination.",
        KernelToolKind::FsWrite => "Replace the content of an existing workspace file.",
        KernelToolKind::GitCommit => "Create a repository commit from the staged index.",
        KernelToolKind::GitDiff => {
            "Read repository differences for the repository or selected paths."
        }
        KernelToolKind::GitStage => {
            "Stage explicitly scoped workspace paths in the repository index."
        }
        KernelToolKind::GitStatus => "Read the repository working tree and index status.",
        KernelToolKind::GitUnstage => "Remove explicitly scoped paths from the repository index.",
        KernelToolKind::WebFetch => "Fetch bounded public HTTP or HTTPS text.",
        KernelToolKind::WebSearch => "Search the public web with a bounded result count.",
    }
}

fn tool_prompt_v2(tool: KernelToolKind) -> &'static str {
    match tool {
        KernelToolKind::FsCreate
        | KernelToolKind::FsWrite
        | KernelToolKind::FsEdit
        | KernelToolKind::FsEnsureDirectory => {
            "Use only for an accepted PlanAction and provide workspace-relative targets."
        }
        KernelToolKind::FsDelete => {
            "Use only for an accepted PlanAction. Provide a workspace-relative path and an explicit targetKind. Directory deletion also requires recursive=true."
        }
        KernelToolKind::FsRename
        | KernelToolKind::GitCommit
        | KernelToolKind::GitStage
        | KernelToolKind::GitUnstage
        | KernelToolKind::GitStatus
        | KernelToolKind::GitDiff => {
            "This registration is disabled and must not be emitted as a provider tool call."
        }
        KernelToolKind::WebSearch | KernelToolKind::WebFetch => {
            "Use only when network access is in Settings and the active PlanAction scope."
        }
        KernelToolKind::FsList | KernelToolKind::FsGlob => {
            "Provide only schema-defined arguments and workspace-relative paths. Use \".\" for the workspace root (or omit an optional path); never send an empty path string."
        }
        _ => "Provide only the arguments defined by this schema; paths are workspace-relative.",
    }
}
