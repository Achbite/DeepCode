use crate::prelude::*;
use crate::*;

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
