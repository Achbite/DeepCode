use crate::{
    CleanupContract, ContractExpiry, IsolationContract, OperationExecutionMode, PathScopePolicy,
    PlanTargetMode, PlanTargetSource, TargetExistence, ToolChangeKind, ToolContentMode,
    ToolFactCategory, ToolFactKind, ToolFamily, ToolOperationKind, ToolPermissionMode,
    ToolRiskLevel, ToolTargetKind, ToolValidationKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelExecutorBinding {
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
    WebSearch,
    WebFetch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionBackendKind {
    Builtin,
    Cli,
    Broker,
    ExternalProcess,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResourceSetSource {
    None,
    Path,
    PathOrQuery,
    SourceAndDestination,
    GitWorkspace,
    GitPaths,
    GitIndex,
    GitRemote,
    Query,
    Url,
    Process,
    BrowserState,
    ProviderResponse,
}

impl Default for ResourceSetSource {
    fn default() -> Self {
        Self::None
    }
}

impl ResourceSetSource {
    pub const fn contributes_resources(self) -> bool {
        !matches!(self, Self::None)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionBundleKey {
    None,
    WorkspaceWrite,
    WorkspaceDelete,
    GitWrite,
    GitPush,
    ProcessExec,
    NetworkEgress,
    BrowserControl,
    ProviderEgress,
}

impl PermissionBundleKey {
    pub const fn wire_name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::WorkspaceWrite => "workspace-write",
            Self::WorkspaceDelete => "workspace-delete",
            Self::GitWrite => "git-write",
            Self::GitPush => "git-push",
            Self::ProcessExec => "process-exec",
            Self::NetworkEgress => "network-egress",
            Self::BrowserControl => "browser-control",
            Self::ProviderEgress => "provider-egress",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputContract {
    pub schema: Value,
    pub planning_schema: Value,
    #[serde(default)]
    pub forbidden_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContract {
    pub path_scope_policy: PathScopePolicy,
    pub needs_workspace: bool,
    pub read_only: bool,
    pub plan_target_mode: PlanTargetMode,
    pub plan_target_source: PlanTargetSource,
    #[serde(default)]
    pub read_set_source: ResourceSetSource,
    #[serde(default)]
    pub write_set_source: ResourceSetSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionContract {
    pub mode: ToolPermissionMode,
    pub risk: ToolRiskLevel,
    pub capability: &'static str,
    pub bundle_key: PermissionBundleKey,
    pub grant_lifetime: ContractExpiry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionContract {
    pub backend: ExecutionBackendKind,
    pub executor_ref: &'static str,
    pub execution_mode: OperationExecutionMode,
    pub isolation: IsolationContract,
    #[serde(default)]
    pub shell_allowed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactContract {
    pub evidence_kind: ToolFactKind,
    pub category: ToolFactCategory,
    #[serde(default)]
    pub change_operation: Option<ToolChangeKind>,
    #[serde(default)]
    pub untrusted_evidence: bool,
    #[serde(default)]
    pub validation_kind: Option<ToolValidationKind>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolContract {
    pub tool_id: &'static str,
    pub provider_visible: bool,
    pub family: ToolFamily,
    pub operation_kind: ToolOperationKind,
    pub input: ToolInputContract,
    pub resource: ResourceContract,
    pub permission: PermissionContract,
    pub execution: ExecutionContract,
    pub fact: FactContract,
    pub cleanup: CleanupContract,
    pub usage_constraints: ToolUsageConstraints,
    #[serde(default)]
    pub hard_deny_rules: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageConstraints {
    pub target_existence: TargetExistence,
    #[serde(default)]
    pub source_existence: Option<TargetExistence>,
    #[serde(default)]
    pub destination_existence: Option<TargetExistence>,
    #[serde(default)]
    pub target_kinds: Vec<ToolTargetKind>,
    pub content_mode: ToolContentMode,
    #[serde(default)]
    pub directory_recursive_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolCatalogSnapshot {
    pub catalog_version: String,
    pub catalog_hash: String,
    pub tools: Vec<KernelToolCatalogTool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolCatalogTool {
    pub tool_id: String,
    pub capability: String,
    pub family: ToolFamily,
    pub operation_kind: ToolOperationKind,
    pub provider_schema: Value,
    pub planning_schema: Value,
    pub provider_visible: bool,
    #[serde(default)]
    pub forbidden_fields: Vec<String>,
    pub risk: ToolRiskLevel,
    pub permission_mode: ToolPermissionMode,
    pub permission_summary: String,
    pub path_scope_policy: PathScopePolicy,
    pub plan_target_mode: PlanTargetMode,
    pub plan_target_source: PlanTargetSource,
    pub execution_mode: OperationExecutionMode,
    pub isolation: IsolationContract,
    #[serde(default)]
    pub hard_deny_rules: Vec<String>,
    pub needs_workspace: bool,
    pub read_only: bool,
    pub usage_constraints: ToolUsageConstraints,
}
