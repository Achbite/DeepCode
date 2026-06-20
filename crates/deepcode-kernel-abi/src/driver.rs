use crate::{RunId, SessionId, WorkflowRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KernelStateContract {
    pub run_id: RunId,
    pub workflow_ref: Option<WorkflowRef>,
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
    pub tool_catalog_snapshot: Option<Value>,
    pub transition_predicates: Vec<String>,
    pub fail_closed_rules: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DriverRequestKind {
    NeedRequirementDraft,
    NeedRequirementDecision,
    NeedResourcePacket,
    NeedProposal,
    NeedUserPlanDecision,
    NeedUserPermissionDecision,
    NeedRepairProposal,
    NeedReviewPacket,
    NeedUserReviewDecision,
    WaitKernelExecution,
    Terminal,
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
pub struct UserDecisionSubmit {
    pub decision_id: String,
    pub decision_kind: String,
    pub target_id: Option<String>,
    pub payload: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceResolveRequest {
    pub manifest: Value,
}
