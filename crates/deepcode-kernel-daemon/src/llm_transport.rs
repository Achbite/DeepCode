use crate::prelude::*;
use crate::*;
use axum::body::Body;
use bytes::Bytes;
use deepcode_kernel_abi::{LlmProviderDiagnostic, LlmProviderErrorLayer};
use std::convert::Infallible;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedLlmProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) provider_flavor: Option<String>,
    pub(crate) base_url: Option<String>,
    pub(crate) model: String,
    pub(crate) max_output_tokens: Option<u32>,
    pub(crate) temperature: Option<f64>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) thinking: Option<String>,
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
    pub(crate) tool_calls: Vec<LlmToolCall>,
    pub(crate) usage: Option<Value>,
}

const OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS_CAP: u32 = 16_384;

pub(crate) fn llm_profile_is_enabled(config: &Value, profile_id: &str) -> bool {
    config
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        })
        .and_then(|profile| profile.get("enabled"))
        .and_then(Value::as_bool)
        == Some(true)
}

pub(crate) fn preferred_enabled_llm_profile_id(config: &Value) -> Option<String> {
    let profiles = config.get("profiles").and_then(Value::as_array)?;
    if let Some(default_id) = config
        .get("defaultProfileId")
        .and_then(Value::as_str)
        .filter(|profile_id| llm_profile_is_enabled(config, profile_id))
    {
        return Some(default_id.to_string());
    }
    profiles.iter().find_map(|profile| {
        if profile.get("enabled").and_then(Value::as_bool) != Some(true) {
            return None;
        }
        profile
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
    })
}

pub(crate) fn resolve_llm_profile(
    gui: &GuiState,
    profile_id: Option<&str>,
) -> Result<ResolvedLlmProfile, String> {
    let default_id = gui
        .llm_profiles
        .get("defaultProfileId")
        .and_then(Value::as_str);
    let selected_id = profile_id.or(default_id);
    let profiles = gui
        .llm_profiles
        .get("profiles")
        .and_then(Value::as_array)
        .ok_or_else(|| "LLM profiles are missing".to_string())?;
    let profile = selected_id
        .and_then(|id| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(id))
        })
        .or_else(|| {
            profiles.iter().find(|profile| {
                profile
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
        })
        .ok_or_else(|| "No enabled LLM profile is configured".to_string())?;

    if !profile
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        return Err("Selected LLM profile is disabled".to_string());
    }

    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("profile")
        .to_string();
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("openaiCompatible")
        .to_string();
    let secret_store = read_json_file(&gui.paths.llm_secrets_path).unwrap_or_else(|| json!({}));
    let secret_key = profile
        .get("secretRef")
        .and_then(Value::as_str)
        .and_then(|value| value.strip_prefix("local-secret:").map(str::to_string))
        .unwrap_or_else(|| id.clone());
    let api_key = secret_store
        .get(&secret_key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| std::env::var("DEEPCODE_LLM_API_KEY").ok());

    Ok(ResolvedLlmProfile {
        id: id.clone(),
        name: profile
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string(),
        kind,
        provider_flavor: profile
            .get("providerFlavor")
            .or_else(|| profile.get("provider_flavor"))
            .and_then(Value::as_str)
            .map(str::to_string),
        base_url: profile
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: profile
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        max_output_tokens: profile
            .get("maxOutputTokens")
            .or_else(|| profile.get("maxTokens"))
            .and_then(token_limit_u32),
        temperature: profile.get("temperature").and_then(Value::as_f64),
        reasoning_effort: profile
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string),
        thinking: profile
            .get("thinking")
            .and_then(Value::as_str)
            .map(str::to_string),
        api_key,
    })
}

pub(crate) async fn call_llm_profile(
    profile: &ResolvedLlmProfile,
    request_envelope: Value,
) -> Result<LlmChatOutput, LlmProviderDiagnostic> {
    let messages = request_envelope
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = request_envelope
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .map(provider_tools_from_values)
        .unwrap_or_default();
    let response_format = request_envelope
        .get("responseFormat")
        .or_else(|| request_envelope.get("response_format"))
        .cloned();
    match profile.kind.as_str() {
        "anthropic" => call_anthropic_profile(profile, messages, tools).await,
        "ollama" => call_ollama_profile(profile, messages, tools).await,
        "openaiCompatible" => {
            call_openai_compatible_profile(profile, messages, tools, response_format.as_ref()).await
        }
        other => Err(provider_local_error(
            profile,
            other,
            "ProviderUnsupportedKind",
            LlmProviderErrorLayer::Transport,
            format!("Unsupported LLM provider kind: {other}"),
        )),
    }
}

