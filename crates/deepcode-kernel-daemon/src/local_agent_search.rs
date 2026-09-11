use crate::llm_transport::ResolvedLlmProfile;
use crate::DaemonSecretProvider;
use deepcode_kernel_runtime::executors::{
    CloudWebSearchConfig, CloudWebSearchProvider, KernelExecutorConfig,
};

/// Select once per run; never infer search support from the chat protocol or
/// model name. Explicit search service settings retain their existing meaning.
pub(crate) fn bind_cloud_search(
    config: &mut KernelExecutorConfig,
    secrets: &mut DaemonSecretProvider,
    profile: &ResolvedLlmProfile,
    profile_id: &str,
) {
    if !config.web_search_endpoint_template.is_empty()
        || !config.web_search_auth_secret_ref.is_empty()
    {
        return;
    }
    let Some(key) = profile.api_key.as_ref().filter(|key| !key.is_empty()) else {
        return;
    };
    let Some(cloud) = cloud_search_config(profile) else {
        return;
    };
    let secret_key = format!("run-search:{profile_id}");
    secrets.values.insert(secret_key.clone(), key.clone());
    config.web_search_auth_secret_ref = format!("local-secret:{secret_key}");
    config.cloud_web_search = Some(cloud);
}

fn cloud_search_config(profile: &ResolvedLlmProfile) -> Option<CloudWebSearchConfig> {
    let base = reqwest::Url::parse(profile.base_url.as_deref()?).ok()?;
    if base.scheme() != "https" || base.port_or_known_default() != Some(443) {
        return None;
    }
    let path = base.path().trim_end_matches('/');
    let (provider, endpoint) = match (profile.provider_flavor.as_deref(), base.host_str()?, path) {
        (Some("deepseek"), "api.deepseek.com", "" | "/v1" | "/anthropic" | "/anthropic/v1") => (
            CloudWebSearchProvider::DeepSeek,
            "https://api.deepseek.com/anthropic/v1/messages".into(),
        ),
        (Some("zhipu"), "open.bigmodel.cn", "/api/paas/v4") => (
            CloudWebSearchProvider::Glm,
            "https://open.bigmodel.cn/api/paas/v4/web_search".into(),
        ),
        (Some("moonshot"), host @ ("api.moonshot.cn" | "api.moonshot.ai"), "/v1")
            if profile.kind == "openaiCompatible" =>
        {
            (
                CloudWebSearchProvider::Kimi,
                format!("https://{host}/v1/formulas/moonshot/web-search:latest/fibers"),
            )
        }
        // Coding-plan credentials and custom gateways have distinct endpoints
        // and entitlements; do not redirect their keys to a general API.
        _ => return None,
    };
    Some(CloudWebSearchConfig { provider, endpoint })
}

#[cfg(test)]
mod tests {
    use super::*;
    use deepcode_kernel_runtime::executors::SecretProvider;
    use std::collections::HashMap;

    fn profile(flavor: &str, base: &str) -> ResolvedLlmProfile {
        ResolvedLlmProfile {
            kind: "openaiCompatible".into(),
            provider_flavor: Some(flavor.into()),
            base_url: Some(base.into()),
            model: "model-name-may-change".into(),
            context_window_tokens: Some(1000000),
            max_output_tokens: Some(32768),
            temperature: None,
            reasoning_effort: None,
            thinking: None,
            hosted_web_search: None,
            api_key: Some("test-key".into()),
        }
    }

    #[test]
    fn search_binding_uses_provider_endpoints_not_model_aliases() {
        for (flavor, base, provider) in [
            (
                "deepseek",
                "https://api.deepseek.com",
                CloudWebSearchProvider::DeepSeek,
            ),
            (
                "deepseek",
                "https://api.deepseek.com/anthropic/v1",
                CloudWebSearchProvider::DeepSeek,
            ),
            (
                "zhipu",
                "https://open.bigmodel.cn/api/paas/v4",
                CloudWebSearchProvider::Glm,
            ),
            (
                "moonshot",
                "https://api.moonshot.cn/v1",
                CloudWebSearchProvider::Kimi,
            ),
            (
                "moonshot",
                "https://api.moonshot.ai/v1",
                CloudWebSearchProvider::Kimi,
            ),
        ] {
            let mut config = KernelExecutorConfig::default();
            let mut secrets = DaemonSecretProvider {
                values: HashMap::new(),
            };
            bind_cloud_search(
                &mut config,
                &mut secrets,
                &profile(flavor, base),
                "selected",
            );
            assert_eq!(config.cloud_web_search.unwrap().provider, provider);
            assert_eq!(
                secrets
                    .resolve(&config.web_search_auth_secret_ref)
                    .as_deref(),
                Some("test-key")
            );
        }
        assert!(cloud_search_config(&profile("deepseek", "https://gateway.example/v1")).is_none());
        assert!(cloud_search_config(&profile(
            "zhipu",
            "https://open.bigmodel.cn/api/coding/paas/v4"
        ))
        .is_none());
        let mut config = KernelExecutorConfig {
            web_search_endpoint_template: "https://search.example?q={query}".into(),
            ..Default::default()
        };
        let mut secrets = DaemonSecretProvider {
            values: HashMap::new(),
        };
        bind_cloud_search(
            &mut config,
            &mut secrets,
            &profile("deepseek", "https://api.deepseek.com"),
            "selected",
        );
        assert!(config.cloud_web_search.is_none());
        assert!(secrets.values.is_empty());
    }
}
