use crate::prelude::*;
use crate::*;
use axum::body::Body;
use bytes::Bytes;
use deepcode_kernel_abi::v2::{CommandRequestId, RunId};
use deepcode_kernel_abi::v2_command::{
    KernelCommandEnvelopeV2, KernelCommandResponseEnvelopeV2, KernelCommandV2,
    KernelFactDomainProjectionV2, KernelFactsQueryScopedV2, KernelReplyV2,
};
use deepcode_kernel_abi::{RunCapabilityV2, ToolIdV2};
use deepcode_kernel_runtime::v2::KernelSessionServiceV2;
use std::collections::{HashMap, HashSet};
use std::convert::Infallible;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedLlmProfile {
    pub(crate) id: String,
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

const LLM_PROFILE_PROBE_TIMEOUT: Duration = Duration::from_secs(60);

fn local_secret_ref_key(secret_ref: &str) -> Option<&str> {
    if secret_ref.trim() != secret_ref {
        return None;
    }
    let key = secret_ref.strip_prefix("local-secret:")?;
    (!key.is_empty() && key.trim() == key).then_some(key)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderThinkingCompatibility {
    DeepSeek,
    GlmDeferred,
    Generic,
}

pub(crate) fn llm_profile_value_is_enabled(profile: &Value) -> bool {
    llm_profile_value_is_current(profile)
        && profile.get("enabled").and_then(Value::as_bool) == Some(true)
        && profile.get("thinking").and_then(Value::as_str) == Some("enabled")
}

pub(crate) fn llm_profile_value_is_current(profile: &Value) -> bool {
    const FIELDS: &[&str] = &[
        "id",
        "name",
        "kind",
        "reasoningTransport",
        "providerFlavor",
        "baseUrl",
        "model",
        "contextWindowTokens",
        "maxOutputTokens",
        "temperature",
        "reasoningEffort",
        "thinking",
        "secretRef",
        "enabled",
    ];
    let Some(profile) = profile.as_object() else {
        return false;
    };
    let optional_exact_string = |field: &str| {
        profile.get(field).is_none_or(|value| {
            value
                .as_str()
                .is_some_and(|value| !value.is_empty() && value.trim() == value)
        })
    };
    let optional_positive_integer = |field: &str| {
        profile.get(field).is_none_or(|value| {
            value
                .as_u64()
                .is_some_and(|value| value > 0 && value <= 1_000_000_000)
        })
    };
    profile.keys().all(|field| FIELDS.contains(&field.as_str()))
        && profile
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.trim() == value)
        && profile
            .get("name")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.trim() == value)
        && profile
            .get("model")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.is_empty() && value.trim() == value)
        && profile.get("enabled").and_then(Value::as_bool).is_some()
        && matches!(
            profile.get("providerFlavor").and_then(Value::as_str),
            Some("openai" | "deepseek" | "zhipu")
        )
        && optional_exact_string("baseUrl")
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
        && matches!(
            (
                profile.get("kind").and_then(Value::as_str),
                profile.get("reasoningTransport").and_then(Value::as_str),
            ),
            (Some("openaiCompatible"), Some("openaiPlaintext"))
                | (Some("anthropic"), Some("anthropicPlaintext"))
                | (Some("ollama"), Some("ollamaPlaintext"))
        )
}

pub(crate) fn llm_profile_store_is_current(config: &Value) -> bool {
    const FIELDS: &[&str] = &["profiles", "defaultProfileId", "storePath"];
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
    let mut profile_ids = HashSet::with_capacity(profiles.len());
    if profiles.iter().any(|profile| {
        !llm_profile_value_is_current(profile)
            || !profile_ids.insert(
                profile
                    .get("id")
                    .and_then(Value::as_str)
                    .expect("current LLM Profile id")
                    .to_string(),
            )
    }) {
        return false;
    }
    let default_profile_is_current = match config.get("defaultProfileId") {
        Some(Value::Null) => true,
        Some(Value::String(profile_id))
            if !profile_id.is_empty() && profile_id.trim() == profile_id =>
        {
            profile_ids.contains(profile_id)
        }
        _ => false,
    };
    default_profile_is_current
        && matches!(
            config.get("storePath"),
            Some(Value::Null | Value::String(_))
        )
}

