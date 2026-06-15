use super::*;

#[test]
fn plan_review_and_skill_trust_placeholders_round_trip() {
    let command = KernelCommand::ProposalSubmit {
        request_id: RequestId("req-proposal".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        proposal: ProposalEnvelope {
            schema_version: "deepcode.agent.protocol.v3".to_string(),
            proposal_id: "proposal-1".to_string(),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            source: ProposalEnvelopeSource::Llm,
            kind: ProposalEnvelopeKind::ActionBundle,
            payload: serde_json::json!({
                "actionBundle": { "version": "1", "id": "plan-1", "goal": "review" }
            }),
            referenced_resource_packet_refs: vec![],
            referenced_evidence_refs: vec![],
            parser_diagnostics: None,
        },
    };
    let encoded = serde_json::to_value(&command).expect("serialize proposal submit command");
    assert_eq!(encoded["kind"], "proposalSubmit");
    assert_eq!(encoded["proposal"]["proposalId"], "proposal-1");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize proposal submit command");
    assert_eq!(decoded, command);

    let event = KernelEvent::ProposalReviewed {
        request_id: Some(RequestId("req-proposal-review".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        proposal_id: "proposal-1".to_string(),
        report: serde_json::json!({ "status": "interfaceOnly" }),
        sequence: Some(9),
    };
    let encoded = serde_json::to_value(&event).expect("serialize proposal review event");
    assert_eq!(encoded["kind"], "proposal.reviewed");
    assert_eq!(encoded["report"]["status"], "interfaceOnly");
    let decoded: KernelEvent =
        serde_json::from_value(encoded).expect("deserialize proposal review event");
    assert_eq!(decoded, event);

    let event = KernelEvent::SkillTrustRequested {
        request_id: Some(RequestId("req-skill-trust".to_string())),
        skill_id: "skill.py".to_string(),
        hash: Some("sha256:abc".to_string()),
        request: serde_json::json!({ "trustMode": "brokeredScript" }),
        sequence: Some(10),
    };
    let encoded = serde_json::to_value(&event).expect("serialize skill trust event");
    assert_eq!(encoded["kind"], "skill.trust_requested");
    assert_eq!(encoded["hash"], "sha256:abc");
    let decoded: KernelEvent =
        serde_json::from_value(encoded).expect("deserialize skill trust event");
    assert_eq!(decoded, event);

    let command = KernelCommand::McpRiskAcknowledgmentSubmit {
        request_id: RequestId("req-mcp-risk".to_string()),
        connector_id: "mcp-text-tools".to_string(),
        binding_id: Some("text.uppercase".to_string()),
        acknowledgment: serde_json::json!({ "decision": "acknowledge" }),
    };
    let encoded = serde_json::to_value(&command).expect("serialize mcp risk command");
    assert_eq!(encoded["kind"], "mcpRiskAcknowledgmentSubmit");
    assert_eq!(encoded["connectorId"], "mcp-text-tools");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize mcp risk command");
    assert_eq!(decoded, command);

    let event = KernelEvent::McpRiskAcknowledgmentRequired {
        request_id: Some(RequestId("req-mcp-risk".to_string())),
        connector_id: "mcp-text-tools".to_string(),
        binding_id: Some("text.uppercase".to_string()),
        risk_report: serde_json::json!({ "riskLevel": "medium" }),
        sequence: Some(11),
    };
    let encoded = serde_json::to_value(&event).expect("serialize mcp risk event");
    assert_eq!(encoded["kind"], "mcp.risk_acknowledgment_required");
    assert_eq!(encoded["riskReport"]["riskLevel"], "medium");
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize mcp risk event");
    assert_eq!(decoded, event);
}

#[test]
fn audit_placeholders_round_trip() {
    let command = KernelCommand::AuditVerify {
        request_id: RequestId("req-audit-verify".to_string()),
        scope: serde_json::json!({ "kind": "all" }),
    };
    let encoded = serde_json::to_value(&command).expect("serialize audit verify command");
    assert_eq!(encoded["kind"], "auditVerify");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize audit verify command");
    assert_eq!(decoded, command);

    let command = KernelCommand::AuditQuery {
        request_id: RequestId("req-audit-query".to_string()),
        filter: serde_json::json!({ "runId": "run-1" }),
        projection: Some("redacted".to_string()),
    };
    let encoded = serde_json::to_value(&command).expect("serialize audit query command");
    assert_eq!(encoded["kind"], "auditQuery");
    assert_eq!(encoded["projection"], "redacted");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize audit query command");
    assert_eq!(decoded, command);

    let event = KernelEvent::AuditVerifyCompleted {
        request_id: Some(RequestId("req-audit-verify".to_string())),
        ok: true,
        report: serde_json::json!({ "entriesVerified": 2 }),
        sequence: Some(11),
    };
    let encoded = serde_json::to_value(&event).expect("serialize audit event");
    assert_eq!(encoded["kind"], "audit.verify_completed");
    assert_eq!(encoded["report"]["entriesVerified"], 2);
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize audit event");
    assert_eq!(decoded, event);
}

#[test]
fn workflow_observe_and_decision_event_round_trip() {
    let observed = KernelEvent::ToolCompleted {
        run_id: Some(RunId("run-1".to_string())),
        session_id: Some(SessionId("session-1".to_string())),
        turn_id: None,
        tool_call_id: "tool-1".to_string(),
        tool_name: "fs.list".to_string(),
        ok: true,
        output: Some(serde_json::json!({ "path": "." })),
        error: None,
        sequence: Some(5),
    };
    let command = KernelCommand::WorkflowObserve {
        request_id: RequestId("req-observe".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        event: Box::new(observed.clone()),
    };
    let encoded = serde_json::to_value(&command).expect("serialize observe command");
    assert_eq!(encoded["kind"], "workflowObserve");
    assert_eq!(encoded["event"]["kind"], "tool.completed");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize observe command");
    assert_eq!(decoded, command);

    let event = KernelEvent::WorkflowDecisionMade {
        request_id: Some(RequestId("req-observe".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        decision: WorkflowDecision {
            action: WorkflowDecisionAction::Continue,
            reason: WorkflowDecisionReason::PendingCriticalSteps,
            phase: Some("complete".to_string()),
            pending_steps: vec!["create temp file".to_string()],
            answer_obligations: vec![AnswerObligation {
                id: AnswerObligationId::Identity,
                description: "answer identity once".to_string(),
                status: AnswerObligationStatus::Pending,
                satisfied_by_event: None,
            }],
            summary: Some("Continue until completion criteria are satisfied.".to_string()),
            fail_closed: false,
        },
        sequence: Some(6),
    };
    let encoded = serde_json::to_value(&event).expect("serialize decision event");
    assert_eq!(encoded["kind"], "workflow.decision_made");
    assert_eq!(encoded["decision"]["action"], "continue");
    assert_eq!(encoded["decision"]["reason"], "pendingCriticalSteps");
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize decision event");
    assert_eq!(decoded, event);
}
