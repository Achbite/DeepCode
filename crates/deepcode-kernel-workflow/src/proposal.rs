use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum ProposalKind {
    RequirementChecklist,
    ResourceRequest,
    PlanDraft,
    AgentPlanDraft,
    ActionBundleDraft,
    PlanReviewReport,
    PermissionPreflightResult,
    ToolActionDraft,
    PatchDraft,
    ValidationProposal,
    RepairProposal,
    ReviewPacket,
    ReplanRequest,
    FinalAnswerDraft,
}

impl ProposalKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::RequirementChecklist => "RequirementChecklist",
            Self::ResourceRequest => "ResourceRequest",
            Self::PlanDraft => "PlanDraft",
            Self::AgentPlanDraft => "AgentPlanDraft",
            Self::ActionBundleDraft => "ActionBundleDraft",
            Self::PlanReviewReport => "PlanReviewReport",
            Self::PermissionPreflightResult => "PermissionPreflightResult",
            Self::ToolActionDraft => "ToolActionDraft",
            Self::PatchDraft => "PatchDraft",
            Self::ValidationProposal => "ValidationProposal",
            Self::RepairProposal => "RepairProposal",
            Self::ReviewPacket => "ReviewPacket",
            Self::ReplanRequest => "ReplanRequest",
            Self::FinalAnswerDraft => "FinalAnswerDraft",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvalidProposalPolicy {
    Reject,
    RejectAndReprompt,
    RejectAndReplan,
    BlockWorkflow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct ProposalEnvelope {
    pub kind: ProposalKind,
    #[serde(default)]
    pub payload: Value,
}