pub(crate) fn effective_llm_profile_is_enabled(
    state: &AppState,
    config: &Value,
    profile_id: &str,
) -> Result<bool, ProviderTraceErrorV1> {
    if !llm_profile_store_is_current(config) {
        return Ok(false);
    }
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
    if !llm_profile_store_is_current(config) {
        return Ok(None);
    }
    let default_id = config.get("defaultProfileId").and_then(Value::as_str);
    if let Some(default_id) = default_id {
        if effective_llm_profile_is_enabled(state, config, default_id)? {
            return Ok(Some(default_id.to_string()));
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

pub(crate) fn resolve_llm_profile(
    gui: &GuiState,
    profile_id: Option<&str>,
) -> Result<ResolvedLlmProfile, String> {
    if !llm_profile_store_is_current(&gui.llm_profiles) {
        return Err("LLM Profile store does not use the current schema".to_string());
    }
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
    let profile = match selected_id {
        Some(id) => profiles
            .iter()
            .find(|profile| profile.get("id").and_then(Value::as_str) == Some(id))
            .ok_or_else(|| format!("Selected LLM profile `{id}` does not exist"))?,
        None => return Err("No default LLM profile is configured".to_string()),
    };

    if profile.get("enabled").and_then(Value::as_bool) != Some(true) {
        return Err("Selected LLM profile is disabled".to_string());
    }
    if !llm_profile_value_is_current(profile) {
        return Err("Selected LLM profile does not use the current profile schema".to_string());
    }
    if profile.get("thinking").and_then(Value::as_str) != Some("enabled") {
        return Err("Selected LLM profile must have plaintext thinking enabled".to_string());
    }

    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .expect("current LLM Profile id")
        .to_string();
    let kind = profile
        .get("kind")
        .and_then(Value::as_str)
        .expect("current LLM Profile kind")
        .to_string();
    let secret_store = match read_json_file(&gui.paths.llm_secrets_path) {
        Some(Value::Object(store)) => store,
        Some(_) => {
            return Err("LLM secret store must be a JSON object".to_string());
        }
        None if gui.paths.llm_secrets_path.exists() => {
            return Err("LLM secret store exists but could not be decoded".to_string());
        }
        None => serde_json::Map::new(),
    };
    let api_key = match profile.get("secretRef").and_then(Value::as_str) {
        Some(secret_ref) => {
            let secret_key = local_secret_ref_key(secret_ref)
                .ok_or_else(|| "Selected LLM profile has an invalid secretRef".to_string())?;
            let secret = secret_store
                .get(secret_key)
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Selected LLM profile secretRef does not resolve to a non-empty local secret"
                        .to_string()
                })?;
            Some(secret.to_string())
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
        id: id.clone(),
        kind,
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
            .expect("current LLM Profile model")
            .to_string(),
        max_output_tokens: profile.get("maxOutputTokens").and_then(token_limit_u32),
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
        .and_then(|options| options.get("deepcode"))
        .and_then(|deepcode| deepcode.get("expectedProviderIdentity"))
    else {
        return Ok(());
    };
    let expectation = expectation
        .as_object()
        .ok_or_else(|| "DeepCode expected Provider identity must be an object.".to_string())?;
    let expected_profile_id = required_provider_identity_field(expectation, "profileId")?;
    let expected_provider = required_provider_identity_field(expectation, "provider")?;
    let expected_model = required_provider_identity_field(expectation, "model")?;
    let actual_provider = required_resolved_provider_flavor(profile);
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
    field: &str,
) -> Result<&'a str, String> {
    expectation
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.trim() == *value)
        .ok_or_else(|| format!("DeepCode expected Provider identity requires non-empty `{field}`."))
}

fn required_resolved_provider_flavor(profile: &ResolvedLlmProfile) -> &str {
    profile
        .provider_flavor
        .as_deref()
        .expect("current LLM Profile providerFlavor")
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
    if let Some(reasoning) = record
        .get("reasoning_content")
        .or_else(|| record.get("reasoningContent"))
        .or_else(|| record.get("reasoning"))
        .and_then(Value::as_str)
    {
        let field = if thinking_compatibility == ProviderThinkingCompatibility::DeepSeek
            || record.contains_key("reasoning_content")
            || record.contains_key("reasoningContent")
        {
            "reasoning_content"
        } else {
            "reasoning"
        };
        message[field] = json!(reasoning);
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
    pub(crate) kernel_service: KernelSessionServiceV2,
    pub(crate) run_capability: RunCapabilityV2,
    pub(crate) admission: SessionProviderTurnAdmissionV2,
}

struct ProviderCompletedTerminalInputV3 {
    native_completion: Value,
    reasoning_transport: String,
    reasoning_digest: String,
    response_digest: String,
    provider_result: Value,
    ordered_items: Vec<Value>,
}

struct DurableProviderTurnTraceV3 {
    store: SessionKernelV2Store,
    dispatch: SessionProviderTurnDispatchReceiptV3,
    trace: ProviderTraceWriterV1,
    terminal_committed: bool,
}

impl DurableProviderTurnTraceV3 {
    fn new(store: SessionKernelV2Store, commit: SessionProviderTurnDispatchCommitV3) -> Self {
        Self {
            store,
            dispatch: commit.receipt,
            trace: commit.trace,
            terminal_committed: false,
        }
    }

    fn finish_noncompleted(
        &mut self,
        terminal_kind: SessionProviderTurnTerminalKindV3,
        trace_kind: ProviderTraceTerminalKindV1,
        reason_code: &str,
    ) -> Result<ProviderTraceMetadataV1, ProviderTraceErrorV1> {
        let metadata = self.trace.finish(ProviderTraceTerminalV1 {
            kind: trace_kind,
            reason_code: Some(reason_code.to_string()),
        })?;
        self.store.commit_provider_terminal(
            &self.dispatch,
            &metadata,
            SessionProviderTurnTerminalCommitV3 {
                terminal_kind,
                reason_code: Some(reason_code.to_string()),
                response_digest: None,
                completion: None,
                provider_result: None,
                ordered_items: Vec::new(),
            },
        )?;
        self.terminal_committed = true;
        Ok(metadata)
    }

    fn finish_completed(
        &mut self,
        input: ProviderCompletedTerminalInputV3,
    ) -> Result<(ProviderTraceMetadataV1, Value), ProviderTraceErrorV1> {
        let metadata = self.trace.finish(ProviderTraceTerminalV1 {
            kind: ProviderTraceTerminalKindV1::Completed,
            reason_code: None,
        })?;
        let completion = json!({
            "schemaVersion": PROVIDER_STREAM_TERMINAL_SCHEMA_V1,
            "nativeCompletion": input.native_completion,
            "reasoningPresent": true,
            "reasoningTransport": input.reasoning_transport,
            "reasoningDigest": input.reasoning_digest,
            "responseDigest": input.response_digest,
            "trace": {
                "sealed": true,
                "sealDigest": metadata.seal_digest,
                "terminalDigest": metadata.terminal_digest,
                "recordCount": metadata.record_count,
            }
        });
        self.store.commit_provider_terminal(
            &self.dispatch,
            &metadata,
            SessionProviderTurnTerminalCommitV3 {
                terminal_kind: SessionProviderTurnTerminalKindV3::Completed,
                reason_code: None,
                response_digest: Some(input.response_digest),
                completion: Some(completion.clone()),
                provider_result: Some(input.provider_result),
                ordered_items: input.ordered_items,
            },
        )?;
        self.terminal_committed = true;
        Ok((metadata, completion))
    }
}

impl std::ops::Deref for DurableProviderTurnTraceV3 {
    type Target = ProviderTraceWriterV1;

    fn deref(&self) -> &Self::Target {
        &self.trace
    }
}

impl std::ops::DerefMut for DurableProviderTurnTraceV3 {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.trace
    }
}

impl Drop for DurableProviderTurnTraceV3 {
    fn drop(&mut self) {
        if self.terminal_committed {
            return;
        }
        let _ = self.finish_noncompleted(
            SessionProviderTurnTerminalKindV3::Cancelled,
            ProviderTraceTerminalKindV1::Cancelled,
            "provider_stream_cancelled",
        );
    }
}

#[derive(Default)]
struct ProviderSealedItemsBuilderV3 {
    positions: Vec<ProviderSealedItemPositionV3>,
    tools: std::collections::BTreeMap<i64, ProviderSealedToolV3>,
}

enum ProviderSealedItemPositionV3 {
    Text { phase: &'static str, text: String },
    Tool { native_index: i64 },
}

#[derive(Default)]
struct ProviderSealedToolV3 {
    call_id: String,
    name: String,
    arguments: String,
}

impl ProviderSealedItemsBuilderV3 {
    fn ingest_public_event(
        &mut self,
        event: &str,
        data: &Value,
    ) -> Result<(), ProviderNativeStreamTransportErrorV1> {
        match event {
            "provider_delta" | "provider_commentary_delta" | "provider_final_delta" => {
                let chunk = data.get("chunk").ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                })?;
                let text = chunk
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                    })?;
                let phase = match event {
                    "provider_commentary_delta" => "commentary",
                    "provider_final_delta" => "final_answer",
                    _ => match chunk.get("providerPhase").and_then(Value::as_str) {
                        Some("commentary") => "commentary",
                        Some("final_answer") => "final_answer",
                        None => "unknown",
                        Some(_) => {
                            return Err(ProviderNativeStreamTransportErrorV1::new(
                                "provider_ordered_items_invalid",
                            ))
                        }
                    },
                };
                if let Some(ProviderSealedItemPositionV3::Text {
                    phase: previous_phase,
                    text: previous_text,
                }) = self.positions.last_mut()
                {
                    if *previous_phase == phase {
                        previous_text.push_str(text);
                        return Ok(());
                    }
                }
                self.positions.push(ProviderSealedItemPositionV3::Text {
                    phase,
                    text: text.to_string(),
                });
            }
            "provider_tool_call_delta" => {
                let chunk = data.get("chunk").ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                })?;
                let delta = chunk.get("toolCallDelta").ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                })?;
                let native_index = delta
                    .get("index")
                    .or_else(|| chunk.get("index"))
                    .and_then(Value::as_i64)
                    .filter(|index| *index >= 0)
                    .ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                    })?;
                if !self.tools.contains_key(&native_index) {
                    self.positions
                        .push(ProviderSealedItemPositionV3::Tool { native_index });
                }
                let tool = self.tools.entry(native_index).or_default();
                if let Some(call_id) = delta
                    .get("id")
                    .or_else(|| chunk.get("callId"))
                    .and_then(Value::as_str)
                {
                    if !tool.call_id.is_empty() && tool.call_id != call_id {
                        return Err(ProviderNativeStreamTransportErrorV1::new(
                            "provider_ordered_items_invalid",
                        ));
                    }
                    tool.call_id = call_id.to_string();
                }
                if let Some(name) = delta.get("name").and_then(Value::as_str) {
                    if !tool.name.is_empty() && tool.name != name {
                        return Err(ProviderNativeStreamTransportErrorV1::new(
                            "provider_ordered_items_invalid",
                        ));
                    }
                    tool.name = name.to_string();
                }
                if let Some(arguments) = delta.get("argumentsDelta").and_then(Value::as_str) {
                    tool.arguments.push_str(arguments);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn materialize(
        self,
        completed_calls: &[LlmToolCall],
    ) -> Result<Vec<Value>, ProviderNativeStreamTransportErrorV1> {
        if self.tools.len() != completed_calls.len() {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_ordered_items_invalid",
            ));
        }
        let mut items = Vec::with_capacity(self.positions.len());
        let mut tool_ordinal = 0usize;
        for position in self.positions {
            match position {
                ProviderSealedItemPositionV3::Text { phase, text } => {
                    items.push(json!({
                        "kind": "text",
                        "phase": phase,
                        "text": text,
                    }));
                }
                ProviderSealedItemPositionV3::Tool { native_index } => {
                    let tool = self.tools.get(&native_index).ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                    })?;
                    let completed = completed_calls.get(tool_ordinal).ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new("provider_ordered_items_invalid")
                    })?;
                    let arguments = if tool.arguments.trim().is_empty() {
                        "{}".to_string()
                    } else {
                        tool.arguments.clone()
                    };
                    let parsed_arguments =
                        serde_json::from_str::<Value>(&arguments).map_err(|_| {
                            ProviderNativeStreamTransportErrorV1::new(
                                "provider_ordered_items_invalid",
                            )
                        })?;
                    if tool.call_id != completed.id || parsed_arguments != completed.arguments {
                        return Err(ProviderNativeStreamTransportErrorV1::new(
                            "provider_ordered_items_invalid",
                        ));
                    }
                    items.push(json!({
                        "kind": "toolCall",
                        "index": tool_ordinal,
                        "callId": tool.call_id,
                        "name": tool.name,
                        "arguments": arguments,
                    }));
                    tool_ordinal += 1;
                }
            }
        }
        Ok(items)
    }
}

