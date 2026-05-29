use deepcode_kernel_policy::Capability;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillTrustMode {
    Declarative,
    BrokeredScript,
    DirectHostScript,
}

impl SkillTrustMode {
    pub fn is_v1_runtime_enabled(&self) -> bool {
        matches!(self, Self::Declarative | Self::BrokeredScript)
    }

    pub fn requires_kernel_broker(&self) -> bool {
        matches!(self, Self::BrokeredScript)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTrustRecord {
    pub skill_id: String,
    pub script_hash: Option<String>,
    pub approved_capabilities: Vec<Capability>,
    pub approved_at: Option<String>,
    pub approved_by: Option<String>,
    pub trust_mode: SkillTrustMode,
    pub ledger_event_ref: Option<String>,
    pub expires_at: Option<String>,
}

impl SkillTrustRecord {
    pub fn direct_host_placeholder(skill_id: impl Into<String>) -> Self {
        Self {
            skill_id: skill_id.into(),
            script_hash: None,
            approved_capabilities: Vec::new(),
            approved_at: None,
            approved_by: None,
            trust_mode: SkillTrustMode::DirectHostScript,
            ledger_event_ref: None,
            expires_at: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_host_script_is_not_v1_runtime_enabled() {
        let record = SkillTrustRecord::direct_host_placeholder("skill.direct-host");

        assert_eq!(record.trust_mode, SkillTrustMode::DirectHostScript);
        assert!(!record.trust_mode.is_v1_runtime_enabled());
        assert!(!record.trust_mode.requires_kernel_broker());
    }

    #[test]
    fn brokered_script_requires_kernel_broker() {
        assert!(SkillTrustMode::BrokeredScript.is_v1_runtime_enabled());
        assert!(SkillTrustMode::BrokeredScript.requires_kernel_broker());
    }
}
