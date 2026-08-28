use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SKILLS: usize = 128;
const MAX_SKILL_BYTES: u64 = 512 * 1024;
const MAX_SCAN_DEPTH: usize = 4;
const MAX_SYSTEM_PROMPT_BYTES: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMountSetting {
    id: String,
    path: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

pub(crate) fn local_agent_plugin_config(settings: &Value) -> Result<Value, String> {
    let system_prompt = settings
        .get("agent.systemPrompt")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "agent.systemPrompt 必须是字符串。".to_string())
        })
        .transpose()?
        .unwrap_or("")
        .to_string();
    if system_prompt.len() > MAX_SYSTEM_PROMPT_BYTES {
        return Err(format!(
            "agent.systemPrompt 超过 {MAX_SYSTEM_PROMPT_BYTES} 字节上限。"
        ));
    }
    if settings.get("skills.autoLoad").and_then(Value::as_bool) != Some(true) {
        return Ok(json!({ "systemPrompt": system_prompt, "skills": [] }));
    }
    let encoded = settings
        .get("skills.mounts")
        .and_then(Value::as_str)
        .unwrap_or("[]");
    let mounts: Vec<SkillMountSetting> = serde_json::from_str(encoded)
        .map_err(|error| format!("解析 skills.mounts 失败：{error}"))?;
    let mut files = BTreeMap::new();
    for mount in mounts
        .into_iter()
        .filter(|mount| mount.enabled && !mount.path.trim().is_empty())
    {
        let root = fs::canonicalize(mount.path.trim())
            .map_err(|error| format!("Skill 挂载 {} 不可用：{error}", mount.path))?;
        let mut mounted_files = Vec::new();
        collect_skill_files(&root, 0, &mut mounted_files)?;
        for path in mounted_files {
            files.entry(path).or_insert_with(|| mount.id.clone());
        }
        if files.len() > MAX_SKILLS {
            return Err(format!("Skill 数量超过首版上限 {MAX_SKILLS}"));
        }
    }
    let mut ids = BTreeSet::new();
    let mut skills = Vec::new();
    for (index, (path, mount_id)) in files.into_iter().enumerate() {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("读取 Skill 元数据 {} 失败：{error}", path.display()))?;
        if metadata.len() > MAX_SKILL_BYTES {
            return Err(format!("Skill 文件 {} 超过大小上限", path.display()));
        }
        let instructions = fs::read_to_string(&path)
            .map_err(|error| format!("读取 Skill {} 失败：{error}", path.display()))?;
        if instructions.trim().is_empty() {
            continue;
        }
        let id = skill_id(&mount_id, &path, index);
        if !ids.insert(id.clone()) {
            return Err(format!("Skill 插件标识重复：{id}"));
        }
        skills.push(json!({
            "id": id,
            "instructions": instructions,
        }));
    }
    Ok(json!({ "systemPrompt": system_prompt, "skills": skills }))
}

fn collect_skill_files(path: &Path, depth: usize, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if output.len() > MAX_SKILLS || depth > MAX_SCAN_DEPTH {
        return Ok(());
    }
    if path.is_file() {
        if path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            output.push(path.to_path_buf());
        }
        return Ok(());
    }
    let direct = path.join("SKILL.md");
    if direct.is_file() {
        output.push(direct);
    }
    if depth == MAX_SCAN_DEPTH {
        return Ok(());
    }
    let mut entries = fs::read_dir(path)
        .map_err(|error| format!("扫描 Skill 目录 {} 失败：{error}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("扫描 Skill 目录 {} 失败：{error}", path.display()))?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("读取 Skill 条目 {} 失败：{error}", entry.path().display()))?;
        if file_type.is_dir()
            && !file_type.is_symlink()
            && !name.starts_with('.')
            && !matches!(name.as_ref(), "node_modules" | "target")
        {
            collect_skill_files(&entry.path(), depth + 1, output)?;
        }
    }
    Ok(())
}

fn skill_id(mount_id: &str, path: &Path, index: usize) -> String {
    let parent = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|name| name.to_str())
        .unwrap_or("skill");
    let readable = format!("{mount_id}-{parent}-{}", index + 1);
    readable
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '-'
            }
        })
        .collect()
}

const fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_skill_loading_is_empty() {
        let config = local_agent_plugin_config(&json!({
            "skills.autoLoad": false,
            "skills.mounts": "not parsed",
        }))
        .expect("disabled config");
        assert_eq!(config, json!({ "systemPrompt": "", "skills": [] }));
    }

    #[test]
    fn system_prompt_is_a_separate_instruction_contribution() {
        let config = local_agent_plugin_config(&json!({
            "agent.systemPrompt": "优先使用函数式组合。",
            "skills.autoLoad": false,
        }))
        .expect("system prompt config");
        assert_eq!(config["systemPrompt"], "优先使用函数式组合。");
        assert_eq!(config["skills"], json!([]));
    }
}