struct ProviderWireEnvelopeV1 {
    raw: Vec<u8>,
    payload: Option<Vec<u8>>,
}

struct ProviderEnvelopeFramerV1 {
    kind: ProviderNativeStreamKindV1,
    buffer: Vec<u8>,
}

#[derive(Debug)]
struct ProviderEnvelopeFramerErrorV1 {
    code: &'static str,
    message: String,
}

impl ProviderEnvelopeFramerErrorV1 {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
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
            "provider_trace_envelope_too_large" => {
                "Provider response envelope exceeded the structural size limit."
            }
            "provider_request_secret_forbidden" => {
                "Provider request contains forbidden structured secret or capability material."
            }
            "provider_dispatch_request_identity_invalid" => {
                "Provider request does not preserve the exact durable Session turn identity."
            }
            "provider_continuation_invalid" => {
                "Provider continuation evidence is missing, stale, or inconsistent."
            }
            "provider_continuation_result_missing" => {
                "Provider continuation is missing an exact completed Kernel tool result."
            }
            "provider_continuation_native_history_invalid" => {
                "Provider continuation cannot reconstruct the required native history."
            }
            "provider_probe_timeout" => {
                "Provider probe did not reach a validated native completion before its deadline."
            }
            "provider_http_status_failed" => "Provider returned a non-success response.",
            "provider_transport_failed" => {
                "Provider transport ended before a validated response was committed."
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

    fn push(
        &mut self,
        chunk: &[u8],
    ) -> Result<Vec<ProviderWireEnvelopeV1>, ProviderEnvelopeFramerErrorV1> {
        self.buffer.extend_from_slice(chunk);
        let mut envelopes = Vec::new();
        match self.kind {
            ProviderNativeStreamKindV1::OpenAiCompatible
            | ProviderNativeStreamKindV1::Anthropic => {
                while let Some((end, delimiter_len)) = sse_envelope_boundary(&self.buffer) {
                    let raw = self.buffer.drain(..end + delimiter_len).collect::<Vec<_>>();
                    ensure_provider_envelope_size(&raw)?;
                    let payload = sse_data_payload(&raw).map_err(|message| {
                        ProviderEnvelopeFramerErrorV1::new(
                            "provider_stream_envelope_invalid",
                            message,
                        )
                    })?;
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
            return Err(provider_envelope_too_large());
        }
        Ok(envelopes)
    }

    fn finish(&mut self) -> Result<Vec<ProviderWireEnvelopeV1>, ProviderEnvelopeFramerErrorV1> {
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
            | ProviderNativeStreamKindV1::Anthropic => Err(ProviderEnvelopeFramerErrorV1::new(
                "provider_stream_envelope_incomplete",
                "Provider SSE stream ended with an incomplete source envelope",
            )),
        }
    }

    fn ensure_empty_after_terminal(&mut self) -> Result<(), ProviderEnvelopeFramerErrorV1> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            self.buffer.clear();
            Ok(())
        } else {
            Err(ProviderEnvelopeFramerErrorV1::new(
                "provider_stream_data_after_terminal",
                "Provider emitted an incomplete envelope after its native terminal marker"
                    .to_string(),
            ))
        }
    }
}

fn provider_envelope_too_large() -> ProviderEnvelopeFramerErrorV1 {
    ProviderEnvelopeFramerErrorV1::new(
        "provider_trace_envelope_too_large",
        format!(
            "Provider envelope exceeded the {} byte hard limit",
            PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1
        ),
    )
}

