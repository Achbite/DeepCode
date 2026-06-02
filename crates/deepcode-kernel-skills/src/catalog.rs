use crate::{SkillDescriptor, SkillSource, SkillTrustRecord};
use deepcode_kernel_policy::{Capability, RiskLevel};

pub fn model_visible_skill_descriptors(
    descriptors: &[SkillDescriptor],
    trust_records: &[SkillTrustRecord],
    effective_capabilities: &[Capability],
) -> Vec<SkillDescriptor> {
    descriptors
        .iter()
        .filter(|descriptor| {
            descriptor.model_visible
                && match descriptor.source {
                    SkillSource::Builtin => true,
                    SkillSource::LocalPack { .. } => {
                        safe_declarative_descriptor(descriptor)
                            || external_descriptor_is_trusted(
                                descriptor,
                                trust_records,
                                effective_capabilities,
                            )
                    }
                    _ => external_descriptor_is_trusted(
                        descriptor,
                        trust_records,
                        effective_capabilities,
                    ),
                }
        })
        .cloned()
        .collect()
}

fn safe_declarative_descriptor(descriptor: &SkillDescriptor) -> bool {
    descriptor.required_capabilities.is_empty()
        && descriptor.effects.is_empty()
        && descriptor.risk_level == RiskLevel::Low
}

fn external_descriptor_is_trusted(
    descriptor: &SkillDescriptor,
    trust_records: &[SkillTrustRecord],
    effective_capabilities: &[Capability],
) -> bool {
    let Some(record) = trust_records
        .iter()
        .find(|record| record.skill_id == descriptor.id)
    else {
        return false;
    };
    if !record.trust_mode.is_v1_runtime_enabled() {
        return false;
    }
    capabilities_cover(
        &record.approved_capabilities,
        &descriptor.required_capabilities,
    ) && capabilities_cover(effective_capabilities, &descriptor.required_capabilities)
}

fn capabilities_cover(available: &[Capability], required: &[Capability]) -> bool {
    required
        .iter()
        .all(|capability| available.contains(capability))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{builtin, SkillExecutorKind, SkillTrustMode};
    use deepcode_kernel_policy::{CapabilityEffect, RiskLevel};

    fn external_descriptor(id: &str, capability: Capability) -> SkillDescriptor {
        SkillDescriptor {
            id: id.to_string(),
            version: "1".to_string(),
            title_key: None,
            description_key: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: serde_json::json!({ "type": "object" }),
            required_capabilities: vec![capability],
            allowed_phases: vec!["complete".to_string()],
            risk_level: RiskLevel::High,
            effects: vec![CapabilityEffect::UsesNetwork],
            source: SkillSource::ExternalProcess {
                command: "python3 skill.py".to_string(),
            },
            executor_kind: SkillExecutorKind::ExternalProcess,
            model_visible: true,
        }
    }

    fn declarative_descriptor() -> SkillDescriptor {
        SkillDescriptor {
            id: "fixture.text.echo".to_string(),
            version: "1".to_string(),
            title_key: None,
            description_key: None,
            input_schema: serde_json::json!({ "type": "object" }),
            output_schema: serde_json::json!({ "type": "object" }),
            required_capabilities: Vec::new(),
            allowed_phases: vec!["plan".to_string(), "complete".to_string()],
            risk_level: RiskLevel::Low,
            effects: Vec::new(),
            source: SkillSource::LocalPack {
                pack_id: "fixture.text".to_string(),
            },
            executor_kind: SkillExecutorKind::LocalPack,
            model_visible: true,
        }
    }

    fn trust_record(skill_id: &str, trust_mode: SkillTrustMode) -> SkillTrustRecord {
        SkillTrustRecord {
            skill_id: skill_id.to_string(),
            script_hash: Some("sha256:abc".to_string()),
            approved_capabilities: vec![Capability::network_egress()],
            approved_at: Some("2026-06-01T00:00:00Z".to_string()),
            approved_by: Some("user".to_string()),
            trust_mode,
            ledger_event_ref: Some("evt-1".to_string()),
            expires_at: None,
        }
    }

    #[test]
    fn builtins_follow_model_visible_flag() {
        let descriptors = vec![
            builtin(
                "fs.read",
                "skill.fs.read.description",
                Capability::workspace_read(),
                RiskLevel::Low,
                vec![CapabilityEffect::ReadsWorkspace],
                vec!["plan"],
                true,
            ),
            builtin(
                "fs.delete",
                "skill.fs.delete.description",
                Capability::workspace_delete(),
                RiskLevel::Critical,
                vec![CapabilityEffect::DeletesWorkspace],
                vec!["complete"],
                false,
            ),
        ];

        let visible = model_visible_skill_descriptors(&descriptors, &[], &[]);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "fs.read");
    }

    #[test]
    fn external_skill_is_hidden_until_trusted_and_capability_covered() {
        let descriptor =
            external_descriptor("external.github.search", Capability::network_egress());
        assert!(model_visible_skill_descriptors(
            &[descriptor.clone()],
            &[],
            &[Capability::network_egress()]
        )
        .is_empty());

        let visible = model_visible_skill_descriptors(
            &[descriptor.clone()],
            &[trust_record(&descriptor.id, SkillTrustMode::BrokeredScript)],
            &[Capability::network_egress()],
        );
        assert_eq!(visible.len(), 1);

        let visible_without_profile_capability = model_visible_skill_descriptors(
            &[descriptor.clone()],
            &[trust_record(&descriptor.id, SkillTrustMode::BrokeredScript)],
            &[],
        );
        assert!(visible_without_profile_capability.is_empty());
    }

    #[test]
    fn safe_declarative_local_pack_is_visible_without_trust_record() {
        let visible = model_visible_skill_descriptors(&[declarative_descriptor()], &[], &[]);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, "fixture.text.echo");
    }

    #[test]
    fn direct_host_trust_record_stays_hidden() {
        let descriptor = external_descriptor("external.direct", Capability::network_egress());
        let visible = model_visible_skill_descriptors(
            &[descriptor.clone()],
            &[trust_record(
                &descriptor.id,
                SkillTrustMode::DirectHostScript,
            )],
            &[Capability::network_egress()],
        );
        assert!(visible.is_empty());
    }
}
