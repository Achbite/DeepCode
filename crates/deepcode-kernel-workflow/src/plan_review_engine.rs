use crate::PlanContract;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanReviewStatus {
    AutoAccepted,
    AwaitingUserApproval,
    AwaitingTemporaryGrant,
    Denied,
    NeedsRevision,
    InterfaceOnly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewFinding {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewReport {
    pub plan_id: String,
    pub status: PlanReviewStatus,
    pub required_capabilities: Vec<String>,
    pub required_permissions: Vec<String>,
    pub hard_floor_hits: Vec<String>,
    pub blocked_reasons: Vec<String>,
    pub findings: Vec<PlanReviewFinding>,
}

impl PlanReviewReport {
    pub fn interface_only(plan: &PlanContract) -> Self {
        Self {
            plan_id: plan.id.clone(),
            status: PlanReviewStatus::InterfaceOnly,
            required_capabilities: plan.required_capabilities.clone(),
            required_permissions: Vec::new(),
            hard_floor_hits: Vec::new(),
            blocked_reasons: vec![
                "PlanReviewGate is a stage 9 interface placeholder; full permission preflight is implemented in later workflow/session phases.".to_string(),
            ],
            findings: Vec::new(),
        }
    }
}

pub trait PlanReviewEngine {
    fn review_plan(&self, plan: &PlanContract) -> PlanReviewReport;
}

#[derive(Debug, Clone, Default)]
pub struct DefaultPlanReviewEngine;

impl PlanReviewEngine for DefaultPlanReviewEngine {
    fn review_plan(&self, plan: &PlanContract) -> PlanReviewReport {
        PlanReviewReport::interface_only(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_plan_review_engine_is_interface_only() {
        let plan = PlanContract::low_risk_direct("plan-1", "inspect workspace");
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.plan_id, "plan-1");
        assert_eq!(report.status, PlanReviewStatus::InterfaceOnly);
        assert_eq!(report.required_capabilities, vec!["workspace.read"]);
        assert!(report.blocked_reasons[0].contains("stage 9 interface placeholder"));
    }
}
