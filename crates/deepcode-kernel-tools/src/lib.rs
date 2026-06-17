use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

pub const TOOL_REGISTRY_VERSION: &str = "deepcode.kernel.tools.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl ToolRiskLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolPermissionMode {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OperationExecutionMode {
    Execute,
    PreviewOnly,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolFamily {
    Workspace,
    Git,
    Process,
    Network,
    Browser,
    Provider,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolDescriptor {
    pub tool_id: &'static str,
    pub capability: &'static str,
    pub family: ToolFamily,
    pub risk: ToolRiskLevel,
    pub permission_mode: ToolPermissionMode,
    pub executor_ref: &'static str,
    pub execution_mode: OperationExecutionMode,
    #[serde(default)]
    pub needs_workspace: bool,
    #[serde(default)]
    pub read_only: bool,
}

#[derive(Debug, Clone)]
pub struct KernelToolRegistry {
    descriptors: BTreeMap<&'static str, KernelToolDescriptor>,
}

impl Default for KernelToolRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl KernelToolRegistry {
    pub fn new() -> Self {
        let mut descriptors = BTreeMap::new();
        for descriptor in builtin_tool_descriptors() {
            descriptors.insert(descriptor.tool_id, descriptor);
        }
        Self { descriptors }
    }

    pub fn get(&self, tool_id: &str) -> Option<&KernelToolDescriptor> {
        self.descriptors.get(tool_id)
    }

    pub fn all(&self) -> impl Iterator<Item = &KernelToolDescriptor> {
        self.descriptors.values()
    }

    pub fn capability_for_tool(&self, tool_id: &str) -> &'static str {
        self.get(tool_id)
            .map(|descriptor| descriptor.capability)
            .unwrap_or("unknown")
    }

    pub fn risk_for_tool(&self, tool_id: &str) -> &'static str {
        self.get(tool_id)
            .map(|descriptor| descriptor.risk.as_str())
            .unwrap_or("low")
    }

    pub fn permission_mode_for_tool(&self, tool_id: &str) -> ToolPermissionMode {
        self.get(tool_id)
            .map(|descriptor| descriptor.permission_mode)
            .unwrap_or(ToolPermissionMode::Deny)
    }

    pub fn needs_workspace(&self, tool_id: &str) -> bool {
        self.get(tool_id)
            .map(|descriptor| descriptor.needs_workspace)
            .unwrap_or(false)
    }

    pub fn tool_for_workspace_kind(&self, kind: WorkspaceOperationKind) -> Option<&'static str> {
        Some(match kind {
            WorkspaceOperationKind::Read => "fs.read",
            WorkspaceOperationKind::List => "fs.list",
            WorkspaceOperationKind::Search => "code.search",
            WorkspaceOperationKind::Diff => "fs.diff",
            WorkspaceOperationKind::Write | WorkspaceOperationKind::Create => "fs.write",
            WorkspaceOperationKind::Patch => "fs.patch",
            WorkspaceOperationKind::Delete => "fs.delete",
            WorkspaceOperationKind::Rename => return None,
        })
    }

    pub fn tool_for_git_kind(&self, kind: GitOperationKind) -> Option<&'static str> {
        Some(match kind {
            GitOperationKind::Status => "git.status",
            GitOperationKind::Diff => "git.diff",
            GitOperationKind::Stage => "git.stage",
            GitOperationKind::Unstage => "git.unstage",
            GitOperationKind::Commit => "git.commit",
            GitOperationKind::Push => "git.push",
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOperation {
    pub id: String,
    pub title: String,
    pub capability: String,
    pub permission_labels: Vec<String>,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: OperationExecutionMode,
    pub operation: PlannedOperationKind,
}

impl PlannedOperation {
    pub fn tool_id(&self, registry: &KernelToolRegistry) -> Option<&'static str> {
        match &self.operation {
            PlannedOperationKind::Workspace(operation) => {
                registry.tool_for_workspace_kind(operation.kind)
            }
            PlannedOperationKind::Git(operation) => registry.tool_for_git_kind(operation.kind),
            PlannedOperationKind::Process(_) => Some("shell.exec"),
            PlannedOperationKind::Network(operation) => match operation.kind {
                NetworkOperationKind::Search => Some("web.search"),
                NetworkOperationKind::Fetch => Some("web.fetch"),
            },
            PlannedOperationKind::Browser(operation) => match operation.kind {
                BrowserOperationKind::Open => Some("browser.open"),
                BrowserOperationKind::Reload => Some("browser.reload"),
                BrowserOperationKind::Snapshot => Some("browser.snapshot"),
                BrowserOperationKind::Inspect => Some("browser.inspect"),
                BrowserOperationKind::Click => Some("browser.click"),
                BrowserOperationKind::Type => Some("browser.type"),
                BrowserOperationKind::Scroll => Some("browser.scroll"),
            },
            PlannedOperationKind::Provider(_) => Some("provider.call"),
        }
    }

    pub fn is_write_like(&self) -> bool {
        !self.write_set.is_empty()
            || matches!(
                self.operation,
                PlannedOperationKind::Workspace(WorkspaceOperation {
                    kind: WorkspaceOperationKind::Write
                        | WorkspaceOperationKind::Create
                        | WorkspaceOperationKind::Patch
                        | WorkspaceOperationKind::Delete
                        | WorkspaceOperationKind::Rename,
                    ..
                }) | PlannedOperationKind::Git(GitOperation {
                    kind: GitOperationKind::Stage
                        | GitOperationKind::Unstage
                        | GitOperationKind::Commit
                        | GitOperationKind::Push,
                    ..
                }) | PlannedOperationKind::Process(_)
                    | PlannedOperationKind::Network(_)
                    | PlannedOperationKind::Browser(_)
                    | PlannedOperationKind::Provider(_)
            )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "family", rename_all = "camelCase")]
pub enum PlannedOperationKind {
    Workspace(WorkspaceOperation),
    Git(GitOperation),
    Process(ProcessOperation),
    Network(NetworkOperation),
    Browser(BrowserOperation),
    Provider(ProviderOperation),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceOperationKind {
    Read,
    List,
    Search,
    Diff,
    Write,
    Create,
    Patch,
    Delete,
    Rename,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperation {
    pub kind: WorkspaceOperationKind,
    pub target_path: Option<String>,
    pub source_block_id: Option<String>,
    #[serde(default)]
    pub replacement_block_id: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub patch_spec: Option<Value>,
    #[serde(default)]
    pub allow_empty_content: bool,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub rename_to: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitOperationKind {
    Status,
    Diff,
    Stage,
    Unstage,
    Commit,
    Push,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitOperation {
    pub kind: GitOperationKind,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub staged: bool,
    #[serde(default)]
    pub remote: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessOperation {
    pub cwd: Option<String>,
    pub argv: Vec<String>,
    pub timeout_ms: Option<u64>,
    pub env_policy: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NetworkOperationKind {
    Search,
    Fetch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkOperation {
    pub kind: NetworkOperationKind,
    pub url: Option<String>,
    pub query: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserOperationKind {
    Open,
    Reload,
    Snapshot,
    Inspect,
    Click,
    Type,
    Scroll,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserOperation {
    pub kind: BrowserOperationKind,
    pub target: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOperation {
    pub profile: Option<String>,
    pub budget_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeBlock {
    pub id: String,
    pub target_path: Option<String>,
    pub language: Option<String>,
    pub operation: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub allow_empty_content: bool,
    #[serde(default)]
    pub permission_labels: Vec<String>,
}

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum OperationCompileError {
    #[error("action bundle has no actions")]
    EmptyActions,
    #[error("action {action_id} is missing capability")]
    MissingCapability { action_id: String },
    #[error("workspace.write action {action_id} requires sourceBlockId")]
    MissingSourceBlock { action_id: String },
    #[error("codeBlock {source_block_id} was not provided for action {action_id}")]
    MissingCodeBlock {
        action_id: String,
        source_block_id: String,
    },
    #[error("codeBlock {source_block_id} has no content")]
    MissingCodeContent { source_block_id: String },
    #[error("codeBlock {source_block_id} has empty content; use allowEmptyContent with a createEmpty or patch operation to make that explicit")]
    EmptyCodeContent { source_block_id: String },
    #[error("workspace action {action_id} requires target path")]
    MissingTargetPath { action_id: String },
    #[error("workspace.search action {action_id} requires query")]
    MissingSearchQuery { action_id: String },
    #[error("unsupported capability {capability}")]
    UnsupportedCapability { capability: String },
    #[error("unsupported operation kind {kind} for capability {capability}")]
    UnsupportedKind { capability: String, kind: String },
}

pub struct OperationCompiler {
    registry: KernelToolRegistry,
}

impl Default for OperationCompiler {
    fn default() -> Self {
        Self::new(KernelToolRegistry::default())
    }
}

impl OperationCompiler {
    pub fn new(registry: KernelToolRegistry) -> Self {
        Self { registry }
    }

    pub fn registry(&self) -> &KernelToolRegistry {
        &self.registry
    }

    pub fn action_bundle_value<'a>(&self, batch: &'a Value) -> Option<&'a Value> {
        batch.get("actionBundle").or_else(|| {
            if batch.get("actions").is_some() {
                Some(batch)
            } else {
                None
            }
        })
    }

    pub fn collect_code_blocks(&self, batch: &Value) -> BTreeMap<String, CodeBlock> {
        let direct = batch.get("codeBlocks");
        let nested = self
            .action_bundle_value(batch)
            .and_then(|bundle| bundle.get("codeBlocks"));
        direct
            .or(nested)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(parse_code_block)
            .map(|block| (block.id.clone(), block))
            .collect()
    }

    pub fn compile_batch(
        &self,
        batch: &Value,
    ) -> Result<Vec<PlannedOperation>, OperationCompileError> {
        let action_bundle = self.action_bundle_value(batch);
        let actions = action_bundle
            .and_then(|bundle| bundle.get("actions"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if actions.is_empty() {
            return Err(OperationCompileError::EmptyActions);
        }
        let code_blocks = self.collect_code_blocks(batch);
        actions
            .iter()
            .enumerate()
            .map(|(index, action)| self.compile_action(action, &code_blocks, index))
            .collect()
    }

    pub fn compile_action(
        &self,
        action: &Value,
        code_blocks: &BTreeMap<String, CodeBlock>,
        index: usize,
    ) -> Result<PlannedOperation, OperationCompileError> {
        let id =
            get_string(action, &["id", "actionId"]).unwrap_or_else(|| format!("action-{index}"));
        let capability = get_string(action, &["capability"]).ok_or_else(|| {
            OperationCompileError::MissingCapability {
                action_id: id.clone(),
            }
        })?;
        let title = get_string(action, &["title", "description"]).unwrap_or_else(|| id.clone());
        let permission_labels = action
            .get("permissionLabels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        match capability.as_str() {
            capability if capability.starts_with("workspace.") => self.compile_workspace_action(
                action,
                code_blocks,
                id,
                title,
                capability,
                permission_labels,
            ),
            "git.read" | "git.write" | "git.push" => {
                self.compile_git_action(action, id, title, &capability, permission_labels)
            }
            "process.exec" => Ok(external_process_operation(
                action,
                id,
                title,
                capability,
                permission_labels,
            )),
            "network.egress" => Ok(external_network_operation(
                action,
                id,
                title,
                capability,
                permission_labels,
            )),
            "browser.control" => Ok(external_browser_operation(
                action,
                id,
                title,
                capability,
                permission_labels,
            )),
            "provider.egress" => Ok(external_provider_operation(
                action,
                id,
                title,
                capability,
                permission_labels,
            )),
            _ => Err(OperationCompileError::UnsupportedCapability { capability }),
        }
    }

    fn compile_workspace_action(
        &self,
        action: &Value,
        code_blocks: &BTreeMap<String, CodeBlock>,
        id: String,
        title: String,
        capability: &str,
        permission_labels: Vec<String>,
    ) -> Result<PlannedOperation, OperationCompileError> {
        let kind = workspace_kind_for_action(action, capability)?;
        let mut target_path = get_string(action, &["targetPath", "path"]);
        let mut source_block_id = get_string(action, &["sourceBlockId"]);
        let mut replacement_block_id = get_string(action, &["replacementBlockId"]);
        let mut content = None;

        if matches!(
            kind,
            WorkspaceOperationKind::Write
                | WorkspaceOperationKind::Create
                | WorkspaceOperationKind::Patch
        ) {
            let block_id = if kind == WorkspaceOperationKind::Patch {
                replacement_block_id
                    .clone()
                    .or_else(|| source_block_id.clone())
            } else {
                source_block_id.clone()
            }
            .ok_or_else(|| OperationCompileError::MissingSourceBlock {
                action_id: id.clone(),
            })?;
            let block = code_blocks.get(&block_id).ok_or_else(|| {
                OperationCompileError::MissingCodeBlock {
                    action_id: id.clone(),
                    source_block_id: block_id.clone(),
                }
            })?;
            let block_content =
                block
                    .content
                    .clone()
                    .ok_or_else(|| OperationCompileError::MissingCodeContent {
                        source_block_id: block_id.clone(),
                    })?;
            if block_content.is_empty() && !block_allows_empty_content(block) {
                return Err(OperationCompileError::EmptyCodeContent {
                    source_block_id: block_id.clone(),
                });
            }
            content = Some(block_content);
            target_path = target_path.or_else(|| block.target_path.clone());
            if kind == WorkspaceOperationKind::Patch {
                replacement_block_id = Some(block_id.clone());
                source_block_id = source_block_id.or_else(|| Some(block_id));
            } else {
                source_block_id = Some(block_id);
            }
        }

        let query = get_string(action, &["query"]);
        if kind == WorkspaceOperationKind::Search && query.is_none() {
            let scoped = first_resource_scope(action);
            if scoped.is_none() {
                return Err(OperationCompileError::MissingSearchQuery {
                    action_id: id.clone(),
                });
            }
        }
        target_path = target_path.or_else(|| first_resource_scope(action));
        if matches!(
            kind,
            WorkspaceOperationKind::Read
                | WorkspaceOperationKind::List
                | WorkspaceOperationKind::Diff
                | WorkspaceOperationKind::Delete
                | WorkspaceOperationKind::Rename
        ) && target_path.is_none()
        {
            target_path = Some(".".to_string());
        }

        let mut read_set = Vec::new();
        let mut write_set = Vec::new();
        match kind {
            WorkspaceOperationKind::Read
            | WorkspaceOperationKind::List
            | WorkspaceOperationKind::Search
            | WorkspaceOperationKind::Diff => {
                read_set.push(
                    target_path
                        .clone()
                        .or_else(|| query.clone())
                        .unwrap_or_else(|| ".".to_string()),
                );
            }
            WorkspaceOperationKind::Write
            | WorkspaceOperationKind::Create
            | WorkspaceOperationKind::Patch
            | WorkspaceOperationKind::Delete
            | WorkspaceOperationKind::Rename => {
                let path = target_path.clone().ok_or_else(|| {
                    OperationCompileError::MissingTargetPath {
                        action_id: id.clone(),
                    }
                })?;
                write_set.push(path);
            }
        }
        let conflict_keys = conflict_keys_for_action(action, &read_set, &write_set);
        let execution_mode = operation_execution_mode(&self.registry, capability, kind);

        Ok(PlannedOperation {
            id,
            title,
            capability: capability.to_string(),
            permission_labels,
            read_set,
            write_set,
            conflict_keys,
            execution_mode,
            operation: PlannedOperationKind::Workspace(WorkspaceOperation {
                kind,
                target_path,
                source_block_id,
                replacement_block_id,
                content,
                patch_spec: action.get("patchSpec").cloned(),
                allow_empty_content: action
                    .get("allowEmptyContent")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                query,
                rename_to: get_string(action, &["renameTo", "toPath", "newPath"]),
            }),
        })
    }

    fn compile_git_action(
        &self,
        action: &Value,
        id: String,
        title: String,
        capability: &str,
        permission_labels: Vec<String>,
    ) -> Result<PlannedOperation, OperationCompileError> {
        let kind = git_kind_for_action(action, capability)?;
        let args = action.get("toolArgs").and_then(Value::as_object);
        let mut paths = get_string_array(action, "paths")
            .or_else(|| {
                args.and_then(|object| object.get("paths"))
                    .and_then(Value::as_array)
                    .map(|items| strings_from_array(items))
            })
            .unwrap_or_default();
        if paths.is_empty() {
            if let Some(path) = args
                .and_then(|object| object.get("path"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| get_string(action, &["path", "targetPath"]))
            {
                paths.push(path);
            }
        }
        let staged = args
            .and_then(|object| object.get("staged"))
            .or_else(|| action.get("staged"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let message = args
            .and_then(|object| object.get("message"))
            .or_else(|| action.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let remote = args
            .and_then(|object| object.get("remote"))
            .or_else(|| action.get("remote"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let branch = args
            .and_then(|object| object.get("branch"))
            .or_else(|| action.get("branch"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let read_set = if matches!(kind, GitOperationKind::Status | GitOperationKind::Diff) {
            if paths.is_empty() {
                vec!["git:workspace".to_string()]
            } else {
                paths.iter().map(|path| format!("git:{path}")).collect()
            }
        } else {
            Vec::new()
        };
        let write_set = if matches!(
            kind,
            GitOperationKind::Stage
                | GitOperationKind::Unstage
                | GitOperationKind::Commit
                | GitOperationKind::Push
        ) {
            if paths.is_empty() {
                vec!["git:index".to_string()]
            } else {
                paths.iter().map(|path| format!("git:{path}")).collect()
            }
        } else {
            Vec::new()
        };
        let conflict_keys = conflict_keys_for_action(action, &read_set, &write_set);
        let execution_mode = self
            .registry
            .tool_for_git_kind(kind)
            .and_then(|tool_id| self.registry.get(tool_id))
            .map(|descriptor| descriptor.execution_mode)
            .unwrap_or(OperationExecutionMode::Blocked);
        Ok(PlannedOperation {
            id,
            title,
            capability: capability.to_string(),
            permission_labels,
            read_set,
            write_set,
            conflict_keys,
            execution_mode,
            operation: PlannedOperationKind::Git(GitOperation {
                kind,
                paths,
                message,
                staged,
                remote,
                branch,
            }),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitGraph {
    pub nodes: Vec<WorkUnitGraphNode>,
    pub edges: Vec<WorkUnitGraphEdge>,
    pub concurrency_groups: Vec<WorkUnitConcurrencyGroup>,
}

impl WorkUnitGraph {
    pub fn from_operations(operations: &[PlannedOperation]) -> Self {
        let mut nodes = Vec::new();
        let mut edges = Vec::new();
        let mut last_writer_by_key = BTreeMap::<String, String>::new();
        for operation in operations {
            let node_id = operation.id.clone();
            for key in operation.read_set.iter().chain(operation.write_set.iter()) {
                if let Some(writer) = last_writer_by_key.get(key) {
                    edges.push(WorkUnitGraphEdge {
                        from: writer.clone(),
                        to: node_id.clone(),
                        reason: format!("conflict:{key}"),
                    });
                }
            }
            if operation.is_write_like() {
                for key in operation
                    .conflict_keys
                    .iter()
                    .chain(operation.write_set.iter())
                {
                    last_writer_by_key.insert(key.clone(), node_id.clone());
                }
            }
            nodes.push(WorkUnitGraphNode {
                id: node_id,
                operation_id: operation.id.clone(),
                can_run_concurrently: !operation.is_write_like(),
                read_set: operation.read_set.clone(),
                write_set: operation.write_set.clone(),
                conflict_keys: operation.conflict_keys.clone(),
            });
        }

        let mut read_validation = Vec::new();
        let mut serial_mutation = Vec::new();
        for node in &nodes {
            if node.can_run_concurrently {
                read_validation.push(node.id.clone());
            } else {
                serial_mutation.push(node.id.clone());
            }
        }
        let mut concurrency_groups = Vec::new();
        if !read_validation.is_empty() {
            concurrency_groups.push(WorkUnitConcurrencyGroup {
                id: "read-validation".to_string(),
                mode: "parallel".to_string(),
                node_ids: read_validation,
            });
        }
        if !serial_mutation.is_empty() {
            concurrency_groups.push(WorkUnitConcurrencyGroup {
                id: "mutation-serial".to_string(),
                mode: "serial".to_string(),
                node_ids: serial_mutation,
            });
        }
        Self {
            nodes,
            edges,
            concurrency_groups,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitGraphNode {
    pub id: String,
    pub operation_id: String,
    pub can_run_concurrently: bool,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitGraphEdge {
    pub from: String,
    pub to: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitConcurrencyGroup {
    pub id: String,
    pub mode: String,
    pub node_ids: Vec<String>,
}

fn builtin_tool_descriptors() -> Vec<KernelToolDescriptor> {
    vec![
        workspace_tool(
            "fs.read",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.list",
            "workspace.read",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.diff",
            "workspace.preview_diff",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "code.search",
            "workspace.search",
            ToolRiskLevel::Low,
            ToolPermissionMode::Allow,
            true,
            true,
        ),
        workspace_tool(
            "fs.write",
            "workspace.write",
            ToolRiskLevel::Medium,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.patch",
            "workspace.write",
            ToolRiskLevel::Medium,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        workspace_tool(
            "fs.delete",
            "workspace.delete",
            ToolRiskLevel::High,
            ToolPermissionMode::Ask,
            true,
            false,
        ),
        KernelToolDescriptor {
            tool_id: "git.status",
            capability: "git.read",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::Low,
            permission_mode: ToolPermissionMode::Allow,
            executor_ref: "kernel.skill.git.status",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "git.diff",
            capability: "git.read",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::Low,
            permission_mode: ToolPermissionMode::Allow,
            executor_ref: "kernel.skill.git.diff",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "git.stage",
            capability: "git.write",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.git.stage",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "git.unstage",
            capability: "git.write",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.git.unstage",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "git.commit",
            capability: "git.write",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.git.commit",
            execution_mode: OperationExecutionMode::Execute,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "git.push",
            capability: "git.push",
            family: ToolFamily::Git,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.git.push",
            execution_mode: OperationExecutionMode::PreviewOnly,
            needs_workspace: true,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "shell.propose",
            capability: "process.propose",
            family: ToolFamily::Process,
            risk: ToolRiskLevel::Low,
            permission_mode: ToolPermissionMode::Allow,
            executor_ref: "kernel.skill.shell.propose",
            execution_mode: OperationExecutionMode::PreviewOnly,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "shell.exec",
            capability: "process.exec",
            family: ToolFamily::Process,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.shell.exec",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "web.search",
            capability: "network.egress",
            family: ToolFamily::Network,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.web.search",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "web.fetch",
            capability: "network.egress",
            family: ToolFamily::Network,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.web.fetch",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "browser.open",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.open",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.reload",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.reload",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.snapshot",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.snapshot",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "browser.inspect",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.inspect",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
        KernelToolDescriptor {
            tool_id: "browser.click",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.click",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.type",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.type",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "browser.scroll",
            capability: "browser.control",
            family: ToolFamily::Browser,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "kernel.skill.browser.scroll",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: false,
        },
        KernelToolDescriptor {
            tool_id: "provider.call",
            capability: "provider.egress",
            family: ToolFamily::Provider,
            risk: ToolRiskLevel::High,
            permission_mode: ToolPermissionMode::Ask,
            executor_ref: "daemon.provider.transport",
            execution_mode: OperationExecutionMode::Blocked,
            needs_workspace: false,
            read_only: true,
        },
    ]
}

fn workspace_tool(
    tool_id: &'static str,
    capability: &'static str,
    risk: ToolRiskLevel,
    permission_mode: ToolPermissionMode,
    needs_workspace: bool,
    read_only: bool,
) -> KernelToolDescriptor {
    KernelToolDescriptor {
        tool_id,
        capability,
        family: ToolFamily::Workspace,
        risk,
        permission_mode,
        executor_ref: "kernel.skill.workspace",
        execution_mode: OperationExecutionMode::Execute,
        needs_workspace,
        read_only,
    }
}

fn parse_code_block(value: &Value) -> Option<CodeBlock> {
    let id = get_string(value, &["id", "blockId"])?;
    Some(CodeBlock {
        id,
        target_path: get_string(value, &["path", "targetPath"]),
        language: get_string(value, &["language"]),
        operation: get_string(value, &["operation"]),
        content: value
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_string),
        allow_empty_content: value
            .get("allowEmptyContent")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        permission_labels: value
            .get("permissionLabels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
    })
}

fn get_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_resource_scope(value: &Value) -> Option<String> {
    value
        .get("resourceScope")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn get_string_array(value: &Value, key: &str) -> Option<Vec<String>> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| strings_from_array(items))
}

fn strings_from_array(items: &[Value]) -> Vec<String> {
    items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn workspace_kind_for_action(
    action: &Value,
    capability: &str,
) -> Result<WorkspaceOperationKind, OperationCompileError> {
    let raw = get_string(action, &["kind"]).unwrap_or_else(|| match capability {
        "workspace.read" => "read".to_string(),
        "workspace.list" => "list".to_string(),
        "workspace.search" => "search".to_string(),
        "workspace.diff" | "workspace.preview_diff" => "diff".to_string(),
        "workspace.write" => "write".to_string(),
        "workspace.create" => "create".to_string(),
        "workspace.delete" => "delete".to_string(),
        "workspace.rename" => "rename".to_string(),
        _ => "write".to_string(),
    });
    match raw.as_str() {
        "read" => Ok(WorkspaceOperationKind::Read),
        "list" => Ok(WorkspaceOperationKind::List),
        "search" => Ok(WorkspaceOperationKind::Search),
        "diff" | "previewDiff" | "preview_diff" => Ok(WorkspaceOperationKind::Diff),
        "write" => Ok(WorkspaceOperationKind::Write),
        "create" => Ok(WorkspaceOperationKind::Create),
        "patch" | "replaceBlock" | "insertBefore" | "insertAfter" => {
            Ok(WorkspaceOperationKind::Patch)
        }
        "delete" => Ok(WorkspaceOperationKind::Delete),
        "rename" => Ok(WorkspaceOperationKind::Rename),
        kind => Err(OperationCompileError::UnsupportedKind {
            capability: capability.to_string(),
            kind: kind.to_string(),
        }),
    }
}

fn block_allows_empty_content(block: &CodeBlock) -> bool {
    block.allow_empty_content
        && matches!(
            block.operation.as_deref(),
            Some("createEmpty" | "patch" | "replaceBlock" | "insertBefore" | "insertAfter")
        )
}

fn git_kind_for_action(
    action: &Value,
    capability: &str,
) -> Result<GitOperationKind, OperationCompileError> {
    let raw = get_string(action, &["kind"]).unwrap_or_else(|| match capability {
        "git.read" => "status".to_string(),
        "git.push" => "push".to_string(),
        _ => "stage".to_string(),
    });
    match raw.as_str() {
        "status" | "read" => Ok(GitOperationKind::Status),
        "diff" => Ok(GitOperationKind::Diff),
        "stage" => Ok(GitOperationKind::Stage),
        "unstage" => Ok(GitOperationKind::Unstage),
        "commit" => Ok(GitOperationKind::Commit),
        "push" => Ok(GitOperationKind::Push),
        kind => Err(OperationCompileError::UnsupportedKind {
            capability: capability.to_string(),
            kind: kind.to_string(),
        }),
    }
}

fn operation_execution_mode(
    registry: &KernelToolRegistry,
    capability: &str,
    kind: WorkspaceOperationKind,
) -> OperationExecutionMode {
    registry
        .tool_for_workspace_kind(kind)
        .and_then(|tool_id| registry.get(tool_id))
        .map(|descriptor| descriptor.execution_mode)
        .unwrap_or_else(|| {
            if capability.starts_with("workspace.") {
                OperationExecutionMode::Blocked
            } else {
                OperationExecutionMode::PreviewOnly
            }
        })
}

fn conflict_keys_for_action(
    action: &Value,
    read_set: &[String],
    write_set: &[String],
) -> Vec<String> {
    let explicit = action
        .get("conflictKeys")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if !explicit.is_empty() {
        return explicit;
    }
    let mut keys = BTreeSet::new();
    for key in write_set.iter().chain(read_set.iter()) {
        keys.insert(key.clone());
    }
    keys.into_iter().collect()
}

fn external_process_operation(
    action: &Value,
    id: String,
    title: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let argv = action
        .get("argv")
        .and_then(Value::as_array)
        .map(|items| strings_from_array(items))
        .unwrap_or_default();
    PlannedOperation {
        id,
        title,
        capability,
        permission_labels,
        read_set: Vec::new(),
        write_set: vec!["process".to_string()],
        conflict_keys: vec!["process".to_string()],
        execution_mode: OperationExecutionMode::Blocked,
        operation: PlannedOperationKind::Process(ProcessOperation {
            cwd: get_string(action, &["cwd"]),
            argv,
            timeout_ms: action.get("timeoutMs").and_then(Value::as_u64),
            env_policy: get_string(action, &["envPolicy"]),
        }),
    }
}

fn external_network_operation(
    action: &Value,
    id: String,
    title: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let kind = if get_string(action, &["url"]).is_some() {
        NetworkOperationKind::Fetch
    } else {
        NetworkOperationKind::Search
    };
    PlannedOperation {
        id,
        title,
        capability,
        permission_labels,
        read_set: Vec::new(),
        write_set: vec!["network.egress".to_string()],
        conflict_keys: vec!["network.egress".to_string()],
        execution_mode: OperationExecutionMode::Blocked,
        operation: PlannedOperationKind::Network(NetworkOperation {
            kind,
            url: get_string(action, &["url"]),
            query: get_string(action, &["query"]),
        }),
    }
}

fn external_browser_operation(
    action: &Value,
    id: String,
    title: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    let kind = match get_string(action, &["kind"]).as_deref() {
        Some("reload") => BrowserOperationKind::Reload,
        Some("snapshot") => BrowserOperationKind::Snapshot,
        Some("inspect") => BrowserOperationKind::Inspect,
        Some("click") => BrowserOperationKind::Click,
        Some("type") => BrowserOperationKind::Type,
        Some("scroll") => BrowserOperationKind::Scroll,
        _ => BrowserOperationKind::Open,
    };
    PlannedOperation {
        id,
        title,
        capability,
        permission_labels,
        read_set: Vec::new(),
        write_set: vec!["browser.control".to_string()],
        conflict_keys: vec!["browser.control".to_string()],
        execution_mode: OperationExecutionMode::Blocked,
        operation: PlannedOperationKind::Browser(BrowserOperation {
            kind,
            target: get_string(action, &["target", "url", "selector"]),
            value: get_string(action, &["value", "text"]),
        }),
    }
}

fn external_provider_operation(
    action: &Value,
    id: String,
    title: String,
    capability: String,
    permission_labels: Vec<String>,
) -> PlannedOperation {
    PlannedOperation {
        id,
        title,
        capability,
        permission_labels,
        read_set: Vec::new(),
        write_set: vec!["provider.egress".to_string()],
        conflict_keys: vec!["provider.egress".to_string()],
        execution_mode: OperationExecutionMode::Blocked,
        operation: PlannedOperationKind::Provider(ProviderOperation {
            profile: get_string(action, &["profile", "profileRef"]),
            budget_ref: get_string(action, &["budgetRef"]),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_covers_core_tool_families() {
        let registry = KernelToolRegistry::default();
        assert_eq!(registry.capability_for_tool("fs.write"), "workspace.write");
        assert_eq!(registry.capability_for_tool("fs.patch"), "workspace.write");
        assert_eq!(registry.capability_for_tool("git.status"), "git.read");
        assert_eq!(registry.capability_for_tool("shell.exec"), "process.exec");
        assert_eq!(registry.capability_for_tool("web.fetch"), "network.egress");
        assert_eq!(
            registry.capability_for_tool("browser.click"),
            "browser.control"
        );
        assert_eq!(
            registry.capability_for_tool("provider.call"),
            "provider.egress"
        );
    }

    #[test]
    fn compiler_requires_write_source_block() {
        let compiler = OperationCompiler::default();
        let batch = serde_json::json!({
            "actions": [{
                "id": "write-1",
                "capability": "workspace.write",
                "targetPath": "src/lib.rs"
            }]
        });
        assert!(matches!(
            compiler.compile_batch(&batch),
            Err(OperationCompileError::MissingSourceBlock { .. })
        ));
    }

    #[test]
    fn compiler_builds_workspace_write_operation() {
        let compiler = OperationCompiler::default();
        let batch = serde_json::json!({
            "actions": [{
                "id": "write-1",
                "title": "Write file",
                "capability": "workspace.write",
                "targetPath": "src/lib.rs",
                "sourceBlockId": "block-1"
            }],
            "codeBlocks": [{
                "blockId": "block-1",
                "targetPath": "src/lib.rs",
                "content": "fn main() {}"
            }]
        });
        let operations = compiler.compile_batch(&batch).unwrap();
        assert_eq!(operations.len(), 1);
        assert_eq!(operations[0].write_set, vec!["src/lib.rs"]);
        assert!(matches!(
            operations[0].operation,
            PlannedOperationKind::Workspace(WorkspaceOperation {
                kind: WorkspaceOperationKind::Write,
                ..
            })
        ));
    }

    #[test]
    fn compiler_rejects_empty_write_content_by_default() {
        let compiler = OperationCompiler::default();
        let batch = serde_json::json!({
            "actions": [{
                "id": "write-1",
                "title": "Write file",
                "capability": "workspace.write",
                "targetPath": "src/lib.rs",
                "sourceBlockId": "block-1"
            }],
            "codeBlocks": [{
                "blockId": "block-1",
                "targetPath": "src/lib.rs",
                "content": ""
            }]
        });
        assert!(matches!(
            compiler.compile_batch(&batch),
            Err(OperationCompileError::EmptyCodeContent { .. })
        ));
    }

    #[test]
    fn compiler_builds_workspace_patch_operation() {
        let compiler = OperationCompiler::default();
        let batch = serde_json::json!({
            "actions": [{
                "id": "patch-1",
                "title": "Patch file",
                "kind": "replaceBlock",
                "capability": "workspace.write",
                "targetPath": "src/lib.rs",
                "replacementBlockId": "block-1",
                "patchSpec": {
                    "match": { "kind": "exactBlock", "text": "old()" }
                }
            }],
            "codeBlocks": [{
                "blockId": "block-1",
                "targetPath": "src/lib.rs",
                "operation": "replaceBlock",
                "content": "new()"
            }]
        });
        let operations = compiler.compile_batch(&batch).unwrap();
        assert!(matches!(
            operations[0].operation,
            PlannedOperationKind::Workspace(WorkspaceOperation {
                kind: WorkspaceOperationKind::Patch,
                ..
            })
        ));
    }

    #[test]
    fn graph_groups_reads_and_serial_writes() {
        let operations = vec![
            PlannedOperation {
                id: "read".to_string(),
                title: "Read".to_string(),
                capability: "workspace.read".to_string(),
                permission_labels: Vec::new(),
                read_set: vec!["src/lib.rs".to_string()],
                write_set: Vec::new(),
                conflict_keys: vec!["src/lib.rs".to_string()],
                execution_mode: OperationExecutionMode::Execute,
                operation: PlannedOperationKind::Workspace(WorkspaceOperation {
                    kind: WorkspaceOperationKind::Read,
                    target_path: Some("src/lib.rs".to_string()),
                    source_block_id: None,
                    replacement_block_id: None,
                    content: None,
                    patch_spec: None,
                    allow_empty_content: false,
                    query: None,
                    rename_to: None,
                }),
            },
            PlannedOperation {
                id: "write".to_string(),
                title: "Write".to_string(),
                capability: "workspace.write".to_string(),
                permission_labels: Vec::new(),
                read_set: Vec::new(),
                write_set: vec!["src/lib.rs".to_string()],
                conflict_keys: vec!["src/lib.rs".to_string()],
                execution_mode: OperationExecutionMode::Execute,
                operation: PlannedOperationKind::Workspace(WorkspaceOperation {
                    kind: WorkspaceOperationKind::Write,
                    target_path: Some("src/lib.rs".to_string()),
                    source_block_id: Some("block".to_string()),
                    replacement_block_id: None,
                    content: Some("x".to_string()),
                    patch_spec: None,
                    allow_empty_content: false,
                    query: None,
                    rename_to: None,
                }),
            },
        ];
        let graph = WorkUnitGraph::from_operations(&operations);
        assert_eq!(graph.concurrency_groups[0].mode, "parallel");
        assert_eq!(graph.concurrency_groups[1].mode, "serial");
    }
}
