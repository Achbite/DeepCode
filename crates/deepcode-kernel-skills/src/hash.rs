use crate::SkillManifest;
use sha2::{Digest, Sha256};

pub fn hash_skill_material(manifest: &SkillManifest, script_bytes: Option<&[u8]>) -> String {
    match script_bytes {
        Some(bytes) => hash_skill_revision(manifest, &[("entrypoint-script", bytes)]),
        None => hash_skill_revision(manifest, &[]),
    }
}

pub fn hash_skill_revision(manifest: &SkillManifest, files: &[(&str, &[u8])]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"deepcode.skill.revision.v1\0");
    let manifest_bytes =
        serde_json::to_vec(manifest).expect("SkillManifest serialization should be infallible");
    hasher.update(b"manifest\0");
    hasher.update(&(manifest_bytes.len() as u64).to_be_bytes());
    hasher.update(manifest_bytes);

    let mut sorted = files.to_vec();
    sorted.sort_by(|left, right| left.0.cmp(right.0));
    for (path, bytes) in sorted {
        hasher.update(b"file\0");
        hasher.update(&(path.len() as u64).to_be_bytes());
        hasher.update(path.as_bytes());
        hasher.update(&(bytes.len() as u64).to_be_bytes());
        hasher.update(bytes);
    }
    format!("sha256:{}", hex_lower(&hasher.finalize()))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("sha256:{}", hex_lower(&hasher.finalize()))
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        InvocationPolicy, SkillEntrypoint, SkillEntrypointKind, SkillManifestKind,
        SkillOutputPolicy, SkillSourceScope, SkillTrustMode, WorkspaceAccess,
    };

    fn manifest() -> SkillManifest {
        SkillManifest {
            schema_version: 1,
            skill_id: "skill.hash".to_string(),
            version: "1".to_string(),
            title: "Hash".to_string(),
            description: None,
            kind: SkillManifestKind::BrokeredScript,
            entrypoint: SkillEntrypoint {
                kind: SkillEntrypointKind::Script,
                command: Some("python3".to_string()),
                args: vec!["skill.py".to_string()],
                script_path: Some("skill.py".to_string()),
            },
            requested_capabilities: Vec::new(),
            effects: Vec::new(),
            env_allowlist: Vec::new(),
            workspace_access: WorkspaceAccess::None,
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
    fn skill_material_hash_changes_with_script_content() {
        let manifest = manifest();
        let left = hash_skill_material(&manifest, Some(b"print(1)"));
        let right = hash_skill_material(&manifest, Some(b"print(2)"));
        assert!(left.starts_with("sha256:"));
        assert_ne!(left, right);
    }

    #[test]
    fn skill_revision_hash_changes_with_any_declared_file() {
        let manifest = manifest();
        let left = hash_skill_revision(
            &manifest,
            &[("SKILL.md", b"read me"), ("scripts/skill.py", b"print(1)")],
        );
        let same_with_different_order = hash_skill_revision(
            &manifest,
            &[("scripts/skill.py", b"print(1)"), ("SKILL.md", b"read me")],
        );
        let changed = hash_skill_revision(
            &manifest,
            &[
                ("SKILL.md", b"read me changed"),
                ("scripts/skill.py", b"print(1)"),
            ],
        );

        assert_eq!(left, same_with_different_order);
        assert_ne!(left, changed);
    }
}
