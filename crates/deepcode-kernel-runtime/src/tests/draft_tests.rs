use super::*;
use deepcode_kernel_abi::ArtifactEditMatch;

#[test]
fn artifact_draft_ledger_validates_sequence_hash_and_terminal_state() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let first = submit_artifact_draft(
        &mut runtime,
        "draft-first",
        artifact_draft_chunk("draft-primary", "frame-primary-1", 1, &["first"], false),
    )
    .expect("first draft chunk succeeds");
    assert!(first
        .iter()
        .any(|event| matches!(event, KernelEvent::DraftChunk { .. })));

    let out_of_order = submit_artifact_draft(
        &mut runtime,
        "draft-out-of-order",
        artifact_draft_chunk("draft-primary", "frame-primary-3", 3, &["third"], true),
    )
    .expect_err("out-of-order draft frame fails");
    assert!(out_of_order.to_string().contains("sequence must be 2"));

    let duplicate = submit_artifact_draft(
        &mut runtime,
        "draft-duplicate",
        artifact_draft_chunk("draft-primary", "frame-primary-1", 2, &["second"], true),
    )
    .expect_err("duplicate frame id fails");
    assert!(duplicate
        .to_string()
        .contains("frameId was already recorded"));

    let mut bad_hash = artifact_draft_chunk(
        "draft-primary",
        "frame-primary-bad-hash",
        2,
        &["second"],
        true,
    );
    bad_hash.base_mut().content_hash = "fnv1a64:0000000000000000".to_string();
    let hash_error = submit_artifact_draft(&mut runtime, "draft-bad-hash", bad_hash)
        .expect_err("mismatched hash fails");
    assert!(hash_error
        .to_string()
        .contains("contentHash does not match"));

    submit_artifact_draft(
        &mut runtime,
        "draft-second",
        artifact_draft_chunk("draft-primary", "frame-primary-2", 2, &["second"], true),
    )
    .expect("corrected second frame reuses the unadvanced sequence");
    let completed = submit_artifact_draft(
        &mut runtime,
        "draft-done",
        artifact_draft_done("draft-primary", "frame-primary-done", 3, "complete"),
    )
    .expect("completed draft succeeds");
    assert!(completed
        .iter()
        .any(|event| matches!(event, KernelEvent::DraftBatchCompleted { .. })));
    assert!(!runtime
        .state
        .artifact_drafts
        .contains_key("run-1:draft-primary"));
    assert!(runtime
        .state
        .terminal_artifact_draft_keys
        .contains("run-1:draft-primary"));

    let terminal_error = submit_artifact_draft(
        &mut runtime,
        "draft-after-terminal",
        artifact_draft_chunk("draft-primary", "frame-primary-4", 4, &["late"], true),
    )
    .expect_err("terminal draft rejects later frames");
    assert!(terminal_error.to_string().contains("already terminal"));
}

#[test]
fn artifact_draft_accepts_logical_chunks_and_enforces_total_budget() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let logical_lines = (0..47)
        .map(|index| {
            if index == 23 {
                format!("line-{index}-{}", "x".repeat(4096))
            } else {
                format!("line-{index}")
            }
        })
        .collect::<Vec<_>>();
    submit_artifact_draft(
        &mut runtime,
        "draft-logical-large",
        artifact_draft_chunk_owned("draft-logical", "frame-logical-1", 1, logical_lines, false),
    )
    .expect("a logical chunk may exceed legacy line and byte limits");
    submit_artifact_draft(
        &mut runtime,
        "draft-logical-final",
        artifact_draft_chunk_owned(
            "draft-logical",
            "frame-logical-2",
            2,
            vec![String::new(), "第二个逻辑块".to_string()],
            true,
        ),
    )
    .expect("a subsequent logical chunk preserves empty lines and Unicode");

    let over_budget = submit_artifact_draft(
        &mut runtime,
        "draft-over-budget",
        artifact_draft_chunk_owned(
            "draft-budget",
            "frame-budget-1",
            1,
            vec!["x".repeat((384 * 1024) + 1)],
            true,
        ),
    )
    .expect_err("the task-wide artifact budget remains fail closed");
    assert!(over_budget
        .to_string()
        .contains("artifact_draft_budget_exceeded"));
    assert!(!runtime
        .state
        .artifact_drafts
        .contains_key("run-1:draft-budget"));

    submit_artifact_draft(
        &mut runtime,
        "draft-empty-first",
        artifact_draft_chunk_owned(
            "draft-empty-first",
            "frame-empty-first-1",
            1,
            vec![String::new()],
            false,
        ),
    )
    .expect("an empty logical first line is valid content");
    let separator_budget = submit_artifact_draft(
        &mut runtime,
        "draft-empty-first-over-budget",
        artifact_draft_chunk_owned(
            "draft-empty-first",
            "frame-empty-first-2",
            2,
            vec!["x".repeat(384 * 1024)],
            true,
        ),
    )
    .expect_err("the newline between logical chunks counts toward the task budget");
    assert!(separator_budget
        .to_string()
        .contains("artifact_draft_budget_exceeded"));
}

