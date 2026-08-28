mod schema;

use self::schema::provider_schema_for_tool;
use crate::invocation_adapter::canonicalize_invocation;
use crate::invocation_types::{KernelCanonicalInvocation, KernelToolKind};
use crate::types::{ToolAvailability, ToolDescriptor, ToolEffectClass, ToolEffectScope};
use serde_json::{json, Value};

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

#[derive(Clone, Copy)]
struct BlockedToolSpec {
    tool_id: &'static str,
    description: &'static str,
    input_schema: fn() -> Value,
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

    let mut registrations = [
        tool(Tool::FsRead, Executor::FsRead, Read, WorkspaceRead),
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
    ]
    .into_iter()
    .map(register_tool)
    .collect::<Vec<_>>();
    registrations.extend([
        register_blocked_tool(BlockedToolSpec {
            tool_id: Tool::WebSearch.as_str(),
            description: tool_description(Tool::WebSearch),
            input_schema: blocked_web_search_schema,
            effect_class: Read,
            effect_scope: NetworkRead,
        }),
        register_blocked_tool(BlockedToolSpec {
            tool_id: Tool::WebFetch.as_str(),
            description: tool_description(Tool::WebFetch),
            input_schema: blocked_web_fetch_schema,
            effect_class: Read,
            effect_scope: NetworkRead,
        }),
        register_blocked_tool(BlockedToolSpec {
            tool_id: "process.shell",
            description: "Run a command through the configured local shell.",
            input_schema: blocked_shell_schema,
            effect_class: Mutation,
            effect_scope: Process,
        }),
    ]);
    registrations
}

fn register_tool(spec: ToolSpec) -> KernelToolRegistration {
    let tool_id = spec.tool.as_str();
    KernelToolRegistration {
        descriptor: ToolDescriptor {
            name: tool_id.to_owned(),
            description: tool_description(spec.tool).to_owned(),
            input_schema: provider_schema_for_tool(spec.tool),
            effect_class: spec.effect_class,
            effect_scope: spec.effect_scope,
            availability: ToolAvailability::Callable,
        },
        executor_binding: Some(spec.executor_binding),
        canonicalize_invocation: Some(canonicalizer_for(spec.tool)),
        tool_id,
    }
}

fn register_blocked_tool(spec: BlockedToolSpec) -> KernelToolRegistration {
    KernelToolRegistration {
        descriptor: ToolDescriptor {
            name: spec.tool_id.to_owned(),
            description: spec.description.to_owned(),
            input_schema: (spec.input_schema)(),
            effect_class: spec.effect_class,
            effect_scope: spec.effect_scope,
            availability: ToolAvailability::Blocked,
        },
        executor_binding: None,
        canonicalize_invocation: None,
        tool_id: spec.tool_id,
    }
}

fn blocked_web_search_schema() -> Value {
    provider_schema_for_tool(KernelToolKind::WebSearch)
}

fn blocked_web_fetch_schema() -> Value {
    provider_schema_for_tool(KernelToolKind::WebFetch)
}

fn blocked_shell_schema() -> Value {
    json!({
        "type": "object",
        "required": ["command"],
        "properties": {
            "command": { "type": "string", "minLength": 1 }
        },
        "additionalProperties": false
    })
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
invocation_canonicalizer!(canonicalize_fs_delete, KernelToolKind::FsDelete);
invocation_canonicalizer!(
    canonicalize_fs_ensure_directory,
    KernelToolKind::FsEnsureDirectory
);
invocation_canonicalizer!(canonicalize_document_read, KernelToolKind::DocumentRead);
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
        KernelToolKind::FsDelete => canonicalize_fs_delete,
        KernelToolKind::FsEnsureDirectory => canonicalize_fs_ensure_directory,
        KernelToolKind::DocumentRead => canonicalize_document_read,
        KernelToolKind::WebSearch => canonicalize_web_search,
        KernelToolKind::WebFetch => canonicalize_web_fetch,
    }
}

fn tool_description(tool: KernelToolKind) -> &'static str {
    match tool {
        KernelToolKind::CodeGrep => {
            "Search workspace text with a bounded literal or regular expression query. Omit path for the workspace root; never pass an empty path."
        }
        KernelToolKind::DocumentRead => "Read bounded text from a workspace PDF document.",
        KernelToolKind::FsCreate => {
            "Create a new workspace file without overwriting an existing target."
        }
        KernelToolKind::FsDelete => {
            "Delete one explicitly selected workspace file or directory tree."
        }
        KernelToolKind::FsDiff => {
            "Preview the textual difference for proposed workspace file content."
        }
        KernelToolKind::FsEdit => "Apply a preconditioned edit to an existing workspace file.",
        KernelToolKind::FsEnsureDirectory => {
            "Ensure that an explicitly selected workspace directory exists."
        }
        KernelToolKind::FsGlob => {
            "Find workspace paths matching a bounded glob pattern. Omit path for the workspace root; never pass an empty path."
        }
        KernelToolKind::FsList => {
            "List a bounded workspace directory tree. Omit path for the workspace root; never pass an empty path."
        }
        KernelToolKind::FsRead => "Read bounded text from a workspace file.",
        KernelToolKind::FsWrite => "Replace the content of an existing workspace file.",
        KernelToolKind::WebFetch => "Fetch bounded HTTP or HTTPS text.",
        KernelToolKind::WebSearch => "Search the web through the configured endpoint.",
    }
}
