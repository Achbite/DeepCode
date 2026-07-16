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

    let trusted_create = gate
        .evaluate(
            &trusted,
            &request(Capability::workspace_create(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(trusted_create.decision, PolicyDecisionKind::Allow);

    let trusted_delete = gate
        .evaluate(
            &trusted,
            &request(Capability::workspace_delete(), RiskLevel::High),
        )
        .unwrap();
    assert_eq!(trusted_delete.decision, PolicyDecisionKind::Allow);

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
fn temporary_grant_is_run_capability_and_resource_scoped() {
    let gate = DefaultPermissionGate;
    let mut profile = PolicyProfile::safe_defaults();
    profile
        .grant_temporary(TemporaryGrant {
            id: "grant-1".to_string(),
            run_id: "run-allowed".to_string(),
            capability: Capability::workspace_write(),
            resource_scope: ResourceScope::workspace_file("src/main.rs"),
            decision: PolicyDecisionKind::Allow,
            expires_after_sequence: Some(20),
            reason: Some("user accepted temporary write".to_string()),
        })
        .unwrap();

    let allowed = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                run_id: Some("run-allowed".to_string()),
                resource_scope: Some(ResourceScope::workspace_file("src/main.rs")),
                ..request(Capability::workspace_write(), RiskLevel::High)
            },
        )
        .unwrap();
    assert_eq!(allowed.decision, PolicyDecisionKind::Allow);

    let different_run = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                run_id: Some("run-other".to_string()),
                resource_scope: Some(ResourceScope::workspace_file("src/main.rs")),
                ..request(Capability::workspace_write(), RiskLevel::High)
            },
        )
        .unwrap();
    assert_eq!(different_run.decision, PolicyDecisionKind::Ask);

    let different_resource = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                run_id: Some("run-allowed".to_string()),
                resource_scope: Some(ResourceScope::workspace_file("src/lib.rs")),
                ..request(Capability::workspace_write(), RiskLevel::High)
            },
        )
        .unwrap();
    assert_eq!(different_resource.decision, PolicyDecisionKind::Ask);
}

#[test]
fn hard_floor_denies_before_temporary_grant() {
    let gate = DefaultPermissionGate;
    let mut profile = PolicyProfile::maintainer_defaults();
    profile
        .grant_temporary(TemporaryGrant {
            id: "grant-delete".to_string(),
            run_id: "run-1".to_string(),
            capability: Capability::workspace_delete(),
            resource_scope: ResourceScope::workspace_file("src"),
            decision: PolicyDecisionKind::Allow,
            expires_after_sequence: None,
            reason: Some("user allowed cleanup".to_string()),
        })
        .unwrap();

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
                ..request(Capability::workspace_delete(), RiskLevel::Critical)
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
fn outside_workspace_write_requires_matching_temporary_grant() {
    let gate = DefaultPermissionGate;
    let mut profile = PolicyProfile::trusted_workspace_defaults();
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

    profile
        .grant_temporary(TemporaryGrant {
            id: "grant-external-write".to_string(),
            run_id: "run-1".to_string(),
            capability: Capability::workspace_write(),
            resource_scope: ResourceScope::external_file("/tmp/research.md"),
            decision: PolicyDecisionKind::Allow,
            expires_after_sequence: None,
            reason: Some("user accepted outside workspace file operation".to_string()),
        })
        .unwrap();

    let allowed = gate
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
    assert_eq!(allowed.decision, PolicyDecisionKind::Allow);

    let sibling = gate
        .evaluate(
            &profile,
            &PermissionRequest {
                resource_scope: Some(ResourceScope::external_file("/tmp/sibling.md")),
                impact: PermissionImpact {
                    effect_surface: EffectSurface::ExternalReadOnly,
                    outside_workspace: OutsideWorkspace::ReadOnlyReference,
                    ..PermissionImpact::default()
                },
                ..request(Capability::workspace_write(), RiskLevel::Critical)
            },
        )
        .unwrap();
    assert_eq!(sibling.decision, PolicyDecisionKind::Deny);
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
