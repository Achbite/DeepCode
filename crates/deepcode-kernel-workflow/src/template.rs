use crate::descriptor::{
    WorkflowDescriptor, WorkflowStateDescriptor, WorkflowStateKind, WorkflowTransitionDescriptor,
};
use crate::error::WorkflowDescriptorResult;
use crate::predicate::PredicateExpr;
use crate::proposal::{InvalidProposalPolicy, ProposalKind};
use crate::validator::{DescriptorValidator, WorkflowValidationReport};
use serde_json::json;

pub const PLAN_CHECK_COMPLETE_REVIEW_TEMPLATE: &str =
    include_str!("../templates/plan-check-complete-review.yaml");

pub fn load_builtin_plan_check_complete_review() -> WorkflowDescriptorResult<WorkflowDescriptor> {
    WorkflowDescriptor::from_yaml_str(PLAN_CHECK_COMPLETE_REVIEW_TEMPLATE)
}

pub fn builtin_plan_check_complete_review() -> WorkflowDescriptor {
    WorkflowDescriptor {
        schema_version: "1.0.0".to_string(),
        id: "plan-check-complete-review".to_string(),
        title: "Plan Check Complete Review".to_string(),
        description: Some("Default guarded workflow template.".to_string()),
        initial_state: "plan".to_string(),
        max_iterations: Some(3),
        terminal_states: vec!["done".to_string()],
        states: vec![
            WorkflowStateDescriptor {
                id: "plan".to_string(),
                kind: WorkflowStateKind::Llm,
                allowed_capabilities: vec![
                    "fs.read".to_string(),
                    "code.search".to_string(),
                    "web.search".to_string(),
                    "context.assemble".to_string(),
                ],
                allowed_proposals: vec![
                    ProposalKind::RequirementChecklist,
                    ProposalKind::ResourceRequest,
                    ProposalKind::PlanDraft,
                    ProposalKind::AgentPlanDraft,
                    ProposalKind::ActionBundleDraft,
                ],
                entry_hooks: vec!["driver.plan.enter".to_string()],
                exit_predicates: vec![proposal_kind_in(vec![
                    ProposalKind::PlanDraft,
                    ProposalKind::AgentPlanDraft,
                    ProposalKind::ActionBundleDraft,
                ])],
                invalid_proposal_policy: InvalidProposalPolicy::RejectAndRequestProposal,
            },
            WorkflowStateDescriptor {
                id: "check".to_string(),
                kind: WorkflowStateKind::Kernel,
                allowed_capabilities: vec![
                    "plan.review".to_string(),
                    "policy.inspect".to_string(),
                    "evidence.query".to_string(),
                    "permission.preflight".to_string(),
                ],
                allowed_proposals: vec![
                    ProposalKind::PlanReviewReport,
                    ProposalKind::PermissionPreflightResult,
                ],
                entry_hooks: vec!["kernel.plan_review.preflight".to_string()],
                exit_predicates: vec![predicate("plan_review.ready")],
                invalid_proposal_policy: InvalidProposalPolicy::Reject,
            },
            WorkflowStateDescriptor {
                id: "complete".to_string(),
                kind: WorkflowStateKind::LlmTool,
                allowed_capabilities: vec![
                    "fs.read".to_string(),
                    "code.search".to_string(),
                    "fs.write".to_string(),
                    "fs.patch".to_string(),
                    "fs.delete".to_string(),
                    "process.exec".to_string(),
                ],
                allowed_proposals: vec![
                    ProposalKind::ToolActionDraft,
                    ProposalKind::PatchDraft,
                    ProposalKind::ValidationProposal,
                    ProposalKind::RepairProposal,
                ],
                entry_hooks: Vec::new(),
                exit_predicates: vec![
                    predicate("validation.succeeded"),
                    predicate("temp_lease.all_released"),
                ],
                invalid_proposal_policy: InvalidProposalPolicy::RejectAndReplan,
            },
            WorkflowStateDescriptor {
                id: "review".to_string(),
                kind: WorkflowStateKind::KernelReview,
                allowed_capabilities: vec![
                    "fs.read".to_string(),
                    "evidence.query".to_string(),
                    "validation.read".to_string(),
                    "reviewgate.evaluate".to_string(),
                ],
                allowed_proposals: vec![
                    ProposalKind::ReviewPacket,
                    ProposalKind::ReplanRequest,
                    ProposalKind::FinalAnswerDraft,
                ],
                entry_hooks: Vec::new(),
                exit_predicates: vec![predicate("review.ready_for_user")],
                invalid_proposal_policy: InvalidProposalPolicy::Reject,
            },
            WorkflowStateDescriptor {
                id: "done".to_string(),
                kind: WorkflowStateKind::Terminal,
                allowed_capabilities: Vec::new(),
                allowed_proposals: Vec::new(),
                entry_hooks: Vec::new(),
                exit_predicates: Vec::new(),
                invalid_proposal_policy: InvalidProposalPolicy::Reject,
            },
        ],
        transitions: vec![
            WorkflowTransitionDescriptor {
                from: "plan".to_string(),
                to: "check".to_string(),
                when: vec![proposal_kind_in(vec![
                    ProposalKind::PlanDraft,
                    ProposalKind::AgentPlanDraft,
                    ProposalKind::ActionBundleDraft,
                ])],
            },
            WorkflowTransitionDescriptor {
                from: "check".to_string(),
                to: "complete".to_string(),
                when: vec![predicate("plan_review.ready")],
            },
            WorkflowTransitionDescriptor {
                from: "complete".to_string(),
                to: "review".to_string(),
                when: vec![
                    predicate("validation.succeeded"),
                    predicate("temp_lease.all_released"),
                ],
            },
            WorkflowTransitionDescriptor {
                from: "review".to_string(),
                to: "complete".to_string(),
                when: vec![predicate("user.replan_requested")],
            },
            WorkflowTransitionDescriptor {
                from: "review".to_string(),
                to: "done".to_string(),
                when: vec![predicate("user.accepted")],
            },
        ],
    }
}

