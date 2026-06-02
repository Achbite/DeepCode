use deepcode_kernel_policy::{Capability, CapabilityEffect, RiskLevel};
use deepcode_kernel_skills::external::broker::{BrokeredScriptRequest, ScriptBrokerPolicy};
use deepcode_kernel_skills::hash::hash_skill_material;
use deepcode_kernel_skills::scanner::scan_skill_manifest;
use deepcode_kernel_skills::{
    model_visible_mcp_tools, model_visible_skill_descriptors, McpConnectorDescriptor,
    McpToolBinding, SkillDescriptor, SkillExecutorKind, SkillManifest, SkillSource, SkillTrustMode,
    SkillTrustRecord,
};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn fixture_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("fixtures/skill-mcp-smoke")
}

fn read_json<T: DeserializeOwned>(relative_path: &str) -> T {
    let path = fixture_root().join(relative_path);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read fixture {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("decode fixture {}: {error}", path.display()))
}

fn read_text(relative_path: &str) -> String {
    let path = fixture_root().join(relative_path);
    fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read fixture {}: {error}", path.display()))
}

fn descriptor_from_manifest(manifest: &SkillManifest, source: SkillSource) -> SkillDescriptor {
    let risk_level = if manifest.requested_capabilities.is_empty() && manifest.effects.is_empty() {
        RiskLevel::Low
    } else {
        RiskLevel::Medium
    };
    SkillDescriptor {
        id: manifest.skill_id.clone(),
        version: manifest.version.clone(),
        title_key: None,
        description_key: None,
        input_schema: serde_json::json!({ "type": "object" }),
        output_schema: serde_json::json!({ "type": "object" }),
        required_capabilities: manifest.requested_capabilities.clone(),
        allowed_phases: vec!["plan".to_string(), "complete".to_string()],
        risk_level,
        effects: manifest.effects.clone(),
        source,
        executor_kind: SkillExecutorKind::LocalPack,
        model_visible: manifest.model_visible,
    }
}

fn trust_record(skill_id: &str, capabilities: Vec<Capability>) -> SkillTrustRecord {
    SkillTrustRecord {
        skill_id: skill_id.to_string(),
        script_hash: Some("sha256:fixture".to_string()),
        approved_capabilities: capabilities,
        approved_at: Some("2026-06-01T00:00:00Z".to_string()),
        approved_by: Some("fixture".to_string()),
        trust_mode: SkillTrustMode::BrokeredScript,
        ledger_event_ref: Some("fixture-ledger-event".to_string()),
        expires_at: None,
    }
}

#[test]
fn declarative_text_skill_fixture_is_model_visible_without_trust() {
    let manifest: SkillManifest = read_json("skills/text-echo-declarative/skill.manifest.json");
    assert_eq!(manifest.skill_id, "fixture.text.echo");
    assert_eq!(manifest.requested_trust_mode, SkillTrustMode::Declarative);
    assert!(!manifest.requires_approval());

    let descriptor = descriptor_from_manifest(
        &manifest,
        SkillSource::LocalPack {
            pack_id: "fixture.text".to_string(),
        },
    );
    let visible = model_visible_skill_descriptors(&[descriptor], &[], &[]);
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].id, "fixture.text.echo");
}

#[test]
fn brokered_text_skill_fixture_hash_scanner_and_catalog_are_stable() {
    let manifest: SkillManifest = read_json("skills/text-transform-brokered/skill.manifest.json");
    let script = read_text("skills/text-transform-brokered/transform.py");
    assert_eq!(
        manifest.requested_trust_mode,
        SkillTrustMode::BrokeredScript
    );
    assert!(manifest.requires_approval());

    let hash = hash_skill_material(&manifest, Some(script.as_bytes()));
    let same_hash = hash_skill_material(&manifest, Some(script.as_bytes()));
    let changed_hash = hash_skill_material(&manifest, Some(format!("{script}\n").as_bytes()));
    assert_eq!(hash, same_hash);
    assert_ne!(hash, changed_hash);

    let report = scan_skill_manifest(&manifest, Some(&script));
    assert!(report.requires_user_approval);
    assert!(report
        .script_hash
        .as_deref()
        .unwrap()
        .starts_with("sha256:"));
    assert!(report
        .static_analysis_boundary
        .contains("Static analysis is advisory"));
    assert!(report
        .findings
        .iter()
        .any(|finding| finding.kind == deepcode_kernel_skills::RiskFindingKind::EnvExposure));

    let descriptor = descriptor_from_manifest(
        &manifest,
        SkillSource::ExternalProcess {
            command: "python3 transform.py".to_string(),
        },
    );
    assert!(model_visible_skill_descriptors(
        &[descriptor.clone()],
        &[],
        &[Capability::workspace_read()]
    )
    .is_empty());

    let visible = model_visible_skill_descriptors(
        &[descriptor],
        &[trust_record(
            "fixture.text.transform",
            vec![Capability::workspace_read()],
        )],
        &[Capability::workspace_read()],
    );
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].effects, vec![CapabilityEffect::ReadsWorkspace]);
}

#[test]
fn direct_host_skill_fixture_remains_disabled() {
    let manifest: SkillManifest =
        read_json("skills/text-transform-brokered/direct-host-disabled.manifest.json");
    assert_eq!(
        manifest.requested_trust_mode,
        SkillTrustMode::DirectHostScript
    );
    assert!(!manifest.v1_runtime_enabled());
    let report = scan_skill_manifest(&manifest, None);
    assert_eq!(report.highest_risk(), Some(RiskLevel::Critical));
}

#[test]
fn broker_policy_authorizes_fixture_method_without_executing_script() {
    let policy = ScriptBrokerPolicy::new(vec![Capability::workspace_read()]);
    let request = BrokeredScriptRequest {
        request_id: "fixture-broker".to_string(),
        invocation_id: "fixture-invoke".to_string(),
        capability: Capability::workspace_read(),
        method: "kernel.fs.read".to_string(),
        arguments: serde_json::json!({ "path": "README.md" }),
    };

    let authorization = policy.authorize(&request).unwrap();
    assert_eq!(authorization.capability, Capability::workspace_read());
}

#[test]
fn mcp_descriptor_fixture_is_default_deny_until_acknowledged_binding() {
    let connector: McpConnectorDescriptor = read_json("mcp/mcp-text-tools/connector.json");
    let unacknowledged: McpToolBinding =
        read_json("mcp/mcp-text-tools/binding-unacknowledged.json");
    let acknowledged: McpToolBinding = read_json("mcp/mcp-text-tools/binding-acknowledged.json");

    assert!(model_visible_mcp_tools(&connector, &[], &[Capability::network_egress()]).is_empty());
    assert!(model_visible_mcp_tools(
        &connector,
        &[unacknowledged],
        &[Capability::network_egress()]
    )
    .is_empty());
    assert!(model_visible_mcp_tools(&connector, &[acknowledged.clone()], &[]).is_empty());

    let visible =
        model_visible_mcp_tools(&connector, &[acknowledged], &[Capability::network_egress()]);
    assert_eq!(visible.len(), 1);
    assert_eq!(visible[0].connector_id, "fixture.mcp.text-tools");
    assert_eq!(
        visible[0].internal_skill_id,
        "fixture.mcp.text-tools.text.reverse"
    );
}

#[test]
fn fixture_json_files_remain_structured_data() {
    let manifest: Value = read_json("skills/text-transform-brokered/skill.manifest.json");
    let connector: Value = read_json("mcp/mcp-text-tools/connector.json");
    assert_eq!(manifest["entrypoint"]["kind"], "script");
    assert_eq!(connector["tools"][0]["id"], "text.reverse");
}
