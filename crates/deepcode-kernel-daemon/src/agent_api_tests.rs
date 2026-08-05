use super::*;

#[test]
fn session_schema_accepts_only_current_v3_history() {
    let current = create_agent_session_value(
        "session-v2",
        "2026-07-29T00:00:00Z",
        "Current v2 session",
        Some("profile-v2"),
        Some("workspace-v2"),
        Some("workspace-hash-v2"),
    );
    assert!(session_schema_is_current(&current));
    assert_eq!(
        current.get("historySchema").and_then(Value::as_str),
        Some(SESSION_KERNEL_HISTORY_SCHEMA_V3)
    );

    for (field, legacy_value) in [
        ("sessionSchemaVersion", "deepcode.agent.session.v1"),
        ("historySchema", "deepcode.session.kernel-persistence.v1"),
        ("historySchema", "deepcode.session.kernel-persistence.v2"),
        ("kernelAbiVersion", "deepcode.kernel.abi.v1"),
    ] {
        let mut legacy = current.clone();
        legacy[field] = json!(legacy_value);
        assert!(
            !session_schema_is_current(&legacy),
            "{field} must fail closed for legacy history"
        );
    }
}

#[test]
fn run_request_rejects_payload_authority_claims() {
    let request = json!({
        "op": "ask",
        "content": "inspect the workspace",
        "callerRequestId": "request-v2",
        "trusted": true
    });
    assert!(
        serde_json::from_value::<AgentSessionRunRequest>(request).is_err(),
        "payload fields cannot manufacture Host trust"
    );
}

#[test]
fn run_request_preserves_separate_ask_and_decision_fields() {
    let ask: AgentSessionRunRequest = serde_json::from_value(json!({
        "op": "ask",
        "content": "inspect the workspace",
        "callerRequestId": "request-ask-v2"
    }))
    .expect("strict ask request");
    assert_eq!(ask.op, "ask");
    assert_eq!(ask.content.as_deref(), Some("inspect the workspace"));
    assert!(ask.decision_kind.is_none());
    assert!(ask.run_id.is_none());

    let decision: AgentSessionRunRequest = serde_json::from_value(json!({
        "op": "resolveDecision",
        "decisionKind": "permission",
        "decision": "reject",
        "guidance": "keep the operation inside src",
        "runId": "run-v2",
        "targetId": "invocation-v2",
        "callerRequestId": "request-decision-v2"
    }))
    .expect("strict decision request");
    assert_eq!(decision.op, "resolveDecision");
    assert!(decision.content.is_none());
    assert!(decision.attachments.is_none());
    assert!(decision.workspace_path.is_none());
    assert_eq!(decision.decision_kind.as_deref(), Some("permission"));
    assert_eq!(decision.run_id.as_deref(), Some("run-v2"));
    assert_eq!(decision.target_id.as_deref(), Some("invocation-v2"));
}

#[test]
fn authority_revoke_request_is_strict_and_typed() {
    let valid: AgentAuthorityRevokeRequestV2 = serde_json::from_value(json!({
        "callerRequestId": "request-revoke-v2",
        "target": {
            "kind": "capabilityLease",
            "leaseId": "lease-v2"
        },
        "reason": "user revoked the lease"
    }))
    .expect("strict revoke request");
    assert!(matches!(
        valid.target,
        AgentAuthorityRevokeTargetRequestV2::CapabilityLease { ref lease_id }
            if lease_id == "lease-v2"
    ));

    assert!(
        serde_json::from_value::<AgentAuthorityRevokeRequestV2>(json!({
            "callerRequestId": "request-revoke-v2",
            "target": {
                "kind": "capabilityLease",
                "leaseId": "lease-v2"
            },
            "reason": "user revoked the lease",
            "trusted": true
        }))
        .is_err()
    );
}