fn ensure_provider_envelope_size(raw: &[u8]) -> Result<(), ProviderEnvelopeFramerErrorV1> {
    if raw.len() > PROVIDER_TRACE_ENVELOPE_HARD_LIMIT_V1 {
        return Err(provider_envelope_too_large());
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

#[derive(Debug, Clone)]
enum ProviderContinuationAssistantItemV1 {
    Text(String),
    Tool(usize),
}

#[derive(Debug, Clone)]
struct ProviderContinuationToolV1 {
    call_id: String,
    wire_name: String,
    internal_name: String,
    arguments: Value,
    output: Value,
}

#[derive(Debug, Clone)]
struct ProviderNativeContinuationV1 {
    reasoning: String,
    assistant_items: Vec<ProviderContinuationAssistantItemV1>,
    tools: Vec<ProviderContinuationToolV1>,
    anthropic_signature: Option<String>,
    openai_reasoning_field: Option<&'static str>,
}

fn inject_provider_native_continuation(
    profile: &ResolvedLlmProfile,
    request_envelope: &mut Value,
    trace_store: &ProviderTraceStoreV1,
    current_identity: &ProviderTraceIdentityV1,
    dispatch_authority: &ProviderStreamDispatchAuthorityV1,
) -> Result<(), ProviderNativeStreamTransportErrorV1> {
    let Some(parent_request_value) = request_envelope.get("parentRequestId") else {
        return Ok(());
    };
    let parent_request_id = parent_request_value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
        })?;
    if current_identity.purpose != ProviderTracePurposeV1::Continuation
        || parent_request_id == current_identity.provider_turn_id
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_invalid",
        ));
    }

    let recovery = trace_store
        .verified_terminal_recovery(&current_identity.session_id, parent_request_id)
        .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid"))?;
    let parent_identity = &recovery.metadata;
    if parent_identity.session_id != current_identity.session_id
        || parent_identity.run_id != current_identity.run_id
        || parent_identity.user_turn_id != current_identity.user_turn_id
        || parent_identity.provider_turn_id != parent_request_id
        || parent_identity.provider_kind != current_identity.provider_kind
        || parent_identity.model != current_identity.model
        || parent_identity.profile_id != current_identity.profile_id
        || parent_identity.profile_revision != current_identity.profile_revision
        || parent_identity.control_epoch != current_identity.control_epoch
        || parent_identity.purpose == ProviderTracePurposeV1::FinalAnswer
        || parent_identity.provider_kind != required_resolved_provider_flavor(profile)
        || parent_identity.model != profile.model
        || parent_identity.profile_id != profile.id
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_invalid",
        ));
    }
    let completed = recovery.completed.ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
    })?;
    if completed.reasoning_transport != resolved_reasoning_transport(profile)
        || completed
            .native_completion
            .get("providerKind")
            .and_then(Value::as_str)
            != Some(profile.kind.as_str())
        || completed
            .provider_result
            .get("providerProfileId")
            .and_then(Value::as_str)
            != Some(profile.id.as_str())
        || completed
            .provider_result
            .get("model")
            .and_then(Value::as_str)
            != Some(profile.model.as_str())
        || completed
            .provider_result
            .get("provider")
            .and_then(Value::as_str)
            != Some(required_resolved_provider_flavor(profile))
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_invalid",
        ));
    }

    let parent_binding =
        provider_dispatch_binding_from_exact_request(&completed.exact_request_body)?;
    if parent_binding.provider_turn_id != parent_request_id
        || parent_binding.run_id != current_identity.run_id
        || parent_binding.control_epoch != current_identity.control_epoch
        || parent_binding.current_input_id != current_identity.user_turn_id
        || parent_binding.purpose != parent_identity.purpose
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_invalid",
        ));
    }
    let parent_request = serde_json::from_slice::<Value>(&completed.exact_request_body)
        .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid"))?;
    let parent_messages = parent_request
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
        })?;
    let parent_input = exact_provider_context_message(
        parent_messages,
        "deepcode.session.provider-current-input.v2",
    )?;
    let current_messages = request_envelope
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
        })?;
    let current_input = exact_provider_context_message(
        current_messages,
        "deepcode.session.provider-current-input.v2",
    )?;
    validate_provider_continuation_admission(current_identity, &current_input, dispatch_authority)?;
    let operation_ids = provider_native_continuation_operation_ids(
        parent_request_id,
        current_identity,
        &parent_input,
        &completed.ordered_items,
    )?;
    let tool_outputs = query_canonical_provider_tool_outputs(
        current_identity,
        dispatch_authority,
        &operation_ids,
    )?;
    let mut continuation = provider_native_continuation_from_evidence(
        parent_request_id,
        current_identity,
        &parent_input,
        completed.reasoning,
        &completed.ordered_items,
        &operation_ids,
        &tool_outputs,
    )?;
    if profile.kind == "anthropic" {
        continuation.anthropic_signature = Some(anthropic_thinking_signature(
            &completed.raw_upstream_envelopes,
            &continuation.reasoning,
        )?);
    } else if profile.kind == "openaiCompatible" {
        continuation.openai_reasoning_field = Some(openai_reasoning_field(
            &completed.raw_upstream_envelopes,
            &continuation.reasoning,
        )?);
    }
    let provider_kind = ProviderNativeStreamKindV1::from_profile_kind(&profile.kind)
        .ok_or_else(|| ProviderNativeStreamTransportErrorV1::new("ProviderUnsupportedKind"))?;
    let native_messages = provider_native_continuation_messages(provider_kind, continuation)?;
    request_envelope
        .get_mut("messages")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid"))?
        .extend(native_messages);
    Ok(())
}

fn provider_native_continuation_from_evidence(
    parent_request_id: &str,
    current_identity: &ProviderTraceIdentityV1,
    parent_input: &Value,
    reasoning: String,
    ordered_items: &[Value],
    operation_ids: &[String],
    tool_outputs: &HashMap<String, Value>,
) -> Result<ProviderNativeContinuationV1, ProviderNativeStreamTransportErrorV1> {
    let mut assistant_items = Vec::new();
    let mut tools = Vec::new();
    let mut call_ids = std::collections::HashSet::new();
    for item in ordered_items {
        match item.get("kind").and_then(Value::as_str) {
            Some("text") => {
                let text = item.get("text").and_then(Value::as_str).ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    )
                })?;
                if !text.is_empty() {
                    assistant_items
                        .push(ProviderContinuationAssistantItemV1::Text(text.to_string()));
                }
            }
            Some("toolCall") => {
                let index = item.get("index").and_then(Value::as_u64).ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    )
                })?;
                if index != u64::try_from(tools.len()).unwrap_or(u64::MAX) {
                    return Err(ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    ));
                }
                let call_id = required_continuation_text(item, "callId")?;
                let wire_name = required_continuation_text(item, "name")?;
                if !call_ids.insert(call_id.clone()) {
                    return Err(ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    ));
                }
                let arguments_text = required_continuation_text(item, "arguments")?;
                let arguments = serde_json::from_str::<Value>(&arguments_text).map_err(|_| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    )
                })?;
                let internal_name = internal_tool_name(&wire_name);
                let tool_id = provider_wire_tool_id_v2(&wire_name)?;
                let operation_id = operation_ids.get(tools.len()).ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    )
                })?;
                let expected_operation_id = provider_continuation_operation_id(
                    current_identity,
                    parent_request_id,
                    parent_input,
                    &call_id,
                    &tool_id,
                    tools.len(),
                    operation_ids.len(),
                )?;
                if operation_id != &expected_operation_id {
                    return Err(ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    ));
                }
                let output = tool_outputs.get(operation_id).cloned().ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_result_missing",
                    )
                })?;
                let tool_index = tools.len();
                tools.push(ProviderContinuationToolV1 {
                    call_id,
                    wire_name,
                    internal_name,
                    arguments,
                    output,
                });
                assistant_items.push(ProviderContinuationAssistantItemV1::Tool(tool_index));
            }
            _ => {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_native_history_invalid",
                ));
            }
        }
    }
    if tools.len() != operation_ids.len()
        || tool_outputs.len() != operation_ids.len()
        || reasoning.trim().is_empty()
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }
    Ok(ProviderNativeContinuationV1 {
        reasoning,
        assistant_items,
        tools,
        anthropic_signature: None,
        openai_reasoning_field: None,
    })
}

fn required_continuation_text(
    value: &Value,
    field: &'static str,
) -> Result<String, ProviderNativeStreamTransportErrorV1> {
    value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })
}

fn provider_continuation_operation_id(
    current_identity: &ProviderTraceIdentityV1,
    parent_request_id: &str,
    parent_input: &Value,
    call_id: &str,
    tool_id: &str,
    zero_based_index: usize,
    call_count: usize,
) -> Result<String, ProviderNativeStreamTransportErrorV1> {
    let target = parent_input
        .get("target")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
        })?;
    let kind = target.get("kind").and_then(Value::as_str).ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
    })?;
    if kind == "contextRead" && call_count == 1 {
        return target
            .get("operationId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
            });
    }
    let authority_key = match kind {
        "planning" => format!("planning:{tool_id}"),
        "planAction" => format!(
            "planAction:{}",
            target
                .get("planActionId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
                })?
        ),
        "contextRead" => format!(
            "contextRead:{}:{}:{}",
            target
                .get("operationId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
                })?,
            target
                .get("idempotencyKey")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
                })?,
            zero_based_index + 1,
        ),
        _ => {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_invalid",
            ));
        }
    };
    let digest = crate::host_v2_storage::canonical_sha256(&json!({
        "runId": current_identity.run_id,
        "controlEpoch": current_identity.control_epoch,
        "providerTurnId": parent_request_id,
        "callIdentity": format!("native:{call_id}"),
        "authorityKey": authority_key,
    }))
    .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid"))?;
    let suffix = digest.strip_prefix("sha256:").ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid")
    })?;
    Ok(format!("operation-{suffix}"))
}

