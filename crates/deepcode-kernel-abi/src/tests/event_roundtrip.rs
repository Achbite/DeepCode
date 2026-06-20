use super::*;

#[test]
fn syscall_result_events_are_locale_neutral() {
    let event = KernelEvent::WorkspaceResult {
        request_id: RequestId("req-list".to_string()),
        operation: "fs.list".to_string(),
        ok: true,
        output: Some(serde_json::json!({ "nodes": [] })),
        error: None,
        sequence: Some(1),
    };

    let encoded = serde_json::to_value(&event).expect("serialize workspace result");
    assert_eq!(encoded["kind"], "workspace.result");
    assert_eq!(encoded["operation"], "fs.list");
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
                "schemaVersion": "deepcode.agent.stream.part.v1",
                "partKind": "codeBlockChunk",
                "targetPath": "src/generated.txt"
            }
        }),
        sequence: Some(9),
    };

    let encoded = serde_json::to_value(&event).expect("serialize draft event");
    assert_eq!(encoded["kind"], "draft.chunk");
    assert_eq!(encoded["draft"]["frame"]["partKind"], "codeBlockChunk");

    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize draft event");
    assert_eq!(decoded, event);
}

#[test]
fn driver_loop_v3_events_round_trip() {
    let contract = KernelStateContract {
        run_id: RunId("run-1".to_string()),
        workflow_ref: Some(WorkflowRef {
            id: "builtin.plan-first".to_string(),
            version: None,
            hash: None,
        }),
        state_id: "plan".to_string(),
        state_kind: "driverRequest".to_string(),
        allowed_inputs: vec!["proposalSubmit".to_string()],
        allowed_proposals: vec!["answer".to_string()],
        proposal_schema_refs: vec!["deepcode.agent.protocol.v3".to_string()],
        required_user_decision: None,
        capability_projection: vec!["fs.read".to_string()],
        tool_catalog_ref: Some("catalog-v1".to_string()),
        tool_catalog_hash: Some("hash-catalog".to_string()),
        tool_catalog_snapshot: None,
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
        "deepcode.agent.protocol.v3"
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
fn plan_command_and_checkpoint_event_round_trip() {
    let command = KernelCommand::PermissionGrantTemporary {
        request_id: RequestId("req-grant".to_string()),
        run_id: RunId("run-1".to_string()),
        grant: TemporaryGrantEnvelope {
            id: "grant-1".to_string(),
            capability: "fs.write".to_string(),
            resource_kind: "workspaceFile".to_string(),
            resource_path: Some("src/main.rs".to_string()),
            expires_after_sequence: Some(10),
            reason: Some("approved test grant".to_string()),
        },
    };
    let encoded = serde_json::to_value(&command).expect("serialize command");
    assert_eq!(encoded["kind"], "permissionGrantTemporary");
    assert_eq!(encoded["grant"]["resourceKind"], "workspaceFile");
    let decoded: KernelCommand = serde_json::from_value(encoded).expect("deserialize command");
    assert_eq!(decoded, command);

    let event = KernelEvent::WorkflowCheckpointed {
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        checkpoint_id: "checkpoint-1".to_string(),
        phase: "plan".to_string(),
        sequence: Some(4),
    };
    let encoded = serde_json::to_value(&event).expect("serialize event");
    assert_eq!(encoded["kind"], "workflow.checkpointed");
    assert_eq!(encoded["checkpointId"], "checkpoint-1");
    let decoded: KernelEvent = serde_json::from_value(encoded).expect("deserialize event");
    assert_eq!(decoded, event);
}
