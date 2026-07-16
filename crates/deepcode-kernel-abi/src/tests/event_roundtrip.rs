use super::*;

#[test]
fn syscall_result_events_are_locale_neutral() {
    let event = KernelEvent::ToolCompleted {
        run_id: None,
        session_id: None,
        turn_id: None,
        tool_call_id: "req-list".to_string(),
        tool_name: "fs.list".to_string(),
        ok: true,
        output: Some(serde_json::json!({ "nodes": [] })),
        error: None,
        sequence: Some(1),
    };

    let encoded = serde_json::to_value(&event).expect("serialize tool result");
    assert_eq!(encoded["kind"], "tool.completed");
    assert_eq!(encoded["toolName"], "fs.list");
    assert_eq!(encoded["ok"], true);
}

#[test]
fn kernel_event_uses_locale_neutral_dotted_kind() {
    let event = KernelEvent::MessageAppended {
        run_id: Some(RunId("run-1".to_string())),
        session_id: Some(SessionId("session-1".to_string())),
        turn_id: Some(TurnId("turn-1".to_string())),
        role: MessageRole::Agent,
        channel: Some("final".to_string()),
        content: None,
        message_key: Some("agent.done".to_string()),
        args: Some(serde_json::json!({ "count": 1 })),
        sequence: Some(7),
    };

    let encoded = serde_json::to_value(&event).expect("serialize event");
    assert_eq!(encoded["kind"], "message.appended");
    assert_eq!(encoded["messageKey"], "agent.done");
    assert_eq!(encoded["sequence"], 7);

    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize event");
    assert_eq!(decoded, event);
}