fn validate_provider_continuation_admission(
    current_identity: &ProviderTraceIdentityV1,
    current_input: &Value,
    dispatch_authority: &ProviderStreamDispatchAuthorityV1,
) -> Result<(), ProviderNativeStreamTransportErrorV1> {
    let admission = &dispatch_authority.admission;
    let current_input_digest = crate::host_v2_storage::canonical_sha256(current_input)
        .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid"))?;
    if admission.provider_turn_id != current_identity.provider_turn_id
        || admission.purpose != ProviderTracePurposeV1::Continuation
        || admission.control_epoch != current_identity.control_epoch
        || admission.current_input_id != current_identity.user_turn_id
        || admission.current_input_digest != current_input_digest
        || current_input.get("providerTurnId").and_then(Value::as_str)
            != Some(current_identity.provider_turn_id.as_str())
        || current_input.get("runId").and_then(Value::as_str)
            != Some(current_identity.run_id.as_str())
        || current_input.get("controlEpoch").and_then(Value::as_u64)
            != Some(current_identity.control_epoch)
        || current_input
            .get("currentInput")
            .and_then(|value| value.get("inputId"))
            .and_then(Value::as_str)
            != Some(current_identity.user_turn_id.as_str())
        || current_input.get("purpose").and_then(Value::as_str) != Some("continuation")
    {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_invalid",
        ));
    }
    Ok(())
}

fn provider_native_continuation_operation_ids(
    parent_request_id: &str,
    current_identity: &ProviderTraceIdentityV1,
    parent_input: &Value,
    ordered_items: &[Value],
) -> Result<Vec<String>, ProviderNativeStreamTransportErrorV1> {
    let call_count = ordered_items
        .iter()
        .filter(|item| item.get("kind").and_then(Value::as_str) == Some("toolCall"))
        .count();
    if call_count == 0 || call_count > 32 {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }
    let mut call_ids = HashSet::with_capacity(call_count);
    let mut operation_ids = Vec::with_capacity(call_count);
    let mut unique_operation_ids = HashSet::with_capacity(call_count);
    for item in ordered_items {
        if item.get("kind").and_then(Value::as_str) != Some("toolCall") {
            continue;
        }
        let index = item.get("index").and_then(Value::as_u64).ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?;
        if index != u64::try_from(operation_ids.len()).unwrap_or(u64::MAX) {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            ));
        }
        let call_id = required_continuation_text(item, "callId")?;
        let wire_name = required_continuation_text(item, "name")?;
        let tool_id = provider_wire_tool_id_v2(&wire_name)?;
        let arguments = required_continuation_text(item, "arguments")?;
        serde_json::from_str::<Value>(&arguments).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?;
        if !call_ids.insert(call_id.clone()) {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            ));
        }
        let operation_id = provider_continuation_operation_id(
            current_identity,
            parent_request_id,
            parent_input,
            &call_id,
            &tool_id,
            operation_ids.len(),
            call_count,
        )?;
        if !unique_operation_ids.insert(operation_id.clone()) {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            ));
        }
        operation_ids.push(operation_id);
    }
    Ok(operation_ids)
}

fn query_canonical_provider_tool_outputs(
    current_identity: &ProviderTraceIdentityV1,
    dispatch_authority: &ProviderStreamDispatchAuthorityV1,
    operation_ids: &[String],
) -> Result<HashMap<String, Value>, ProviderNativeStreamTransportErrorV1> {
    let run_id = RunId::new(current_identity.run_id.clone())
        .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_continuation_invalid"))?;
    let expected = operation_ids.iter().cloned().collect::<HashSet<_>>();
    if expected.len() != operation_ids.len() || expected.is_empty() {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }

    let mut outputs = HashMap::with_capacity(expected.len());
    let mut output_bytes = 0_usize;
    let mut after_ledger_sequence = 0_u64;
    let mut continuation = None;
    let mut snapshot_high_water = None;
    loop {
        let request_id = next_provider_facts_request_id()?;
        let envelope = KernelCommandEnvelopeV2::new(
            request_id.clone(),
            KernelCommandV2::KernelFactsQueryScoped(KernelFactsQueryScopedV2 {
                run_id: run_id.clone(),
                after_ledger_sequence,
                limit: 1_000,
                continuation,
            }),
        );
        let page = match dispatch_authority
            .kernel_service
            .handle_session_command(envelope, &dispatch_authority.run_capability)
        {
            KernelCommandResponseEnvelopeV2::Correlated {
                request_id: response_request_id,
                reply: KernelReplyV2::KernelFactsProjected(page),
                ..
            } if response_request_id == request_id => page,
            _ => {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_result_missing",
                ))
            }
        };
        page.validate().map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new("provider_continuation_result_missing")
        })?;
        if page.requested_after_ledger_sequence != after_ledger_sequence
            || snapshot_high_water.is_some_and(|expected| expected != page.snapshot_high_water)
        {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_result_missing",
            ));
        }
        snapshot_high_water.get_or_insert(page.snapshot_high_water);

        for fact in page.facts {
            if fact.domain != KernelFactDomainProjectionV2::Invocation
                || fact.fact_kind != "toolCompleted"
                || fact.lineage.run_id != run_id
                || fact
                    .lineage
                    .control_epoch
                    .is_none_or(|epoch| epoch.get() != current_identity.control_epoch)
            {
                continue;
            }
            let Some(operation_id) = fact
                .lineage
                .operation_id
                .as_ref()
                .map(ToString::to_string)
                .filter(|operation_id| expected.contains(operation_id))
            else {
                continue;
            };
            let output = fact.details.get("output").cloned().ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new("provider_continuation_result_missing")
            })?;
            output_bytes = output_bytes
                .checked_add(
                    serde_json::to_vec(&output)
                        .map_err(|_| {
                            ProviderNativeStreamTransportErrorV1::new(
                                "provider_continuation_result_missing",
                            )
                        })?
                        .len(),
                )
                .filter(|bytes| *bytes <= PROVIDER_TRACE_REQUEST_HARD_LIMIT_V1)
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new("provider_request_too_large")
                })?;
            if outputs.insert(operation_id, output).is_some() {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_result_missing",
                ));
            }
        }

        if !page.has_more {
            if page.next_continuation.is_some()
                || page.next_after_ledger_sequence != page.snapshot_high_water
            {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_result_missing",
                ));
            }
            break;
        }
        if page.next_after_ledger_sequence <= after_ledger_sequence {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_result_missing",
            ));
        }
        after_ledger_sequence = page.next_after_ledger_sequence;
        continuation = page.next_continuation;
        if continuation.is_none() {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_result_missing",
            ));
        }
    }
    if outputs.len() != expected.len() {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_result_missing",
        ));
    }
    Ok(outputs)
}

fn next_provider_facts_request_id() -> Result<CommandRequestId, ProviderNativeStreamTransportErrorV1>
{
    let mut entropy = [0_u8; 16];
    getrandom::fill(&mut entropy).map_err(|_| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_result_missing")
    })?;
    let digest = crate::host_v2_storage::sha256_prefixed(&entropy);
    CommandRequestId::new(format!(
        "provider-native-facts-{}",
        digest.strip_prefix("sha256:").unwrap_or(digest.as_str())
    ))
    .map_err(|_| ProviderNativeStreamTransportErrorV1::new("provider_continuation_result_missing"))
}

