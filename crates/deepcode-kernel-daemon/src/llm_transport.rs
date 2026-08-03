use crate::prelude::*;
use crate::*;
use axum::body::Body;
use bytes::Bytes;
use deepcode_kernel_abi::RunCapabilityV2;
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
const LLM_PROFILE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderThinkingCompatibility {
    DeepSeek,
    GlmDeferred,
    KimiDeferred,
    Generic,
}

pub(crate) fn llm_profile_is_enabled(config: &Value, profile_id: &str) -> bool {
    config
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        })
        .is_some_and(llm_profile_value_is_enabled)
}

fn llm_profile_value_is_enabled(profile: &Value) -> bool {
    profile.get("enabled").and_then(Value::as_bool) == Some(true)
        && profile.get("thinking").and_then(Value::as_str) == Some("enabled")
        && profile_reasoning_transport_is_compatible(profile)
}

pub(crate) fn effective_llm_profile_is_enabled(
    state: &AppState,
    config: &Value,
    profile_id: &str,
) -> Result<bool, ProviderTraceErrorV1> {
    let Some(profile) = config
        .get("profiles")
        .and_then(Value::as_array)
        .and_then(|profiles| {
            profiles
                .iter()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        })
    else {
        return Ok(false);
    };
    if !llm_profile_value_is_enabled(profile) {
        return Ok(false);
    }
    let profile_revision = crate::host_v2_storage::stable_json_sha256(profile)?;
    state
        .provider_trace_v1
        .profile_revision_is_unavailable(profile_id, &profile_revision)
        .map(|unavailable| !unavailable)
}

pub(crate) fn preferred_effective_llm_profile_id(
    state: &AppState,
    config: &Value,
) -> Result<Option<String>, ProviderTraceErrorV1> {
    let Some(profiles) = config.get("profiles").and_then(Value::as_array) else {
        return Ok(None);
    };
    let default_id = config.get("defaultProfileId").and_then(Value::as_str);
    if let Some(default_id) = default_id {
        if effective_llm_profile_is_enabled(state, config, default_id)? {
            return Ok(Some(default_id.to_string()));
        }
    }
    for profile in profiles {
        let Some(profile_id) = profile.get("id").and_then(Value::as_str) else {
            continue;
        };
        if Some(profile_id) == default_id {
            continue;
        }
        if effective_llm_profile_is_enabled(state, config, profile_id)? {
            return Ok(Some(profile_id.to_string()));
        }
    }
    Ok(None)
}

pub(crate) fn profile_reasoning_transport_is_compatible(profile: &Value) -> bool {
    matches!(
        (
            profile.get("kind").and_then(Value::as_str),
            profile.get("reasoningTransport").and_then(Value::as_str),
        ),
        (Some("openaiCompatible"), Some("openaiPlaintext"))
            | (Some("anthropic"), Some("anthropicPlaintext"))
            | (Some("ollama"), Some("ollamaPlaintext"))
    )
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
        if !llm_profile_value_is_enabled(profile) {
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
            profiles
                .iter()
                .find(|profile| llm_profile_value_is_enabled(profile))
        })
        .ok_or_else(|| "No enabled LLM profile is configured".to_string())?;

    if profile.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("Selected LLM profile is disabled".to_string());
    }
    if !profile_reasoning_transport_is_compatible(profile) {
        return Err(
            "Selected LLM profile has no compatible plaintext reasoning transport".to_string(),
        );
    }
    if profile.get("thinking").and_then(Value::as_str) != Some("enabled") {
        return Err("Selected LLM profile must have plaintext thinking enabled".to_string());
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

pub(crate) fn resolved_reasoning_transport(profile: &ResolvedLlmProfile) -> &'static str {
    match profile.kind.as_str() {
        "openaiCompatible" => "openaiPlaintext",
        "anthropic" => "anthropicPlaintext",
        "ollama" => "ollamaPlaintext",
        _ => "unsupported",
    }
}

pub(crate) fn validate_provider_identity_expectation(
    profile: &ResolvedLlmProfile,
    request: &Value,
) -> Result<(), String> {
    let Some(expectation) = request
        .get("providerOptions")
        .or_else(|| request.get("provider_options"))
        .and_then(|options| options.get("deepcode"))
        .and_then(|deepcode| {
            deepcode
                .get("expectedProviderIdentity")
                .or_else(|| deepcode.get("expected_provider_identity"))
        })
    else {
        return Ok(());
    };
    let expectation = expectation
        .as_object()
        .ok_or_else(|| "DeepCode expected Provider identity must be an object.".to_string())?;
    let expected_profile_id =
        required_provider_identity_field(expectation, "profileId", "profile_id")?;
    let expected_provider = required_provider_identity_field(expectation, "provider", "provider")?;
    let expected_model = required_provider_identity_field(expectation, "model", "model")?;
    let actual_provider = profile
        .provider_flavor
        .as_deref()
        .unwrap_or(profile.kind.as_str());
    for (name, expected, actual) in [
        ("profileId", expected_profile_id, profile.id.as_str()),
        ("provider", expected_provider, actual_provider),
        ("model", expected_model, profile.model.as_str()),
    ] {
        if expected != actual {
            return Err(format!(
                "Active Provider continuation expected {name} `{expected}` but Daemon resolved `{actual}`."
            ));
        }
    }
    Ok(())
}

