use crate::prelude::*;
use crate::*;
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub(crate) struct SseDataParser {
    buffer: String,
}

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
pub(crate) struct OpenAiCompatibleStreamAccumulator {
    content: String,
    reasoning: String,
    tool_calls: BTreeMap<i64, ToolCallDeltaBuffer>,
    pub(crate) usage: Option<Value>,
    pub(crate) done_emitted: bool,
    source_envelope_seq: u64,
}

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

#[allow(dead_code)]
pub(crate) fn openai_stream_events_from_data(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    data: &str,
) -> Vec<String> {
    openai_stream_events_from_data_inner(accumulator, data, None)
}

pub(crate) fn openai_stream_events_from_data_for_request(
    accumulator: &mut OpenAiCompatibleStreamAccumulator,
    data: &str,
    request_id: &str,
) -> Vec<String> {
    openai_stream_events_from_data_inner(accumulator, data, Some(request_id))
}

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
                    let args = normalized_openai_tool_arguments(function.get("arguments"));
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

fn normalized_openai_tool_arguments(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(raw)) => {
            serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.clone()))
        }
        Some(value) => value.clone(),
        None => json!({}),
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

pub(crate) fn llm_decoded_response_payload(response: LlmChatDecodedResponse) -> Value {
    let mut payload = llm_output_payload(response.output);
    let Some(raw_provider) = response.raw_provider else {
        return payload;
    };
    if let Some(done) = payload
        .get_mut("chunks")
        .and_then(Value::as_array_mut)
        .and_then(|chunks| chunks.last_mut())
        .and_then(Value::as_object_mut)
    {
        done.insert("rawProvider".to_string(), raw_provider);
        done.insert(
            "providerSource".to_string(),
            json!({
                "schemaVersion": "deepcode.provider.source-envelope.v1",
                "sequence": 1,
                "encoding": "json",
            }),
        );
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
