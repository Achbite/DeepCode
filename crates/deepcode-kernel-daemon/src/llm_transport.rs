#![allow(dead_code)]
#![allow(unused_imports)]

use crate::prelude::*;
use crate::*;

#[derive(Debug, Clone)]
pub(crate) struct ResolvedLlmProfile {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
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
}

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
) -> Result<LlmChatOutput, String> {
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
    if llm_mock_enabled() {
        let mock_system_instruction = messages
            .iter()
            .find(|value| value.get("role").and_then(Value::as_str) == Some("system"))
            .and_then(|value| value.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mock_user_prompt = messages
            .iter()
            .rev()
            .find(|value| value.get("role").and_then(Value::as_str) == Some("user"))
            .and_then(|value| value.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        return Ok(mock_llm_output(mock_system_instruction, mock_user_prompt));
    }
    match profile.kind.as_str() {
        "anthropic" => call_anthropic_profile(profile, messages, tools).await,
        "ollama" => call_ollama_profile(profile, messages, tools).await,
        "openaiCompatible" | "codex" => {
            call_openai_compatible_profile(profile, messages, tools).await
        }
        other => Err(format!("Unsupported LLM provider kind: {other}")),
    }
}

pub(crate) async fn call_openai_compatible_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, String> {
    let api_key = profile
        .api_key
        .as_deref()
        .ok_or_else(|| format!("LLM profile `{}` has no API key", profile.name))?;
    let url = normalize_openai_base_url(profile);
    let mut body = json!({
        "model": profile.model,
        "messages": messages,
        "stream": false
    });
    if let Some(tokens) = profile.max_output_tokens {
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
    if is_deepseek_profile(profile) {
        body["user_id"] = json!("deepcode_local");
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
    let response = reqwest::Client::new()
        .post(url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("LLM request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("LLM response JSON parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), value));
    }
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .cloned()
        .unwrap_or(Value::Null);
    Ok(parse_openai_message(&choice))
}

pub(crate) async fn call_anthropic_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, String> {
    let api_key = profile
        .api_key
        .as_deref()
        .ok_or_else(|| format!("LLM profile `{}` has no API key", profile.name))?;
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
        .map_err(|error| format!("LLM request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("LLM response JSON parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), value));
    }
    Ok(parse_anthropic_message(&value))
}

pub(crate) async fn call_ollama_profile(
    profile: &ResolvedLlmProfile,
    messages: Vec<Value>,
    tools: Vec<LlmToolDefinition>,
) -> Result<LlmChatOutput, String> {
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
        .map_err(|error| format!("LLM request failed: {error}"))?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|error| format!("LLM response JSON parse failed: {error}"))?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status.as_u16(), value));
    }
    Ok(parse_openai_message(
        value.get("message").unwrap_or(&Value::Null),
    ))
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
    }
}

pub(crate) fn llm_output_payload(output: LlmChatOutput) -> Value {
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
    json!({
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
    })
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
