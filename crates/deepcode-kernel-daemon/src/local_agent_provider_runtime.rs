use crate::llm_transport::{resolve_llm_profile, ResolvedLlmProfile};
use crate::prelude::*;
use crate::GuiState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderRuntimeSnapshot {
    pub(crate) provider_runtime_ref: String,
    pub(crate) profile_id: String,
    pub(crate) context_window_tokens: u64,
    pub(crate) max_output_tokens: u32,
}

#[derive(Clone)]
pub(crate) struct ProviderRuntimeBinding {
    snapshot: ProviderRuntimeSnapshot,
    profile: ResolvedLlmProfile,
}

impl ProviderRuntimeBinding {
    pub(crate) fn snapshot(&self) -> &ProviderRuntimeSnapshot {
        &self.snapshot
    }

    pub(crate) fn profile(&self) -> ResolvedLlmProfile {
        self.profile.clone()
    }
}

#[derive(Clone, Default)]
pub(crate) struct ProviderRuntimeRegistry {
    bindings: Arc<Mutex<HashMap<ProviderRunKey, ProviderRuntimeBinding>>>,
}

impl ProviderRuntimeRegistry {
    pub(crate) fn prepare(
        gui: &GuiState,
        profile_id: Option<&str>,
    ) -> Result<ProviderRuntimeBinding, String> {
        capture_binding(gui, profile_id)
    }

    pub(crate) fn bind(
        &self,
        session_id: &str,
        run_id: &str,
        binding: ProviderRuntimeBinding,
    ) -> Result<(), String> {
        let key = ProviderRunKey::new(session_id, run_id);
        let mut bindings = self.lock()?;
        if let Some(existing) = bindings.get(&key) {
            if existing.snapshot.provider_runtime_ref != binding.snapshot.provider_runtime_ref
                || existing.snapshot.profile_id != binding.snapshot.profile_id
            {
                return Err("当前 run 已绑定其他 Provider runtime。".to_string());
            }
            return Ok(());
        }
        bindings.insert(key, binding);
        Ok(())
    }

    pub(crate) fn resolve(
        &self,
        gui: &GuiState,
        session_id: &str,
        run_id: &str,
        provider_runtime_ref: &str,
        profile_id: &str,
    ) -> Result<ProviderRuntimeBinding, String> {
        if provider_runtime_ref.trim() != provider_runtime_ref
            || provider_runtime_ref.is_empty()
            || profile_id.trim() != profile_id
            || profile_id.is_empty()
        {
            return Err("Provider runtime identity 无效。".to_string());
        }
        let key = ProviderRunKey::new(session_id, run_id);
        if let Some(binding) = self.lock()?.get(&key).cloned() {
            if binding.snapshot.provider_runtime_ref != provider_runtime_ref
                || binding.snapshot.profile_id != profile_id
            {
                return Err("当前 run 的 Provider runtime identity 不一致。".to_string());
            }
            return Ok(binding);
        }

        // A same-version daemon restart loses only the in-memory binding. Rebuild it
        // from the current profile and accept it solely when the deterministic
        // runtime identity is unchanged. A changed profile remains unavailable
        // instead of silently changing an already-started run.
        let binding = capture_binding(gui, Some(profile_id))?;
        if binding.snapshot.provider_runtime_ref != provider_runtime_ref {
            return Err("Provider runtime 已不再与 run.started 固定的配置一致。".to_string());
        }
        self.lock()?.insert(key, binding.clone());
        Ok(binding)
    }

    pub(crate) fn release(&self, session_id: &str, run_id: &str) -> Result<(), String> {
        let key = ProviderRunKey::new(session_id, run_id);
        self.lock()?.remove(&key);
        Ok(())
    }

    pub(crate) fn clear(&self) -> Result<(), String> {
        self.lock()?.clear();
        Ok(())
    }

    fn lock(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<ProviderRunKey, ProviderRuntimeBinding>>, String>
    {
        self.bindings
            .lock()
            .map_err(|_| "Provider runtime registry 锁已损坏。".to_string())
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ProviderRunKey {
    session_id: String,
    run_id: String,
}

impl ProviderRunKey {
    fn new(session_id: &str, run_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            run_id: run_id.to_string(),
        }
    }
}

fn capture_binding(
    gui: &GuiState,
    requested_profile_id: Option<&str>,
) -> Result<ProviderRuntimeBinding, String> {
    let profile_id = selected_profile_id(gui, requested_profile_id)?;
    let profile = resolve_llm_profile(gui, Some(&profile_id))?;
    let context_window_tokens = profile
        .context_window_tokens
        .filter(|value| *value > 0)
        .ok_or_else(|| "LLM Profile 缺少正数 contextWindowTokens。".to_string())?;
    let max_output_tokens = profile
        .max_output_tokens
        .filter(|value| *value > 0)
        .ok_or_else(|| "LLM Profile 缺少正数 maxOutputTokens。".to_string())?;
    if u64::from(max_output_tokens) >= context_window_tokens {
        return Err("LLM Profile 的 maxOutputTokens 必须小于 contextWindowTokens。".to_string());
    }

    let runtime_shape = json!({
        "profileId": profile_id,
        "kind": profile.kind,
        "providerFlavor": profile.provider_flavor,
        "baseUrl": profile.base_url,
        "model": profile.model,
        "contextWindowTokens": context_window_tokens,
        "maxOutputTokens": max_output_tokens,
        "temperature": profile.temperature,
        "reasoningEffort": profile.reasoning_effort,
        "thinking": profile.thinking,
        "secretRef": selected_profile(gui, &profile_id)?.get("secretRef"),
    });
    let encoded = serde_json::to_vec(&runtime_shape)
        .map_err(|error| format!("编码 Provider runtime identity 失败：{error}"))?;
    let snapshot = ProviderRuntimeSnapshot {
        provider_runtime_ref: format!(
            "provider-runtime:{}",
            deepcode_kernel_tools::hash_bytes(&encoded)
        ),
        profile_id,
        context_window_tokens,
        max_output_tokens,
    };
    Ok(ProviderRuntimeBinding { snapshot, profile })
}

fn selected_profile_id(gui: &GuiState, requested: Option<&str>) -> Result<String, String> {
    let selected = requested.or_else(|| {
        gui.llm_profiles
            .get("defaultProfileId")
            .and_then(Value::as_str)
    });
    let profile_id = selected.ok_or_else(|| "没有配置默认 LLM Profile。".to_string())?;
    if profile_id.is_empty() || profile_id.trim() != profile_id {
        return Err("LLM Profile id 无效。".to_string());
    }
    selected_profile(gui, profile_id)?;
    Ok(profile_id.to_string())
}

fn selected_profile<'a>(gui: &'a GuiState, profile_id: &str) -> Result<&'a Value, String> {
    gui.llm_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        })
        .ok_or_else(|| format!("LLM Profile 不存在：{profile_id}"))
}