#[test]
fn artifact_draft_edit_match_hash_vectors_match_session_protocol() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let mut exact = artifact_draft_chunk_owned(
        "draft-edit-exact",
        "frame-edit-exact-1",
        1,
        vec!["replacement".to_string()],
        true,
    );
    if let ArtifactDraftLedgerFrame::ArtifactChunk {
        base, edit_match, ..
    } = &mut exact
    {
        *edit_match = Some(ArtifactEditMatch::ExactBlock {
            target_lines: vec!["beta".to_string()],
        });
        base.content_hash = "fnv1a64:6cc00e4f2c73ebd1".to_string();
    }
    submit_artifact_draft(&mut runtime, "draft-edit-exact", exact)
        .expect("exact editMatch hash matches the Session protocol vector");

    let mut line_range = artifact_draft_chunk_owned(
        "draft-edit-line",
        "frame-edit-line-1",
        1,
        vec!["replacement".to_string()],
        true,
    );
    if let ArtifactDraftLedgerFrame::ArtifactChunk {
        base, edit_match, ..
    } = &mut line_range
    {
        *edit_match = Some(ArtifactEditMatch::LineRange {
            start_line: 2,
            end_line: 2,
            expected_file_hash: None,
            expected_before_lines: Some(vec!["beta".to_string()]),
            expected_before_text: Some("beta\n".to_string()),
        });
        base.content_hash = "fnv1a64:d21b3d8f9280a0fa".to_string();
    }
    submit_artifact_draft(&mut runtime, "draft-edit-line", line_range)
        .expect("line-range editMatch hash matches the Session protocol vector");
}

#[test]
fn proposal_review_enforces_kernel_artifact_budget() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let payload = action_bundle(
        serde_json::json!([{
            "actionId": "create-over-budget",
            "toolId": "fs.create",
            "args": { "path": "over-budget.txt", "contentBlockId": "over-budget-content" },
            "description": "Create one generated artifact.",
            "dependsOn": []
        }]),
        serde_json::json!([{
            "blockId": "over-budget-content",
            "targetPath": "over-budget.txt",
            "operation": "create",
            "contentLines": ["x".repeat((384 * 1024) + 1)]
        }]),
    );
    let report = submit_proposal_raw(&mut runtime, payload);
    assert_eq!(report["status"], "denied");
    assert!(report["diagnostics"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|diagnostic| diagnostic.contains("artifact_draft_budget_exceeded")));
    assert!(report["executionContract"]["operations"]
        .as_array()
        .is_some_and(Vec::is_empty));
}

#[test]
fn artifact_draft_incomplete_finalize_does_not_advance_state() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    submit_artifact_draft(
        &mut runtime,
        "draft-incomplete-first",
        artifact_draft_chunk(
            "draft-incomplete",
            "frame-incomplete-1",
            1,
            &["first"],
            false,
        ),
    )
    .expect("incomplete draft starts");
    let incomplete = submit_artifact_draft(
        &mut runtime,
        "draft-incomplete-done",
        artifact_draft_done("draft-incomplete", "frame-incomplete-done", 2, "too early"),
    )
    .expect_err("incomplete draft cannot finalize");
    assert!(incomplete.to_string().contains("missing slots"));

    submit_artifact_draft(
        &mut runtime,
        "draft-incomplete-corrected",
        artifact_draft_chunk(
            "draft-incomplete",
            "frame-incomplete-2",
            2,
            &["second"],
            true,
        ),
    )
    .expect("failed finalize leaves the next sequence available");
}

#[test]
fn proposal_submit_accepts_v4_and_rejects_v3() {
    let (mut runtime, _workspace) = runtime_with_workspace();
    let accepted = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("answer-v4".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v4".to_string(),
                proposal_id: "answer-1".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                source: ProposalEnvelopeSource::Llm,
                kind: ProposalEnvelopeKind::Answer,
                payload: serde_json::json!({ "format": "markdown", "content": "ok" }),
                referenced_resource_packet_refs: Vec::new(),
                referenced_evidence_refs: Vec::new(),
                parser_diagnostics: None,
            },
        })
        .expect("v4 answer accepted");
    assert!(accepted
        .iter()
        .any(|event| matches!(event, KernelEvent::ProposalAccepted { .. })));

    let rejected = runtime
        .dispatch(KernelCommand::ProposalSubmit {
            request_id: RequestId("answer-v3".to_string()),
            run_id: RunId("run-1".to_string()),
            session_id: Some(SessionId("session-1".to_string())),
            proposal: ProposalEnvelope {
                schema_version: "deepcode.agent.protocol.v3".to_string(),
                proposal_id: "answer-old".to_string(),
                run_id: RunId("run-1".to_string()),
                session_id: Some(SessionId("session-1".to_string())),
                source: ProposalEnvelopeSource::Llm,
                kind: ProposalEnvelopeKind::Answer,
                payload: serde_json::json!({}),
                referenced_resource_packet_refs: Vec::new(),
                referenced_evidence_refs: Vec::new(),
                parser_diagnostics: None,
            },
        })
        .expect("old schema returns rejection event");
    assert!(rejected
        .iter()
        .any(|event| matches!(event, KernelEvent::ProposalRejected { .. })));
}
