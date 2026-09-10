use crate::prelude::*;
use crate::*;

pub(crate) fn anthropic_stream_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
    require_tool_call: bool,
) -> Value {
    let (system, chat_messages) = split_system_messages(messages);
    let chat_messages = anthropic_messages(chat_messages);
    let max_tokens = profile
        .max_output_tokens
        .expect("resolved Provider runtime has maxOutputTokens");
    let mut body = json!({
        "model": profile.model,
        "messages": chat_messages,
        "max_tokens": max_tokens,
        "stream": true,
    });
    if profile.provider_flavor.as_deref() == Some("deepseek") {
        if let Some(thinking) = &profile.thinking {
            body["thinking"] = json!({"type": thinking});
        }
        if let Some(effort) = &profile.reasoning_effort {
            body["output_config"] = json!({"effort": effort});
        }
    } else if profile.thinking.as_deref() == Some("enabled") {
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
                "name": tool.name,
                "description": tool.description,
                "input_schema": tool.input_schema
            }))
            .collect::<Vec<_>>());
        if require_tool_call {
            body["tool_choice"] = json!({ "type": "any" });
        }
    }
    body
}

fn anthropic_messages(messages: Vec<Value>) -> Vec<Value> {
    let mut output = Vec::with_capacity(messages.len());
    for message in messages {
        let Some(record) = message.as_object() else {
            continue;
        };
        match record.get("role").and_then(Value::as_str).unwrap_or("user") {
            "assistant" => output.push(anthropic_assistant_message(record)),
            "tool" => append_anthropic_tool_result(&mut output, record),
            "user" => output.push(json!({
                "role": "user",
                "content": message_content_string(record.get("content"))
            })),
            _ => {}
        }
    }
    output
}

fn anthropic_assistant_message(record: &serde_json::Map<String, Value>) -> Value {
    let mut content = Vec::new();
    if let Some(reasoning) = record
        .get("reasoningContent")
        .or_else(|| record.get("reasoning_content"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        let mut block = json!({ "type": "thinking", "thinking": reasoning });
        if let Some(signature) = record
            .get("reasoningSignature")
            .or_else(|| record.get("reasoning_signature"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            block["signature"] = json!(signature);
        }
        content.push(block);
    }
    let text = message_content_string(record.get("content"));
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for call in record
        .get("toolCalls")
        .or_else(|| record.get("tool_calls"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(call) = call.as_object() else {
            continue;
        };
        let function = call.get("function").and_then(Value::as_object);
        let Some(name) = function
            .and_then(|value| value.get("name"))
            .or_else(|| call.get("name"))
            .and_then(Value::as_str)
        else {
            continue;
        };
        let input = function
            .and_then(|value| value.get("arguments"))
            .or_else(|| call.get("input"))
            .or_else(|| call.get("arguments"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let input = match input {
            Value::String(text) => serde_json::from_str(&text).unwrap_or_else(|_| json!({})),
            value => value,
        };
        content.push(json!({
            "type": "tool_use",
            "id": call
                .get("providerCallId")
                .and_then(Value::as_str)
                .expect("validated tool call has providerCallId"),
            "name": name,
            "input": input
        }));
    }
    json!({ "role": "assistant", "content": content })
}

fn append_anthropic_tool_result(
    messages: &mut Vec<Value>,
    record: &serde_json::Map<String, Value>,
) {
    let block = json!({
        "type": "tool_result",
        "tool_use_id": record
            .get("providerCallId")
            .and_then(Value::as_str)
            .expect("validated tool message has providerCallId"),
        "content": message_content_string(record.get("content"))
    });
    if let Some(content) = messages
        .last_mut()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| message.get_mut("content"))
        .and_then(Value::as_array_mut)
        .filter(|content| {
            content
                .iter()
                .all(|item| item.get("type").and_then(Value::as_str) == Some("tool_result"))
        })
    {
        content.push(block);
        return;
    }
    messages.push(json!({ "role": "user", "content": [block] }));
}

pub(crate) fn ollama_stream_request_body(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: &[LlmToolDefinition],
    require_tool_call: bool,
) -> Value {
    let mut body = json!({
        "model": profile.model,
        "messages": messages,
        "stream": true,
        "think": profile.thinking.as_deref() == Some("enabled"),
    });
    body["options"] = json!({
        "num_predict": profile
            .max_output_tokens
            .expect("resolved Provider runtime has maxOutputTokens")
    });
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
        if require_tool_call {
            body["tool_choice"] = json!("required");
        }
    }
    body
}
