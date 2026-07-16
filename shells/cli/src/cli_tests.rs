use super::*;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};

#[test]
fn parses_tools_run_with_explicit_mutation_approval() {
    let command = Command::parse(vec![
        "tools".to_string(),
        "run".to_string(),
        "fs.write".to_string(),
        "--workspace".to_string(),
        "/tmp/workspace".to_string(),
        "--args-file".to_string(),
        "/tmp/args.json".to_string(),
        "--approve-contract".to_string(),
    ])
    .expect("tools run parses");
    match command {
        Command::ToolsRun {
            tool_id,
            workspace,
            args_file,
            approve_contract,
            ..
        } => {
            assert_eq!(tool_id, "fs.write");
            assert_eq!(workspace, "/tmp/workspace");
            assert_eq!(args_file, "/tmp/args.json");
            assert!(approve_contract);
        }
        _ => panic!("expected tools run command"),
    }
}

#[test]
fn tool_verification_coverage_is_derived_from_the_catalog() {
    let catalog = json!({
        "tools": [
            {
                "toolId": "read.tool",
                "executionMode": "execute",
                "providerVisible": true
            },
            {
                "toolId": "internal.tool",
                "executionMode": "execute",
                "providerVisible": false
            },
            {
                "toolId": "blocked.tool",
                "executionMode": "blocked",
                "providerVisible": false
            }
        ]
    });
    let coverage = BTreeMap::from([
        (
            "read.tool".to_string(),
            BTreeSet::from(["success".to_string(), "failure".to_string()]),
        ),
        (
            "blocked.tool".to_string(),
            BTreeSet::from(["blocked".to_string()]),
        ),
    ]);

    assert!(verify_catalog_case_coverage(&catalog, &coverage)
        .expect("coverage can be derived")
        .is_empty());

    let incomplete = BTreeMap::from([(
        "read.tool".to_string(),
        BTreeSet::from(["success".to_string()]),
    )]);
    let errors = verify_catalog_case_coverage(&catalog, &incomplete)
        .expect("incomplete coverage is reported");
    assert!(errors
        .iter()
        .any(|error| error.contains("read.tool requires a failure")));
    assert!(errors
        .iter()
        .any(|error| error.contains("blocked.tool requires a blocked")));
}

#[test]
fn parses_tools_verify_without_embedded_cases() {
    let command = Command::parse(vec![
        "tools".to_string(),
        "verify".to_string(),
        "--workspace".to_string(),
        "/tmp/workspace".to_string(),
        "--cases".to_string(),
        "/tmp/cases.jsonl".to_string(),
    ])
    .expect("tools verify parses");
    match command {
        Command::ToolsVerify {
            workspace,
            cases,
            approve_contract,
            ..
        } => {
            assert_eq!(workspace, "/tmp/workspace");
            assert_eq!(cases, "/tmp/cases.jsonl");
            assert!(!approve_contract);
        }
        _ => panic!("expected tools verify command"),
    }
}

fn timeline_with_pending(kind: &str, run_id: &str, target_key: &str, target_id: &str) -> Value {
    let mut timeline = json!({
        "sessionId": "session-test",
        "interactionProjection": {
            "pending": {
                "kind": kind,
                "runId": run_id
            }
        },
        "turns": []
    });
    timeline["interactionProjection"]["pending"][target_key] = json!(target_id);
    timeline
}

