use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const MAX_PLUGINS: usize = 128;
const MAX_SKILL_BYTES: u64 = 512 * 1024;
const MAX_SCAN_DEPTH: usize = 4;
const MAX_DYNAMIC_PLUGIN_BYTES: usize = 4 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillMountSetting {
    id: String,
    path: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
    #[serde(default)]
    activation_media_types: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PluginSelectionInput {
    pub(crate) selection_id: String,
    pub(crate) uri: String,
    pub(crate) label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPluginCatalogItem {
    uri: String,
    display_name: String,
    short_description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    icon_ref: Option<String>,
    activation_media_types: Vec<String>,
    enabled: bool,
    available: bool,
}

#[derive(Debug, Clone)]
enum PluginContribution {
    Skill,
    Mcp { server_id: String },
}

#[derive(Debug, Clone)]
struct PluginSource {
    public: PublicPluginCatalogItem,
    plugin_artifact_ref: String,
    plugin_instance_ref: String,
    capability_refs: Vec<String>,
    capability_summary: String,
    contribution: PluginContribution,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedPluginSelection {
    catalog_revision: String,
    plugins: Vec<PluginSource>,
    mcp_server_ids: BTreeSet<String>,
}

impl ResolvedPluginSelection {
    pub(crate) fn mcp_server_ids(&self) -> &BTreeSet<String> {
        &self.mcp_server_ids
    }
}

pub(crate) fn plugin_catalog_projection(settings: &Value) -> Result<Value, String> {
    let (revision, sources) = plugin_catalog(settings)?;
    Ok(json!({
        "revision": revision,
        "plugins": sources.values().map(|source| &source.public).collect::<Vec<_>>(),
    }))
}

pub(crate) fn plugin_uri_for_activation_media_type(
    settings: &Value,
    media_type: &str,
) -> Result<Option<String>, String> {
    let (_, sources) = plugin_catalog(settings)?;
    Ok(sources.values().find_map(|source| {
        source
            .public
            .activation_media_types
            .iter()
            .any(|candidate| candidate == media_type)
            .then(|| source.public.uri.clone())
    }))
}

pub(crate) fn resolve_plugin_selection(
    settings: &Value,
    catalog_revision: Option<&str>,
    selections: &[PluginSelectionInput],
) -> Result<ResolvedPluginSelection, String> {
    if selections.len() > 16 {
        return Err("plugin_selection_invalid: 单次请求最多选择 16 个插件。".to_string());
    }
    let (revision, sources) = plugin_catalog(settings)?;
    if !selections.is_empty() && catalog_revision != Some(revision.as_str()) {
        return Err("plugin_selection_stale: 插件目录已经变化，请刷新后重新选择。".to_string());
    }
    let mut selection_ids = BTreeSet::new();
    let mut uris = BTreeSet::new();
    let mut plugins = Vec::new();
    let mut mcp_server_ids = BTreeSet::new();
    for selection in selections {
        if !valid_identifier(&selection.selection_id)
            || selection.label.trim().is_empty()
            || selection.label.len() > 160
            || !selection_ids.insert(selection.selection_id.clone())
            || !uris.insert(selection.uri.clone())
        {
            return Err("plugin_selection_invalid: 插件选择字段无效或重复。".to_string());
        }
        let source = sources.get(&selection.uri).ok_or_else(|| {
            format!(
                "plugin_selection_unavailable: 显式选择的插件不可用：{}",
                selection.uri
            )
        })?;
        if let PluginContribution::Mcp { server_id } = &source.contribution {
            mcp_server_ids.insert(server_id.clone());
        }
        plugins.push(source.clone());
    }
    plugins.sort_by(|left, right| left.public.uri.cmp(&right.public.uri));
    Ok(ResolvedPluginSelection {
        catalog_revision: revision,
        plugins,
        mcp_server_ids,
    })
}

pub(crate) fn local_agent_plugin_config(
    settings: &Value,
    selection: &ResolvedPluginSelection,
) -> Result<Value, String> {
    let workspace_mutation = settings
        .get("agent.permissions.workspaceMutation")
        .and_then(Value::as_str)
        .unwrap_or("plan");
    if !matches!(workspace_mutation, "plan" | "allow") {
        return Err("agent.permissions.workspaceMutation 必须是 plan 或 allow。".to_string());
    }
    let engineering_decisions = settings
        .get("agent.permissions.engineeringDecisions")
        .and_then(Value::as_str)
        .unwrap_or("ask");
    if !matches!(engineering_decisions, "ask" | "delegate") {
        return Err("agent.permissions.engineeringDecisions 必须是 ask 或 delegate。".to_string());
    }
    Ok(json!({
        "workspaceMutation": workspace_mutation,
        "engineeringDecisions": engineering_decisions,
        "selectedPlugins": selection.plugins.iter().map(|plugin| json!({
            "uri": plugin.public.uri,
            "displayName": plugin.public.display_name,
            "capabilitySummary": plugin.capability_summary,
        })).collect::<Vec<_>>(),
    }))
}

pub(crate) fn selected_plugin_snapshot(
    selection: &ResolvedPluginSelection,
    extension_generation_ref: &str,
) -> Value {
    json!({
        "catalogRevision": selection.catalog_revision,
        "plugins": selection.plugins.iter().map(|plugin| json!({
            "uri": plugin.public.uri,
            "pluginArtifactRef": plugin.plugin_artifact_ref,
            "pluginInstanceRef": plugin.plugin_instance_ref,
            "extensionGenerationRef": extension_generation_ref,
            "capabilityRefs": plugin.capability_refs,
        })).collect::<Vec<_>>(),
    })
}

pub(crate) fn extension_generation_ref(
    plugin_config: &Value,
    mcp: &crate::local_agent_mcp::McpRuntime,
) -> Result<String, String> {
    let shape = json!({
        "selectedPlugins": plugin_config.get("selectedPlugins"),
        "mcp": mcp.extension_identity(),
    });
    let encoded = serde_json::to_vec(&shape)
        .map_err(|error| format!("编码 ExtensionGenerationRef 输入失败：{error}"))?;
    Ok(format!(
        "extension-generation:{}",
        deepcode_kernel_tools::hash_bytes(&encoded)
    ))
}

pub(crate) fn kernel_runtime_generation_key(
    extension_generation_ref: &str,
    settings: &Value,
) -> Result<String, String> {
    let shape = json!({
        "extensionGenerationRef": extension_generation_ref,
        "permissions": {
            "workspaceMutation": settings.get("agent.permissions.workspaceMutation"),
            "networkRead": settings.get("agent.permissions.networkRead"),
            "external": settings.get("agent.permissions.external"),
        },
        "webSearch": {
            "endpointTemplate": settings.get("agent.web.search.endpointTemplate"),
            "authHeaderName": settings.get("agent.web.search.authHeaderName"),
            "authSecretRef": settings.get("agent.web.search.authSecretRef"),
        },
    });
    let encoded = serde_json::to_vec(&shape)
        .map_err(|error| format!("编码 Kernel runtime generation key 失败：{error}"))?;
    Ok(format!(
        "kernel-runtime:{}",
        deepcode_kernel_tools::hash_bytes(&encoded)
    ))
}

fn plugin_catalog(settings: &Value) -> Result<(String, BTreeMap<String, PluginSource>), String> {
    let mut sources = BTreeMap::new();
    for source in skill_plugins(settings)? {
        insert_plugin_source(&mut sources, source)?;
    }
    for descriptor in crate::local_agent_mcp::configured_plugins(settings)
        .map_err(|error| format!("{}: {}", error.code, error.message))?
    {
        insert_plugin_source(
            &mut sources,
            PluginSource {
                public: PublicPluginCatalogItem {
                    uri: descriptor.uri,
                    display_name: descriptor.name.clone(),
                    short_description: format!("MCP service {}", descriptor.name),
                    icon_ref: None,
                    activation_media_types: Vec::new(),
                    enabled: true,
                    available: true,
                },
                plugin_artifact_ref: descriptor.plugin_artifact_ref,
                plugin_instance_ref: descriptor.plugin_instance_ref,
                capability_refs: vec![descriptor.capability_ref],
                capability_summary: format!(
                    "The selected MCP service exposes its callable capabilities in the current tool catalog."
                ),
                contribution: PluginContribution::Mcp {
                    server_id: descriptor.id,
                },
            },
        )?;
    }
    if sources.len() > MAX_PLUGINS {
        return Err(format!("Plugin 数量超过首版上限 {MAX_PLUGINS}"));
    }
    let mut activation_owners = BTreeMap::new();
    for source in sources.values() {
        for media_type in &source.public.activation_media_types {
            if let Some(previous) = activation_owners.insert(media_type, &source.public.uri) {
                return Err(format!(
                    "Plugin activationMediaTypes 重复：{media_type} 同时属于 {previous} 和 {}",
                    source.public.uri
                ));
            }
        }
    }
    let identity = sources
        .values()
        .map(|source| {
            json!({
                "public": source.public,
                "pluginArtifactRef": source.plugin_artifact_ref,
                "pluginInstanceRef": source.plugin_instance_ref,
                "capabilityRefs": source.capability_refs,
            })
        })
        .collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&identity)
        .map_err(|error| format!("编码 PluginCatalog revision 失败：{error}"))?;
    let revision = format!(
        "plugin-catalog:{}",
        deepcode_kernel_tools::hash_bytes(&encoded)
    );
    Ok((revision, sources))
}

fn insert_plugin_source(
    sources: &mut BTreeMap<String, PluginSource>,
    source: PluginSource,
) -> Result<(), String> {
    let uri = source.public.uri.clone();
    if sources.insert(uri.clone(), source).is_some() {
        return Err(format!("Plugin URI 重复：{uri}"));
    }
    Ok(())
}

fn skill_plugins(settings: &Value) -> Result<Vec<PluginSource>, String> {
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
        let activation_media_types =
            normalize_activation_media_types(&mount.activation_media_types)?;
        let root = fs::canonicalize(mount.path.trim())
            .map_err(|error| format!("Skill 挂载 {} 不可用：{error}", mount.path))?;
        let mut mounted_files = Vec::new();
        collect_skill_files(&root, 0, &mut mounted_files)?;
        for path in mounted_files {
            files
                .entry(path)
                .or_insert_with(|| (mount.id.clone(), activation_media_types.clone()));
        }
        if files.len() > MAX_PLUGINS {
            return Err(format!("Skill 数量超过首版上限 {MAX_PLUGINS}"));
        }
    }
    files
        .into_iter()
        .enumerate()
        .map(|(index, (path, (mount_id, activation_media_types)))| {
            skill_plugin(&mount_id, &path, index, activation_media_types)
        })
        .collect()
}

fn skill_plugin(
    mount_id: &str,
    path: &Path,
    index: usize,
    activation_media_types: Vec<String>,
) -> Result<PluginSource, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("读取 Skill 元数据 {} 失败：{error}", path.display()))?;
    if metadata.len() > MAX_SKILL_BYTES {
        return Err(format!("Skill 文件 {} 超过大小上限", path.display()));
    }
    let instructions = fs::read_to_string(path)
        .map_err(|error| format!("读取 Skill {} 失败：{error}", path.display()))?;
    if instructions.trim().is_empty() {
        return Err(format!("Skill 文件 {} 不能为空", path.display()));
    }
    let id = skill_id(mount_id, path, index);
    let uri = format!("plugin://{}@skill", plugin_slug(&id));
    let display_name = skill_display_name(path, &instructions);
    let short_description = skill_short_description(&instructions, &display_name);
    let canonical = path
        .to_str()
        .ok_or_else(|| format!("Skill 路径不是 UTF-8：{}", path.display()))?;
    let plugin_artifact_ref = format!(
        "plugin-artifact:{}",
        deepcode_kernel_tools::hash_bytes(instructions.as_bytes())
    );
    let plugin_instance_ref = format!(
        "plugin-instance:{}",
        deepcode_kernel_tools::hash_bytes(canonical.as_bytes())
    );
    Ok(PluginSource {
        public: PublicPluginCatalogItem {
            uri,
            display_name,
            short_description,
            icon_ref: None,
            activation_media_types,
            enabled: true,
            available: true,
        },
        plugin_artifact_ref,
        plugin_instance_ref,
        capability_refs: vec![format!("skill:{id}")],
        capability_summary: truncate_utf8(&instructions, MAX_DYNAMIC_PLUGIN_BYTES),
        contribution: PluginContribution::Skill,
    })
}

