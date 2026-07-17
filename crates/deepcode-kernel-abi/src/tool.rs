use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

impl ToolRiskLevel {
    pub const fn as_str(self) -> &'static str {
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

impl ToolPermissionMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }

    pub const fn stricter(self, other: Self) -> Self {
        match (self, other) {
            (Self::Deny, _) | (_, Self::Deny) => Self::Deny,
            (Self::Ask, _) | (_, Self::Ask) => Self::Ask,
            (Self::Allow, Self::Allow) => Self::Allow,
        }
    }
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
    Document,
    Git,
    Process,
    Network,
    Browser,
    Provider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PathScopePolicy {
    None,
    WorkspaceReadScope,
    WorkspacePathScopedGrant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanTargetSource {
    None,
    Path,
    PathOrCurrentDirectory,
    SourceDestination,
    GitWorkspace,
    GitIndex,
    GitRemote,
    NetworkUrl,
    NetworkQuery,
}

impl PlanTargetSource {
    pub fn derive(self, args: &Value) -> Vec<String> {
        match self {
            Self::None => Vec::new(),
            Self::Path => string_arg(args, "path").into_iter().collect(),
            Self::PathOrCurrentDirectory => {
                vec![string_arg(args, "path").unwrap_or_else(|| ".".to_string())]
            }
            Self::SourceDestination => [
                string_arg(args, "path"),
                string_arg(args, "destinationPath"),
            ]
            .into_iter()
            .flatten()
            .collect(),
            Self::GitWorkspace => git_targets(args, "workspace"),
            Self::GitIndex => git_targets(args, "index"),
            Self::GitRemote => vec![format!(
                "git:remote:{}",
                string_arg(args, "remote").unwrap_or_else(|| "origin".to_string())
            )],
            Self::NetworkUrl => string_arg(args, "url")
                .map(|value| vec![format!("network:{value}")])
                .unwrap_or_default(),
            Self::NetworkQuery => string_arg(args, "query")
                .map(|value| vec![format!("network:{value}")])
                .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetExistence {
    Any,
    MustExist,
    MustNotExist,
}

impl ToolFamily {
    pub const fn permission_resource_kind(self) -> PermissionResourceKind {
        match self {
            Self::Workspace | Self::Document => PermissionResourceKind::WorkspacePath,
            Self::Git => PermissionResourceKind::GitWorkspace,
            Self::Process => PermissionResourceKind::Process,
            Self::Network => PermissionResourceKind::NetworkTarget,
            Self::Browser => PermissionResourceKind::BrowserState,
            Self::Provider => PermissionResourceKind::ProviderProfile,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionResourceKind {
    WorkspacePath,
    GitWorkspace,
    Process,
    NetworkTarget,
    BrowserState,
    ProviderProfile,
    RuntimePermission,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContractExpiry {
    NotRequired,
    RunBatchUntilReview,
    PlanReviewOrRunTerminal,
    ReviewGateOrRunTerminal,
    ReviewGateReplanCancelOrRunTerminal,
    Immediate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContractCleanupPolicy {
    None,
    PerOperationCleanupContract,
    PlanGrantLease,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolTargetKind {
    File,
    Directory,
}

impl ToolTargetKind {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolContentMode {
    None,
    ContentBlock,
    ReplacementBlock,
}

impl ToolContentMode {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ContentBlock => "contentBlock",
            Self::ReplacementBlock => "replacementBlock",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolFactKind {
    FileText,
    DirectoryTree,
    FileMatches,
    DiffPreview,
    SearchResults,
    FileCreate,
    FileWrite,
    FilePatch,
    FileRename,
    FileDelete,
    DocumentText,
    DirectoryEnsure,
    GitStatus,
    GitDiff,
    GitIndexMutation,
    GitCommit,
    GitPush,
    ProcessResult,
    WebSearchEvidence,
    WebFetchEvidence,
    ProviderCall,
    BrowserEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileTargetRefKind {
    WorkspaceRelative,
    RootRelative,
    AbsolutePath,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTargetRef {
    pub kind: FileTargetRefKind,
    pub path: String,
    #[serde(default)]
    pub root_id: Option<String>,
}

impl FileTargetRef {
    pub fn from_path(path: impl Into<String>) -> Self {
        let path = path.into();
        let kind = if std::path::Path::new(&path).is_absolute() {
            FileTargetRefKind::AbsolutePath
        } else {
            FileTargetRefKind::WorkspaceRelative
        };
        Self {
            kind,
            path,
            root_id: None,
        }
    }

    pub fn raw_path(&self) -> String {
        match self.kind {
            FileTargetRefKind::WorkspaceRelative | FileTargetRefKind::AbsolutePath => {
                self.path.clone()
            }
            FileTargetRefKind::RootRelative => self
                .root_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|root_id| {
                    if self.path.trim().is_empty() {
                        root_id.to_string()
                    } else {
                        format!("{}/{}", root_id.trim_end_matches('/'), self.path)
                    }
                })
                .unwrap_or_else(|| self.path.clone()),
        }
    }
}

fn string_arg(args: &Value, field: &str) -> Option<String> {
    args.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn git_targets(args: &Value, fallback: &str) -> Vec<String> {
    let mut targets = args
        .get("paths")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("git:{value}"))
        .collect::<Vec<_>>();
    if targets.is_empty() {
        if let Some(path) = string_arg(args, "path") {
            targets.push(format!("git:{path}"));
        }
    }
    if targets.is_empty() {
        targets.push(format!("git:{fallback}"));
    }
    targets
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolOperationKind {
    FsRead,
    FsList,
    FsGlob,
    FsDiff,
    FsCreate,
    FsWrite,
    FsEdit,
    FsRename,
    FsDelete,
    FsEnsureDirectory,
    CodeGrep,
    DocumentRead,
    GitStatus,
    GitDiff,
    GitStage,
    GitUnstage,
    GitCommit,
    GitPush,
    ProcessExec,
    WebSearch,
    WebFetch,
    BrowserOpen,
    BrowserReload,
    BrowserSnapshot,
    BrowserInspect,
    BrowserClick,
    BrowserType,
    BrowserScroll,
    ProviderCall,
}

impl ToolOperationKind {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::FsRead => "fsRead",
            Self::FsList => "fsList",
            Self::FsGlob => "fsGlob",
            Self::FsDiff => "fsDiff",
            Self::FsCreate => "fsCreate",
            Self::FsWrite => "fsWrite",
            Self::FsEdit => "fsEdit",
            Self::FsRename => "fsRename",
            Self::FsDelete => "fsDelete",
            Self::FsEnsureDirectory => "fsEnsureDirectory",
            Self::CodeGrep => "codeGrep",
            Self::DocumentRead => "documentRead",
            Self::GitStatus => "gitStatus",
            Self::GitDiff => "gitDiff",
            Self::GitStage => "gitStage",
            Self::GitUnstage => "gitUnstage",
            Self::GitCommit => "gitCommit",
            Self::GitPush => "gitPush",
            Self::ProcessExec => "processExec",
            Self::WebSearch => "webSearch",
            Self::WebFetch => "webFetch",
            Self::BrowserOpen => "browserOpen",
            Self::BrowserReload => "browserReload",
            Self::BrowserSnapshot => "browserSnapshot",
            Self::BrowserInspect => "browserInspect",
            Self::BrowserClick => "browserClick",
            Self::BrowserType => "browserType",
            Self::BrowserScroll => "browserScroll",
            Self::ProviderCall => "providerCall",
        }
    }

    pub const fn is_workspace_mutation(self) -> bool {
        matches!(
            self,
            Self::FsCreate
                | Self::FsWrite
                | Self::FsEdit
                | Self::FsRename
                | Self::FsDelete
                | Self::FsEnsureDirectory
        )
    }

    pub const fn has_workspace_path(self) -> bool {
        matches!(
            self,
            Self::FsRead
                | Self::FsList
                | Self::FsGlob
                | Self::FsDiff
                | Self::FsCreate
                | Self::FsWrite
                | Self::FsEdit
                | Self::FsRename
                | Self::FsDelete
                | Self::FsEnsureDirectory
                | Self::CodeGrep
                | Self::DocumentRead
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanTargetMode {
    PerTarget,
    SourceDestination,
    Aggregate,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolFactCategory {
    WorkspaceRead,
    WorkspaceMutation,
    Git,
    ExternalEvidence,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolChangeKind {
    Create,
    Write,
    Edit,
    Rename,
    Delete,
}

impl ToolChangeKind {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Write => "write",
            Self::Edit => "edit",
            Self::Rename => "rename",
            Self::Delete => "delete",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolValidationKind {
    ReadBack,
    PatchReadBack,
    RenameVerified,
    DeleteVerified,
}

impl ToolValidationKind {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::ReadBack => "readBack",
            Self::PatchReadBack => "patchReadBack",
            Self::RenameVerified => "renameVerified",
            Self::DeleteVerified => "deleteVerified",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationLevel {
    None,
    Supervised,
    OsSandbox,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SandboxSupportState {
    Unavailable,
    ContractOnly,
    Experimental,
    Enforced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IsolationFallbackPolicy {
    Deny,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolOutputTrust {
    ToolFact,
    UntrustedEvidence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupLeasePolicy {
    None,
    SandboxLease,
    ProviderStream,
    BatchTemporaryFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CleanupFailurePolicy {
    RecordFailure,
    BlockReviewAcceptance,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IsolationContract {
    pub minimum_level: IsolationLevel,
    pub support_state: SandboxSupportState,
    pub backend_requirement: Option<String>,
    pub profile_ref: Option<String>,
    pub fallback: IsolationFallbackPolicy,
    pub output_trust: ToolOutputTrust,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupContract {
    pub lease_policy: CleanupLeasePolicy,
    pub terminate_process_tree: bool,
    pub remove_scratch: bool,
    pub revoke_broker_grant: bool,
    pub deadline_ms: u64,
    pub failure_policy: CleanupFailurePolicy,
}
