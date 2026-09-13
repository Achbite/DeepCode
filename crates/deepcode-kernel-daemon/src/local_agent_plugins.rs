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
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<PluginCatalogError>,
}

#[derive(Debug, Clone, Serialize)]
struct PluginCatalogError {
    code: &'static str,
    message: String,
}

#[derive(Debug, Clone)]
enum PluginCatalogEntry {
    Skill(SkillLocator),
    Loaded(PluginSource),
    Unavailable(PublicPluginCatalogItem),
}

#[derive(Debug, Clone)]
struct SkillLocator {
    public: PublicPluginCatalogItem,
    id: String,
    path: PathBuf,
}

impl PluginCatalogEntry {
    fn public(&self) -> &PublicPluginCatalogItem {
        match self {
            Self::Skill(locator) => &locator.public,
            Self::Loaded(source) => &source.public,
            Self::Unavailable(public) => public,
        }
    }

    fn into_public(self) -> PublicPluginCatalogItem {
        match self {
            Self::Skill(locator) => match skill_plugin(&locator) {
                Ok(source) => source.public,
                Err(message) => PublicPluginCatalogItem {
                    error: Some(PluginCatalogError {
                        code: "skill_load_failed",
                        message,
                    }),
                    ..locator.public
                },
            },
            Self::Loaded(source) => source.public,
            Self::Unavailable(public) => public,
        }
    }
}

#[derive(Debug, Clone)]
enum PluginContribution {
    Skill,
    Mcp { plugin_uri: String },
}

#[derive(Debug, Clone)]
struct PluginSource {
    public: PublicPluginCatalogItem,
    plugin_artifact_ref: String,
    plugin_instance_ref: String,
    capability_refs: Vec<String>,
    capability_summary: String,
    tool_prompt_provider: Option<Value>,
    contribution: PluginContribution,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedPluginSelection {
    catalog_revision: String,
    plugins: Vec<PluginSource>,
    mcp_plugin_instances: BTreeMap<String, String>,
}

impl ResolvedPluginSelection {
    pub(crate) fn mcp_plugin_instances(&self) -> &BTreeMap<String, String> {
        &self.mcp_plugin_instances
    }

