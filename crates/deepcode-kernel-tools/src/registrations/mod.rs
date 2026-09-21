mod schema;

use self::schema::provider_schema_for_tool;
use crate::invocation_types::KernelToolKind;
use crate::types::{ToolAvailability, ToolDescriptor, ToolEffectClass, ToolEffectScope};

#[derive(Debug, Clone)]
pub(crate) struct KernelToolRegistration {
    pub(crate) descriptor: ToolDescriptor,
    pub(crate) kind: KernelToolKind,
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
    effect_class: ToolEffectClass,
    effect_scope: ToolEffectScope,
}

const fn tool(
    tool: KernelToolKind,
    effect_class: ToolEffectClass,
    effect_scope: ToolEffectScope,
) -> ToolSpec {
    ToolSpec {
        tool,
        effect_class,
        effect_scope,
    }
}

pub(crate) fn builtin_tool_registrations() -> Vec<KernelToolRegistration> {
    use KernelToolKind as Tool;
    use ToolEffectClass::{Mutation, Read};
    use ToolEffectScope::{NetworkRead, Process, WorkspaceRead, WorkspaceWrite};

    [
        tool(Tool::ProcessPowerShell, Mutation, Process),
        tool(Tool::FsRead, Read, WorkspaceRead),
        tool(Tool::FsWrite, Mutation, WorkspaceWrite),
        tool(Tool::FsEdit, Mutation, WorkspaceWrite),
        tool(Tool::FsDelete, Mutation, WorkspaceWrite),
        tool(Tool::WebSearch, Read, NetworkRead),
        tool(Tool::WebFetch, Read, NetworkRead),
        tool(Tool::ProcessShell, Mutation, Process),
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
        kind: spec.tool,
        usage_guidelines,
        tool_id,
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
            "Run a PowerShell script in the selected Windows environment. Kernel applies available filesystem permissions: project files are read-only; approved test/output directories and session drafts are writable. The result preserves the actual exit status and output.",
            &[
                "Each call starts in the bound workspace root with no profile and UTF-8 output. Use PowerShell syntax; Windows PowerShell 5.1 does not support && or ||. Preserve $LASTEXITCODE for native commands.",
                "Use the project's required build/test entrypoints. Report the actual command error; missing commands, denied access and connection failures do not prove that tools or services are absent.",
                "Use file tools to edit or delete project files. Declare test/output directories in Plan writablePaths. Kernel owns temporary resources for each call; keep files needed by later calls in workspace paths."
            ],
        ),
        KernelToolKind::ProcessShell => (
            "Run a Bash script from the bound workspace root. Kernel applies the available filesystem permissions: project files are read-only; approved test/output directories and session drafts are writable. Commands can fail at the sandbox boundary; the result preserves their exit status and output. Optional terminal input uses a one-call PTY; otherwise stdin is closed.",
            &[
                "Use cd for subdirectories and the project's required build/test entrypoints. Preserve the exit status being checked, including pipeline failures. Use fs.read for known UTF-8 workspace files.",
                "Report the actual command error; missing commands, denied access and connection failures do not prove that tools or services are absent.",
                "Use file tools to edit or delete project files. Declare test/output directories in Plan writablePaths. Kernel owns temporary resources for each call; keep files needed by later calls in workspace paths.",
                "Output is limited to the last 2000 lines or 50 KiB. When truncated, inspect bounded sections of the returned fullOutput log paths instead of repeating the command."
            ],
        ),
    }
}