pub(crate) async fn call_openai_compatible_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
    response_format: Option<&Value>,
) -> Result<LlmChatOutput, LlmProviderDiagnostic> {
    let api_key = profile.api_key.as_deref().ok_or_else(|| {
        provider_local_error(
            profile,
            "openaiCompatible",
            "ProviderProfileMissingApiKey",
            LlmProviderErrorLayer::Transport,
            format!("LLM profile `{}` has no API key", profile.name),
        )
    })?;
    let url = normalize_openai_base_url(profile);
    let body = openai_compatible_request_body(profile, messages, &tools, response_format, false);
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            provider_transport_error(
                profile,
                "openaiCompatible",
                "request_failed",
                error.to_string(),
            )
        })?;
    let response = read_provider_json_response(
        profile,
        "openaiCompatible",
        response,
        "openai.chat.completion.v1: choices[0].message",
        false,
    )
    .await?;
    let choice = openai_message(&response).ok_or_else(|| {
        provider_schema_error(
            profile,
            "openaiCompatible",
            &response,
            "OpenAI-compatible response must contain choices[0].message object",
        )
    })?;
    let mut output = parse_openai_message(choice);
    output.usage = response.value.get("usage").cloned();
    Ok(output)
}

pub(crate) fn openai_compatible_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
    response_format: Option<&Value>,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": profile.model,
        "messages": openai_compatible_messages(messages),
        "stream": stream
    });
    if let Some(tokens) = effective_openai_compatible_max_tokens(profile) {
        body["max_tokens"] = json!(tokens);
    }
    if should_send_sampling(profile) {
        if let Some(temperature) = profile.temperature {
            body["temperature"] = json!(temperature);
        }
    }
    if let Some(effort) = profile.reasoning_effort.as_ref() {
        body["reasoning_effort"] = json!(effort);
    }
    if let Some(thinking) = profile.thinking.as_ref() {
        body["thinking"] = json!({ "type": thinking });
    }
    if response_format_is_json_object(response_format) {
        body["response_format"] = json!({ "type": "json_object" });
    }
    if is_deepseek_profile(profile) {
        body["user_id"] = json!("deepcode_local");
        if stream {
            body["stream_options"] = json!({ "include_usage": true });
        }
    }
    if is_zhipu_profile(profile) && stream && !tools.is_empty() {
        body["tool_stream"] = json!(true);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": provider_tool_name(&tool.name),
                    "description": tool.description,
                    "parameters": tool.input_schema
                }
            }))
            .collect::<Vec<_>>());
    }
    body
}

fn openai_compatible_messages(messages: Vec<Value>) -> Vec<Value> {
    messages
        .into_iter()
        .map(openai_compatible_message)
        .collect()
}

fn openai_compatible_message(message: Value) -> Value {
    let Some(record) = message.as_object() else {
        return message;
    };
    let role = record.get("role").and_then(Value::as_str).unwrap_or("user");
    match role {
        "assistant" => openai_compatible_assistant_message(record),
        "tool" => openai_compatible_tool_message(record),
        "system" | "user" => json!({
            "role": role,
            "content": message_content_string(record.get("content"))
        }),
        _ => json!({
            "role": role,
            "content": message_content_string(record.get("content"))
        }),
    }
}

