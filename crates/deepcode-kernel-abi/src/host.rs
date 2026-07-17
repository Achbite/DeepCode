use crate::{ResourceFileClassification, ResourceSearchMatch, WorkspaceBinding};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostResultSource {
    HostManagement,
    HostProjection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostCapability {
    BrowserRuntime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostCapabilityUnavailableReason {
    BackendUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilityUnavailable {
    pub capability: HostCapability,
    pub reason: HostCapabilityUnavailableReason,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostWorkspaceSourceKind {
    Directory,
    CodeWorkspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceFolder {
    pub id: String,
    pub name: String,
    pub path: String,
    pub absolute_path: String,
    pub original_path: String,
    pub is_absolute: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUnsupportedWorkspaceField {
    pub key: String,
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceSpec {
    pub id: String,
    pub name: String,
    pub source: HostWorkspaceSourceKind,
    pub source_path: Option<String>,
    pub root_path: String,
    pub folders: Vec<HostWorkspaceFolder>,
    pub settings: Value,
    pub unsupported_fields: Vec<HostUnsupportedWorkspaceField>,
    pub opened_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostWorkspaceRootStatus {
    Ready,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceBindingResolved {
    pub workspace_binding: WorkspaceBinding,
    pub root_status: HostWorkspaceRootStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceOpened {
    pub workspace: HostWorkspaceSpec,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceCurrent {
    pub current: Option<HostWorkspaceSpec>,
    pub fallback_used: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceSaved {
    pub workspace_file_path: String,
    pub workspace: HostWorkspaceSpec,
    pub created: bool,
    pub overwritten: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum HostWorkspaceOutput {
    BindingResolved(HostWorkspaceBindingResolved),
    Opened(HostWorkspaceOpened),
    Current(HostWorkspaceCurrent),
    Saved(HostWorkspaceSaved),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostWorkspaceResult {
    pub source: HostResultSource,
    pub output: HostWorkspaceOutput,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillEffect {
    ReadsWorkspace,
    WritesWorkspace,
    CreatesWorkspace,
    DeletesWorkspace,
    ReadsGit,
    RunsProcess,
    UsesNetwork,
    ReadsSecret,
    ModifiesGit,
    PushesGit,
    ControlsBrowser,
    ModifiesKernel,
    ModifiesConfig,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostSkillSource {
    LocalPack { pack_id: String },
    ExternalProcess { program: String, argv: Vec<String> },
    ExternalConnector { connector_id: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillAdapterKind {
    Declarative,
    ExternalProcess,
    Mcp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillActivationStatus {
    Dormant,
    Registered,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillDescriptor {
    pub id: String,
    pub version: String,
    pub title_key: Option<String>,
    pub description_key: Option<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub required_capabilities: Vec<String>,
    pub allowed_phases: Vec<String>,
    pub risk_level: HostSkillRiskLevel,
    pub effects: Vec<HostSkillEffect>,
    pub source: HostSkillSource,
    pub adapter_kind: HostSkillAdapterKind,
    pub activation_status: HostSkillActivationStatus,
    pub requested_model_visible: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillCatalogResult {
    pub source: HostResultSource,
    pub skills: Vec<HostSkillDescriptor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillTrustDecisionKind {
    Accept,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostSkillTrustMode {
    Declarative,
    BrokeredScript,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillTrustDecisionSubmit {
    pub decision: HostSkillTrustDecisionKind,
    pub trust_mode: HostSkillTrustMode,
    pub revision_hash: Option<String>,
    pub approved_capabilities: Vec<String>,
    pub approved_at: Option<String>,
    pub approved_by: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSkillTrustDecisionRecord {
    pub skill_id: String,
    pub decision: HostSkillTrustDecisionKind,
    pub trust_mode: HostSkillTrustMode,
    pub revision_hash: Option<String>,
    pub approved_capabilities: Vec<String>,
    pub approved_at: Option<String>,
    pub approved_by: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostMcpRiskDecisionKind {
    Acknowledge,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMcpRiskDecisionSubmit {
    pub decision: HostMcpRiskDecisionKind,
    pub revision_hash: Option<String>,
    pub acknowledged_by: Option<String>,
    pub acknowledged_at: Option<String>,
    pub risk_level: HostSkillRiskLevel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMcpRiskDecisionRecord {
    pub connector_id: String,
    pub binding_id: Option<String>,
    pub decision: HostMcpRiskDecisionKind,
    pub revision_hash: Option<String>,
    pub acknowledged_by: Option<String>,
    pub acknowledged_at: Option<String>,
    pub risk_level: HostSkillRiskLevel,
    pub permission_granted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostInspectionQuery {
    Browse {
        path: Option<String>,
    },
    List {
        folder_id: Option<String>,
        path: String,
        depth: u32,
    },
    Read {
        folder_id: Option<String>,
        path: String,
    },
    Grep {
        folder_id: Option<String>,
        query: String,
        path: String,
        include: Vec<String>,
        exclude: Vec<String>,
        strategy: String,
        context_lines: u32,
        max_results: u32,
    },
    GitStatus,
    GitDiff {
        path: Option<String>,
        staged: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostInspectionQueryKind {
    Browse,
    List,
    Read,
    Grep,
    GitStatus,
    GitDiff,
}

impl HostInspectionQuery {
    pub const fn kind(&self) -> HostInspectionQueryKind {
        match self {
            Self::Browse { .. } => HostInspectionQueryKind::Browse,
            Self::List { .. } => HostInspectionQueryKind::List,
            Self::Read { .. } => HostInspectionQueryKind::Read,
            Self::Grep { .. } => HostInspectionQueryKind::Grep,
            Self::GitStatus => HostInspectionQueryKind::GitStatus,
            Self::GitDiff { .. } => HostInspectionQueryKind::GitDiff,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HostFileTreeNodeKind {
    File,
    Directory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFileTreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub kind: HostFileTreeNodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<HostFileTreeNode>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_classification: Option<ResourceFileClassification>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostFileReadResult {
    pub folder_id: String,
    pub path: String,
    pub content: String,
    pub size_bytes: usize,
    pub file_size_bytes: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub content_hash: String,
    pub binary: bool,
    pub file_classification: ResourceFileClassification,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGrepResult {
    pub folder_id: String,
    pub query: String,
    pub path: String,
    pub strategy: String,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
    pub context_lines: usize,
    pub max_results: usize,
    pub returned_matches: usize,
    pub truncated: bool,
    pub visited_files: usize,
    pub skipped_files: usize,
    pub skipped_binary_files: usize,
    pub skipped_executable_files: usize,
    pub matches: Vec<ResourceSearchMatch>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGitChange {
    pub path: String,
    pub index: String,
    pub worktree: String,
    pub group: String,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGitStatusResult {
    pub root: String,
    pub changes: Vec<HostGitChange>,
    pub raw: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGitDiffResult {
    pub root: String,
    pub staged: bool,
    pub path: Option<String>,
    pub diff: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBrowseEntry {
    pub name: String,
    pub absolute_path: String,
    #[serde(rename = "type")]
    pub kind: HostFileTreeNodeKind,
    pub is_code_workspace: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBrowseResult {
    pub absolute_path: String,
    pub parent_path: Option<String>,
    pub entries: Vec<HostBrowseEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
pub enum HostInspectionOutput {
    Browse(HostBrowseResult),
    List(Vec<HostFileTreeNode>),
    Read(HostFileReadResult),
    Grep(HostGrepResult),
    GitStatus(HostGitStatusResult),
    GitDiff(HostGitDiffResult),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInspectionResult {
    pub source: HostResultSource,
    pub output: HostInspectionOutput,
}
