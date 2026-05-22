use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmProfilesFile {
    profiles: Vec<Value>,
    default_profile_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmProfilesResult {
    pub profiles: Vec<Value>,
    pub default_profile_id: Option<String>,
    pub store_path: Option<String>,
}

fn user_id() -> String {
    std::env::var("DEEPCODE_USER_ID")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "local".into())
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn config_root() -> PathBuf {
    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").ok().unwrap_or_else(|| {
            let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
            format!("{}/AppData/Roaming", home)
        });
        PathBuf::from(appdata).join("DeepCode").join("config")
    } else {
        let base = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                PathBuf::from(home).join(".config")
            });
        base.join("deepcode").join("config")
    }
}

fn user_config_dir() -> PathBuf {
    config_root().join("user").join(user_id())
}

fn profiles_path() -> PathBuf {
    user_config_dir().join("settings").join("llm-profiles.json")
}

fn secrets_path() -> PathBuf {
    user_config_dir().join("secrets").join("llm-secrets.json")
}

fn default_profiles_file() -> LlmProfilesFile {
    LlmProfilesFile {
        profiles: vec![
            json!({
                "id": "deepseek-v4-flash-openai",
                "name": "DeepSeek V4 Flash",
                "kind": "openaiCompatible",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-v4-flash",
                "maxTokens": 4096,
                "temperature": 0.2,
                "reasoningEffort": "medium",
                "thinking": "enabled",
                "enabled": true
            }),
            json!({
                "id": "deepseek-v4-pro-openai",
                "name": "DeepSeek V4 Pro",
                "kind": "openaiCompatible",
                "baseUrl": "https://api.deepseek.com",
                "model": "deepseek-v4-pro",
                "maxTokens": 4096,
                "temperature": 0.2,
                "reasoningEffort": "high",
                "thinking": "enabled",
                "enabled": true
            }),
        ],
        default_profile_id: Some("deepseek-v4-flash-openai".into()),
    }
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn sanitize_profile(raw: &Value) -> Option<Value> {
    let id = string_field(raw, "id")?;
    let name = string_field(raw, "name")?;
    let model = string_field(raw, "model")?;
    let kind = string_field(raw, "kind").unwrap_or_else(|| "openaiCompatible".into());
    let mut profile = Map::new();
    profile.insert("id".into(), Value::String(id));
    profile.insert("name".into(), Value::String(name));
    profile.insert("kind".into(), Value::String(kind));
    profile.insert("model".into(), Value::String(model));
    profile.insert(
        "enabled".into(),
        Value::Bool(raw.get("enabled").and_then(Value::as_bool).unwrap_or(true)),
    );
    for key in ["baseUrl", "reasoningEffort", "thinking", "secretRef"] {
        if let Some(value) = string_field(raw, key) {
            profile.insert(key.into(), Value::String(value));
        }
    }
    for key in ["maxTokens", "temperature"] {
        if let Some(value) = raw.get(key).and_then(Value::as_f64) {
            if let Some(number) = serde_json::Number::from_f64(value) {
                profile.insert(key.into(), Value::Number(number));
            }
        }
    }
    Some(Value::Object(profile))
}

fn read_profiles_file() -> LlmProfilesFile {
    let path = profiles_path();
    let parsed = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str::<LlmProfilesFile>(&raw).ok());
    let Some(file) = parsed else {
        return default_profiles_file();
    };
    let profiles: Vec<Value> = file.profiles.iter().filter_map(sanitize_profile).collect();
    if profiles.is_empty() {
        return default_profiles_file();
    }
    let default_profile_id = file
        .default_profile_id
        .filter(|id| profiles.iter().any(|profile| string_field(profile, "id").as_deref() == Some(id.as_str())))
        .or_else(|| profiles.first().and_then(|profile| string_field(profile, "id")));
    LlmProfilesFile {
        profiles,
        default_profile_id,
    }
}

