use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn skill_discover(&self, request_id: RequestId) -> KernelResult<Vec<KernelEvent>> {
        let descriptors = self.skills.list()?;
        let effective_capabilities = self
            .policy_profile
            .grants
            .values()
            .filter(|grant| grant.decision != PolicyDecisionKind::Deny)
            .map(|grant| grant.capability.clone())
            .collect::<Vec<_>>();
        let descriptors = model_visible_skill_descriptors(
            &descriptors,
            &self.state.skill_trust_records,
            &effective_capabilities,
        );
        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: None,
            ok: true,
            output: Some(serde_json::json!({ "skills": descriptors })),
            error: None,
            sequence: None,
        }])
    }

    pub(crate) fn skill_trust_approve(
        &mut self,
        request_id: RequestId,
        skill_id: String,
        decision: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let approval = SkillTrustApprovalDecision::from_value(decision)?;
        if matches!(approval.decision.as_deref(), Some("reject" | "deny")) {
            return Ok(vec![KernelEvent::SkillResult {
                request_id,
                skill_id: Some(skill_id),
                ok: true,
                output: Some(serde_json::json!({ "decision": "rejected" })),
                error: None,
                sequence: None,
            }]);
        }
        if approval.trust_mode == SkillTrustMode::DirectHostScript {
            return Err(KernelError::PermissionDenied(
                "DirectHostScript is not enabled by the active Kernel skill runtime".to_string(),
            ));
        }

        let record = SkillTrustRecord {
            skill_id: skill_id.clone(),
            revision_hash: approval.revision_hash,
            approved_capabilities: approval.approved_capabilities,
            approved_at: approval.approved_at,
            approved_by: approval.approved_by,
            trust_mode: approval.trust_mode,
            ledger_event_ref: None,
            expires_at: approval.expires_at,
        };
        self.state
            .skill_trust_records
            .retain(|existing| existing.skill_id != skill_id);
        self.state.skill_trust_records.push(record.clone());
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-skill-trust-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "skill.trust_granted".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": format!("Skill trust granted: {skill_id}"),
                "skillId": skill_id,
                "trustRecord": &record
            }),
            created_at: None,
        })?;
        Ok(vec![KernelEvent::SkillTrustGranted {
            request_id: Some(request_id),
            skill_id: record.skill_id.clone(),
            trust_record: serde_json::to_value(record).unwrap_or(Value::Null),
            sequence: Some(sequence),
        }])
    }
}
#[derive(Debug)]
struct SkillTrustApprovalDecision {
    decision: Option<String>,
    trust_mode: SkillTrustMode,
    revision_hash: Option<String>,
    approved_capabilities: Vec<deepcode_kernel_policy::Capability>,
    approved_at: Option<String>,
    approved_by: Option<String>,
    expires_at: Option<String>,
}

impl SkillTrustApprovalDecision {
    fn from_value(value: Value) -> KernelResult<Self> {
        let decision = value
            .get("decision")
            .and_then(Value::as_str)
            .map(|value| value.to_ascii_lowercase());
        let trust_mode = value
            .get("trustMode")
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|error| {
                KernelError::InvalidCommand(format!("invalid skill trust mode: {error}"))
            })?
            .unwrap_or(SkillTrustMode::BrokeredScript);
        let approved_capabilities = value
            .get("approvedCapabilities")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(deepcode_kernel_policy::Capability::new)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        Ok(Self {
            decision,
            trust_mode,
            revision_hash: get_string(&value, "revisionHash")
                .or_else(|| get_string(&value, "scriptHash")),
            approved_capabilities,
            approved_at: get_string(&value, "approvedAt"),
            approved_by: get_string(&value, "approvedBy"),
            expires_at: get_string(&value, "expiresAt"),
        })
    }
}
