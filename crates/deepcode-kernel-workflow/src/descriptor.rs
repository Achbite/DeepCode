use crate::error::{WorkflowDescriptorError, WorkflowDescriptorResult};
use crate::predicate::PredicateExpr;
use crate::proposal::{InvalidProposalPolicy, ProposalKind};
use serde::{Deserialize, Serialize};

pub type WorkflowId = String;
pub type StateId = String;
pub type HookRef = String;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowStateKind {
    Llm,
    Kernel,
    LlmTool,
    KernelReview,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkflowDescriptor {
    pub schema_version: String,
    pub id: WorkflowId,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    pub initial_state: StateId,
    pub states: Vec<WorkflowStateDescriptor>,
    pub transitions: Vec<WorkflowTransitionDescriptor>,
    pub terminal_states: Vec<StateId>,
    #[serde(default)]
    pub max_iterations: Option<u32>,
}

impl WorkflowDescriptor {
    pub fn from_json_str(input: &str) -> WorkflowDescriptorResult<Self> {
        serde_json::from_str(input)
            .map_err(|error| WorkflowDescriptorError::parse(error.to_string()))
    }

    pub fn from_yaml_str(input: &str) -> WorkflowDescriptorResult<Self> {
        serde_yaml::from_str(input)
            .map_err(|error| WorkflowDescriptorError::parse(error.to_string()))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkflowStateDescriptor {
    pub id: StateId,
    pub kind: WorkflowStateKind,
    #[serde(default)]
    pub allowed_capabilities: Vec<String>,
    #[serde(default)]
    pub allowed_proposals: Vec<ProposalKind>,
    #[serde(default)]
    pub entry_hooks: Vec<HookRef>,
    #[serde(default)]
    pub exit_predicates: Vec<PredicateExpr>,
    pub invalid_proposal_policy: InvalidProposalPolicy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct WorkflowTransitionDescriptor {
    pub from: StateId,
    pub to: StateId,
    #[serde(default)]
    pub when: Vec<PredicateExpr>,
}
