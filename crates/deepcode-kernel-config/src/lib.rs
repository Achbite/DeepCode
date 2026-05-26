use deepcode_kernel_abi::KernelResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
    Run,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConfigTrustLevel {
    Trusted,
    User,
    Workspace,
    Untrusted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSource {
    pub id: String,
    pub kind: ConfigSourceKind,
    pub path: Option<String>,
    pub trust_level: ConfigTrustLevel,
    pub schema_version: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigLayer {
    pub source: ConfigSource,
    pub values: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveConfig {
    pub schema_version: String,
    pub layers: Vec<ConfigSource>,
    pub values: Value,
    pub hash: Option<String>,
}

pub trait ConfigResolver {
    fn resolve(&self, layers: &[ConfigLayer]) -> KernelResult<EffectiveConfig>;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleMessage {
    pub key: String,
    pub args: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleCatalog {
    pub locale: String,
    pub fallback: Vec<String>,
    pub messages: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeStyleProfile {
    pub id: String,
    pub language: Option<String>,
    pub rules: Value,
    pub source_refs: Vec<String>,
}
