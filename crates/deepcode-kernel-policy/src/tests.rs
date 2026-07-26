use super::*;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let path =
            std::env::temp_dir().join(format!("deepcode-policy-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&path).expect("create policy test directory");
        Self(path)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn request(capability: Capability, risk_level: RiskLevel) -> PermissionRequest {
    PermissionRequest {
        id: "perm-1".to_string(),
        run_id: Some("run-1".to_string()),
        capability,
        risk_level,
        summary: "permission".to_string(),
        args_preview: serde_json::json!({}),
        skill_id: None,
        effects: Vec::new(),
        source_trust: None,
        resource_scope: Some(ResourceScope::workspace_file("src/main.rs")),
        impact: PermissionImpact::default(),
    }
}

#[test]
fn developer_profile_allows_read_and_asks_write() {
    let profile = PolicyProfile::developer_defaults();
    let gate = DefaultPermissionGate;

    let read = gate
        .evaluate(
            &profile,
            &request(Capability::workspace_read(), RiskLevel::Low),
        )
        .unwrap();
    assert_eq!(read.decision, PolicyDecisionKind::Allow);
    assert!(read.request.is_none());

    let write = gate
        .evaluate(
            &profile,
            &request(Capability::workspace_write(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(write.decision, PolicyDecisionKind::Ask);
    assert!(write.request.is_some());
}

#[test]
fn missing_capability_denies_by_default() {
    let profile = PolicyProfile::developer_defaults();
    let gate = DefaultPermissionGate;
    let decision = gate
        .evaluate(
            &profile,
            &request(Capability::network_egress(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(decision.decision, PolicyDecisionKind::Deny);
}

#[test]
fn workspace_source_cannot_self_grant_allow() {
    let mut profile = PolicyProfile::developer_defaults();
    let error = profile
        .grant(PolicyGrant {
            capability: Capability::process_exec(),
            decision: PolicyDecisionKind::Allow,
            source: PolicySourceTrust::Workspace,
            reason: Some("workspace requested shell".to_string()),
        })
        .unwrap_err();

    assert!(matches!(error, KernelError::PermissionDenied(_)));
}

#[test]
fn autonomy_profiles_have_expected_permission_matrix() {
    let gate = DefaultPermissionGate;

    let safe = PolicyProfile::safe_defaults();
    let safe_write = gate
        .evaluate(
            &safe,
            &request(Capability::workspace_write(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(safe_write.decision, PolicyDecisionKind::Ask);

    let trusted = PolicyProfile::trusted_workspace_defaults();
    let trusted_write = gate
        .evaluate(
            &trusted,
            &request(Capability::workspace_write(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(trusted_write.decision, PolicyDecisionKind::Allow);

    let trusted_repeated_write = gate
        .evaluate(
            &trusted,
            &request(Capability::workspace_write(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(trusted_repeated_write.decision, PolicyDecisionKind::Allow);

    let trusted_critical_write = gate
        .evaluate(
            &trusted,
            &request(Capability::workspace_write(), RiskLevel::Critical),
        )
        .unwrap();
    assert_eq!(trusted_critical_write.decision, PolicyDecisionKind::Allow);

    let expert = PolicyProfile::expert_defaults();
    let expert_shell = gate
        .evaluate(
            &expert,
            &request(Capability::process_exec(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(expert_shell.decision, PolicyDecisionKind::Ask);

    let maintainer = PolicyProfile::maintainer_defaults();
    let kernel_modify = gate
        .evaluate(
            &maintainer,
            &PermissionRequest {
                resource_scope: Some(ResourceScope {
                    kind: ResourceScopeKind::Kernel,
                    path: None,
                    managed_by_kernel: true,
                }),
                ..request(Capability::kernel_modify(), RiskLevel::Critical)
            },
        )
        .unwrap();
    assert_eq!(kernel_modify.decision, PolicyDecisionKind::Ask);
}

fn v2_candidate(
    autonomy_mode: GrantAutonomyModeV2,
    operation_kind: deepcode_kernel_abi::ToolOperationKind,
) -> CapabilityGrantAutoIssueCandidateV2 {
    use deepcode_kernel_abi::{
        OperationExecutionMode, TargetExistence, ToolOperationKind, ToolPermissionMode,
        ToolRiskLevel,
    };

    let (tool_id, risk, resource_scope, effect_scope) = match operation_kind {
        ToolOperationKind::FsRead => (
            "fs.read",
            ToolRiskLevel::Low,
            GrantResolvedScopeV2::ExactWorkspace {
                resources: vec!["resource:file:src/lib.rs".to_string()],
            },
            vec!["workspace.read:file".to_string()],
        ),
        ToolOperationKind::FsWrite => (
            "fs.write",
            ToolRiskLevel::Medium,
            GrantResolvedScopeV2::ExactWorkspace {
                resources: vec!["resource:file:src/lib.rs".to_string()],
            },
            vec!["workspace.write:file".to_string()],
        ),
        ToolOperationKind::FsRename => (
            "fs.rename",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::ExactWorkspace {
                resources: vec![
                    "resource:file:src/old.rs".to_string(),
                    "resource:file:src/new.rs".to_string(),
                ],
            },
            vec!["workspace.rename:no-overwrite".to_string()],
        ),
        ToolOperationKind::FsDelete => (
            "fs.delete",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::ExactWorkspace {
                resources: vec!["resource:file:src/lib.rs".to_string()],
            },
            vec!["workspace.delete:file".to_string()],
        ),
        ToolOperationKind::GitStage => (
            "git.stage",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::ExactGitWorkspace {
                resources: vec!["resource:git-index:workspace".to_string()],
            },
            vec!["git.index:stage".to_string()],
        ),
        ToolOperationKind::GitUnstage => (
            "git.unstage",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::ExactGitWorkspace {
                resources: vec!["resource:git-index:workspace".to_string()],
            },
            vec!["git.index:unstage".to_string()],
        ),
        ToolOperationKind::GitCommit => (
            "git.commit",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::ExactGitWorkspace {
                resources: vec!["resource:git-index:workspace".to_string()],
            },
            vec!["git.commit:create".to_string()],
        ),
        ToolOperationKind::GitPush => (
            "git.push",
            ToolRiskLevel::Critical,
            GrantResolvedScopeV2::ExactGitWorkspace {
                resources: vec!["resource:git-remote:origin".to_string()],
            },
            vec!["git.remote:push".to_string()],
        ),
        ToolOperationKind::ProcessExec => (
            "process.exec",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::Process,
            vec!["process.execute".to_string()],
        ),
        ToolOperationKind::WebFetch => (
            "web.fetch",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::Network,
            vec!["network.fetch".to_string()],
        ),
        ToolOperationKind::BrowserClick => (
            "browser.click",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::Browser,
            vec!["browser.click".to_string()],
        ),
        ToolOperationKind::ProviderCall => (
            "provider.call",
            ToolRiskLevel::High,
            GrantResolvedScopeV2::Provider,
            vec!["provider.call".to_string()],
        ),
        _ => panic!("v2 test candidate does not cover {operation_kind:?}"),
    };

    CapabilityGrantAutoIssueCandidateV2 {
        autonomy_mode,
        tool_id: tool_id.to_string(),
        operation_kind,
        permission_mode: ToolPermissionMode::Ask,
        execution_mode: OperationExecutionMode::Execute,
        risk,
        resource_scope,
        effect_scope,
        rename_destination_existence: (operation_kind == ToolOperationKind::FsRename)
            .then_some(TargetExistence::MustNotExist),
    }
}

#[test]
fn v2_strict_auto_issues_only_low_risk_local_grants() {
    use deepcode_kernel_abi::ToolOperationKind;

    let read = evaluate_capability_grant_auto_issue_v2(&v2_candidate(
        GrantAutonomyModeV2::Strict,
        ToolOperationKind::FsRead,
    ));
    assert!(read.is_auto_issue());
    assert_eq!(
        read.reason,
        CapabilityGrantAutoIssueReasonV2::LowRiskLocalTool
    );

    for operation in [ToolOperationKind::FsWrite, ToolOperationKind::FsRename] {
        let decision = evaluate_capability_grant_auto_issue_v2(&v2_candidate(
            GrantAutonomyModeV2::Strict,
            operation,
        ));
        assert_eq!(
            decision.decision,
            CapabilityGrantAutoIssueDecisionV2::RequireExplicitDecision
        );
    }
}

#[test]
fn v2_trusted_workspace_requires_exact_bounded_medium_mutation_scope() {
    use deepcode_kernel_abi::ToolOperationKind;

    let bounded = evaluate_capability_grant_auto_issue_v2(&v2_candidate(
        GrantAutonomyModeV2::TrustedWorkspace,
        ToolOperationKind::FsWrite,
    ));
    assert!(bounded.is_auto_issue());
    assert_eq!(
        bounded.reason,
        CapabilityGrantAutoIssueReasonV2::BoundedMediumWorkspaceMutation
    );

    let mut unresolved = v2_candidate(
        GrantAutonomyModeV2::TrustedWorkspace,
        ToolOperationKind::FsWrite,
    );
    unresolved.resource_scope = GrantResolvedScopeV2::UnresolvedOrUnbounded;
    let decision = evaluate_capability_grant_auto_issue_v2(&unresolved);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::MissingExactResourceOrEffectScope
    );

    let rename = evaluate_capability_grant_auto_issue_v2(&v2_candidate(
        GrantAutonomyModeV2::TrustedWorkspace,
        ToolOperationKind::FsRename,
    ));
    assert!(!rename.is_auto_issue());
}

#[test]
fn v2_maximum_auto_issues_only_the_three_reversible_high_operations() {
    use deepcode_kernel_abi::ToolOperationKind;

    for operation in [
        ToolOperationKind::FsRename,
        ToolOperationKind::GitStage,
        ToolOperationKind::GitUnstage,
    ] {
        let decision = evaluate_capability_grant_auto_issue_v2(&v2_candidate(
            GrantAutonomyModeV2::Maximum,
            operation,
        ));
        assert!(decision.is_auto_issue(), "{operation:?}: {decision:?}");
        assert_eq!(
            decision.reason,
            CapabilityGrantAutoIssueReasonV2::MaximumReversibleHighOperation
        );
    }

    let mut overwrite = v2_candidate(GrantAutonomyModeV2::Maximum, ToolOperationKind::FsRename);
    overwrite.rename_destination_existence = Some(deepcode_kernel_abi::TargetExistence::Any);
    let decision = evaluate_capability_grant_auto_issue_v2(&overwrite);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::RenameMayOverwrite
    );
}

#[test]
fn v2_never_auto_issues_excluded_external_or_critical_authority() {
    use deepcode_kernel_abi::ToolOperationKind;

    for operation in [
        ToolOperationKind::FsDelete,
        ToolOperationKind::GitCommit,
        ToolOperationKind::GitPush,
        ToolOperationKind::ProcessExec,
        ToolOperationKind::WebFetch,
        ToolOperationKind::BrowserClick,
        ToolOperationKind::ProviderCall,
    ] {
        let decision = evaluate_capability_grant_auto_issue_v2(&v2_candidate(
            GrantAutonomyModeV2::Maximum,
            operation,
        ));
        assert!(!decision.is_auto_issue(), "{operation:?}: {decision:?}");
    }

    let mut external_low = v2_candidate(GrantAutonomyModeV2::Maximum, ToolOperationKind::FsRead);
    external_low.resource_scope = GrantResolvedScopeV2::External {
        resources: vec!["resource:file:/outside/workspace".to_string()],
    };
    let decision = evaluate_capability_grant_auto_issue_v2(&external_low);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::ExternalOrNonWorkspaceAuthority
    );
}

#[test]
fn v2_contract_mismatch_and_deny_fail_closed() {
    use deepcode_kernel_abi::{
        OperationExecutionMode, ToolOperationKind, ToolPermissionMode, ToolRiskLevel,
    };

    let mut mismatch = v2_candidate(GrantAutonomyModeV2::Maximum, ToolOperationKind::FsRename);
    mismatch.risk = ToolRiskLevel::Low;
    let decision = evaluate_capability_grant_auto_issue_v2(&mismatch);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::ToolContractMismatch
    );

    let mut denied = v2_candidate(GrantAutonomyModeV2::Maximum, ToolOperationKind::GitStage);
    denied.permission_mode = ToolPermissionMode::Deny;
    let decision = evaluate_capability_grant_auto_issue_v2(&denied);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::ToolContractDenied
    );

    let mut blocked = v2_candidate(GrantAutonomyModeV2::Maximum, ToolOperationKind::GitStage);
    blocked.execution_mode = OperationExecutionMode::Blocked;
    let decision = evaluate_capability_grant_auto_issue_v2(&blocked);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::ToolContractNotExecutable
    );

    let mut missing_tool_identity =
        v2_candidate(GrantAutonomyModeV2::Strict, ToolOperationKind::FsRead);
    missing_tool_identity.tool_id = " ".to_string();
    let decision = evaluate_capability_grant_auto_issue_v2(&missing_tool_identity);
    assert!(!decision.is_auto_issue());
    assert_eq!(
        decision.reason,
        CapabilityGrantAutoIssueReasonV2::ToolContractMismatch
    );
}

#[test]
fn trusted_workspace_full_access_does_not_cover_deepcode_config_assets() {
    let gate = DefaultPermissionGate;
    let profile = PolicyProfile::trusted_workspace_defaults();
    let decision = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                resource_scope: Some(ResourceScope::workspace_file(
                    ".deepcode/ruler/project-rules.md",
                )),
                ..request(Capability::workspace_write(), RiskLevel::High)
            },
        )
        .unwrap();

    assert_eq!(decision.decision, PolicyDecisionKind::Deny);
    assert!(decision
        .reason
        .as_deref()
        .unwrap_or_default()
        .contains(".deepcode"));
}

#[test]
fn hard_floor_denies_even_for_maintainer_profile() {
    let gate = DefaultPermissionGate;
    let profile = PolicyProfile::maintainer_defaults();

    let decision = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                resource_scope: Some(ResourceScope::workspace_file("src")),
                impact: PermissionImpact {
                    effect_surface: EffectSurface::SystemPath,
                    batch_size: BatchSize::Unbounded,
                    persistence: Persistence::Persistent,
                    outside_workspace: OutsideWorkspace::Forbidden,
                    hard_floor: None,
                },
                ..request(Capability::workspace_write(), RiskLevel::Critical)
            },
        )
        .unwrap();

    assert_eq!(decision.decision, PolicyDecisionKind::Deny);
    assert!(decision
        .reason
        .as_deref()
        .unwrap_or_default()
        .contains("hard floor"));
}

#[test]
fn outside_workspace_write_is_a_kernel_hard_floor() {
    let gate = DefaultPermissionGate;
    let profile = PolicyProfile::trusted_workspace_defaults();
    let decision = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                resource_scope: Some(ResourceScope::external_file("/tmp/research.md")),
                impact: PermissionImpact {
                    effect_surface: EffectSurface::ExternalReadOnly,
                    outside_workspace: OutsideWorkspace::ReadOnlyReference,
                    ..PermissionImpact::default()
                },
                ..request(Capability::workspace_write(), RiskLevel::Critical)
            },
        )
        .unwrap();

    assert_eq!(decision.decision, PolicyDecisionKind::Deny);
}

#[test]
fn kernel_modify_requires_maintainer_autonomy_floor() {
    let gate = DefaultPermissionGate;
    let trusted = PolicyProfile::trusted_workspace_defaults();
    let denied = gate
        .evaluate(
            &trusted,
            &PermissionRequest {
                resource_scope: Some(ResourceScope {
                    kind: ResourceScopeKind::Kernel,
                    path: None,
                    managed_by_kernel: true,
                }),
                impact: PermissionImpact {
                    effect_surface: EffectSurface::Kernel,
                    persistence: Persistence::Persistent,
                    ..PermissionImpact::default()
                },
                ..request(Capability::kernel_modify(), RiskLevel::Critical)
            },
        )
        .unwrap();
    assert_eq!(denied.decision, PolicyDecisionKind::Deny);

    let maintainer = PolicyProfile::maintainer_defaults();
    let ask = gate
        .evaluate(
            &maintainer,
            &PermissionRequest {
                resource_scope: Some(ResourceScope {
                    kind: ResourceScopeKind::Kernel,
                    path: None,
                    managed_by_kernel: true,
                }),
                impact: PermissionImpact {
                    effect_surface: EffectSurface::Kernel,
                    persistence: Persistence::Persistent,
                    ..PermissionImpact::default()
                },
                ..request(Capability::kernel_modify(), RiskLevel::Critical)
            },
        )
        .unwrap();
    assert_eq!(ask.decision, PolicyDecisionKind::Ask);
}

#[test]
fn windows_shell_policy_defaults_to_wsl_and_respects_override() {
    let policy = ExecutionEnvironmentPolicy::windows_default();
    let missing_wsl = policy.decide_windows_shell(false);
    assert_eq!(missing_wsl.shell, ShellRuntimePreference::Wsl);
    assert!(missing_wsl.requires_wsl_install);
    assert_eq!(
        missing_wsl.message_key.as_deref(),
        Some("execution.windows.wslInstallRequired")
    );

    let policy = ExecutionEnvironmentPolicy {
        host_shell_override: Some(HostShellOverride {
            shell: ShellRuntimePreference::PowerShell,
            reason: Some("user explicitly requested Windows shell".to_string()),
            acknowledged_risk: true,
        }),
        ..ExecutionEnvironmentPolicy::windows_default()
    };
    let override_decision = policy.decide_windows_shell(false);
    assert_eq!(override_decision.shell, ShellRuntimePreference::PowerShell);
    assert!(override_decision.host_override_recorded);
    assert!(!override_decision.requires_wsl_install);
}

#[test]
fn docker_policy_is_default_recommendation_not_hard_requirement() {
    let policy = ExecutionEnvironmentPolicy {
        prefer_docker: false,
        host_shell_override: Some(HostShellOverride {
            shell: ShellRuntimePreference::Cmd,
            reason: Some("user disabled Docker".to_string()),
            acknowledged_risk: true,
        }),
        ..ExecutionEnvironmentPolicy::windows_default()
    };
    let decision = policy.decide_windows_shell(true);

    assert!(!decision.prefer_docker);
    assert_eq!(decision.shell, ShellRuntimePreference::Cmd);
    assert!(decision.host_override_recorded);
}

#[test]
fn workspace_boundary_rejects_escaped_paths() {
    let root = TestDirectory::new();
    let boundary = WorkspaceBoundary::new(&root.0);
    for path in ["/etc/passwd", "../secret.txt", "C:/Users/test/file.txt"] {
        assert!(
            boundary.resolve_read(path).is_err(),
            "{path} must not resolve through the workspace boundary"
        );
    }
    assert_eq!(
        boundary.resolve_read("src/main.rs").unwrap(),
        root.0.join("src/main.rs")
    );
}

#[cfg(unix)]
#[test]
fn workspace_boundary_allows_in_root_read_symlink_but_rejects_mutation() {
    use std::os::unix::fs::symlink;

    let root = TestDirectory::new();
    let target = root.0.join("target.txt");
    fs::write(&target, "value").expect("write symlink target");
    symlink(&target, root.0.join("link.txt")).expect("create in-root symlink");

    let boundary = WorkspaceBoundary::new(&root.0);
    assert_eq!(boundary.resolve_read("link.txt").unwrap(), target);
    assert!(boundary.resolve_mutation("link.txt").is_err());
}

#[cfg(unix)]
#[test]
fn workspace_boundary_rejects_out_of_root_symlink_reads_and_mutations() {
    use std::os::unix::fs::symlink;

    let root = TestDirectory::new();
    let external = TestDirectory::new();
    fs::write(external.0.join("outside.txt"), "value").expect("write external target");
    symlink(&external.0, root.0.join("outside")).expect("create outside symlink");

    let boundary = WorkspaceBoundary::new(&root.0);
    assert!(boundary.resolve_read("outside/outside.txt").is_err());
    assert!(boundary.resolve_mutation("outside/new-file.txt").is_err());
}

#[test]
fn workspace_boundary_blocks_protected_config_asset_mutation() {
    assert!(WorkspaceBoundary::assert_mutable_config_asset("src/lib.rs").is_ok());
    assert!(WorkspaceBoundary::assert_mutable_config_asset(".deepcode/policy/rules.json").is_err());
    assert!(
        WorkspaceBoundary::assert_mutable_config_asset(".deepcode\\skills\\demo.json").is_err()
    );
}