pub fn validate_builtin_plan_check_complete_review(
) -> WorkflowDescriptorResult<WorkflowValidationReport> {
    DescriptorValidator::default().validate(&builtin_plan_check_complete_review())
}

fn predicate(id: &str) -> PredicateExpr {
    PredicateExpr {
        predicate: id.to_string(),
        args: serde_json::Value::Null,
    }
}

fn proposal_kind_in(kinds: Vec<ProposalKind>) -> PredicateExpr {
    PredicateExpr {
        predicate: "proposal.kind.in".to_string(),
        args: json!({
            "kinds": kinds.iter().map(ProposalKind::as_str).collect::<Vec<_>>()
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_template_loads_from_yaml_and_validates() {
        let descriptor = load_builtin_plan_check_complete_review().unwrap();
        assert_eq!(descriptor.id, "plan-check-complete-review");
        assert_eq!(descriptor.initial_state, "plan");
        assert_eq!(descriptor.terminal_states, vec!["done"]);

        DescriptorValidator::default()
            .validate(&descriptor)
            .unwrap();
    }

    #[test]
    fn builtin_template_round_trips_through_json() {
        let descriptor = builtin_plan_check_complete_review();
        let encoded = serde_json::to_string(&descriptor).unwrap();
        let decoded = WorkflowDescriptor::from_json_str(&encoded).unwrap();

        assert_eq!(decoded, descriptor);
    }

    #[test]
    fn builtin_plan_accepts_action_bundle_draft() {
        let descriptor = builtin_plan_check_complete_review();
        let plan = descriptor
            .states
            .iter()
            .find(|state| state.id == "plan")
            .expect("plan state");
        assert!(plan
            .allowed_proposals
            .contains(&ProposalKind::ActionBundleDraft));
        assert!(descriptor.transitions[0].when[0]
            .args
            .get("kinds")
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .iter()
            .any(|kind| kind.as_str() == Some("ActionBundleDraft")));
    }
}
