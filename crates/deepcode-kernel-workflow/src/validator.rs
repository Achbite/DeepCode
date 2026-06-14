use crate::descriptor::{WorkflowDescriptor, WorkflowStateDescriptor};
use crate::error::{WorkflowDescriptorError, WorkflowDescriptorResult};
use crate::predicate::{PredicateExpr, PredicateRegistry};
use crate::proposal::ProposalKind;
use std::collections::{BTreeMap, BTreeSet, VecDeque};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct WorkflowValidationReport {
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct DescriptorValidator {
    known_capabilities: BTreeSet<String>,
    known_hooks: BTreeSet<String>,
    predicate_registry: PredicateRegistry,
}

impl Default for DescriptorValidator {
    fn default() -> Self {
        Self {
            known_capabilities: known_capabilities(),
            known_hooks: known_hooks(),
            predicate_registry: PredicateRegistry::default(),
        }
    }
}

impl DescriptorValidator {
    pub fn validate(
        &self,
        descriptor: &WorkflowDescriptor,
    ) -> WorkflowDescriptorResult<WorkflowValidationReport> {
        validate_schema_header(descriptor)?;
        let states = self.validate_states(descriptor)?;
        self.validate_transitions(descriptor, &states)?;
        self.validate_graph(descriptor, &states)?;
        Ok(WorkflowValidationReport::default())
    }

    fn validate_states<'a>(
        &self,
        descriptor: &'a WorkflowDescriptor,
    ) -> WorkflowDescriptorResult<BTreeMap<&'a str, &'a WorkflowStateDescriptor>> {
        if descriptor.terminal_states.is_empty() {
            return validation_error(
                "terminal_states_required",
                "workflow descriptor requires at least one terminal state",
            );
        }
        let mut states = BTreeMap::new();
        for state in &descriptor.states {
            if state.id.trim().is_empty() {
                return validation_error("state_id_required", "workflow state id is required");
            }
            if states.insert(state.id.as_str(), state).is_some() {
                return validation_error(
                    "duplicate_state",
                    format!("workflow state {} is duplicated", state.id),
                );
            }
            if !descriptor.terminal_states.contains(&state.id) && state.allowed_proposals.is_empty()
            {
                return validation_error(
                    "state_proposals_required",
                    format!("workflow state {} must declare allowed proposals", state.id),
                );
            }
            for capability in &state.allowed_capabilities {
                if !self.known_capabilities.contains(capability) {
                    return validation_error(
                        "unknown_capability",
                        format!(
                            "workflow state {} references unknown capability {}",
                            state.id, capability
                        ),
                    );
                }
            }
            for hook in &state.entry_hooks {
                if !self.known_hooks.contains(hook) || hook_looks_executable(hook) {
                    return validation_error(
                        "unsafe_hook",
                        format!(
                            "workflow state {} references unsupported hook {}",
                            state.id, hook
                        ),
                    );
                }
            }
            self.validate_predicates(&state.exit_predicates)?;
            ensure_no_duplicate_proposals(&state.id, &state.allowed_proposals)?;
        }
        if states.is_empty() {
            return validation_error("states_required", "workflow descriptor requires states");
        }
        if !states.contains_key(descriptor.initial_state.as_str()) {
            return validation_error(
                "missing_initial_state",
                format!("initial state {} does not exist", descriptor.initial_state),
            );
        }
        for terminal in &descriptor.terminal_states {
            if !states.contains_key(terminal.as_str()) {
                return validation_error(
                    "unknown_terminal_state",
                    format!("terminal state {} does not exist", terminal),
                );
            }
        }
        Ok(states)
    }

    fn validate_transitions(
        &self,
        descriptor: &WorkflowDescriptor,
        states: &BTreeMap<&str, &WorkflowStateDescriptor>,
    ) -> WorkflowDescriptorResult<()> {
        for transition in &descriptor.transitions {
            if !states.contains_key(transition.from.as_str()) {
                return validation_error(
                    "unknown_transition_state",
                    format!(
                        "transition from {} references unknown state",
                        transition.from
                    ),
                );
            }
            if !states.contains_key(transition.to.as_str()) {
                return validation_error(
                    "unknown_transition_state",
                    format!("transition to {} references unknown state", transition.to),
                );
            }
            if descriptor.terminal_states.contains(&transition.from) {
                return validation_error(
                    "terminal_state_has_outgoing_transition",
                    format!(
                        "terminal state {} must not have outgoing transitions",
                        transition.from
                    ),
                );
            }
            if transition.from == transition.to && !has_user_or_budget_predicate(&transition.when) {
                return validation_error(
                    "unbounded_self_loop",
                    format!("state {} has an unbounded self-loop", transition.from),
                );
            }
            if transition.when.is_empty() {
                return validation_error(
                    "transition_predicate_required",
                    format!(
                        "transition {} -> {} requires predicates",
                        transition.from, transition.to
                    ),
                );
            }
            self.validate_predicates(&transition.when)?;
        }
        Ok(())
    }

    fn validate_predicates(&self, predicates: &[PredicateExpr]) -> WorkflowDescriptorResult<()> {
        for predicate in predicates {
            if self.predicate_registry.is_forbidden(&predicate.predicate) {
                return validation_error(
                    "forbidden_predicate",
                    format!("predicate {} is forbidden", predicate.predicate),
                );
            }
            if !self.predicate_registry.is_known(&predicate.predicate) {
                return validation_error(
                    "unknown_predicate",
                    format!("predicate {} is not registered", predicate.predicate),
                );
            }
        }
        Ok(())
    }

    fn validate_graph(
        &self,
        descriptor: &WorkflowDescriptor,
        states: &BTreeMap<&str, &WorkflowStateDescriptor>,
    ) -> WorkflowDescriptorResult<()> {
        let mut outgoing: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
        for transition in &descriptor.transitions {
            outgoing
                .entry(transition.from.as_str())
                .or_default()
                .push(transition.to.as_str());
        }
        for state in states.keys() {
            if descriptor
                .terminal_states
                .iter()
                .any(|terminal| terminal == state)
            {
                continue;
            }
            if outgoing.get(state).map(Vec::is_empty).unwrap_or(true) {
                return validation_error(
                    "dead_end_state",
                    format!("non-terminal state {} has no outgoing transitions", state),
                );
            }
        }

        let reachable = reachable_states(descriptor.initial_state.as_str(), &outgoing);
        for state in states.keys() {
            if !reachable.contains(state) {
                return validation_error(
                    "unreachable_state",
                    format!("workflow state {} is unreachable", state),
                );
            }
        }
        if !descriptor
            .terminal_states
            .iter()
            .any(|terminal| reachable.contains(terminal.as_str()))
        {
            return validation_error(
                "terminal_unreachable",
                "no terminal state is reachable from initial state",
            );
        }
        Ok(())
    }
}

