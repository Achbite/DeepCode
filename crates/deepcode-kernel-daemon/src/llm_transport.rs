use crate::prelude::*;
use crate::*;
use axum::body::Body;
use bytes::Bytes;
use std::collections::HashSet;
use std::convert::Infallible;

const LLM_PROFILE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);
const PROVIDER_REQUEST_LIMIT: usize = 8 * 1024 * 1024;
const PROVIDER_ENVELOPE_LIMIT: usize = 1024 * 1024;
const PROVIDER_ERROR_BODY_LIMIT: usize = 16 * 1024;
const PROVIDER_ERROR_MESSAGE_LIMIT: usize = 512;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedLlmProfile {
    pub(crate) kind: String,
    pub(crate) provider_flavor: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) model: String,
    pub(crate) context_window_tokens: Option<u64>,
    pub(crate) max_output_tokens: Option<u32>,
    pub(crate) temperature: Option<f64>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) thinking: Option<String>,
    pub(crate) hosted_web_search: Option<String>,
    pub(crate) api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmToolDefinition {
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) input_schema: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmToolCall {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) arguments: Value,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct LlmChatOutput {
    pub(crate) content: String,
    pub(crate) reasoning: Option<String>,
    pub(crate) reasoning_signature: Option<String>,
    pub(crate) tool_calls: Vec<LlmToolCall>,
    pub(crate) hosted_web_search_calls: Vec<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderThinkingCompatibility {
    DeepSeek,
    Glm,
    Moonshot,
    Generic,
}

fn local_secret_ref_key(secret_ref: &str) -> Option<&str> {
    if secret_ref.trim() != secret_ref {
        return None;
    }
    let key = secret_ref.strip_prefix("local-secret:")?;
    (!key.is_empty() && key.trim() == key).then_some(key)
}

pub(crate) fn llm_profile_value_is_enabled(profile: &Value) -> bool {
    llm_profile_value_is_current(profile)
        && profile.get("enabled").and_then(Value::as_bool) == Some(true)
}

pub(crate) fn llm_profile_value_is_current(profile: &Value) -> bool {
    const FIELDS: &[&str] = &[
        "id",
        "name",
        "kind",
        "providerFlavor",
        "baseUrl",
        "model",
        "contextWindowTokens",
        "maxOutputTokens",
        "temperature",
        "reasoningEffort",
        "thinking",
        "hostedWebSearch",
        "secretRef",
        "enabled",
    ];
    let Some(profile) = profile.as_object() else {
        return false;
    };
    let text = |field: &str| {
        profile
            .get(field)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.trim() == value)
    };
    let optional_text = |field: &str| profile.get(field).is_none_or(|_| text(field));
    let optional_positive_integer = |field: &str| {
        profile.get(field).is_none_or(|value| {
            value
                .as_u64()
                .is_some_and(|value| value > 0 && value <= 1_000_000_000)
        })
    };
    profile.keys().all(|field| FIELDS.contains(&field.as_str()))
        && text("id")
        && text("name")
        && text("model")
        && profile.get("enabled").and_then(Value::as_bool).is_some()
        && matches!(
            profile.get("kind").and_then(Value::as_str),
            Some("openaiCompatible" | "responses" | "anthropic" | "ollama")
        )
        && profile.get("providerFlavor").is_none_or(|value| {
            matches!(
                value.as_str(),
                Some("openai" | "deepseek" | "zhipu" | "moonshot")
            )
        })
        && optional_text("baseUrl")
        && optional_positive_integer("contextWindowTokens")
        && optional_positive_integer("maxOutputTokens")
        && profile
            .get("temperature")
            .is_none_or(|value| value.as_f64().is_some_and(f64::is_finite))
        && profile
            .get("reasoningEffort")
            .is_none_or(|value| matches!(value.as_str(), Some("low" | "medium" | "high" | "max")))
        && profile
            .get("thinking")
            .is_none_or(|value| matches!(value.as_str(), Some("enabled" | "disabled")))
        && profile.get("hostedWebSearch").is_none_or(|value| {
            value.as_str() == Some("web_search")
                && profile.get("kind").and_then(Value::as_str) == Some("responses")
        })
        && profile
            .get("secretRef")
            .is_none_or(|value| value.as_str().and_then(local_secret_ref_key).is_some())
        && match (
            profile.get("contextWindowTokens").and_then(Value::as_u64),
            profile.get("maxOutputTokens").and_then(Value::as_u64),
        ) {
            (Some(context), Some(output)) => output < context,
            _ => true,
        }
}

pub(crate) fn llm_profile_store_is_current(config: &Value) -> bool {
    const FIELDS: &[&str] = &["profiles", "defaultProfileId"];
    let Some(config) = config.as_object() else {
        return false;
    };
    if config.len() != FIELDS.len() || config.keys().any(|field| !FIELDS.contains(&field.as_str()))
    {
        return false;
    }
    let Some(profiles) = config.get("profiles").and_then(Value::as_array) else {
        return false;
    };
    let mut ids = HashSet::with_capacity(profiles.len());
    if profiles.iter().any(|profile| {
        !llm_profile_value_is_current(profile)
            || !ids.insert(
                profile
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("current profile id")
                    .to_string(),
            )
    }) {
        return false;
    }
    let default_is_valid = match config.get("defaultProfileId") {
        Some(Value::Null) => true,
        Some(Value::String(id)) if !id.is_empty() && id.trim() == id => ids.contains(id),
        _ => false,
    };
    default_is_valid
}

pub(crate) fn llm_secret_store_is_current(store: &Value) -> bool {
    store.as_object().is_some_and(|store| {
        store.iter().all(|(key, value)| {
            !key.is_empty()
                && key.len() <= 128
                && key.trim() == key
                && !key.chars().any(char::is_control)
                && value
                    .as_str()
                    .is_some_and(|secret| !secret.trim().is_empty())
        })
    })
}

pub(crate) fn resolve_llm_profile(
    gui: &GuiState,
    profile_id: Option<&str>,
) -> Result<ResolvedLlmProfile, String> {
    if !llm_profile_store_is_current(&gui.llm_profiles) {
        return Err("LLM Profile 文件不是当前格式。".to_string());
    }
    let selected_id = profile_id.or_else(|| {
        gui.llm_profiles
            .get("defaultProfileId")
            .and_then(Value::as_str)
    });
    let profiles = gui
        .llm_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| "LLM Profile 列表不存在。".to_string())?;
    let profile = match selected_id {
        Some(id) => profiles
            .iter()
            .find(|profile| profile.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| format!("LLM Profile 不存在：{id}"))?,
        None => return Err("没有配置默认 LLM Profile。".to_string()),
    };
    if !llm_profile_value_is_enabled(profile) {
        return Err("选中的 LLM Profile 未启用或格式无效。".to_string());
    }
    let context_window_tokens = profile
        .get("contextWindowTokens")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| "LLM Profile 缺少正数 contextWindowTokens。".to_string())?;
    let max_output_tokens = profile
        .get("maxOutputTokens")
        .and_then(token_limit_u32)
        .filter(|value| *value > 0)
        .ok_or_else(|| "LLM Profile 缺少正数 maxOutputTokens。".to_string())?;
    if u64::from(max_output_tokens) >= context_window_tokens {
        return Err("LLM Profile 的 maxOutputTokens 必须小于 contextWindowTokens。".to_string());
    }
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .expect("validated profile id")
        .to_string();
    let secret_store = match read_optional_json_file(&gui.paths.llm_secrets_path)? {
        Some(value) if llm_secret_store_is_current(&value) => {
            value.as_object().cloned().expect("validated secret store")
        }
        Some(_) => return Err("LLM secret 文件不是当前字符串映射格式。".to_string()),
        None => serde_json::Map::new(),
    };
    let api_key = match profile.get("secretRef").and_then(Value::as_str) {
        Some(secret_ref) => {
            let key = local_secret_ref_key(secret_ref)
                .ok_or_else(|| "LLM Profile 的 secretRef 无效。".to_string())?;
            Some(
                secret_store
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| "LLM Profile 的本地 secret 不存在。".to_string())?
                    .to_string(),
            )
        }
        None => secret_store
            .get(&id)
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .or_else(|| {
                std::env::var("DEEPCODE_LLM_API_KEY")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
            }),
    };
    Ok(ResolvedLlmProfile {
        kind: profile
            .get("kind")
            .and_then(Value::as_str)
            .expect("validated profile kind")
            .to_string(),
        provider_flavor: profile
            .get("providerFlavor")
            .and_then(Value::as_str)
            .map(str::to_string),
        base_url: profile
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: profile
            .get("model")
            .and_then(Value::as_str)
            .expect("validated profile model")
            .to_string(),
        context_window_tokens: Some(context_window_tokens),
        max_output_tokens: Some(max_output_tokens),
        temperature: profile.get("temperature").and_then(Value::as_f64),
        reasoning_effort: profile
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
        thinking: profile
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string),
        hosted_web_search: profile
            .get("hostedWebSearch")
            .and_then(Value::as_str)
            .map(str::to_string),
        api_key,
    })
}

