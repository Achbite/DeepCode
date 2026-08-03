use crate::prelude::*;
use crate::*;
use deepcode_kernel_abi::{LlmProviderDiagnostic, LlmProviderErrorLayer};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub(crate) fn anthropic_stream_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
) -> Value {
    let (system, chat_messages) = split_system_messages(messages);
    let mut body = json!({
        "model": profile.model,
        "messages": chat_messages,
        "max_tokens": profile.max_output_tokens.unwrap_or(4096),
        "stream": true,
    });
    if profile.thinking.as_deref() == Some("enabled") {
        let max_tokens = profile.max_output_tokens.unwrap_or(4096);
        if max_tokens > 1024 {
            body["thinking"] = json!({
                "type": "enabled",
                "budget_tokens": (max_tokens / 2).max(1024).min(max_tokens - 1),
            });
        }
    }
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
    body
}

pub(crate) fn ollama_stream_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
) -> Value {
    let mut body = json!({
        "model": profile.model,
        "messages": messages,
        "stream": true,
        "think": profile.thinking.as_deref() == Some("enabled"),
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
    body
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderJsonResponse {
    pub(crate) value: Value,
    status: Option<u16>,
    content_type: String,
    body: String,
    body_hash: String,
    is_stream: bool,
    expected_schema: String,
}

pub(crate) struct ProviderDiagnosticInput<'a> {
    pub(crate) profile: &'a ResolvedLlmProfile,
    pub(crate) provider: &'a str,
    pub(crate) reason: &'a str,
    pub(crate) error_layer: LlmProviderErrorLayer,
    pub(crate) status: Option<u16>,
    pub(crate) content_type: Option<&'a str>,
    pub(crate) body: &'a str,
    pub(crate) body_hash: Option<&'a str>,
    pub(crate) is_stream: bool,
    pub(crate) expected_schema: &'a str,
    pub(crate) message: String,
}

pub(crate) async fn read_provider_json_response(
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
        provider_response_error(ProviderDiagnosticInput {
            profile,
            provider,
            reason: "ProviderResponseReadFailed",
            error_layer: LlmProviderErrorLayer::Transport,
            status: None,
            content_type: Some(&content_type),
            body: "",
            body_hash: None,
            is_stream,
            expected_schema,
            message: error.to_string(),
        })
    })?;
    let body_hash = provider_body_hash(&body);
    if !status.is_success() {
        return Err(provider_response_error(ProviderDiagnosticInput {
            profile,
            provider,
            reason: "ProviderHttpStatusFailed",
            error_layer: LlmProviderErrorLayer::HttpStatus,
            status: Some(status.as_u16()),
            content_type: Some(&content_type),
            body: &body,
            body_hash: Some(body_hash.as_str()),
            is_stream,
            expected_schema,
            message: format!("LLM provider returned HTTP {}", status.as_u16()),
        }));
    }
    let value = serde_json::from_str::<Value>(&body).map_err(|error| {
        provider_response_error(ProviderDiagnosticInput {
            profile,
            provider,
            reason: "ProviderJsonDecodeFailed",
            error_layer: LlmProviderErrorLayer::JsonDecode,
            status: Some(status.as_u16()),
            content_type: Some(&content_type),
            body: &body,
            body_hash: Some(body_hash.as_str()),
            is_stream,
            expected_schema,
            message: error.to_string(),
        })
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

pub(crate) fn provider_transport_error(
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
    provider_response_error(ProviderDiagnosticInput {
        profile,
        provider,
        reason,
        error_layer: LlmProviderErrorLayer::Transport,
        status: None,
        content_type: None,
        body: "",
        body_hash: None,
        is_stream: false,
        expected_schema: "provider.transport",
        message,
    })
}

pub(crate) fn provider_response_error(input: ProviderDiagnosticInput<'_>) -> LlmProviderDiagnostic {
    LlmProviderDiagnostic {
        reason: input.reason.to_string(),
        error_layer: input.error_layer,
        message: input.message,
        provider: input.provider.to_string(),
        profile_id: input.profile.id.clone(),
        profile_name: input.profile.name.clone(),
        model: input.profile.model.clone(),
        status: input.status,
        content_type: input.content_type.unwrap_or("unknown").to_string(),
        is_stream: input.is_stream,
        body_preview: provider_body_preview(input.body),
        body_hash: input.body_hash.map(str::to_string),
        expected_schema: input.expected_schema.to_string(),
    }
}

pub(crate) fn provider_local_error(
    profile: &ResolvedLlmProfile,
    provider: &str,
    reason: &str,
    error_layer: LlmProviderErrorLayer,
    message: String,
) -> LlmProviderDiagnostic {
    provider_response_error(ProviderDiagnosticInput {
        profile,
        provider,
        reason,
        error_layer,
        status: None,
        content_type: None,
        body: "",
        body_hash: None,
        is_stream: false,
        expected_schema: "provider.local.config",
        message,
    })
}

fn provider_body_hash(body: &str) -> String {
    let mut hasher = DefaultHasher::new();
    body.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub(crate) fn provider_body_preview(body: &str) -> String {
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

pub(crate) fn openai_message(response: &ProviderJsonResponse) -> Option<&Value> {
    response
        .value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .filter(|message| message.is_object())
}

fn has_anthropic_message(response: &ProviderJsonResponse) -> bool {
    response
        .value
        .get("content")
        .and_then(Value::as_array)
        .is_some()
}

fn ollama_message(response: &ProviderJsonResponse) -> Option<&Value> {
    response
        .value
        .get("message")
        .filter(|message| message.is_object())
}

pub(crate) fn provider_schema_error(
    profile: &ResolvedLlmProfile,
    provider: &str,
    response: &ProviderJsonResponse,
    message: &str,
) -> LlmProviderDiagnostic {
    provider_response_error(ProviderDiagnosticInput {
        profile,
        provider,
        reason: "ProviderSchemaDecodeFailed",
        error_layer: LlmProviderErrorLayer::SchemaDecode,
        status: response.status,
        content_type: Some(&response.content_type),
        body: &response.body,
        body_hash: Some(&response.body_hash),
        is_stream: response.is_stream,
        expected_schema: &response.expected_schema,
        message: message.to_string(),
    })
}
