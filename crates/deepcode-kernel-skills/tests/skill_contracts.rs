use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use deepcode_kernel_skills::hash::{hash_skill_material, hash_skill_revision};
use deepcode_kernel_skills::scanner::scan_skill_manifest;
use deepcode_kernel_skills::{
    InvocationPolicy, McpAuthDeclaration, McpConnectorManifest, McpServerIdentity,
    McpTransportDeclaration, PluginBundleContents, PluginBundleManifest, PluginBundlePolicy,
    PluginRiskSummary, SkillEntrypoint, SkillEntrypointKind, SkillManifest, SkillManifestKind,
    SkillOutputPolicy, SkillSourceScope, SkillTrustMode, WorkspaceAccess,
};

fn dormant_manifest() -> SkillManifest {
    SkillManifest {
        schema_version: 1,
        skill_id: "extension.read-only".to_string(),
        version: "1".to_string(),
        title: "Read-only extension".to_string(),
        description: None,
        kind: SkillManifestKind::BrokeredScript,
        entrypoint: SkillEntrypoint {
            kind: SkillEntrypointKind::ExternalProcess,
            program: Some("python3".to_string()),
            argv: vec!["extension.py".to_string()],
            script_path: Some("extension.py".to_string()),
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
fn skill_hash_and_scanner_are_deterministic_without_execution() {
    let manifest = dormant_manifest();
    let content = "print('read only')";
    assert_eq!(
        hash_skill_material(&manifest, Some(content.as_bytes())),
        hash_skill_material(&manifest, Some(content.as_bytes()))
    );
    assert_ne!(
        hash_skill_revision(&manifest, &[("extension.py", content.as_bytes())]),
        hash_skill_revision(
            &manifest,
            &[("extension.py", format!("{content}\n").as_bytes())]
        )
    );
    let report = scan_skill_manifest(&manifest, Some(content));
    assert!(report.requires_user_approval);
}

#[test]
fn mcp_transport_remains_a_dormant_typed_contract() {
    let manifest = McpConnectorManifest {
        schema_version: 1,
        connector_id: "connector.example".to_string(),
        version: "1".to_string(),
        server: McpServerIdentity {
            name: "Example".to_string(),
            vendor: None,
        },
        transport: McpTransportDeclaration {
            kind: "stdio".to_string(),
            program: Some("adapter".to_string()),
            argv: vec!["--stdio".to_string()],
            endpoint: None,
        },
        auth: McpAuthDeclaration {
            kind: "none".to_string(),
            secret_ref: None,
        },
        descriptor_snapshot_hash: Some("sha256:contract".to_string()),
        risk_level: RiskLevel::High,
    };
    let encoded = serde_json::to_value(manifest).unwrap();
    assert_eq!(encoded["transport"]["program"], "adapter");
    assert_eq!(encoded["transport"]["argv"][0], "--stdio");
}

#[test]
fn plugin_manifest_cannot_grant_or_enable_runtime_capability() {
    let plugin = PluginBundleManifest {
        schema_version: 1,
        plugin_id: "plugin.example".to_string(),
        namespace: "example".to_string(),
        name: "Example plugin".to_string(),
        version: "1".to_string(),
        revision_hash: None,
        provenance: None,
        contents: PluginBundleContents::default(),
        policy: PluginBundlePolicy::default(),
        risk: PluginRiskSummary::default(),
    };
    assert!(!plugin.grants_capability());
    assert!(!plugin.enables_runtime_capability());
}
