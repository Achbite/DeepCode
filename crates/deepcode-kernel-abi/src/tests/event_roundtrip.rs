use super::*;

#[test]
fn syscall_result_events_are_locale_neutral() {
    let event = KernelEvent::WorkspaceResult {
        request_id: RequestId("req-list".to_string()),
        operation: "workspace.list".to_string(),
        ok: true,
        output: Some(serde_json::json!({ "nodes": [] })),
        error: None,
        sequence: Some(1),
    };

    let encoded = serde_json::to_value(&event).expect("serialize workspace result");
    assert_eq!(encoded["kind"], "workspace.result");
    assert_eq!(encoded["operation"], "workspace.list");
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
fn plan_command_and_checkpoint_event_round_trip() {
    let command = KernelCommand::PermissionGrantTemporary {
        request_id: RequestId("req-grant".to_string()),
        run_id: RunId("run-1".to_string()),
        grant: TemporaryGrantEnvelope {
            id: "grant-1".to_string(),
            capability: "workspace.write".to_string(),
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
