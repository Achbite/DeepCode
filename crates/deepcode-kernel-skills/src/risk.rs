use deepcode_kernel_policy::RiskLevel;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRiskReport {
    pub skill_id: String,
    pub script_hash: Option<String>,
    pub findings: Vec<SkillRiskFinding>,
    pub requires_user_approval: bool,
    pub static_analysis_boundary: String,
}

impl SkillRiskReport {
    pub fn highest_risk(&self) -> Option<RiskLevel> {
        self.findings.iter().fold(None, |current, finding| {
            Some(match current {
                None => finding.severity.clone(),
                Some(value) if risk_rank(&finding.severity) > risk_rank(&value) => {
                    finding.severity.clone()
                }
                Some(value) => value,
            })
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRiskFinding {
    pub kind: RiskFindingKind,
    pub severity: RiskLevel,
    pub message: String,
    pub evidence: Option<String>,
}

impl SkillRiskFinding {
    pub fn new(
        kind: RiskFindingKind,
        severity: RiskLevel,
        message: impl Into<String>,
        evidence: Option<String>,
    ) -> Self {
        Self {
            kind,
            severity,
            message: message.into(),
            evidence,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RiskFindingKind {
    DirectHostDisabled,
    WorkspaceWrite,
    NetworkAccess,
    SecretAccess,
    ProcessExecution,
    EnvExposure,
    PathTraversal,
    TempPath,
    DangerousCommand,
    GitMutation,
}

fn risk_rank(level: &RiskLevel) -> u8 {
    match level {
        RiskLevel::Low => 1,
        RiskLevel::Medium => 2,
        RiskLevel::High => 3,
        RiskLevel::Critical => 4,
    }
}