pub(crate) fn openai_compatible_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
    stream: bool,
    require_tool_call: bool,
) -> Value {
    let compatibility = provider_thinking_compatibility(profile);
    let mut body = json!({
        "model": profile.model,
        "messages": messages
            .into_iter()
            .map(|message| openai_compatible_message(message, compatibility))
            .collect::<Vec<_>>(),
        "stream": stream,
        "max_tokens": profile
            .max_output_tokens
            .expect("resolved Provider runtime has maxOutputTokens")
    });
    if !matches!(
        compatibility,
        ProviderThinkingCompatibility::DeepSeek | ProviderThinkingCompatibility::Moonshot
    ) {
        if let Some(temperature) = profile.temperature {
            body["temperature"] = json!(temperature);
        }
    }
    let kimi_k3 = compatibility == ProviderThinkingCompatibility::Moonshot
        && profile.model.starts_with("kimi-k3");
    if let Some(effort) = profile
        .reasoning_effort
        .as_ref()
        .filter(|_| compatibility != ProviderThinkingCompatibility::Moonshot || kimi_k3)
    {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(thinking) = profile.thinking.as_ref().filter(|_| !kimi_k3) {
        body["thinking"] = if compatibility == ProviderThinkingCompatibility::Moonshot
            && profile.model.starts_with("kimi-k2.7-code")
            && thinking == "enabled"
        {
            json!({ "type": "enabled", "keep": "all" })
        } else {
            json!({ "type": thinking })
        };
    }
    if compatibility == ProviderThinkingCompatibility::Glm && stream && !tools.is_empty() {
        body["tool_stream"] = json!(true);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema
                }
            }))
            .collect::<Vec<_>>());
        if require_tool_call
            && !(compatibility == ProviderThinkingCompatibility::DeepSeek
                && profile.thinking.as_deref() == Some("enabled"))
            && !(compatibility == ProviderThinkingCompatibility::Moonshot && !kimi_k3)
        {
            body["tool_choice"] = json!("required");
        }
    }
    body
}

fn responses_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
    hosted_tools: &[Value],
    stream: bool,
    require_tool_call: bool,
) -> Result<Value, ProviderTransportError> {
    let mut provider_tools = tools
        .iter()
        .map(|tool| {
            json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            })
        })
        .collect::<Vec<_>>();
    for tool in hosted_tools {
        let tool = tool.as_object().ok_or_else(|| {
            ProviderTransportError::message(
                "provider_hosted_tool_invalid",
                "Responses hosted tool 不是对象。",
            )
        })?;
        if tool.len() != 2
            || tool.get("type").and_then(Value::as_str) != Some("webSearch")
            || tool.get("providerToolType").and_then(Value::as_str) != Some("web_search")
        {
            return Err(ProviderTransportError::message(
                "provider_hosted_tool_invalid",
                "Responses hosted tool 合同无效。",
            ));
        }
        provider_tools.push(json!({ "type": "web_search" }));
    }
    let mut body = json!({
        "model": profile.model,
        "input": responses_input(messages)?,
        "stream": stream,
        "max_output_tokens": profile
            .max_output_tokens
            .expect("resolved Provider runtime has maxOutputTokens"),
    });
    if let Some(effort) = profile
        .reasoning_effort
        .as_ref()
        .filter(|_| profile.thinking.as_deref() != Some("disabled"))
    {
        body["reasoning"] = json!({ "effort": effort });
    }
    if provider_thinking_compatibility(profile) != ProviderThinkingCompatibility::DeepSeek {
        if let Some(temperature) = profile.temperature {
            body["temperature"] = json!(temperature);
        }
    }
    if !provider_tools.is_empty() {
        body["tools"] = Value::Array(provider_tools);
        if require_tool_call {
            body["tool_choice"] = json!("required");
        }
    }
    Ok(body)
}

fn responses_input(messages: Vec<Value>) -> Result<Vec<Value>, ProviderTransportError> {
    let mut input = Vec::new();
    for message in messages {
        let record = message.as_object().ok_or_else(|| {
            ProviderTransportError::message("provider_envelope_invalid", "Responses 消息不是对象。")
        })?;
        if let Some(blocks) = record
            .get("providerOutputBlocks")
            .filter(|blocks| !blocks.is_null())
        {
            if record.get("role").and_then(Value::as_str) != Some("assistant") {
                return Err(ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Responses providerOutputBlocks 只能属于 assistant 消息。",
                ));
            }
            let blocks = blocks
                .as_array()
                .filter(|blocks| !blocks.is_empty())
                .ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses providerOutputBlocks 不是非空数组。",
                    )
                })?;
            for block in blocks {
                let item = block.get("item").ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses providerOutputBlock 缺少原生 item。",
                    )
                })?;
                if !valid_responses_replay_item(item) {
                    return Err(ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses providerOutputBlock 原生 item 无效。",
                    ));
                }
                input.push(item.clone());
            }
            continue;
        }
        if let Some(provider_items) = record
            .get("providerItems")
            .filter(|provider_items| !provider_items.is_null())
        {
            let provider_items = provider_items.as_array().ok_or_else(|| {
                ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Responses providerItems 不是数组。",
                )
            })?;
            for item in provider_items {
                if !valid_responses_hosted_search_item(item) {
                    return Err(ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses providerItems 合同无效。",
                    ));
                }
                input.push(item.clone());
            }
        }
        let role = record
            .get("role")
            .and_then(Value::as_str)
            .filter(|role| matches!(*role, "system" | "user" | "assistant" | "tool"))
            .ok_or_else(|| {
                ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Responses 消息角色无效。",
                )
            })?;
        let content = record
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Responses 消息正文不是字符串。",
                )
            })?;
        if role == "tool" {
            let call_id = record
                .get("providerCallId")
                .and_then(Value::as_str)
                .filter(|call_id| !call_id.trim().is_empty())
                .ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses tool 消息缺少 providerCallId。",
                    )
                })?;
            input.push(json!({
                "type": "function_call_output",
                "call_id": call_id,
                "output": content,
            }));
            continue;
        }
        if !content.is_empty() {
            input.push(json!({
                "type": "message",
                "role": role,
                "content": [{
                    "type": if role == "assistant" { "output_text" } else { "input_text" },
                    "text": content,
                }],
            }));
        }
        let calls = match record.get("toolCalls").filter(|calls| !calls.is_null()) {
            Some(value) => value.as_array().ok_or_else(|| {
                ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Responses toolCalls 不是数组。",
                )
            })?,
            None => continue,
        };
        for call in calls {
            let call = call.as_object().ok_or_else(|| {
                ProviderTransportError::message(
                    "provider_envelope_invalid",
                    "Responses toolCalls 成员不是对象。",
                )
            })?;
            let call_id = call
                .get("providerCallId")
                .and_then(Value::as_str)
                .filter(|call_id| !call_id.trim().is_empty())
                .ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses function_call 缺少 providerCallId。",
                    )
                })?;
            let name = call
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses function_call 缺少工具名称。",
                    )
                })?;
            let arguments = call
                .get("input")
                .filter(|input| input.is_object())
                .ok_or_else(|| {
                    ProviderTransportError::message(
                        "provider_envelope_invalid",
                        "Responses function_call 参数不是对象。",
                    )
                })?;
            let arguments = serde_json::to_string(arguments).map_err(|error| {
                ProviderTransportError::message(
                    "provider_request_encode_failed",
                    format!("无法编码 Responses function_call 参数：{error}"),
                )
            })?;
            input.push(json!({
                "type": "function_call",
                "call_id": call_id,
                "name": name,
                "arguments": arguments,
            }));
        }
    }
    Ok(input)
}