fn validate_schema_header(descriptor: &WorkflowDescriptor) -> WorkflowDescriptorResult<()> {
    if !matches!(descriptor.schema_version.as_str(), "1" | "1.0" | "1.0.0") {
        return validation_error(
            "unsupported_schema_version",
            format!(
                "unsupported workflow schema version {}",
                descriptor.schema_version
            ),
        );
    }
    if descriptor.id.trim().is_empty() {
        return validation_error("workflow_id_required", "workflow id is required");
    }
    if descriptor.initial_state.trim().is_empty() {
        return validation_error("initial_state_required", "initial state is required");
    }
    Ok(())
}

fn ensure_no_duplicate_proposals(
    state_id: &str,
    proposals: &[ProposalKind],
) -> WorkflowDescriptorResult<()> {
    let mut seen = BTreeSet::new();
    for proposal in proposals {
        if !seen.insert(proposal) {
            return validation_error(
                "duplicate_proposal",
                format!(
                    "workflow state {} repeats proposal {}",
                    state_id,
                    proposal.as_str()
                ),
            );
        }
    }
    Ok(())
}

fn reachable_states<'a>(
    initial: &'a str,
    outgoing: &BTreeMap<&'a str, Vec<&'a str>>,
) -> BTreeSet<&'a str> {
    let mut reachable = BTreeSet::new();
    let mut queue = VecDeque::from([initial]);
    while let Some(state) = queue.pop_front() {
        if !reachable.insert(state) {
            continue;
        }
        if let Some(next_states) = outgoing.get(state) {
            for next in next_states {
                queue.push_back(next);
            }
        }
    }
    reachable
}

fn has_user_or_budget_predicate(predicates: &[PredicateExpr]) -> bool {
    predicates.iter().any(|predicate| {
        predicate.predicate.starts_with("user.") || predicate.predicate == "risk_budget.exhausted"
    })
}

fn hook_looks_executable(hook: &str) -> bool {
    let lower = hook.to_ascii_lowercase();
    lower.contains("shell")
        || lower.contains("script")
        || lower.contains("eval")
        || lower.contains("python")
        || lower.contains("node")
        || lower.contains("bash")
        || lower.contains("powershell")
}

