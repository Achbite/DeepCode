#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;
use axum::body::Body;
use bytes::Bytes;
use deepcode_kernel_abi::{LlmProviderDiagnostic, LlmProviderErrorLayer};
use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::convert::Infallible;
use std::hash::{Hash, Hasher};

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

pub(crate) fn resolve_kernel_llm_profile(
    state: &AppState,
    profile_ref: Option<&deepcode_kernel_abi::ProfileRef>,
) -> Result<ResolvedLlmProfile, String> {
    let gui = state.gui.lock().expect("gui state lock");
    resolve_llm_profile(&gui, profile_ref.map(|value| value.id.as_str()))
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
    let choice = require_openai_message(profile, "openaiCompatible", &response)?;
    let mut output = parse_openai_message(choice);
    output.usage = response.value.get("usage").cloned();
    Ok(output)
}

fn openai_compatible_request_body(
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
    let role = record
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("user");
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

pub(crate) fn llm_stream_response(profile: ResolvedLlmProfile, request_envelope: Value) -> Response {
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

fn normalize_anthropic_base_url(profile: &ResolvedLlmProfile) -> String {
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

fn normalize_ollama_base_url(profile: &ResolvedLlmProfile) -> String {
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
    model.contains("glm") || model.contains("zhipu") || base.contains("bigmodel") || base.contains("zhipu")
}

fn provider_tool_name(name: &str) -> String {
    name.replace('.', "__")
}

fn internal_tool_name(name: &str) -> String {
    name.replace("__", ".")
}

fn split_system_messages(messages: Vec<Value>) -> (String, Vec<Value>) {
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

pub(crate) async fn call_anthropic_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, LlmProviderDiagnostic> {
    let api_key = profile.api_key.as_deref().ok_or_else(|| {
        provider_local_error(
            profile,
            "anthropic",
            "ProviderProfileMissingApiKey",
            LlmProviderErrorLayer::Transport,
            format!("LLM profile `{}` has no API key", profile.name),
        )
    })?;
    let (system, chat_messages) = split_system_messages(messages);
    let mut body = json!({
        "model": profile.model,
        "messages": chat_messages,
        "max_tokens": profile.max_output_tokens.unwrap_or(4096)
    });
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = json!(tools
            .iter()
            .map(|tool| json!({
                "name": provider_tool_name(&tool.name),
                "description": tool.description,
                "input_schema": tool.input_schema
            }))
            .collect::<Vec<_>>());
    }
    let response = reqwest::Client::new()
        .post(normalize_anthropic_base_url(profile))
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            provider_transport_error(profile, "anthropic", "request_failed", error.to_string())
        })?;
    let response = read_provider_json_response(
        profile,
        "anthropic",
        response,
        "anthropic.messages.v1: content[]",
        false,
    )
    .await?;
    require_anthropic_message(profile, "anthropic", &response)?;
    Ok(parse_anthropic_message(&response.value))
}

pub(crate) async fn call_ollama_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, LlmProviderDiagnostic> {
    let mut body = json!({
        "model": profile.model,
        "messages": messages,
        "stream": false
    });
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
    let response = reqwest::Client::new()
        .post(normalize_ollama_base_url(profile))
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            provider_transport_error(profile, "ollama", "request_failed", error.to_string())
        })?;
    let response = read_provider_json_response(
        profile,
        "ollama",
        response,
        "ollama.chat.v1: message",
        false,
    )
    .await?;
    let message = require_ollama_message(profile, "ollama", &response)?;
    Ok(parse_openai_message(message))
}

#[derive(Debug, Clone)]
struct ProviderJsonResponse {
    value: Value,
    status: Option<u16>,
    content_type: String,
    body: String,
    body_hash: String,
    is_stream: bool,
    expected_schema: String,
}

