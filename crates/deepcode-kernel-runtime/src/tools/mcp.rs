use super::*;

impl DeepCodeKernelRuntime {
    pub(crate) fn host_mcp_risk_decision_submit(
        &mut self,
        request_id: RequestId,
        connector_id: String,
        binding_id: Option<String>,
        decision: HostMcpRiskDecisionSubmit,
    ) -> KernelResult<Vec<KernelEvent>> {
        let record = HostMcpRiskDecisionRecord {
            connector_id,
            binding_id,
            decision: decision.decision,
            revision_hash: decision.revision_hash,
            acknowledged_by: decision.acknowledged_by,
            acknowledged_at: decision.acknowledged_at,
            risk_level: decision.risk_level,
            permission_granted: false,
        };
        self.state.mcp_risk_acknowledgments.push(record.clone());
        let sequence = self.ledger.list_all()?.len() as u64 + 1;
        self.ledger.append(LedgerEvent {
            id: format!("evt-host-mcp-risk-decision-{sequence}"),
            run_id: None,
            session_id: None,
            kind: "host.mcp_risk_decision_recorded".to_string(),
            sequence: Some(sequence),
            payload: serde_json::json!({
                "summary": "Host MCP risk decision recorded",
                "record": &record
            }),
            created_at: None,
        })?;
        Ok(vec![KernelEvent::HostMcpRiskDecisionRecorded {
            request_id,
            record,
            sequence: Some(sequence),
        }])
    }
}
