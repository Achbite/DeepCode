use super::*;

#[test]
fn kernel_command_round_trips_as_tagged_json() {
    let command = KernelCommand::HealthCheck {
        request_id: RequestId("req-1".to_string()),
    };

    let encoded = serde_json::to_string(&command).expect("serialize command");
    assert!(encoded.contains("healthCheck"));

    let decoded: KernelCommand = serde_json::from_str(&encoded).expect("deserialize command");
    assert_eq!(decoded, command);
}

#[test]
fn run_start_carries_workspace_binding_and_refs() {
    let command = KernelCommand::RunStart {
        request_id: RequestId("req-run".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        input: UserInput {
            text: "inspect workspace".to_string(),
            attachments: vec![serde_json::json!({ "kind": "context" })],
        },
        workspace_binding: Some(WorkspaceBinding {
            workspace_id: Some("ws-1".to_string()),
            workspace_hash: Some("hash-1".to_string()),
            open_path: Some("/workspace/project.code-workspace".to_string()),
            active_folder_id: Some("wf-0".to_string()),
            folder_hash: Some("folder-hash".to_string()),
        }),
        profile_ref: Some(ProfileRef {
            id: "developer".to_string(),
            kind: Some("policy".to_string()),
            hash: None,
        }),
        workflow_ref: Some(WorkflowRef {
            id: "plan-first".to_string(),
            version: Some("1".to_string()),
            hash: None,
        }),
        run_overrides: Some(serde_json::json!({ "mode": "plan" })),
    };

    let encoded = serde_json::to_value(&command).expect("serialize run start");
    assert_eq!(encoded["kind"], "runStart");
    assert_eq!(encoded["workspaceBinding"]["activeFolderId"], "wf-0");
    assert_eq!(encoded["profileRef"]["id"], "developer");
    assert_eq!(encoded["workflowRef"]["id"], "plan-first");

    let decoded: KernelCommand = serde_json::from_value(encoded).expect("deserialize run start");
    assert_eq!(decoded, command);
}

#[test]
fn workspace_and_skill_syscalls_round_trip() {
    let command = KernelCommand::WorkspaceWrite {
        request_id: RequestId("req-write".to_string()),
        folder_id: Some("wf-0".to_string()),
        path: "_agent_tmp_syscall.txt".to_string(),
        content: "hello".to_string(),
        create: true,
    };

    let encoded = serde_json::to_value(&command).expect("serialize workspace write");
    assert_eq!(encoded["kind"], "workspaceWrite");
    assert_eq!(encoded["path"], "_agent_tmp_syscall.txt");

    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize workspace write");
    assert_eq!(decoded, command);

    let command = KernelCommand::SkillInvoke {
        request_id: RequestId("req-skill".to_string()),
        run_id: Some(RunId("run-1".to_string())),
        session_id: Some(SessionId("session-1".to_string())),
        skill_id: "external.python.echo".to_string(),
        input: serde_json::json!({ "text": "ok" }),
    };
    let encoded = serde_json::to_value(&command).expect("serialize skill invoke");
    assert_eq!(encoded["kind"], "skillInvoke");
    assert_eq!(encoded["runId"], "run-1");
    assert_eq!(encoded["sessionId"], "session-1");
    assert_eq!(encoded["skillId"], "external.python.echo");
}