async fn read_provider_json_response(
    profile: &ResolvedLlmProfile,
    provider: &str,
    response: reqwest::Response,
    expected_schema: &str,
    is_stream: bool,
) -> Result<ProviderJsonResponse, LlmProviderDiagnostic> {
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("unknown")
        .to_string();
    let body = response.text().await.map_err(|error| {
        provider_response_diagnostic(
            profile,
            provider,
            "ProviderResponseReadFailed",
            LlmProviderErrorLayer::Transport,
            None,
            Some(&content_type),
            "",
            None,
            is_stream,
            expected_schema,
            error.to_string(),
        )
    })?;
    let body_hash = provider_body_hash(&body);
    if !status.is_success() {
        return Err(provider_response_diagnostic(
            profile,
            provider,
            "ProviderHttpStatusFailed",
            LlmProviderErrorLayer::HttpStatus,
            Some(status.as_u16()),
            Some(&content_type),
            &body,
            Some(body_hash.as_str()),
            is_stream,
            expected_schema,
            format!("LLM provider returned HTTP {}", status.as_u16()),
        ));
    }
    let value = serde_json::from_str::<Value>(&body).map_err(|error| {
        provider_response_error(
            profile,
            provider,
            "ProviderJsonDecodeFailed",
            LlmProviderErrorLayer::JsonDecode,
            Some(status.as_u16()),
            Some(&content_type),
            &body,
            Some(body_hash.as_str()),
            is_stream,
            expected_schema,
            error.to_string(),
        )
    })?;
    Ok(ProviderJsonResponse {
        value,
        status: Some(status.as_u16()),
        content_type,
        body,
        body_hash,
        is_stream,
        expected_schema: expected_schema.to_string(),
    })
}

fn provider_transport_error(
    profile: &ResolvedLlmProfile,
    provider: &str,
    reason: &str,
    message: String,
) -> LlmProviderDiagnostic {
    let reason = match reason {
        "request_failed" => "ProviderTransportFailed",
        "response_read_failed" => "ProviderResponseReadFailed",
        other => other,
    };
    provider_response_diagnostic(
        profile,
        provider,
        reason,
        LlmProviderErrorLayer::Transport,
        None,
        None,
        "",
        None,
        false,
        "provider.transport",
        message,
    )
}

fn provider_response_error(
    profile: &ResolvedLlmProfile,
    provider: &str,
    reason: &str,
    error_layer: LlmProviderErrorLayer,
    status: Option<u16>,
    content_type: Option<&str>,
    body: &str,
    body_hash: Option<&str>,
    is_stream: bool,
    expected_schema: &str,
    message: String,
) -> LlmProviderDiagnostic {
    provider_response_diagnostic(
        profile,
        provider,
        reason,
        error_layer,
        status,
        content_type,
        body,
        body_hash,
        is_stream,
        expected_schema,
        message,
    )
}

fn provider_response_diagnostic(
    profile: &ResolvedLlmProfile,
    provider: &str,
    reason: &str,
    error_layer: LlmProviderErrorLayer,
    status: Option<u16>,
    content_type: Option<&str>,
    body: &str,
    body_hash: Option<&str>,
    is_stream: bool,
    expected_schema: &str,
    message: String,
) -> LlmProviderDiagnostic {
    LlmProviderDiagnostic {
        reason: reason.to_string(),
        error_layer,
        message,
        provider: provider.to_string(),
        profile_id: profile.id.clone(),
        profile_name: profile.name.clone(),
        model: profile.model.clone(),
        status,
        content_type: content_type.unwrap_or("unknown").to_string(),
        is_stream,
        body_preview: provider_body_preview(body),
        body_hash: body_hash.map(str::to_string),
        expected_schema: expected_schema.to_string(),
    }
}

fn provider_local_error(
    profile: &ResolvedLlmProfile,
    provider: &str,
    reason: &str,
    error_layer: LlmProviderErrorLayer,
    message: String,
) -> LlmProviderDiagnostic {
    provider_response_diagnostic(
        profile,
        provider,
        reason,
        error_layer,
        None,
        None,
        "",
        None,
        false,
        "provider.local.config",
        message,
    )
}