fn anthropic_thinking_signature(
    raw_envelopes: &[Vec<u8>],
    expected_reasoning: &str,
) -> Result<String, ProviderNativeStreamTransportErrorV1> {
    let mut thinking_index: Option<i64> = None;
    let mut reasoning = String::new();
    let mut signature = String::new();
    for raw in raw_envelopes {
        let Some(payload) = sse_data_payload(raw).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?
        else {
            continue;
        };
        let value = serde_json::from_slice::<Value>(&payload).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?;
        match value.get("type").and_then(Value::as_str) {
            Some("content_block_start") => {
                let index = value.get("index").and_then(Value::as_i64).ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    )
                })?;
                let block = value
                    .get("content_block")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new(
                            "provider_continuation_native_history_invalid",
                        )
                    })?;
                match block.get("type").and_then(Value::as_str) {
                    Some("thinking") => {
                        if thinking_index.replace(index).is_some() {
                            return Err(ProviderNativeStreamTransportErrorV1::new(
                                "provider_continuation_native_history_invalid",
                            ));
                        }
                        if let Some(initial) = block.get("thinking").and_then(Value::as_str) {
                            reasoning.push_str(initial);
                        }
                        if let Some(initial) = block.get("signature").and_then(Value::as_str) {
                            signature.push_str(initial);
                        }
                    }
                    Some("redacted_thinking") => {
                        return Err(ProviderNativeStreamTransportErrorV1::new(
                            "provider_continuation_native_history_invalid",
                        ));
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let index = value.get("index").and_then(Value::as_i64);
                if index != thinking_index {
                    continue;
                }
                let delta = value
                    .get("delta")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new(
                            "provider_continuation_native_history_invalid",
                        )
                    })?;
                match delta.get("type").and_then(Value::as_str) {
                    Some("thinking_delta") => reasoning.push_str(
                        delta
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ),
                    Some("signature_delta") => signature.push_str(
                        delta
                            .get("signature")
                            .and_then(Value::as_str)
                            .unwrap_or_default(),
                    ),
                    _ => {}
                }
            }
            _ => {}
        }
    }
    if thinking_index.is_none() || reasoning != expected_reasoning || signature.trim().is_empty() {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }
    Ok(signature)
}

fn openai_reasoning_field(
    raw_envelopes: &[Vec<u8>],
    expected_reasoning: &str,
) -> Result<&'static str, ProviderNativeStreamTransportErrorV1> {
    let mut field: Option<&'static str> = None;
    let mut reasoning = String::new();
    for raw in raw_envelopes {
        let Some(payload) = sse_data_payload(raw).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?
        else {
            continue;
        };
        if payload.as_slice() == b"[DONE]" {
            continue;
        }
        let value = serde_json::from_slice::<Value>(&payload).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?;
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_native_history_invalid",
                )
            })?;
        if choices.len() > 1 {
            return Err(ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            ));
        }
        for choice in choices {
            if choice.get("index").and_then(Value::as_i64) != Some(0) {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_native_history_invalid",
                ));
            }
            let delta = choice
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    )
                })?;
            let reasoning_content = delta
                .get("reasoning_content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let generic_reasoning = delta
                .get("reasoning")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let (next_field, chunk) = match (reasoning_content, generic_reasoning) {
                (Some(_), Some(_)) => {
                    return Err(ProviderNativeStreamTransportErrorV1::new(
                        "provider_continuation_native_history_invalid",
                    ));
                }
                (Some(chunk), None) => ("reasoning_content", chunk),
                (None, Some(chunk)) => ("reasoning", chunk),
                (None, None) => continue,
            };
            if field.is_some_and(|existing| existing != next_field) {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_native_history_invalid",
                ));
            }
            field = Some(next_field);
            reasoning.push_str(chunk);
        }
    }
    if reasoning != expected_reasoning {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }
    field.ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_native_history_invalid")
    })
}

fn provider_native_continuation_messages(
    provider_kind: ProviderNativeStreamKindV1,
    continuation: ProviderNativeContinuationV1,
) -> Result<Vec<Value>, ProviderNativeStreamTransportErrorV1> {
    let assistant_text = continuation
        .assistant_items
        .iter()
        .filter_map(|item| match item {
            ProviderContinuationAssistantItemV1::Text(text) => Some(text.as_str()),
            ProviderContinuationAssistantItemV1::Tool(_) => None,
        })
        .collect::<String>();
    match provider_kind {
        ProviderNativeStreamKindV1::OpenAiCompatible => {
            let reasoning_field = continuation.openai_reasoning_field.ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_native_history_invalid",
                )
            })?;
            let mut assistant = json!({
                "role": "assistant",
                "content": assistant_text,
                "toolCalls": continuation.tools.iter().map(|tool| json!({
                    "id": tool.call_id,
                    "name": tool.internal_name,
                    "arguments": tool.arguments,
                })).collect::<Vec<_>>(),
            });
            assistant[reasoning_field] = json!(continuation.reasoning);
            let mut messages = vec![assistant];
            messages.extend(continuation.tools.iter().map(|tool| {
                json!({
                    "role": "tool",
                    "toolCallId": tool.call_id,
                    "content": serde_json::to_string(&tool.output).unwrap_or_default(),
                })
            }));
            Ok(messages)
        }
        ProviderNativeStreamKindV1::Anthropic => {
            let signature = continuation.anthropic_signature.ok_or_else(|| {
                ProviderNativeStreamTransportErrorV1::new(
                    "provider_continuation_native_history_invalid",
                )
            })?;
            let mut content = vec![json!({
                "type": "thinking",
                "thinking": continuation.reasoning,
                "signature": signature,
            })];
            for item in &continuation.assistant_items {
                match item {
                    ProviderContinuationAssistantItemV1::Text(text) => {
                        content.push(json!({ "type": "text", "text": text }));
                    }
                    ProviderContinuationAssistantItemV1::Tool(index) => {
                        let tool = continuation.tools.get(*index).ok_or_else(|| {
                            ProviderNativeStreamTransportErrorV1::new(
                                "provider_continuation_native_history_invalid",
                            )
                        })?;
                        content.push(json!({
                            "type": "tool_use",
                            "id": tool.call_id,
                            "name": tool.wire_name,
                            "input": tool.arguments,
                        }));
                    }
                }
            }
            let tool_results = continuation
                .tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "tool_result",
                        "tool_use_id": tool.call_id,
                        "content": serde_json::to_string(&tool.output).unwrap_or_default(),
                    })
                })
                .collect::<Vec<_>>();
            Ok(vec![
                json!({ "role": "assistant", "content": content }),
                json!({ "role": "user", "content": tool_results }),
            ])
        }
        ProviderNativeStreamKindV1::Ollama => {
            let mut messages = vec![json!({
                "role": "assistant",
                "thinking": continuation.reasoning,
                "content": assistant_text,
                "tool_calls": continuation.tools.iter().enumerate().map(|(index, tool)| json!({
                    "type": "function",
                    "function": {
                        "index": index,
                        "name": tool.wire_name,
                        "arguments": tool.arguments,
                    },
                })).collect::<Vec<_>>(),
            })];
            messages.extend(continuation.tools.iter().map(|tool| {
                json!({
                    "role": "tool",
                    "tool_name": tool.wire_name,
                    "content": serde_json::to_string(&tool.output).unwrap_or_default(),
                })
            }));
            Ok(messages)
        }
    }
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
    let response_format = request_envelope.get("responseFormat").cloned();
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
    let current_input =
        exact_provider_context_message(messages, "deepcode.session.provider-current-input.v2")?;
    let plan_context =
        exact_provider_context_message(messages, "deepcode.session.provider-plan-decision.v2")?;
    let review_context =
        exact_provider_context_message(messages, "deepcode.session.provider-review.v2")?;
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
    let target = current_input
        .get("target")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
        })?;
    let target_kind = required_text(target.get("kind"))?;
    if !matches!(
        target_kind.as_str(),
        "planning" | "planAction" | "contextRead" | "finalAnswer"
    ) {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_dispatch_request_identity_invalid",
        ));
    }
    let plan_revision = plan_context
        .get("plan")
        .map(|plan| required_text(plan.get("planRevision")))
        .transpose()?;
    let review_binding = review_context
        .get("review")
        .map(|review| {
            let revision = review
                .get("revision")
                .and_then(Value::as_u64)
                .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_dispatch_request_identity_invalid",
                    )
                })?;
            let high_water = review
                .get("snapshotHighWater")
                .and_then(Value::as_u64)
                .filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_dispatch_request_identity_invalid",
                    )
                })?;
            let work_authority = review
                .get("workAuthority")
                .ok_or_else(|| {
                    ProviderNativeStreamTransportErrorV1::new(
                        "provider_dispatch_request_identity_invalid",
                    )
                })
                .and_then(|value| {
                    decode_session_work_authority_v3(value).map_err(|_| {
                        ProviderNativeStreamTransportErrorV1::new(
                            "provider_dispatch_request_identity_invalid",
                        )
                    })
                })?;
            Ok::<_, ProviderNativeStreamTransportErrorV1>((revision, high_water, work_authority))
        })
        .transpose()?;
    let (work_authority, review_revision, snapshot_high_water) =
        match (purpose, target_kind.as_str(), review_binding) {
            (
                ProviderTracePurposeV1::FinalAnswer,
                "finalAnswer",
                Some((revision, high_water, review_work_authority)),
            ) => {
                let target_work_authority = target
                    .get("workAuthority")
                    .ok_or_else(|| {
                        ProviderNativeStreamTransportErrorV1::new(
                            "provider_dispatch_request_identity_invalid",
                        )
                    })
                    .and_then(|value| {
                        decode_session_work_authority_v3(value).map_err(|_| {
                            ProviderNativeStreamTransportErrorV1::new(
                                "provider_dispatch_request_identity_invalid",
                            )
                        })
                    })?;
                let target_review_revision = target.get("reviewRevision").and_then(Value::as_u64);
                let target_high_water = target.get("snapshotHighWater").and_then(Value::as_u64);
                let target_input_id = required_text(target.get("inputId"))?;
                let target_control_epoch = target.get("controlEpoch").and_then(Value::as_u64);
                let plan_binding_valid = match &target_work_authority {
                    SessionWorkAuthorityV3::Plan {
                        plan_revision: target_plan_revision,
                    } => plan_revision.as_deref() == Some(target_plan_revision.as_str()),
                    SessionWorkAuthorityV3::ContextRead { .. } => plan_revision.is_none(),
                };
                if target_work_authority != review_work_authority
                    || !plan_binding_valid
                    || target_input_id != current_input_id
                    || target_control_epoch != Some(control_epoch)
                    || target_review_revision != Some(revision)
                    || target_high_water != Some(high_water)
                {
                    return Err(ProviderNativeStreamTransportErrorV1::new(
                        "provider_dispatch_request_identity_invalid",
                    ));
                }
                (
                    Some(target_work_authority),
                    Some(revision),
                    Some(high_water),
                )
            }
            (ProviderTracePurposeV1::FinalAnswer, _, _)
            | (_, "finalAnswer", _)
            | (_, _, Some(_)) => {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_dispatch_request_identity_invalid",
                ));
            }
            _ => (None, None, None),
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
        plan_revision,
        work_authority,
        review_revision,
        snapshot_high_water,
    })
}