fn openai_compatible_assistant_message(record: &serde_json::Map<String, Value>) -> Value {
    let mut message = json!({
        "role": "assistant",
        "content": message_content_string(record.get("content"))
    });
    let tool_calls = record
        .get("tool_calls")
        .or_else(|| record.get("toolCalls"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(openai_compatible_tool_call)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    message
}

fn openai_compatible_tool_message(record: &serde_json::Map<String, Value>) -> Value {
    let tool_call_id = record
        .get("tool_call_id")
        .or_else(|| record.get("toolCallId"))
        .and_then(Value::as_str)
        .unwrap_or("tool-call");
    json!({
        "role": "tool",
        "tool_call_id": tool_call_id,
        "content": message_content_string(record.get("content"))
    })
}

fn openai_compatible_tool_call(value: &Value) -> Option<Value> {
    let record = value.as_object()?;
    let function = record.get("function").and_then(Value::as_object);
    let name = function
        .and_then(|item| item.get("name"))
        .or_else(|| record.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("tool");
    let arguments = function
        .and_then(|item| item.get("arguments"))
        .or_else(|| record.get("arguments"));
    Some(json!({
        "id": record
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("tool-call"),
        "type": "function",
        "function": {
            "name": provider_tool_name(name),
            "arguments": tool_arguments_string(arguments)
        }
    }))
}

fn message_content_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn tool_arguments_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    }
}

pub(crate) fn llm_stream_response(
    profile: ResolvedLlmProfile,
    request_envelope: Value,
) -> Response {
    let stream = async_stream::stream! {
        if profile.kind.as_str() != "openaiCompatible" {
            yield Ok::<Bytes, Infallible>(Bytes::from(sse_json_event(
                "provider_error",
                json!({
                    "type": "provider_error",
                    "error": format!("Streaming is only implemented for openaiCompatible profiles, got {}", profile.kind),
                }),
            )));
            return;
        }

        yield Ok::<Bytes, Infallible>(Bytes::from(sse_json_event(
            "provider_metadata",
            json!({
                "type": "provider_metadata",
                "providerProfileId": profile.id,
                "provider": profile.provider_flavor.as_deref().unwrap_or(profile.kind.as_str()),
                "model": profile.model,
            }),
        )));

        let messages = request_envelope
            .get("messages")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let tools = request_envelope
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .map(provider_tools_from_values)
            .unwrap_or_default();
        let response_format = request_envelope
            .get("responseFormat")
            .or_else(|| request_envelope.get("response_format"))
            .cloned();
        let Some(api_key) = profile.api_key.clone() else {
            yield Ok(Bytes::from(sse_json_event(
                "provider_error",
                json!({
                    "type": "provider_error",
                    "error": format!("LLM profile `{}` has no API key", profile.name),
                }),
            )));
            return;
        };
        let body = openai_compatible_request_body(&profile, messages, &tools, response_format.as_ref(), true);
        let response = match reqwest::Client::new()
            .post(normalize_openai_base_url(&profile))
            .bearer_auth(api_key)
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                yield Ok(Bytes::from(sse_json_event(
                    "provider_error",
                    json!({ "type": "provider_error", "error": error.to_string() }),
                )));
                return;
            }
        };
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("unknown")
            .to_string();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            yield Ok(Bytes::from(sse_json_event(
                "provider_error",
                json!({
                    "type": "provider_error",
                    "error": format!("LLM provider returned HTTP {}", status.as_u16()),
                    "rawProvider": {
                        "status": status.as_u16(),
                        "contentType": content_type,
                        "bodyPreview": provider_body_preview(&body),
                    },
                }),
            )));
            return;
        }

        let mut parser = SseDataParser::default();
        let mut accumulator = OpenAiCompatibleStreamAccumulator::default();
        let mut response = response;
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let text = String::from_utf8_lossy(&chunk);
                    for data in parser.push(&text) {
                        for event in openai_stream_events_from_data(&mut accumulator, &data) {
                            yield Ok(Bytes::from(event));
                        }
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    yield Ok(Bytes::from(sse_json_event(
                        "provider_error",
                        json!({ "type": "provider_error", "error": error.to_string() }),
                    )));
                    return;
                }
            }
        }
        for data in parser.finish() {
            for event in openai_stream_events_from_data(&mut accumulator, &data) {
                yield Ok(Bytes::from(event));
            }
        }
        if !accumulator.done_emitted {
            yield Ok(Bytes::from(sse_json_event(
                "provider_done",
                json!({
                    "type": "provider_done",
                    "chunk": {
                        "type": "done",
                        "usage": accumulator.usage,
                    },
                    "usage": accumulator.usage,
                }),
            )));
        }
    };

    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| Response::new(Body::from("event: provider_error\ndata: {\"type\":\"provider_error\",\"error\":\"failed to build stream response\"}\n\n")))
}

fn response_format_is_json_object(response_format: Option<&Value>) -> bool {
    response_format
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        == Some("json_object")
}

pub(crate) fn effective_openai_compatible_max_tokens(profile: &ResolvedLlmProfile) -> Option<u32> {
    profile
        .max_output_tokens
        .filter(|tokens| *tokens > 0)
        .map(|tokens| tokens.min(OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS_CAP))
}

fn token_limit_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|raw| u32::try_from(raw).ok())
        .or_else(|| {
            value
                .as_i64()
                .filter(|raw| *raw > 0)
                .and_then(|raw| u32::try_from(raw).ok())
        })
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

fn should_send_sampling(profile: &ResolvedLlmProfile) -> bool {
    !profile.model.to_ascii_lowercase().contains("deepseek")
}

fn is_deepseek_profile(profile: &ResolvedLlmProfile) -> bool {
    if profile
        .provider_flavor
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("deepseek"))
        .unwrap_or(false)
    {
        return true;
    }
    let base_url = profile.base_url.as_deref().unwrap_or_default();
    profile.model.to_ascii_lowercase().contains("deepseek")
        || base_url.to_ascii_lowercase().contains("deepseek")
}

fn is_zhipu_profile(profile: &ResolvedLlmProfile) -> bool {
    if profile
        .provider_flavor
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("zhipu"))
        .unwrap_or(false)
    {
        return true;
    }
    let base_url = profile.base_url.as_deref().unwrap_or_default();
    let model = profile.model.to_ascii_lowercase();
    let base = base_url.to_ascii_lowercase();
    model.contains("glm")
        || model.contains("zhipu")
        || base.contains("bigmodel")
        || base.contains("zhipu")
}

pub(crate) fn provider_tool_name(name: &str) -> String {
    name.replace('.', "__")
}

pub(crate) fn internal_tool_name(name: &str) -> String {
    name.replace("__", ".")
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
#[path = "llm_transport_tests.rs"]
mod tests;
