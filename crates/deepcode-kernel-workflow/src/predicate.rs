use crate::proposal::ProposalKind;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;

pub type PredicateId = String;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct PredicateExpr {
    pub predicate: PredicateId,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PredicateRegistry {
    known: BTreeSet<String>,
    forbidden: BTreeSet<String>,
}

impl Default for PredicateRegistry {
    fn default() -> Self {
        let known = [
            "proposal.kind.in",
            "plan_review.ready",
            "plan_review.blocked",
            "permission.pending",
            "permission.denied",
            "permission.preflight_satisfied",
            "tool_call.failed.count_gte",
            "tool_call.success.count_gte",
            "validation.succeeded",
            "validation.failed",
            "review.ready_for_user",
            "user.accepted",
            "user.rejected",
            "user.replan_requested",
            "temp_lease.all_released",
            "risk_budget.exhausted",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        let forbidden = [
            "llm_says_done",
            "model_claims_test_passed",
            "assistant_final_answer_exists",
            "natural_language_contains_done",
        ]
        .into_iter()
        .map(str::to_string)
        .collect();
        Self { known, forbidden }
    }
}

impl PredicateRegistry {
    pub fn is_known(&self, predicate: &str) -> bool {
        self.known.contains(predicate)
    }

    pub fn is_forbidden(&self, predicate: &str) -> bool {
        self.forbidden.contains(predicate)
    }

    pub fn evaluates_from_proposal(&self, predicate: &PredicateExpr) -> bool {
        predicate.predicate == "proposal.kind.in"
    }

    pub fn evaluate_proposal_kind_in(
        &self,
        predicate: &PredicateExpr,
        proposal_kind: &ProposalKind,
    ) -> bool {
        if predicate.predicate != "proposal.kind.in" {
            return false;
        }
        predicate
            .args
            .get("kinds")
            .and_then(Value::as_array)
            .map(|kinds| {
                kinds
                    .iter()
                    .filter_map(Value::as_str)
                    .any(|kind| kind == proposal_kind.as_str())
            })
            .unwrap_or(false)
    }
}
