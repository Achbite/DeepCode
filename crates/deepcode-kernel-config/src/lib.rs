use deepcode_kernel_abi::{ConfigSnapshot, ConfigSourceRef, KernelError, KernelResult};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigSourceKind {
    KernelDefault,
    Bundled,
    System,
    User,
    Workspace,
    Profile,
    Session,
    RunOverride,
    ExternalConnector,
}

impl ConfigSourceKind {
    pub fn as_ref_kind(&self) -> &'static str {
        match self {
            Self::KernelDefault => "kernelDefault",
            Self::Bundled => "bundled",
            Self::System => "system",
            Self::User => "user",
            Self::Workspace => "workspace",
            Self::Profile => "profile",
            Self::Session => "session",
            Self::RunOverride => "runOverride",
            Self::ExternalConnector => "externalConnector",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigScope {
    Global,
    User,
    Workspace,
    Profile,
    Session,
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigTrustLevel {
    Kernel,
    Trusted,
    User,
    Workspace,
    Untrusted,
}

impl ConfigTrustLevel {
    pub fn as_ref_trust_level(&self) -> &'static str {
        match self {
            Self::Kernel => "kernel",
            Self::Trusted => "trusted",
            Self::User => "user",
            Self::Workspace => "workspace",
            Self::Untrusted => "untrusted",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigDomain {
    App,
    Editor,
    Files,
    Terminal,
    Agent,
    Workflow,
    Policy,
    Skills,
    Ruler,
    Style,
    I18n,
    Provider,
    Session,
    Validation,
    Host,
    ExternalConnector,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    pub id: String,
    pub kind: ConfigSourceKind,
    pub scope: ConfigScope,
    pub path: Option<String>,
    pub trust_level: ConfigTrustLevel,
    pub schema_version: String,
    pub content_hash: Option<String>,
}

impl ConfigSource {
    pub fn to_ref(&self) -> ConfigSourceRef {
        ConfigSourceRef {
            id: self.id.clone(),
            kind: self.kind.as_ref_kind().to_string(),
            path: self.path.clone(),
            trust_level: Some(self.trust_level.as_ref_trust_level().to_string()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigLayer {
    pub source: ConfigSource,
    pub domain: Option<ConfigDomain>,
    pub values: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigResolverInput {
    pub schema_version: String,
    pub layers: Vec<ConfigLayer>,
    pub kernel_invariants: Option<Value>,
    pub created_at: Option<String>,
}

pub trait ConfigResolver {
    fn resolve(&self, input: ConfigResolverInput) -> KernelResult<ConfigSnapshot>;
}

#[derive(Debug, Clone, Default)]
pub struct DefaultConfigResolver;

impl ConfigResolver for DefaultConfigResolver {
    fn resolve(&self, input: ConfigResolverInput) -> KernelResult<ConfigSnapshot> {
        if input.schema_version.trim().is_empty() {
            return Err(KernelError::InvalidCommand(
                "config schemaVersion is required".to_string(),
            ));
        }

        let schema_version = input.schema_version;
        let mut effective = Value::Object(Map::new());
        let mut source_refs = Vec::with_capacity(input.layers.len());
        for layer in input.layers {
            validate_source(&layer.source)?;
            merge_value(&mut effective, &layer.values);
            source_refs.push(layer.source.to_ref());
        }

        if let Some(invariants) = input.kernel_invariants {
            merge_value(&mut effective, &invariants);
        }

        let hash = stable_hash_value(&serde_json::json!({
            "schemaVersion": schema_version.clone(),
            "sourceRefs": source_refs,
            "effective": effective,
        }));

        Ok(ConfigSnapshot {
            snapshot_id: format!("cfg-{}", &hash[..12]),
            schema_version,
            source_refs,
            effective,
            hash: Some(hash),
            created_at: input.created_at,
        })
    }
}

fn validate_source(source: &ConfigSource) -> KernelResult<()> {
    if source.id.trim().is_empty() {
        return Err(KernelError::InvalidCommand(
            "config source id is required".to_string(),
        ));
    }
    if source.schema_version.trim().is_empty() {
        return Err(KernelError::InvalidCommand(format!(
            "config source {} missing schemaVersion",
            source.id
        )));
    }
    Ok(())
}

fn merge_value(target: &mut Value, source: &Value) {
    match (target, source) {
        (Value::Object(target_map), Value::Object(source_map)) => {
            for (key, source_value) in source_map {
                if source_value.is_null() {
                    target_map.remove(key);
                    continue;
                }
                match target_map.get_mut(key) {
                    Some(target_value) => merge_value(target_value, source_value),
                    None => {
                        target_map.insert(key.clone(), source_value.clone());
                    }
                }
            }
        }
        (target_value, source_value) => {
            *target_value = source_value.clone();
        }
    }
}

fn stable_hash_value(value: &Value) -> String {
    stable_hash_text(&serde_json::to_string(value).unwrap_or_default())
}

fn stable_hash_text(text: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalePack {
    pub locale: String,
    pub name: String,
    pub fallback: Vec<String>,
    pub namespaces: BTreeMap<String, BTreeMap<String, String>>,
    pub schema_version: String,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleMessage {
    pub locale: String,
    pub key: String,
    pub args: Value,
    pub text: String,
    pub fallback_used: Option<String>,
    pub missing: bool,
}

pub trait LocaleResolver {
    fn render(&self, locale: &str, key: &str, args: Value) -> KernelResult<LocaleMessage>;
}

#[derive(Debug, Clone, Default)]
pub struct InMemoryLocaleResolver {
    default_locale: String,
    packs: BTreeMap<String, LocalePack>,
}

impl InMemoryLocaleResolver {
    pub fn new(default_locale: impl Into<String>, packs: Vec<LocalePack>) -> Self {
        Self {
            default_locale: default_locale.into(),
            packs: packs
                .into_iter()
                .map(|pack| (pack.locale.clone(), pack))
                .collect(),
        }
    }

    fn fallback_chain(&self, locale: &str) -> Vec<String> {
        let mut chain = Vec::new();
        push_unique(&mut chain, locale.to_string());
        if let Some(pack) = self.packs.get(locale) {
            for fallback in &pack.fallback {
                push_unique(&mut chain, fallback.clone());
            }
        }
        push_unique(&mut chain, self.default_locale.clone());
        chain
    }
}

impl LocaleResolver for InMemoryLocaleResolver {
    fn render(&self, locale: &str, key: &str, args: Value) -> KernelResult<LocaleMessage> {
        for candidate in self.fallback_chain(locale) {
            if let Some(pack) = self.packs.get(&candidate) {
                if let Some(template) = lookup_message(pack, key) {
                    return Ok(LocaleMessage {
                        locale: locale.to_string(),
                        key: key.to_string(),
                        text: format_template(template, &args),
                        args,
                        fallback_used: if candidate == locale {
                            None
                        } else {
                            Some(candidate)
                        },
                        missing: false,
                    });
                }
            }
        }

        Ok(LocaleMessage {
            locale: locale.to_string(),
            key: key.to_string(),
            text: key.to_string(),
            args,
            fallback_used: None,
            missing: true,
        })
    }
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.trim().is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn lookup_message<'a>(pack: &'a LocalePack, key: &str) -> Option<&'a str> {
    for namespace in pack.namespaces.values() {
        if let Some(value) = namespace.get(key) {
            return Some(value);
        }
    }
    None
}

fn format_template(template: &str, args: &Value) -> String {
    let Some(args) = args.as_object() else {
        return template.to_string();
    };
    let mut output = template.to_string();
    for (key, value) in args {
        let replacement = match value {
            Value::String(value) => value.clone(),
            Value::Number(value) => value.to_string(),
            Value::Bool(value) => value.to_string(),
            Value::Null => String::new(),
            other => other.to_string(),
        };
        output = output.replace(&format!("{{{key}}}"), &replacement);
    }
    output
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeStyleSourceRef {
    pub id: String,
    pub kind: String,
    pub path: Option<String>,
    pub content_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeStyleProfile {
    pub id: String,
    pub language: Option<String>,
    pub rules: Value,
    pub source_refs: Vec<CodeStyleSourceRef>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(id: &str, kind: ConfigSourceKind, trust_level: ConfigTrustLevel) -> ConfigSource {
        ConfigSource {
            id: id.to_string(),
            kind,
            scope: ConfigScope::User,
            path: None,
            trust_level,
            schema_version: "1".to_string(),
            content_hash: None,
        }
    }

    #[test]
    fn config_resolver_merges_layers_and_applies_invariants_last() {
        let resolver = DefaultConfigResolver;
        let snapshot = resolver
            .resolve(ConfigResolverInput {
                schema_version: "1".to_string(),
                layers: vec![
                    ConfigLayer {
                        source: source(
                            "kernel-default",
                            ConfigSourceKind::KernelDefault,
                            ConfigTrustLevel::Kernel,
                        ),
                        domain: None,
                        values: serde_json::json!({
                            "agent": { "defaultMode": "plan" },
                            "policy": { "allowShellExec": false },
                            "session": { "templateLocale": "en-US" }
                        }),
                    },
                    ConfigLayer {
                        source: source(
                            "workspace",
                            ConfigSourceKind::Workspace,
                            ConfigTrustLevel::Workspace,
                        ),
                        domain: None,
                        values: serde_json::json!({
                            "agent": { "defaultMode": "askBeforeWrite" },
                            "policy": { "allowShellExec": true },
                            "session": { "templateLocale": null }
                        }),
                    },
                ],
                kernel_invariants: Some(serde_json::json!({
                    "policy": { "allowShellExec": false }
                })),
                created_at: Some("2026-05-26T00:00:00Z".to_string()),
            })
            .expect("resolve config");

        assert_eq!(snapshot.effective["agent"]["defaultMode"], "askBeforeWrite");
        assert_eq!(snapshot.effective["policy"]["allowShellExec"], false);
        assert!(snapshot.effective["session"]
            .get("templateLocale")
            .is_none());
        assert_eq!(snapshot.source_refs.len(), 2);
        assert_eq!(
            snapshot.source_refs[1].trust_level.as_deref(),
            Some("workspace")
        );
        assert!(snapshot.hash.is_some());
        assert_eq!(snapshot.created_at.as_deref(), Some("2026-05-26T00:00:00Z"));
    }

    #[test]
    fn config_resolver_rejects_invalid_source_metadata() {
        let resolver = DefaultConfigResolver;
        let error = resolver
            .resolve(ConfigResolverInput {
                schema_version: "1".to_string(),
                layers: vec![ConfigLayer {
                    source: ConfigSource {
                        id: String::new(),
                        kind: ConfigSourceKind::User,
                        scope: ConfigScope::User,
                        path: None,
                        trust_level: ConfigTrustLevel::User,
                        schema_version: "1".to_string(),
                        content_hash: None,
                    },
                    domain: None,
                    values: serde_json::json!({}),
                }],
                kernel_invariants: None,
                created_at: None,
            })
            .expect_err("empty source id should fail");

        assert!(matches!(error, KernelError::InvalidCommand(_)));
    }

    #[test]
    fn locale_resolver_falls_back_and_renders_args() {
        let zh = LocalePack {
            locale: "zh-CN".to_string(),
            name: "简体中文".to_string(),
            fallback: vec!["en-US".to_string()],
            namespaces: BTreeMap::from([(
                "agent".to_string(),
                BTreeMap::from([(
                    "agent.stage.plan".to_string(),
                    "规划 {count} 项".to_string(),
                )]),
            )]),
            schema_version: "1".to_string(),
            hash: None,
        };
        let en = LocalePack {
            locale: "en-US".to_string(),
            name: "English".to_string(),
            fallback: vec![],
            namespaces: BTreeMap::from([(
                "agent".to_string(),
                BTreeMap::from([(
                    "agent.stage.review".to_string(),
                    "Review {count} item(s)".to_string(),
                )]),
            )]),
            schema_version: "1".to_string(),
            hash: None,
        };
        let resolver = InMemoryLocaleResolver::new("en-US", vec![zh, en]);

        let direct = resolver
            .render(
                "zh-CN",
                "agent.stage.plan",
                serde_json::json!({ "count": 2 }),
            )
            .expect("render direct locale");
        assert_eq!(direct.text, "规划 2 项");
        assert_eq!(direct.fallback_used, None);

        let fallback = resolver
            .render(
                "zh-CN",
                "agent.stage.review",
                serde_json::json!({ "count": 1 }),
            )
            .expect("render fallback locale");
        assert_eq!(fallback.text, "Review 1 item(s)");
        assert_eq!(fallback.fallback_used.as_deref(), Some("en-US"));

        let missing = resolver
            .render("zh-CN", "capability.unknown.sample", serde_json::json!({}))
            .expect("render missing key");
        assert_eq!(missing.text, "capability.unknown.sample");
        assert!(missing.missing);
    }
}
