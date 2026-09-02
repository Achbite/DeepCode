mod schema;

use self::schema::provider_schema_for_tool;
use crate::invocation_adapter::canonicalize_invocation;
use crate::invocation_types::{KernelCanonicalInvocation, KernelToolKind};
use crate::types::{ToolAvailability, ToolDescriptor, ToolEffectClass, ToolEffectScope};
use serde_json::Value;

pub(crate) type KernelInvocationCanonicalizer =
    fn(Value) -> Result<KernelCanonicalInvocation, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelExecutorBinding {
    FsRead,
    FsWrite,
    FsEdit,
    FsDelete,
    WebSearch,
    WebFetch,
    ProcessShell,
}

#[derive(Debug, Clone)]
pub(crate) struct KernelToolRegistration {
    pub(crate) descriptor: ToolDescriptor,
    pub(crate) executor_binding: Option<KernelExecutorBinding>,
    pub(crate) canonicalize_invocation: Option<KernelInvocationCanonicalizer>,
    tool_id: &'static str,
}

impl KernelToolRegistration {
    pub(crate) fn tool_id(&self) -> &'static str {
        self.tool_id
    }
}

#[derive(Clone, Copy)]
struct ToolSpec {
    tool: KernelToolKind,
    executor_binding: KernelExecutorBinding,
    effect_class: ToolEffectClass,
    effect_scope: ToolEffectScope,
}

const fn tool(
    tool: KernelToolKind,
    executor_binding: KernelExecutorBinding,
    effect_class: ToolEffectClass,
    effect_scope: ToolEffectScope,
) -> ToolSpec {
    ToolSpec {
        tool,
        executor_binding,
        effect_class,
        effect_scope,
    }
}

pub(crate) fn builtin_tool_registrations() -> Vec<KernelToolRegistration> {
    use KernelExecutorBinding as Executor;
    use KernelToolKind as Tool;
    use ToolEffectClass::{Mutation, Read};
    use ToolEffectScope::{NetworkRead, Process, WorkspaceRead, WorkspaceWrite};

    [
        tool(Tool::FsRead, Executor::FsRead, Read, WorkspaceRead),
        tool(Tool::FsWrite, Executor::FsWrite, Mutation, WorkspaceWrite),
        tool(Tool::FsEdit, Executor::FsEdit, Mutation, WorkspaceWrite),
        tool(Tool::FsDelete, Executor::FsDelete, Mutation, WorkspaceWrite),
        tool(Tool::WebSearch, Executor::WebSearch, Read, NetworkRead),
        tool(Tool::WebFetch, Executor::WebFetch, Read, NetworkRead),
        tool(
            Tool::ProcessShell,
            Executor::ProcessShell,
            Mutation,
            Process,
        ),
    ]
    .into_iter()
    .map(register_tool)
    .collect()
}

fn register_tool(spec: ToolSpec) -> KernelToolRegistration {
    let tool_id = spec.tool.as_str();
    let availability = if spec.tool == KernelToolKind::ProcessShell {
        process_shell_availability()
    } else {
        ToolAvailability::Callable
    };
    KernelToolRegistration {
        descriptor: ToolDescriptor {
            name: tool_id.to_owned(),
            description: tool_description(spec.tool).to_owned(),
            input_schema: provider_schema_for_tool(spec.tool),
            effect_class: spec.effect_class,
            effect_scope: spec.effect_scope,
            availability,
        },
        executor_binding: (availability == ToolAvailability::Callable)
            .then_some(spec.executor_binding),
        canonicalize_invocation: (availability == ToolAvailability::Callable)
            .then(|| canonicalizer_for(spec.tool)),
        tool_id,
    }
}

const fn process_shell_availability() -> ToolAvailability {
    ToolAvailability::Callable
}

macro_rules! invocation_canonicalizer {
    ($name:ident, $tool:expr) => {
        fn $name(arguments: Value) -> Result<KernelCanonicalInvocation, String> {
            canonicalize_invocation($tool, arguments).map_err(|error| error.to_string())
        }
    };
}

invocation_canonicalizer!(canonicalize_fs_read, KernelToolKind::FsRead);
invocation_canonicalizer!(canonicalize_fs_write, KernelToolKind::FsWrite);
invocation_canonicalizer!(canonicalize_fs_edit, KernelToolKind::FsEdit);
invocation_canonicalizer!(canonicalize_fs_delete, KernelToolKind::FsDelete);
invocation_canonicalizer!(canonicalize_web_search, KernelToolKind::WebSearch);
invocation_canonicalizer!(canonicalize_web_fetch, KernelToolKind::WebFetch);
invocation_canonicalizer!(canonicalize_process_shell, KernelToolKind::ProcessShell);

fn canonicalizer_for(tool: KernelToolKind) -> KernelInvocationCanonicalizer {
    match tool {
        KernelToolKind::FsRead => canonicalize_fs_read,
        KernelToolKind::FsWrite => canonicalize_fs_write,
        KernelToolKind::FsEdit => canonicalize_fs_edit,
        KernelToolKind::FsDelete => canonicalize_fs_delete,
        KernelToolKind::WebSearch => canonicalize_web_search,
        KernelToolKind::WebFetch => canonicalize_web_fetch,
        KernelToolKind::ProcessShell => canonicalize_process_shell,
    }
}

fn tool_description(tool: KernelToolKind) -> &'static str {
    match tool {
        KernelToolKind::FsDelete => "Delete one explicitly named workspace file or directory tree.",
        KernelToolKind::FsEdit => "Apply exact, non-overlapping text replacements to one existing workspace file.",
        KernelToolKind::FsRead => "Read bounded UTF-8 text from a workspace file. Do not use for PDFs or binary files.",
        KernelToolKind::FsWrite => "Create or replace one workspace file and any missing parent directories.",
        KernelToolKind::WebFetch => "Fetch bounded HTTP or HTTPS text.",
        KernelToolKind::WebSearch => {
            "Search the web through the built-in RSS backend or an explicitly configured JSON endpoint."
        }
        KernelToolKind::ProcessShell => {
            #[cfg(target_os = "macos")]
            {
                "Execute one bounded Bash command from the bound workspace. executionScope \"workspace\" uses the macOS workspace sandbox; \"host\" uses the host user environment and external-effect authority. Use workspaceMode \"write\" for workspace mutations. terminal optionally supplies exact one-call PTY input; otherwise stdin is closed. The result follows the shell command's final exit status, so use fail-fast shell logic when every step must succeed."
            }
            #[cfg(not(target_os = "macos"))]
            {
                "Execute one bounded Bash command from the bound workspace. On this platform executionScope \"workspace\" is unavailable because no workspace sandbox is registered; use \"host\" only when host execution is intended and external-effect authority is available. Use workspaceMode \"write\" for workspace mutations. terminal optionally supplies exact one-call PTY input; otherwise stdin is closed. The result follows the shell command's final exit status, so use fail-fast shell logic when every step must succeed."
            }
        }
    }
}
