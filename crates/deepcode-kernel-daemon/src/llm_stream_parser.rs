use crate::llm_transport::{internal_tool_name, LlmChatOutput, LlmToolCall, LlmToolDefinition};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProviderStreamKind {
    OpenAiCompatible,
    Anthropic,
    Ollama,
}

impl ProviderStreamKind {
    pub(crate) fn from_profile_kind(value: &str) -> Option<Self> {
        match value {
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
            Self::Ollama => "done=true",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderStreamError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl ProviderStreamError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderEmission {
    pub(crate) event: Value,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderCompletion {
    pub(crate) provider_kind: ProviderStreamKind,
    pub(crate) finish_reason: Option<String>,
    pub(crate) usage: Option<ProviderUsage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProviderUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_read_input_tokens: Option<u64>,
    pub(crate) cache_miss_input_tokens: Option<u64>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderStreamResult {
    pub(crate) output: LlmChatOutput,
    pub(crate) completion: ProviderCompletion,
}

#[derive(Debug, Clone, Default)]
struct ToolBuffer {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
    complete_arguments: Option<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProviderStreamAccumulator {
    kind: ProviderStreamKind,
    content: String,
    reasoning: String,
    reasoning_signature: String,
    tool_calls: BTreeMap<i64, ToolBuffer>,
    finish_reason: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
    cache_miss_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    source_done: bool,
}

impl ProviderStreamAccumulator {
    pub(crate) fn new(kind: ProviderStreamKind) -> Self {
        Self {
            kind,
            content: String::new(),
            reasoning: String::new(),
            reasoning_signature: String::new(),
            tool_calls: BTreeMap::new(),
            finish_reason: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_input_tokens: None,
            cache_miss_input_tokens: None,
            cache_creation_input_tokens: None,
            source_done: false,
        }
    }

    pub(crate) fn source_done(&self) -> bool {
        self.source_done
    }

    pub(crate) fn ingest_payload(
        &mut self,
        payload: &[u8],
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        if self.source_done {
            return Err(ProviderStreamError::new(
                "provider_stream_data_after_terminal",
                "Provider 在完成标记后继续返回数据。",
            ));
        }
        let text = std::str::from_utf8(payload).map_err(|error| {
            ProviderStreamError::new(
                "provider_stream_utf8_invalid",
                format!("Provider 流不是 UTF-8：{error}"),
            )
        })?;
        match self.kind {
            ProviderStreamKind::OpenAiCompatible => self.ingest_openai(text),
            ProviderStreamKind::Anthropic => self.ingest_anthropic(text),
            ProviderStreamKind::Ollama => self.ingest_ollama(text),
        }
    }

    pub(crate) fn finalize(self) -> Result<ProviderStreamResult, ProviderStreamError> {
        self.finalize_with_call_id_namespace(None)
    }

    pub(crate) fn finalize_for_request(
        self,
        request_id: &str,
    ) -> Result<ProviderStreamResult, ProviderStreamError> {
        self.finalize_with_call_id_namespace(Some(request_id))
    }

    fn finalize_with_call_id_namespace(
        self,
        request_id: Option<&str>,
    ) -> Result<ProviderStreamResult, ProviderStreamError> {
        if !self.source_done {
            return Err(ProviderStreamError::new(
                "provider_stream_native_terminal_missing",
                "Provider 流结束前没有完成标记。",
            ));
        }
        if !self.reasoning_signature.trim().is_empty() && self.reasoning.trim().is_empty() {
            return Err(ProviderStreamError::new(
                "provider_reasoning_signature_without_content",
                "Provider reasoning signature 缺少对应 reasoning content。",
            ));
        }
        let mut tool_calls = Vec::with_capacity(self.tool_calls.len());
        for (index, call) in self.tool_calls {
            let name = call.name.ok_or_else(|| {
                ProviderStreamError::new(
                    "provider_tool_call_name_missing",
                    format!("Provider 工具调用 {index} 缺少名称。"),
                )
            })?;
            let arguments = match call.complete_arguments {
                Some(value) => value,
                None if call.arguments.trim().is_empty() => json!({}),
                None => serde_json::from_str(&call.arguments).map_err(|error| {
                    ProviderStreamError::new(
                        "provider_tool_call_arguments_invalid",
                        format!("Provider 工具调用 {index} 参数不是有效 JSON：{error}"),
                    )
                })?,
            };
            if !arguments.is_object() {
                return Err(ProviderStreamError::new(
                    "provider_tool_call_arguments_invalid",
                    format!("Provider 工具调用 {index} 参数必须是 JSON 对象。"),
                ));
            }
            let id = match (call.id, request_id) {
                (Some(id), _) => id,
                (None, Some(request_id)) => format!("provider-tool:{request_id}:{index}"),
                (None, None) => format!("probe-tool:{index}"),
            };
            tool_calls.push(LlmToolCall {
                id,
                name: internal_tool_name(&name),
                arguments,
            });
        }
        Ok(ProviderStreamResult {
            output: LlmChatOutput {
                content: self.content,
                reasoning: (!self.reasoning.trim().is_empty()).then_some(self.reasoning),
                reasoning_signature: (!self.reasoning_signature.trim().is_empty())
                    .then_some(self.reasoning_signature),
                tool_calls,
            },
            completion: ProviderCompletion {
                provider_kind: self.kind,
                finish_reason: self.finish_reason,
                usage: match (self.input_tokens, self.output_tokens) {
                    (Some(input_tokens), Some(output_tokens)) => Some(match self.kind {
                        ProviderStreamKind::Anthropic => anthropic_usage(
                            input_tokens,
                            output_tokens,
                            self.cache_read_input_tokens,
                            self.cache_creation_input_tokens,
                        )?,
                        ProviderStreamKind::OpenAiCompatible => {
                            let cache = cache_usage_from_total(
                                input_tokens,
                                self.cache_read_input_tokens,
                                self.cache_miss_input_tokens,
                            )?;
                            ProviderUsage {
                                input_tokens,
                                output_tokens,
                                cache_read_input_tokens: cache.map(|value| value.0),
                                cache_miss_input_tokens: cache.map(|value| value.1),
                            }
                        }
                        ProviderStreamKind::Ollama => ProviderUsage {
                            input_tokens,
                            output_tokens,
                            cache_read_input_tokens: None,
                            cache_miss_input_tokens: None,
                        },
                    }),
                    _ => None,
                },
            },
        })
    }

    fn ingest_openai(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        if payload.trim() == "[DONE]" {
            self.source_done = true;
            return Ok(Vec::new());
        }
        let value = parse_json(payload)?;
        if let Some(error) = value.get("error") {
            return Err(ProviderStreamError::new(
                "provider_error",
                error.to_string(),
            ));
        }
        if let Some(usage) = value.get("usage") {
            set_token_count(
                &mut self.input_tokens,
                usage
                    .get("prompt_tokens")
                    .or_else(|| usage.get("input_tokens")),
                "输入 token",
            )?;
            set_token_count(
                &mut self.output_tokens,
                usage
                    .get("completion_tokens")
                    .or_else(|| usage.get("output_tokens")),
                "输出 token",
            )?;
            set_token_count(
                &mut self.cache_read_input_tokens,
                usage
                    .get("prompt_cache_hit_tokens")
                    .or_else(|| usage.pointer("/prompt_tokens_details/cached_tokens"))
                    .or_else(|| usage.pointer("/input_tokens_details/cached_tokens")),
                "缓存读取输入 token",
            )?;
            set_token_count(
                &mut self.cache_miss_input_tokens,
                usage.get("prompt_cache_miss_tokens"),
                "缓存未命中输入 token",
            )?;
        }
        let mut emissions = Vec::new();
        for choice in value
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
                self.finish_reason = Some(reason.to_owned());
            }
            let delta = choice.get("delta").unwrap_or(&Value::Null);
            if let Some(text) = delta.get("content").and_then(Value::as_str) {
                self.push_text(text, &mut emissions);
            }
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
            {
                self.reasoning.push_str(reasoning);
            }
            for call in delta
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let index = required_tool_call_index(call.get("index"), "OpenAI tool call")?;
                let buffer = self.tool_calls.entry(index).or_default();
                set_once(
                    &mut buffer.id,
                    call.get("id").and_then(Value::as_str),
                    "工具调用 ID",
                )?;
                let function = call.get("function").unwrap_or(&Value::Null);
                append_streamed_tool_name(
                    &mut buffer.name,
                    function.get("name").and_then(Value::as_str),
                );
                if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                    buffer.arguments.push_str(arguments);
                }
            }
        }
        Ok(emissions)
    }

    fn ingest_anthropic(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        let value = parse_json(payload)?;
        let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let mut emissions = Vec::new();
        match event_type {
            "message_start" => {
                set_token_count(
                    &mut self.input_tokens,
                    value.pointer("/message/usage/input_tokens"),
                    "输入 token",
                )?;
                set_token_count(
                    &mut self.cache_read_input_tokens,
                    value.pointer("/message/usage/cache_read_input_tokens"),
                    "缓存读取输入 token",
                )?;
                set_token_count(
                    &mut self.cache_creation_input_tokens,
                    value.pointer("/message/usage/cache_creation_input_tokens"),
                    "缓存创建输入 token",
                )?;
            }
            "content_block_start" => {
                let index =
                    required_tool_call_index(value.get("index"), "Anthropic content block start")?;
                let block = value.get("content_block").unwrap_or(&Value::Null);
                if block.get("type").and_then(Value::as_str) == Some("thinking") {
                    if let Some(thinking) = block.get("thinking").and_then(Value::as_str) {
                        self.reasoning.push_str(thinking);
                    }
                    if let Some(signature) = block.get("signature").and_then(Value::as_str) {
                        self.reasoning_signature.push_str(signature);
                    }
                }
                if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                    let buffer = self.tool_calls.entry(index).or_default();
                    set_once(
                        &mut buffer.id,
                        block.get("id").and_then(Value::as_str),
                        "工具调用 ID",
                    )?;
                    set_once(
                        &mut buffer.name,
                        block.get("name").and_then(Value::as_str),
                        "工具名称",
                    )?;
                    if let Some(input) = block.get("input").filter(|value| {
                        !value.is_null()
                            && value.as_object().is_none_or(|object| !object.is_empty())
                    }) {
                        buffer.complete_arguments = Some(input.clone());
                    }
                }
            }
            "content_block_delta" => {
                let index =
                    required_tool_call_index(value.get("index"), "Anthropic content block delta")?;
                let delta = value.get("delta").unwrap_or(&Value::Null);
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            self.push_text(text, &mut emissions);
                        }
                    }
                    Some("thinking_delta") => {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            self.reasoning.push_str(text);
                        }
                    }
                    Some("signature_delta") => {
                        if let Some(signature) = delta.get("signature").and_then(Value::as_str) {
                            self.reasoning_signature.push_str(signature);
                        }
                    }
                    Some("input_json_delta") => {
                        if let Some(text) = delta.get("partial_json").and_then(Value::as_str) {
                            self.tool_calls
                                .entry(index)
                                .or_default()
                                .arguments
                                .push_str(text);
                        }
                    }
                    _ => {}
                }
            }
            "message_delta" => {
                self.finish_reason = value
                    .get("delta")
                    .and_then(|delta| delta.get("stop_reason"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                set_token_count(
                    &mut self.output_tokens,
                    value.pointer("/usage/output_tokens"),
                    "输出 token",
                )?;
            }
            "message_stop" => self.source_done = true,
            "error" => {
                return Err(ProviderStreamError::new(
                    "provider_error",
                    value.get("error").unwrap_or(&value).to_string(),
                ));
            }
            _ => {}
        }
        Ok(emissions)
    }

    fn ingest_ollama(
        &mut self,
        payload: &str,
    ) -> Result<Vec<ProviderEmission>, ProviderStreamError> {
        let value = parse_json(payload)?;
        if let Some(error) = value.get("error") {
            return Err(ProviderStreamError::new(
                "provider_error",
                error.to_string(),
            ));
        }
        let mut emissions = Vec::new();
        let message = value.get("message").unwrap_or(&Value::Null);
        if let Some(text) = message.get("content").and_then(Value::as_str) {
            self.push_text(text, &mut emissions);
        }
        if let Some(reasoning) = message.get("thinking").and_then(Value::as_str) {
            self.reasoning.push_str(reasoning);
        }
        for (index, call) in message
            .get("tool_calls")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let function = call.get("function").unwrap_or(call);
            let buffer = self.tool_calls.entry(index as i64).or_default();
            set_once(
                &mut buffer.name,
                function.get("name").and_then(Value::as_str),
                "工具名称",
            )?;
            if let Some(arguments) = function.get("arguments") {
                buffer.complete_arguments = Some(arguments.clone());
            }
        }
        if value.get("done").and_then(Value::as_bool) == Some(true) {
            set_token_count(
                &mut self.input_tokens,
                value.get("prompt_eval_count"),
                "输入 token",
            )?;
            set_token_count(
                &mut self.output_tokens,
                value.get("eval_count"),
                "输出 token",
            )?;
            self.source_done = true;
            self.finish_reason = value
                .get("done_reason")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        Ok(emissions)
    }

    fn push_text(&mut self, text: &str, emissions: &mut Vec<ProviderEmission>) {
        if text.is_empty() {
            return;
        }
        self.content.push_str(text);
        emissions.push(ProviderEmission {
            event: json!({ "type": "text_delta", "content": text }),
        });
    }
}

