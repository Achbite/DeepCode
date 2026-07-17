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
fn run_create_carries_workspace_binding_and_profile_ref() {
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
        run_overrides: Some(serde_json::json!({ "mode": "plan" })),
    };

    let encoded = serde_json::to_value(&command).expect("serialize run create");
    assert_eq!(encoded["kind"], "runCreate");
    assert_eq!(encoded["workspaceBinding"]["activeFolderId"], "wf-0");
    assert_eq!(encoded["profileRef"]["id"], "developer");
    assert!(encoded.get("workflowRef").is_none());

    let decoded: KernelCommand = serde_json::from_value(encoded).expect("deserialize run create");
    assert_eq!(decoded, command);
}

#[test]
fn driver_loop_commands_round_trip() {
    let proposal = ProposalEnvelope {
        schema_version: "deepcode.agent.protocol.v4".to_string(),
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
        "deepcode.agent.protocol.v4"
    );
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize proposal submit");
    assert_eq!(decoded, command);

    let command = KernelCommand::ResourceResolve {
        request_id: RequestId("req-resource".to_string()),
        run_id: RunId("run-1".to_string()),
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

    let command = KernelCommand::DraftLedgerSubmit {
        request_id: RequestId("req-draft".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        frame: ArtifactDraftLedgerFrame::ArtifactChunk {
            base: ArtifactDraftFrameBase {
                schema_version: ARTIFACT_DRAFT_SCHEMA_VERSION.to_string(),
                draft_id: "draft-generic".to_string(),
                frame_id: "frame-generic".to_string(),
                run_id: "run-1".to_string(),
                session_id: "session-1".to_string(),
                task_id: "task-generic".to_string(),
                sequence: 1,
                content_hash: "fnv1a64:0000000000000000".to_string(),
                expected_slot_ids: vec!["slot-generic".to_string()],
            },
            slot_id: "slot-generic".to_string(),
            content_lines: vec!["generic draft content".to_string()],
            final_chunk: true,
            edit_match: None,
        },
    };
    let encoded = serde_json::to_value(&command).expect("serialize draft ledger submit");
    assert_eq!(encoded["kind"], "draftLedgerSubmit");
    assert_eq!(encoded["frame"]["partKind"], "artifactChunk");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize draft ledger submit");
    assert_eq!(decoded, command);
}

#[test]
fn host_resource_and_execution_contract_decision_round_trip() {
    let binding_command = KernelCommand::HostWorkspaceBindingResolve {
        request_id: RequestId("req-binding".to_string()),
        path: "workspace-root".to_string(),
    };
    let encoded = serde_json::to_value(&binding_command).expect("serialize binding resolve");
    assert_eq!(encoded["kind"], "hostWorkspaceBindingResolve");
    assert_eq!(encoded["path"], "workspace-root");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize binding resolve");
    assert_eq!(decoded, binding_command);

    let command = KernelCommand::HostResourceQuery {
        request_id: RequestId("req-host-resource".to_string()),
        query: HostInspectionQuery::Read {
            folder_id: Some("wf-0".to_string()),
            path: "managed-syscall-resource".to_string(),
        },
    };

    let encoded = serde_json::to_value(&command).expect("serialize host resource query");
    assert_eq!(encoded["kind"], "hostResourceQuery");
    assert_eq!(encoded["query"]["kind"], "read");
    assert_eq!(encoded["query"]["path"], "managed-syscall-resource");

    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize host resource query");
    assert_eq!(decoded, command);
}

#[test]
fn plan_authorization_commands_round_trip_without_permission_fields_in_intent() {
    let submit = KernelCommand::PlanAuthorizationSubmit {
        request_id: RequestId("req-plan-authorization".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        intent: TaskIntentEnvelope {
            schema_version: TASK_INTENT_SCHEMA_VERSION.to_string(),
            plan_id: "plan-1".to_string(),
            plan_hash: "plan-hash-1".to_string(),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            workspace_binding_hash: Some("workspace-hash-1".to_string()),
            catalog_version: "deepcode.kernel.tools.v3".to_string(),
            catalog_hash: "catalog-hash-1".to_string(),
            tasks: vec![TaskIntentTask {
                task_id: "task-1".to_string(),
                tool_id: "fs.create".to_string(),
                targets: vec!["nested/output.txt".to_string()],
                depends_on: Vec::new(),
                args: serde_json::json!({}),
            }],
        },
    };
    let encoded = serde_json::to_value(&submit).expect("serialize plan authorization submit");
    assert_eq!(encoded["kind"], "planAuthorizationSubmit");
    assert_eq!(encoded["intent"]["tasks"][0]["toolId"], "fs.create");
    assert!(encoded["intent"]["tasks"][0].get("permission").is_none());
    assert!(encoded["intent"]["tasks"][0].get("risk").is_none());
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize plan authorization submit");
    assert_eq!(decoded, submit);

    let decision = KernelCommand::PlanAuthorizationDecisionSubmit {
        request_id: RequestId("req-plan-authorization-decision".to_string()),
        run_id: RunId("run-1".to_string()),
        session_id: Some(SessionId("session-1".to_string())),
        decision: PlanAuthorizationDecisionSubmit {
            decision_id: "decision-1".to_string(),
            authorization_contract_id: "authorization-1".to_string(),
            plan_id: "plan-1".to_string(),
            plan_hash: "plan-hash-1".to_string(),
            contract_hash: "contract-hash-1".to_string(),
            decision: PlanAuthorizationDecisionKind::Accept,
        },
    };
    let encoded = serde_json::to_value(&decision).expect("serialize plan authorization decision");
    assert_eq!(encoded["kind"], "planAuthorizationDecisionSubmit");
    assert_eq!(encoded["decision"]["contractHash"], "contract-hash-1");
    let decoded: KernelCommand =
        serde_json::from_value(encoded).expect("deserialize plan authorization decision");
    assert_eq!(decoded, decision);
}