fn provider_body_hash(body: &str) -> String {
    let mut hasher = DefaultHasher::new();
    body.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn provider_body_preview(body: &str) -> String {
    let mut preview = String::new();
    for line in body.lines() {
        let lower = line.to_ascii_lowercase();
        if lower.contains("authorization")
            || lower.contains("api_key")
            || lower.contains("apikey")
            || lower.contains("secret")
            || lower.contains("password")
            || lower.contains("token")
        {
            preview.push_str("[redacted-provider-error-line]\n");
        } else {
            preview.push_str(line);
            preview.push('\n');
        }
        if preview.chars().count() >= 1600 {
            break;
        }
    }
    if preview.is_empty() {
        return String::new();
    }
    let clipped = preview.chars().take(1600).collect::<String>();
    clipped.trim_end().to_string()
}

fn require_openai_message<'a>(
    profile: &ResolvedLlmProfile,
    provider: &str,
    response: &'a ProviderJsonResponse,
) -> Result<&'a Value, LlmProviderDiagnostic> {
    response
        .value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .filter(|message| message.is_object())
        .ok_or_else(|| {
            provider_schema_error(
                profile,
                provider,
                response,
                "OpenAI-compatible response must contain choices[0].message object",
            )
        })
}

fn require_anthropic_message(
    profile: &ResolvedLlmProfile,
    provider: &str,
    response: &ProviderJsonResponse,
) -> Result<(), LlmProviderDiagnostic> {
    response
        .value
        .get("content")
        .and_then(Value::as_array)
        .map(|_| ())
        .ok_or_else(|| {
            provider_schema_error(
                profile,
                provider,
                response,
                "Anthropic response must contain content array",
            )
        })
}

fn require_ollama_message<'a>(
    profile: &ResolvedLlmProfile,
    provider: &str,
    response: &'a ProviderJsonResponse,
) -> Result<&'a Value, LlmProviderDiagnostic> {
    response
        .value
        .get("message")
        .filter(|message| message.is_object())
        .ok_or_else(|| {
            provider_schema_error(
                profile,
                provider,
                response,
                "Ollama response must contain message object",
            )
        })
}

fn provider_schema_error(
    profile: &ResolvedLlmProfile,
    provider: &str,
    response: &ProviderJsonResponse,
    message: &str,
) -> LlmProviderDiagnostic {
    provider_response_error(
        profile,
        provider,
        "ProviderSchemaDecodeFailed",
        LlmProviderErrorLayer::SchemaDecode,
        response.status,
        Some(&response.content_type),
        &response.body,
        Some(&response.body_hash),
        response.is_stream,
        &response.expected_schema,
        message.to_string(),
    )
}

#[derive(Debug, Default)]
struct SseDataParser {
    buffer: String,
}

impl SseDataParser {
    fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        self.drain_complete_events()
    }

    fn finish(&mut self) -> Vec<String> {
        let mut events = self.drain_complete_events();
        if !self.buffer.trim().is_empty() {
            events.extend(parse_sse_event(&self.buffer));
            self.buffer.clear();
        }
        events
    }

    fn drain_complete_events(&mut self) -> Vec<String> {
        let mut events = Vec::new();
        while let Some(index) = self.buffer.find("\n\n") {
            let raw = self.buffer[..index].to_string();
            self.buffer = self.buffer[index + 2..].to_string();
            events.extend(parse_sse_event(&raw));
        }
        events
    }
}

fn parse_sse_event(raw: &str) -> Vec<String> {
    let mut data_lines = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start().to_string());
        }
    }
    if data_lines.is_empty() {
        Vec::new()
    } else {
        vec![data_lines.join("\n")]
    }
}

