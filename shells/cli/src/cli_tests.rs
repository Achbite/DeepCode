use super::*;

#[test]
fn parser_rejects_removed_tools_commands() {
    for arguments in [vec!["tools", "run", "fs.write"], vec!["tools", "verify"]] {
        let result = Command::parse(arguments.into_iter().map(str::to_string).collect());
        assert!(
            result.is_err(),
            "product CLI must not expose a direct tool execution or verifier command"
        );
    }
}

#[test]
fn parser_accepts_v2_plan_decision_identity() {
    let command = Command::parse(
        [
            "--session",
            "session-v2",
            "decision",
            "plan",
            "accept",
            "run-v2",
            "plan-revision-v2",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
    )
    .expect("v2 plan decision parses");

    let Command::Decision {
        kind,
        decision,
        run_id,
        target_id,
        guidance,
        host,
        ..
    } = command
    else {
        panic!("expected a v2 decision command");
    };
    assert_eq!(kind, "plan");
    assert_eq!(decision, "accept");
    assert_eq!(run_id.as_deref(), Some("run-v2"));
    assert_eq!(target_id.as_deref(), Some("plan-revision-v2"));
    assert!(guidance.is_none());
    assert_eq!(host.session_id.as_deref(), Some("session-v2"));
}

#[test]
fn parser_accepts_v2_permission_denial_guidance() {
    let command = Command::parse(
        [
            "permission",
            "reject",
            "run-v2",
            "invocation-v2",
            "keep changes inside src",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
    )
    .expect("v2 permission decision parses");

    let Command::Decision {
        kind,
        decision,
        run_id,
        target_id,
        guidance,
        ..
    } = command
    else {
        panic!("expected a v2 permission decision command");
    };
    assert_eq!(kind, "permission");
    assert_eq!(decision, "reject");
    assert_eq!(run_id.as_deref(), Some("run-v2"));
    assert_eq!(target_id.as_deref(), Some("invocation-v2"));
    assert_eq!(guidance.as_deref(), Some("keep changes inside src"));
}

#[test]
fn help_is_side_effect_free_and_direct_tool_commands_remain_unreachable() {
    assert!(matches!(
        Command::parse(vec!["--help".to_string()]).expect("help parses"),
        Command::Help
    ));
    assert!(Command::parse(vec![
        "--no-auto-start-kernel".to_string(),
        "tools".to_string(),
        "run".to_string(),
        "fs.read".to_string(),
    ])
    .is_err());
}