fn write_json_atomic(path: PathBuf, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid_store_path".to_string())?;
    fs::create_dir_all(parent).map_err(|err| format!("create store directory failed: {err}"))?;
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    let raw = serde_json::to_string_pretty(value).map_err(|err| err.to_string())?;
    fs::write(&tmp, raw).map_err(|err| format!("write temp file failed: {err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("rename temp file failed: {err}"))?;
    Ok(())
}

fn persist_profiles(file: &LlmProfilesFile) -> Result<(), String> {
    write_json_atomic(
        profiles_path(),
        &serde_json::to_value(file).map_err(|err| err.to_string())?,
    )
}

fn read_secrets() -> BTreeMap<String, String> {
    fs::read_to_string(secrets_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
        .unwrap_or_default()
}

fn persist_secrets(secrets: &BTreeMap<String, String>) -> Result<(), String> {
    write_json_atomic(
        secrets_path(),
        &serde_json::to_value(secrets).map_err(|err| err.to_string())?,
    )
}

fn secret_ref(profile_id: &str) -> String {
    format!("llm:{profile_id}")
}

pub fn get_profiles() -> LlmProfilesResult {
    let file = read_profiles_file();
    LlmProfilesResult {
        profiles: file.profiles,
        default_profile_id: file.default_profile_id,
        store_path: Some(profiles_path().to_string_lossy().replace('\\', "/")),
    }
}

pub fn patch_profiles(request: Value) -> Result<LlmProfilesResult, String> {
    let body = request.get("request").unwrap_or(&request);
    let previous = read_profiles_file();
    let previous_by_id: HashMap<String, Value> = previous
        .profiles
        .iter()
        .filter_map(|profile| string_field(profile, "id").map(|id| (id, profile.clone())))
        .collect();
    let mut secret_store = read_secrets();
    let secrets = body.get("secrets").and_then(Value::as_object);
    let mut next_profiles = Vec::new();
    let mut seen = HashSet::new();

    for raw_profile in body
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(mut profile) = sanitize_profile(raw_profile) else {
            continue;
        };
        let Some(id) = string_field(&profile, "id") else {
            continue;
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let provided_secret = secrets.and_then(|map| map.get(&id));
        let mut next_secret_ref = string_field(&profile, "secretRef")
            .or_else(|| previous_by_id.get(&id).and_then(|old| string_field(old, "secretRef")));

        match provided_secret {
            Some(Value::String(value)) if !value.trim().is_empty() => {
                let reference = secret_ref(&id);
                secret_store.insert(reference.clone(), value.trim().to_string());
                next_secret_ref = Some(reference);
            }
            Some(Value::Null) => {
                if let Some(reference) = next_secret_ref.take() {
                    secret_store.remove(&reference);
                }
            }
            _ => {}
        }

        if let Some(reference) = next_secret_ref {
            if let Value::Object(map) = &mut profile {
                map.insert("secretRef".into(), Value::String(reference));
            }
        }
        next_profiles.push(profile);
    }

    for old_profile in previous.profiles {
        if let Some(id) = string_field(&old_profile, "id") {
            if !seen.contains(&id) {
                if let Some(reference) = string_field(&old_profile, "secretRef") {
                    secret_store.remove(&reference);
                }
            }
        }
    }

    let default_profile_id = body
        .get("defaultProfileId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|id| seen.contains(id))
        .or_else(|| next_profiles.first().and_then(|profile| string_field(profile, "id")));

    let file = LlmProfilesFile {
        profiles: next_profiles,
        default_profile_id,
    };
    persist_profiles(&file)?;
    persist_secrets(&secret_store)?;
    Ok(get_profiles())
}

fn profile_by_id(profile_id: &str) -> Result<Value, String> {
    read_profiles_file()
        .profiles
        .into_iter()
        .find(|profile| string_field(profile, "id").as_deref() == Some(profile_id))
        .ok_or_else(|| format!("LLM profile not found: {profile_id}"))
}

fn secret_for_profile(profile: &Value) -> Option<String> {
    let reference = string_field(profile, "secretRef")?;
    read_secrets().get(&reference).cloned()
}

fn normalize_openai_url(profile: &Value) -> String {
    let base = string_field(profile, "baseUrl").unwrap_or_else(|| "https://api.openai.com/v1".into());
    let base = base.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn safe_tool_name(name: &str, used: &mut HashSet<String>) -> String {
    let base: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let base = if base.is_empty() { "tool".into() } else { base };
    let mut candidate = base.clone();
    let mut suffix = 2;
    while used.contains(&candidate) {
        candidate = format!("{base}_{suffix}");
        suffix += 1;
    }
    used.insert(candidate.clone());
    candidate
}

fn openai_tools(tools: Option<&Vec<Value>>) -> (Option<Vec<Value>>, HashMap<String, String>) {
    let Some(tools) = tools else {
        return (None, HashMap::new());
    };
    let mut used = HashSet::new();
    let mut from_provider = HashMap::new();
    let mapped: Vec<Value> = tools
        .iter()
        .filter_map(|tool| {
            let name = string_field(tool, "name")?;
            let provider_name = safe_tool_name(&name, &mut used);
            from_provider.insert(provider_name.clone(), name);
            Some(json!({
                "type": "function",
                "function": {
                    "name": provider_name,
                    "description": string_field(tool, "description").unwrap_or_default(),
                    "parameters": tool.get("inputSchema").cloned().unwrap_or_else(|| json!({}))
                }
            }))
        })
        .collect();
    if mapped.is_empty() {
        (None, from_provider)
    } else {
        (Some(mapped), from_provider)
    }
}

fn openai_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            json!({
                "role": string_field(message, "role").unwrap_or_else(|| "user".into()),
                "content": string_field(message, "content").unwrap_or_default(),
                "tool_call_id": string_field(message, "toolCallId")
            })
        })
        .collect()
}

async fn call_openai_compatible(profile: &Value, api_key: &str, request: &Value) -> Result<Value, String> {
    let messages = request
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = request.get("tools").and_then(Value::as_array);
    let (tools, from_provider) = openai_tools(tools);
    let mut body = json!({
        "model": string_field(profile, "model").unwrap_or_default(),
        "messages": openai_messages(&messages),
        "tools": tools,
        "temperature": profile.get("temperature").cloned(),
        "max_tokens": profile.get("maxTokens").cloned(),
        "stream": false
    });

    if let Some(thinking) = string_field(profile, "thinking") {
        body["thinking"] = json!({ "type": thinking });
    }
    if let Some(effort) = string_field(profile, "reasoningEffort") {
        body["reasoning_effort"] = Value::String(effort);
    }

    let response = reqwest::Client::new()
        .post(normalize_openai_url(profile))
        .header("Content-Type", "application/json")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("LLM request failed: {err}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("LLM response read failed: {err}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), text.chars().take(500).collect::<String>()));
    }
    let json: Value = serde_json::from_str(&text).map_err(|err| format!("LLM JSON parse failed: {err}"))?;
    let message = json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut chunks = Vec::new();
    if let Some(content) = string_field(&message, "content") {
        if !content.is_empty() {
            chunks.push(json!({ "type": "delta", "content": content }));
        }
    }
    for tool_call in message
        .get("tool_calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let provider_name = tool_call
            .get("function")
            .and_then(|function| string_field(function, "name"))
            .unwrap_or_default();
        let arguments_raw = tool_call
            .get("function")
            .and_then(|function| string_field(function, "arguments"))
            .unwrap_or_else(|| "{}".into());
        let arguments = serde_json::from_str::<Value>(&arguments_raw).unwrap_or(Value::String(arguments_raw));
        chunks.push(json!({
            "type": "tool_call",
            "toolCall": {
                "id": string_field(tool_call, "id").unwrap_or_else(|| "tool-call".into()),
                "name": from_provider.get(&provider_name).cloned().unwrap_or(provider_name),
                "arguments": arguments
            }
        }));
    }
    chunks.push(json!({ "type": "done" }));
    Ok(json!({ "chunks": chunks }))
}