#[derive(Debug, Clone, Default)]
struct ToolCallDeltaBuffer {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

#[derive(Debug, Default)]
struct OpenAiCompatibleStreamAccumulator {
    content: String,
    reasoning: String,
    tool_calls: BTreeMap<i64, ToolCallDeltaBuffer>,
    usage: Option<Value>,
    done_emitted: bool,
}

impl OpenAiCompatibleStreamAccumulator {
    fn output(&self) -> LlmChatOutput {
        let tool_calls = self
            .tool_calls
            .iter()
            .filter_map(|(index, buffer)| {
                let name = buffer.name.clone()?;
                let arguments = if buffer.arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&buffer.arguments).unwrap_or_else(|_| {
                        json!({ "rawArguments": buffer.arguments })
                    })
                };
                Some(LlmToolCall {
                    id: buffer
                        .id
                        .clone()
                        .unwrap_or_else(|| format!("tool-call-{index}")),
                    name: internal_tool_name(&name),
                    arguments,
                })
            })
            .collect::<Vec<_>>();
        LlmChatOutput {
            content: self.content.clone(),
            reasoning: (!self.reasoning.is_empty()).then(|| self.reasoning.clone()),
            tool_calls,
            usage: self.usage.clone(),
        }
    }
}

pub(crate) fn parse_openai_compatible_sse_text(text: &str) -> LlmChatOutput {
    let mut parser = SseDataParser::default();
    let mut accumulator = OpenAiCompatibleStreamAccumulator::default();
    for data in parser.push(text).into_iter().chain(parser.finish()) {
        let _ = openai_stream_events_from_data(&mut accumulator, &data);
    }
    accumulator.output()
}

fn openai_stream_events_from_data(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    data: &str,
) -> Vec<String> {
    if data.trim() == "[DONE]" {
        accumulator.done_emitted = true;
        return vec![sse_json_event(
            "provider_done",
            json!({
                "type": "provider_done",
                "chunk": {
                    "type": "done",
                    "usage": accumulator.usage,
                },
                "usage": accumulator.usage,
            }),
        )];
    }
    let value = match serde_json::from_str::<Value>(data) {
        Ok(value) => value,
        Err(error) => {
            return vec![sse_json_event(
                "provider_error",
                json!({
                    "type": "provider_error",
                    "error": error.to_string(),
                    "rawProvider": data,
                }),
            )];
        }
    };
    openai_stream_events_from_value(accumulator, value)
}

fn openai_stream_events_from_value(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    value: Value,
) -> Vec<String> {
    let mut events = Vec::new();
    if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()).cloned() {
        accumulator.usage = Some(usage.clone());
        events.push(sse_json_event(
            "provider_usage",
            json!({
                "type": "provider_usage",
                "usage": usage,
                "chunk": {
                    "type": "done",
                    "usage": usage,
                },
            }),
        ));
    }
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for choice in choices {
        let index = choice.get("index").and_then(Value::as_i64).unwrap_or(0);
        let finish_reason = choice.get("finish_reason").and_then(Value::as_str).map(str::to_string);
        let delta = choice.get("delta").cloned().unwrap_or_else(|| json!({}));
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            accumulator.reasoning.push_str(reasoning);
            events.push(sse_json_event(
                "provider_reasoning_delta",
                json!({
                    "type": "provider_reasoning_delta",
                    "chunk": {
                        "type": "reasoning_delta",
                        "content": reasoning,
                        "index": index,
                        "finishReason": finish_reason,
                        "rawProvider": choice.clone(),
                    },
                }),
            ));
        }
        if let Some(content) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            accumulator.content.push_str(content);
            events.push(sse_json_event(
                "provider_delta",
                json!({
                    "type": "provider_delta",
                    "chunk": {
                        "type": "delta",
                        "content": content,
                        "index": index,
                        "finishReason": finish_reason,
                        "rawProvider": choice.clone(),
                    },
                }),
            ));
        }
        for tool_call in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let tool_index = tool_call
                .get("index")
                .and_then(Value::as_i64)
                .unwrap_or(index);
            let buffer = accumulator.tool_calls.entry(tool_index).or_default();
            if let Some(id) = tool_call.get("id").and_then(Value::as_str) {
                buffer.id = Some(id.to_string());
            }
            let function = tool_call.get("function").cloned().unwrap_or_else(|| json!({}));
            if let Some(name) = function.get("name").and_then(Value::as_str).filter(|value| !value.is_empty()) {
                buffer.name = Some(name.to_string());
            }
            let arguments_delta = function
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !arguments_delta.is_empty() {
                buffer.arguments.push_str(&arguments_delta);
            }
            events.push(sse_json_event(
                "provider_tool_call_delta",
                json!({
                    "type": "provider_tool_call_delta",
                    "chunk": {
                        "type": "tool_call",
                        "index": tool_index,
                        "callId": buffer.id.clone(),
                        "finishReason": finish_reason,
                        "toolCallDelta": {
                            "id": buffer.id.clone(),
                            "index": tool_index,
                            "name": buffer.name.clone(),
                            "argumentsDelta": arguments_delta,
                        },
                        "rawProvider": tool_call.clone(),
                    },
                }),
            ));
        }
    }
    events
}

