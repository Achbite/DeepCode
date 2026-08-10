use crate::prelude::*;
use crate::*;
use std::collections::{BTreeMap, BTreeSet};

pub(crate) const PROVIDER_STREAM_TERMINAL_SCHEMA_V1: &str = "deepcode.provider-stream-terminal.v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderNativeStreamKindV1 {
    OpenAiCompatible,
    Anthropic,
    Ollama,
}

impl ProviderNativeStreamKindV1 {
    pub(crate) fn from_profile_kind(kind: &str) -> Option<Self> {
        match kind {
            "openaiCompatible" => Some(Self::OpenAiCompatible),
            "anthropic" => Some(Self::Anthropic),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    pub(crate) fn wire_name(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "openaiCompatible",
            Self::Anthropic => "anthropic",
            Self::Ollama => "ollama",
        }
    }

    pub(crate) fn terminal_signal(self) -> &'static str {
        match self {
            Self::OpenAiCompatible => "[DONE]",
            Self::Anthropic => "message_stop",
            Self::Ollama => "done:true",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderNativeStreamErrorV1 {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ProviderNativeStreamErrorV1 {
    fn invalid(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderPublicStreamEventV1 {
    pub(crate) event: &'static str,
    pub(crate) data: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderNormalizedEmissionV1 {
    pub(crate) trace_event: Value,
    pub(crate) public_event: Option<ProviderPublicStreamEventV1>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderNativeCompletionV1 {
    pub(crate) provider_kind: ProviderNativeStreamKindV1,
    pub(crate) finish_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderNativeStreamResultV1 {
    pub(crate) output: LlmChatOutput,
    pub(crate) completion: ProviderNativeCompletionV1,
}

#[derive(Debug, Clone, Default)]
struct ProviderNativeToolBufferV1 {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    arguments_complete: Option<Value>,
}

#[derive(Debug)]
pub(crate) struct ProviderNativeStreamAccumulatorV1 {
    kind: ProviderNativeStreamKindV1,
    content: String,
    reasoning: String,
    tool_calls: BTreeMap<i64, ProviderNativeToolBufferV1>,
    usage: Option<Value>,
    finish_reason: Option<String>,
    source_done: bool,
}

impl ProviderNativeStreamAccumulatorV1 {
    pub(crate) fn new(kind: ProviderNativeStreamKindV1) -> Self {
        Self {
            kind,
            content: String::new(),
            reasoning: String::new(),
            tool_calls: BTreeMap::new(),
            usage: None,
            finish_reason: None,
            source_done: false,
        }
    }

    pub(crate) fn source_done(&self) -> bool {
        self.source_done
    }

    fn validate_tool_index_first_occurrence(
        &self,
        index: i64,
    ) -> Result<(), ProviderNativeStreamErrorV1> {
        if self.tool_calls.contains_key(&index) {
            return Ok(());
        }

        match self.kind {
            ProviderNativeStreamKindV1::OpenAiCompatible | ProviderNativeStreamKindV1::Ollama => {
                let expected = i64::try_from(self.tool_calls.len()).unwrap_or(i64::MAX);
                if index != expected {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_index_discontinuous",
                        "Provider-native tool ordinals must first appear continuously from zero",
                    ));
                }
            }
            ProviderNativeStreamKindV1::Anthropic => {
                if self
                    .tool_calls
                    .last_key_value()
                    .is_some_and(|(previous, _)| index <= *previous)
                {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_index_out_of_order",
                        "Anthropic tool content-block indexes must first appear in native order",
                    ));
                }
            }
        }

        Ok(())
    }

    pub(crate) fn ingest_payload(
        &mut self,
        payload: &[u8],
    ) -> Result<Vec<ProviderNormalizedEmissionV1>, ProviderNativeStreamErrorV1> {
        if self.source_done {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stream_data_after_terminal",
                "Provider emitted data after its native terminal marker",
            ));
        }
        let text = std::str::from_utf8(payload).map_err(|error| {
            ProviderNativeStreamErrorV1::invalid(
                "provider_stream_utf8_invalid",
                format!("Provider envelope is not valid UTF-8: {error}"),
            )
        })?;
        match self.kind {
            ProviderNativeStreamKindV1::OpenAiCompatible => self.ingest_openai_payload(text),
            ProviderNativeStreamKindV1::Anthropic => self.ingest_anthropic_payload(text),
            ProviderNativeStreamKindV1::Ollama => self.ingest_ollama_payload(text),
        }
    }

    pub(crate) fn finalize(
        self,
    ) -> Result<ProviderNativeStreamResultV1, ProviderNativeStreamErrorV1> {
        if !self.source_done {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stream_native_terminal_missing",
                "Provider stream ended before its native terminal marker",
            ));
        }
        if self.reasoning.trim().is_empty() {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_reasoning_missing",
                "Provider turn completed without non-empty plaintext reasoning",
            ));
        }
        if self.kind == ProviderNativeStreamKindV1::OpenAiCompatible && self.finish_reason.is_none()
        {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stream_finish_reason_missing",
                "OpenAI-compatible stream completed without a finish_reason",
            ));
        }
        if self.kind == ProviderNativeStreamKindV1::OpenAiCompatible {
            for (expected, index) in self.tool_calls.keys().copied().enumerate() {
                if index != i64::try_from(expected).unwrap_or(i64::MAX) {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_index_discontinuous",
                        "OpenAI-compatible tool-call indexes must be continuous from zero",
                    ));
                }
            }
        }
        let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
        for (index, buffer) in self.tool_calls {
            let name = buffer.name.ok_or_else(|| {
                ProviderNativeStreamErrorV1::invalid(
                    "provider_tool_call_name_missing",
                    format!("Provider tool call {index} has no function name"),
                )
            })?;
            let arguments = if let Some(arguments) = buffer.arguments_complete {
                arguments
            } else if buffer.arguments.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&buffer.arguments).map_err(|error| {
                    ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_arguments_invalid",
                        format!("Provider tool call {index} arguments are invalid JSON: {error}"),
                    )
                })?
            };
            tool_calls.push(LlmToolCall {
                id: buffer.id.ok_or_else(|| {
                    ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_identity_missing",
                        format!("Provider tool call {index} has no identity"),
                    )
                })?,
                name: internal_tool_name(&name),
                arguments,
            });
        }
        if self.finish_reason.as_deref() == Some("tool_calls") && tool_calls.is_empty() {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_tool_calls_finish_without_calls",
                "OpenAI-compatible finish_reason tool_calls contained no tool call",
            ));
        }
        if self.finish_reason.as_deref() == Some("stop") && !tool_calls.is_empty() {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stop_finish_with_tool_calls",
                "OpenAI-compatible finish_reason stop conflicted with tool calls",
            ));
        }
        Ok(ProviderNativeStreamResultV1 {
            output: LlmChatOutput {
                content: self.content,
                reasoning: Some(self.reasoning),
                tool_calls,
                usage: self.usage,
            },
            completion: ProviderNativeCompletionV1 {
                provider_kind: self.kind,
                finish_reason: self.finish_reason,
            },
        })
    }

    fn ingest_openai_payload(
        &mut self,
        data: &str,
    ) -> Result<Vec<ProviderNormalizedEmissionV1>, ProviderNativeStreamErrorV1> {
        if data.trim() == "[DONE]" {
            if self.finish_reason.is_none() {
                return Err(ProviderNativeStreamErrorV1::invalid(
                    "provider_stream_finish_reason_missing",
                    "OpenAI-compatible [DONE] arrived before a valid finish_reason",
                ));
            }
            self.source_done = true;
            return Ok(Vec::new());
        }
        let value = parse_provider_json(data, "OpenAI-compatible")?;
        if let Some(error) = value.get("error") {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stream_upstream_error",
                format!("OpenAI-compatible stream returned an error: {error}"),
            ));
        }
        let mut emissions = Vec::new();
        if let Some(usage) = value.get("usage").filter(|value| !value.is_null()).cloned() {
            self.usage = Some(usage.clone());
            emissions.push(usage_emission(usage));
        }
        let choices = value
            .get("choices")
            .and_then(Value::as_array)
            .ok_or_else(|| {
                ProviderNativeStreamErrorV1::invalid(
                    "provider_stream_schema_invalid",
                    "OpenAI-compatible stream envelope requires choices[]",
                )
            })?;
        if choices.len() > 1 {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stream_multiple_choices_unsupported",
                "Provider stream envelope may contain at most one assistant choice",
            ));
        }
        for choice in choices {
            let index = choice.get("index").and_then(Value::as_i64).ok_or_else(|| {
                ProviderNativeStreamErrorV1::invalid(
                    "provider_stream_schema_invalid",
                    "OpenAI-compatible stream choice requires an explicit integer index",
                )
            })?;
            if index != 0 {
                return Err(ProviderNativeStreamErrorV1::invalid(
                    "provider_stream_multiple_choices_unsupported",
                    "Provider stream choice index must be zero",
                ));
            }
            if let Some(finish_reason) = choice.get("finish_reason").and_then(Value::as_str) {
                if !matches!(finish_reason, "stop" | "tool_calls") {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_stream_finish_reason_invalid",
                        format!(
                            "OpenAI-compatible finish_reason `{finish_reason}` is not supported"
                        ),
                    ));
                }
                if self
                    .finish_reason
                    .as_deref()
                    .is_some_and(|existing| existing != finish_reason)
                {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_stream_finish_reason_conflict",
                        "OpenAI-compatible stream changed its finish_reason",
                    ));
                }
                self.finish_reason = Some(finish_reason.to_string());
            }
            let delta = choice
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    ProviderNativeStreamErrorV1::invalid(
                        "provider_stream_schema_invalid",
                        "OpenAI-compatible stream choice requires delta object",
                    )
                })?;
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                self.reasoning.push_str(reasoning);
                emissions.push(reasoning_emission(reasoning));
            }
            if let Some(content) = delta
                .get("content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                self.content.push_str(content);
                emissions.push(text_emission(content));
            }
            let mut envelope_tool_indices = BTreeSet::new();
            for call in delta
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let tool_index = call.get("index").and_then(Value::as_i64).ok_or_else(|| {
                    ProviderNativeStreamErrorV1::invalid(
                        "provider_stream_schema_invalid",
                        "OpenAI-compatible tool call requires an explicit integer index",
                    )
                })?;
                if !(0..32).contains(&tool_index) {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_index_invalid",
                        "OpenAI-compatible tool-call index must be in 0..31",
                    ));
                }
                if !envelope_tool_indices.insert(tool_index) {
                    return Err(ProviderNativeStreamErrorV1::invalid(
                        "provider_tool_call_index_duplicate",
                        "OpenAI-compatible stream envelope repeated a tool-call index",
                    ));
                }
                self.validate_tool_index_first_occurrence(tool_index)?;
                let buffer = self.tool_calls.entry(tool_index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if buffer.id.as_deref().is_some_and(|existing| existing != id) {
                        return Err(ProviderNativeStreamErrorV1::invalid(
                            "provider_tool_call_identity_conflict",
                            "Provider changed a tool-call identity within one response",
                        ));
                    }
                    buffer.id = Some(id.to_string());
                }
                let function = call.get("function").and_then(Value::as_object);
                if let Some(name) = function
                    .and_then(|value| value.get("name"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                {
                    if buffer
                        .name
                        .as_deref()
                        .is_some_and(|existing| existing != name)
                    {
                        return Err(ProviderNativeStreamErrorV1::invalid(
                            "provider_tool_call_name_conflict",
                            "Provider changed a tool-call name within one response",
                        ));
                    }
                    buffer.name = Some(name.to_string());
                }
                let arguments_delta = function
                    .and_then(|value| value.get("arguments"))
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                buffer.arguments.push_str(arguments_delta);
                emissions.push(tool_delta_emission(
                    tool_index,
                    buffer.id.as_deref(),
                    buffer.name.as_deref(),
                    arguments_delta,
                ));
            }
        }
        Ok(emissions)
    }

    fn ingest_anthropic_payload(
        &mut self,
        data: &str,
    ) -> Result<Vec<ProviderNormalizedEmissionV1>, ProviderNativeStreamErrorV1> {
        let value = parse_provider_json(data, "Anthropic")?;
        let event_type = value.get("type").and_then(Value::as_str).ok_or_else(|| {
            ProviderNativeStreamErrorV1::invalid(
                "provider_stream_schema_invalid",
                "Anthropic stream envelope requires type",
            )
        })?;
        let mut emissions = Vec::new();
        match event_type {
            "message_start" => {
                if let Some(usage) = value
                    .get("message")
                    .and_then(|message| message.get("usage"))
                    .cloned()
                {
                    self.usage = Some(usage.clone());
                    emissions.push(usage_emission(usage));
                }
            }
            "content_block_start" => {
                let index = value.get("index").and_then(Value::as_i64).unwrap_or(0);
                let block = value
                    .get("content_block")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ProviderNativeStreamErrorV1::invalid(
                            "provider_stream_schema_invalid",
                            "Anthropic content_block_start requires content_block",
                        )
                    })?;
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    self.validate_tool_index_first_occurrence(index)?;
                    let buffer = self.tool_calls.entry(index).or_default();
                    if let Some(id) = block.get("id").and_then(Value::as_str) {
                        if buffer.id.as_deref().is_some_and(|existing| existing != id) {
                            return Err(ProviderNativeStreamErrorV1::invalid(
                                "provider_tool_call_identity_conflict",
                                "Provider changed a tool-call identity within one response",
                            ));
                        }
                        buffer.id = Some(id.to_string());
                    }
                    if let Some(name) = block.get("name").and_then(Value::as_str) {
                        if buffer
                            .name
                            .as_deref()
                            .is_some_and(|existing| existing != name)
                        {
                            return Err(ProviderNativeStreamErrorV1::invalid(
                                "provider_tool_call_name_conflict",
                                "Provider changed a tool-call name within one response",
                            ));
                        }
                        buffer.name = Some(name.to_string());
                    }
                    if let Some(input) = block.get("input").filter(|value| !value.is_null()) {
                        buffer.arguments_complete = Some(input.clone());
                    }
                    emissions.push(tool_delta_emission(
                        index,
                        buffer.id.as_deref(),
                        buffer.name.as_deref(),
                        "",
                    ));
                }
            }
            "content_block_delta" => {
                let index = value.get("index").and_then(Value::as_i64).unwrap_or(0);
                let delta = value
                    .get("delta")
                    .and_then(Value::as_object)
                    .ok_or_else(|| {
                        ProviderNativeStreamErrorV1::invalid(
                            "provider_stream_schema_invalid",
                            "Anthropic content_block_delta requires delta",
                        )
                    })?;
                match delta
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "thinking_delta" => {
                        let reasoning = delta
                            .get("thinking")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !reasoning.is_empty() {
                            self.reasoning.push_str(reasoning);
                            emissions.push(reasoning_emission(reasoning));
                        }
                    }
                    "text_delta" => {
                        let content = delta
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        if !content.is_empty() {
                            self.content.push_str(content);
                            emissions.push(text_emission(content));
                        }
                    }
                    "input_json_delta" => {
                        let arguments_delta = delta
                            .get("partial_json")
                            .and_then(Value::as_str)
                            .unwrap_or_default();
                        self.validate_tool_index_first_occurrence(index)?;
                        let buffer = self.tool_calls.entry(index).or_default();
                        if !arguments_delta.is_empty() {
                            buffer.arguments_complete = None;
                            buffer.arguments.push_str(arguments_delta);
                        }
                        emissions.push(tool_delta_emission(
                            index,
                            buffer.id.as_deref(),
                            buffer.name.as_deref(),
                            arguments_delta,
                        ));
                    }
                    "signature_delta" => {}
                    other => {
                        return Err(ProviderNativeStreamErrorV1::invalid(
                            "provider_stream_anthropic_delta_unsupported",
                            format!("Anthropic delta type `{other}` is not supported"),
                        ))
                    }
                }
            }
            "message_delta" => {
                if let Some(usage) = value.get("usage").cloned() {
                    self.usage = Some(usage.clone());
                    emissions.push(usage_emission(usage));
                }
            }
            "content_block_stop" | "ping" => {}
            "message_stop" => self.source_done = true,
            "error" => {
                return Err(ProviderNativeStreamErrorV1::invalid(
                    "provider_stream_upstream_error",
                    format!("Anthropic stream returned an error: {value}"),
                ))
            }
            other => {
                return Err(ProviderNativeStreamErrorV1::invalid(
                    "provider_stream_anthropic_event_unsupported",
                    format!("Anthropic stream event `{other}` is not supported"),
                ))
            }
        }
        Ok(emissions)
    }

    fn ingest_ollama_payload(
        &mut self,
        data: &str,
    ) -> Result<Vec<ProviderNormalizedEmissionV1>, ProviderNativeStreamErrorV1> {
        let value = parse_provider_json(data, "Ollama")?;
        if let Some(error) = value.get("error") {
            return Err(ProviderNativeStreamErrorV1::invalid(
                "provider_stream_upstream_error",
                format!("Ollama stream returned an error: {error}"),
            ));
        }
        let mut emissions = Vec::new();
        let mut message_reasoning_present = false;
        if let Some(message) = value.get("message").and_then(Value::as_object) {
            if let Some(reasoning) = message
                .get("thinking")
                .or_else(|| message.get("reasoning"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                message_reasoning_present = true;
                self.reasoning.push_str(reasoning);
                emissions.push(reasoning_emission(reasoning));
            }
            if let Some(content) = message
                .get("content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                self.content.push_str(content);
                emissions.push(text_emission(content));
            }
            for (ordinal, call) in message
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
            {
                let index = i64::try_from(ordinal).unwrap_or(i64::MAX);
                let function =
                    call.get("function")
                        .and_then(Value::as_object)
                        .ok_or_else(|| {
                            ProviderNativeStreamErrorV1::invalid(
                                "provider_stream_schema_invalid",
                                "Ollama tool call requires function object",
                            )
                        })?;
                self.validate_tool_index_first_occurrence(index)?;
                let buffer = self.tool_calls.entry(index).or_default();
                if let Some(id) = call.get("id").and_then(Value::as_str) {
                    if buffer.id.as_deref().is_some_and(|existing| existing != id) {
                        return Err(ProviderNativeStreamErrorV1::invalid(
                            "provider_tool_call_identity_conflict",
                            "Provider changed a tool-call identity within one response",
                        ));
                    }
                    buffer.id = Some(id.to_string());
                } else if buffer.id.is_none() {
                    buffer.id = Some(format!("tool-call-{index}"));
                }
                if let Some(name) = function.get("name").and_then(Value::as_str) {
                    if buffer
                        .name
                        .as_deref()
                        .is_some_and(|existing| existing != name)
                    {
                        return Err(ProviderNativeStreamErrorV1::invalid(
                            "provider_tool_call_name_conflict",
                            "Provider changed a tool-call name within one response",
                        ));
                    }
                    buffer.name = Some(name.to_string());
                }
                let arguments = function
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                match buffer.arguments_complete.as_ref() {
                    Some(existing) if existing == &arguments => continue,
                    Some(_) => {
                        return Err(ProviderNativeStreamErrorV1::invalid(
                            "provider_tool_call_arguments_conflict",
                            "Provider changed complete tool-call arguments within one response",
                        ))
                    }
                    None => buffer.arguments_complete = Some(arguments.clone()),
                }
                emissions.push(tool_delta_emission(
                    index,
                    buffer.id.as_deref(),
                    buffer.name.as_deref(),
                    &serde_json::to_string(&arguments).unwrap_or_else(|_| "{}".to_string()),
                ));
            }
        }
        if !message_reasoning_present {
            if let Some(reasoning) = value
                .get("thinking")
                .or_else(|| value.get("reasoning"))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                self.reasoning.push_str(reasoning);
                emissions.push(reasoning_emission(reasoning));
            }
        }
        let usage = ollama_usage(&value);
        if !usage.as_object().is_none_or(serde_json::Map::is_empty) {
            self.usage = Some(usage.clone());
            emissions.push(usage_emission(usage));
        }
        if value.get("done").and_then(Value::as_bool) == Some(true) {
            self.source_done = true;
        }
        Ok(emissions)
    }
}

