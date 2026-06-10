use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanRiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionCriteria {
    pub id: String,
    pub description: String,
    pub evidence_required: Vec<String>,
    pub validation_kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPolicy {
    pub require_evidence: bool,
    pub require_validation_success: bool,
}

impl Default for ReviewPolicy {
    fn default() -> Self {
        Self {
            require_evidence: true,
            require_validation_success: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanContract {
    pub id: String,
    pub goal: String,
    #[serde(default)]
    pub scope: Vec<String>,
    #[serde(default)]
    pub forbidden_actions: Vec<String>,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub completion_criteria: Vec<CompletionCriteria>,
    pub risk_level: PlanRiskLevel,
    #[serde(default)]
    pub requires_user_approval: bool,
    #[serde(default)]
    pub review_policy: ReviewPolicy,
}

impl PlanContract {
    pub fn low_risk_direct(id: impl Into<String>, goal: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            goal: goal.into(),
            scope: vec!["workspace".to_string()],
            forbidden_actions: Vec::new(),
            required_capabilities: vec!["workspace.read".to_string()],
            completion_criteria: vec![CompletionCriteria {
                id: "criteria-evidence".to_string(),
                description: "At least one evidence reference is produced.".to_string(),
                evidence_required: vec!["observation".to_string()],
                validation_kind: None,
            }],
            risk_level: PlanRiskLevel::Low,
            requires_user_approval: false,
            review_policy: ReviewPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionBundleDraft {
    pub id: String,
    pub goal: String,
    #[serde(default)]
    pub actions: Vec<PlannedAction>,
    #[serde(default)]
    pub validation_expectations: Vec<ValidationExpectation>,
    #[serde(default)]
    pub review_expectations: Vec<ReviewExpectation>,
}

impl ActionBundleDraft {
    pub fn to_plan_contract(&self) -> PlanContract {
        let mut capabilities = BTreeSet::new();
        let mut scopes = BTreeSet::new();
        for action in &self.actions {
            capabilities.insert(action.capability.clone());
            for scope in &action.resource_scope {
                scopes.insert(scope.clone());
            }
        }

        let completion_criteria = self
            .validation_expectations
            .iter()
            .map(|expectation| CompletionCriteria {
                id: expectation.id.clone(),
                description: expectation.description.clone(),
                evidence_required: vec!["validation_result".to_string()],
                validation_kind: expectation.command.as_ref().map(|_| "command".to_string()),
            })
            .collect::<Vec<_>>();

        let required_capabilities = capabilities.into_iter().collect::<Vec<_>>();
        PlanContract {
            id: self.id.clone(),
            goal: self.goal.clone(),
            scope: if scopes.is_empty() {
                vec!["workspace".to_string()]
            } else {
                scopes.into_iter().collect()
            },
            forbidden_actions: Vec::new(),
            risk_level: risk_level_for_capabilities(&required_capabilities),
            requires_user_approval: required_capabilities
                .iter()
                .any(|capability| high_risk_capability(capability)),
            required_capabilities,
            completion_criteria,
            review_policy: ReviewPolicy::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannedAction {
    pub id: String,
    pub title: String,
    pub capability: String,
    #[serde(default)]
    pub resource_scope: Vec<String>,
    #[serde(default)]
    pub can_parallelize: bool,
    #[serde(default)]
    pub conflict_keys: Vec<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationExpectation {
    pub id: String,
    pub description: String,
    #[serde(default)]
    pub command: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewExpectation {
    pub id: String,
    pub description: String,
}

fn risk_level_for_capabilities(capabilities: &[String]) -> PlanRiskLevel {
    if capabilities
        .iter()
        .any(|capability| matches!(capability.as_str(), "secret.read" | "kernel.modify"))
    {
        return PlanRiskLevel::Critical;
    }
    if capabilities.iter().any(|capability| {
        matches!(
            capability.as_str(),
            "process.exec" | "network.egress" | "browser.control" | "git.write"
        )
    }) {
        return PlanRiskLevel::High;
    }
    if capabilities.iter().any(|capability| {
        matches!(
            capability.as_str(),
            "workspace.write" | "workspace.create" | "workspace.delete" | "workspace.rename"
        )
    }) {
        return PlanRiskLevel::Medium;
    }
    PlanRiskLevel::Low
}

fn high_risk_capability(capability: &str) -> bool {
    matches!(
        capability,
        "workspace.write"
            | "workspace.create"
            | "workspace.delete"
            | "workspace.rename"
            | "process.exec"
            | "network.egress"
            | "browser.control"
            | "git.write"
            | "secret.read"
            | "config.modify"
            | "kernel.modify"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_bundle_round_trips_through_json_and_yaml() {
        let bundle = ActionBundleDraft {
            id: "bundle-1".to_string(),
            goal: "Inspect workspace".to_string(),
            actions: vec![PlannedAction {
                id: "action-1".to_string(),
                title: "List files".to_string(),
                capability: "workspace.read".to_string(),
                resource_scope: vec![".".to_string()],
                can_parallelize: true,
                conflict_keys: Vec::new(),
                purpose: Some("collect evidence".to_string()),
            }],
            validation_expectations: vec![ValidationExpectation {
                id: "validation-1".to_string(),
                description: "Evidence is present.".to_string(),
                command: None,
            }],
            review_expectations: vec![ReviewExpectation {
                id: "review-1".to_string(),
                description: "User checks the summary.".to_string(),
            }],
        };

        let json = serde_json::to_string(&bundle).unwrap();
        let decoded_json: ActionBundleDraft = serde_json::from_str(&json).unwrap();
        assert_eq!(decoded_json, bundle);

        let yaml = serde_yaml::to_string(&bundle).unwrap();
        let decoded_yaml: ActionBundleDraft = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(decoded_yaml, bundle);
    }

    #[test]
    fn action_bundle_compiles_to_plan_contract_without_execution_semantics() {
        let bundle = ActionBundleDraft {
            id: "bundle-write".to_string(),
            goal: "Write generated file".to_string(),
            actions: vec![PlannedAction {
                id: "write-1".to_string(),
                title: "LLM says it needs admin permission".to_string(),
                capability: "workspace.write".to_string(),
                resource_scope: vec!["src".to_string()],
                can_parallelize: false,
                conflict_keys: vec!["src/out.txt".to_string()],
                purpose: None,
            }],
            validation_expectations: vec![ValidationExpectation {
                id: "check-1".to_string(),
                description: "Generated file exists.".to_string(),
                command: None,
            }],
            review_expectations: Vec::new(),
        };

        let plan = bundle.to_plan_contract();
        assert_eq!(plan.required_capabilities, vec!["workspace.write"]);
        assert_eq!(plan.risk_level, PlanRiskLevel::Medium);
        assert!(plan.requires_user_approval);
        assert_eq!(plan.scope, vec!["src"]);
        assert_eq!(plan.completion_criteria.len(), 1);
    }
}