#[test]
fn draft_ledger_events_round_trip() {
    let event = KernelEvent::DraftChunk {
        request_id: Some(RequestId("req-draft".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        draft: serde_json::json!({
            "draftId": "draft-generic",
            "status": "draft.chunk",
            "frame": {
                "schemaVersion": "deepcode.agent.artifact-draft.v1",
                "partKind": "artifactChunk",
                "slotId": "slot-generic",
                "contentLines": ["generic content"]
            }
        }),
        sequence: Some(9),
    };

    let encoded = serde_json::to_value(&event).expect("serialize draft event");
    assert_eq!(encoded["kind"], "draft.chunk");
    assert_eq!(encoded["draft"]["frame"]["partKind"], "artifactChunk");

    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize draft event");
    assert_eq!(decoded, event);
}

#[test]
fn driver_loop_events_round_trip() {
    let contract = KernelStateContract {
        run_id: RunId("run-1".to_string()),
        state_id: "ready".to_string(),
        state_kind: "driverRequest".to_string(),
        allowed_inputs: vec!["proposalSubmit".to_string()],
        allowed_proposals: vec!["answer".to_string()],
        proposal_schema_refs: vec!["deepcode.agent.protocol.v4".to_string()],
        required_user_decision: None,
        capability_projection: vec!["fs.read".to_string()],
        tool_catalog_ref: Some("catalog-v1".to_string()),
        tool_catalog_hash: Some("hash-catalog".to_string()),
        tool_catalog_snapshot: None,
        draft_admission_policy: DraftAdmissionPolicy {
            max_total_utf8_bytes: 384 * 1024,
        },
        transition_predicates: vec![],
        fail_closed_rules: vec![],
    };
    let event = KernelEvent::StateEntered {
        request_id: Some(RequestId("req-state".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        state_contract: contract.clone(),
        sequence: Some(1),
    };
    let encoded = serde_json::to_value(&event).expect("serialize state event");
    assert_eq!(encoded["kind"], "state.entered");
    assert_eq!(
        encoded["stateContract"]["proposalSchemaRefs"][0],
        "deepcode.agent.protocol.v4"
    );
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize state event");
    assert_eq!(decoded, event);

    let event = KernelEvent::DriverRequestProduced {
        request_id: Some(RequestId("req-driver".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        driver_request: DriverRequest {
            id: "driver-run-1-need-proposal".to_string(),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            kind: DriverRequestKind::NeedProposal,
            reason: "Need proposal".to_string(),
            state_contract: contract,
        },
        sequence: Some(2),
    };
    let encoded = serde_json::to_value(&event).expect("serialize driver request event");
    assert_eq!(encoded["kind"], "driver.request_produced");
    assert_eq!(encoded["driverRequest"]["kind"], "needProposal");
    let decoded: KernelEvent =
        serde_json::from_value(encoded).expect("deserialize driver request event");
    assert_eq!(decoded, event);
}

#[test]
fn llm_provider_error_event_round_trips_with_raw_response_diagnostic() {
    let event = KernelEvent::LlmProviderError {
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        phase: "plan".to_string(),
        llm_call_id: "llm-run-1-plan-1".to_string(),
        diagnostic: LlmProviderDiagnostic {
            reason: "ProviderJsonDecodeFailed".to_string(),
            error_layer: LlmProviderErrorLayer::JsonDecode,
            message: "expected value at line 1 column 1".to_string(),
            provider: "openaiCompatible".to_string(),
            profile_id: "profile-1".to_string(),
            profile_name: "DeepSeek V4 Pro".to_string(),
            model: "deepseek-v4-pro".to_string(),
            status: Some(200),
            content_type: "text/html".to_string(),
            is_stream: false,
            body_preview: "<html>bad gateway</html>".to_string(),
            body_hash: Some("abc123".to_string()),
            expected_schema: "openai.chat.completion.v1: choices[0].message".to_string(),
        },
        sequence: Some(8),
    };

    let encoded = serde_json::to_value(&event).expect("serialize provider error event");
    assert_eq!(encoded["kind"], "llm.provider_error");
    assert_eq!(encoded["diagnostic"]["reason"], "ProviderJsonDecodeFailed");
    assert_eq!(encoded["diagnostic"]["contentType"], "text/html");
    assert_eq!(
        encoded["diagnostic"]["expectedSchema"],
        "openai.chat.completion.v1: choices[0].message"
    );

    let decoded: KernelEvent =
        serde_json::from_value(encoded).expect("deserialize provider error event");
    assert_eq!(decoded, event);
}

#[test]
fn runtime_lifecycle_event_round_trip() {
    let event = KernelEvent::RuntimeLifecycleChanged {
        request_id: Some(RequestId("request-1".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        previous_state: Some(RuntimeLifecycleState::Created),
        current_state: RuntimeLifecycleState::Ready,
        reason: Some("runInitialized".to_string()),
        sequence: Some(4),
    };
    let encoded = serde_json::to_value(&event).expect("serialize event");
    assert_eq!(encoded["kind"], "runtime.lifecycle_changed");
    assert_eq!(encoded["currentState"], "ready");
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize event");
    assert_eq!(decoded, event);
}

#[test]
fn plan_authorization_events_round_trip_with_kernel_contract_and_lease_identity() {
    let contract = KernelPlanAuthorizationContract {
        id: "authorization-1".to_string(),
        plan_id: "plan-1".to_string(),
        plan_hash: "plan-hash-1".to_string(),
        status: PlanAuthorizationStatus::Confirmable,
        workspace_binding_hash: Some("workspace-hash-1".to_string()),
        catalog_version: "deepcode.kernel.tools.v3".to_string(),
        catalog_hash: "catalog-hash-1".to_string(),
        operation_set_hash: "operation-set-hash-1".to_string(),
        contract_hash: "contract-hash-1".to_string(),
        operations: vec![KernelPlanAuthorizationOperation {
            id: "operation-1".to_string(),
            source_task_id: "task-1".to_string(),
            tool_id: "fs.create".to_string(),
            operation_kind: "create".to_string(),
            content_mode: "contentBlock".to_string(),
            targets: vec!["nested/output.txt".to_string()],
            depends_on: Vec::new(),
            fixed_args: serde_json::json!({"executable": false}),
            args_template: serde_json::json!({
                "path": "nested/output.txt",
                "contentBlockId": "executionTime"
            }),
            target_kind: Some("file".to_string()),
            recursive: None,
            read_set: Vec::new(),
            write_set: vec!["nested/output.txt".to_string()],
            conflict_keys: vec!["nested/output.txt".to_string()],
            execution_mode: "execute".to_string(),
            internal: false,
            parent_operation_id: None,
        }],
        permission_bundles: Vec::new(),
        interventions: Vec::new(),
        cleanup_policy: "kernelPlanGrantLease".to_string(),
        expires_after: "reviewGateReplanCancelOrRunTerminal".to_string(),
    };
    let reviewed = KernelEvent::PlanAuthorizationReviewed {
        request_id: Some(RequestId("req-plan-authorization".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        plan_id: "plan-1".to_string(),
        review: PlanAuthorizationReview {
            plan_id: "plan-1".to_string(),
            status: PlanAuthorizationStatus::Confirmable,
            diagnostics: Vec::new(),
            authorization_contract: contract,
        },
        sequence: Some(10),
    };
    let encoded = serde_json::to_value(&reviewed).expect("serialize plan authorization review");
    assert_eq!(encoded["kind"], "plan_authorization.reviewed");
    assert_eq!(
        encoded["review"]["authorizationContract"]["id"],
        "authorization-1"
    );
    let decoded: KernelEvent =
        serde_json::from_value(encoded).expect("deserialize plan authorization review");
    assert_eq!(decoded, reviewed);

    let recorded = KernelEvent::PlanAuthorizationDecisionRecorded {
        request_id: Some(RequestId("req-plan-decision".to_string())),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        authorization_contract_id: "authorization-1".to_string(),
        decision: "accept".to_string(),
        lease_id: Some("plan-grant-lease-authorization-1".to_string()),
        sequence: Some(11),
    };
    let encoded = serde_json::to_value(&recorded).expect("serialize plan authorization decision");
    assert_eq!(encoded["kind"], "plan_authorization.decision_recorded");
    assert_eq!(encoded["leaseId"], "plan-grant-lease-authorization-1");
    let decoded: KernelEvent =
        serde_json::from_value(encoded).expect("deserialize plan authorization decision");
    assert_eq!(decoded, recorded);
}
