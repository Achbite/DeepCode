
use crate::prelude::*;
use crate::*;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillMountScanRequest {
    pub(crate) path: String,
}

pub(crate) async fn skill_mount_scan(Json(body): Json<SkillMountScanRequest>) -> Json<ApiResponse> {
    let root = PathBuf::from(body.path.trim());
    if body.path.trim().is_empty() {
        return ApiResponse::error("invalid_request", "path is required");
    }
    if !root.is_dir() {
        return ApiResponse::error(
            "skill_mount_not_directory",
            format!("{} is not a directory", root.display()),
        );
    }

    let mut skills = Vec::new();
    let mut warnings = Vec::new();
    scan_skill_mount_dir(&root, &root, 0, &mut skills, &mut warnings);

    ApiResponse::ok(json!({
        "mountPath": root.to_string_lossy(),
        "scannedAt": now_text(),
        "skills": skills,
        "warnings": warnings
    }))
}

pub(crate) fn scan_skill_mount_dir(
    mount_root: &FsPath,
    dir: &FsPath,
    depth: usize,
    skills: &mut Vec<Value>,
    warnings: &mut Vec<String>,
) {
    const MAX_DEPTH: usize = 3;
    const MAX_SKILLS: usize = 128;

    if skills.len() >= MAX_SKILLS {
        return;
    }

    let manifest_path = ["skill.manifest.json", "manifest.json"]
        .iter()
        .map(|name| dir.join(name))
        .find(|path| path.is_file());
    if let Some(path) = manifest_path {
        match scan_skill_manifest(mount_root, dir, &path) {
            Ok(skill) => skills.push(skill),
            Err(error) => warnings.push(error),
        }
    } else {
        let skill_md = dir.join("SKILL.md");
        if skill_md.is_file() {
            match scan_skill_markdown(mount_root, dir, &skill_md) {
                Ok(skill) => skills.push(skill),
                Err(error) => warnings.push(error),
            }
        }
    }

    if depth >= MAX_DEPTH || skills.len() >= MAX_SKILLS {
        return;
    }

    let Ok(entries) = sorted_dir_entries(dir) else {
        warnings.push(format!("failed to read {}", dir.display()));
        return;
    };
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() || name == "node_modules" || name == "target" || name.starts_with('.') {
            continue;
        }
        scan_skill_mount_dir(mount_root, &path, depth + 1, skills, warnings);
        if skills.len() >= MAX_SKILLS {
            warnings.push("skill scan limit reached; remaining folders were skipped".to_string());
            break;
        }
    }
}

pub(crate) fn scan_skill_manifest(
    mount_root: &FsPath,
    dir: &FsPath,
    path: &FsPath,
) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("read {} failed: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("parse {} failed: {error}", path.display()))?;
    let trust_mode = value
        .get("requestedTrustMode")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let workspace_access = value
        .get("workspaceAccess")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let requested_capabilities = string_vec_field(&value, "requestedCapabilities");
    let effects = string_vec_field(&value, "effects");
    let env_allowlist = string_vec_field(&value, "envAllowlist");
    let requires_approval = !requested_capabilities.is_empty()
        || !env_allowlist.is_empty()
        || workspace_access != "none"
        || trust_mode != "declarative";
    let v1_runtime_enabled = trust_mode != "directHostScript";
    let risk_level = if trust_mode == "directHostScript" {
        "high"
    } else if trust_mode == "brokeredScript" || requires_approval {
        "medium"
    } else {
        "low"
    };
    let entrypoint_kind = value
        .get("entrypoint")
        .and_then(|entrypoint| entrypoint.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");

    Ok(json!({
        "sourceKind": "manifest",
        "manifestStatus": "parsed",
        "sourcePath": path.to_string_lossy(),
        "relativePath": relative_path_text(mount_root, dir),
        "skillId": value.get("skillId").and_then(Value::as_str).unwrap_or("unknown"),
        "version": value.get("version").and_then(Value::as_str).unwrap_or("unknown"),
        "title": value.get("title").and_then(Value::as_str).unwrap_or("Untitled Skill"),
        "description": value.get("description").and_then(Value::as_str).unwrap_or(""),
        "entrypointKind": entrypoint_kind,
        "trustMode": trust_mode,
        "workspaceAccess": workspace_access,
        "requestedCapabilities": requested_capabilities,
        "effects": effects,
        "envAllowlist": env_allowlist,
        "modelVisible": value.get("modelVisible").and_then(Value::as_bool).unwrap_or(false),
        "requiresApproval": requires_approval,
        "v1RuntimeEnabled": v1_runtime_enabled,
        "riskLevel": risk_level
    }))
}

pub(crate) fn scan_skill_markdown(
    mount_root: &FsPath,
    dir: &FsPath,
    path: &FsPath,
) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("read {} failed: {error}", path.display()))?;
    let title = raw
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::trim))
        .filter(|line| !line.is_empty())
        .unwrap_or_else(|| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Text Skill")
        });
    let description = raw
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("---"))
        .unwrap_or("");
    let fallback_id = dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("text-skill");

    Ok(json!({
        "sourceKind": "skillMd",
        "manifestStatus": "inferred",
        "sourcePath": path.to_string_lossy(),
        "relativePath": relative_path_text(mount_root, dir),
        "skillId": fallback_id,
        "version": "unknown",
        "title": title,
        "description": description,
        "entrypointKind": "text",
        "trustMode": "declarative",
        "workspaceAccess": "none",
        "requestedCapabilities": [],
        "effects": [],
        "envAllowlist": [],
        "modelVisible": true,
        "requiresApproval": false,
        "v1RuntimeEnabled": true,
        "riskLevel": "low"
    }))
}

pub(crate) fn string_vec_field(value: &Value, field: &str) -> Vec<String> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

pub(crate) fn relative_path_text(root: &FsPath, path: &FsPath) -> String {
    path.strip_prefix(root)
        .ok()
        .filter(|relative| !relative.as_os_str().is_empty())
        .map(|relative| relative.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}