fn cache_usage_from_total(
    input_tokens: u64,
    cache_read_input_tokens: Option<u64>,
    cache_miss_input_tokens: Option<u64>,
) -> Result<Option<(u64, u64)>, ProviderStreamError> {
    let result = match (cache_read_input_tokens, cache_miss_input_tokens) {
        (None, None) => return Ok(None),
        (Some(read), None) if read <= input_tokens => (read, input_tokens - read),
        (None, Some(miss)) if miss <= input_tokens => (input_tokens - miss, miss),
        (Some(read), Some(miss))
            if read
                .checked_add(miss)
                .is_some_and(|sum| sum <= input_tokens) =>
        {
            (read, miss)
        }
        _ => {
            return Err(ProviderStreamError::new(
                "provider_usage_invalid",
                "Provider 缓存 token 计数超过输入 token 总量。",
            ));
        }
    };
    Ok(Some(result))
}

fn anthropic_usage(
    input_tokens: u64,
    output_tokens: u64,
    cache_read_input_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
) -> Result<ProviderUsage, ProviderStreamError> {
    let Some(cache_read_input_tokens) = cache_read_input_tokens else {
        return Ok(ProviderUsage {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_miss_input_tokens: None,
        });
    };
    let Some(cache_creation_input_tokens) = cache_creation_input_tokens else {
        return Ok(ProviderUsage {
            input_tokens,
            output_tokens,
            cache_read_input_tokens: None,
            cache_miss_input_tokens: None,
        });
    };
    let cache_miss_input_tokens = input_tokens
        .checked_add(cache_creation_input_tokens)
        .ok_or_else(|| {
            ProviderStreamError::new("provider_usage_invalid", "Provider 输入 token 溢出。")
        })?;
    let total_input_tokens = cache_miss_input_tokens
        .checked_add(cache_read_input_tokens)
        .ok_or_else(|| {
            ProviderStreamError::new("provider_usage_invalid", "Provider 输入 token 溢出。")
        })?;
    Ok(ProviderUsage {
        input_tokens: total_input_tokens,
        output_tokens,
        cache_read_input_tokens: Some(cache_read_input_tokens),
        cache_miss_input_tokens: Some(cache_miss_input_tokens),
    })
}