fn canonical_pending_fixture(
    raw: &Value,
    session_id: &str,
    kind: &str,
    run_id: &str,
    target_key: &str,
    target_id: &str,
) -> Value {
    let readable_key = if kind == "review" {
        "readableReview"
    } else {
        "readablePlan"
    };
    let readable = timeline_payload(raw)
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|turn| {
            turn.get("blocks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .flat_map(|block| {
            block
                .get("events")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .find_map(|event| {
            event
                .get("payload")
                .and_then(|payload| payload.get(readable_key))
        })
        .cloned()
        .unwrap_or_else(|| json!({ "sections": [] }));
    let mut structured = readable;
    structured["kind"] = json!(kind);
    let mut timeline = json!({
        "sessionId": session_id,
        "interactionProjection": {
            "pending": {
                "kind": kind,
                "runId": run_id,
                "blockId": "pending-block"
            }
        },
        "turns": [{
            "blocks": [{
                "id": "pending-block",
                "narrativeKind": kind,
                "structuredProjection": structured
            }]
        }]
    });
    timeline["interactionProjection"]["pending"][target_key] = json!(target_id);
    timeline
}

#[test]
fn selects_latest_pending_plan_from_projection_events() {
    let timeline = timeline_with_pending("plan", "run-b", "planId", "plan-b");

    let pending = find_pending_session_decision(&timeline, "plan", None).unwrap();
    assert_eq!(
        pending,
        PendingSessionDecision {
            run_id: "run-b".to_string(),
            target_id: Some("plan-b".to_string()),
        }
    );
}

#[test]
fn selects_pending_plan_matching_explicit_run_filter() {
    let timeline = timeline_with_pending("plan", "run-a", "planId", "plan-a");

    let pending = find_pending_session_decision(&timeline, "plan", Some("run-a")).unwrap();
    assert_eq!(
        pending,
        PendingSessionDecision {
            run_id: "run-a".to_string(),
            target_id: Some("plan-a".to_string()),
        }
    );
}

#[test]
fn ignores_plan_consumed_by_terminal_plan_review() {
    let timeline = json!({ "sessionId": "session-test", "turns": [] });

    assert!(find_pending_session_decision(&timeline, "plan", None).is_none());
}

#[test]
fn selects_pending_requirement_confirmation() {
    let timeline = timeline_with_pending("requirement", "run-a", "requirementId", "requirement-a");

    let pending = find_pending_session_decision(&timeline, "requirement", None).unwrap();
    assert_eq!(
        pending,
        PendingSessionDecision {
            run_id: "run-a".to_string(),
            target_id: Some("requirement-a".to_string()),
        }
    );
}

#[test]
fn selects_pending_review_summary() {
    let timeline = timeline_with_pending("review", "run-a", "reviewId", "review-a");

    let pending = find_pending_session_decision(&timeline, "review", None).unwrap();
    assert_eq!(
        pending,
        PendingSessionDecision {
            run_id: "run-a".to_string(),
            target_id: Some("review-a".to_string()),
        }
    );
}

#[test]
fn selects_confirmable_review_summary_without_status() {
    let timeline = timeline_with_pending("review", "run-a", "reviewId", "review-a");

    let pending = find_pending_session_decision(&timeline, "review", None).unwrap();
    assert_eq!(
        pending,
        PendingSessionDecision {
            run_id: "run-a".to_string(),
            target_id: Some("review-a".to_string()),
        }
    );
}

#[test]
fn print_text_uses_pending_plan_projection() {
    let timeline = json!({
        "sessionId": "session-print",
        "turns": [
            {
                "blocks": [
                    {
                        "narrativeKind": "thinking",
                        "title": "Thinking",
                        "bodyMarkdown": "internal reasoning should stay out of compact decision output"
                    },
                    {
                        "events": [
                            {
                                "kind": "plan_card",
                                "payload": {
                                    "confirmable": true,
                                    "runId": "run-print",
                                    "planId": "plan-print",
                                    "title": "Prepare generic work",
                                    "readablePlan": {
                                        "summary": "Plan summary text",
                                        "sections": [
                                            {
                                                "sectionId": "tasks",
                                                "titleKey": "session.projection.plan.section.tasks",
                                                "items": [
                                            {
                                                "kind": "task",
                                                "text": "Write generic module",
                                                "targetRefs": ["src/generic.ts"]
                                            },
                                            {
                                                "kind": "fact",
                                                "messageKey": "session.projection.plan.boundary.notExecution"
                                            }
                                        ]
                                    }
                                        ]
                                    }
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    });
    let timeline = canonical_pending_fixture(
        &timeline,
        "session-print",
        "plan",
        "run-print",
        "planId",
        "plan-print",
    );

    let text = extract_plain_text(&timeline).expect("pending plan text");
    assert!(text.contains("Pending plan decision"));
    assert!(text.contains("Plan summary text"));
    assert!(text.contains("## Tasks"));
    assert!(text.contains("Write generic module"));
    assert!(text.contains("This is a plan, not an execution result."));
    assert!(text.contains("Decision target: plan run=run-print target=plan-print"));
    assert!(text.contains("DeepCode-CLI --session session-print decision plan accept"));
    assert!(!text.contains("session.projection.plan.section.tasks"));
}

#[test]
fn print_text_deduplicates_structured_plan_summary() {
    let timeline = json!({
        "sessionId": "session-dedupe",
        "turns": [
            {
                "blocks": [
                    {
                        "events": [
                            {
                                "kind": "plan_card",
                                "payload": {
                                    "confirmable": true,
                                    "runId": "run-dedupe",
                                    "planId": "plan-dedupe",
                                    "summary": "Shared summary",
                                    "readablePlan": {
                                        "summary": "Shared summary",
                                        "sections": [
                                            {
                                                "sectionId": "summary",
                                                "titleKey": "session.projection.plan.section.summary",
                                                "items": [
                                                    {
                                                        "kind": "text",
                                                        "text": "Shared summary"
                                                    }
                                                ]
                                            },
                                            {
                                                "sectionId": "tasks",
                                                "titleKey": "session.projection.plan.section.tasks",
                                                "items": [
                                                    {
                                                        "kind": "task",
                                                        "text": "Complete generic step"
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    });
    let timeline = canonical_pending_fixture(
        &timeline,
        "session-dedupe",
        "plan",
        "run-dedupe",
        "planId",
        "plan-dedupe",
    );

    let text = extract_plain_text(&timeline).expect("pending plan text");
    assert_eq!(text.matches("Shared summary").count(), 1);
    assert!(text.contains("## Summary"));
    assert!(text.contains("## Tasks"));
    assert!(text.contains("Complete generic step"));
    assert!(text.contains("Decision target: plan run=run-dedupe target=plan-dedupe"));
}

#[test]
fn print_text_renders_pending_review_projection_without_raw_keys() {
    let timeline = json!({
        "sessionId": "session-review",
        "turns": [
            {
                "blocks": [
                    {
                        "events": [
                            {
                                "kind": "review_summary",
                                "payload": {
                                    "confirmable": true,
                                    "status": "waitingUserReview",
                                    "runId": "run-review",
                                    "reviewId": "review-1",
                                    "sourcePlanId": "plan-1",
                                    "readableReview": {
                                        "summaryKey": "review.summary.waitingUserReview",
                                        "sections": [
                                            {
                                                "sectionId": "executionResult",
                                                "titleKey": "session.projection.review.section.executionResult",
                                                "items": [
                                                    {
                                                        "kind": "fact",
                                                        "messageKey": "session.projection.review.count.workUnitsCompleted",
                                                        "messageArgs": { "count": "2" }
                                                    }
                                                ]
                                            },
                                            {
                                                "sectionId": "changedFiles",
                                                "titleKey": "session.projection.review.section.changedFiles",
                                                "items": [
                                                    {
                                                        "kind": "target",
                                                        "messageKey": "review.changedFile",
                                                        "messageArgs": {
                                                            "path": "src/module.txt",
                                                            "operation": "write",
                                                            "status": "completed"
                                                        },
                                                        "targetRefs": ["src/module.txt"]
                                                    },
                                                    {
                                                        "kind": "target",
                                                        "messageKey": "review.changedFile",
                                                        "messageArgs": {
                                                            "path": "src/module.txt",
                                                            "operation": "write",
                                                            "status": "completed"
                                                        },
                                                        "targetRefs": ["src/module.txt"]
                                                    }
                                                ]
                                            }
                                        ]
                                    }
                                }
                            }
                        ]
                    }
                ]
            }
        ]
    });
    let timeline = canonical_pending_fixture(
        &timeline,
        "session-review",
        "review",
        "run-review",
        "reviewId",
        "review-1",
    );

    let text = extract_plain_text(&timeline).expect("pending review text");
    assert!(text.contains("Pending review decision"));
    assert!(text.contains("The current batch has executed."));
    assert!(text.contains("## Execution result"));
    assert!(text.contains("WorkUnits completed: 2"));
    assert!(text.contains("## Files changed in this batch"));
    assert_eq!(
        text.matches("src/module.txt operation=write status=completed")
            .count(),
        1
    );
    assert!(!text.contains("review.summary.waitingUserReview"));
    assert!(!text.contains("session.projection.review.count.workUnitsCompleted"));
    assert!(!text.contains("internal reasoning should stay out"));
    assert!(text.contains("Decision target: review run=run-review target=review-1"));
    assert!(text.contains("DeepCode-CLI --session session-review decision review accept"));
}

#[test]
fn print_text_uses_pending_plan_projection_from_api_wrapper() {
    let timeline = json!({
        "ok": true,
        "data": {
            "sessionId": "session-print-wrapper",
            "turns": [
                {
                    "blocks": [
                        {
                            "events": [
                                {
                                    "kind": "plan_card",
                                    "payload": {
                                        "confirmable": true,
                                        "runId": "run-wrapper",
                                        "planId": "plan-wrapper",
                                        "readablePlan": {
                                            "summary": "Wrapped plan summary"
                                        }
                                    }
                                }
                            ]
                        }
                    ]
                }
            ]
        }
    });
    let canonical = canonical_pending_fixture(
        &timeline,
        "session-print-wrapper",
        "plan",
        "run-wrapper",
        "planId",
        "plan-wrapper",
    );
    let timeline = json!({ "ok": true, "data": canonical });

    let text = extract_plain_text(&timeline).expect("pending plan text");
    assert!(text.contains("Pending plan decision"));
    assert!(text.contains("Wrapped plan summary"));
    assert!(text.contains("Decision target: plan run=run-wrapper target=plan-wrapper"));
    assert!(text.contains("DeepCode-CLI --session session-print-wrapper decision plan accept"));
}
