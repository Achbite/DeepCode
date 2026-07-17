use crate::{FileTargetRef, OperationExecutionMode, ToolOperationKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedOperation {
    pub id: String,
    pub title: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    #[serde(default)]
    pub depends_on: Vec<String>,
    pub capability: String,
    pub permission_labels: Vec<String>,
    #[serde(default)]
    pub target_ref: Option<FileTargetRef>,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: OperationExecutionMode,
    pub operation: PlannedOperationKind,
}

impl PlannedOperation {
    pub fn is_write_like(&self) -> bool {
        if !self.write_set.is_empty() {
            return true;
        }
        match &self.operation {
            PlannedOperationKind::Workspace(operation) => matches!(
                operation.kind,
                WorkspaceOperationKind::Write
                    | WorkspaceOperationKind::Create
                    | WorkspaceOperationKind::Patch
                    | WorkspaceOperationKind::Delete
                    | WorkspaceOperationKind::Rename
            ),
            PlannedOperationKind::Git(operation) => matches!(
                operation.kind,
                GitOperationKind::Stage
                    | GitOperationKind::Unstage
                    | GitOperationKind::Commit
                    | GitOperationKind::Push
            ),
            PlannedOperationKind::Process(_)
            | PlannedOperationKind::Network(_)
            | PlannedOperationKind::Browser(_)
            | PlannedOperationKind::Provider(_) => true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "family", rename_all = "camelCase")]
pub enum PlannedOperationKind {
    Workspace(Box<WorkspaceOperation>),
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
    Glob,
    Search,
    Diff,
    Write,
    Create,
    Patch,
    Delete,
    Rename,
    DocumentRead,
    EnsureDirectory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOperation {
    pub kind: WorkspaceOperationKind,
    pub target_path: Option<String>,
    #[serde(default)]
    pub target_kind: Option<String>,
    #[serde(default)]
    pub recursive: bool,
    pub content_block_id: Option<String>,
    #[serde(default)]
    pub replacement_block_id: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub patch_spec: Option<Value>,
    #[serde(default)]
    pub allow_empty_content: bool,
    #[serde(default)]
    pub temporary: bool,
    #[serde(default)]
    pub executable: bool,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub depth: Option<u64>,
    #[serde(default)]
    pub include_hidden: bool,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    #[serde(default)]
    pub strategy: Option<String>,
    #[serde(default)]
    pub context_lines: Option<u64>,
    #[serde(default)]
    pub max_results: Option<u64>,
    #[serde(default)]
    pub rename_to: Option<String>,
    #[serde(default)]
    pub start_line: Option<u64>,
    #[serde(default)]
    pub end_line: Option<u64>,
    #[serde(default)]
    pub start_page: Option<u64>,
    #[serde(default)]
    pub end_page: Option<u64>,
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
    #[serde(default)]
    pub limit: Option<u64>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
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
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub selector: Option<String>,
    #[serde(default)]
    pub inspect_state: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub delta_y: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderOperation {
    pub profile_ref: Option<String>,
    pub budget_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentBlock {
    pub id: String,
    pub target_path: Option<String>,
    pub language: Option<String>,
    pub operation: Option<String>,
    pub content: Option<String>,
    #[serde(default)]
    pub allow_empty_content: bool,
}