fn required_provider_identity_field<'a>(
    expectation: &'a serde_json::Map<String, Value>,
    camel_case: &str,
    snake_case: &str,
) -> Result<&'a str, String> {
    expectation
        .get(camel_case)
        .or_else(|| expectation.get(snake_case))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!("DeepCode expected Provider identity requires non-empty `{camel_case}`.")
        })
}

pub(crate) fn openai_compatible_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
    response_format: Option<&Value>,
    stream: bool,
) -> Value {
    let thinking_compatibility = provider_thinking_compatibility(profile);
    let mut body = json!({
        "model": profile.model,
        "messages": openai_compatible_messages(messages, thinking_compatibility),
        "stream": stream
    });
    if let Some(tokens) = effective_openai_compatible_max_tokens(profile) {
        body["max_tokens"] = json!(tokens);
    }
    if should_send_sampling(thinking_compatibility) {
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
    if thinking_compatibility == ProviderThinkingCompatibility::DeepSeek {
        body["user_id"] = json!("deepcode_local");
        if stream {
            body["stream_options"] = json!({ "include_usage": true });
        }
    }
    if thinking_compatibility == ProviderThinkingCompatibility::GlmDeferred
        && stream
        && !tools.is_empty()
    {
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

fn openai_compatible_messages(
    messages: Vec<Value>,
    thinking_compatibility: ProviderThinkingCompatibility,
) -> Vec<Value> {
    messages
        .into_iter()
        .map(|message| openai_compatible_message(message, thinking_compatibility))
        .collect()
}

fn openai_compatible_message(
    message: Value,
    thinking_compatibility: ProviderThinkingCompatibility,
) -> Value {
    let Some(record) = message.as_object() else {
        return message;
    };
    let role = record.get("role").and_then(Value::as_str).unwrap_or("user");
    match role {
        "assistant" => openai_compatible_assistant_message(record, thinking_compatibility),
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

fn openai_compatible_assistant_message(
    record: &serde_json::Map<String, Value>,
    thinking_compatibility: ProviderThinkingCompatibility,
) -> Value {
    let mut message = json!({
        "role": "assistant",
        "content": message_content_string(record.get("content"))
    });
    if thinking_compatibility == ProviderThinkingCompatibility::DeepSeek {
        if let Some(reasoning_content) = record
            .get("reasoning_content")
            .or_else(|| record.get("reasoningContent"))
            .and_then(Value::as_str)
        {
            message["reasoning_content"] = json!(reasoning_content);
        }
    }
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

#[derive(Clone)]
pub(crate) struct ProviderStreamTraceContextV1 {
    pub(crate) store: ProviderTraceStoreV1,
    pub(crate) identity: ProviderTraceIdentityV1,
    pub(crate) dispatch_authority: ProviderStreamDispatchAuthorityV1,
}

#[derive(Clone)]
pub(crate) struct ProviderStreamDispatchAuthorityV1 {
    pub(crate) session_store: SessionKernelV2Store,
    pub(crate) run_capability: RunCapabilityV2,
    pub(crate) admission: SessionProviderTurnAdmissionV2,
}

struct ProviderWireEnvelopeV1 {
    raw: Vec<u8>,
    payload: Option<Vec<u8>>,
}

struct ProviderEnvelopeFramerV1 {
    kind: ProviderNativeStreamKindV1,
    buffer: Vec<u8>,
}

#[derive(Debug, Clone)]
pub(crate) struct LlmNativeStreamProbeResultV1 {
    pub(crate) provider_kind: &'static str,
    pub(crate) terminal_signal: &'static str,
    pub(crate) finish_reason: Option<String>,
    pub(crate) reasoning_present: bool,
    pub(crate) response_present: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderNativeStreamTransportErrorV1 {
    pub(crate) code: &'static str,
    pub(crate) http_status: Option<u16>,
}

impl ProviderNativeStreamTransportErrorV1 {
    fn new(code: &'static str) -> Self {
        Self {
            code,
            http_status: None,
        }
    }

    fn http(status: u16) -> Self {
        Self {
            code: "provider_http_status_failed",
            http_status: Some(status),
        }
    }

    pub(crate) fn safe_message(&self) -> &'static str {
        match self.code {
            "ProviderUnsupportedKind" => "Selected Provider kind is not supported.",
            "ProviderProfileMissingApiKey" => {
                "Selected Provider Profile has no configured API key."
            }
            "provider_plaintext_reasoning_not_enabled" => {
                "Provider Profile does not enable a supported plaintext reasoning mode."
            }
            "provider_reasoning_missing" => {
                "Provider response did not contain the required plaintext reasoning."
            }
            "provider_request_too_large" => {
                "Provider probe request exceeded the transport size limit."
            }
            "provider_request_secret_forbidden" => {
                "Provider request contains forbidden structured secret or capability material."
            }
            "provider_dispatch_request_identity_invalid" => {
                "Provider request does not preserve the exact durable Session turn identity."
            }
            "provider_probe_timeout" => {
                "Provider probe did not reach a validated native completion before its deadline."
            }
            "provider_http_status_failed" => "Provider returned a non-success response.",
            "provider_transport_failed" => {
                "Provider transport ended before a validated response was committed."
            }
            "provider_stream_raw_limit_exceeded" => {
                "Provider response crossed the source-byte limit."
            }
            _ => "Provider probe failed before a validated native streaming completion.",
        }
    }
}

struct PreparedProviderNativeStreamRequestV1 {
    provider_kind: ProviderNativeStreamKindV1,
    exact_request_body: Vec<u8>,
    tool_count: usize,
}

impl ProviderEnvelopeFramerV1 {
    fn new(kind: ProviderNativeStreamKindV1) -> Self {
        Self {
            kind,
            buffer: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Result<Vec<ProviderWireEnvelopeV1>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut envelopes = Vec::new();
        match self.kind {
            ProviderNativeStreamKindV1::OpenAiCompatible
            | ProviderNativeStreamKindV1::Anthropic => {
                while let Some((end, delimiter_len)) = sse_envelope_boundary(&self.buffer) {
                    let raw = self.buffer.drain(..end + delimiter_len).collect::<Vec<_>>();
                    ensure_provider_envelope_size(&raw)?;
                    let payload = sse_data_payload(&raw)?;
                    envelopes.push(ProviderWireEnvelopeV1 { raw, payload });
                }
            }
            ProviderNativeStreamKindV1::Ollama => {
                while let Some(index) = self.buffer.iter().position(|byte| *byte == b'\n') {
                    let raw = self.buffer.drain(..=index).collect::<Vec<_>>();
                    ensure_provider_envelope_size(&raw)?;
                    let payload = trimmed_ndjson_payload(&raw);
                    envelopes.push(ProviderWireEnvelopeV1 { raw, payload });
                }
            }
        }
        if self.buffer.len() > PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1 {
            return Err(format!(
                "Provider envelope exceeded the {} byte hard limit",
                PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1
            ));
        }
        Ok(envelopes)
    }

    fn finish(&mut self) -> Result<Vec<ProviderWireEnvelopeV1>, String> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }
        match self.kind {
            ProviderNativeStreamKindV1::Ollama => {
                let raw = std::mem::take(&mut self.buffer);
                ensure_provider_envelope_size(&raw)?;
                let payload = trimmed_ndjson_payload(&raw);
                Ok(vec![ProviderWireEnvelopeV1 { raw, payload }])
            }
            ProviderNativeStreamKindV1::OpenAiCompatible
            | ProviderNativeStreamKindV1::Anthropic => {
                Err("Provider SSE stream ended with an incomplete source envelope".to_string())
            }
        }
    }

    fn ensure_empty_after_terminal(&mut self) -> Result<(), String> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            self.buffer.clear();
            Ok(())
        } else {
            Err(
                "Provider emitted an incomplete envelope after its native terminal marker"
                    .to_string(),
            )
        }
    }
}

fn ensure_provider_envelope_size(raw: &[u8]) -> Result<(), String> {
    if raw.len() > PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1 {
        return Err(format!(
            "Provider envelope exceeded the {} byte hard limit",
            PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1
        ));
    }
    Ok(())
}

fn sse_envelope_boundary(buffer: &[u8]) -> Option<(usize, usize)> {
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
        (Some(boundary), None) | (None, Some(boundary)) => Some(boundary),
        (None, None) => None,
    }
}

fn sse_data_payload(raw: &[u8]) -> Result<Option<Vec<u8>>, String> {
    let text = std::str::from_utf8(raw)
        .map_err(|error| format!("Provider SSE envelope is not valid UTF-8: {error}"))?;
    let mut data = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(value) = line.strip_prefix("data:") {
            if !data.is_empty() {
                data.push(b'\n');
            }
            data.extend_from_slice(value.trim_start().as_bytes());
        }
    }
    Ok((!data.is_empty()).then_some(data))
}

fn trimmed_ndjson_payload(raw: &[u8]) -> Option<Vec<u8>> {
    let start = raw.iter().position(|byte| !byte.is_ascii_whitespace())?;
    let end = raw
        .iter()
        .rposition(|byte| !byte.is_ascii_whitespace())
        .map(|index| index + 1)?;
    Some(raw[start..end].to_vec())
}

fn prepare_provider_native_stream_request(
    profile: &ResolvedLlmProfile,
    request_envelope: &Value,
) -> Result<PreparedProviderNativeStreamRequestV1, ProviderNativeStreamTransportErrorV1> {
    let provider_kind = ProviderNativeStreamKindV1::from_profile_kind(&profile.kind)
        .ok_or_else(|| ProviderNativeStreamTransportErrorV1::new("ProviderUnsupportedKind"))?;
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
    let provider_body = match provider_kind {
        ProviderNativeStreamKindV1::OpenAiCompatible => {
            validate_provider_thinking_continuation(profile, &messages).map_err(|_| {
                ProviderNativeStreamTransportErrorV1::new("provider_thinking_continuation_invalid")
            })?;
            openai_compatible_request_body(
                profile,
                messages,
                &tools,
                response_format.as_ref(),
                true,
            )
        }
        ProviderNativeStreamKindV1::Anthropic => {
            anthropic_stream_request_body(profile, messages, &tools)
        }
        ProviderNativeStreamKindV1::Ollama => ollama_stream_request_body(profile, messages, &tools),
    };
    crate::host_v2_storage::reject_transport_capabilities(&provider_body).map_err(|_| {
        ProviderNativeStreamTransportErrorV1::new("provider_request_secret_forbidden")
    })?;
    let exact_request_body = serde_json::to_vec(&provider_body)
        .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_request_encode_failed"))?;
    if exact_request_body.len() > PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1 {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_request_too_large",
        ));
    }
    Ok(PreparedProviderNativeStreamRequestV1 {
        provider_kind,
        exact_request_body,
        tool_count: tools.len(),
    })
}