pub(crate) fn valid_responses_hosted_search_item(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("web_search_call")
        && item
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.trim().is_empty())
        && matches!(
            item.get("status").and_then(Value::as_str),
            Some("completed" | "failed")
        )
        && item.get("action").is_some_and(Value::is_object)
}

fn valid_responses_replay_item(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str) {
        Some("message") => {
            item.get("role").and_then(Value::as_str) == Some("assistant")
                && item.get("content").is_some_and(Value::is_array)
        }
        Some("reasoning") => item.is_object(),
        Some("function_call") => {
            item.get("call_id")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                && item
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                && item.get("arguments").and_then(Value::as_str).is_some()
        }
        Some("web_search_call") => valid_responses_hosted_search_item(item),
        _ => false,
    }
}

fn openai_compatible_message(
    message: Value,
    compatibility: ProviderThinkingCompatibility,
) -> Value {
    let Some(record) = message.as_object() else {
        return message;
    };
    let role = record.get("role").and_then(Value::as_str).unwrap_or("user");
    match role {
        "assistant" => {
            let mut output = json!({
                "role": "assistant",
                "content": message_content_string(record.get("content"))
            });
            if let Some(reasoning) = record
                .get("reasoningContent")
                .or_else(|| record.get("reasoning_content"))
                .and_then(Value::as_str)
            {
                output[if matches!(
                    compatibility,
                    ProviderThinkingCompatibility::DeepSeek
                        | ProviderThinkingCompatibility::Glm
                        | ProviderThinkingCompatibility::Moonshot
                ) {
                    "reasoning_content"
                } else {
                    "reasoning"
                }] = json!(reasoning);
            }
            let calls = record
                .get("toolCalls")
                .or_else(|| record.get("tool_calls"))
                .and_then(Value::as_array)
                .map(|calls| {
                    calls
                        .iter()
                        .filter_map(openai_tool_call)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if !calls.is_empty() {
                output["tool_calls"] = Value::Array(calls);
                if compatibility == ProviderThinkingCompatibility::DeepSeek
                    && output.get("reasoning_content").is_none()
                {
                    // DeepSeek V4 rejects both an omitted field and JSON null
                    // when a thinking-mode tool-call message is replayed. An
                    // empty string is the accepted wire representation for a
                    // sub-turn where the Provider emitted no reasoning text;
                    // this does not invent reasoning in Session state.
                    output["reasoning_content"] = json!("");
                }
            }
            output
        }
        "tool" => json!({
            "role": "tool",
            "tool_call_id": record
                .get("providerCallId")
                .and_then(Value::as_str)
                .expect("validated tool message has providerCallId"),
            "content": provider_tool_content(record.get("content"), compatibility)
        }),
        _ => json!({
            "role": role,
            "content": message_content_string(record.get("content"))
        }),
    }
}

fn provider_tool_content(
    content: Option<&Value>,
    compatibility: ProviderThinkingCompatibility,
) -> String {
    let text = message_content_string(content);
    if compatibility == ProviderThinkingCompatibility::Moonshot {
        if let Ok(result) = serde_json::from_str::<Value>(&text) {
            if result["outcome"] == "completed" && result["output"]["provider"] == "kimi-formula" {
                if let Some(output) = result["output"]["providerContent"].as_str() {
                    return output.to_string();
                }
            }
        }
    }
    text
}

fn openai_tool_call(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let function = record.get("function").and_then(Value::as_object);
    let name = function
        .and_then(|value| value.get("name"))
        .or_else(|| record.get("name"))
        .and_then(Value::as_str)?;
    let arguments = function
        .and_then(|value| value.get("arguments"))
        .or_else(|| record.get("input"))
        .or_else(|| record.get("arguments"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    Some(json!({
        "id": record
            .get("providerCallId")
            .and_then(Value::as_str)
            .expect("validated tool call has providerCallId"),
        "type": "function",
        "function": {
            "name": name,
            "arguments": match arguments {
                Value::String(text) => text,
                value => serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
            }
        }
    }))
}

pub(crate) fn message_content_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    }
}

#[derive(Debug, Clone)]
pub(crate) struct LlmStreamProbeResult {
    pub(crate) provider_kind: &'static str,
    pub(crate) terminal_signal: &'static str,
    pub(crate) finish_reason: Option<String>,
    pub(crate) reasoning_present: bool,
    pub(crate) response_present: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderTransportError {
    pub(crate) code: &'static str,
    pub(crate) http_status: Option<u16>,
    message: Option<String>,
}

impl ProviderTransportError {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            http_status: None,
            message: None,
        }
    }

    fn message(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            http_status: None,
            message: Some(message.into()),
        }
    }

    fn http(status: u16) -> Self {
        Self {
            code: "provider_http_status_failed",
            http_status: Some(status),
            message: None,
        }
    }

    pub(crate) fn safe_message(&self) -> String {
        if let Some(message) = &self.message {
            return message.clone();
        }
        match self.code {
            "provider_kind_unsupported" => "当前 Provider 类型不受支持。",
            "provider_api_key_missing" => "当前 Provider Profile 没有配置 API Key。",
            "provider_request_too_large" => "Provider 请求超过本地传输上限。",
            "provider_envelope_invalid" => "Provider 请求正文不是当前闭合结构。",
            "provider_hosted_tool_unsupported" => "当前 Provider API surface 不支持 hosted tool。",
            "provider_hosted_tool_invalid" => "Provider hosted tool 合同无效。",
            "provider_envelope_too_large" => "Provider 单个流事件超过结构上限。",
            "provider_probe_timeout" => "Provider 探测超时。",
            "provider_http_status_failed" => "Provider 返回非成功 HTTP 状态。",
            "provider_transport_failed" => "Provider 连接失败。",
            _ => "Provider 流未正常完成。",
        }
        .to_string()
    }
}

#[derive(Debug)]
struct PreparedProviderRequest {
    kind: ProviderStreamKind,
    body: Vec<u8>,
    hosted_web_search_enabled: bool,
}

fn prepare_provider_request(
    profile: &ResolvedLlmProfile,
    envelope: &Value,
) -> Result<PreparedProviderRequest, ProviderTransportError> {
    let kind = ProviderStreamKind::from_profile_kind(&profile.kind)
        .ok_or_else(|| ProviderTransportError::new("provider_kind_unsupported"))?;
    let messages = envelope
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| ProviderTransportError::new("provider_envelope_invalid"))?;
    let tools = envelope
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .map(provider_tools_from_values)
        .ok_or_else(|| ProviderTransportError::new("provider_envelope_invalid"))?;
    let hosted_tools = envelope
        .get("hostedTools")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| ProviderTransportError::new("provider_envelope_invalid"))?;
    if !hosted_tools.is_empty() && kind != ProviderStreamKind::Responses {
        return Err(ProviderTransportError::new(
            "provider_hosted_tool_unsupported",
        ));
    }
    let require_tool_call = envelope
        .get("requireToolCall")
        .and_then(Value::as_bool)
        .ok_or_else(|| ProviderTransportError::new("provider_envelope_invalid"))?;
    if require_tool_call && tools.is_empty() {
        return Err(ProviderTransportError::new(
            "provider_required_tool_missing",
        ));
    }
    let provider_body = match kind {
        ProviderStreamKind::OpenAiCompatible => {
            openai_compatible_request_body(profile, messages, &tools, true, require_tool_call)
        }
        ProviderStreamKind::Responses => responses_request_body(
            profile,
            messages,
            &tools,
            &hosted_tools,
            true,
            require_tool_call,
        )?,
        ProviderStreamKind::Anthropic => {
            anthropic_stream_request_body(profile, messages, &tools, require_tool_call)
        }
        ProviderStreamKind::Ollama => {
            ollama_stream_request_body(profile, messages, &tools, require_tool_call)
        }
    };
    let body = serde_json::to_vec(&provider_body).map_err(|error| {
        ProviderTransportError::message(
            "provider_request_encode_failed",
            format!("无法编码 Provider 请求：{error}"),
        )
    })?;
    if body.len() > PROVIDER_REQUEST_LIMIT {
        return Err(ProviderTransportError::new("provider_request_too_large"));
    }
    Ok(PreparedProviderRequest {
        kind,
        body,
        hosted_web_search_enabled: !hosted_tools.is_empty(),
    })
}