fn sse_json_event(event: &str, value: Value) -> String {
    let data = serde_json::to_string(&value).unwrap_or_else(|_| {
        "{\"type\":\"provider_error\",\"error\":\"failed to serialize stream event\"}".to_string()
    });
    format!("event: {event}\ndata: {data}\n\n")
}

pub(crate) fn parse_openai_message(message: &Value) -> LlmChatOutput {
    let content = message
        .get("content")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let reasoning = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let function = item.get("function")?;
                    let provider_name = function.get("name").and_then(Value::as_str)?;
                    let args = function
                        .get("arguments")
                        .and_then(Value::as_str)
                        .and_then(|raw| serde_json::from_str(raw).ok())
                        .or_else(|| function.get("arguments").cloned())
                        .unwrap_or_else(|| json!({}));
                    Some(LlmToolCall {
                        id: item
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("tool-call")
                            .to_string(),
                        name: internal_tool_name(provider_name),
                        arguments: args,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    LlmChatOutput {
        content,
        reasoning,
        tool_calls,
        usage: None,
    }
}

pub(crate) fn parse_anthropic_message(value: &Value) -> LlmChatOutput {
    let mut content = Vec::new();
    let mut tool_calls = Vec::new();
    for item in value
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    content.push(text.to_string());
                }
            }
            "tool_use" => {
                let name = item.get("name").and_then(Value::as_str).unwrap_or("tool");
                tool_calls.push(LlmToolCall {
                    id: item
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("tool-call")
                        .to_string(),
                    name: internal_tool_name(name),
                    arguments: item.get("input").cloned().unwrap_or_else(|| json!({})),
                });
            }
            _ => {}
        }
    }
    LlmChatOutput {
        content: content.join("\n"),
        reasoning: None,
        tool_calls,
        usage: None,
    }
}

pub(crate) fn llm_output_payload(output: LlmChatOutput) -> Value {
    let usage = output.usage.clone();
    let mut chunks = Vec::new();
    if let Some(reasoning) = output.reasoning.as_ref().filter(|value| !value.is_empty()) {
        chunks.push(json!({ "type": "reasoning_delta", "content": reasoning }));
    }
    if !output.content.is_empty() {
        chunks.push(json!({ "type": "delta", "content": output.content }));
    }
    for call in &output.tool_calls {
        chunks.push(json!({
            "type": "tool_call",
            "toolCall": {
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments
            }
        }));
    }
    chunks.push(json!({ "type": "done" }));
    let mut payload = json!({
        "chunks": chunks,
        "assistantMessage": {
            "role": "assistant",
            "content": output.content,
            "reasoningContent": output.reasoning,
            "toolCalls": output.tool_calls.into_iter().map(|call| json!({
                "id": call.id,
                "name": call.name,
                "arguments": call.arguments
            })).collect::<Vec<_>>()
        }
    });
    if let Some(usage) = usage {
        payload["usage"] = usage;
    }
    payload
}