fn parse_json(payload: &str) -> Result<Value, ProviderStreamError> {
    serde_json::from_str(payload).map_err(|error| {
        ProviderStreamError::new(
            "provider_stream_json_invalid",
            format!("Provider 流事件不是有效 JSON：{error}"),
        )
    })
}

fn required_tool_call_index(
    value: Option<&Value>,
    context: &str,
) -> Result<i64, ProviderStreamError> {
    value
        .and_then(Value::as_i64)
        .filter(|index| *index >= 0)
        .ok_or_else(|| {
            ProviderStreamError::new(
                "provider_tool_call_index_invalid",
                format!("{context} 缺少非负整数 index。"),
            )
        })
}

fn set_once(
    slot: &mut Option<String>,
    value: Option<&str>,
    label: &str,
) -> Result<(), ProviderStreamError> {
    let Some(value) = value else {
        return Ok(());
    };
    if slot.as_deref().is_some_and(|existing| existing != value) {
        return Err(ProviderStreamError::new(
            "provider_tool_call_identity_conflict",
            format!("Provider 在同一响应中改变了{label}。"),
        ));
    }
    if slot.is_none() {
        *slot = Some(value.to_owned());
    }
    Ok(())
}

fn append_streamed_tool_name(slot: &mut Option<String>, value: Option<&str>) {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return;
    };
    let Some(existing) = slot.as_mut() else {
        *slot = Some(value.to_owned());
        return;
    };
    if existing == value {
        return;
    }
    if value.starts_with(existing.as_str()) {
        *existing = value.to_owned();
        return;
    }
    existing.push_str(value);
}