fn provider_request_url(profile: &ResolvedLlmProfile, kind: ProviderStreamKind) -> String {
    match kind {
        ProviderStreamKind::OpenAiCompatible => normalize_openai_base_url(profile),
        ProviderStreamKind::Responses => normalize_responses_base_url(profile),
        ProviderStreamKind::Anthropic => normalize_anthropic_base_url(profile),
        ProviderStreamKind::Ollama => normalize_ollama_base_url(profile),
    }
}

fn build_provider_request(
    profile: &ResolvedLlmProfile,
    prepared: &PreparedProviderRequest,
) -> Result<reqwest::RequestBuilder, ProviderTransportError> {
    let url = provider_request_url(profile, prepared.kind);
    let mut request = reqwest::Client::new()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(prepared.body.clone());
    match prepared.kind {
        ProviderStreamKind::OpenAiCompatible | ProviderStreamKind::Responses => {
            let key = profile
                .api_key
                .as_deref()
                .ok_or_else(|| ProviderTransportError::new("provider_api_key_missing"))?;
            request = request.bearer_auth(key);
        }
        ProviderStreamKind::Anthropic => {
            let key = profile
                .api_key
                .as_deref()
                .ok_or_else(|| ProviderTransportError::new("provider_api_key_missing"))?;
            request = request
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        }
        ProviderStreamKind::Ollama => {}
    }
    Ok(request)
}

struct ProviderEnvelopeFramer {
    kind: ProviderStreamKind,
    buffer: Vec<u8>,
}

impl ProviderEnvelopeFramer {
    fn new(kind: ProviderStreamKind) -> Self {
        Self {
            kind,
            buffer: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, ProviderTransportError> {
        self.buffer.extend_from_slice(chunk);
        let mut payloads = Vec::new();
        match self.kind {
            ProviderStreamKind::OpenAiCompatible
            | ProviderStreamKind::Responses
            | ProviderStreamKind::Anthropic => {
                while let Some((end, delimiter)) = sse_boundary(&self.buffer) {
                    let raw = self.buffer.drain(..end + delimiter).collect::<Vec<_>>();
                    ensure_envelope_size(&raw)?;
                    if let Some(payload) = sse_payload(&raw)? {
                        payloads.push(payload);
                    }
                }
            }
            ProviderStreamKind::Ollama => {
                while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
                    let raw = self.buffer.drain(..=index).collect::<Vec<_>>();
                    ensure_envelope_size(&raw)?;
                    if let Some(payload) = trimmed_payload(&raw) {
                        payloads.push(payload);
                    }
                }
            }
        }
        if self.buffer.len() > PROVIDER_ENVELOPE_LIMIT {
            return Err(ProviderTransportError::new("provider_envelope_too_large"));
        }
        Ok(payloads)
    }

    fn finish(&mut self) -> Result<Vec<Vec<u8>>, ProviderTransportError> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            self.buffer.clear();
            return Ok(Vec::new());
        }
        if self.kind != ProviderStreamKind::Ollama {
            return Err(ProviderTransportError::new("provider_stream_incomplete"));
        }
        let raw = std::mem::take(&mut self.buffer);
        ensure_envelope_size(&raw)?;
        Ok(trimmed_payload(&raw).into_iter().collect())
    }
}

fn ensure_envelope_size(raw: &[u8]) -> Result<(), ProviderTransportError> {
    if raw.len() > PROVIDER_ENVELOPE_LIMIT {
        Err(ProviderTransportError::new("provider_envelope_too_large"))
    } else {
        Ok(())
    }
}

fn sse_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
    let crlf = buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|index| (index, 4));
    let lf = buffer
        .windows(2)
        .position(|window| window == b"\n\n")
        .map(|index| (index, 2));
    match (crlf, lf) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

fn sse_payload(raw: &[u8]) -> Result<Option<Vec<u8>>, ProviderTransportError> {
    let text = std::str::from_utf8(raw).map_err(|error| {
        ProviderTransportError::message(
            "provider_stream_utf8_invalid",
            format!("Provider SSE 不是 UTF-8：{error}"),
        )
    })?;
    let mut data = Vec::new();
    for line in text.lines() {
        if let Some(value) = line.trim_end_matches('\r').strip_prefix("data:") {
            if !data.is_empty() {
                data.push(b'\n');
            }
            data.extend_from_slice(value.trim_start().as_bytes());
        }
    }
    Ok((!data.is_empty()).then_some(data))
}

fn trimmed_payload(raw: &[u8]) -> Option<Vec<u8>> {
    let start = raw.iter().position(|byte| !byte.is_ascii_whitespace())?;
    let end = raw
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)?;
    Some(raw[start..end].to_vec())
}

pub(crate) async fn probe_llm_profile_stream(
    profile: &ResolvedLlmProfile,
) -> Result<LlmStreamProbeResult, ProviderTransportError> {
    tokio::time::timeout(LLM_PROFILE_PROBE_TIMEOUT, probe_profile(profile))
        .await
        .unwrap_or_else(|_| Err(ProviderTransportError::new("provider_probe_timeout")))
}

async fn probe_profile(
    profile: &ResolvedLlmProfile,
) -> Result<LlmStreamProbeResult, ProviderTransportError> {
    let prepared = prepare_provider_request(
        profile,
        &json!({
            "messages": [{ "role": "user", "content": "Reply with OK." }],
            "tools": [],
            "hostedTools": [],
            "requireToolCall": false
        }),
    )?;
    let kind = prepared.kind;
    let mut response = build_provider_request(profile, &prepared)?
        .send()
        .await
        .map_err(|_| ProviderTransportError::new("provider_transport_failed"))?;
    if !response.status().is_success() {
        return Err(ProviderTransportError::http(response.status().as_u16()));
    }
    let mut framer = ProviderEnvelopeFramer::new(kind);
    let mut accumulator = ProviderStreamAccumulator::new(kind);
    loop {
        let (payloads, eof) = match response.chunk().await {
            Ok(Some(chunk)) => (framer.push(&chunk)?, false),
            Ok(None) => (framer.finish()?, true),
            Err(_) => return Err(ProviderTransportError::new("provider_transport_failed")),
        };
        for payload in payloads {
            accumulator
                .ingest_payload(&payload)
                .map_err(|error| ProviderTransportError::message(error.code, error.message))?;
        }
        if accumulator.source_done() || eof {
            break;
        }
    }
    let result = accumulator
        .finalize()
        .map_err(|error| ProviderTransportError::message(error.code, error.message))?;
    let response_present = !result.output.content.trim().is_empty()
        || result
            .output
            .tool_calls
            .iter()
            .any(|call| !call.id.is_empty() && !call.name.is_empty());
    Ok(LlmStreamProbeResult {
        provider_kind: result.completion.provider_kind.wire_name(),
        terminal_signal: result.completion.provider_kind.terminal_signal(),
        finish_reason: result.completion.finish_reason,
        reasoning_present: result
            .output
            .reasoning
            .as_deref()
            .is_some_and(|reasoning| !reasoning.trim().is_empty()),
        response_present,
    })
}