fn parse_provider_json(data: &str, provider: &str) -> Result<Value, ProviderNativeStreamErrorV1> {
    serde_json::from_str(data).map_err(|error| {
        ProviderNativeStreamErrorV1::invalid(
            "provider_stream_json_invalid",
            format!("{provider} stream envelope is invalid JSON: {error}"),
        )
    })
}

fn reasoning_emission(content: &str) -> ProviderNormalizedEmissionV1 {
    ProviderNormalizedEmissionV1 {
        trace_event: json!({ "type": "reasoning_delta", "content": content }),
        public_event: None,
    }
}

fn text_emission(content: &str) -> ProviderNormalizedEmissionV1 {
    ProviderNormalizedEmissionV1 {
        trace_event: json!({ "type": "text_delta", "content": content }),
        public_event: Some(ProviderPublicStreamEventV1 {
            event: "provider_delta",
            data: json!({
                "type": "provider_delta",
                "chunk": { "type": "delta", "content": content }
            }),
        }),
    }
}

fn tool_delta_emission(
    index: i64,
    id: Option<&str>,
    name: Option<&str>,
    arguments_delta: &str,
) -> ProviderNormalizedEmissionV1 {
    let tool_call_delta = json!({
        "id": id,
        "index": index,
        "name": name,
        "argumentsDelta": arguments_delta,
    });
    ProviderNormalizedEmissionV1 {
        trace_event: json!({
            "type": "tool_call_delta",
            "toolCallDelta": tool_call_delta,
        }),
        public_event: Some(ProviderPublicStreamEventV1 {
            event: "provider_tool_call_delta",
            data: json!({
                "type": "provider_tool_call_delta",
                "chunk": {
                    "type": "tool_call",
                    "index": index,
                    "callId": id,
                    "toolCallDelta": tool_call_delta,
                }
            }),
        }),
    }
}