fn known_capabilities() -> BTreeSet<String> {
    [
        "workspace.read",
        "workspace.preview_diff",
        "workspace.write",
        "workspace.create",
        "workspace.delete",
        "workspace.rename",
        "workspace.list",
        "workspace.search",
        "git.write",
        "process.propose",
        "process.exec",
        "network.egress",
        "secret.read",
        "config.modify",
        "kernel.modify",
        "web.search",
        "context.assemble",
        "plan.review",
        "policy.inspect",
        "evidence.query",
        "permission.preflight",
        "validation.read",
        "reviewgate.evaluate",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn known_hooks() -> BTreeSet<String> {
    ["driver.plan.enter", "kernel.plan_review.preflight"]
        .into_iter()
        .map(str::to_string)
        .collect()
}

fn validation_error<T>(
    code: impl Into<String>,
    message: impl Into<String>,
) -> WorkflowDescriptorResult<T> {
    Err(WorkflowDescriptorError::validation(code, message))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::descriptor::{
        WorkflowStateDescriptor, WorkflowStateKind, WorkflowTransitionDescriptor,
    };
    use crate::proposal::InvalidProposalPolicy;
    use crate::template::builtin_plan_check_complete_review;
    use serde_json::json;

    fn validator() -> DescriptorValidator {
        DescriptorValidator::default()
    }

    fn error_code(error: WorkflowDescriptorError) -> String {
        error.code
    }

    #[test]
    fn accepts_default_workflow_descriptor() {
        validator()
            .validate(&builtin_plan_check_complete_review())
            .unwrap();
    }

    #[test]
    fn rejects_duplicate_state() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.states.push(descriptor.states[0].clone());

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "duplicate_state"
        );
    }

    #[test]
    fn rejects_missing_initial_state() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.initial_state = "missing".to_string();

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "missing_initial_state"
        );
    }

    #[test]
    fn rejects_unknown_transition_target() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.transitions[0].to = "unknown".to_string();

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "unknown_transition_state"
        );
    }

    #[test]
    fn rejects_no_terminal_state() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.terminal_states.clear();

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "terminal_states_required"
        );
    }

    #[test]
    fn rejects_unreachable_state() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.states.push(WorkflowStateDescriptor {
            id: "orphan".to_string(),
            kind: WorkflowStateKind::Terminal,
            allowed_capabilities: Vec::new(),
            allowed_proposals: Vec::new(),
            entry_hooks: Vec::new(),
            exit_predicates: Vec::new(),
            invalid_proposal_policy: InvalidProposalPolicy::Reject,
        });
        descriptor.terminal_states.push("orphan".to_string());

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "unreachable_state"
        );
    }

    #[test]
    fn rejects_unknown_capability() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.states[0]
            .allowed_capabilities
            .push("workspace.fly".to_string());

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "unknown_capability"
        );
    }

    #[test]
    fn rejects_script_hook() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.states[0]
            .entry_hooks
            .push("shell:cargo test".to_string());

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "unsafe_hook"
        );
    }

    #[test]
    fn rejects_forbidden_predicate() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.transitions[0].when[0].predicate = "llm_says_done".to_string();

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "forbidden_predicate"
        );
    }

    #[test]
    fn rejects_unknown_predicate() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.transitions[0].when[0].predicate = "unknown.predicate".to_string();

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "unknown_predicate"
        );
    }

    #[test]
    fn rejects_unbounded_self_loop() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.transitions.push(WorkflowTransitionDescriptor {
            from: "complete".to_string(),
            to: "complete".to_string(),
            when: vec![PredicateExpr {
                predicate: "validation.failed".to_string(),
                args: serde_json::Value::Null,
            }],
        });

        assert_eq!(
            error_code(validator().validate(&descriptor).unwrap_err()),
            "unbounded_self_loop"
        );
    }

    #[test]
    fn allows_review_to_complete_user_replan_loop() {
        let descriptor = builtin_plan_check_complete_review();

        assert!(descriptor
            .transitions
            .iter()
            .any(|transition| transition.from == "review" && transition.to == "complete"));
        validator().validate(&descriptor).unwrap();
    }

    #[test]
    fn unknown_proposal_kind_fails_to_parse() {
        let yaml = r#"
schema_version: "1.0.0"
id: invalid-proposal
title: Invalid Proposal
initial_state: plan
terminal_states: [done]
states:
  - id: plan
    kind: llm
    allowed_proposals: [NotAProposal]
    invalid_proposal_policy: reject
  - id: done
    kind: terminal
    invalid_proposal_policy: reject
transitions:
  - from: plan
    to: done
    when:
      - predicate: user.accepted
"#;

        assert!(WorkflowDescriptor::from_yaml_str(yaml).is_err());
    }

    #[test]
    fn rejects_shell_like_predicate_args_only_when_hook_or_predicate_is_executable() {
        let mut descriptor = builtin_plan_check_complete_review();
        descriptor.transitions[0].when[0].args = json!({"kinds": ["PlanDraft"]});

        validator().validate(&descriptor).unwrap();
    }
}
