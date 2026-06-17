use crate::{ActionBundleDraft, PlanContract};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

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

pub type ProposalReviewStatus = PlanReviewStatus;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewFinding {
    pub code: String,
    pub message: String,
}

pub type ProposalReviewFinding = PlanReviewFinding;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewInput {
    pub plan: PlanContract,
    #[serde(default)]
    pub action_bundle: Option<ActionBundleDraft>,
}

pub type ProposalReviewInput = PlanReviewInput;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewReport {
    pub plan_id: String,
    pub status: PlanReviewStatus,
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub required_permissions: Vec<String>,
    #[serde(default)]
    pub permission_gaps: Vec<String>,
    #[serde(default)]
    pub hard_floor_hits: Vec<String>,
    #[serde(default)]
    pub denied_reasons: Vec<String>,
    #[serde(default)]
    pub blocked_reasons: Vec<String>,
    #[serde(default)]
    pub findings: Vec<PlanReviewFinding>,
    pub kernel_generated_permission_summary: String,
}

pub type ProposalReviewReport = PlanReviewReport;

impl PlanReviewReport {
    pub fn denied(plan_id: impl Into<String>, reason: impl Into<String>) -> Self {
        let reason = reason.into();
        Self {
            plan_id: plan_id.into(),
            status: PlanReviewStatus::Denied,
            required_capabilities: Vec::new(),
            required_permissions: Vec::new(),
            permission_gaps: Vec::new(),
            hard_floor_hits: Vec::new(),
            denied_reasons: vec![reason.clone()],
            blocked_reasons: vec![reason],
            findings: Vec::new(),
            kernel_generated_permission_summary:
                "Kernel preflight: status=denied; capabilities=none; permissionGaps=none; hardFloor=none.".to_string(),
        }
    }

    pub fn interface_only(plan: &PlanContract) -> Self {
        Self {
            plan_id: plan.id.clone(),
            status: PlanReviewStatus::InterfaceOnly,
            required_capabilities: sorted(plan.required_capabilities.iter().cloned()),
            required_permissions: Vec::new(),
            permission_gaps: Vec::new(),
            hard_floor_hits: Vec::new(),
            denied_reasons: Vec::new(),
            blocked_reasons: vec![
                "PlanReviewGate is an interface placeholder; structured preflight is available through DefaultPlanReviewEngine.".to_string(),
            ],
            findings: Vec::new(),
            kernel_generated_permission_summary:
                "Kernel preflight: status=interfaceOnly; capabilities=notEvaluated; permissionGaps=notEvaluated; hardFloor=notEvaluated.".to_string(),
        }
    }
}

pub trait PlanReviewEngine {
    fn review_plan(&self, plan: &PlanContract) -> PlanReviewReport;

    fn review_input(&self, input: PlanReviewInput) -> PlanReviewReport {
        self.review_plan(&input.plan)
    }
}

pub trait ProposalReviewEngine: PlanReviewEngine {}

impl<T> ProposalReviewEngine for T where T: PlanReviewEngine {}

#[derive(Debug, Clone, Default)]
pub struct DefaultPlanReviewEngine;

pub type DefaultProposalReviewEngine = DefaultPlanReviewEngine;

impl PlanReviewEngine for DefaultPlanReviewEngine {
    fn review_plan(&self, plan: &PlanContract) -> PlanReviewReport {
        self.review_input(PlanReviewInput {
            plan: plan.clone(),
            action_bundle: None,
        })
    }

    fn review_input(&self, input: PlanReviewInput) -> PlanReviewReport {
        review_structured_plan(input)
    }
}