pub async fn probe_profile(request: Value) -> Result<Value, String> {
    let body = request.get("request").unwrap_or(&request);
    let profile_id = string_field(body, "profileId").ok_or_else(|| "missing profileId".to_string())?;
    let profile = profile_by_id(&profile_id)?;
    if profile.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err("LLM profile is disabled".into());
    }
    let kind = string_field(&profile, "kind").unwrap_or_else(|| "openaiCompatible".into());
    let api_key = secret_for_profile(&profile).unwrap_or_default();
    if api_key.is_empty() && kind != "ollama" {
        return Ok(json!({
            "ok": false,
            "provider": kind,
            "model": string_field(&profile, "model"),
            "error": "missing_api_key"
        }));
    }

    let start = Instant::now();
    let result = call_openai_compatible(
        &profile,
        &api_key,
        &json!({
            "messages": [
                { "role": "system", "content": "You are a probe." },
                { "role": "user", "content": "Reply with deepcode-ok." }
            ],
            "stream": false
        }),
    )
    .await;
    Ok(match result {
        Ok(_) => json!({
            "ok": true,
            "provider": kind,
            "model": string_field(&profile, "model"),
            "latencyMs": start.elapsed().as_millis() as u64
        }),
        Err(error) => json!({
            "ok": false,
            "provider": kind,
            "model": string_field(&profile, "model"),
            "latencyMs": start.elapsed().as_millis() as u64,
            "error": error
        }),
    })
}

pub async fn chat(request: Value) -> Result<Value, String> {
    let body = request.get("request").unwrap_or(&request);
    let profile_id = string_field(body, "profileId").ok_or_else(|| "missing profileId".to_string())?;
    let profile = profile_by_id(&profile_id)?;
    if profile.get("enabled").and_then(Value::as_bool) == Some(false) {
        return Err("LLM profile is disabled".into());
    }
    let kind = string_field(&profile, "kind").unwrap_or_else(|| "openaiCompatible".into());
    let api_key = secret_for_profile(&profile).unwrap_or_default();
    if api_key.is_empty() && kind != "ollama" {
        return Err("LLM profile is missing API key".into());
    }
    if kind != "openaiCompatible" && kind != "codex" {
        return Err(format!("Tauri LLM provider not implemented yet: {kind}"));
    }
    call_openai_compatible(&profile, &api_key, body).await
}
