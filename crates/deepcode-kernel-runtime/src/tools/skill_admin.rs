use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn host_skill_discover(
        &self,
        request_id: RequestId,
    ) -> KernelResult<Vec<KernelEvent>> {
        let skills = self
            .user_skill_registry
            .list()?
            .into_iter()
            .map(host_skill_descriptor)
            .collect();
        Ok(vec![KernelEvent::HostSkillsDiscovered {
            request_id,
            result: HostSkillCatalogResult {
                source: HostResultSource::HostManagement,
                skills,
            },
        }])
    }

    pub(crate) fn host_skill_trust_decision_submit(
        &mut self,
        request_id: RequestId,
        skill_id: String,
        decision: HostSkillTrustDecisionSubmit,
    ) -> KernelResult<Vec<KernelEvent>> {
        let trust_mode = match decision.trust_mode {
            HostSkillTrustMode::Declarative => SkillTrustMode::Declarative,
            HostSkillTrustMode::BrokeredScript => SkillTrustMode::BrokeredScript,
        };
        let approved_capabilities = decision
            .approved_capabilities
            .iter()
            .map(deepcode_kernel_policy::Capability::new)
            .collect::<Vec<_>>();

        if decision.decision == HostSkillTrustDecisionKind::Accept {
            let record = SkillTrustRecord {
                skill_id: skill_id.clone(),
                revision_hash: decision.revision_hash.clone(),
                approved_capabilities: approved_capabilities.clone(),
                approved_at: decision.approved_at.clone(),
                approved_by: decision.approved_by.clone(),
                trust_mode,
                ledger_event_ref: None,
                expires_at: decision.expires_at.clone(),
            };
            self.state
                .skill_trust_records
                .retain(|existing| existing.skill_id != skill_id);
            self.state.skill_trust_records.push(record);
        }

        let record = HostSkillTrustDecisionRecord {
            skill_id: skill_id.clone(),
            decision: decision.decision,
            trust_mode: decision.trust_mode,
            revision_hash: decision.revision_hash,
            approved_capabilities: decision.approved_capabilities,
            approved_at: decision.approved_at,
            approved_by: decision.approved_by,
            expires_at: decision.expires_at,
        };
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-host-skill-trust-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "host.skill_trust_decision_recorded".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": format!("Host skill trust decision recorded: {skill_id}"),
                "record": &record
            }),
            created_at: None,
        })?;
        Ok(vec![KernelEvent::HostSkillTrustDecisionRecorded {
            request_id,
            record,
            sequence: Some(sequence),
        }])
    }
}

fn host_skill_descriptor(descriptor: SkillDescriptor) -> HostSkillDescriptor {
    HostSkillDescriptor {
        id: descriptor.id,
        version: descriptor.version,
        title_key: descriptor.title_key,
        description_key: descriptor.description_key,
        input_schema: descriptor.input_schema,
        output_schema: descriptor.output_schema,
        required_capabilities: descriptor
            .required_capabilities
            .into_iter()
            .map(|capability| capability.0)
            .collect(),
        allowed_phases: descriptor.allowed_phases,
        risk_level: host_skill_risk_level(descriptor.risk_level),
        effects: descriptor
            .effects
            .into_iter()
            .map(host_skill_effect)
            .collect(),
        source: host_skill_source(descriptor.source),
        adapter_kind: host_skill_adapter_kind(descriptor.adapter_kind),
        activation_status: host_skill_activation_status(descriptor.activation_status),
        requested_model_visible: descriptor.requested_model_visible,
    }
}

fn host_skill_risk_level(level: deepcode_kernel_policy::RiskLevel) -> HostSkillRiskLevel {
    match level {
        deepcode_kernel_policy::RiskLevel::Low => HostSkillRiskLevel::Low,
        deepcode_kernel_policy::RiskLevel::Medium => HostSkillRiskLevel::Medium,
        deepcode_kernel_policy::RiskLevel::High => HostSkillRiskLevel::High,
        deepcode_kernel_policy::RiskLevel::Critical => HostSkillRiskLevel::Critical,
    }
}

fn host_skill_effect(effect: deepcode_kernel_policy::CapabilityEffect) -> HostSkillEffect {
    match effect {
        deepcode_kernel_policy::CapabilityEffect::ReadsWorkspace => HostSkillEffect::ReadsWorkspace,
        deepcode_kernel_policy::CapabilityEffect::WritesWorkspace => {
            HostSkillEffect::WritesWorkspace
        }
        deepcode_kernel_policy::CapabilityEffect::CreatesWorkspace => {
            HostSkillEffect::CreatesWorkspace
        }
        deepcode_kernel_policy::CapabilityEffect::DeletesWorkspace => {
            HostSkillEffect::DeletesWorkspace
        }
        deepcode_kernel_policy::CapabilityEffect::ReadsGit => HostSkillEffect::ReadsGit,
        deepcode_kernel_policy::CapabilityEffect::RunsProcess => HostSkillEffect::RunsProcess,
        deepcode_kernel_policy::CapabilityEffect::UsesNetwork => HostSkillEffect::UsesNetwork,
        deepcode_kernel_policy::CapabilityEffect::ReadsSecret => HostSkillEffect::ReadsSecret,
        deepcode_kernel_policy::CapabilityEffect::ModifiesGit => HostSkillEffect::ModifiesGit,
        deepcode_kernel_policy::CapabilityEffect::PushesGit => HostSkillEffect::PushesGit,
        deepcode_kernel_policy::CapabilityEffect::ControlsBrowser => {
            HostSkillEffect::ControlsBrowser
        }
        deepcode_kernel_policy::CapabilityEffect::ModifiesKernel => HostSkillEffect::ModifiesKernel,
        deepcode_kernel_policy::CapabilityEffect::ModifiesConfig => HostSkillEffect::ModifiesConfig,
    }
}

fn host_skill_source(source: deepcode_kernel_skills::SkillSource) -> HostSkillSource {
    match source {
        deepcode_kernel_skills::SkillSource::LocalPack { pack_id } => {
            HostSkillSource::LocalPack { pack_id }
        }
        deepcode_kernel_skills::SkillSource::ExternalProcess { program, argv } => {
            HostSkillSource::ExternalProcess { program, argv }
        }
        deepcode_kernel_skills::SkillSource::ExternalConnector { connector_id } => {
            HostSkillSource::ExternalConnector { connector_id }
        }
    }
}

fn host_skill_adapter_kind(kind: deepcode_kernel_skills::SkillAdapterKind) -> HostSkillAdapterKind {
    match kind {
        deepcode_kernel_skills::SkillAdapterKind::Declarative => HostSkillAdapterKind::Declarative,
        deepcode_kernel_skills::SkillAdapterKind::ExternalProcess => {
            HostSkillAdapterKind::ExternalProcess
        }
        deepcode_kernel_skills::SkillAdapterKind::Mcp => HostSkillAdapterKind::Mcp,
    }
}

fn host_skill_activation_status(
    status: deepcode_kernel_skills::SkillActivationStatus,
) -> HostSkillActivationStatus {
    match status {
        deepcode_kernel_skills::SkillActivationStatus::Dormant => {
            HostSkillActivationStatus::Dormant
        }
        deepcode_kernel_skills::SkillActivationStatus::Registered => {
            HostSkillActivationStatus::Registered
        }
    }
}