fn review_structured_plan(input: PlanReviewInput) -> PlanReviewReport {
    let mut capabilities = BTreeSet::new();
    for capability in &input.plan.required_capabilities {
        capabilities.insert(capability.clone());
    }
    if let Some(bundle) = &input.action_bundle {
        for action in &bundle.actions {
            capabilities.insert(action.capability.clone());
        }
    }
    let required_capabilities = sorted(capabilities.into_iter());

    let mut hard_floor_hits = Vec::new();
    let mut denied_reasons = Vec::new();
    let mut permission_gaps = Vec::new();
    let mut findings = Vec::new();

    for capability in &required_capabilities {
        if hard_floor_capability(capability) {
            hard_floor_hits.push(capability.clone());
            denied_reasons.push(format!("capability {capability} is blocked by hard floor"));
            continue;
        }
        if !known_capability(capability) {
            denied_reasons.push(format!("unknown capability {capability}"));
            continue;
        }
        if permission_gap_capability(capability) {
            permission_gaps.push(capability.clone());
        }
    }

    if input.plan.completion_criteria.is_empty()
        || input
            .plan
            .completion_criteria
            .iter()
            .any(|criteria| criteria.evidence_required.is_empty())
    {
        findings.push(PlanReviewFinding {
            code: "completion_evidence_required".to_string(),
            message: "completion criteria must declare evidence requirements".to_string(),
        });
    }

    let status = if !denied_reasons.is_empty() || !hard_floor_hits.is_empty() {
        PlanReviewStatus::Denied
    } else if !findings.is_empty() {
        PlanReviewStatus::NeedsRevision
    } else if !permission_gaps.is_empty() {
        PlanReviewStatus::AwaitingTemporaryGrant
    } else if input.plan.requires_user_approval {
        PlanReviewStatus::AwaitingUserApproval
    } else {
        PlanReviewStatus::AutoAccepted
    };

    let required_permissions = permission_gaps
        .iter()
        .map(|capability| format!("temporaryGrant:{capability}"))
        .collect::<Vec<_>>();
    let blocked_reasons = denied_reasons
        .iter()
        .cloned()
        .chain(findings.iter().map(|finding| finding.message.clone()))
        .collect::<Vec<_>>();

    PlanReviewReport {
        plan_id: input.plan.id,
        kernel_generated_permission_summary: permission_summary(
            &status,
            &required_capabilities,
            &permission_gaps,
            &hard_floor_hits,
        ),
        status,
        required_capabilities,
        required_permissions,
        permission_gaps,
        hard_floor_hits,
        denied_reasons,
        blocked_reasons,
        findings,
    }
}

fn permission_summary(
    status: &PlanReviewStatus,
    capabilities: &[String],
    permission_gaps: &[String],
    hard_floor_hits: &[String],
) -> String {
    format!(
        "Kernel preflight: status={}; capabilities={}; permissionGaps={}; hardFloor={}.",
        status_name(status),
        list_or_none(capabilities),
        list_or_none(permission_gaps),
        list_or_none(hard_floor_hits)
    )
}

fn status_name(status: &PlanReviewStatus) -> &'static str {
    match status {
        PlanReviewStatus::AutoAccepted => "autoAccepted",
        PlanReviewStatus::AwaitingUserApproval => "awaitingUserApproval",
        PlanReviewStatus::AwaitingTemporaryGrant => "awaitingTemporaryGrant",
        PlanReviewStatus::Denied => "denied",
        PlanReviewStatus::NeedsRevision => "needsRevision",
        PlanReviewStatus::InterfaceOnly => "interfaceOnly",
    }
}

fn list_or_none(values: &[String]) -> String {
    if values.is_empty() {
        "none".to_string()
    } else {
        values.join(",")
    }
}

fn sorted(values: impl Iterator<Item = String>) -> Vec<String> {
    values.collect::<BTreeSet<_>>().into_iter().collect()
}

fn known_capability(capability: &str) -> bool {
    matches!(
        capability,
        "workspace.read"
            | "workspace.preview_diff"
            | "workspace.write"
            | "workspace.create"
            | "workspace.delete"
            | "workspace.rename"
            | "workspace.list"
            | "workspace.search"
            | "code.search"
            | "git.read"
            | "git.write"
            | "git.push"
            | "browser.control"
            | "process.propose"
            | "process.exec"
            | "network.egress"
            | "secret.read"
            | "web.search"
            | "context.assemble"
            | "plan.review"
            | "policy.inspect"
            | "evidence.query"
            | "permission.preflight"
            | "validation.read"
            | "reviewgate.evaluate"
            | "config.modify"
            | "kernel.modify"
    )
}

