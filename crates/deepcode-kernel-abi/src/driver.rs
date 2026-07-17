use crate::{
    IsolationContract, OperationExecutionMode, PathScopePolicy, PlanTargetMode, PlanTargetSource,
    RunId, SessionId, TargetExistence, ToolContentMode, ToolFamily, ToolOperationKind,
    ToolPermissionMode, ToolRiskLevel, ToolTargetKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAdmissionPolicy {
    pub max_total_utf8_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolUsageConstraintsRef {
    pub target_existence: TargetExistence,
    pub source_existence: Option<TargetExistence>,
    pub destination_existence: Option<TargetExistence>,
    pub target_kinds: Vec<ToolTargetKind>,
    pub content_mode: ToolContentMode,
    pub directory_recursive_required: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolCatalogEntryRef {
    pub tool_id: String,
    pub capability: String,
    pub family: ToolFamily,
    pub operation_kind: ToolOperationKind,
    pub provider_schema: Value,
    pub planning_schema: Value,
    pub provider_visible: bool,
    pub forbidden_fields: Vec<String>,
    pub risk: ToolRiskLevel,
    pub permission_mode: ToolPermissionMode,
    pub permission_summary: String,
    pub path_scope_policy: PathScopePolicy,
    pub plan_target_mode: PlanTargetMode,
    pub plan_target_source: PlanTargetSource,
    pub execution_mode: OperationExecutionMode,
    pub isolation: IsolationContract,
    pub hard_deny_rules: Vec<String>,
    pub needs_workspace: bool,
    pub read_only: bool,
    pub usage_constraints: KernelToolUsageConstraintsRef,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelToolCatalogSnapshotRef {
    pub catalog_version: String,
    pub catalog_hash: String,
    pub tools: Vec<KernelToolCatalogEntryRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStateContract {
    pub kernel_abi_version: String,
    pub run_id: RunId,
    pub state_id: String,
    pub state_kind: String,
    pub allowed_inputs: Vec<String>,
    pub allowed_proposals: Vec<String>,
    pub proposal_schema_refs: Vec<String>,
    pub required_user_decision: Option<String>,
    pub capability_projection: Vec<String>,
    pub tool_catalog_ref: Option<String>,
    #[serde(default)]
    pub tool_catalog_hash: Option<String>,
    #[serde(default)]
    pub tool_catalog_snapshot: Option<KernelToolCatalogSnapshotRef>,
    pub draft_admission_policy: DraftAdmissionPolicy,
    pub transition_predicates: Vec<String>,
    pub fail_closed_rules: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DriverRequestKind {
    NeedProposal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverRequest {
    pub id: String,
    pub run_id: RunId,
    pub session_id: Option<SessionId>,
    pub kind: DriverRequestKind,
    pub reason: String,
    pub state_contract: KernelStateContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalEnvelopeSource {
    Llm,
    User,
    System,
    Cache,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalEnvelopeKind {
    Answer,
    ResourceRequest,
    DecisionRequest,
    ActionBundle,
    Diagnostic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalEnvelope {
    pub schema_version: String,
    pub proposal_id: String,
    pub run_id: RunId,
    pub session_id: Option<SessionId>,
    pub source: ProposalEnvelopeSource,
    pub kind: ProposalEnvelopeKind,
    pub payload: Value,
    pub referenced_resource_packet_refs: Vec<String>,
    pub referenced_evidence_refs: Vec<String>,
    pub parser_diagnostics: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceResolveRequest {
    pub manifest: Value,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalResourceLease {
    pub resource_id: String,
    pub root_id: String,
    pub canonical_path: String,
    pub target_kind: ExternalResourceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExternalResourceKind {
    File,
    Directory,
}
