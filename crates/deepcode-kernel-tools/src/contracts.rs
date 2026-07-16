use crate::{CleanupContract, IsolationContract};
use serde::{Deserialize, Serialize};
use serde_json::Value;

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

impl ToolPermissionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionBackendKind {
    Builtin,
    Cli,
    Broker,
    ExternalProcess,
    Mcp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputContract {
    pub schema: Value,
    pub planning_schema: Value,
    #[serde(default)]
    pub forbidden_fields: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanTargetMode {
    PerTarget,
    SourceDestination,
    Aggregate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceContract {
    pub path_scope_policy: &'static str,
    pub needs_workspace: bool,
    pub read_only: bool,
    pub plan_target_mode: PlanTargetMode,
    #[serde(default)]
    pub read_set_source: &'static str,
    #[serde(default)]
    pub write_set_source: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionContract {
    pub mode: ToolPermissionMode,
    pub risk: ToolRiskLevel,
    pub capability: &'static str,
    pub bundle_key: &'static str,
    pub grant_lifetime: &'static str,
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
pub enum ToolFactCategory {
    WorkspaceRead,
    WorkspaceMutation,
    Git,
    ExternalEvidence,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactContract {
    pub evidence_kind: &'static str,
    pub category: ToolFactCategory,
    #[serde(default)]
    pub change_operation: Option<&'static str>,
    #[serde(default)]
    pub untrusted_evidence: bool,
    #[serde(default)]
    pub validation_kind: Option<&'static str>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolTemplate {
    pub tool_id: &'static str,
    pub provider_visible: bool,
    pub family: ToolFamily,
    pub operation_kind: Option<&'static str>,
    pub input: ToolInputContract,
    pub resource: ResourceContract,
    pub permission: PermissionContract,
    pub execution: ExecutionContract,
    pub fact: FactContract,
    pub cleanup: CleanupContract,
    pub usage_constraints: ToolUsageConstraints,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsageConstraints {
    pub target_existence: &'static str,
    #[serde(default)]
    pub source_existence: Option<&'static str>,
    #[serde(default)]
    pub destination_existence: Option<&'static str>,
    #[serde(default)]
    pub target_kinds: Vec<&'static str>,
    pub content_mode: &'static str,
    #[serde(default)]
    pub directory_recursive_required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolCatalogSnapshot {
    pub catalog_version: &'static str,
    pub catalog_hash: String,
    pub tools: Vec<KernelToolCatalogTool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolCatalogTool {
    pub tool_id: &'static str,
    pub capability: &'static str,
    pub family: ToolFamily,
    pub operation_kind: Option<&'static str>,
    pub provider_schema: Value,
    pub planning_schema: Value,
    pub provider_visible: bool,
    #[serde(default)]
    pub forbidden_fields: Vec<String>,
    pub risk: ToolRiskLevel,
    pub permission_mode: ToolPermissionMode,
    pub permission_summary: String,
    pub path_scope_policy: &'static str,
    pub plan_target_mode: PlanTargetMode,
    pub execution_mode: OperationExecutionMode,
    pub isolation: IsolationContract,
    #[serde(default)]
    pub hard_deny_rules: Vec<String>,
    pub needs_workspace: bool,
    pub read_only: bool,
    pub usage_constraints: ToolUsageConstraints,
}