fn exact_provider_context_message(
    messages: &[Value],
    schema_version: &str,
) -> Result<Value, ProviderNativeStreamTransportErrorV1> {
    let mut matches = messages.iter().filter_map(|message| {
        if message.get("role").and_then(Value::as_str) != Some("user") {
            return None;
        }
        let content = message.get("content").and_then(Value::as_str)?;
        let value = serde_json::from_str::<Value>(content).ok()?;
        (value.get("schemaVersion").and_then(Value::as_str) == Some(schema_version))
            .then_some(value)
    });
    let value = matches.next().ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_dispatch_request_identity_invalid")
    })?;
    if matches.next().is_some() {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_dispatch_request_identity_invalid",
        ));
    }
    Ok(value)
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
    loop {
        let (envelopes, reached_eof) = match response.chunk().await {
            Ok(Some(chunk)) => (
                framer
                    .push(&chunk)
                    .map_err(|error| ProviderNativeStreamTransportErrorV1::new(error.code))?,
                false,
            ),
            Ok(None) => (
                framer
                    .finish()
                    .map_err(|error| ProviderNativeStreamTransportErrorV1::new(error.code))?,
                true,
            ),
            Err(_) => {
                return Err(ProviderNativeStreamTransportErrorV1::new(
                    "provider_transport_failed",
                ));
            }
        };
        for envelope in envelopes {
            let Some(payload) = envelope.payload else {
                continue;
            };
            accumulator
                .ingest_payload(&payload)
                .map_err(|error| ProviderNativeStreamTransportErrorV1::new(error.code))?;
        }
        if accumulator.source_done() {
            framer
                .ensure_empty_after_terminal()
                .map_err(|error| ProviderNativeStreamTransportErrorV1::new(error.code))?;
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
        let ProviderStreamTraceContextV1 {
            store: trace_store,
            identity: trace_identity,
            dispatch_authority,
        } = trace_context;
        let mut request_envelope = request_envelope;
        if let Err(error) = inject_provider_native_continuation(
            &profile,
            &mut request_envelope,
            &trace_store,
            &trace_identity,
            &dispatch_authority,
        ) {
            yield Ok::<Bytes, Infallible>(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.safe_message(),
            )));
            return;
        }
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
        let dispatch_commit = match dispatch_authority.session_store.commit_provider_dispatch(
            &dispatch_authority.run_capability,
            &dispatch_authority.admission,
            &exact_request_binding,
            &trace_store,
            trace_identity,
            &prepared.exact_request_body,
        ) {
            Ok(commit) => commit,
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
        let mut trace = DurableProviderTurnTraceV3::new(
            dispatch_authority.session_store.clone(),
            dispatch_commit,
        );
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
                let _ = finish_provider_trace_failure(
                    &mut trace,
                    "provider_retryable_no_mutation",
                );
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
            let _ = finish_provider_trace_failure(
                &mut trace,
                "provider_trace_response_boundary_failed",
            );
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
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                "provider_error_body_too_large",
                                "Provider error body exceeded the per-envelope structural limit",
                            )));
                            return;
                        }
                        error_body.extend_from_slice(&chunk);
                    }
                    Ok(None) => break,
                    Err(_) => {
                        let _ = finish_provider_trace_failure(
                            &mut trace,
                            "provider_retryable_no_mutation",
                        );
                        yield Ok(Bytes::from(provider_public_error_event(
                            &request_id,
                            "provider_retryable_no_mutation",
                            "Provider error response ended before its body was archived",
                        )));
                        return;
                    }
                }
            }
            if !error_body.is_empty() {
                if let Err(error) = trace.append_raw_upstream_envelope(&error_body) {
                    let _ = finish_provider_trace_failure(&mut trace, error.code);
                    yield Ok(Bytes::from(provider_public_error_event(
                        &request_id,
                        error.code,
                        error.message,
                    )));
                    return;
                }
            }
            let reason_code = if (500..=599).contains(&status.as_u16()) {
                "provider_retryable_no_mutation"
            } else {
                "ProviderHttpStatusFailed"
            };
            let _ = finish_provider_trace_failure(&mut trace, reason_code);
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
            "provider": required_resolved_provider_flavor(&profile),
            "model": profile.model,
        });
        if let Err(error) = trace.append_normalized_event(metadata.clone()) {
            let _ = finish_provider_trace_failure(
                &mut trace,
                "provider_trace_metadata_archive_failed",
            );
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.message,
            )));
            return;
        }
        if let Err(error) = trace.archive_before_publication(|_| ()) {
            let _ = finish_provider_trace_failure(
                &mut trace,
                "provider_trace_metadata_flush_failed",
            );
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
        let mut sealed_items = ProviderSealedItemsBuilderV3::default();
        let mut response = response;
        'upstream: loop {
            let flush_deadline = trace
                .next_flush_deadline()
                .map(tokio::time::Instant::from_std);
            let next = tokio::select! {
                chunk = response.chunk() => Some(chunk),
                _ = async {
                    match flush_deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending::<()>().await,
                    }
                } => None,
            };
            let Some(next) = next else {
                if let Err(error) = trace.flush_if_due(Instant::now()) {
                    let _ = finish_provider_trace_failure(
                        &mut trace,
                        "provider_trace_periodic_flush_failed",
                    );
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
                    for envelope in envelopes {
                        if let Err(error) = trace.append_raw_upstream_envelope(&envelope.raw) {
                            let _ = finish_provider_trace_failure(&mut trace, error.code);
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                error.code,
                                error.message,
                            )));
                            return;
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
                                let _ = finish_provider_trace_failure(
                                    &mut trace,
                                    "provider_trace_normalized_archive_failed",
                                );
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                            if let Some(mut public_event) = emission.public_event {
                                if let Err(error) = sealed_items.ingest_public_event(
                                    public_event.event,
                                    &public_event.data,
                                ) {
                                    let _ = finish_provider_trace_failure(
                                        &mut trace,
                                        error.code,
                                    );
                                    yield Ok(Bytes::from(provider_public_error_event(
                                        &request_id,
                                        error.code,
                                        error.safe_message(),
                                    )));
                                    return;
                                }
                                if let Some(record) = public_event.data.as_object_mut() {
                                    record.insert(
                                        "requestId".to_string(),
                                        json!(request_id.as_str()),
                                    );
                                }
                                if let Err(error) =
                                    trace.archive_before_publication(|_| ())
                                {
                                    let _ = finish_provider_trace_failure(
                                        &mut trace,
                                        "provider_trace_publication_flush_failed",
                                    );
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
                        if let Err(error) = framer.ensure_empty_after_terminal() {
                            let _ = finish_provider_trace_failure(&mut trace, error.code);
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                error.code,
                                error.message,
                            )));
                            return;
                        }
                        break 'upstream;
                    }
                }
                Ok(None) => {
                    let envelopes = match framer.finish() {
                        Ok(envelopes) => envelopes,
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
                    for envelope in envelopes {
                        if let Err(error) = trace.append_raw_upstream_envelope(&envelope.raw) {
                            let _ = finish_provider_trace_failure(&mut trace, error.code);
                            yield Ok(Bytes::from(provider_public_error_event(
                                &request_id,
                                error.code,
                                error.message,
                            )));
                            return;
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
                                let _ = finish_provider_trace_failure(
                                    &mut trace,
                                    "provider_trace_normalized_archive_failed",
                                );
                                yield Ok(Bytes::from(provider_public_error_event(
                                    &request_id,
                                    error.code,
                                    error.message,
                                )));
                                return;
                            }
                            if let Some(mut public_event) = emission.public_event {
                                if let Err(error) = sealed_items.ingest_public_event(
                                    public_event.event,
                                    &public_event.data,
                                ) {
                                    let _ = finish_provider_trace_failure(
                                        &mut trace,
                                        error.code,
                                    );
                                    yield Ok(Bytes::from(provider_public_error_event(
                                        &request_id,
                                        error.code,
                                        error.safe_message(),
                                    )));
                                    return;
                                }
                                if let Some(record) = public_event.data.as_object_mut() {
                                    record.insert(
                                        "requestId".to_string(),
                                        json!(request_id.as_str()),
                                    );
                                }
                                if let Err(error) =
                                    trace.archive_before_publication(|_| ())
                                {
                                    let _ = finish_provider_trace_failure(
                                        &mut trace,
                                        "provider_trace_publication_flush_failed",
                                    );
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
                        "provider_retryable_no_mutation",
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
        let ordered_items = match sealed_items.materialize(&result.output.tool_calls) {
            Ok(items) => items,
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
        let mut provider_result = json!({
            "providerProfileId": profile.id,
            "provider": required_resolved_provider_flavor(&profile),
            "model": profile.model,
        });
        if let Some(usage) = result.output.usage {
            if !usage.is_object() {
                let _ = finish_provider_trace_failure(
                    &mut trace,
                    "provider_usage_invalid",
                );
                yield Ok(Bytes::from(provider_public_error_event(
                    &request_id,
                    "provider_usage_invalid",
                    "Provider usage metadata is invalid",
                )));
                return;
            }
            provider_result["usage"] = usage;
        }
        if let Err(error) = trace.append_normalized_event(json!({
            "type": "validatedTerminal",
            "nativeCompletion": native_completion,
            "reasoningPresent": true,
            "reasoningTransport": resolved_reasoning_transport(&profile),
            "reasoningDigest": reasoning_digest,
            "responseDigest": response_digest,
            "providerResult": provider_result.clone(),
            "orderedItems": ordered_items.clone(),
        })) {
            let _ = finish_provider_trace_failure(
                &mut trace,
                "provider_trace_validated_terminal_archive_failed",
            );
            yield Ok(Bytes::from(provider_public_error_event(
                &request_id,
                error.code,
                error.message,
            )));
            return;
        }
        let (_, completion) = match trace.finish_completed(ProviderCompletedTerminalInputV3 {
            native_completion: native_completion.clone(),
            reasoning_transport: resolved_reasoning_transport(&profile).to_string(),
            reasoning_digest: reasoning_digest.clone(),
            response_digest: response_digest.clone(),
            provider_result,
            ordered_items,
        }) {
            Ok(completed) => completed,
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
            "receipt": completion,
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
    trace: &mut DurableProviderTurnTraceV3,
    reason_code: &str,
) -> Result<ProviderTraceMetadataV1, ProviderTraceErrorV1> {
    trace.finish_noncompleted(
        SessionProviderTurnTerminalKindV3::Failed,
        ProviderTraceTerminalKindV1::Failed,
        reason_code,
    )
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
        "provider_trace_envelope_too_large" | "provider_error_body_too_large" => {
            "Provider response exceeded the per-envelope structural size limit."
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
    profile.max_output_tokens.filter(|tokens| *tokens > 0)
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
    match required_resolved_provider_flavor(profile) {
        "deepseek" => ProviderThinkingCompatibility::DeepSeek,
        "zhipu" => ProviderThinkingCompatibility::GlmDeferred,
        "openai" => ProviderThinkingCompatibility::Generic,
        _ => unreachable!("current LLM Profile providerFlavor"),
    }
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

fn provider_wire_tool_id_v2(
    wire_name: &str,
) -> Result<String, ProviderNativeStreamTransportErrorV1> {
    let encoded = wire_name.strip_prefix("dcv2_").ok_or_else(|| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_native_history_invalid")
    })?;
    if encoded.is_empty() || encoded.len() % 2 != 0 {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }
    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        let pair = std::str::from_utf8(pair).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?;
        bytes.push(u8::from_str_radix(pair, 16).map_err(|_| {
            ProviderNativeStreamTransportErrorV1::new(
                "provider_continuation_native_history_invalid",
            )
        })?);
    }
    let decoded = String::from_utf8(bytes).map_err(|_| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_native_history_invalid")
    })?;
    let tool_id = ToolIdV2::parse(decoded).map_err(|_| {
        ProviderNativeStreamTransportErrorV1::new("provider_continuation_native_history_invalid")
    })?;
    let canonical_wire_name = format!(
        "dcv2_{}",
        tool_id
            .as_str()
            .as_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    if canonical_wire_name != wire_name {
        return Err(ProviderNativeStreamTransportErrorV1::new(
            "provider_continuation_native_history_invalid",
        ));
    }
    Ok(tool_id.to_string())
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
