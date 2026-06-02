use crate::hash::hash_skill_revision;
use crate::manifest::{SkillManifest, WorkspaceAccess};
use crate::risk::{RiskFindingKind, SkillRiskFinding, SkillRiskReport};
use crate::SkillTrustMode;
use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};

pub fn scan_skill_manifest(
    manifest: &SkillManifest,
    script_content: Option<&str>,
) -> SkillRiskReport {
    let mut findings = Vec::new();

    if manifest.requested_trust_mode == SkillTrustMode::DirectHostScript {
        findings.push(SkillRiskFinding::new(
            RiskFindingKind::DirectHostDisabled,
            RiskLevel::Critical,
            "DirectHostScript is reserved for a later high-risk extension and is disabled in v1.",
            None,
        ));
    }

    if manifest.workspace_access == WorkspaceAccess::ReadWrite
        || manifest
            .effects
            .contains(&CapabilityEffect::WritesWorkspace)
        || manifest
            .requested_capabilities
            .contains(&Capability::workspace_write())
    {
        findings.push(SkillRiskFinding::new(
            RiskFindingKind::WorkspaceWrite,
            RiskLevel::High,
            "Skill requests workspace write access.",
            None,
        ));
    }

    if manifest
        .requested_capabilities
        .contains(&Capability::network_egress())
        || manifest.effects.contains(&CapabilityEffect::UsesNetwork)
    {
        findings.push(SkillRiskFinding::new(
            RiskFindingKind::NetworkAccess,
            RiskLevel::High,
            "Skill requests network egress.",
            None,
        ));
    }

    if manifest
        .requested_capabilities
        .contains(&Capability::secret_read())
        || manifest.effects.contains(&CapabilityEffect::ReadsSecret)
    {
        findings.push(SkillRiskFinding::new(
            RiskFindingKind::SecretAccess,
            RiskLevel::Critical,
            "Skill requests secret access.",
            None,
        ));
    }

    if !manifest.env_allowlist.is_empty() {
        findings.push(SkillRiskFinding::new(
            RiskFindingKind::EnvExposure,
            RiskLevel::Medium,
            "Skill requests environment variable forwarding.",
            Some(manifest.env_allowlist.join(",")),
        ));
    }

    if let Some(script_content) = script_content {
        scan_script_content(script_content, &mut findings);
    }

    let revision_hash = script_content.map(|content| {
        let path = manifest
            .entrypoint
            .script_path
            .as_deref()
            .unwrap_or("entrypoint-script");
        hash_skill_revision(manifest, &[(path, content.as_bytes())])
    });

    SkillRiskReport {
        skill_id: manifest.skill_id.clone(),
        revision_hash: revision_hash.clone(),
        script_hash: revision_hash,
        requires_user_approval: manifest.requires_approval() || !findings.is_empty(),
        static_analysis_boundary:
            "Static analysis is advisory; Broker, PermissionGate, WorkspaceBoundary and AuditLedger remain the security boundary."
                .to_string(),
        findings,
    }
}

fn scan_script_content(script_content: &str, findings: &mut Vec<SkillRiskFinding>) {
    let lower = script_content.to_ascii_lowercase();
    for pattern in ["rm -rf", "remove-item -recurse", "mkfs", "format "] {
        if lower.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::DangerousCommand,
                RiskLevel::Critical,
                "Script contains a destructive command pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
    for pattern in ["curl ", "wget ", "requests.", "urllib", "fetch("] {
        if lower.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::NetworkAccess,
                RiskLevel::High,
                "Script contains a network access pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
    for pattern in ["subprocess", "os.system", "child_process", "exec("] {
        if lower.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::ProcessExecution,
                RiskLevel::High,
                "Script contains a process execution pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
    for pattern in ["../", "..\\"] {
        if script_content.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::PathTraversal,
                RiskLevel::High,
                "Script contains a path traversal pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
    for pattern in ["/tmp/", "c:\\", "d:\\", "e:\\"] {
        if lower.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::TempPath,
                RiskLevel::Medium,
                "Script contains a host-specific or temp path pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
    for pattern in ["gh_token", "openai_api_key", ".ssh", "id_rsa"] {
        if lower.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::SecretAccess,
                RiskLevel::Critical,
                "Script contains a secret access pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
    for pattern in ["git push", "git commit", "git reset", "git checkout --"] {
        if lower.contains(pattern) {
            findings.push(SkillRiskFinding::new(
                RiskFindingKind::GitMutation,
                RiskLevel::High,
                "Script contains a git mutation pattern.",
                Some(pattern.to_string()),
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        InvocationPolicy, SkillEntrypoint, SkillEntrypointKind, SkillManifestKind,
        SkillOutputPolicy, SkillSourceScope,
    };

    fn manifest() -> SkillManifest {
        SkillManifest {
            schema_version: 1,
            skill_id: "skill.scan".to_string(),
            version: "1".to_string(),
            title: "Scan".to_string(),
            description: None,
            kind: SkillManifestKind::BrokeredScript,
            entrypoint: SkillEntrypoint {
                kind: SkillEntrypointKind::Script,
                command: Some("python3".to_string()),
                args: vec!["skill.py".to_string()],
                script_path: Some("skill.py".to_string()),
            },
            requested_capabilities: vec![Capability::workspace_read()],
            effects: vec![CapabilityEffect::ReadsWorkspace],
            env_allowlist: Vec::new(),
            workspace_access: WorkspaceAccess::ReadOnly,
            timeout_ms: 1_000,
            requested_model_visible: false,
            requested_trust_mode: SkillTrustMode::BrokeredScript,
            source_scope: SkillSourceScope::Local,
            provenance: None,
            invocation_policy: InvocationPolicy::AskBeforeUse,
            output_policy: SkillOutputPolicy::TempOnly,
            runtime: None,
            resources: Vec::new(),
            limits: None,
            risk: None,
        }
    }

    #[test]
    fn static_scan_flags_risky_script_patterns_but_remains_advisory() {
        let manifest = manifest();
        let report = scan_skill_manifest(
            &manifest,
            Some("import subprocess\nsubprocess.run(['curl', '../x'])\nprint('/tmp/x')"),
        );
        assert!(report.requires_user_approval);
        assert!(report.revision_hash.unwrap().starts_with("sha256:"));
        assert!(report.script_hash.unwrap().starts_with("sha256:"));
        assert!(report
            .findings
            .iter()
            .any(|finding| finding.kind == RiskFindingKind::ProcessExecution));
        assert!(report
            .static_analysis_boundary
            .contains("Static analysis is advisory"));
    }

    #[test]
    fn direct_host_manifest_is_critical_and_disabled() {
        let mut manifest = manifest();
        manifest.requested_trust_mode = SkillTrustMode::DirectHostScript;
        let report = scan_skill_manifest(&manifest, None);
        assert_eq!(report.highest_risk(), Some(RiskLevel::Critical));
    }
}