    pub(crate) fn extension_tool_prompt_providers(&self) -> Vec<Value> {
        self.plugins
            .iter()
            .filter_map(|plugin| plugin.tool_prompt_provider.clone())
            .collect()
    }
}

pub(crate) fn plugin_catalog_projection(settings: &Value) -> Result<Value, String> {
    let (revision, sources) = plugin_catalog(settings)?;
    Ok(json!({
        "revision": revision,
        "plugins": sources.into_values().map(PluginCatalogEntry::into_public).collect::<Vec<_>>(),
    }))
}

/// Settings inspects text Skills through the same loader used for run preparation.
/// It does not activate an MCP server or a binary plugin while opening the page.
pub(crate) fn skill_settings_projection(settings: &Value) -> Result<Value, String> {
    let mut skills = crate::local_agent_product_tools::bundled_skill_settings();
    for entry in skill_catalog_entries(settings)? {
        let source = entry.into_public();
        skills.push(json!({
            "id": source.uri,
            "displayName": source.display_name,
            "description": source.short_description,
            "source": "mounted",
        }));
    }
    Ok(json!({ "skills": skills }))
}

pub(crate) fn plugin_uri_for_activation_media_type(
    settings: &Value,
    media_type: &str,
) -> Result<Option<String>, String> {
    let (_, sources) = plugin_catalog(settings)?;
    for entry in sources.into_values() {
        let source = entry.public();
        if source.enabled
            && source
                .activation_media_types
                .iter()
                .any(|candidate| candidate == media_type)
        {
            let source = entry.into_public();
            if let Some(error) = &source.error {
                return Err(format!("{}: {}", error.code, error.message));
            }
            return Ok(Some(source.uri.clone()));
        }
    }
    Ok(None)
}

pub(crate) fn resolve_plugin_selection(
    settings: &Value,
    catalog_revision: Option<&str>,
    selections: &[PluginSelectionInput],
) -> Result<ResolvedPluginSelection, String> {
    if selections.len() > 16 {
        return Err("plugin_selection_invalid: 单次请求最多选择 16 个插件。".to_string());
    }
    if selections.is_empty() {
        return Ok(ResolvedPluginSelection {
            catalog_revision: "plugin-catalog:empty".into(),
            plugins: Vec::new(),
            mcp_plugin_instances: BTreeMap::new(),
        });
    }
    let (revision, sources) = plugin_catalog(settings)?;
    let mut selection_ids = BTreeSet::new();
    let mut uris = BTreeSet::new();
    let mut plugins = Vec::new();
    let mut mcp_plugin_instances = BTreeMap::new();
    for selection in selections {
        if !valid_identifier(&selection.selection_id)
            || selection.label.trim().is_empty()
            || selection.label.len() > 160
            || !selection_ids.insert(selection.selection_id.clone())
            || !uris.insert(selection.uri.clone())
        {
            return Err("plugin_selection_invalid: 插件选择字段无效或重复。".to_string());
        }
        let entry = sources.get(&selection.uri).cloned().ok_or_else(|| {
            format!(
                "plugin_selection_unavailable: 显式选择的插件不可用：{}",
                selection.uri
            )
        })?;
        let mut source = match entry {
            PluginCatalogEntry::Skill(locator) => {
                skill_plugin(&locator).map_err(|message| format!("skill_load_failed: {message}"))?
            }
            PluginCatalogEntry::Loaded(source) => source,
            PluginCatalogEntry::Unavailable(public) => {
                return Err(match public.error {
                    Some(error) => format!("{}: {}", error.code, error.message),
                    None => format!("plugin_selection_disabled: 插件未启用：{}", public.uri),
                });
            }
        };
        source.plugin_instance_ref = new_plugin_instance_ref()?;
        if let PluginContribution::Mcp { plugin_uri } = &source.contribution {
            mcp_plugin_instances.insert(plugin_uri.clone(), source.plugin_instance_ref.clone());
        }
        plugins.push(source);
    }
    if catalog_revision != Some(revision.as_str()) {
        return Err("plugin_selection_stale: 插件目录已经变化，请刷新后重新选择。".to_string());
    }
    plugins.sort_by(|left, right| left.public.uri.cmp(&right.public.uri));
    Ok(ResolvedPluginSelection {
        catalog_revision: revision,
        plugins,
        mcp_plugin_instances,
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

fn plugin_catalog(
    settings: &Value,
) -> Result<(String, BTreeMap<String, PluginCatalogEntry>), String> {
    let mut sources = BTreeMap::new();
    for source in skill_catalog_entries(settings)? {
        insert_plugin_source(&mut sources, source)?;
    }
    for descriptor in crate::local_agent_mcp::available_plugins(settings)
        .map_err(|error| format!("{}: {}", error.code, error.message))?
    {
        let public = PublicPluginCatalogItem {
            uri: descriptor.uri.clone(),
            display_name: descriptor.name.clone(),
            short_description: descriptor.short_description,
            icon_ref: None,
            activation_media_types: descriptor.activation_media_types,
            enabled: descriptor.enabled,
            available: descriptor.enabled && descriptor.error.is_none(),
            error: descriptor.error.map(|error| PluginCatalogError {
                code: error.code,
                message: error.message,
            }),
        };
        let entry = if public.available {
            PluginCatalogEntry::Loaded(PluginSource {
                public,
                plugin_artifact_ref: descriptor.plugin_artifact_ref,
                plugin_instance_ref: String::new(),
                capability_refs: descriptor.capability_refs,
                capability_summary: descriptor.capability_summary,
                tool_prompt_provider: descriptor.tool_prompt_provider,
                contribution: PluginContribution::Mcp {
                    plugin_uri: descriptor.uri,
                },
            })
        } else {
            PluginCatalogEntry::Unavailable(public)
        };
        insert_plugin_source(&mut sources, entry)?;
    }
    if sources.len() > MAX_PLUGINS {
        return Err(format!("Plugin 数量超过首版上限 {MAX_PLUGINS}"));
    }
    let mut activation_owners = BTreeMap::new();
    for source in sources
        .values()
        .map(PluginCatalogEntry::public)
        .filter(|source| source.enabled)
    {
        for media_type in &source.activation_media_types {
            if let Some(previous) = activation_owners.insert(media_type, &source.uri) {
                return Err(format!(
                    "Plugin activationMediaTypes 重复：{media_type} 同时属于 {previous} 和 {}",
                    source.uri
                ));
            }
        }
    }
    let identity = sources
        .values()
        .map(|entry| {
            let public = entry.public();
            let mut identity = json!({
                "uri": public.uri,
                "displayName": public.display_name,
                "shortDescription": public.short_description,
                "iconRef": public.icon_ref,
                "activationMediaTypes": public.activation_media_types,
                "enabled": public.enabled,
            });
            if let PluginCatalogEntry::Loaded(source) = entry {
                identity["pluginArtifactRef"] = json!(source.plugin_artifact_ref);
                identity["capabilityRefs"] = json!(source.capability_refs);
            }
            identity
        })
        .collect::<Vec<_>>();
    // The directory revision describes locators and configuration. Skill content
    // belongs to the selected artifact and does not invalidate other selections.
    let encoded = serde_json::to_vec(&json!({
        "entries": identity,
        "skillMounts": settings.get("skills.mounts"),
        "mcpServers": settings.get("mcp.servers"),
    }))
    .map_err(|error| format!("编码 PluginCatalog revision 失败：{error}"))?;
    let revision = format!(
        "plugin-catalog:{}",
        deepcode_kernel_tools::hash_bytes(&encoded)
    );
    Ok((revision, sources))
}

fn insert_plugin_source(
    sources: &mut BTreeMap<String, PluginCatalogEntry>,
    source: PluginCatalogEntry,
) -> Result<(), String> {
    let uri = source.public().uri.clone();
    if sources.insert(uri.clone(), source).is_some() {
        return Err(format!("Plugin URI 重复：{uri}"));
    }
    Ok(())
}

fn skill_catalog_entries(settings: &Value) -> Result<Vec<PluginCatalogEntry>, String> {
    let encoded = settings
        .get("skills.mounts")
        .and_then(Value::as_str)
        .unwrap_or("[]");
    let mounts: Vec<SkillMountSetting> = serde_json::from_str(encoded)
        .map_err(|error| format!("解析 skills.mounts 失败：{error}"))?;
    let mut files = BTreeMap::new();
    let mut entries = Vec::new();
    for mount in mounts {
        let mut public = PublicPluginCatalogItem {
            uri: format!("plugin://{}@skill-mount", plugin_slug(&mount.id)),
            display_name: format!("Skill 挂载：{}", mount.id),
            short_description: format!("Skill mount {}", mount.path),
            icon_ref: None,
            activation_media_types: Vec::new(),
            enabled: mount.enabled,
            available: false,
            error: None,
        };
        if !mount.enabled {
            entries.push(PluginCatalogEntry::Unavailable(public));
            continue;
        }
        let loaded = (|| {
            public.activation_media_types =
                normalize_activation_media_types(&mount.activation_media_types)?;
            if mount.path.trim().is_empty() {
                return Err(format!("Skill 挂载 {} 的路径不能为空。", mount.id));
            }
            let root = fs::canonicalize(mount.path.trim())
                .map_err(|error| format!("Skill 挂载 {} 不可用：{error}", mount.path))?;
            let mut mounted_files = Vec::new();
            collect_skill_files(&root, 0, &mut mounted_files)?;
            Ok(mounted_files)
        })();
        match loaded {
            Ok(mounted_files) => {
                for path in mounted_files {
                    files.entry(path).or_insert_with(|| {
                        (mount.id.clone(), public.activation_media_types.clone())
                    });
                }
            }
            Err(message) => {
                public.error = Some(PluginCatalogError {
                    code: "skill_mount_unavailable",
                    message,
                });
                entries.push(PluginCatalogEntry::Unavailable(public));
            }
        }
        if files.len() + entries.len() > MAX_PLUGINS {
            return Err(format!("Skill 数量超过首版上限 {MAX_PLUGINS}"));
        }
    }
    for (index, (path, (mount_id, activation_media_types))) in files.into_iter().enumerate() {
        let id = skill_id(&mount_id, &path, index);
        entries.push(PluginCatalogEntry::Skill(SkillLocator {
            public: PublicPluginCatalogItem {
                uri: format!("plugin://{}@skill", plugin_slug(&id)),
                display_name: skill_display_name(&path, ""),
                short_description: format!("Skill file {}", path.display()),
                icon_ref: None,
                activation_media_types,
                enabled: true,
                available: false,
                error: None,
            },
            id,
            path,
        }));
    }
    Ok(entries)
}

fn skill_plugin(locator: &SkillLocator) -> Result<PluginSource, String> {
    let path = &locator.path;
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
    let display_name = skill_display_name(path, &instructions);
    let short_description = skill_short_description(&instructions, &display_name);
    path.to_str()
        .ok_or_else(|| format!("Skill 路径不是 UTF-8：{}", path.display()))?;
    let plugin_artifact_ref = format!(
        "plugin-artifact:{}",
        deepcode_kernel_tools::hash_bytes(instructions.as_bytes())
    );
    Ok(PluginSource {
        public: PublicPluginCatalogItem {
            display_name,
            short_description,
            available: true,
            ..locator.public.clone()
        },
        plugin_artifact_ref,
        plugin_instance_ref: String::new(),
        capability_refs: vec![format!("skill:{}", locator.id)],
        capability_summary: truncate_utf8(&instructions, MAX_DYNAMIC_PLUGIN_BYTES),
        tool_prompt_provider: None,
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

fn new_plugin_instance_ref() -> Result<String, String> {
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy)
        .map_err(|error| format!("生成 PluginInstanceRef 失败：{error}"))?;
    let mut reference = String::from("plugin-instance:");
    for byte in entropy {
        use std::fmt::Write as _;
        write!(&mut reference, "{byte:02x}").expect("writing to String cannot fail");
    }
    Ok(reference)
}

const fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_selection_does_not_load_the_plugin_catalog() {
        let selected = resolve_plugin_selection(
            &json!({"skills.mounts":"not JSON", "mcp.servers":"not JSON"}),
            None,
            &[],
        )
        .unwrap();
        assert!(selected.plugins.is_empty());
        assert!(selected.mcp_plugin_instances.is_empty());
        assert!(selected.extension_tool_prompt_providers().is_empty());
    }

    #[test]
    fn unavailable_plugins_preserve_their_errors_without_blocking_selected_skills() {
        struct TestDirectory(PathBuf);
        impl Drop for TestDirectory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let root = std::env::temp_dir().join(new_plugin_instance_ref().unwrap().replace(':', "-"));
        fs::create_dir(&root).unwrap();
        let directory = TestDirectory(root);
        fs::create_dir(directory.0.join("good")).unwrap();
        fs::create_dir(directory.0.join("bad")).unwrap();
        fs::write(
            directory.0.join("good/SKILL.md"),
            "# Good Skill\nRead the selected document.",
        )
        .unwrap();
        let unreadable = directory.0.join("bad/SKILL.md");
        fs::write(&unreadable, [0xff]).unwrap();
        let original_error = fs::read_to_string(&unreadable).unwrap_err().to_string();
        let settings = json!({
            "skills.mounts": serde_json::to_string(&json!([
                {"id":"fixtures", "path":directory.0, "enabled":true},
                {"id":"missing", "path":directory.0.join("missing"), "enabled":true},
                {"id":"disabled", "path":directory.0.join("disabled"), "enabled":false}
            ])).unwrap(),
            "mcp.servers": serde_json::to_string(&json!([
                {"id":"broken", "name":"Broken MCP", "command":"", "enabled":true}
            ])).unwrap(),
        });
        let catalog = plugin_catalog_projection(&settings).unwrap();
        let plugins = catalog["plugins"].as_array().unwrap();
        let good = plugins
            .iter()
            .find(|plugin| plugin["displayName"] == "Good Skill")
            .unwrap();
        assert_eq!(good["available"], true);
        let selection = |plugin: &Value| PluginSelectionInput {
            selection_id: "selection:test".into(),
            uri: plugin["uri"].as_str().unwrap().into(),
            label: plugin["displayName"].as_str().unwrap().into(),
        };
        let selected =
            resolve_plugin_selection(&settings, catalog["revision"].as_str(), &[selection(good)])
                .unwrap();
        assert_eq!(selected.plugins.len(), 1);
        assert_eq!(selected.plugins[0].public.uri, good["uri"]);

        let bad = plugins
            .iter()
            .find(|plugin| plugin["error"]["code"] == "skill_load_failed")
            .unwrap();
        assert_eq!(bad["available"], false);
        assert!(bad["error"]["message"]
            .as_str()
            .unwrap()
            .contains(&original_error));
        let rejected =
            resolve_plugin_selection(&settings, catalog["revision"].as_str(), &[selection(bad)])
                .unwrap_err();
        assert!(rejected.contains(&original_error));

        fs::write(&unreadable, "# Repaired Skill\nAn unrelated skill changed.").unwrap();
        let changed_catalog = plugin_catalog_projection(&settings).unwrap();
        assert_eq!(changed_catalog["revision"], catalog["revision"]);
        let selected_after_unrelated_change =
            resolve_plugin_selection(&settings, catalog["revision"].as_str(), &[selection(good)])
                .unwrap();
        assert_eq!(
            selected_after_unrelated_change.plugins[0].plugin_artifact_ref,
            selected.plugins[0].plugin_artifact_ref
        );

        fs::write(
            directory.0.join("good/SKILL.md"),
            "# Good Skill\nRead the newly selected document.",
        )
        .unwrap();
        let selected_after_content_change =
            resolve_plugin_selection(&settings, catalog["revision"].as_str(), &[selection(good)])
                .unwrap();
        assert_ne!(
            selected_after_content_change.plugins[0].plugin_artifact_ref,
            selected.plugins[0].plugin_artifact_ref
        );
        assert_eq!(
            selected_after_content_change.plugins[0].capability_summary,
            "# Good Skill\nRead the newly selected document."
        );
        assert!(plugins
            .iter()
            .any(|plugin| plugin["error"]["code"] == "skill_mount_unavailable"));
        let disabled = plugins
            .iter()
            .find(|plugin| plugin["enabled"] == false)
            .unwrap();
        assert_eq!(disabled["available"], false);
        assert!(disabled.get("error").is_none());
        assert!(resolve_plugin_selection(
            &settings,
            catalog["revision"].as_str(),
            &[selection(disabled)]
        )
        .unwrap_err()
        .starts_with("plugin_selection_disabled:"));

        let broken_mcp = plugins
            .iter()
            .find(|plugin| plugin["uri"] == "plugin://broken@mcp")
            .unwrap();
        assert_eq!(broken_mcp["available"], false);
        assert_eq!(broken_mcp["error"]["code"], "mcp_server_command_missing");
        let selected_mcp =
            BTreeMap::from([("plugin://broken@mcp".into(), "plugin-instance:test".into())]);
        match crate::local_agent_mcp::McpRuntime::from_selected_settings(&settings, &selected_mcp) {
            Err(error) => assert_eq!(error.code, "mcp_server_command_missing"),
            Ok(_) => panic!("selected invalid MCP server must fail before process startup"),
        }
    }
}
