use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBundleManifest {
    pub schema_version: u32,
    pub plugin_id: String,
    pub namespace: String,
    pub name: String,
    pub version: String,
    pub revision_hash: Option<String>,
    pub provenance: Option<String>,
    pub contents: PluginBundleContents,
    pub policy: PluginBundlePolicy,
    pub risk: PluginRiskSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBundleContents {
    #[serde(default)]
    pub skills: Vec<String>,
    #[serde(default)]
    pub mcp_connectors: Vec<String>,
    #[serde(default)]
    pub prompts: Vec<String>,
    #[serde(default)]
    pub workflows: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBundlePolicy {
    pub auto_enable_skills: bool,
    pub auto_enable_mcp: bool,
    pub postinstall_allowed: bool,
}

impl Default for PluginBundlePolicy {
    fn default() -> Self {
        Self {
            auto_enable_skills: false,
            auto_enable_mcp: false,
            postinstall_allowed: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRiskSummary {
    pub summary: Option<String>,
    #[serde(default)]
    pub requires_user_review: bool,
}

impl PluginBundleManifest {
    pub fn grants_capability(&self) -> bool {
        false
    }

    pub fn enables_runtime_capability(&self) -> bool {
        self.policy.auto_enable_skills
            || self.policy.auto_enable_mcp
            || self.policy.postinstall_allowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_bundle_is_distribution_container_not_authorization() {
        let manifest = PluginBundleManifest {
            schema_version: 1,
            plugin_id: "plugin.fixture".to_string(),
            namespace: "fixture".to_string(),
            name: "Fixture Plugin".to_string(),
            version: "1".to_string(),
            revision_hash: Some("sha256:fixture".to_string()),
            provenance: Some("local".to_string()),
            contents: PluginBundleContents {
                skills: vec!["fixture.text.echo".to_string()],
                mcp_connectors: vec!["fixture.mcp.text-tools".to_string()],
                prompts: Vec::new(),
                workflows: Vec::new(),
            },
            policy: PluginBundlePolicy::default(),
            risk: PluginRiskSummary {
                summary: Some("fixture only".to_string()),
                requires_user_review: true,
            },
        };

        assert!(!manifest.grants_capability());
        assert!(!manifest.enables_runtime_capability());
    }
}
