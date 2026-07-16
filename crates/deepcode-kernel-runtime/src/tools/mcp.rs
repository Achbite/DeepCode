use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn mcp_risk_acknowledgment_submit(
        &mut self,
        request_id: RequestId,
        connector_id: String,
        binding_id: Option<String>,
        acknowledgment: Value,
    ) -> KernelResult<Vec<KernelEvent>> {
        let decision = acknowledgment
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("acknowledge");
        let record = serde_json::json!({
            "connectorId": connector_id,
            "bindingId": binding_id,
            "decision": decision,
            "revisionHash": get_string(&acknowledgment, "revisionHash"),
            "acknowledgedBy": get_string(&acknowledgment, "acknowledgedBy"),
            "acknowledgedAt": get_string(&acknowledgment, "acknowledgedAt"),
            "riskLevel": acknowledgment.get("riskLevel").cloned().unwrap_or_else(|| serde_json::json!("medium")),
            "permissionGranted": false,
            "boundary": "MCP risk acknowledgment records user understanding only; it does not grant workspace, shell, network, or secret permission."
        });
        self.state.mcp_risk_acknowledgments.push(record.clone());
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-mcp-risk-ack-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "mcp.risk_acknowledgment_recorded".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": "MCP risk acknowledgment recorded",
                "record": &record
            }),
            created_at: None,
        })?;
        Ok(vec![KernelEvent::SkillResult {
            request_id,
            skill_id: Some("mcp.risk_acknowledgment".to_string()),
            ok: true,
            output: Some(record),
            error: None,
            sequence: Some(sequence),
        }])
    }
}
