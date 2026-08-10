use crate::scanner::scan_skill_manifest;
use crate::{SkillActivationStatus, SkillManifest, SkillTrustMode, WorkspaceAccess};
use deepcode_kernel_policy::RiskLevel;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_DEPTH: usize = 3;
const MAX_SKILLS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMountEntry {
    pub source_kind: String,
    pub manifest_status: String,
    pub source_path: String,
    pub relative_path: String,
    pub skill_id: String,
    pub version: String,
    pub title: String,
    pub description: String,
    pub entrypoint_kind: String,
    pub trust_mode: String,
    pub workspace_access: String,
    pub requested_capabilities: Vec<String>,
    pub effects: Vec<String>,
    pub env_allowlist: Vec<String>,
    pub model_visible: bool,
    pub requires_approval: bool,
    pub activation_status: SkillActivationStatus,
    pub risk_level: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillMountScanResult {
    pub mount_path: String,
    pub scanned_at: String,
    pub skills: Vec<SkillMountEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillMountScanError {
    pub code: &'static str,
    pub message: String,
}

pub fn scan_skill_mount(path: &Path) -> Result<SkillMountScanResult, SkillMountScanError> {
    if path.as_os_str().is_empty() {
        return Err(SkillMountScanError {
            code: "invalid_request",
            message: "path is required".to_string(),
        });
    }
    let root = path.canonicalize().map_err(|error| SkillMountScanError {
        code: "skill_mount_unavailable",
        message: format!("cannot resolve {}: {error}", path.display()),
    })?;
    if !root.is_dir() {
        return Err(SkillMountScanError {
            code: "skill_mount_not_directory",
            message: format!("{} is not a directory", root.display()),
        });
    }

    let mut skills = Vec::new();
    let mut warnings = Vec::new();
    scan_directory(&root, &root, 0, &mut skills, &mut warnings);
    Ok(SkillMountScanResult {
        mount_path: root.to_string_lossy().to_string(),
        scanned_at: scan_timestamp(),
        skills,
        warnings,
    })
}

fn scan_directory(
    root: &Path,
    directory: &Path,
    depth: usize,
    skills: &mut Vec<SkillMountEntry>,
    warnings: &mut Vec<String>,
) {
    if skills.len() >= MAX_SKILLS {
        return;
    }

    if let Some(manifest_path) = ["skill.manifest.json", "manifest.json"]
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.is_file())
    {
        match read_manifest(root, directory, &manifest_path) {
            Ok(entry) => skills.push(entry),
            Err(error) => warnings.push(error),
        }
    } else {
        let skill_markdown = directory.join("SKILL.md");
        if skill_markdown.is_file() {
            match read_skill_markdown(root, directory, &skill_markdown) {
                Ok(entry) => skills.push(entry),
                Err(error) => warnings.push(error),
            }
        }
    }

    if depth >= MAX_DEPTH || skills.len() >= MAX_SKILLS {
        return;
    }
    let entries = match sorted_entries(directory) {
        Ok(entries) => entries,
        Err(error) => {
            warnings.push(format!("failed to read {}: {error}", directory.display()));
            return;
        }
    };
    for entry in entries {
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                warnings.push(format!(
                    "failed to inspect {}: {error}",
                    entry.path().display()
                ));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if !file_type.is_dir()
            || file_type.is_symlink()
            || name.starts_with('.')
            || matches!(name.as_str(), "node_modules" | "target")
        {
            continue;
        }
        scan_directory(root, &entry.path(), depth + 1, skills, warnings);
        if skills.len() >= MAX_SKILLS {
            warnings.push("skill scan limit reached; remaining folders were skipped".to_string());
            break;
        }
    }
}

fn read_manifest(root: &Path, directory: &Path, path: &Path) -> Result<SkillMountEntry, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("read {} failed: {error}", path.display()))?;
    let manifest: SkillManifest = serde_json::from_str(&raw)
        .map_err(|error| format!("parse {} failed: {error}", path.display()))?;
    let risk = scan_skill_manifest(&manifest, None);
    let risk_level = risk.highest_risk().unwrap_or(RiskLevel::Low);
    Ok(SkillMountEntry {
        source_kind: "manifest".to_string(),
        manifest_status: "parsed".to_string(),
        source_path: path.to_string_lossy().to_string(),
        relative_path: relative_path(root, directory),
        skill_id: manifest.skill_id,
        version: manifest.version,
        title: manifest.title,
        description: manifest.description.unwrap_or_default(),
        entrypoint_kind: enum_name(&manifest.entrypoint.kind),
        trust_mode: enum_name(&manifest.requested_trust_mode),
        workspace_access: enum_name(&manifest.workspace_access),
        requested_capabilities: manifest
            .requested_capabilities
            .into_iter()
            .map(|capability| capability.0)
            .collect(),
        effects: manifest.effects.iter().map(enum_name).collect(),
        env_allowlist: manifest.env_allowlist,
        model_visible: manifest.requested_model_visible,
        requires_approval: risk.requires_user_approval,
        activation_status: SkillActivationStatus::Dormant,
        risk_level: enum_name(&risk_level),
    })
}

fn read_skill_markdown(
    root: &Path,
    directory: &Path,
    path: &Path,
) -> Result<SkillMountEntry, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("read {} failed: {error}", path.display()))?;
    let title = raw
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|line| !line.is_empty())
        .or_else(|| directory.file_name().and_then(|name| name.to_str()))
        .unwrap_or("Text Skill")
        .to_string();
    let description = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .unwrap_or("")
        .to_string();
    let skill_id = directory
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("text-skill")
        .to_string();
    Ok(SkillMountEntry {
        source_kind: "skillMd".to_string(),
        manifest_status: "inferred".to_string(),
        source_path: path.to_string_lossy().to_string(),
        relative_path: relative_path(root, directory),
        skill_id,
        version: "unknown".to_string(),
        title,
        description,
        entrypoint_kind: "declarative".to_string(),
        trust_mode: enum_name(&SkillTrustMode::Declarative),
        workspace_access: enum_name(&WorkspaceAccess::None),
        requested_capabilities: Vec::new(),
        effects: Vec::new(),
        env_allowlist: Vec::new(),
        model_visible: true,
        requires_approval: false,
        activation_status: SkillActivationStatus::Dormant,
        risk_level: enum_name(&RiskLevel::Low),
    })
}

fn sorted_entries(path: &Path) -> std::io::Result<Vec<fs::DirEntry>> {
    let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    Ok(entries)
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

fn enum_name<T: Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "unknown".to_string())
}

fn scan_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mount_scan_parses_typed_manifest() {
        let root = std::env::temp_dir().join(format!(
            "deepcode-skill-mount-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create mount");
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "skillId": "local.read",
            "version": "1",
            "title": "Local read",
            "description": "Reads local evidence.",
            "entrypoint": { "kind": "declarative", "program": null, "argv": [], "scriptPath": null },
            "requestedCapabilities": [],
            "effects": [],
            "envAllowlist": [],
            "workspaceAccess": "none",
            "timeoutMs": 1000,
            "requestedModelVisible": true,
            "requestedTrustMode": "declarative"
        });
        fs::write(
            root.join("skill.manifest.json"),
            serde_json::to_vec(&manifest).expect("manifest json"),
        )
        .expect("write manifest");

        let result = scan_skill_mount(&root).expect("scan mount");
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].skill_id, "local.read");
        assert_eq!(
            result.skills[0].activation_status,
            SkillActivationStatus::Dormant
        );
        fs::remove_dir_all(root).expect("remove mount");
    }
}