fn permission_gap_capability(capability: &str) -> bool {
    matches!(
        capability,
        "workspace.write"
            | "workspace.create"
            | "workspace.delete"
            | "workspace.rename"
            | "git.write"
            | "git.push"
            | "browser.control"
            | "process.exec"
            | "network.egress"
            | "secret.read"
    )
}

fn hard_floor_capability(capability: &str) -> bool {
    matches!(capability, "kernel.modify" | "config.modify")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ActionBundleDraft, PlannedAction, ValidationExpectation};

    #[test]
    fn default_plan_review_engine_auto_accepts_read_only_plan() {
        let plan = PlanContract::low_risk_direct("plan-1", "inspect workspace");
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.plan_id, "plan-1");
        assert_eq!(report.status, PlanReviewStatus::AutoAccepted);
        assert_eq!(report.required_capabilities, vec!["workspace.read"]);
        assert!(report.permission_gaps.is_empty());
        assert!(report
            .kernel_generated_permission_summary
            .contains("status=autoAccepted"));
    }

    #[test]
    fn write_process_network_and_secret_create_permission_gaps() {
        for capability in [
            "workspace.write",
            "process.exec",
            "network.egress",
            "secret.read",
        ] {
            let mut plan = PlanContract::low_risk_direct("plan-gap", "gap");
            plan.required_capabilities = vec![capability.to_string()];
            let report = DefaultPlanReviewEngine.review_plan(&plan);
            assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
            assert_eq!(report.permission_gaps, vec![capability]);
            assert_eq!(
                report.required_permissions,
                vec![format!("temporaryGrant:{capability}")]
            );
        }
    }

    #[test]
    fn unknown_capability_is_denied() {
        let mut plan = PlanContract::low_risk_direct("plan-unknown", "unknown");
        plan.required_capabilities = vec!["workspace.fly".to_string()];
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::Denied);
        assert!(report.denied_reasons[0].contains("unknown capability"));
    }

    #[test]
    fn hard_floor_capability_is_denied() {
        let mut plan = PlanContract::low_risk_direct("plan-hard-floor", "hard floor");
        plan.required_capabilities = vec!["kernel.modify".to_string()];
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::Denied);
        assert_eq!(report.hard_floor_hits, vec!["kernel.modify"]);
    }

    #[test]
    fn explicit_user_approval_waits_for_user_when_no_permission_gap() {
        let mut plan = PlanContract::low_risk_direct("plan-user", "needs user");
        plan.requires_user_approval = true;
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::AwaitingUserApproval);
    }

    #[test]
    fn missing_evidence_needs_revision() {
        let mut plan = PlanContract::low_risk_direct("plan-evidence", "needs evidence");
        plan.completion_criteria[0].evidence_required.clear();
        let report = DefaultPlanReviewEngine.review_plan(&plan);

        assert_eq!(report.status, PlanReviewStatus::NeedsRevision);
        assert_eq!(report.findings[0].code, "completion_evidence_required");
    }

    #[test]
    fn action_bundle_capabilities_are_reviewed_without_copying_llm_text() {
        let plan = PlanContract::low_risk_direct("plan-bundle", "bundle");
        let bundle = ActionBundleDraft {
            id: "bundle-1".to_string(),
            goal: "bundle".to_string(),
            actions: vec![PlannedAction {
                id: "action-1".to_string(),
                title: "LLM says admin permission is needed".to_string(),
                capability: "workspace.write".to_string(),
                resource_scope: vec!["src".to_string()],
                can_parallelize: false,
                conflict_keys: Vec::new(),
                purpose: None,
            }],
            validation_expectations: vec![ValidationExpectation {
                id: "check-1".to_string(),
                description: "file exists".to_string(),
                command: None,
            }],
            review_expectations: Vec::new(),
        };
        let report = DefaultPlanReviewEngine.review_input(PlanReviewInput {
            plan,
            action_bundle: Some(bundle),
        });

        assert_eq!(report.status, PlanReviewStatus::AwaitingTemporaryGrant);
        assert_eq!(report.permission_gaps, vec!["workspace.write"]);
        assert!(!report
            .kernel_generated_permission_summary
            .contains("admin permission"));
    }
}