fn provider_dispatch_binding_from_exact_request(
    exact_request_body: &[u8],
) -> Result<SessionProviderDispatchBindingV2, ProviderNativeStreamTransportErrorV1> {
    let body = serde_json::from_slice::<Value>(exact_request_body).map_err(|_| {
        ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
    })?;
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
        })?;
    let mut matches = messages.iter().filter_map(|message| {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        let content = message.get("content").and_then(Value::as_str)?;
        let value = serde_json::from_str::<Value>(content).ok()?;
        (value.get("schemaVersion").and_then(Value::as_str)
            == Some("deepcode.session.provider-current-input.v2"))
        .then_some(value)
    });
    let current_input = matches.next().ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
    })?;
    if matches.next().is_some() {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_dispatch_request_identity_invalid",
        ));
    }
    let required_text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new(
                    "provider_dispatch_request_identity_invalid",
                )
            })
    };
    let provider_turn_id = required_text(current_input.get("providerTurnId"))?;
    let run_id = required_text(current_input.get("runId"))?;
    let control_epoch = current_input
        .get("controlEpoch")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
        })?;
    let current_input_id = required_text(
        current_input
            .get("currentInput")
            .and_then(|value| value.get("inputId")),
    )?;
    let purpose = match current_input.get("purpose").and_then(Value::as_str) {
        Some("primary") => ProviderTracePurposeV1::Primary,
        Some("continuation") => ProviderTracePurposeV1::Continuation,
        Some("finalAnswer") => ProviderTracePurposeV1::FinalAnswer,
        _ => {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_dispatch_request_identity_invalid",
            ))
        }
    };
    let current_input_digest =
        crate::host_v2_storage::canonical_sha256(&current_input).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
        })?;
    Ok(SessionProviderDispatchBindingV2 {
        provider_turn_id,
        run_id,
        control_epoch,
        current_input_id,
        current_input_digest,
        purpose,
    })
}