pub(crate) fn local_agent_provider_stream_response(
    profile: ResolvedLlmProfile,
    request_envelope: Value,
    request_id: String,
    archive_directory: std::path::PathBuf,
    archive_identity: Value,
) -> Response {
    let response_request_id = request_id.clone();
    let stream = async_stream::stream! {
        let mut archive = match deepcode_kernel_runtime::execution_archive::ExecutionArchive::open(
            Some(&archive_directory),
            archive_identity,
        ) {
            Ok(archive) => archive,
            Err(error) => {
                yield Ok::<Bytes, Infallible>(Bytes::from(provider_event(
                    &request_id,
                    "failed",
                    json!({"code": "execution_archive_failed", "message": error.to_string()}),
                )));
                return;
            }
        };
        let prepared = match prepare_provider_request(&profile, &request_envelope) {
            Ok(prepared) => prepared,
            Err(error) => {
                let (packet, archive_failed) = archived_provider_event(
                    &mut archive,
                    &request_id,
                    "failed",
                    json!({ "code": error.code, "message": error.safe_message() }),
                );
                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                if archive_failed {
                    return;
                }
                return;
            }
        };
        let kind = prepared.kind;
        // Retain the wire body, never the credential-bearing profile or headers.
        if let Err(error) = archive
            .record(
                "request.started",
                json!({
                    "method": "POST", "url": provider_request_url(&profile, kind),
                    "model": profile.model, "apiSurface": profile.kind,
                }),
            )
            .and_then(|()| archive.bytes("request.body", &prepared.body))
        {
            yield Ok::<Bytes, Infallible>(Bytes::from(provider_event(
                &request_id,
                "failed",
                json!({"code": "execution_archive_failed", "message": error.to_string()}),
            )));
            return;
        }
        let request = match build_provider_request(&profile, &prepared) {
            Ok(request) => request,
            Err(error) => {
                let (packet, archive_failed) = archived_provider_event(
                    &mut archive,
                    &request_id,
                    "failed",
                    json!({ "code": error.code, "message": error.safe_message() }),
                );
                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                if archive_failed {
                    return;
                }
                return;
            }
        };
        let mut response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let (packet, archive_failed) = archived_provider_event(
                    &mut archive,
                    &request_id,
                    "failed",
                    json!({
                        "code": "provider_transport_failed",
                        "message": format!("Provider 连接失败：{error}"),
                    }),
                );
                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                if archive_failed {
                    return;
                }
                return;
            }
        };
        if let Err(error) = archive.record("response.headers", json!({
                "statusCode": response.status().as_u16(),
                "url": response.url().as_str(),
                "contentType": response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()),
            })) {
                yield Ok::<Bytes, Infallible>(Bytes::from(provider_event(&request_id, "failed",
                    json!({"code": "execution_archive_failed", "message": error.to_string()}))));
                return;
            }
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let message = match provider_http_error_message(&mut response, status, &mut archive).await {
                Ok(message) => message,
                Err(error) => {
                    yield Ok::<Bytes, Infallible>(Bytes::from(provider_event(
                        &request_id,
                        "failed",
                        json!({"code": "execution_archive_failed", "message": error.to_string()}),
                    )));
                    return;
                }
            };
            let (packet, archive_failed) = archived_provider_event(
                &mut archive,
                &request_id,
                "failed",
                json!({
                    "code": "provider_http_failed",
                    "message": message,
                }),
            );
            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
            if archive_failed {
                return;
            }
            return;
        }
        let mut framer = ProviderEnvelopeFramer::new(kind);
        let mut accumulator = ProviderStreamAccumulator::new(kind);
        'provider: loop {
            let (payloads, eof) = match response.chunk().await {
                Ok(Some(chunk)) => {
                    if let Err(error) = archive.bytes("response.chunk", &chunk) {
                        yield Ok::<Bytes, Infallible>(Bytes::from(provider_event(
                            &request_id,
                            "failed",
                            json!({"code": "execution_archive_failed", "message": error.to_string()}),
                        )));
                        return;
                    }
                    match framer.push(&chunk) {
                        Ok(payloads) => (payloads, false),
                        Err(error) => {
                            let (packet, archive_failed) = archived_provider_event(
                                &mut archive,
                                &request_id,
                                "failed",
                                json!({ "code": error.code, "message": error.safe_message() }),
                            );
                            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                            if archive_failed {
                                return;
                            }
                            return;
                        }
                    }
                }
                Ok(None) => match framer.finish() {
                    Ok(payloads) => (payloads, true),
                    Err(error) => {
                        let (packet, archive_failed) = archived_provider_event(
                            &mut archive,
                            &request_id,
                            "failed",
                            json!({ "code": error.code, "message": error.safe_message() }),
                        );
                        yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                        if archive_failed {
                            return;
                        }
                        return;
                    }
                },
                Err(error) => {
                    let (packet, archive_failed) = archived_provider_event(
                        &mut archive,
                        &request_id,
                        "failed",
                        json!({
                            "code": "provider_stream_read_failed",
                            "message": format!("读取 Provider 流失败：{error}"),
                        }),
                    );
                    yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                    if archive_failed {
                        return;
                    }
                    return;
                }
            };
            for payload in payloads {
                let emissions = match accumulator.ingest_payload(&payload) {
                    Ok(emissions) => emissions,
                    Err(error) => {
                        let (packet, archive_failed) = archived_provider_event(
                            &mut archive,
                            &request_id,
                            "failed",
                            json!({ "code": error.code, "message": error.message }),
                        );
                        yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                        if archive_failed {
                            return;
                        }
                        return;
                    }
                };
                for emission in emissions {
                    let event_type = emission.event.get("type").and_then(Value::as_str);
                    match event_type {
                        Some("tool_call_delta") => {
                            let mut data = emission.event;
                            data.as_object_mut()
                                .expect("tool delta object")
                                .remove("type");
                            let (packet, archive_failed) = archived_provider_event(
                                &mut archive,
                                &request_id,
                                "tool.call.delta",
                                data,
                            );
                            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                            if archive_failed {
                                return;
                            }
                        }
                        Some("text_delta") | Some("reasoning_delta") => {
                            let Some(text) = emission.event.get("content").and_then(Value::as_str)
                            else {
                                continue;
                            };
                            let provider_type = if event_type == Some("text_delta") {
                                "text.delta"
                            } else {
                                "reasoning.delta"
                            };
                            let mut data =
                                match emission.event.get("output_index").and_then(Value::as_i64) {
                                    Some(output_index) => {
                                        json!({ "text": text, "outputIndex": output_index })
                                    }
                                    None => json!({ "text": text }),
                                };
                            if emission.event.get("kind").and_then(Value::as_str) == Some("summary") {
                                data["kind"] = json!("summary");
                            }
                            let (packet, archive_failed) =
                                archived_provider_event(&mut archive, &request_id, provider_type, data);
                            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                            if archive_failed {
                                return;
                            }
                        }
                        Some("output_item_completed") => {
                            let Some(output_index) =
                                emission.event.get("output_index").and_then(Value::as_i64)
                            else {
                                let (packet, archive_failed) = archived_provider_event(
                                    &mut archive,
                                    &request_id,
                                    "failed",
                                    json!({
                                        "code": "provider_stream_emission_invalid",
                                        "message": "Kernel 流解析器产生了缺少 output_index 的完成项。",
                                    }),
                                );
                                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                                if archive_failed {
                                    return;
                                }
                                return;
                            };
                            let Some(item) = emission.event.get("item") else {
                                let (packet, archive_failed) = archived_provider_event(
                                    &mut archive,
                                    &request_id,
                                    "failed",
                                    json!({
                                        "code": "provider_stream_emission_invalid",
                                        "message": "Kernel 流解析器产生了缺少 item 的完成项。",
                                    }),
                                );
                                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                                if archive_failed {
                                    return;
                                }
                                return;
                            };
                            if item.get("type").and_then(Value::as_str) == Some("web_search_call")
                                && !prepared.hosted_web_search_enabled
                            {
                                let (packet, archive_failed) = archived_provider_event(
                                    &mut archive,
                                    &request_id,
                                    "failed",
                                    json!({
                                        "code": "provider_hosted_search_unrequested",
                                        "message": "Provider 返回了当前请求未启用的 hosted search 事实。",
                                    }),
                                );
                                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                                if archive_failed {
                                    return;
                                }
                                return;
                            }
                            let (packet, archive_failed) = archived_provider_event(
                                &mut archive,
                                &request_id,
                                "output.item.completed",
                                json!({
                                    "outputIndex": output_index,
                                    "item": item,
                                }),
                            );
                            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                            if archive_failed {
                                return;
                            }
                        }
                        _ => {}
                    }
                }
            }
            if accumulator.source_done() || eof {
                break 'provider;
            }
        }
        let result = match accumulator.finalize_for_request(&request_id) {
            Ok(result) => result,
            Err(error) => {
                let (packet, archive_failed) = archived_provider_event(
                    &mut archive,
                    &request_id,
                    "failed",
                    json!({ "code": error.code, "message": error.message }),
                );
                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                if archive_failed {
                    return;
                }
                return;
            }
        };
        if !prepared.hosted_web_search_enabled && !result.output.hosted_web_search_calls.is_empty() {
            let (packet, archive_failed) = archived_provider_event(
                &mut archive,
                &request_id,
                "failed",
                json!({
                    "code": "provider_hosted_search_unrequested",
                    "message": "Provider 返回了当前请求未启用的 hosted search 事实。",
                }),
            );
            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
            if archive_failed {
                return;
            }
            return;
        }
        if result.completion.provider_kind != ProviderStreamKind::Responses
            && (!result.output.content.is_empty()
                || result
                    .output
                    .reasoning
                    .as_deref()
                    .is_some_and(|reasoning| !reasoning.trim().is_empty())
                || !result.output.tool_calls.is_empty())
        {
            let mut message = json!({
                "messageId": format!("provider-message:{request_id}"),
                "content": result.output.content,
            });
            if let Some(reasoning) = result
                .output
                .reasoning
                .as_deref()
                .filter(|reasoning| !reasoning.trim().is_empty())
            {
                message["reasoningContent"] = json!(reasoning);
            }
            if let Some(signature) = result
                .output
                .reasoning_signature
                .as_deref()
                .filter(|signature| !signature.trim().is_empty())
            {
                message["reasoningSignature"] = json!(signature);
            }
            let (packet, archive_failed) =
                archived_provider_event(&mut archive, &request_id, "assistant.message", message);
            yield Ok::<Bytes, Infallible>(Bytes::from(packet));
            if archive_failed {
                return;
            }
        }
        let completed_data = match (result.completion.usage, profile.context_window_tokens) {
            (Some(usage), Some(context_window_tokens)) => {
                let mut usage_data = json!({
                    "inputTokens": usage.input_tokens,
                    "outputTokens": usage.output_tokens,
                    "contextWindowTokens": context_window_tokens,
                });
                if let (Some(cache_read), Some(cache_miss)) =
                    (usage.cache_read_input_tokens, usage.cache_miss_input_tokens)
                {
                    usage_data["cacheReadInputTokens"] = json!(cache_read);
                    usage_data["cacheMissInputTokens"] = json!(cache_miss);
                }
                json!({ "usage": usage_data })
            }
            _ => json!({}),
        };
        if result.completion.provider_kind != ProviderStreamKind::Responses {
            for call in result.output.tool_calls {
                let (packet, archive_failed) = archived_provider_event(
                    &mut archive,
                    &request_id,
                    "tool.call",
                    json!({
                        "callId": call.id,
                        "name": call.name,
                        "input": call.arguments,
                    }),
                );
                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                if archive_failed {
                    return;
                }
            }
            for item in result.output.hosted_web_search_calls {
                let (packet, archive_failed) = archived_provider_event(
                    &mut archive,
                    &request_id,
                    "hosted.web-search.completed",
                    json!({ "item": item }),
                );
                yield Ok::<Bytes, Infallible>(Bytes::from(packet));
                if archive_failed {
                    return;
                }
            }
        }
        let (packet, archive_failed) =
            archived_provider_event(&mut archive, &request_id, "completed", completed_data);
        yield Ok::<Bytes, Infallible>(Bytes::from(packet));
        if archive_failed {
            return;
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| {
            Response::new(Body::from(provider_event(
                &response_request_id,
                "failed",
                json!({
                    "code": "provider_response_build_failed",
                    "message": "无法创建 Provider 流响应。",
                }),
            )))
        })
}

