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
    ProcessPowerShell,
}

#[derive(Debug, Clone)]
pub(crate) struct KernelToolRegistration {
    pub(crate) descriptor: ToolDescriptor,
    pub(crate) executor_binding: KernelExecutorBinding,
    pub(crate) canonicalize_invocation: KernelInvocationCanonicalizer,
    pub(crate) usage_guidelines: &'static [&'static str],
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
        tool(
            Tool::ProcessPowerShell,
            Executor::ProcessPowerShell,
            Mutation,
            Process,
        ),
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
    let (description, usage_guidelines) = tool_guidance(spec.tool);
    KernelToolRegistration {
        descriptor: ToolDescriptor {
            name: tool_id.to_owned(),
            description: description.to_owned(),
            input_schema: provider_schema_for_tool(spec.tool),
            effect_class: spec.effect_class,
            effect_scope: spec.effect_scope,
            availability: ToolAvailability::Callable,
        },
        executor_binding: spec.executor_binding,
        canonicalize_invocation: canonicalizer_for(spec.tool),
        usage_guidelines,
        tool_id,
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
invocation_canonicalizer!(canonicalize_fs_write, KernelToolKind::FsWrite);
invocation_canonicalizer!(canonicalize_fs_edit, KernelToolKind::FsEdit);
invocation_canonicalizer!(canonicalize_fs_delete, KernelToolKind::FsDelete);
invocation_canonicalizer!(canonicalize_web_search, KernelToolKind::WebSearch);
invocation_canonicalizer!(canonicalize_web_fetch, KernelToolKind::WebFetch);
invocation_canonicalizer!(canonicalize_process_shell, KernelToolKind::ProcessShell);
invocation_canonicalizer!(canonicalize_powershell, KernelToolKind::ProcessPowerShell);

fn canonicalizer_for(tool: KernelToolKind) -> KernelInvocationCanonicalizer {
    match tool {
        KernelToolKind::FsRead => canonicalize_fs_read,
        KernelToolKind::FsWrite => canonicalize_fs_write,
        KernelToolKind::FsEdit => canonicalize_fs_edit,
        KernelToolKind::FsDelete => canonicalize_fs_delete,
        KernelToolKind::WebSearch => canonicalize_web_search,
        KernelToolKind::WebFetch => canonicalize_web_fetch,
        KernelToolKind::ProcessShell => canonicalize_process_shell,
        KernelToolKind::ProcessPowerShell => canonicalize_powershell,
    }
}

fn tool_guidance(tool: KernelToolKind) -> (&'static str, &'static [&'static str]) {
    match tool {
        KernelToolKind::FsDelete => (
            "Delete one explicitly named workspace file or directory tree.",
            &[],
        ),
        KernelToolKind::FsEdit => (
            "Apply exact, non-overlapping text replacements to one existing workspace file. Every oldText must match a unique region of the original file; later edits do not see earlier replacements. Keep oldText as small as possible while still unique, and do not include large unchanged regions. Combine disjoint changes to the same file in one call. All replacements are applied atomically.",
            &[],
        ),
        KernelToolKind::FsRead => (
            "Read bounded UTF-8 text from a workspace file. Do not use for PDFs or binary files. The content field contains the selected source text, including whitespace. Check the returned truncation fields and line range before requesting more content.",
            &[
                "Use this to inspect the contents of a known workspace text file instead of shell commands such as cat or sed.",
                "Use startLine and maxLines for a line range; startByte and maxBytes for byte bounds."
            ],
        ),
        KernelToolKind::FsWrite => (
            "Create or replace one workspace file and any missing parent directories.",
            &[],
        ),
        KernelToolKind::WebFetch => (
            "Read bounded text from a known HTTP or HTTPS URL.",
            &[
                "Read URLs supplied by the user or returned by search."
            ],
        ),
        KernelToolKind::WebSearch => (
            "Search the web by keyword and return sources.",
            &[
                "Cite returned sources and report search errors."
            ],
        ),
        KernelToolKind::ProcessPowerShell => (
            "Execute a bounded PowerShell script in the selected native Windows environment. Use PowerShell syntax. Each call starts a fresh noninteractive process with no user profile and UTF-8 output. Scope and Plan authority are the same as other process tools. Check $LASTEXITCODE for native programs and use exit to preserve a failed command status.",
            &[
                "Use PowerShell syntax directly. Each call starts without a profile and emits UTF-8. Windows PowerShell 5.1 does not support && or ||; use separate statements and explicit exit handling.",
                "After a native executable, capture $LASTEXITCODE before running another command and exit with that code when validating a build or test. Do not assume a pipeline preserves the original exit code.",
                "Use the declared project tools. Report observations with their execution scope: denied sandbox access does not prove a host service is stopped. Check status in the intended scope before starting a service. A nonzero test result is not evidence of shell incompatibility.",
                "Stay within the confirmed Plan targets and execution scope. If the selected environment cannot enforce workspace scope, report that limit and request a permitted host scope or another project environment; changing shell syntax does not grant permission."
            ],
        ),
        KernelToolKind::ProcessShell => (
            "Execute one bounded Bash command from the bound workspace. executionScope \"workspace\" uses the selected environment's workspace sandbox; \"host\" uses the host environment and requires external-effect authority. Check the execution environment snapshot for sandbox availability. Use workspaceMode \"write\" for mutations. terminal supplies optional one-call PTY input; otherwise stdin is closed. The result preserves the command's final exit status.",
            &[
                "Use this for discovery, search, builds and commands. Run checks independently or save and return their exit status; use conditionals for expected failures and pipefail when pipeline failures must propagate.",
                "Do not use this as the default way to read a known UTF-8 workspace text file.",
                "Use the project's declared build/test scripts in their required environment. Finding an executable does not establish service readiness. A sandbox denial or unreachable socket does not prove a host service is stopped; check status in the intended scope before starting it. Host execution requires Kernel authorization; a confirmed Plan alone does not provide it.",
                "A Plan denial means this call was not executed. Stay within confirmed targets and executionScope; routine command details do not require reconfirmation. Revise the Plan only when the authorized scope must change.",
                "Output is limited to the last 2000 lines or 50 KiB. When truncated, fullOutput contains Session-owned log paths; inspect bounded sections with a read-only Bash command instead of repeating the original command."
            ],
        ),
    }
}
