use crate::{
    CleanupContract, ContractCleanupPolicy, ContractExpiry, FileTargetRef, KernelErrorEnvelope,
    OperationExecutionMode, PermissionResourceKind, ToolOperationKind, ToolPermissionMode,
    ToolRiskLevel, ToolTargetKind,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelExecutionContractStatus {
    Denied,
    AutoAccepted,
    AwaitingUserApproval,
    AuthorizedByPlan,
}

impl KernelExecutionContractStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Denied => "denied",
            Self::AutoAccepted => "autoAccepted",
            Self::AwaitingUserApproval => "awaitingUserApproval",
            Self::AuthorizedByPlan => "authorizedByPlan",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelGateInterventionKind {
    Permission,
    Policy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelGateInterventionStatus {
    Pending,
    SatisfiedByPlanAuthorization,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionOperation {
    pub id: String,
    pub title: String,
    pub depends_on: Vec<String>,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub args: Value,
    pub args_hash: String,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: OperationExecutionMode,
    pub cleanup: CleanupContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelPermissionBundle {
    pub id: String,
    pub capability: String,
    pub permission_mode: ToolPermissionMode,
    pub risk: ToolRiskLevel,
    pub resource_kind: PermissionResourceKind,
    pub operation_ids: Vec<String>,
    pub tool_ids: Vec<String>,
    pub targets: Vec<String>,
    pub expires_after: ContractExpiry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelGateIntervention {
    pub id: String,
    pub intervention_kind: KernelGateInterventionKind,
    pub status: KernelGateInterventionStatus,
    pub permission_bundle_id: Option<String>,
    pub affected_operation_ids: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelExecutionContract {
    pub id: String,
    pub proposal_id: String,
    pub authorization_contract_id: Option<String>,
    pub status: KernelExecutionContractStatus,
    pub catalog_version: String,
    pub catalog_hash: String,
    pub operation_set_hash: String,
    pub contract_hash: String,
    pub operations: Vec<KernelExecutionOperation>,
    pub permission_bundles: Vec<KernelPermissionBundle>,
    pub interventions: Vec<KernelGateIntervention>,
    pub cleanup_policy: ContractCleanupPolicy,
    pub expires_after: ContractExpiry,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelProposalReviewReport {
    pub proposal_id: String,
    pub status: KernelExecutionContractStatus,
    pub required_permissions: Vec<String>,
    pub diagnostics: Vec<String>,
    pub execution_contract: KernelExecutionContract,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelAction {
    pub action_id: String,
    pub tool_id: String,
    pub args: Value,
    pub description: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KernelContentOperation {
    Create,
    CreateEmpty,
    Overwrite,
    Patch,
    ReplaceBlock,
    InsertBefore,
    InsertAfter,
}

impl KernelContentOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::CreateEmpty => "createEmpty",
            Self::Overwrite => "overwrite",
            Self::Patch => "patch",
            Self::ReplaceBlock => "replaceBlock",
            Self::InsertBefore => "insertBefore",
            Self::InsertAfter => "insertAfter",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelContentBlock {
    pub block_id: String,
    pub target_path: String,
    pub language: Option<String>,
    pub operation: KernelContentOperation,
    pub content_lines: Vec<String>,
    #[serde(default)]
    pub allow_empty_content: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelValidationExpectation {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelReviewExpectation {
    pub id: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelContinuationExpectation {
    pub id: String,
    pub description: String,
    #[serde(default)]
    pub target: Vec<String>,
    pub reason: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelActionBundle {
    pub version: String,
    pub id: String,
    pub goal: String,
    pub requirement_id: Option<String>,
    pub actions: Vec<KernelAction>,
    #[serde(default)]
    pub continuation_expectations: Vec<KernelContinuationExpectation>,
    #[serde(default)]
    pub validation_expectations: Vec<KernelValidationExpectation>,
    #[serde(default)]
    pub review_expectations: Vec<KernelReviewExpectation>,
}

/// Canonical executable fields extracted once from an untrusted Provider payload.
/// Additional Provider presentation fields are ignored at this boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelActionProposal {
    pub action_bundle: KernelActionBundle,
    #[serde(default)]
    pub content_blocks: Vec<KernelContentBlock>,
    pub authorization_contract_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KernelActionBatch {
    pub plan_id: String,
    pub contract_id: String,
    pub contract_hash: String,
    pub action_bundle: KernelActionBundle,
    #[serde(default)]
    pub content_blocks: Vec<KernelContentBlock>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelActionSummary {
    pub action_id: String,
    pub tool_id: String,
    pub description: String,
    pub args: Value,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelContentBlockSummary {
    pub block_id: String,
    pub target_path: String,
    pub language: Option<String>,
    pub operation: KernelContentOperation,
    pub content_bytes: usize,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelActionBatchSummary {
    pub plan_id: String,
    pub action_bundle_id: String,
    pub goal: String,
    pub action_count: usize,
    pub actions: Vec<KernelActionSummary>,
    pub content_blocks: Vec<KernelContentBlockSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewGateDecisionKind {
    Accept,
    Revise,
    Reject,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewGateDecision {
    pub decision: ReviewGateDecisionKind,
    pub guidance: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewGateStatus {
    Accepted,
    NeedsReplan,
    Aborted,
    CleanupFailed,
}

impl ReviewGateStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::NeedsReplan => "needsReplan",
            Self::Aborted => "aborted",
            Self::CleanupFailed => "cleanupFailed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewGateEvaluation {
    pub id: String,
    pub run_id: String,
    pub status: ReviewGateStatus,
    pub decision: ReviewGateDecision,
    pub failed_work_unit_count: usize,
    pub blocked_work_unit_count: usize,
    pub cleanup_failure_count: usize,
    pub revoked_temporary_grant_count: usize,
    pub released_resource_count: usize,
    pub removed_temp_file_count: usize,
    pub cleanup_failures: Vec<String>,
    pub summary: String,
    pub facts_ref: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkUnitStatus {
    Queued,
    Started,
    Completed,
    Failed,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledToolSummary {
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub path: Option<String>,
    pub target_kind: Option<ToolTargetKind>,
    pub recursive: Option<bool>,
    pub query: Option<String>,
    pub args_preview: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkUnitDescriptor {
    pub id: String,
    pub plan_id: String,
    pub action_id: String,
    pub title: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub capability: String,
    pub target_ref: Option<FileTargetRef>,
    pub read_set: Vec<String>,
    pub write_set: Vec<String>,
    pub conflict_keys: Vec<String>,
    pub execution_mode: OperationExecutionMode,
    pub status: WorkUnitStatus,
    pub compiled_tool: Option<CompiledToolSummary>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCompletionFact {
    pub tool_call_id: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub ok: bool,
    pub output: Option<Value>,
    pub error: Option<KernelErrorEnvelope>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolRequestFact {
    pub tool_call_id: String,
    pub tool_id: String,
    pub operation_kind: ToolOperationKind,
    pub args_preview: Value,
}