// Archive the same envelope that is delivered to Session, preserving outputIndex
// and event ordering. A failed archive write terminates this transport explicitly.
fn archived_provider_event(
    archive: &mut deepcode_kernel_runtime::execution_archive::ExecutionArchive,
    request_id: &str,
    event_type: &str,
    data: Value,
) -> (String, bool) {
    let written = archive
        .record("session.event", json!({"type": event_type, "data": &data}))
        .and_then(|()| {
            if matches!(event_type, "completed" | "failed") {
                archive.finish(event_type, json!({}))
            } else {
                Ok(())
            }
        });
    match written {
        Ok(()) => (provider_event(request_id, event_type, data), false),
        Err(error) => (
            provider_event(
                request_id,
                "failed",
                json!({
                    "code": "execution_archive_failed", "message": error.to_string(),
                }),
            ),
            true,
        ),
    }
}

async fn provider_http_error_message(
    response: &mut reqwest::Response,
    status: u16,
    archive: &mut deepcode_kernel_runtime::execution_archive::ExecutionArchive,
) -> std::io::Result<String> {
    let mut body = Vec::new();
    while body.len() < PROVIDER_ERROR_BODY_LIMIT {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                archive.bytes("response.chunk", &chunk)?;
                let remaining = PROVIDER_ERROR_BODY_LIMIT - body.len();
                body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            }
            Ok(None) | Err(_) => break,
        }
    }
    archive.record(
        "response.error-body.read",
        json!({
            "retainedBytes": body.len(), "readLimitBytes": PROVIDER_ERROR_BODY_LIMIT,
            "limitReached": body.len() == PROVIDER_ERROR_BODY_LIMIT,
        }),
    )?;
    Ok(match provider_http_error_detail(&body) {
        Some(detail) => format!("Provider 返回 HTTP {status}：{detail}"),
        None => format!("Provider 返回 HTTP {status}。"),
    })
}

fn provider_http_error_detail(body: &[u8]) -> Option<String> {
    let value = serde_json::from_slice::<Value>(body).ok()?;
    let message = value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)?
        .trim();
    if message.is_empty() {
        return None;
    }
    Some(
        message
            .chars()
            .filter(|character| !character.is_control() || character.is_whitespace())
            .take(PROVIDER_ERROR_MESSAGE_LIMIT)
            .collect(),
    )
}

fn provider_event(request_id: &str, event_type: &str, data: Value) -> String {
    sse_json_event(
        "provider_event",
        json!({
            "schemaVersion": "deepcode.provider-event",
            "requestId": request_id,
            "type": event_type,
            "data": data,
        }),
    )
}

fn token_limit_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|raw| u32::try_from(raw).ok())
        .filter(|value| *value > 0)
}

fn normalize_openai_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else {
        format!("{base}/chat/completions")
    }
}

fn normalize_responses_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.openai.com/v1")
        .trim_end_matches('/');
    if base.ends_with("/responses") {
        base.to_string()
    } else {
        format!("{base}/responses")
    }
}

pub(crate) fn normalize_anthropic_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("https://api.anthropic.com")
        .trim_end_matches('/');
    if base.ends_with("/v1/messages") {
        base.to_string()
    } else {
        format!("{base}/v1/messages")
    }
}