fn usage_emission(usage: Value) -> ProviderNormalizedEmissionV1 {
    ProviderNormalizedEmissionV1 {
        trace_event: json!({ "type": "usage", "usage": usage }),
        public_event: Some(ProviderPublicStreamEventV1 {
            event: "provider_usage",
            data: json!({
                "type": "provider_usage",
                "usage": usage,
            }),
        }),
    }
}

fn ollama_usage(value: &Value) -> Value {
    let mut usage = serde_json::Map::new();
    for field in [
        "prompt_eval_count",
        "eval_count",
        "total_duration",
        "load_duration",
        "prompt_eval_duration",
        "eval_duration",
    ] {
        if let Some(item) = value.get(field) {
            usage.insert(field.to_string(), item.clone());
        }
    }
    Value::Object(usage)
}

#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct SseDataParser {
    buffer: String,
}

#[cfg(test)]
impl SseDataParser {
    pub(crate) fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buffer.push_str(chunk);
        self.drain_complete_events()
    }

    pub(crate) fn finish(&mut self) -> Vec<String> {
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

#[cfg(test)]
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

#[cfg(test)]
#[derive(Debug, Clone, Default)]
struct ToolCallDeltaBuffer {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

#[cfg(test)]
#[derive(Debug, Default)]
pub(crate) struct OpenAiCompatibleStreamAccumulator {
    content: String,
    reasoning: String,
    tool_calls: BTreeMap<i64, ToolCallDeltaBuffer>,
    pub(crate) usage: Option<Value>,
    pub(crate) done_emitted: bool,
    source_envelope_seq: u64,
}

#[cfg(test)]
impl OpenAiCompatibleStreamAccumulator {
    fn next_source_envelope_seq(&mut self) -> u64 {
        self.source_envelope_seq = self.source_envelope_seq.saturating_add(1);
        self.source_envelope_seq
    }

    #[cfg(test)]
    fn output(&self) -> LlmChatOutput {
        let tool_calls = self
            .tool_calls
            .iter()
            .filter_map(|(index, buffer)| {
                let name = buffer.name.clone()?;
                let arguments = if buffer.arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&buffer.arguments)
                        .unwrap_or_else(|_| json!({ "rawArguments": buffer.arguments }))
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

#[cfg(test)]
pub(crate) fn parse_openai_compatible_sse_text(text: &str) -> LlmChatOutput {
    let mut parser = SseDataParser::default();
    let mut accumulator = OpenAiCompatibleStreamAccumulator::default();
    for data in parser.push(text).into_iter().chain(parser.finish()) {
        let _ = openai_stream_events_from_data(&mut accumulator, &data);
    }
    accumulator.output()
}

#[cfg(test)]
pub(crate) fn openai_stream_events_from_data(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    data: &str,
) -> Vec<String> {
    openai_stream_events_from_data_inner(accumulator, data, None)
}

#[cfg(test)]
fn openai_stream_events_from_data_inner(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    data: &str,
    request_id: Option<&str>,
) -> Vec<String> {
    if data.trim() == "[DONE]" {
        let source_envelope_seq = accumulator.next_source_envelope_seq();
        accumulator.done_emitted = true;
        return vec![provider_sse_json_event(
            "provider_done",
            json!({
                "type": "provider_done",
                "providerSource": {
                    "schemaVersion": "deepcode.provider.source-envelope.v1",
                    "sequence": source_envelope_seq,
                    "encoding": "sse-marker",
                },
                "rawProvider": "[DONE]",
                "chunk": {
                    "type": "done",
                    "usage": accumulator.usage,
                },
                "usage": accumulator.usage,
            }),
            request_id,
        )];
    }
    let value = match serde_json::from_str::<Value>(data) {
        Ok(value) => value,
        Err(error) => {
            let source_envelope_seq = accumulator.next_source_envelope_seq();
            return vec![provider_sse_json_event(
                "provider_error",
                json!({
                    "type": "provider_error",
                    "error": error.to_string(),
                    "providerSource": {
                        "schemaVersion": "deepcode.provider.source-envelope.v1",
                        "sequence": source_envelope_seq,
                        "encoding": "invalid-json",
                    },
                    "rawProvider": data,
                }),
                request_id,
            )];
        }
    };
    openai_stream_events_from_value(accumulator, value, request_id)
}

#[cfg(test)]
fn openai_stream_events_from_value(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    value: Value,
    request_id: Option<&str>,
) -> Vec<String> {
    let source_envelope_seq = accumulator.next_source_envelope_seq();
    let mut events = vec![provider_sse_json_event(
        "provider_metadata",
        json!({
            "type": "provider_metadata",
            "providerSource": {
                "schemaVersion": "deepcode.provider.source-envelope.v1",
                "sequence": source_envelope_seq,
                "encoding": "json",
            },
            "rawProvider": value.clone(),
        }),
        request_id,
    )];
    if let Some(usage) = value.get("usage").filter(|usage| !usage.is_null()).cloned() {
        accumulator.usage = Some(usage.clone());
        events.push(provider_sse_json_event(
            "provider_usage",
            json!({
                "type": "provider_usage",
                "providerSourceSeq": source_envelope_seq,
                "usage": usage,
                "chunk": {
                    "type": "done",
                    "usage": usage,
                },
            }),
            request_id,
        ));
    }
    let choices = value
        .get("choices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for choice in choices {
        let index = choice.get("index").and_then(Value::as_i64).unwrap_or(0);
        let finish_reason = choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let delta = choice.get("delta").cloned().unwrap_or_else(|| json!({}));
        if let Some(reasoning) = delta
            .get("reasoning_content")
            .or_else(|| delta.get("reasoning"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            accumulator.reasoning.push_str(reasoning);
            events.push(provider_sse_json_event(
                "provider_reasoning_delta",
                json!({
                    "type": "provider_reasoning_delta",
                    "providerSourceSeq": source_envelope_seq,
                    "chunk": {
                        "type": "reasoning_delta",
                        "content": reasoning,
                        "index": index,
                        "finishReason": finish_reason,
                    },
                }),
                request_id,
            ));
        }
        if let Some(content) = delta
            .get("content")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            accumulator.content.push_str(content);
            events.push(provider_sse_json_event(
                "provider_delta",
                json!({
                    "type": "provider_delta",
                    "providerSourceSeq": source_envelope_seq,
                    "chunk": {
                        "type": "delta",
                        "content": content,
                        "index": index,
                        "finishReason": finish_reason,
                    },
                }),
                request_id,
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
            let function = tool_call
                .get("function")
                .cloned()
                .unwrap_or_else(|| json!({}));
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
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
            events.push(provider_sse_json_event(
                "provider_tool_call_delta",
                json!({
                    "type": "provider_tool_call_delta",
                    "providerSourceSeq": source_envelope_seq,
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
                    },
                }),
                request_id,
            ));
        }
    }
    events
}

#[cfg(test)]
fn provider_sse_json_event(event: &str, mut value: Value, request_id: Option<&str>) -> String {
    if let (Some(request_id), Some(record)) = (request_id, value.as_object_mut()) {
        record.insert("requestId".to_string(), json!(request_id));
    }
    sse_json_event(event, value)
}

pub(crate) fn sse_json_event(event: &str, value: Value) -> String {
    let data = serde_json::to_string(&value).unwrap_or_else(|_| {
        "{\"type\":\"provider_error\",\"error\":\"failed to serialize stream event\"}".to_string()
    });
    format!("event: {event}\ndata: {data}\n\n")
}

#[cfg(test)]
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