fn normalize_activation_media_types(values: &[String]) -> Result<Vec<String>, String> {
    if values.len() > 16 {
        return Err("Skill activationMediaTypes 最多包含 16 项。".to_string());
    }
    let mut normalized = BTreeSet::new();
    for value in values {
        let candidate = value.trim().to_ascii_lowercase();
        let valid = candidate.len() <= 128
            && candidate.split_once('/').is_some_and(|(kind, subtype)| {
                !kind.is_empty()
                    && !subtype.is_empty()
                    && kind.chars().chain(subtype.chars()).all(|character| {
                        character.is_ascii_alphanumeric()
                            || matches!(
                                character,
                                '!' | '#' | '$' | '&' | '^' | '_' | '.' | '+' | '-'
                            )
                    })
            });
        if !valid {
            return Err(format!("Skill activationMediaTypes 无效：{value}"));
        }
        normalized.insert(candidate);
    }
    Ok(normalized.into_iter().collect())
}

fn collect_skill_files(path: &Path, depth: usize, output: &mut Vec<PathBuf>) -> Result<(), String> {
    if output.len() > MAX_PLUGINS || depth > MAX_SCAN_DEPTH {
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
    format!("{mount_id}-{parent}-{}", index + 1)
}

fn skill_display_name(path: &Path, instructions: &str) -> String {
    instructions
        .lines()
        .find_map(|line| line.trim().strip_prefix("# "))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| truncate_utf8(line, 160))
        .unwrap_or_else(|| {
            path.parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str())
                .unwrap_or("Skill")
                .to_string()
        })
}

fn skill_short_description(instructions: &str, fallback: &str) -> String {
    instructions
        .lines()
        .map(str::trim)
        .find(|line| {
            !line.is_empty()
                && !line.starts_with('#')
                && *line != "---"
                && !line.starts_with("name:")
                && !line.starts_with("description:")
        })
        .map(|line| truncate_utf8(line, 240))
        .unwrap_or_else(|| format!("Skill plugin {fallback}"))
}

fn plugin_slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>();
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "plugin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

const fn enabled_by_default() -> bool {
    true
}