fn validate_provider_native_reasoning_mode(
    profile: &ResolvedLlmProfile,
    provider_kind: ProviderNativeStreamKindV1,
) -> Result<(), ProviderNativeStreamTransportErrorV1> {
    if profile.thinking.as_deref() != Some("enabled")
        || (provider_kind == ProviderNativeStreamKindV1::Anthropic
            && profile.max_output_tokens.unwrap_or(4096) <= 1024)
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_plaintext_reasoning_not_enabled",
        ));
    }
    Ok(())
}

fn build_provider_native_stream_request(
    profile: &ResolvedLlmProfile,
    provider_kind: ProviderNativeStreamKindV1,
    exact_request_body: Vec<u8>,
) -> Result<reqwest::RequestBuilder, ProviderNativeStreamTransportErrorV1> {
    let url = match provider_kind {
        ProviderNativeStreamKindV1::OpenAiCompatible => normalize_openai_base_url(profile),
        ProviderNativeStreamKindV1::Anthropic => normalize_anthropic_base_url(profile),
        ProviderNativeStreamKindV1::Ollama => normalize_ollama_base_url(profile),
    };
    let mut request = reqwest::Client::new()
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(exact_request_body);
    match provider_kind {
        ProviderNativeStreamKindV1::OpenAiCompatible => {
            let api_key = profile.api_key.as_deref().ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new("ProviderProfileMissingApiKey")
            })?;
            request = request.bearer_auth(api_key);
        }
        ProviderNativeStreamKindV1::Anthropic => {
            let api_key = profile.api_key.as_deref().ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new("ProviderProfileMissingApiKey")
            })?;
            request = request
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01");
        }
        ProviderNativeStreamKindV1::Ollama => {}
    }
    Ok(request)
}

pub(crate) async fn probe_llm_profile_native_stream(
    profile: &ResolvedLlmProfile,
) -> Result<LlmNativeStreamProbeResultV1, ProviderNativeStreamTransportErrorV1> {
    tokio::time::timeout(
        LLM_PROFILE_PROBE_TIMEOUT,
        probe_llm_profile_native_stream_inner(profile),
    )
    .await
    .unwrap_or_else(|_| Err(provider_probe_timeout_error()))
}

fn provider_probe_timeout_error() -> ProviderNativeStreamTransportErrorV1 {
    ProviderNativeStreamTransportErrorV1::new("provider_probe_timeout")
}