pub(crate) fn provider_tools_from_values(values: Vec<Value>) -> Vec<LlmToolDefinition> {
    values
        .into_iter()
        .filter_map(|value| {
            Some(LlmToolDefinition {
                name: value.get("name").and_then(Value::as_str)?.to_string(),
                description: value
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or("DeepCode tool")
                    .to_string(),
                input_schema: value
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" })),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_profile() -> ResolvedLlmProfile {
        ResolvedLlmProfile {
            id: "profile-1".to_string(),
            name: "DeepSeek V4 Pro".to_string(),
            kind: "openaiCompatible".to_string(),
            provider_flavor: Some("deepseek".to_string()),
            base_url: Some("https://api.example.test/v1".to_string()),
            model: "deepseek-v4-pro".to_string(),
            max_output_tokens: Some(1024),
            temperature: None,
            reasoning_effort: None,
            thinking: None,
            api_key: Some("secret".to_string()),
        }
    }

    #[test]
    fn provider_json_decode_diagnostic_keeps_raw_response_context() {
        let diagnostic = provider_response_error(
            &test_profile(),
            "openaiCompatible",
            "ProviderJsonDecodeFailed",
            LlmProviderErrorLayer::JsonDecode,
            Some(200),
            Some("text/html"),
            "token: should-not-leak\n<html>bad gateway</html>",
            Some("abc123"),
            false,
            "openai.chat.completion.v1: choices[0].message",
            "expected value at line 1 column 1".to_string(),
        );

        assert_eq!(diagnostic.reason, "ProviderJsonDecodeFailed");
        assert_eq!(diagnostic.status, Some(200));
        assert_eq!(diagnostic.content_type, "text/html");
        assert!(!diagnostic.is_stream);
        assert_eq!(
            diagnostic.expected_schema,
            "openai.chat.completion.v1: choices[0].message"
        );
        assert!(diagnostic
            .body_preview
            .contains("[redacted-provider-error-line]"));
        assert!(!diagnostic.body_preview.contains("should-not-leak"));
        let archive_text = diagnostic.archive_text();
        assert!(archive_text.contains("ProviderJsonDecodeFailed:"));
        assert!(archive_text.contains("content_type = text/html"));
        assert!(archive_text.contains("expected_schema = openai.chat.completion.v1"));
    }

    #[test]
    fn openai_request_body_clamps_excessive_max_tokens() {
        let mut profile = test_profile();
        profile.max_output_tokens = Some(384_000);

        let body = openai_compatible_request_body(
            &profile,
            vec![json!({ "role": "user", "content": "hello" })],
            &[],
            None,
            false,
        );

        assert_eq!(
            body["max_tokens"].as_u64(),
            Some(OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS_CAP as u64)
        );
    }

    #[test]
    fn openai_request_body_keeps_configured_max_tokens_under_cap() {
        let mut profile = test_profile();
        profile.max_output_tokens = Some(2048);

        let body = openai_compatible_request_body(
            &profile,
            vec![json!({ "role": "user", "content": "hello" })],
            &[],
            None,
            false,
        );

        assert_eq!(body["max_tokens"].as_u64(), Some(2048));
    }

    #[test]
    fn openai_request_body_preserves_json_response_format() {
        let body = openai_compatible_request_body(
            &test_profile(),
            vec![json!({ "role": "user", "content": "hello" })],
            &[],
            Some(&json!({ "type": "json_object" })),
            false,
        );

        assert_eq!(
            body["response_format"]["type"].as_str(),
            Some("json_object")
        );
    }

    #[test]
    fn deepseek_stream_request_includes_usage_options() {
        let body = openai_compatible_request_body(
            &test_profile(),
            vec![json!({ "role": "user", "content": "hello" })],
            &[],
            None,
            true,
        );

        assert_eq!(body["stream"].as_bool(), Some(true));
        assert_eq!(
            body["stream_options"]["include_usage"].as_bool(),
            Some(true)
        );
    }

    #[test]
    fn zhipu_stream_request_enables_tool_stream_for_tools() {
        let mut profile = test_profile();
        profile.name = "Zhipu GLM".to_string();
        profile.provider_flavor = Some("zhipu".to_string());
        profile.base_url = Some("https://open.bigmodel.cn/api/paas/v4".to_string());
        profile.model = "glm-4.5".to_string();
        let tools = vec![LlmToolDefinition {
            name: "fs.read".to_string(),
            description: "Read a generic file.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": { "path": { "type": "string" } }
            }),
        }];

        let body = openai_compatible_request_body(
            &profile,
            vec![json!({ "role": "user", "content": "hello" })],
            &tools,
            None,
            true,
        );

        assert_eq!(body["stream"].as_bool(), Some(true));
        assert_eq!(body["tool_stream"].as_bool(), Some(true));
        assert_eq!(
            body["tools"][0]["function"]["name"].as_str(),
            Some("fs__read")
        );
    }

    #[test]
    fn openai_request_body_normalizes_internal_tool_messages() {
        let body = openai_compatible_request_body(
            &test_profile(),
            vec![
                json!({
                    "role": "assistant",
                    "content": "",
                    "toolCalls": [{
                        "id": "call-generic",
                        "name": "fs.read",
                        "arguments": { "path": "generic.txt" }
                    }]
                }),
                json!({
                    "role": "tool",
                    "toolCallId": "call-generic",
                    "content": { "ok": true }
                }),
            ],
            &[],
            None,
            true,
        );

        let assistant = &body["messages"][0];
        assert!(assistant.get("toolCalls").is_none());
        assert_eq!(
            assistant["tool_calls"][0]["function"]["name"].as_str(),
            Some("fs__read")
        );
        let arguments = assistant["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap();
        let parsed: Value = serde_json::from_str(arguments).unwrap();
        assert_eq!(parsed["path"].as_str(), Some("generic.txt"));

        let tool = &body["messages"][1];
        assert!(tool.get("toolCallId").is_none());
        assert_eq!(tool["tool_call_id"].as_str(), Some("call-generic"));
        assert_eq!(tool["content"].as_str(), Some("{\"ok\":true}"));
    }

    #[test]
    fn llm_output_payload_preserves_provider_usage() {
        let payload = llm_output_payload(LlmChatOutput {
            content: "done".to_string(),
            reasoning: None,
            tool_calls: Vec::new(),
            usage: Some(json!({
                "prompt_cache_hit_tokens": 80,
                "prompt_cache_miss_tokens": 20,
                "prompt_tokens": 100,
                "completion_tokens": 12,
                "total_tokens": 112
            })),
        });

        assert_eq!(payload["usage"]["prompt_cache_hit_tokens"].as_u64(), Some(80));
        assert_eq!(payload["usage"]["prompt_cache_miss_tokens"].as_u64(), Some(20));
        assert_eq!(payload["usage"]["prompt_tokens"].as_u64(), Some(100));
        assert_eq!(payload["usage"]["completion_tokens"].as_u64(), Some(12));
        assert_eq!(payload["usage"]["total_tokens"].as_u64(), Some(112));
    }

    #[test]
    fn openai_sse_parser_collects_content_reasoning_and_usage() {
        let output = parse_openai_compatible_sse_text(
            r#"data: {"choices":[{"index":0,"delta":{"reasoning_content":"reason "}}]}

data: {"choices":[{"index":0,"delta":{"content":"hel"}}]}

data: {"choices":[{"index":0,"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}

data: [DONE]

"#,
        );

        assert_eq!(output.reasoning.as_deref(), Some("reason "));
        assert_eq!(output.content, "hello");
        assert_eq!(output.usage.unwrap()["total_tokens"].as_u64(), Some(6));
    }

    #[test]
    fn openai_sse_parser_accumulates_tool_call_arguments() {
        let output = parse_openai_compatible_sse_text(
            r#"data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-generic","function":{"name":"fs__read","arguments":"{\"pa"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\"generic.txt\"}"}}]},"finish_reason":"tool_calls"}]}

data: [DONE]

"#,
        );

        assert_eq!(output.tool_calls.len(), 1);
        assert_eq!(output.tool_calls[0].id, "call-generic");
        assert_eq!(output.tool_calls[0].name, "fs.read");
        assert_eq!(output.tool_calls[0].arguments["path"].as_str(), Some("generic.txt"));
    }
}
