use crate::descriptor::{StateId, WorkflowDescriptor, WorkflowStateDescriptor};
use crate::error::{WorkflowDescriptorError, WorkflowDescriptorResult};
use crate::predicate::{PredicateExpr, PredicateRegistry};
use crate::proposal::{ProposalEnvelope, ProposalKind};
use crate::validator::DescriptorValidator;
use std::collections::BTreeSet;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProposalValidationDecision {
    pub accepted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TransitionInput {
    pub current_state: StateId,
    pub proposal: Option<ProposalEnvelope>,
    pub satisfied_predicates: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransitionDecision {
    Stay {
        state: StateId,
        reason: String,
    },
    Advance {
        from: StateId,
        to: StateId,
        reason: String,
    },
}

#[derive(Debug, Clone, Default)]
pub struct SafeInterpreter {
    validator: DescriptorValidator,
    predicate_registry: PredicateRegistry,
}

impl SafeInterpreter {
    pub fn validate_descriptor(
        &self,
        descriptor: &WorkflowDescriptor,
    ) -> WorkflowDescriptorResult<()> {
        self.validator.validate(descriptor).map(|_| ())
    }

    pub fn validate_proposal(
        &self,
        state: &WorkflowStateDescriptor,
        proposal: &ProposalEnvelope,
    ) -> ProposalValidationDecision {
        if state
            .allowed_proposals
            .iter()
            .any(|kind| kind == &proposal.kind)
        {
            ProposalValidationDecision {
                accepted: true,
                reason: None,
            }
        } else {
            ProposalValidationDecision {
                accepted: false,
                reason: Some(format!(
                    "proposal {} is not allowed in state {}",
                    proposal.kind.as_str(),
                    state.id
                )),
            }
        }
    }

    pub fn evaluate_transition(
        &self,
        descriptor: &WorkflowDescriptor,
        input: TransitionInput,
    ) -> WorkflowDescriptorResult<TransitionDecision> {
        self.validate_descriptor(descriptor)?;
        let state = descriptor
            .states
            .iter()
            .find(|state| state.id == input.current_state)
            .ok_or_else(|| {
                WorkflowDescriptorError::validation(
                    "unknown_current_state",
                    format!("current state {} does not exist", input.current_state),
                )
            })?;
        if let Some(proposal) = &input.proposal {
            let decision = self.validate_proposal(state, proposal);
            if !decision.accepted {
                return Ok(TransitionDecision::Stay {
                    state: input.current_state,
                    reason: decision
                        .reason
                        .unwrap_or_else(|| "invalid proposal".to_string()),
                });
            }
        }
        for transition in descriptor
            .transitions
            .iter()
            .filter(|transition| transition.from == input.current_state)
        {
            if transition
                .when
                .iter()
                .all(|predicate| self.predicate_satisfied(predicate, &input))
            {
                return Ok(TransitionDecision::Advance {
                    from: transition.from.clone(),
                    to: transition.to.clone(),
                    reason: "transition predicates satisfied".to_string(),
                });
            }
        }
        Ok(TransitionDecision::Stay {
            state: input.current_state,
            reason: "no transition predicates satisfied".to_string(),
        })
    }

    fn predicate_satisfied(&self, predicate: &PredicateExpr, input: &TransitionInput) -> bool {
        if self.predicate_registry.evaluates_from_proposal(predicate) {
            return input
                .proposal
                .as_ref()
                .map(|proposal| self.proposal_predicate_satisfied(predicate, &proposal.kind))
                .unwrap_or(false);
        }
        input.satisfied_predicates.contains(&predicate.predicate)
    }

    fn proposal_predicate_satisfied(
        &self,
        predicate: &PredicateExpr,
        proposal_kind: &ProposalKind,
    ) -> bool {
        self.predicate_registry
            .evaluate_proposal_kind_in(predicate, proposal_kind)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proposal::{ProposalEnvelope, ProposalKind};
    use crate::template::builtin_plan_check_complete_review;
    use serde_json::Value;

    fn proposal(kind: ProposalKind) -> ProposalEnvelope {
        ProposalEnvelope {
            kind,
            payload: Value::Null,
        }
    }

    #[test]
    fn invalid_proposal_stays_without_transition() {
        let descriptor = builtin_plan_check_complete_review();
        let decision = SafeInterpreter::default()
            .evaluate_transition(
                &descriptor,
                TransitionInput {
                    current_state: "plan".to_string(),
                    proposal: Some(proposal(ProposalKind::PatchDraft)),
                    satisfied_predicates: BTreeSet::new(),
                },
            )
            .unwrap();

        assert!(matches!(
            decision,
            TransitionDecision::Stay { state, reason }
                if state == "plan" && reason.contains("not allowed")
        ));
    }

    #[test]
    fn plan_draft_advances_to_check() {
        let descriptor = builtin_plan_check_complete_review();
        let decision = SafeInterpreter::default()
            .evaluate_transition(
                &descriptor,
                TransitionInput {
                    current_state: "plan".to_string(),
                    proposal: Some(proposal(ProposalKind::PlanDraft)),
                    satisfied_predicates: BTreeSet::new(),
                },
            )
            .unwrap();

        assert_eq!(
            decision,
            TransitionDecision::Advance {
                from: "plan".to_string(),
                to: "check".to_string(),
                reason: "transition predicates satisfied".to_string(),
            }
        );
    }

    #[test]
    fn action_bundle_draft_advances_to_check() {
        let descriptor = builtin_plan_check_complete_review();
        let decision = SafeInterpreter::default()
            .evaluate_transition(
                &descriptor,
                TransitionInput {
                    current_state: "plan".to_string(),
                    proposal: Some(proposal(ProposalKind::ActionBundleDraft)),
                    satisfied_predicates: BTreeSet::new(),
                },
            )
            .unwrap();

        assert_eq!(
            decision,
            TransitionDecision::Advance {
                from: "plan".to_string(),
                to: "check".to_string(),
                reason: "transition predicates satisfied".to_string(),
            }
        );
    }

    #[test]
    fn complete_to_review_requires_all_predicates() {
        let descriptor = builtin_plan_check_complete_review();
        let mut partial = BTreeSet::new();
        partial.insert("validation.succeeded".to_string());

        let partial_decision = SafeInterpreter::default()
            .evaluate_transition(
                &descriptor,
                TransitionInput {
                    current_state: "complete".to_string(),
                    proposal: Some(proposal(ProposalKind::ValidationProposal)),
                    satisfied_predicates: partial,
                },
            )
            .unwrap();
        assert!(matches!(
            partial_decision,
            TransitionDecision::Stay { state, .. } if state == "complete"
        ));

        let mut complete = BTreeSet::new();
        complete.insert("validation.succeeded".to_string());
        complete.insert("temp_lease.all_released".to_string());
        let completed_decision = SafeInterpreter::default()
            .evaluate_transition(
                &descriptor,
                TransitionInput {
                    current_state: "complete".to_string(),
                    proposal: Some(proposal(ProposalKind::ValidationProposal)),
                    satisfied_predicates: complete,
                },
            )
            .unwrap();

        assert!(matches!(
            completed_decision,
            TransitionDecision::Advance { from, to, .. }
                if from == "complete" && to == "review"
        ));
    }
}