async fn probe_llm_profile_native_stream_inner(
    profile: &ResolvedLlmProfile,
) -> Result<LlmNativeStreamProbeResultV1, ProviderNativeStreamTransportErrorV1> {
    let probe_envelope = json!({
        "messages": [{ "role": "user", "content": "Reply with OK." }],
        "tools": []
    });
    let prepared = prepare_provider_native_stream_request(profile, &probe_envelope)?;
    let provider_kind = prepared.provider_kind;
    validate_provider_native_reasoning_mode(profile, provider_kind)?;
    let request =
        build_provider_native_stream_request(profile, provider_kind, prepared.exact_request_body)?;

    let response = request
        .send()
        .await
        .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_transport_failed"))?;
    if !response.status().is_success() {
        return Err(ProviderNativeStreamTransportErrorV1::http(
            response.status().as_u16(),
        ));
    }

    let mut response = response;
    let mut framer = ProviderEnvelopeFramerV1::new(provider_kind);
    let mut accumulator = ProviderNativeStreamAccumulatorV1::new(provider_kind);
    let mut source_bytes = 0usize;
    loop {
        let (envelopes, reached_eof) = match response.chunk().await {
            Ok(Some(chunk)) => (
                framer.push(&chunk).map_err(|_| {
                    ProviderNativeStreamTransportErrorV1::new("provider_stream_envelope_invalid")
                })?,
                false,
            ),
            Ok(None) => (
                framer.finish().map_err(|_| {
                    ProviderNativeStreamTransportErrorV1::new("provider_stream_envelope_incomplete")
                })?,
                true,
            ),
            Err(_) => {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_transport_failed",
                ));
            }
        };
        for envelope in envelopes {
            source_bytes = source_bytes.saturating_add(envelope.raw.len());
            if source_bytes > PROVIDER_TRACE_RAW_SOURCE_SOFT_LIMIT_V1 {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_stream_raw_limit_exceeded",
                ));
            }
            let Some(payload) = envelope.payload else {
                continue;
            };
            accumulator
                .ingest_payload(&payload)
                .map_err(|error| ProviderNativeStreamTransportErrorV1::new(error.code))?;
        }
        if accumulator.source_done() {
            framer.ensure_empty_after_terminal().map_err(|_| {
                ProviderNativeStreamTransportErrorV1::new("provider_stream_data_after_terminal")
            })?;
            break;
        }
        if reached_eof {
            break;
        }
    }

    let result = accumulator
        .finalize()
        .map_err(|error| ProviderNativeStreamTransportErrorV1::new(error.code))?;
    let response_present = !result.output.content.trim().is_empty()
        || result.output.tool_calls.iter().any(|call| {
            !call.id.trim().is_empty() && !call.name.trim().is_empty() && !call.arguments.is_null()
        });
    Ok(LlmNativeStreamProbeResultV1 {
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

pub(crate) fn llm_stream_response(
    profile: ResolvedLlmProfile,
    request_envelope: Value,
    request_id: String,
    trace_context: ProviderStreamTraceContextV1,
    session_io_guard: tokio::sync::OwnedRwLockReadGuard<()>,
) -> Response {
    let response_request_id = request_id.clone();
    let stream = async_stream::stream! {
        let _session_io_guard = session_io_guard;
        let prepared = match prepare_provider_native_stream_request(
            &profile,
            &request_envelope,
        ) {
            Ok(prepared) => prepared,
            Err(error) => {
                yield Ok::<Bytes, Infallible>(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    error.safe_message(),
                )));
                return;
            }
        };
        let provider_kind = prepared.provider_kind;
        let tool_count = prepared.tool_count;
        let exact_request_binding = match provider_dispatch_binding_from_exact_request(
            &prepared.exact_request_body,
        ) {
            Ok(binding) => binding,
            Err(error) => {
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    error.safe_message(),
                )));
                return;
            }
        };
        if let Err(error) = validate_provider_native_reasoning_mode(&profile, provider_kind) {
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.safe_message(),
            )));
            return;
        }
        let ProviderStreamTraceContextV1 {
            store: trace_store,
            identity: trace_identity,
            dispatch_authority,
        } = trace_context;
        let trace_purpose = trace_identity.purpose;
        if matches!(trace_purpose, ProviderTracePurposeV1::FinalAnswer) && tool_count != 0 {
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                "provider_final_answer_tools_exposed",
                "A finalAnswer Provider request must not expose tools",
            )));
            return;
        }
        let quarantine_profile_id = trace_identity.profile_id.clone();
        let quarantine_profile_revision = trace_identity.profile_revision.clone();
        let quarantine_store = trace_store.clone();
        let availability_transition =
            crate::settings_api::settings_transition_gate_v2().read().await;
        match trace_store.profile_revision_is_unavailable(
            &quarantine_profile_id,
            &quarantine_profile_revision,
        ) {
            Ok(false) => {}
            Ok(true) => {
                drop(availability_transition);
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    "llm_profile_revision_unavailable",
                    "Selected Provider Profile revision became unavailable before durable dispatch commit.",
                )));
                return;
            }
            Err(error) => {
                drop(availability_transition);
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    "Provider Profile availability could not be verified before durable dispatch commit.",
                )));
                return;
            }
        }
        let mut trace = match dispatch_authority.session_store.commit_provider_dispatch(
            &dispatch_authority.run_capability,
            &dispatch_authority.admission,
            &exact_request_binding,
            &trace_store,
            trace_identity,
            &prepared.exact_request_body,
        ) {
            Ok(trace) => trace,
            Err(error) => {
                drop(availability_transition);
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    error.message,
                )));
                return;
            }
        };
        drop(availability_transition);
        let request = match build_provider_native_stream_request(
            &profile,
            provider_kind,
            prepared.exact_request_body,
        ) {
            Ok(request) => request,
            Err(error) => {
                let _ = finish_provider_trace_failure(&mut trace, error.code);
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    error.safe_message(),
                )));
                return;
            }
        };
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                let _ = finish_provider_trace_failure(&mut trace, "ProviderTransportFailed");
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    "provider_retryable_no_mutation",
                    error.to_string(),
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
        if let Err(error) = trace.response_boundary(ProviderTraceResponseBoundaryV1 {
            status_code: status.as_u16(),
            content_type: Some(content_type),
        }) {
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.message,
            )));
            return;
        }
        if !status.is_success() {
            let mut response = response;
            let mut error_body = Vec::new();
            loop {
                match response.chunk().await {
                    Ok(Some(chunk)) => {
                        if error_body.len().saturating_add(chunk.len())
                            > PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1
                        {
                            let _ = finish_provider_trace_failure(
                                &mut trace,
                                "provider_error_body_too_large",
                            );
                            break;
                        }
                        error_body.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            let raw_limit_exceeded = if error_body.is_empty() {
                false
            } else {
                match trace.append_raw_upstream_envelope(&error_body) {
                    Ok(ProviderTraceRawAppendV1::Archived { .. }) => false,
                    Ok(ProviderTraceRawAppendV1::LimitExceeded { .. }) => {
                        let _ = trace.finish(ProviderTraceTerminalV1 {
                            kind: ProviderTraceTerminalKindV1::LimitExceeded,
                            reason_code: Some(
                                "provider_trace_raw_limit_exceeded".to_string(),
                            ),
                        });
                        true
                    }
                    Err(_) => false,
                }
            };
            if !raw_limit_exceeded {
                let _ = finish_provider_trace_failure(&mut trace, "ProviderHttpStatusFailed");
            }
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                if (500..=599).contains(&status.as_u16()) {
                    "provider_retryable_no_mutation"
                } else {
                    "llm_chat_failed"
                },
                format!("LLM provider returned HTTP {}", status.as_u16()),
            )));
            return;
        }

        let metadata = json!({
            "type": "provider_metadata",
            "requestId": request_id.as_str(),
            "providerProfileId": profile.id,
            "provider": profile.provider_flavor.as_deref().unwrap_or(profile.kind.as_str()),
            "model": profile.model,
        });
        if let Err(error) = trace.append_normalized_event(metadata.clone()) {
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.message,
            )));
            return;
        }
        if let Err(error) = trace.archive_before_publication(|_| ()) {
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.message,
            )));
            return;
        }
        let mut response_digest_items = vec![metadata.clone()];
        yield Ok(Bytes::from(sse_json_event("provider_metadata", metadata)));

        let mut framer = ProviderEnvelopeFramerV1::new(provider_kind);
        let mut accumulator = ProviderNativeStreamAccumulatorV1::new(provider_kind);
        let mut response = response;
        'upstream: loop {
            let flush_deadline = tokio::time::Instant::from_std(trace.next_flush_deadline());
            let next = tokio::select! {
                chunk = response.chunk() => Some(chunk),
                _ = tokio::time::sleep_until(flush_deadline) => None,
            };
            let Some(next) = next else {
                if let Err(error) = trace.flush_if_due(Instant::now()) {
                    yield Ok(Bytes::from(provider_public_error_event(
                        &request_id,
                        error.code,
                        error.message,
                    )));
                    return;
                }
                continue;
            };
            match next {
                Ok(Some(chunk)) => {
                    let envelopes = match framer.push(&chunk) {
                        Ok(envelopes) => envelopes,
                        Err(message) => {
                            let _ = finish_provider_trace_failure(
                                &mut trace,
                                "provider_stream_envelope_invalid",
                            );
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                "provider_stream_envelope_invalid",
                                message,
                            )));
                            return;
                        }
                    };
                    for envelope in envelopes {
                        let raw_result = trace.append_raw_upstream_envelope(&envelope.raw);
                        match raw_result {
                            Ok(ProviderTraceRawAppendV1::Archived { .. }) => {}
                            Ok(ProviderTraceRawAppendV1::LimitExceeded { .. }) => {
                                let _ = trace.finish(ProviderTraceTerminalV1 {
                                    kind: ProviderTraceTerminalKindV1::LimitExceeded,
                                    reason_code: Some(
                                        "provider_trace_raw_limit_exceeded".to_string(),
                                    ),
                                });
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    "provider_trace_raw_limit_exceeded",
                                    "Provider trace crossed the 1 MiB raw source limit",
                                )));
                                return;
                            }
                            Err(error) => {
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                        }
                        let Some(payload) = envelope.payload else {
                            continue;
                        };
                        let emissions = match accumulator.ingest_payload(&payload) {
                            Ok(emissions) => emissions,
                            Err(error) => {
                                let _ = finish_provider_trace_failure(&mut trace, error.code);
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                        };
                        for emission in emissions {
                            if let Err(error) =
                                trace.append_normalized_event(emission.trace_event)
                            {
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                            if let Some(mut public_event) = emission.public_event {
                                if let Some(record) = public_event.data.as_object_mut() {
                                    record.insert(
                                        "requestId".to_string(),
                                        json!(request_id.as_str()),
                                    );
                                }
                                if let Err(error) =
                                    trace.archive_before_publication(|_| ())
                                {
                                    yield Ok(Bytes::from(provider_public_error_event(
                                        &request_id,
                                        error.code,
                                        error.message,
                                    )));
                                    return;
                                }
                                response_digest_items.push(public_event.data.clone());
                                yield Ok(Bytes::from(sse_json_event(
                                    public_event.event,
                                    public_event.data,
                                )));
                            }
                        }
                    }
                    if accumulator.source_done() {
                        if let Err(message) = framer.ensure_empty_after_terminal() {
                            let _ = finish_provider_trace_failure(
                                &mut trace,
                                "provider_stream_data_after_terminal",
                            );
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                "provider_stream_data_after_terminal",
                                message,
                            )));
                            return;
                        }
                        break 'upstream;
                    }
                }
                Ok(None) => {
                    let envelopes = match framer.finish() {
                        Ok(envelopes) => envelopes,
                        Err(message) => {
                            let _ = finish_provider_trace_failure(
                                &mut trace,
                                "provider_stream_envelope_incomplete",
                            );
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                "provider_stream_envelope_incomplete",
                                message,
                            )));
                            return;
                        }
                    };
                    for envelope in envelopes {
                        match trace.append_raw_upstream_envelope(&envelope.raw) {
                            Ok(ProviderTraceRawAppendV1::Archived { .. }) => {}
                            Ok(ProviderTraceRawAppendV1::LimitExceeded { .. }) => {
                                let _ = trace.finish(ProviderTraceTerminalV1 {
                                    kind: ProviderTraceTerminalKindV1::LimitExceeded,
                                    reason_code: Some(
                                        "provider_trace_raw_limit_exceeded".to_string(),
                                    ),
                                });
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    "provider_trace_raw_limit_exceeded",
                                    "Provider trace crossed the 1 MiB raw source limit",
                                )));
                                return;
                            }
                            Err(error) => {
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                        }
                        let Some(payload) = envelope.payload else {
                            continue;
                        };
                        let emissions = match accumulator.ingest_payload(&payload) {
                            Ok(emissions) => emissions,
                            Err(error) => {
                                let _ = finish_provider_trace_failure(&mut trace, error.code);
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                        };
                        for emission in emissions {
                            if let Err(error) =
                                trace.append_normalized_event(emission.trace_event)
                            {
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                            if let Some(mut public_event) = emission.public_event {
                                if let Some(record) = public_event.data.as_object_mut() {
                                    record.insert(
                                        "requestId".to_string(),
                                        json!(request_id.as_str()),
                                    );
                                }
                                if let Err(error) =
                                    trace.archive_before_publication(|_| ())
                                {
                                    yield Ok(Bytes::from(provider_public_error_event(
                                        &request_id,
                                        error.code,
                                        error.message,
                                    )));
                                    return;
                                }
                                response_digest_items.push(public_event.data.clone());
                                yield Ok(Bytes::from(sse_json_event(
                                    public_event.event,
                                    public_event.data,
                                )));
                            }
                        }
                    }
                    break;
                }
                Err(error) => {
                    let _ = finish_provider_trace_failure(
                        &mut trace,
                        "ProviderResponseReadFailed",
                    );
                    yield Ok(Bytes::from(provider_public_error_event(
                        &request_id,
                        "provider_retryable_no_mutation",
                        error.to_string(),
                    )));
                    return;
                }
            }
        }
        let result = match accumulator.finalize() {
            Ok(result) => result,
            Err(error) => {
                if error.code == "provider_reasoning_missing" {
                    let _availability_transition =
                        crate::settings_api::settings_transition_gate_v2().write().await;
                    if let Err(quarantine_error) =
                        quarantine_store.mark_profile_revision_unavailable(
                            &quarantine_profile_id,
                            &quarantine_profile_revision,
                            error.code,
                        )
                    {
                        drop(_availability_transition);
                        let _ = finish_provider_trace_failure(
                            &mut trace,
                            "provider_profile_quarantine_failed",
                        );
                        yield Ok(Bytes::from(provider_public_error_event(
                            &request_id,
                            "provider_profile_quarantine_failed",
                            quarantine_error.message,
                        )));
                        return;
                    }
                }
                let _ = finish_provider_trace_failure(&mut trace, error.code);
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    error.message,
                )));
                return;
            }
        };
        if matches!(
            trace_purpose,
            ProviderTracePurposeV1::FinalAnswer
        ) && !result.output.tool_calls.is_empty()
        {
            let _ = finish_provider_trace_failure(
                &mut trace,
                "provider_final_answer_tool_call_forbidden",
            );
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                "provider_final_answer_tool_call_forbidden",
                "A finalAnswer Provider turn cannot return tool calls",
            )));
            return;
        }
        let reasoning = result.output.reasoning.as_deref().unwrap_or_default();
        let reasoning_digest = crate::host_v2_storage::sha256_prefixed(reasoning.as_bytes());
        let mut native_completion = json!({
            "providerKind": result.completion.provider_kind.wire_name(),
            "terminalSignal": result.completion.provider_kind.terminal_signal(),
        });
        if let Some(finish_reason) = result.completion.finish_reason {
            native_completion["finishReason"] = json!(finish_reason);
        }
        response_digest_items.push(json!({
            "nativeCompletion": native_completion,
        }));
        let response_digest = match crate::host_v2_storage::stable_json_sha256(&json!({
            "orderedSafeItems": response_digest_items,
        })) {
            Ok(digest) => digest,
            Err(error) => {
                let _ = finish_provider_trace_failure(
                    &mut trace,
                    "provider_response_digest_failed",
                );
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    "provider_response_digest_failed",
                    error.message,
                )));
                return;
            }
        };
        if let Err(error) = trace.append_normalized_event(json!({
            "type": "validatedTerminal",
            "nativeCompletion": native_completion,
            "reasoningPresent": true,
            "reasoningTransport": resolved_reasoning_transport(&profile),
            "reasoningDigest": reasoning_digest,
            "responseDigest": response_digest,
        })) {
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.message,
            )));
            return;
        }
        let trace_metadata = match trace.finish(ProviderTraceTerminalV1 {
            kind: ProviderTraceTerminalKindV1::Completed,
            reason_code: None,
        }) {
            Ok(metadata) => metadata,
            Err(error) => {
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    error.code,
                    error.message,
                )));
                return;
            }
        };
        let terminal = json!({
            "type": "provider_terminal",
            "requestId": request_id.as_str(),
            "receipt": {
                "schemaVersion": PROVIDER_STREAM_TERMINAL_SCHEMA_V1,
                "nativeCompletion": native_completion,
                "reasoningPresent": true,
                "reasoningTransport": resolved_reasoning_transport(&profile),
                "reasoningDigest": reasoning_digest,
                "responseDigest": response_digest,
                "trace": {
                    "sealed": true,
                    "sealDigest": trace_metadata.seal_digest,
                    "terminalDigest": trace_metadata.terminal_digest,
                    "recordCount": trace_metadata.record_count,
                }
            }
        });
        yield Ok(Bytes::from(sse_json_event("provider_terminal", terminal)));
    };

    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| {
            Response::new(Body::from(sse_json_event(
                "provider_error",
                json!({
                    "type": "provider_error",
                    "requestId": response_request_id,
                    "error": "failed to build stream response"
                }),
            )))
        })
}

