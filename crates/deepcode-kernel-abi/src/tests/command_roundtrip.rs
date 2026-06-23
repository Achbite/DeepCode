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
fn run_create_carries_workspace_binding_and_refs() {
    let command = KernelCommand::RunCreate {
        request_id: RequestId("req-run".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        input: UserInput {
            text: "inspect workspace".to_string(),
            attachments: vec![serde_json::json!({ "kind": "context" })],
        },
        workspace_binding: Some(WorkspaceBinding {
            workspace_id: Some("ws-1".to_string()),
            workspace_hash: Some("hash-1".to_string()),
            open_path: Some("workspace-binding".to_string()),
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

    let encoded = serde_json::to_value(&command).expect("serialize run create");
    assert_eq!(encoded["kind"], "runCreate");
    assert_eq!(encoded["workspaceBinding"]["activeFolderId"], "wf-0");
    assert_eq!(encoded["profileRef"]["id"], "developer");
    assert_eq!(encoded["workflowRef"]["id"], "plan-first");

    let decoded: KernelCommand = serde_json::from_value(encoded).expect("deserialize run create");
    assert_eq!(decoded, command);
}

#[test]
fn driver_loop_v3_commands_round_trip() {
    let proposal = ProposalEnvelope {
        schema_version: "deepcode.agent.protocol.v3".to_string(),
        proposal_id: "proposal-1".to_string(),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        source: ProposalEnvelopeSource::Llm,
        kind: ProposalEnvelopeKind::Answer,
        payload: serde_json::json!({ "answer": { "format": "markdown", "content": "ok" } }),
        referenced_resource_packet_refs: vec![],
        referenced_evidence_refs: vec![],
        parser_diagnostics: None,
    };
    let command = KernelCommand::ProposalSubmit {
        request_id: RequestId("req-proposal".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        proposal: proposal.clone(),
    };
    let encoded = serde_json::to_value(&command).expect("serialize proposal submit");
    assert_eq!(encoded["kind"], "proposalSubmit");
    assert_eq!(
        encoded["proposal"]["schemaVersion"],
        "deepcode.agent.protocol.v3"
    );
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize proposal submit");
    assert_eq!(decoded, command);

    let command = KernelCommand::ResourceResolve {
        request_id: RequestId("req-resource".to_string()),
        run_id: Some(RunId("run-1".to_string())),
        session_id: Some(SessionId("session-1".to_string())),
        request: ResourceResolveRequest {
            manifest: serde_json::json!({
                "id": "manifest-1",
                "entries": [{ "id": "entry-1", "kind": "file" }]
            }),
        },
    };
    let encoded = serde_json::to_value(&command).expect("serialize resource resolve");
    assert_eq!(encoded["kind"], "resourceResolve");
    assert_eq!(encoded["request"]["manifest"]["id"], "manifest-1");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize resource resolve");
    assert_eq!(decoded, command);

    let command = KernelCommand::UserDecisionSubmit {
        request_id: RequestId("req-decision".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        decision: UserDecisionSubmit {
            decision_id: "decision-1".to_string(),
            decision_kind: "accepted".to_string(),
            target_id: Some(proposal.proposal_id),
            payload: serde_json::json!({}),
        },
    };
    let encoded = serde_json::to_value(&command).expect("serialize user decision");
    assert_eq!(encoded["kind"], "userDecisionSubmit");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize user decision");
    assert_eq!(decoded, command);

    let command = KernelCommand::DraftLedgerSubmit {
        request_id: RequestId("req-draft".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        frame: serde_json::json!({
            "schemaVersion": "deepcode.agent.stream.part.v1",
            "partKind": "codeBlockChunk",
            "draftId": "draft-generic",
            "targetPath": "src/generated.txt",
            "chunk": "generic draft content\n"
        }),
    };
    let encoded = serde_json::to_value(&command).expect("serialize draft ledger submit");
    assert_eq!(encoded["kind"], "draftLedgerSubmit");
    assert_eq!(encoded["frame"]["partKind"], "codeBlockChunk");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize draft ledger submit");
    assert_eq!(decoded, command);
}

#[test]
fn workspace_and_skill_syscalls_round_trip() {
    let command = KernelCommand::HostResourceQuery {
        request_id: RequestId("req-host-resource".to_string()),
        query: serde_json::json!({
            "kind": "read",
            "folderId": "wf-0",
            "path": "managed-syscall-resource"
        }),
    };

    let encoded = serde_json::to_value(&command).expect("serialize host resource query");
    assert_eq!(encoded["kind"], "hostResourceQuery");
    assert_eq!(encoded["query"]["kind"], "read");
    assert_eq!(encoded["query"]["path"], "managed-syscall-resource");

    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize host resource query");
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