fn set_token_count(
    slot: &mut Option<u64>,
    value: Option<&Value>,
    label: &str,
) -> Result<(), ProviderStreamError> {
    let Some(value) = value else {
        return Ok(());
    };
    let value = value.as_u64().ok_or_else(|| {
        ProviderStreamError::new(
            "provider_usage_invalid",
            format!("Provider {label}计数不是非负整数。"),
        )
    })?;
    if slot.is_some_and(|existing| existing != value) {
        return Err(ProviderStreamError::new(
            "provider_usage_conflict",
            format!("Provider 在同一响应中改变了{label}计数。"),
        ));
    }
    *slot = Some(value);
    Ok(())
}

pub(crate) fn sse_json_event(event: &str, value: Value) -> String {
    format!("event: {event}\ndata: {value}\n\n")
}

pub(crate) fn provider_tools_from_values(values: Vec<Value>) -> Vec<LlmToolDefinition> {
    values
        .into_iter()
        .filter_map(|value| {
            Some(LlmToolDefinition {
                name: value.get("name")?.as_str()?.to_owned(),
                description: value
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
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

    #[test]
    fn openai_text_does_not_require_reasoning() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(br#"{"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}"#)
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.content, "OK");
        assert!(result.output.reasoning.is_none());
    }

    #[test]
    fn openai_usage_is_preserved_as_provider_fact() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(br#"{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5}}"#)
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 12,
                output_tokens: 5,
                cache_read_input_tokens: None,
                cache_miss_input_tokens: None,
            })
        );
    }

    #[test]
    fn anthropic_usage_is_preserved_as_provider_fact() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Anthropic);
        parser
            .ingest_payload(br#"{"type":"message_start","message":{"usage":{"input_tokens":21}}}"#)
            .unwrap();
        parser
            .ingest_payload(
                br#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":8}}"#,
            )
            .unwrap();
        parser
            .ingest_payload(br#"{"type":"message_stop"}"#)
            .unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 21,
                output_tokens: 8,
                cache_read_input_tokens: None,
                cache_miss_input_tokens: None,
            })
        );
    }

    #[test]
    fn ollama_usage_is_preserved_as_provider_fact() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Ollama);
        parser
            .ingest_payload(
                br#"{"message":{"content":"OK"},"done":true,"prompt_eval_count":9,"eval_count":3}"#,
            )
            .unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 9,
                output_tokens: 3,
                cache_read_input_tokens: None,
                cache_miss_input_tokens: None,
            })
        );
    }

    #[test]
    fn provider_without_native_tool_ids_gets_request_scoped_call_identity() {
        fn call_id(request_id: &str) -> String {
            let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Ollama);
            parser
                .ingest_payload(
                    br#"{"message":{"tool_calls":[{"function":{"name":"fs__list","arguments":{"path":"."}}}]},"done":true,"prompt_eval_count":1,"eval_count":1}"#,
                )
                .unwrap();
            parser
                .finalize_for_request(request_id)
                .unwrap()
                .output
                .tool_calls[0]
                .id
                .clone()
        }

        assert_eq!(call_id("request-a"), "provider-tool:request-a:0");
        assert_eq!(call_id("request-b"), "provider-tool:request-b:0");
        assert_ne!(call_id("request-a"), call_id("request-b"));
    }

    #[test]
    fn deepseek_cache_usage_is_preserved_as_provider_fact() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(
                br#"{"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"prompt_cache_hit_tokens":15,"prompt_cache_miss_tokens":5}}"#,
            )
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 20,
                output_tokens: 4,
                cache_read_input_tokens: Some(15),
                cache_miss_input_tokens: Some(5),
            })
        );
    }

    #[test]
    fn openai_cached_tokens_derives_miss_from_same_usage_object() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(
                br#"{"choices":[],"usage":{"input_tokens":30,"output_tokens":6,"input_tokens_details":{"cached_tokens":18}}}"#,
            )
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 30,
                output_tokens: 6,
                cache_read_input_tokens: Some(18),
                cache_miss_input_tokens: Some(12),
            })
        );
    }

    #[test]
    fn anthropic_cache_components_form_total_and_miss_usage() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Anthropic);
        parser
            .ingest_payload(
                br#"{"type":"message_start","message":{"usage":{"input_tokens":4,"cache_read_input_tokens":10,"cache_creation_input_tokens":6}}}"#,
            )
            .unwrap();
        parser
            .ingest_payload(
                br#"{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}"#,
            )
            .unwrap();
        parser
            .ingest_payload(br#"{"type":"message_stop"}"#)
            .unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(
            result.completion.usage,
            Some(ProviderUsage {
                input_tokens: 20,
                output_tokens: 2,
                cache_read_input_tokens: Some(10),
                cache_miss_input_tokens: Some(10),
            })
        );
    }

    #[test]
    fn openai_tool_call_is_decoded_to_internal_name() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        parser
            .ingest_payload(
                br#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"fs__read","arguments":"{\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}"#,
            )
            .unwrap();
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.tool_calls[0].name, "fs.read");
        assert_eq!(result.output.tool_calls[0].arguments["path"], "README.md");
    }

    #[test]
    fn openai_compatible_tool_name_accepts_glm_stream_fragments() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        for payload in [
            br#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"fs__","arguments":"{"}}]}}]}"#.as_slice(),
            br#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"read","arguments":"\"path\":\"README.md\"}"}}]},"finish_reason":"tool_calls"}]}"#.as_slice(),
        ] {
            parser.ingest_payload(payload).unwrap();
        }
        parser.ingest_payload(b"[DONE]").unwrap();
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.tool_calls[0].name, "fs.read");
        assert_eq!(result.output.tool_calls[0].arguments["path"], "README.md");
    }

    #[test]
    fn openai_tool_call_without_index_is_rejected_instead_of_merged_into_zero() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::OpenAiCompatible);
        let error = parser
            .ingest_payload(
                br#"{"choices":[{"delta":{"tool_calls":[{"id":"call-1","function":{"name":"fs__read","arguments":"{}"}}]}}]}"#,
            )
            .expect_err("missing index rejected");

        assert_eq!(error.code, "provider_tool_call_index_invalid");
    }

    #[test]
    fn anthropic_content_block_without_index_is_rejected() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Anthropic);
        let error = parser
            .ingest_payload(
                br#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}"#,
            )
            .expect_err("missing index rejected");

        assert_eq!(error.code, "provider_tool_call_index_invalid");
    }

    #[test]
    fn anthropic_thinking_signature_is_preserved_for_tool_continuation() {
        let mut parser = ProviderStreamAccumulator::new(ProviderStreamKind::Anthropic);
        for payload in [
            br#"{"type":"message_start","message":{"usage":{"input_tokens":3}}}"#.as_slice(),
            br#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#.as_slice(),
            br#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}"#.as_slice(),
            br#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"opaque-signature"}}"#.as_slice(),
            br#"{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tool-1","name":"fs__read","input":{}}}"#.as_slice(),
            br#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"README.md\"}"}}"#.as_slice(),
            br#"{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":4}}"#.as_slice(),
            br#"{"type":"message_stop"}"#.as_slice(),
        ] {
            parser.ingest_payload(payload).unwrap();
        }
        let result = parser.finalize().unwrap();
        assert_eq!(result.output.reasoning.as_deref(), Some("reason"));
        assert_eq!(
            result.output.reasoning_signature.as_deref(),
            Some("opaque-signature")
        );
        assert_eq!(result.output.tool_calls[0].name, "fs.read");
        assert_eq!(result.output.tool_calls[0].arguments["path"], "README.md");
    }
}