fn finish_provider_trace_failure(
    trace: &mut ProviderTraceWriterV1,
    reason_code: &str,
) -> Result<ProviderTraceMetadataV1, ProviderTraceErrorV1> {
    trace.finish(ProviderTraceTerminalV1 {
        kind: ProviderTraceTerminalKindV1::Failed,
        reason_code: Some(reason_code.to_string()),
    })
}

pub(crate) fn provider_public_error_event(
    request_id: &str,
    code: &str,
    _message: impl Into<String>,
) -> String {
    let message = match code {
        "http_body_rejected" => "Provider stream request was rejected before admission.",
        "provider_request_identity_invalid" => "Provider stream request identity is invalid.",
        "provider_transport_authority_required" | "provider_transport_authority_invalid" => {
            "Provider transport authority is unavailable or invalid."
        }
        "agent_session_deletion_in_progress" => {
            "Session storage is unavailable because deletion is pending or complete."
        }
        "provider_profile_identity_invalid" | "provider_profile_revision_stale" => {
            "Selected Provider Profile does not match the Run-bound configuration."
        }
        "provider_profile_unavailable" => "Selected Provider Profile is unavailable.",
        "provider_trace_identity_missing"
        | "provider_trace_run_stale"
        | "provider_trace_user_turn_invalid"
        | "provider_trace_control_epoch_invalid"
        | "provider_trace_purpose_invalid" => {
            "Provider trace identity is missing, invalid, or stale."
        }
        "llm_profile_revision_unavailable" => "Selected Provider Profile revision is unavailable.",
        "ProviderProfileMissingApiKey" => "Selected Provider Profile has no configured API key.",
        "provider_retryable_no_mutation" => {
            "Provider transport ended before a validated response was committed."
        }
        "provider_reasoning_missing" => {
            "Provider response did not contain the required plaintext reasoning."
        }
        "provider_final_answer_tool_call_forbidden" => {
            "Provider returned a tool call during a no-tools finalAnswer turn."
        }
        "provider_trace_raw_limit_exceeded" => {
            "Provider response crossed the private trace source-byte limit."
        }
        "llm_chat_failed" => "Provider returned a non-success response.",
        _ => "Provider stream failed before a validated terminal receipt.",
    };
    sse_json_event(
        "provider_error",
        json!({
            "type": "provider_error",
            "requestId": request_id,
            "error": code,
            "message": message,
        }),
    )
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

fn should_send_sampling(compatibility: ProviderThinkingCompatibility) -> bool {
    compatibility != ProviderThinkingCompatibility::DeepSeek
}

fn provider_thinking_compatibility(profile: &ResolvedLlmProfile) -> ProviderThinkingCompatibility {
    let flavor = profile
        .provider_flavor
        .as_deref()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !flavor.is_empty() {
        return match flavor.as_str() {
            "deepseek" => ProviderThinkingCompatibility::DeepSeek,
            "zhipu" | "glm" => ProviderThinkingCompatibility::GlmDeferred,
            "kimi" | "moonshot" => ProviderThinkingCompatibility::KimiDeferred,
            _ => ProviderThinkingCompatibility::Generic,
        };
    }
    let base_url = profile.base_url.as_deref().unwrap_or_default();
    let model = profile.model.to_ascii_lowercase();
    let base = base_url.to_ascii_lowercase();
    if model.contains("deepseek") || base.contains("deepseek") {
        return ProviderThinkingCompatibility::DeepSeek;
    }
    if model.contains("glm")
        || model.contains("zhipu")
        || base.contains("bigmodel")
        || base.contains("zhipu")
    {
        return ProviderThinkingCompatibility::GlmDeferred;
    }
    if model.contains("kimi")
        || model.contains("moonshot")
        || base.contains("kimi")
        || base.contains("moonshot")
    {
        return ProviderThinkingCompatibility::KimiDeferred;
    }
    ProviderThinkingCompatibility::Generic
}

fn validate_provider_thinking_continuation(
    profile: &ResolvedLlmProfile,
    messages: &[Value],
) -> Result<(), String> {
    if provider_thinking_compatibility(profile) != ProviderThinkingCompatibility::DeepSeek
        || !profile
            .thinking
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("enabled"))
            .unwrap_or(false)
    {
        return Ok(());
    }
    for (index, message) in messages.iter().enumerate() {
        let Some(record) = message.as_object() else {
            continue;
        };
        if record.get("role").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let has_tool_calls = record
            .get("tool_calls")
            .or_else(|| record.get("toolCalls"))
            .and_then(Value::as_array)
            .map(|calls| !calls.is_empty())
            .unwrap_or(false);
        if !has_tool_calls {
            continue;
        }
        let reasoning_content = record
            .get("reasoning_content")
            .or_else(|| record.get("reasoningContent"));
        if !matches!(reasoning_content, Some(Value::String(_))) {
            return Err(format!(
                "DeepSeek thinking assistant tool-call message at index {index} must include string reasoning_content"
            ));
        }
    }
    Ok(())
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
