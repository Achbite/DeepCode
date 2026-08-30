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
    FsStat,
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
    GithubSearch,
    GithubRead,
    ArxivSearch,
    ArxivRead,
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
        tool(Tool::FsStat, Executor::FsStat, Read, WorkspaceRead),
        tool(Tool::FsList, Executor::FsList, Read, WorkspaceRead),
        tool(Tool::FsGlob, Executor::FsGlob, Read, WorkspaceRead),
        tool(Tool::FsDiff, Executor::FsDiff, Read, WorkspaceRead),
        tool(Tool::CodeGrep, Executor::CodeGrep, Read, WorkspaceRead),
        tool(Tool::FsCreate, Executor::FsCreate, Mutation, WorkspaceWrite),
        tool(Tool::FsWrite, Executor::FsWrite, Mutation, WorkspaceWrite),
        tool(Tool::FsEdit, Executor::FsEdit, Mutation, WorkspaceWrite),
        tool(Tool::FsDelete, Executor::FsDelete, Mutation, WorkspaceWrite),
        tool(
            Tool::FsEnsureDirectory,
            Executor::FsEnsureDirectory,
            Mutation,
            WorkspaceWrite,
        ),
        tool(
            Tool::DocumentRead,
            Executor::DocumentRead,
            Read,
            WorkspaceRead,
        ),
        tool(Tool::WebSearch, Executor::WebSearch, Read, NetworkRead),
        tool(Tool::WebFetch, Executor::WebFetch, Read, NetworkRead),
        tool(
            Tool::GithubSearch,
            Executor::GithubSearch,
            Read,
            NetworkRead,
        ),
        tool(Tool::GithubRead, Executor::GithubRead, Read, NetworkRead),
        tool(Tool::ArxivSearch, Executor::ArxivSearch, Read, NetworkRead),
        tool(Tool::ArxivRead, Executor::ArxivRead, Read, NetworkRead),
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
    #[cfg(target_os = "macos")]
    {
        ToolAvailability::Callable
    }
    #[cfg(not(target_os = "macos"))]
    {
        ToolAvailability::Blocked
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
invocation_canonicalizer!(canonicalize_fs_stat, KernelToolKind::FsStat);
invocation_canonicalizer!(canonicalize_fs_list, KernelToolKind::FsList);
invocation_canonicalizer!(canonicalize_fs_glob, KernelToolKind::FsGlob);
invocation_canonicalizer!(canonicalize_fs_diff, KernelToolKind::FsDiff);
invocation_canonicalizer!(canonicalize_code_grep, KernelToolKind::CodeGrep);
invocation_canonicalizer!(canonicalize_fs_create, KernelToolKind::FsCreate);
invocation_canonicalizer!(canonicalize_fs_write, KernelToolKind::FsWrite);
invocation_canonicalizer!(canonicalize_fs_edit, KernelToolKind::FsEdit);
invocation_canonicalizer!(canonicalize_fs_delete, KernelToolKind::FsDelete);
invocation_canonicalizer!(
    canonicalize_fs_ensure_directory,
    KernelToolKind::FsEnsureDirectory
);
invocation_canonicalizer!(canonicalize_document_read, KernelToolKind::DocumentRead);
invocation_canonicalizer!(canonicalize_web_search, KernelToolKind::WebSearch);
invocation_canonicalizer!(canonicalize_web_fetch, KernelToolKind::WebFetch);
invocation_canonicalizer!(canonicalize_github_search, KernelToolKind::GithubSearch);
invocation_canonicalizer!(canonicalize_github_read, KernelToolKind::GithubRead);
invocation_canonicalizer!(canonicalize_arxiv_search, KernelToolKind::ArxivSearch);
invocation_canonicalizer!(canonicalize_arxiv_read, KernelToolKind::ArxivRead);
invocation_canonicalizer!(canonicalize_process_shell, KernelToolKind::ProcessShell);

fn canonicalizer_for(tool: KernelToolKind) -> KernelInvocationCanonicalizer {
    match tool {
        KernelToolKind::FsRead => canonicalize_fs_read,
        KernelToolKind::FsStat => canonicalize_fs_stat,
        KernelToolKind::FsList => canonicalize_fs_list,
        KernelToolKind::FsGlob => canonicalize_fs_glob,
        KernelToolKind::FsDiff => canonicalize_fs_diff,
        KernelToolKind::CodeGrep => canonicalize_code_grep,
        KernelToolKind::FsCreate => canonicalize_fs_create,
        KernelToolKind::FsWrite => canonicalize_fs_write,
        KernelToolKind::FsEdit => canonicalize_fs_edit,
        KernelToolKind::FsDelete => canonicalize_fs_delete,
        KernelToolKind::FsEnsureDirectory => canonicalize_fs_ensure_directory,
        KernelToolKind::DocumentRead => canonicalize_document_read,
        KernelToolKind::WebSearch => canonicalize_web_search,
        KernelToolKind::WebFetch => canonicalize_web_fetch,
        KernelToolKind::GithubSearch => canonicalize_github_search,
        KernelToolKind::GithubRead => canonicalize_github_read,
        KernelToolKind::ArxivSearch => canonicalize_arxiv_search,
        KernelToolKind::ArxivRead => canonicalize_arxiv_read,
        KernelToolKind::ProcessShell => canonicalize_process_shell,
    }
}

fn tool_description(tool: KernelToolKind) -> &'static str {
    match tool {
        KernelToolKind::CodeGrep => {
            "Search workspace text with a bounded literal or regular expression query. Omit path for the workspace root; never pass an empty path."
        }
        KernelToolKind::DocumentRead => "Read bounded text from a workspace PDF document.",
        KernelToolKind::FsCreate => {
            "Create a new workspace file without overwriting an existing target. The parent directory must already exist; call fs.ensure_directory first when needed, and include both mutations in any required Plan manifest."
        }
        KernelToolKind::FsDelete => {
            "Delete one explicitly selected workspace file or directory tree."
        }
        KernelToolKind::FsDiff => {
            "Preview the textual difference for proposed workspace file content."
        }
        KernelToolKind::FsEdit => {
            "Apply one exact, preconditioned edit to an existing workspace file. Match and replacement strings are literal file content; encode JSON line breaks once as \\n. A lineRange digest must be copied in full from fs.read, including its sha256: prefix."
        }
        KernelToolKind::FsEnsureDirectory => {
            "Ensure that an explicitly selected workspace directory exists. This is a distinct workspace mutation and must be listed explicitly in any required Plan manifest."
        }
        KernelToolKind::FsGlob => {
            "Find workspace paths matching a bounded glob pattern. Omit path for the workspace root; never pass an empty path."
        }
        KernelToolKind::FsList => {
            "List a bounded workspace directory tree. Omit path for the workspace root; never pass an empty path."
        }
        KernelToolKind::FsRead => "Read bounded text from a workspace file.",
        KernelToolKind::FsStat => {
            "Inspect the exact existence and type of one workspace-relative path."
        }
        KernelToolKind::FsWrite => "Replace the content of an existing workspace file.",
        KernelToolKind::WebFetch => "Fetch bounded HTTP or HTTPS text.",
        KernelToolKind::WebSearch => {
            "Search the web through the built-in RSS backend or an explicitly configured JSON endpoint."
        }
        KernelToolKind::GithubSearch => {
            "Search GitHub repositories, code, or issues with explicit paging."
        }
        KernelToolKind::GithubRead => {
            "Read repository contents from GitHub by owner/name, path, and optional ref."
        }
        KernelToolKind::ArxivSearch => {
            "Search arXiv metadata with explicit field, paging, and ordering."
        }
        KernelToolKind::ArxivRead => "Read one arXiv paper's canonical metadata and links.",
        KernelToolKind::ProcessShell => {
            "Run one bounded non-interactive /bin/sh command from a canonical workspace-relative directory. PATH includes Host and standard developer-tool directories. Writes are limited to the workspace and Kernel-owned $TMPDIR; HOME is read-only. Point mutable tool state at $TMPDIR or the workspace."
        }
    }
}