pub(crate) fn normalize_ollama_base_url(profile: &ResolvedLlmProfile) -> String {
    let base = profile
        .base_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:11434")
        .trim_end_matches('/');
    if base.ends_with("/api/chat") {
        base.to_string()
    } else {
        format!("{base}/api/chat")
    }
}

fn provider_thinking_compatibility(profile: &ResolvedLlmProfile) -> ProviderThinkingCompatibility {
    match profile.provider_flavor.as_deref() {
        Some("deepseek") => ProviderThinkingCompatibility::DeepSeek,
        Some("zhipu") => ProviderThinkingCompatibility::Glm,
        Some("moonshot") => ProviderThinkingCompatibility::Moonshot,
        _ => ProviderThinkingCompatibility::Generic,
    }
}

pub(crate) fn split_system_messages(messages: Vec<Value>) -> (String, Vec<Value>) {
    let mut system = Vec::new();
    let mut chat = Vec::new();
    for message in messages {
        if message.get("role").and_then(Value::as_str) == Some("system") {
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                system.push(content.to_string());
            }
        } else {
            chat.push(message);
        }
    }
    (system.join("\n\n"), chat)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_tool_constraint_reaches_each_provider_payload() {
        let envelope = json!({
            "messages": [{ "role": "user", "content": "Execute the confirmed step." }],
            "tools": [{
                "name": "fixture_tool",
                "description": "Execute one fixture action.",
                "inputSchema": { "type": "object", "additionalProperties": false }
            }],
            "hostedTools": [],
            "requireToolCall": true
        });
        for (kind, expected) in [
            ("openaiCompatible", json!("required")),
            ("responses", json!("required")),
            ("anthropic", json!({ "type": "any" })),
            ("ollama", json!("required")),
        ] {
            let prepared = prepare_provider_request(&test_profile(kind), &envelope)
                .expect("required-tool request must prepare");
            let body: Value =
                serde_json::from_slice(&prepared.body).expect("provider request body must decode");
            assert_eq!(
                body.get("tool_choice"),
                Some(&expected),
                "provider kind {kind}"
            );
        }
    }

    #[test]
    fn normal_provider_request_does_not_force_a_tool_call() {
        let prepared = prepare_provider_request(
            &test_profile("openaiCompatible"),
            &json!({
                "messages": [{ "role": "user", "content": "Answer normally." }],
                "tools": [{
                    "name": "fixture_tool",
                    "description": "Fixture action.",
                    "inputSchema": { "type": "object" }
                }],
                "hostedTools": [],
                "requireToolCall": false
            }),
        )
        .expect("normal request must prepare");
        let body: Value =
            serde_json::from_slice(&prepared.body).expect("provider request body must decode");
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn deepseek_thinking_execution_omits_unsupported_tool_choice() {
        let mut profile = test_profile("openaiCompatible");
        profile.provider_flavor = Some("deepseek".to_string());
        profile.thinking = Some("enabled".to_string());
        let prepared = prepare_provider_request(
            &profile,
            &json!({
                "messages": [{ "role": "user", "content": "Execute the confirmed step." }],
                "tools": [{
                    "name": "fixture_tool",
                    "description": "Execute one fixture action.",
                    "inputSchema": { "type": "object", "additionalProperties": false }
                }],
                "hostedTools": [],
                "requireToolCall": true
            }),
        )
        .expect("DeepSeek thinking request must prepare");
        let body: Value =
            serde_json::from_slice(&prepared.body).expect("provider request body must decode");

        assert_eq!(body["thinking"], json!({ "type": "enabled" }));
        assert_eq!(body["tools"].as_array().map(Vec::len), Some(1));
        assert!(body.get("tool_choice").is_none());
    }

    #[test]
    fn responses_request_enables_hosted_search_and_replays_provider_item_unchanged() {
        let mut profile = test_profile("responses");
        profile.provider_flavor = Some("deepseek".to_string());
        profile.base_url = Some("https://api.deepseek.com".to_string());
        profile.hosted_web_search = Some("web_search".to_string());
        let item = json!({
            "type": "web_search_call",
            "id": "ws_1",
            "status": "completed",
            "action": { "type": "search", "queries": ["current compiler release"] },
        });
        let failed_item = json!({
            "type": "web_search_call",
            "id": "ws_2",
            "status": "failed",
            "action": { "type": "open_page", "url": "https://example.com/unavailable" },
        });
        let prepared = prepare_provider_request(
            &profile,
            &json!({
                "messages": [
                    { "role": "user", "content": "Find the current release." },
                    {
                        "role": "assistant",
                        "content": "The current release is available.",
                        "providerItems": [item.clone(), failed_item.clone()]
                    }
                ],
                "tools": [],
                "hostedTools": [{
                    "type": "webSearch",
                    "providerToolType": "web_search"
                }],
                "requireToolCall": false
            }),
        )
        .expect("Responses request must prepare");
        let body: Value =
            serde_json::from_slice(&prepared.body).expect("Responses body must decode");

        assert_eq!(prepared.kind, ProviderStreamKind::Responses);
        assert!(prepared.hosted_web_search_enabled);
        assert_eq!(body["tools"], json!([{ "type": "web_search" }]));
        assert_eq!(body["input"][1], item);
        assert_eq!(body["input"][2], failed_item);
        assert_eq!(body["input"][3]["role"], "assistant");
        assert_eq!(
            normalize_responses_base_url(&profile),
            "https://api.deepseek.com/responses"
        );
    }

    #[test]
    fn responses_request_replays_ordered_native_items_and_provider_call_identity() {
        let native_items = vec![
            json!({
                "type": "message",
                "id": "msg_intro",
                "role": "assistant",
                "status": "completed",
                "content": [{ "type": "output_text", "text": "I will inspect it." }],
            }),
            json!({
                "type": "web_search_call",
                "id": "ws_1",
                "status": "completed",
                "action": { "type": "search", "queries": ["current compiler release"] },
            }),
            json!({
                "type": "function_call",
                "id": "fc_1",
                "call_id": "provider-call:read",
                "name": "fs_read",
                "arguments": "{\"path\":\"README.md\"}",
                "status": "completed",
            }),
        ];
        let blocks = native_items
            .iter()
            .enumerate()
            .map(
                |(output_index, item)| match item["type"].as_str().unwrap() {
                    "message" => json!({
                        "outputIndex": output_index,
                        "kind": "narrative",
                        "narrativeId": "narrative:intro",
                        "item": item,
                    }),
                    "web_search_call" => json!({
                        "outputIndex": output_index,
                        "kind": "providerHosted",
                        "activityId": "activity:search",
                        "providerCallId": "ws_1",
                        "providerToolType": "web_search",
                        "item": item,
                    }),
                    "function_call" => json!({
                        "outputIndex": output_index,
                        "kind": "toolCall",
                        "callId": "logical-call:read",
                        "providerCallId": "provider-call:read",
                        "toolName": "fs.read",
                        "item": item,
                    }),
                    _ => unreachable!(),
                },
            )
            .collect::<Vec<_>>();
        let prepared = prepare_provider_request(
            &test_profile("responses"),
            &json!({
                "messages": [
                    { "role": "user", "content": "Inspect it." },
                    {
                        "role": "assistant",
                        "content": "",
                        "providerOutputBlocks": blocks,
                    },
                    {
                        "role": "tool",
                        "content": "{\"ok\":true}",
                        "toolCallId": "logical-call:read",
                        "providerCallId": "provider-call:read",
                    }
                ],
                "tools": [],
                "hostedTools": [],
                "requireToolCall": false,
            }),
        )
        .expect("ordered Responses replay must prepare");
        let body: Value = serde_json::from_slice(&prepared.body).unwrap();
        let input = body["input"].as_array().unwrap();

        assert_eq!(&input[1..4], native_items.as_slice());
        assert_eq!(
            input[4],
            json!({
                "type": "function_call_output",
                "call_id": "provider-call:read",
                "output": "{\"ok\":true}",
            })
        );
    }

    #[test]
    fn responses_replays_rejected_raw_arguments_and_result_without_repair() {
        let item = json!({"type":"function_call","call_id":"native:bad","name":"fs_read","arguments":"{\"path\":","status":"completed"});
        let rejection = json!({"status":"inputRejected","executed":false,"error":{"code":"provider_tool_call_arguments_invalid","message":"Invalid JSON object."}}).to_string();
        let prepared = prepare_provider_request(&test_profile("responses"), &json!({
            "messages":[
                {"role":"user","content":"Read source."},
                {"role":"assistant","content":"","providerOutputBlocks":[{
                    "outputIndex":0,"kind":"toolCallRejected","callId":"call:bad","providerCallId":"native:bad","toolName":"fs.read","item":item
                }]},
                {"role":"tool","toolCallId":"call:bad","providerCallId":"native:bad","content":rejection}
            ],"tools":[],"hostedTools":[],"requireToolCall":false
        })).unwrap();
        let body: Value = serde_json::from_slice(&prepared.body).unwrap();
        assert_eq!(body["input"][1], item);
        assert_eq!(
            body["input"][2],
            json!({"type":"function_call_output","call_id":"native:bad","output":rejection})
        );
    }

    #[test]
    fn responses_request_rejects_invalid_hosted_tool_instead_of_rewriting_it() {
        let error = prepare_provider_request(
            &test_profile("responses"),
            &json!({
                "messages": [{ "role": "user", "content": "Search." }],
                "tools": [],
                "hostedTools": [{
                    "type": "webSearch",
                    "providerToolType": "some_other_tool"
                }],
                "requireToolCall": false
            }),
        )
        .expect_err("invalid hosted tool must fail");

        assert_eq!(error.code, "provider_hosted_tool_invalid");
    }

    #[test]
    fn kimi_formula_result_is_replayed_verbatim_only_for_moonshot() {
        let encrypted =
            "----MOONSHOT ENCRYPTED BEGIN----opaque\nbytes----MOONSHOT ENCRYPTED END----";
        let content = json!(
            json!({"recordId":"record:1", "outcome":"completed", "output": {
                "provider":"kimi-formula", "providerContent":encrypted, "responseId":"fiber:1"
            }})
            .to_string()
        );
        assert_eq!(
            provider_tool_content(Some(&content), ProviderThinkingCompatibility::Moonshot),
            encrypted
        );
        assert_eq!(
            provider_tool_content(Some(&content), ProviderThinkingCompatibility::DeepSeek),
            content.as_str().unwrap()
        );
    }

    #[test]
    fn current_provider_templates_preserve_supported_thinking_and_tool_parameters() {
        let tools = vec![LlmToolDefinition {
            name: "web_search".into(),
            description: "Search".into(),
            input_schema: json!({"type":"object"}),
        }];
        let mut kimi = test_profile("openaiCompatible");
        kimi.provider_flavor = Some("moonshot".into());
        kimi.model = "kimi-k3".into();
        kimi.reasoning_effort = Some("max".into());
        kimi.thinking = Some("enabled".into());
        let body = openai_compatible_request_body(&kimi, vec![], &tools, true, true);
        assert!(body.get("thinking").is_none());
        assert_eq!(body["reasoning_effort"], "max");
        assert_eq!(body["tool_choice"], "required");
        kimi.model = "kimi-k2.7-code".into();
        let body = openai_compatible_request_body(&kimi, vec![], &tools, true, true);
        assert_eq!(body["thinking"], json!({"type":"enabled", "keep":"all"}));
        assert!(body.get("reasoning_effort").is_none());
        assert!(body.get("tool_choice").is_none());
        let mut deepseek = test_profile("anthropic");
        deepseek.provider_flavor = Some("deepseek".into());
        deepseek.thinking = Some("enabled".into());
        deepseek.reasoning_effort = Some("high".into());
        let body = anthropic_stream_request_body(&deepseek, vec![], &[], false);
        assert_eq!(body["thinking"], json!({"type":"enabled"}));
        assert_eq!(body["output_config"], json!({"effort":"high"}));
        let glm = openai_compatible_message(
            json!({"role":"assistant", "content":"", "reasoningContent":"reasoning"}),
            ProviderThinkingCompatibility::Glm,
        );
        assert_eq!(glm["reasoning_content"], "reasoning");
    }

    #[tokio::test]
    async fn provider_archive_keeps_raw_stream_wire_request_and_delivered_events() {
        use base64::Engine;
        use std::io::{Read, Write};
        let valid = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"检查\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"完成\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4}}\n\n",
            "data: [DONE]\n\n"
        ).as_bytes().to_vec();
        for (raw, outcome) in [
            (valid, "completed"),
            (b"data: {invalid}\n\n".to_vec(), "failed"),
        ] {
            let directory = std::env::temp_dir().join(format!(
                "deepcode-provider-archive-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let mut profile = test_profile("openaiCompatible");
            profile.base_url = Some(format!("http://{}/v1", listener.local_addr().unwrap()));
            profile.api_key = Some("test-provider-key".into());
            let payload = raw.clone();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                let (start, length) = loop {
                    let count = socket.read(&mut chunk).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|p| p == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        break (end + 4, length);
                    }
                };
                while request.len() < start + length {
                    let count = socket.read(&mut chunk).unwrap();
                    assert_ne!(count, 0);
                    request.extend_from_slice(&chunk[..count]);
                }
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", payload.len()).unwrap();
                // Exercise framing across arbitrary byte boundaries, including UTF-8.
                for bytes in payload.chunks(37) {
                    socket.write_all(bytes).unwrap();
                }
                request[start..start + length].to_vec()
            });
            let response = local_agent_provider_stream_response(
                profile,
                json!({
                    "messages":[{"role":"user","content":"归档检查"}], "tools":[], "hostedTools":[], "requireToolCall":false,
                }),
                "request:archive".into(),
                directory.clone(),
                json!({"sessionId":"session:archive","runId":"run:archive","requestId":"request:archive"}),
            );
            let delivered = axum::body::to_bytes(response.into_body(), 1024 * 1024)
                .await
                .unwrap();
            let wire_request = server.join().unwrap();
            let log = std::fs::read_to_string(directory.join("timeline.jsonl")).unwrap();
            assert!(!log.contains("test-provider-key"));
            let lines: Vec<Value> = log
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            let original: Vec<u8> = lines
                .iter()
                .filter(|line| line["type"] == "response.chunk")
                .flat_map(|line| {
                    base64::engine::general_purpose::STANDARD
                        .decode(line["data"]["base64"].as_str().unwrap())
                        .unwrap()
                })
                .collect();
            assert_eq!(original, raw);
            let request_line = lines
                .iter()
                .find(|line| line["type"] == "request.body")
                .unwrap();
            assert_eq!(
                base64::engine::general_purpose::STANDARD
                    .decode(request_line["data"]["base64"].as_str().unwrap())
                    .unwrap(),
                wire_request
            );
            let replay: String = lines
                .iter()
                .filter(|line| line["type"] == "session.event")
                .map(|line| {
                    provider_event(
                        "request:archive",
                        line["data"]["type"].as_str().unwrap(),
                        line["data"]["data"].clone(),
                    )
                })
                .collect();
            assert_eq!(replay.as_bytes(), delivered.as_ref());
            assert_eq!(lines.last().unwrap()["data"]["outcome"], outcome);
            std::fs::remove_dir_all(directory).unwrap();
        }
    }

    fn test_profile(kind: &str) -> ResolvedLlmProfile {
        ResolvedLlmProfile {
            kind: kind.to_string(),
            provider_flavor: None,
            base_url: None,
            model: "fixture-model".to_string(),
            context_window_tokens: Some(4_096),
            max_output_tokens: Some(512),
            temperature: None,
            reasoning_effort: None,
            thinking: None,
            hosted_web_search: None,
            api_key: None,
        }
    }
}
